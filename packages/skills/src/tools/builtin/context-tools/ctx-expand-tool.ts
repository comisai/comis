// SPDX-License-Identifier: Apache-2.0
/**
 * `ctx_expand` — recover the underlying messages of a compressed summary region
 * of THIS conversation, via the injected `ContextStorePort`.
 *
 * Walk + reconstruct + taint + budget-cap (the read-tool + exec-externalization
 * blueprint):
 *   1. SCOPE: conversation derived per-call from `tryGetContext().sessionKey`
 *      (fail-closed `permission_denied` with no live session) — never cached,
 *      never a caller-supplied id (E2 isolation).
 *   2. WALK: `getSummaryMessages(summaryId)` → message ids; re-join via the
 *      existing `getMessages` (id-keyed map). A drifted (missing) id is SKIPPED,
 *      never thrown — the result reports an `unrecoverable` count so the model
 *      knows coverage is partial (mirrors the assembler's per-row drift skip).
 *   3. BUDGET + SPILL: when the recovered body exceeds `maxExpandTokens`, the
 *      detail is `scrubSecretsFromText`-scrubbed (the externalized file is the
 *      broadest egress surface — defense-in-depth) and written to the session
 *      `tool-results/` dir via `safePath` (filename = the toolCallId, NOT agent
 *      text); the tool returns a compact file-handle reference instead of
 *      inlining the body. Small output is inlined, taint-wrapped.
 *   4. TAINT: inline recovered content is wrapped via
 *      `wrapExternalContent({ source: "unknown" })` (prompt-injection surface).
 *   5. OBSERVABILITY: ids/counts/durationMs/step ONLY — never the recovered body.
 *
 * @module
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { wrapExternalContent, scrubSecretsFromText, safePath, type LcdMessage } from "@comis/core";

import { jsonResult, readStringParam } from "../../../platform-tools/tool-helpers.js";
import { emitExpansionMetric, estimateTokens, renderMessageText, requireCtxScope, type ContextToolDeps } from "./context-tools-shared.js";

const CtxExpandParams = Type.Object({
  summaryId: Type.String({ description: "The summaryId (from ctx_search / ctx_inspect) whose covered messages to recover." }),
});

/** Join recovered message text blocks for the externalized/inline body. */
const BODY_SEPARATOR = "\n---\n";

/**
 * Create the `ctx_expand` tool — recover a compressed region's underlying
 * detail, bounded by `maxExpandTokens`, for THIS conversation only.
 */
