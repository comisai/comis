// SPDX-License-Identifier: Apache-2.0
/**
 * `ctx_search` — full-text search over THIS conversation's compressed history
 * (the in-session lossless store), via the injected `ContextStorePort`.
 *
 * Direct-injection (NOT the RPC `session_search`/`memory_search` recall path):
 *   1. SCOPE: the conversation is derived per-call from `tryGetContext().sessionKey`
 *      and rejected (`permission_denied`) when there is no live session. NEVER
 *      cached in the factory closure; NEVER a caller-supplied id (conversation isolation).
 *   2. SANITIZE: the raw query is run through `sanitizeFts5Query` (the skills-side
 *      sanitizer) BEFORE it reaches `store.searchLcd` (the store
 *      trusts a pre-sanitized query).
 *   3. TAINT: every returned hit snippet is recovered/untrusted content, so it is
 *      wrapped via `wrapExternalContent({ source: "unknown" })` before it leaves
 *      the tool (the prompt-injection surface).
 *   4. OBSERVABILITY: logs ids/counts/durationMs/step ONLY — never the query text
 *      or a snippet body (the log-payload-checker gate).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { wrapExternalContent, scrubSecretsFromText, type LcdSearchHit, type LcdSearchResult } from "@comis/core";

import { jsonResult, throwToolError, readStringParam, readNumberParam } from "../../../platform-tools/tool-helpers.js";
import { sanitizeFts5Query } from "../../../platform-tools/tools/fts5-sanitizer.js";
import { emitExpansionMetric, emitScriptZeroHit, requireCtxScope, type ContextToolDeps } from "./context-tools-shared.js";

/**
 * Scan-floor cap note surfaced to the model when the bounded normalized
 * scan reached its row cap (`lane === "scan" && scanCapped`). Content-free
 * (no query text) — names the SCAN_ROW_CAP (`@comis/memory` `SCAN_ROW_CAP = 2000`)
 * so the model knows older messages were not scanned. Pinned by the tool test.
 */
const SCAN_CAP_NOTE =
  "Search scanned the 2,000 most recent messages (scan cap reached); older messages were not searched.";

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
      //     LIVE context per-call; fail closed without a fully-scoped
      //     session. NEVER a wiring closure (multi-agent-safe).
      const ctxScope = requireCtxScope();
      const conversationRef = ctxScope.conversationRef;

      // (2) SANITIZE — strip FTS5 special chars in the tool, before the store sees it.
      const q = sanitizeFts5Query(readStringParam(params, "query", true)!);
      const scope = resolveScope(readStringParam(params, "scope", false));
      const requested = readNumberParam(params, "limit", false) ?? 10;
      const limit = Math.min(Math.max(1, requested), 30);

      const t0 = deps.nowMs();
      // searchLcd returns the widened LcdSearchResult
      // { hits, scriptZeroHit?, lane, matchErrored, scanCapped? } — preserve the
      // hits array for downstream processing and surface the script-health signals
      // at THIS logging/emit boundary (infra-free seam: @comis/memory has no logger).
      const result: LcdSearchResult = deps.store.searchLcd(ctxScope, q, { limit, scope });
      const hits: LcdSearchHit[] = result.hits;

      // (3) SCRUB + TAINT — scrub secrets out of every recovered snippet, THEN wrap
      //     it as untrusted before it leaves the tool. A snippet can legitimately
      //     contain a credential (the lossless store keeps the raw conversation);
      //     the egress copy must never carry it to the model context (mirrors the
      //     ctx_expand egress scrub). The base store is untouched.
      const safeHits = hits.map((h) => ({
        kind: h.kind,
        refId: h.refId,
        rank: h.rank,
        snippet: wrapExternalContent(scrubSecretsFromText(h.snippet).text, { source: "unknown" }),
      }));

      // (4) OBSERVABILITY — ids/counts/durationMs/step ONLY; never the query or a snippet.
      // Read the end-instant ONCE and reuse it for the DEBUG durationMs, the
      // emit durationMs, AND the emit timestamp, so the three are a single
      // consistent clock snapshot (the afterTurn triggers' one-read pattern).
      const endMs = deps.nowMs();
      // Signal purity: the store sets
      // `scriptZeroHit` ONLY on a CLEAN zero-hit (`!matchErrored`); a swallowed
      // FTS5 MATCH error surfaces as `matchErrored` instead and must NEVER count
      // as a lane gap.
      if (result.matchErrored) {
        // §2.7 failure branch: a degraded MATCH error stays a content-free WARN
        // (hint + errorKind) at the TOOL boundary (the memory package is
        // logger-free). NO query text. NOT a script_zero_hit signal.
        deps.logger.warn(
          {
            step: "lcd-search",
            agentId: ctxScope.agentId,
            sessionKey: ctxScope.sessionKey,
            lane: result.lane,
            hint: "FTS MATCH errored and degraded to zero rows — not counted as a lane gap; if persistent, run comis doctor (FTS drift) or check SQLite FTS5/trigram availability",
            errorKind: "dependency" as const,
          },
          "lcd search MATCH errored (degraded)",
        );
      } else if (result.scriptZeroHit) {
        // A clean non-Latin zero-hit → emit a content-free event-bus signal onto
        // the `comis explain` timeline AND the `comis system-health` health_signal.
        // Guarded: a throwing subscriber can NEVER fail the already-completed
        // search. Payload carries the closed `scriptClass`/`lane` enums + ids +
        // timestamp ONLY — the query string is intentionally ABSENT.
        emitScriptZeroHit(deps, {
          conversationRef: ctxScope.conversationRef,
          agentId: ctxScope.agentId,
          sessionKey: ctxScope.sessionKey,
          scriptClass: result.scriptZeroHit,
          lane: result.lane,
          timestamp: endMs,
        });
      }
      deps.logger.debug(
        {
          toolName: "ctx_search",
          conversationRef,
          scope,
          hitCount: hits.length,
          durationMs: endMs - t0,
          step: "ctx_search",
        },
        "ctx_search complete",
      );
      // Content-free expansion-hit metric (ids/counts/durationMs only —
      // NEVER the query or a snippet; the lossless store, AGENTS.md §2.2/§2.7).
      // GUARD the emit. TypedEventBus.emit delegates to Node's
      // EventEmitter.emit, which propagates the first subscriber exception
      // synchronously to the emitter — so a throwing subscriber (a trajectory
      // writer, a metrics sink) would unwind out of execute() and convert this
      // already-completed recovery into a tool failure the model sees. Swallow
      // it (best-effort, content-free), mirroring the afterTurn emitters'
      // non-fatal contract: observability can NEVER fail the recovery.
      emitExpansionMetric(deps, "ctx_search", {
        conversationRef: ctxScope.conversationRef,
        agentId: ctxScope.agentId,
        sessionKey: ctxScope.sessionKey,
        tool: "ctx_search",
        recoveredCount: hits.length,
        durationMs: endMs - t0,
        timestamp: endMs,
      });

      // Surface the lane to the model (which path served the query) and,
      // when the bounded normalized scan floor hit its row cap, the cap note (the
      // "cap noted in result" criterion) — so the model knows older messages were
      // not searched and can narrow/retry. Content-free (no query text). The cap
      // note rides ONLY the scan lane (the only lane that caps).
      const scanCapped = result.lane === "scan" && result.scanCapped === true;
      return jsonResult({
        hits: safeHits,
        lane: result.lane,
        ...(result.lane === "scan" ? { scanCapped } : {}),
        ...(scanCapped ? { capNote: SCAN_CAP_NOTE } : {}),
      });
    },
  };
}
