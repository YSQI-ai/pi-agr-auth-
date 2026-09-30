/**
 * Antigravity auth for the pi coding agent.
 *
 * Ports `opencode-antigravity-auth` (an OpenCode V1 plugin) to pi's extension
 * API. The whole V1 core — account rotation, token refresh,
 * daily/autopush/prod endpoint fallback, request wrapping and SSE unwrapping —
 * is reused untouched through `AntigravityCLIOAuthPlugin().auth.loader()`;
 * this file only adapts the host: pi supplies `registerProvider` + an OAuth
 * flow, and we intercept `fetch` where pi's `@google/genai` client emits
 * requests.
 *
 * Install:  pi install git:github.com/YSQI-ai/pi-antigravity-auth
 * Login:    /login  -> pick "Antigravity"
 * Models:   /model  -> antigravity/antigravity-gemini-3-pro
 * Logout:   /antigravity-logout
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { dbg, rotateLog } from "./src/log.js"
import { PROVIDER_ID, MARKER_HEADER, MARKER_VALUE, buildModels } from "./src/models.js"
import { API_KEY_PLACEHOLDER } from "./src/models.js"
import { installFetchHook } from "./src/fetch-hook.js"
import { login, logout, refreshToken, getApiKey, runLoginFlow, accountSummary, hasPiCredential } from "./src/oauth.js"
import { registerSearchTool } from "./src/search.js"
import { getV1, poolSize, invalidateFetch, invalidateAccessToken } from "./src/v1.js"

const PROVIDER_DISPLAY_NAME = "Antigravity (free Gemini/Claude)"

/** Open a URL in the user's browser — used only by our own commands. */
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process")
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true })
    child.on("error", () => dbg(`openBrowser: ${cmd} failed`))
    child.unref()
  } catch (e: any) {
    dbg(`openBrowser ERR ${e?.message}`)
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  rotateLog()
  dbg("extension loading...")

  // Must be installed before anything can issue a model request.
  installFetchHook()

  // Warm V1 up front so a broken install fails loudly at load, not mid-chat.
  // Non-fatal: login/requests can still be retried later.
  try {
    await getV1()
  } catch (e: any) {
    dbg(`V1 warm-up failed (continuing): ${e?.message}`)
  }

  // -------------------------------------------------------------------------
  // Provider
  // -------------------------------------------------------------------------
  // `apiKey` is a literal placeholder, not a secret: `resolveConfigValue()`
  // substitutes env vars only when they exist, otherwise it passes the string
  // through. Without it pi treats the provider as unauthenticated and hides
  // every model (`hasConfiguredAuth`), even when the shared pool already holds
  // an account from the OpenCode plugin. The fetch hook discards it —
  // V1 sends its own `Authorization: Bearer` instead.
  const models = buildModels()
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_DISPLAY_NAME,
    apiKey: API_KEY_PLACEHOLDER,
    api: "google-generative-ai",
    models,
    oauth: { name: PROVIDER_DISPLAY_NAME, login, refreshToken, getApiKey },
  })
  dbg(`provider "${PROVIDER_ID}" registered (${models.length} models)`)

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------
  registerSearchTool(pi)

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------
  pi.registerCommand("antigravity-logout", {
    description: "Sign out of Antigravity: clear pi's credential and the shared account pool",
    handler: async (_args, ctx) => {
      try {
        const before = await accountSummary()
        const result = await logout()
        ctx.ui.notify(
          `Antigravity signed out (pi credential: ${result.piCleared ? "removed" : "already absent"}, ` +
            `${result.poolSize} account${result.poolSize === 1 ? "" : "s"} cleared from the pool).`,
          "info",
        )
        dbg(`antigravity-logout: pool ${before.count} -> 0`)
      } catch (e: any) {
        dbg(`antigravity-logout ERR ${e?.message}`)
        ctx.ui.notify(`Logout failed: ${e?.message}`, "error")
      }
    },
  })

  pi.registerCommand("antigravity-accounts", {
    description: "Show Antigravity account pool status",
    handler: async (_args, ctx) => {
      try {
        invalidateFetch()
        invalidateAccessToken()
        const s = await accountSummary()
        const lines = [
          `Antigravity accounts: ${s.count} in pool`,
          `Active: ${s.active}`,
          `pi credential: ${s.loggedIntoPi ? "present" : "absent"}`,
          "",
          s.count > 1
            ? "Rotation is automatic: V1 picks a non-cooled-down account per request."
            : "Add another account with /antigravity-login to enable rotation.",
        ]
        ctx.ui.notify(lines.join("\n"), "info")
        dbg(`antigravity-accounts: count=${s.count} pi=${s.loggedIntoPi}`)
      } catch (e: any) {
        ctx.ui.notify(`Could not read accounts: ${e?.message}`, "error")
      }
    },
  })

  pi.registerCommand("antigravity-login", {
    description: "Add another Antigravity account to the rotation pool (does not change pi's credential)",
    handler: async (_args, ctx) => {
      try {
        const before = await poolSize()
        const creds = await runLoginFlow({
          openUrl: (url) => {
            void openBrowser(url)
            ctx.ui.notify(`Opened Google sign-in. If no browser appeared, visit:\n${url}`, "info")
          },
          onProgress: (message) => ctx.ui.setStatus("antigravity", message),
        })
        ctx.ui.setStatus("antigravity", undefined)
        const after = await poolSize()
        ctx.ui.notify(
          `Account added. Pool: ${before} -> ${after} (active credential unchanged: ` +
            `${await hasPiCredential() ? "pi stays bound to its own account" : "run /login to bind pi"}).`,
          "info",
        )
        dbg(`antigravity-login: pool ${before} -> ${after}, refreshLen=${creds.refresh.length}`)
      } catch (e: any) {
        ctx.ui.setStatus("antigravity", undefined)
        dbg(`antigravity-login ERR ${e?.message}`)
        ctx.ui.notify(`Login failed: ${e?.message}`, "error")
      }
    },
  })

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return
    try {
      const count = await poolSize()
      const piBound = await hasPiCredential()
      dbg(`session_start(${event.reason}): pool=${count} piCredential=${piBound}`)
      if (count > 0 && !piBound) {
        ctx.ui.notify(
          `Antigravity: ${count} account${count === 1 ? "" : "s"} available from the shared pool, ` +
            `but pi has no credential yet. Run /login -> ${PROVIDER_DISPLAY_NAME} to enable requests.`,
          "info",
        )
      }
    } catch (e: any) {
      dbg(`session_start ERR ${e?.message}`)
    }
  })

  dbg(`extension ready (marker ${MARKER_HEADER}=${MARKER_VALUE}, provider ${PROVIDER_ID})`)
}
