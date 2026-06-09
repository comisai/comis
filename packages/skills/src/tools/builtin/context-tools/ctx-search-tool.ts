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
import { wrapExternalContent, scrubSecretsFromText, type LcdSearchHit, type LcdSearchResult } from "@comis/core";

import { jsonResult, throwToolError, readStringParam, readNumberParam } from "../../../platform-tools/tool-helpers.js";
import { sanitizeFts5Query } from "../../../platform-tools/tools/fts5-sanitizer.js";
import { emitExpansionMetric, requireCtxScope, type ContextToolDeps } from "./context-tools-shared.js";

const CtxSearchParams = Type.Object({
  query: Type.String({ description: "Full-text query over THIS conversation's compressed history." }),
  scope: Type.Optional(
    Type.String({ description: "messages | summaries | both (default both)" }),
  ),
  limit: Type.Optional(
    // NO hard minimum/maximum: the handler is the single clamp authority
    // (Math.min(Math.max(1, requested), 30)). A hard schema bound made the agent
    // framework REJECT an out-of-range value (e.g. the LLM's round-number limit:50)
    // before execute() could clamp it, turning a recoverable lookup into a
    // [tool failure]. Keep it an integer; the description states the effective range.
    Type.Integer({ description: "Max hits (default 10, clamped to 1..30)" }),
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
      // (1) SCOPE — build the (conversation, agent, tenant) read scope from the
      //     LIVE context per-call (R4 / WR-02); fail closed without a fully-scoped
      //     session. NEVER a wiring closure (multi-agent-safe, Pitfall 4).
      const ctxScope = requireCtxScope();
      const conversationId = ctxScope.conversationId;

      // (2) SANITIZE — strip FTS5 special chars in the tool, before the store sees it.
      const q = sanitizeFts5Query(readStringParam(params, "query", true)!);
      const scope = resolveScope(readStringParam(params, "scope", false));
      const requested = readNumberParam(params, "limit", false) ?? 10;
      const limit = Math.min(Math.max(1, requested), 30);

      const t0 = deps.nowMs();
      // EFF-03: searchLcd now returns LcdSearchResult { hits, cjkZeroHit } — destructure
      // to preserve the hits array for downstream processing and surface the CJK flag
      // at THIS logging boundary (infra-free seam: @comis/memory has no logger import).
      const result: LcdSearchResult = deps.store.searchLcd(ctxScope, q, { limit, scope });
      const hits: LcdSearchHit[] = result.hits;

      // (3) SCRUB + TAINT — scrub secrets out of every recovered snippet, THEN wrap
      //     it as untrusted before it leaves the tool. A snippet can legitimately
      //     contain a credential (the F1 lossless store keeps the raw conversation);
      //     the egress copy must never carry it to the model context (mirrors the
      //     ctx_expand egress scrub). The base store is untouched.
      const safeHits = hits.map((h) => ({
        kind: h.kind,
        refId: h.refId,
        rank: h.rank,
        snippet: wrapExternalContent(scrubSecretsFromText(h.snippet).text, { source: "unknown" }),
      }));

      // (4) OBSERVABILITY — ids/counts/durationMs/step ONLY; never the query or a snippet.
      // WR-03: read the end-instant ONCE and reuse it for the DEBUG durationMs, the
      // emit durationMs, AND the emit timestamp, so the three are a single
      // consistent clock snapshot (the afterTurn triggers' one-read pattern).
      const endMs = deps.nowMs();
      // EFF-03: CJK zero-hit counter — content-free DEBUG event (boolean flag only;
      // the query string is intentionally ABSENT per T-170-05-01). This is the
      // §14.4 instrumented trigger for the deferred CJK-trigram FTS path: when this
      // counter climbs on a real non-Latin channel, CJK-01 (trigram FTS) is activated.
      if (result.cjkZeroHit) {
        deps.logger.debug(
          { step: "lcd-search", agentId: ctxScope.agentId, sessionKey: ctxScope.sessionKey, cjkZeroHit: true },
          "lcd FTS returned zero hits for CJK query",
        );
      }
      deps.logger.debug(
        {
          toolName: "ctx_search",
          conversationId,
          scope,
          hitCount: hits.length,
          durationMs: endMs - t0,
          step: "ctx_search",
        },
        "ctx_search complete",
      );
      // O1: content-free expansion-hit metric (ids/counts/durationMs only —
      // NEVER the query or a snippet; the lossless store, AGENTS.md §2.2/§2.7).
      // WR-02: GUARD the emit. TypedEventBus.emit delegates to Node's
      // EventEmitter.emit, which propagates the first subscriber exception
      // synchronously to the emitter — so a throwing subscriber (a trajectory
      // writer, a metrics sink) would unwind out of execute() and convert this
      // already-completed recovery into a tool failure the model sees. Swallow
      // it (best-effort, content-free), mirroring the afterTurn emitters'
      // non-fatal contract: observability can NEVER fail the recovery.
      emitExpansionMetric(deps, "ctx_search", {
        conversationId: ctxScope.conversationId,
        agentId: ctxScope.agentId,
        sessionKey: ctxScope.sessionKey,
        tool: "ctx_search",
        recoveredCount: hits.length,
        durationMs: endMs - t0,
        timestamp: endMs,
      });

      return jsonResult({ hits: safeHits });
    },
  };
}