export function createCtxExpandTool(deps: ContextToolDeps): AgentTool<typeof CtxExpandParams> {
  return {
    name: "ctx_expand",
    label: "Context Expand",
    description:
      "Recover the underlying messages of a compressed summary region of THIS conversation (zoom into a " +
      "<summary>). Large recovered regions are written to a file you can read with the file tools; small " +
      "ones are returned inline. Distinct from cross-session recall.",
    parameters: CtxExpandParams,

    async execute(toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      // (1) SCOPE — build the (conversation, agent, tenant) read scope from the
      //     LIVE context per-call (R4 / WR-02); fail closed without a fully-scoped
      //     session. NEVER a wiring closure (multi-agent-safe, Pitfall 4).
      const ctxScope = requireCtxScope();
      const conversationId = ctxScope.conversationId;
      const summaryId = readStringParam(params, "summaryId", true)!;
      const t0 = deps.nowMs();

      // (2) WALK + RECONSTRUCT — id-keyed map; skip a drifted id, never throw.
      //     Agent-scoped reads (R4) — a different agent's covered ids / messages
      //     are unreachable within a shared conversation (WR-02).
      const messageIds = deps.store.getSummaryMessages(ctxScope, summaryId);
      const byId = new Map<string, LcdMessage>(
        deps.store.getMessages(ctxScope).map((r) => [r.id, r]),
      );
      const parts: string[] = [];
      let unrecoverable = 0;
      for (const id of messageIds) {
        const row = byId.get(id);
        if (!row) {
          unrecoverable++;
          continue;
        }
        parts.push(renderMessageText(row));
      }
      const rawBody = parts.join(BODY_SEPARATOR);

      // (3) BUDGET + SPILL — oversized regions are ALWAYS secret-scrubbed, then
      //     either written to a file handle (when a session dir exists) OR, when
      //     NO dir is available (heartbeat/cron/ephemeral context, or a resolver
      //     parse failure), inlined TRUNCATED to the cap. WR-04: the scrub AND the
      //     size bound must NOT be conditional on a dir being present — the prior
      //     `if (oversized && dir)` let the no-dir case fall through to the inline
      //     path and return the FULL rawBody UNBOUNDED and UNSCRUBBED, an
      //     unbounded-inline + unscrubbed-egress leak the cap exists to prevent.
      const dir = deps.getToolResultsDir();
      const oversized = estimateTokens(rawBody) > deps.maxExpandTokens;
      if (oversized) {
        // Defense-in-depth on the broadest egress surface — ALWAYS, regardless of
        // whether the body spills to a file or is inlined-truncated (WR-04).
        const scrubbed = scrubSecretsFromText(rawBody).text;
        // WR-03: read the end-instant ONCE for the DEBUG durationMs AND the emit
        // durationMs + timestamp, so the three are a single consistent snapshot
        // (the afterTurn triggers' one-read pattern).
        const endMs = deps.nowMs();

        if (dir) {
          mkdirSync(dir, { recursive: true });
          const persistPath = safePath(dir, `ctx-expand-${toolCallId}.txt`); // toolCallId, NOT agent text
          writeFileSync(persistPath, scrubbed, "utf-8");
          deps.logger.debug(
            {
              toolName: "ctx_expand",
              conversationId,
              summaryId,
              recoveredCount: parts.length,
              unrecoverable,
              spilled: true,
              durationMs: endMs - t0,
              step: "ctx_expand",
            },
            "ctx_expand spilled",
          );
          // O1: content-free expansion-hit metric (ids/counts/durationMs only —
          // NEVER the recovered body; the lossless store, AGENTS.md §2.2/§2.7).
          // WR-02: GUARDED — a throwing subscriber must never fail this completed
          // spill recovery (see emitExpansionMetric).
          emitExpansionMetric(deps, "ctx_expand", {
            conversationId: ctxScope.conversationId,
            agentId: ctxScope.agentId,
            sessionKey: ctxScope.sessionKey,
            tool: "ctx_expand",
            recoveredCount: parts.length,
            durationMs: endMs - t0,
            timestamp: endMs,
          });
          return jsonResult({
            fullOutputPath: persistPath,
            unrecoverable,
            note: `[Expanded region saved to: ${persistPath} — read it with the file tools if you need the full detail.]`,
          });
        }

        // No dir: inline the SCRUBBED body TRUNCATED to the cap rather than
        // returning it whole (WR-04). The cap mirrors `estimateTokens` (chars/4),
        // so `maxExpandTokens` tokens ⇒ `maxExpandTokens * 4` chars. The truncation
        // happens on the already-scrubbed text, then the bounded slice is
        // taint-wrapped — never inlined raw/unbounded/unscrubbed.
        const capChars = deps.maxExpandTokens * 4;
        const truncated = scrubbed.length > capChars;
        const clipped = truncated ? scrubbed.slice(0, capChars) : scrubbed;
        const cappedBody = wrapExternalContent(clipped, { source: "unknown" });
        deps.logger.debug(
          {
            toolName: "ctx_expand",
            conversationId,
            summaryId,
            recoveredCount: parts.length,
            unrecoverable,
            spilled: false,
            truncated,
            durationMs: endMs - t0,
            step: "ctx_expand",
          },
          "ctx_expand inlined oversized body truncated (no tool-results dir)",
        );
        // O1: content-free expansion-hit metric (WR-02 GUARDED; ids/counts only).
        emitExpansionMetric(deps, "ctx_expand", {
          conversationId: ctxScope.conversationId,
          agentId: ctxScope.agentId,
          sessionKey: ctxScope.sessionKey,
          tool: "ctx_expand",
          recoveredCount: parts.length,
          durationMs: endMs - t0,
          timestamp: endMs,
        });
        return jsonResult({ body: cappedBody, unrecoverable, truncated });
      }

      // (4) INLINE — taint-wrap the recovered body before it leaves the tool.
      const body = wrapExternalContent(rawBody, { source: "unknown" });
      // WR-03: read the end-instant ONCE for the DEBUG durationMs AND the emit
      // durationMs + timestamp (the afterTurn triggers' one-read pattern).
      const endMs = deps.nowMs();
      deps.logger.debug(
        {
          toolName: "ctx_expand",
          conversationId,
          summaryId,
          recoveredCount: parts.length,
          unrecoverable,
          spilled: false,
          durationMs: endMs - t0,
          step: "ctx_expand",
        },
        "ctx_expand complete",
      );
      // O1: content-free expansion-hit metric (ids/counts/durationMs only —
      // NEVER the recovered body; the lossless store, AGENTS.md §2.2/§2.7).
      // WR-02: GUARDED — a throwing subscriber must never fail this completed
      // inline recovery (see emitExpansionMetric).
      emitExpansionMetric(deps, "ctx_expand", {
        conversationId: ctxScope.conversationId,
        agentId: ctxScope.agentId,
        sessionKey: ctxScope.sessionKey,
        tool: "ctx_expand",
        recoveredCount: parts.length,
        durationMs: endMs - t0,
        timestamp: endMs,
      });
      return jsonResult({ body, unrecoverable });
    },
  };
}
