// SPDX-License-Identifier: Apache-2.0
/**
 * `ctx_inspect` — return a compressed summary's METADATA (depth, descendant
 * count, time span, token count, kind, taint, fallback) plus its immediate
 * child summaryIds and covered-message count, via the injected
 * `ContextStorePort`.
 *
 * Composition (no dedicated single-summary getter): filters
 * `getSummaries(conversationRef)` by `summaryId`, then composes
 * `getSummaryChildren` + `getSummaryMessages`. Returns METADATA ONLY — the
 * summary `content` is NOT surfaced and NOT logged, so the output is not
 * taint-wrapped (metadata is not untrusted content). The agent uses the
 * returned shape to decide whether to `ctx_expand` the region.
 *
 * Owner-scoped: the conversation is derived per-call from
 * `tryGetContext().sessionKey` (fail-closed `permission_denied` with no live
 * session), never a caller-supplied id (conversation isolation).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { type LcdSummary } from "@comis/core";

import { jsonResult, throwToolError, readStringParam } from "../../../platform-tools/tool-helpers.js";
import { emitExpansionMetric, requireCtxScope, type ContextToolDeps } from "./context-tools-shared.js";

const CtxInspectParams = Type.Object({
  summaryId: Type.String({ description: "The summaryId (from a ctx_search summary hit or a <summary> footer) to inspect." }),
});

/**
 * Create the `ctx_inspect` tool — metadata + structure of one compressed
 * summary region, for THIS conversation only.
 */
export function createCtxInspectTool(deps: ContextToolDeps): AgentTool<typeof CtxInspectParams> {
  return {
    name: "ctx_inspect",
    label: "Context Inspect",
    description:
      "Inspect a compressed summary region of THIS conversation: its depth, how many messages it covers, " +
      "its time span, token cost, child summaries, and covered-message count — metadata only (use ctx_expand " +
      "to recover the underlying detail). Distinct from cross-session recall.",
    parameters: CtxInspectParams,

    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      // SCOPE — build the (conversation, agent, tenant) read scope from the LIVE
      // context per-call; fail closed without a fully-scoped session.
      const ctxScope = requireCtxScope();
      const conversationRef = ctxScope.conversationRef;
      const summaryId = readStringParam(params, "summaryId", true)!;
      const t0 = deps.nowMs();

      // Filter this agent's summaries (agent-scoped) — there is no single-summary getter.
      const summary: LcdSummary | undefined = deps.store
        .getSummaries(ctxScope)
        .find((s) => s.summaryId === summaryId);
      if (!summary) {
        throwToolError("not_found", `No summary with id "${summaryId}" in this conversation.`, {
          hint: "Use ctx_search to find a valid summaryId, or check the <summary> footer.",
        });
      }

      // Compose the structural edges (the new region-walk methods) — agent-scoped.
      const children = deps.store.getSummaryChildren(ctxScope, summaryId);
      const coveredMessageIds = deps.store.getSummaryMessages(ctxScope, summaryId);

      // ids/counts/timestamps only — NEVER the summary content.
      deps.logger.debug(
        {
          toolName: "ctx_inspect",
          conversationRef,
          summaryId,
          kind: summary.kind,
          depth: summary.depth,
          childCount: children.length,
          coveredMessageCount: coveredMessageIds.length,
          step: "ctx_inspect",
        },
        "ctx_inspect complete",
      );
      // Content-free expansion-hit metric (ids/counts/durationMs only —
      // NEVER the summary content; the lossless store, AGENTS.md §2.2/§2.7).
      // recoveredCount = the covered-message count the inspection surfaced.
      // GUARDED — a throwing subscriber must never fail this completed
      // metadata read (see emitExpansionMetric).
      // Read the end-instant ONCE so durationMs and timestamp are a single
      // consistent snapshot (the afterTurn triggers' one-read pattern).
      const endMs = deps.nowMs();
      emitExpansionMetric(deps, "ctx_inspect", {
        conversationRef: ctxScope.conversationRef,
        agentId: ctxScope.agentId,
        sessionKey: ctxScope.sessionKey,
        tool: "ctx_inspect",
        recoveredCount: coveredMessageIds.length,
        durationMs: endMs - t0,
        timestamp: endMs,
      });

      // METADATA ONLY — deliberately NOT taint-wrapped (metadata is not content;
      // the summary body is never surfaced here, only by ctx_expand).
      return jsonResult({
        summaryId: summary.summaryId,
        kind: summary.kind,
        depth: summary.depth,
        descendantCount: summary.descendantCount,
        earliestAt: summary.earliestAt,
        latestAt: summary.latestAt,
        tokenCount: summary.tokenCount,
        taint: summary.taint,
        fallback: summary.fallback,
        childSummaryIds: children.map((c) => c.summaryId),
        coveredMessageCount: coveredMessageIds.length,
      });
    },
  };
}
