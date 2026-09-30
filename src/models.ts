import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent"
import { OPENCODE_MODEL_DEFINITIONS } from "opencode-antigravity-auth/dist/src/plugin/config/models.js"
import { dbg } from "./log.js"

/**
 * Provider identifier. Every model is addressed as `antigravity/<model-id>`.
 * The ids below are deliberately the *original* Antigravity ids: V1's
 * `resolveModelForHeaderStyle()` rewrites them to the wire name
 * (`antigravity-gemini-3-pro` -> `gemini-3-pro-low`) when it builds the request.
 */
export const PROVIDER_ID = "antigravity"

/**
 * Marker header injected on every request this provider sends.
 *
 * The fetch hook uses it to tell "a request from our provider" apart from a
 * genuine call to the built-in `google` provider — both would otherwise share
 * the same `generativelanguage.googleapis.com` base URL.
 * `resolveHeaders()` treats unknown values as literals (it only substitutes
 * env vars), so this survives the round trip through pi's config resolution.
 */
export const MARKER_HEADER = "x-antigravity-auth"
export const MARKER_VALUE = "pi-antigravity"

/** Base URL handed to pi. Only a *prefix*: the fetch hook rewrites the real target. */
export const PROVIDER_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

/**
 * Placeholder API key.
 *
 * pi hides a provider's models until `hasConfiguredAuth()` passes, so without
 * this the model picker stays empty even when the shared account pool already
 * holds a logged-in account (e.g. one added by the OpenCode plugin). It is
 * never sent: the fetch hook strips `x-goog-api-key` / `x-api-key` before
 * handing the request to V1, which authenticates with its own bearer token.
 *
 * Deliberately not a valid-looking key so it can never be mistaken for one.
 */
export const API_KEY_PLACEHOLDER = "pi-antigravity-oauth"

/**
 * pi only accepts `"text" | "image"` as input modalities; V1 also advertises
 * `"pdf"`, which would be rejected by pi's schema.
 */
function toPiInputs(inputs: readonly string[]): ("text" | "image")[] {
  const out = inputs.filter((i): i is "text" | "image" => i === "text" || i === "image")
  return out.length > 0 ? out : ["text"]
}

/** Map V1's OpenCode model table onto pi's `ProviderModelConfig`. */
export function buildModels(): ProviderModelConfig[] {
  const models: ProviderModelConfig[] = []
  for (const [id, def] of Object.entries(OPENCODE_MODEL_DEFINITIONS)) {
    models.push({
      id,
      name: def.name,
      api: "google-generative-ai",
      // Drives pi's thinking UI. V1 declares `variants` for exactly the models
      // that can think, so that is our source of truth.
      reasoning: !!def.variants && Object.keys(def.variants).length > 0,
      input: toPiInputs(def.modalities?.input ?? ["text"]),
      // Antigravity is a free-quota product; the real cost is $0 and reporting
      // anything else would skew pi's usage numbers.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: def.limit.context,
      maxTokens: def.limit.output,
      baseUrl: PROVIDER_BASE_URL,
      headers: { [MARKER_HEADER]: MARKER_VALUE },
    })
  }
  dbg(`models built: ${models.length} (${models.map((m) => m.id).join(", ")})`)
  return models
}

/**
 * Model table shaped the way V1's `loader(getAuth, provider)` expects it —
 * a flat record of `{ cost }`-bearing entries. V1 zeroes the cost itself, but
 * it mutates whatever we hand it, so give it its own copy.
 */
export function buildV1Provider(): { id: string; models: Record<string, { cost: { input: number; output: number } }> } {
  const models: Record<string, { cost: { input: number; output: number } }> = {}
  for (const [id] of Object.entries(OPENCODE_MODEL_DEFINITIONS)) {
    models[id] = { cost: { input: 0, output: 0 } }
  }
  return { id: PROVIDER_ID, models }
}
