import { dbg, rotateLog } from "./log.js"
import { MARKER_HEADER, MARKER_VALUE, PROVIDER_BASE_URL } from "./models.js"
import { ensureFetch, invalidateFetch } from "./v1.js"

let installed = false
let originalFetch: typeof globalThis.fetch | null = null

function headerOf(input: any, init: RequestInit | undefined): Headers {
  // `Headers`/`Request` both expose `.headers`; plain objects need wrapping.
  if (init?.headers) return new Headers(init.headers)
  if (input && typeof input === "object" && input.headers) return new Headers(input.headers)
  return new Headers()
}

function urlOf(input: any): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  if (input && typeof input === "object" && typeof input.url === "string") return input.url
  return ""
}

/**
 * V1 only rewrites the body when `typeof init.body === "string"` — hand it a
 * Buffer/Uint8Array and the whole transformation is silently skipped, so the
 * raw Gemini payload reaches Antigravity unwrapped and is rejected with
 * `Unknown name "contents"`. Always normalise to a UTF-8 string here.
 */
function toBodyString(body: any): string | undefined {
  if (body == null) return undefined
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8")
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8")
  if (body instanceof URLSearchParams) return body.toString()
  return String(body)
}

/**
 * Route our provider's traffic through V1's wrapped fetch.
 *
 * Why a global hook rather than pi's `before_provider_request`: that event can
 * only replace the request *body*, never the URL or headers, and Antigravity
 * lives at a completely different host with a wrapped envelope. pi exposes no
 * request-level hook, so `fetch` — which pi's own `@google/genai` client uses —
 * is the only interception point available.
 *
 * Re-entrancy is safe: V1 rewrites the target to `cloudcode-pa.googleapis.com`,
 * which fails this predicate and therefore falls through to the real fetch.
 */
export function installFetchHook(): void {
  if (installed) return
  installed = true
  rotateLog()

  originalFetch = globalThis.fetch.bind(globalThis)

  globalThis.fetch = async (input: any, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input)

    let headers: Headers
    try {
      headers = headerOf(input, init)
    } catch {
      return originalFetch!(input, init)
    }

    // Only our own provider marks its requests; everything else is untouched.
    if (headers.get(MARKER_HEADER) !== MARKER_VALUE) return originalFetch!(input, init)
    if (!url.includes("generativelanguage.googleapis.com")) return originalFetch!(input, init)

    const v1fetch = await ensureFetch()
    if (!v1fetch) {
      dbg("fetch hook: no V1 fetch available (not logged in?)")
      throw new Error(
        "Antigravity: not authenticated. Run /login and select the Antigravity provider (or add an account with /antigravity-login).",
      )
    }

    // Strip everything that would leak the placeholder key or collide with
    // V1's own credentials. V1 deletes `x-api-key` but *not* `x-goog-api-key`,
    // and @google/genai always sets the latter from `apiKey` — sending both
    // makes Google reject the request with "API key not valid".
    headers.delete(MARKER_HEADER)
    headers.delete("x-goog-api-key")
    headers.delete("x-api-key")
    headers.delete("x-goog-user-project")
    headers.delete("x-goog-api-client")

    const method = (init?.method ?? "POST").toUpperCase()
    const body = toBodyString(init?.body)
    const signal = init?.signal

    dbg(`fetch hook -> V1 ${method} ${url.slice(0, 120)} bodyLen=${body?.length ?? 0}`)

    try {
      let response = await v1fetch(url, { method, headers, body, signal })
      dbg(`fetch hook <- ${response.status} ${response.statusText ?? ""}`)

      // V1's `streamingTransformer` has a bug where it occasionally concatenates
      // SSE events with a single `\n` (e.g. when injecting synthetic usage stats),
      // creating invalid payloads like `data: {...}\ndata: {...}`.
      // @google/genai splits by `\n\n`, so it hands the merged string to
      // `JSON.parse()`, which throws `Unexpected non-whitespace character`.
      // We fix this by parsing the SSE lines and ensuring standard `\n\n` separators.
      if (response.ok && response.body && url.includes("alt=sse")) {
        const textDecoder = new TextDecoder()
        const textEncoder = new TextEncoder()
        let buffer = ""
        const fixSseStream = new TransformStream({
          transform(chunk, controller) {
            buffer += textDecoder.decode(chunk, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""
            for (let i = 0; i < lines.length; i++) {
              let line = lines[i]
              // If V1 jammed something together without a newline, split it
              line = line.replace(/(.)(data: )/g, "$1\n\n$2")
              const parts = line.split("\n\n")
              for (const part of parts) {
                if (part.startsWith("data:")) {
                  controller.enqueue(textEncoder.encode(part + "\n\n"))
                } else if (part.trim() !== "") {
                  controller.enqueue(textEncoder.encode(part + "\n"))
                }
              }
            }
          },
          flush(controller) {
            buffer += textDecoder.decode()
            if (buffer.trim()) {
              let line = buffer.replace(/(.)(data: )/g, "$1\n\n$2")
              const parts = line.split("\n\n")
              for (const part of parts) {
                if (part.startsWith("data:")) {
                  controller.enqueue(textEncoder.encode(part + "\n\n"))
                } else if (part.trim() !== "") {
                  controller.enqueue(textEncoder.encode(part + "\n"))
                }
              }
            }
          },
        })
        response = new Response(response.body.pipeThrough(fixSseStream), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      return response
    } catch (e: any) {
      if (signal?.aborted) {
        dbg("fetch hook: aborted by caller")
      } else {
        dbg(`fetch hook ERR ${e?.stack ?? e?.message}`)
      }
      throw e
    }
  }

  dbg(`fetch hook installed (marker=${MARKER_HEADER}=${MARKER_VALUE}, base=${PROVIDER_BASE_URL})`)
}

/** Undo the hook — used by `/antigravity-logout` and teardown. */
export function uninstallFetchHook(): void {
  if (!installed || !originalFetch) return
  globalThis.fetch = originalFetch
  installed = false
  invalidateFetch()
  dbg("fetch hook removed")
}

export { invalidateFetch }
