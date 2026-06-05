// SPDX-License-Identifier: Apache-2.0
/**
 * `ctx_search` — full-text search over THIS conversation's compressed history
 * (the in-session lossless store), via the injected `ContextStorePort`.
 *
 * Direct-injection (NOT the RPC `session_search`/`memory_search` recall path):
 *   1. SCOPE: the conversation is derived per-call from `tryGetContext().sessionKey`
 *      and rejected (`permission_denied`) when there is no live session. NEVER
 *      cached in the factory closure; NEVER a caller-supplied id (E2 isolation).
 *   2. SANITIZE: the raw query is run through `sanitizeFts5Query` (the skills-side
 *      sanitizer) BEFORE it reaches `store.searchLcd` (PATTERNS gap #2 — the store
 *      trusts a pre-sanitized query).
 *   3. TAINT: every returned hit snippet is recovered/untrusted content, so it is
 *      wrapped via `wrapExternalContent({ source: "unknown" })` before it leaves
 *      the tool (the prompt-injection surface).
 *   4. OBSERVABILITY: logs ids/counts/durationMs/step ONLY — never the query text
 *      or a snippet body (Pitfall 2 / log-payload-checker gate).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { tryGetContext, wrapExternalContent, type LcdSearchHit } from "@comis/core";

import { jsonResult, throwToolError, readStringParam, readNumberParam } from "../../../platform-tools/tool-helpers.js";
import { sanitizeFts5Query } from "../../../platform-tools/tools/fts5-sanitizer.js";
import type { ContextToolDeps } from "./context-tools-shared.js";

const CtxSearchParams = Type.Object({
  query: Type.String({ description: "Full-text query over THIS conversation's compressed history." }),
  scope: Type.Optional(
    Type.String({ description: "messages | summaries | both (default both)" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Max hits (default 10, max 30)", minimum: 1, maximum: 30 }),
  ),
});

/** The closed `scope` union (AGENTS.md §2.8) — validated with an exhaustive default. */
type CtxScope = "messages" | "summaries" | "both";

/** Validate the optional `scope` param against the closed set; default `"both"`. */
function resolveScope(raw: string | undefined): CtxScope {
  switch (raw) {
    case undefined:
    case "both":
      return "both";
    case "messages":
      return "messages";
    case "summaries":
      return "summaries";
    default:
      throwToolError("invalid_value", `Invalid scope: "${raw}".`, {
        validValues: ["messages", "summaries", "both"],
        param: "scope",
        hint: "Use one of the listed scope values.",
      });
  }
}

/**
 * Create the `ctx_search` tool. Reads the injected `ContextStorePort` — distinct
 * from `memory_search` (cross-session recall).
 */
export function createCtxSearchTool(deps: ContextToolDeps): AgentTool<typeof CtxSearchParams> {
  return {
    name: "ctx_search",
    label: "Context Search",
    description:
      "Full-text search over THIS conversation's compressed history (the in-session lossless store). " +
      "Distinct from memory_search (cross-session recall). Use to recover detail that was compressed " +
      "out of your visible context, then ctx_expand to read the full region.",
    parameters: CtxSearchParams,

    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      // (1) SCOPE — derive per-call, never cache; fail closed with no live session.
      const ctx = tryGetContext();
      if (!ctx?.sessionKey) {
        throwToolError("permission_denied", "ctx_search operates only inside a live session.", {
          hint: "This tool searches the current conversation's compressed history; it cannot run outside a session.",
        });
      }
      const conversationId = ctx.sessionKey;

      // (2) SANITIZE — strip FTS5 special chars in the tool, before the store sees it.
      const q = sanitizeFts5Query(readStringParam(params, "query", true)!);
      const scope = resolveScope(readStringParam(params, "scope", false));
      const requested = readNumberParam(params, "limit", false) ?? 10;
      const limit = Math.min(Math.max(1, requested), 30);

      const t0 = deps.nowMs();
      const hits: LcdSearchHit[] = deps.store.searchLcd(conversationId, q, { limit, scope });

      // (3) TAINT — wrap every recovered snippet as untrusted before it leaves the tool.
      const safeHits = hits.map((h) => ({
        kind: h.kind,
        refId: h.refId,
        rank: h.rank,
        snippet: wrapExternalContent(h.snippet, { source: "unknown" }),
      }));

      // (4) OBSERVABILITY — ids/counts/durationMs/step ONLY; never the query or a snippet.
      deps.logger.debug(
        {
          toolName: "ctx_search",
          conversationId,
          scope,
          hitCount: hits.length,
          durationMs: deps.nowMs() - t0,
          step: "ctx_search",
        },
        "ctx_search complete",
      );

      return jsonResult({ hits: safeHits });
    },
  };
}
