import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai"
import { authorizeAntigravity, exchangeAntigravity } from "opencode-antigravity-auth"
import { startOAuthListener } from "opencode-antigravity-auth/dist/src/plugin/server.js"
import { dbg } from "./log.js"
import { PROVIDER_ID } from "./models.js"
import {
  PI_AUTH_PATH,
  addAccountToPool,
  clearPool,
  invalidateAccessToken,
  invalidateFetch,
  readPool,
} from "./v1.js"

/**
 * Antigravity's redirect URI is a fixed `http://localhost:51121/oauth-callback`
 * baked into the CLI's OAuth client, so the port is not configurable.
 */
const LOGIN_TIMEOUT_MS = Number(process.env.ANTIGRAVITY_OAUTH_TIMEOUT_MS) || 180_000

/**
 * Core browser PKCE flow, independent of who drives the UI.
 *
 * `openUrl` is called once with the Google authorization URL; `onProgress`
 * mirrors status back to the caller. Extracted so both pi's `/login` (which
 * owns the browser) and our own `/antigravity-login` command can share it.
 */
export async function runLoginFlow(opts: {
  openUrl: (url: string) => void | Promise<void>
  onProgress?: (message: string) => void
  signal?: AbortSignal
}): Promise<OAuthCredentials> {
  const listener = await startOAuthListener({ timeoutMs: LOGIN_TIMEOUT_MS })
  let aborted = false
  const onAbort = () => {
    aborted = true
    dbg("login aborted by caller")
    void listener.close().catch(() => {})
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const authorization = await authorizeAntigravity("")
    dbg(`login: opening browser ${authorization.url.slice(0, 90)}...`)
    await opts.openUrl(authorization.url)
    opts.onProgress?.("Waiting for the Google OAuth callback...")

    const callbackUrl = await listener.waitForCallback()
    const code = callbackUrl.searchParams.get("code")
    const state = callbackUrl.searchParams.get("state")
    if (!code || !state) throw new Error("OAuth callback is missing code/state")

    const result = await exchangeAntigravity(code, state)
    if (result.type !== "success") throw new Error(result.error)
    dbg(`login: success email=${result.email ?? "(none)"} project=${result.projectId || "none"}`)

    await addAccountToPool({
      refresh: result.refresh,
      access: result.access,
      expires: result.expires,
      email: result.email,
      projectId: result.projectId,
    })
    invalidateFetch()
    invalidateAccessToken()

    return { refresh: result.refresh, access: result.access, expires: result.expires }
  } catch (e: any) {
    if (aborted) dbg("login: cancelled")
    else dbg(`login ERR ${e?.stack ?? e?.message}`)
    throw e
  } finally {
    opts.signal?.removeEventListener("abort", onAbort)
    await listener.close().catch(() => {})
  }
}

/**
 * pi's `/login` adapter: pi opens the browser and owns the progress UI.
 */
export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return runLoginFlow({
    openUrl: (url) => {
      callbacks.onAuth({ url, instructions: "Complete the Google sign-in in your browser." })
    },
    onProgress: (message) => callbacks.onProgress?.(message),
    signal: callbacks.signal,
  })
}

/**
 * Refresh pi's stored credential.
 *
 * Delegates to V1's own refresh (`POST oauth2.googleapis.com/token` with the
 * Antigravity client id/secret). The extra `signal` parameter exists only in
 * pi >= 0.99 and is deliberately optional so this also runs on 0.74.
 *
 * `refreshAccessToken` accepts a `client` and `providerId` that it never
 * reads — they exist for OpenCode's persistence hooks — so a stub is safe.
 */
export async function refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
  if (signal?.aborted) throw new Error("Antigravity: refresh aborted")
  const auth = { type: "oauth" as const, refresh: credentials.refresh, access: credentials.access, expires: credentials.expires }
  const { refreshAccessToken } = await import("opencode-antigravity-auth/dist/src/plugin/token.js")
  const updated = await refreshAccessToken(auth as any, {} as any, PROVIDER_ID)
  if (!updated?.access) throw new Error("Antigravity: token refresh failed")
  dbg(`refreshToken: ok (expires ${new Date(Number(updated.expires ?? 0)).toISOString()})`)
  invalidateAccessToken()
  return {
    ...credentials,
    refresh: updated.refresh,
    access: updated.access,
    expires: Number(updated.expires ?? 0),
  }
}

/** pi stores one credential per provider; this is how it labels ours. */
export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

interface PiAuthFile {
  [provider: string]: unknown
}

/** Whether pi currently stores a credential for our provider. */
export async function hasPiCredential(): Promise<boolean> {
  try {
    const { readFile } = await import("node:fs/promises")
    const raw = await readFile(PI_AUTH_PATH, "utf8")
    if (!raw.trim()) return false
    return PROVIDER_ID in (JSON.parse(raw) as PiAuthFile)
  } catch {
    return false
  }
}

/**
 * Remove only our entry from `~/.pi/agent/auth.json`, leaving other providers
 * untouched. pi's own `/logout` does the same thing; this exists so our
 * `/antigravity-logout` can clear *both* stores in one step.
 */
async function dropPiCredential(): Promise<boolean> {
  const { readFile, writeFile, chmod } = await import("node:fs/promises")
  try {
    const raw = await readFile(PI_AUTH_PATH, "utf8")
    const data: PiAuthFile = raw.trim() ? JSON.parse(raw) : {}
    if (!(PROVIDER_ID in data)) return false
    delete data[PROVIDER_ID]
    await writeFile(PI_AUTH_PATH, JSON.stringify(data, null, 2), "utf8")
    await chmod(PI_AUTH_PATH, 0o600).catch(() => {})
    dbg("logout: removed pi credential")
    return true
  } catch (e: any) {
    if (e?.code === "ENOENT") return false
    dbg(`logout: failed to edit auth.json: ${e?.message}`)
    throw e
  }
}

/**
 * Full logout: drop pi's credential **and** wipe V1's shared account pool.
 *
 * Clearing only the pi side would leave `~/.config/opencode/antigravity-accounts.json`
 * behind, and V1 would silently revive the session on the next loader call —
 * the "ghost login" the OpenCode port had to solve the same way.
 */
export async function logout(): Promise<{ piCleared: boolean; poolSize: number }> {
  const pool = await readPool()
  const before = pool?.accounts?.length ?? 0
  const piCleared = await dropPiCredential()
  await clearPool()
  invalidateAccessToken()
  invalidateFetch()
  dbg(`logout: pi=${piCleared} pool ${before} -> 0`)
  return { piCleared, poolSize: before }
}

/** Account count in the shared pool, for the status command. */
export async function accountSummary(): Promise<{
  count: number
  active: string
  loggedIntoPi: boolean
}> {
  const pool = await readPool()
  const accounts = pool?.accounts ?? []
  const active = accounts[pool?.activeIndex ?? 0]
  return {
    count: accounts.length,
    active: active?.email ?? "(unknown)",
    loggedIntoPi: await hasPiCredential(),
  }
}
