import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { executeSearch } from "opencode-antigravity-auth/dist/src/plugin/search.js"
import { Type } from "typebox"
import { dbg } from "./log.js"
import { getAccessToken } from "./v1.js"

/**
 * Port of V1's `google_search` tool.
 *
 * V1 registered this as an OpenCode tool; here it becomes a pi tool with the
 * same parameters. It is a *separate* API call (grounding only) because the
 * Gemini API refuses to combine `googleSearch` with function declarations.
 */
export function registerSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "google_search",
    label: "Google Search",
    description:
      "Search the web with Google and return summarized results with sources. " +
      "Use this when you need current information, or pass specific URLs to extract and analyze.",
    promptSnippet: "google_search(query, urls?, thinking?) - web search with sources",
    promptGuidelines: [
      "Use google_search for current events, versions, docs, or anything after your knowledge cutoff.",
      "Pass `urls` to extract content from specific pages instead of searching.",
    ],
    parameters: Type.Object(
      {
        query: Type.String({ description: "The search query or question to answer using web search" }),
        urls: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "List of specific URLs to fetch and analyze. IMPORTANT: Always extract and include any URLs mentioned by the user in their query here.",
          }),
        ),
        thinking: Type.Optional(
          Type.Boolean({
            description: "Enable deep thinking for more thorough analysis (default: true)",
            default: true,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal) {
      const started = Date.now()
      try {
        const { token, projectId } = await getAccessToken()
        dbg(`google_search: "${params.query.slice(0, 80)}" urls=${params.urls?.length ?? 0}`)
        const text = await executeSearch(
          {
            query: params.query,
            urls: params.urls,
            thinking: params.thinking ?? true,
          },
          token,
          projectId,
          signal,
        )
        dbg(`google_search: ok in ${Date.now() - started}ms (${text.length} chars)`)
        return { content: [{ type: "text" as const, text }], details: {} }
      } catch (e: any) {
        if (signal?.aborted) {
          dbg("google_search: aborted")
          throw e
        }
        dbg(`google_search ERR ${e?.stack ?? e?.message}`)
        return {
          content: [{ type: "text" as const, text: `Google search failed: ${e?.message ?? e}` }],
          details: {},
          isError: true,
        }
      }
    },
  })
  dbg("google_search tool registered")
}
