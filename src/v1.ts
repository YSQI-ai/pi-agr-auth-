import { homedir } from "node:os"
import { join } from "node:path"
import {
  loadAccounts,
  saveAccountsReplace,
  clearAccounts,
  type AccountStorageV4,
} from "opencode-antigravity-auth/dist/src/plugin/storage.js"
import { formatRefreshParts, parseRefreshParts } from "opencode-antigravity-auth/dist/src/plugin/auth.js"
import { refreshAccessToken } from "opencode-antigravity-auth/dist/src/plugin/token.js"
import { dbg } from "./log.js"
import { PROVIDER_ID, buildV1Provider } from "./models.js"

/**
 * All V1 state lives in OpenCode's config dir on purpose: an account you
 * already logged into with the OpenCode plugin is immediately usable here too,
 * and vice versa. Override with `OPENCODE_CONFIG_DIR` (honoured by V1 itself).
 */
export const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config/opencode")

/** `~/.pi/agent/auth.json` — the credentials pi itself owns. */
export const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json")

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

let v1: any = null
let v1Promise: Promise<any> | null = null
let cachedFetch: Fetch | null = null
let loaderAttempted = false

/**
 * Minimal stand-in for OpenCode's `client`.
 *
 * V1 only ever *writes* credentials through `client.auth.set`, which is a no-op
 * for us: pi owns the credential store and V1's own account pool already
 * persists everything the rotation logic needs.
 */
function makeClientShim() {
  return {
    auth: {
      set: async (args: any) => {
        dbg(`client.auth.set refreshLen=${args?.body?.refresh?.length ?? 0} (no-op: pi owns credentials)`)
      },
    },
    session: {
      prompt: async () => {
        dbg("client.session.prompt called — not supported under pi, returning empty")
        return {}
      },
    },
    tui: {
      showToast: async (args: any) => {
        dbg(`toast: ${args?.body?.message ?? args?.message ?? ""}`)
      },
    },
  }
}

/** Load and initialise the V1 plugin exactly once. */
export async function getV1(): Promise<any> {
  if (v1) return v1
  if (!v1Promise) {
    v1Promise = (async () => {
      const mod: any = await import("opencode-antigravity-auth")
      const factory = mod.AntigravityCLIOAuthPlugin
      if (typeof factory !== "function") throw new Error("AntigravityCLIOAuthPlugin is not a function")
      const result = await factory({ client: makeClientShim(), directory: CONFIG_DIR })
      const methods = result?.auth?.methods ?? []
      dbg(`V1 ready methods=${methods.length} loader=${typeof result?.auth?.loader}`)
      return result
    })()
  }
  try {
    v1 = await v1Promise
    return v1
  } catch (e: any) {
    v1Promise = null
    dbg(`V1 load ERR ${e?.stack ?? e?.message}`)
    throw e
  }
}

// ---------------------------------------------------------------------------
// Account pool
// ---------------------------------------------------------------------------

/** V1's packed refresh string: `refreshToken|projectId|managedProjectId`. */
export type PackedRefresh = string

export async function readPool(): Promise<AccountStorageV4 | null> {
  try {
    return (await loadAccounts()) ?? null
  } catch (e: any) {
    dbg(`readPool ERR ${e?.message}`)
    return null
  }
}

export async function poolSize(): Promise<number> {
  const pool = await readPool()
  return pool?.accounts?.length ?? 0
}

export interface ExchangedAccount {
  refresh: PackedRefresh
  access: string
  expires: number
  email?: string
  projectId?: string
}

/**
 * Add (or re-activate) an account in the shared pool.
 *
 * This is what makes multi-account rotation work: every login appends a row,
 * and V1's `AccountManager.loadFromDisk()` rotates across all of them at
 * request time. Re-logging the same account just moves `activeIndex` to it.
 */
export async function addAccountToPool(result: ExchangedAccount): Promise<void> {
  const parts = parseRefreshParts(result.refresh)
  if (!parts.refreshToken) {
    dbg("addAccountToPool: no refresh token in exchange result, skipping")
    return
  }
  const pool = (await readPool()) ?? { version: 4, accounts: [], activeIndex: 0 }
  const existing = pool.accounts.find((a) => a.refreshToken === parts.refreshToken)
  if (existing) {
    existing.lastUsed = Date.now()
    if (result.email) existing.email = result.email
    if (parts.projectId) existing.projectId = parts.projectId
    pool.activeIndex = pool.accounts.indexOf(existing)
    dbg(`addAccountToPool: re-activated existing account ${existing.email ?? "(no email)"} (index ${pool.activeIndex})`)
  } else {
    pool.accounts.push({
      email: result.email,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId || undefined,
      addedAt: Date.now(),
      lastUsed: Date.now(),
      lastSwitchReason: "initial",
    })
    pool.activeIndex = pool.accounts.length - 1
    dbg(`addAccountToPool: added ${result.email ?? "(no email)"} (pool size ${pool.accounts.length})`)
  }
  await saveAccountsReplace(pool as AccountStorageV4)
}

/**
 * The credential V1's loader needs, built from the pool's active account.
 *
 * Returns `null` (rather than an empty oauth stub) when nothing is logged in,
 * so the loader clears stale state and hands back `{}` instead of trying to
 * run with an empty refresh token.
 */
