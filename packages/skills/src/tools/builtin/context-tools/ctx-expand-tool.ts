// SPDX-License-Identifier: Apache-2.0
/**
 * `ctx_expand` — recover the underlying detail of a compressed summary region
 * of THIS conversation, via the injected `ContextStorePort`.
 *
 * A bounded in-process MULTI-HOP walk that descends the summary-parent (T2)
 * hierarchy (condensed → child summaries → leaf summaries → messages) with
 * depth/token/node-visit caps, returning a RANKED CITED evidence bundle. The
 * walk runs READ-ONLY inside the single-flight `runOnConversation` serializer and
 * delegates the BFS to `ctxExpandWalk` (`ctx-expand-walk.ts`). It is NOT a
 * sub-agent. When the knowledge graph is empty/default-off
 * (no `spreadLane` threaded), the walk runs T2-only (the live floor).
 *
 * Walk + reconstruct + taint + budget-cap (the read-tool + exec-externalization
 * blueprint):
 *   1. SCOPE: conversation derived per-call from `tryGetContext().sessionKey`
 *      (fail-closed `permission_denied` with no live session) — never cached,
 *      never a caller-supplied id (conversation isolation).
 *   2. WALK: a bounded BFS over `getSummaryChildren` (T2 descent) +
 *      `getSummaryMessages` (leaf → message ids), re-joined via `getMessages`
 *      (id-keyed map). Depth is tier-gated (`maxExpandDepth`); the bundle is
 *      bounded by `maxExpandTokens` + a node-visit cap; a visited-set makes it
 *      cycle-safe. A drifted (missing) id is SKIPPED, never thrown — the result
 *      reports an `unrecoverable` count so the model knows coverage is partial.
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
import { wrapExternalContent, scrubSecretsFromText, safePath } from "@comis/core";

import { jsonResult, readStringParam } from "../../../platform-tools/tool-helpers.js";
import { emitExpansionMetric, estimateTokens, requireCtxScope, type ContextToolDeps } from "./context-tools-shared.js";
import { ctxExpandWalk } from "./ctx-expand-walk.js";

/** A sane node-visit bound for the multi-hop walk (caps a pathological wide DAG). */
const MAX_WALK_NODES = 64;

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
      //     LIVE context per-call; fail closed without a fully-scoped
      //     session. NEVER a wiring closure (multi-agent-safe).
      const ctxScope = requireCtxScope();
      const conversationId = ctxScope.conversationId;
      const summaryId = readStringParam(params, "summaryId", true)!;
      const t0 = deps.nowMs();

      // (2) WALK + RECONSTRUCT — a bounded multi-hop BFS over the
      //     summary-parent (T2) hierarchy (condensed → child summaries → leaf
      //     summaries → messages), depth/token/node-visit capped, returning a
      //     RANKED CITED evidence bundle. T2-only floor: no spreadLane is threaded
      //     into the tool deps today, so the KG (T4) lane is absent and the walk
      //     runs T2-only (the live default — graceful degradation). A drifted id is
      //     SKIPPED (counted unrecoverable), never thrown.
      //
      //     The walk is READ-ONLY and runs INSIDE the single-flight
      //     `runOnConversation` serializer so a deferred compaction
      //     write cannot rewrite the DAG ordinals mid-walk. Scope-inheritance:
      //     EVERY edge read passes `ctxScope` (an out-of-scope node is unreachable
      //     by construction) — the depth cap is a wiring-time CAPACITY knob,
      //     but scope is ALWAYS per-call.
      const bundle = await deps.store.runOnConversation(conversationId, () =>
        ctxExpandWalk(deps.store, ctxScope, summaryId, {
          maxDepth: deps.maxExpandDepth ?? 1,
          maxTokens: deps.maxExpandTokens,
          maxNodes: MAX_WALK_NODES,
        }),
      );
      const parts = bundle.items.map((it) => it.text);
      const unrecoverable = bundle.unrecoverable;
      const rawBody = parts.join(BODY_SEPARATOR);

      // (3) BUDGET + SPILL — oversized regions are ALWAYS secret-scrubbed, then
      //     either written to a file handle (when a session dir exists) OR, when
      //     NO dir is available (heartbeat/cron/ephemeral context, or a resolver
      //     parse failure), inlined TRUNCATED to the cap. The scrub AND the
      //     size bound must NOT be conditional on a dir being present — otherwise
      //     the no-dir case falls through to the inline
      //     path and returns the FULL rawBody UNBOUNDED and UNSCRUBBED, an
      //     unbounded-inline + unscrubbed-egress leak the cap exists to prevent.
      const dir = deps.getToolResultsDir();
      const oversized = estimateTokens(rawBody) > deps.maxExpandTokens;
      if (oversized) {
        // Defense-in-depth on the broadest egress surface — ALWAYS, regardless of
        // whether the body spills to a file or is inlined-truncated.
        const scrubbed = scrubSecretsFromText(rawBody).text;
        // Read the end-instant ONCE for the DEBUG durationMs AND the emit
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
          // Content-free expansion-hit metric (ids/counts/durationMs only —
          // NEVER the recovered body; the lossless store, AGENTS.md §2.2/§2.7).
          // GUARDED — a throwing subscriber must never fail this completed
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
        // returning it whole. The cap mirrors `estimateTokens` (chars/4),
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
        // Content-free expansion-hit metric (GUARDED; ids/counts only).
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

      // (4) INLINE — scrub secrets, THEN taint-wrap the recovered body before it
      //     leaves the tool. The egress scrub mirrors the oversized spill branch:
      //     the recovered region can legitimately contain a credential (the
      //     lossless store keeps the raw conversation), but it must never reach the
      //     model context / be re-injected via summaries verbatim. The base store is
      //     untouched — only this derived egress copy is scrubbed.
      const body = wrapExternalContent(scrubSecretsFromText(rawBody).text, { source: "unknown" });
      // Read the end-instant ONCE for the DEBUG durationMs AND the emit
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
      // Content-free expansion-hit metric (ids/counts/durationMs only —
      // NEVER the recovered body; the lossless store, AGENTS.md §2.2/§2.7).
      // GUARDED — a throwing subscriber must never fail this completed
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