export async function getAuth(): Promise<any | null> {
  const pool = await readPool()
  if (!pool || pool.accounts.length === 0) return null
  const active = pool.accounts[pool.activeIndex] ?? pool.accounts[0]
  if (!active?.refreshToken) return null
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: active.refreshToken,
      projectId: active.projectId,
      managedProjectId: active.managedProjectId,
    }),
    access: "",
    expires: 0,
  }
}

/** Wipe the shared account pool (used by logout). */
export async function clearPool(): Promise<void> {
  await clearAccounts()
  invalidateFetch()
  dbg("account pool cleared")
}

// ---------------------------------------------------------------------------
// pi credential <-> pool reconciliation
// ---------------------------------------------------------------------------

interface PiAuthFile {
  [provider: string]: { refresh?: string; access?: string; expires?: number } | undefined
}

async function readPiCredential(): Promise<{ refresh: string; access: string; expires: number } | null> {
  try {
    const { readFile } = await import("node:fs/promises")
    const raw = await readFile(PI_AUTH_PATH, "utf8")
    if (!raw.trim()) return null
    const cred = (JSON.parse(raw) as PiAuthFile)[PROVIDER_ID]
    if (!cred?.refresh) return null
    return { refresh: cred.refresh, access: cred.access ?? "", expires: Number(cred.expires ?? 0) }
  } catch {
    return null
  }
}

/**
 * Heal the split-brain state where pi holds a credential but the shared pool
 * is empty (e.g. the pool was cleared by a logout in the other tool).
 *
 * Without this, pi would report "logged in" while every request failed with
 * `no credentials in pool`. The reverse direction needs no healing on purpose:
 * a pool populated by OpenCode with no pi credential is a valid state — pi
 * simply cannot make requests until `/login` binds it.
 */
export async function syncPoolFromPi(): Promise<void> {
  if ((await poolSize()) > 0) return
  const cred = await readPiCredential()
  if (!cred) return
  dbg("syncPoolFromPi: pool empty, restoring from pi credential")
  await addAccountToPool(cred)
  invalidateFetch()
}

// ---------------------------------------------------------------------------
// V1 loader -> fetch
// ---------------------------------------------------------------------------

/** Drop the cached fetch so the next request rebuilds it from current auth. */
export function invalidateFetch(): void {
  cachedFetch = null
  loaderAttempted = false
}

/**
 * Lazily ask V1 for its wrapped `fetch`.
 *
 * V1 returns one function that already handles everything the raw plugin did:
 * account rotation, token refresh, daily/autopush/prod endpoint fallback,
 * request wrapping and SSE unwrapping. We only have to call it.
 */
export async function ensureFetch(): Promise<Fetch | null> {
  if (cachedFetch) return cachedFetch
  if (loaderAttempted && !cachedFetch) return null
  loaderAttempted = true

  try {
    await syncPoolFromPi()
    const plugin = await getV1()
    const loader = plugin?.auth?.loader
    if (typeof loader !== "function") {
      dbg("ensureFetch: V1 loader missing")
      return null
    }
    const auth = await getAuth()
    if (!auth) {
      dbg("ensureFetch: no credentials in pool — run /login")
      return null
    }
    const res: any = await loader(getAuth, buildV1Provider())
    cachedFetch = res?.fetch ?? null
    dbg(`ensureFetch: loader returned keys=[${Object.keys(res ?? {}).join(",")}] fetch=${typeof cachedFetch}`)
  } catch (e: any) {
    dbg(`ensureFetch ERR ${e?.stack ?? e?.message}`)
    cachedFetch = null
    // Let a later request retry instead of staying permanently broken.
    loaderAttempted = false
  }
  return cachedFetch
}

// ---------------------------------------------------------------------------
// Access token for non-model calls (google_search)
// ---------------------------------------------------------------------------

interface CachedAccess {
  token: string
  expires: number
}

let accessCache: CachedAccess = { token: "", expires: 0 }

/** Force the next `getAccessToken()` to hit Google again. */
export function invalidateAccessToken(): void {
  accessCache = { token: "", expires: 0 }
}

/**
 * Fresh access token for the pool's active account.
 *
 * Needed by `executeSearch()`, which — unlike model traffic — is not routed
 * through V1's loader fetch and so does not get token refresh for free.
 */
export async function getAccessToken(): Promise<{ token: string; projectId: string }> {
  const auth = await getAuth()
  if (!auth) throw new Error("Antigravity: not logged in. Run /login and pick the Antigravity provider.")

  const projectId = parseRefreshParts(auth.refresh).projectId ?? ""

  if (accessCache.token && accessCache.expires > Date.now() + 60_000) {
    return { token: accessCache.token, projectId }
  }

  const plugin = await getV1()
  const tokenMod = await import("opencode-antigravity-auth/dist/src/plugin/token.js")
  if (typeof tokenMod.refreshAccessToken !== "function") {
    throw new Error("Antigravity: token refresh module unavailable")
  }
  const updated = await tokenMod.refreshAccessToken(auth, plugin?.client ?? makeClientShim(), PROVIDER_ID)
  if (!updated?.access) {
    dbg("getAccessToken: refresh returned no access token")
    throw new Error("Antigravity: could not refresh access token")
  }
  accessCache = { token: updated.access, expires: Number(updated.expires ?? 0) }
  dbg(`getAccessToken: refreshed (expires ${new Date(accessCache.expires).toISOString()}, project=${projectId || "none"})`)
  return { token: accessCache.token, projectId }
}

/** Re-export for callers that only need a plain refresh. */
export { refreshAccessToken }
