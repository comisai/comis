// SPDX-License-Identifier: Apache-2.0
/**
 * `ctx_inspect` — return a compressed summary's METADATA (depth, descendant
 * count, time span, token count, kind, taint, fallback) plus its immediate
 * child summaryIds and covered-message count, via the injected
 * `ContextStorePort`.
 *
 * Composition (RESEARCH Q2 — no dedicated single-summary getter): filters
 * `getSummaries(conversationId)` by `summaryId`, then composes
 * `getSummaryChildren` + `getSummaryMessages`. Returns METADATA ONLY — the
 * summary `content` is NOT surfaced and NOT logged, so the output is not
 * taint-wrapped (metadata is not untrusted content). The agent uses the
 * returned shape to decide whether to `ctx_expand` the region.
 *
 * Owner-scoped: the conversation is derived per-call from
 * `tryGetContext().sessionKey` (fail-closed `permission_denied` with no live
 * session), never a caller-supplied id (E2 isolation).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { tryGetContext, type LcdSummary } from "@comis/core";

import { jsonResult, throwToolError, readStringParam } from "../../../platform-tools/tool-helpers.js";
import type { ContextToolDeps } from "./context-tools-shared.js";

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
      // SCOPE — derive per-call, never cache; fail closed with no live session.
      const ctx = tryGetContext();
      if (!ctx?.sessionKey) {
        throwToolError("permission_denied", "ctx_inspect operates only inside a live session.", {
          hint: "This tool inspects the current conversation's compressed history; it cannot run outside a session.",
        });
      }
      const conversationId = ctx.sessionKey;
      const summaryId = readStringParam(params, "summaryId", true)!;

      // Filter the (tens-of) summaries for this conversation — no single-summary getter (YAGNI, Q2).
      const summary: LcdSummary | undefined = deps.store
        .getSummaries(conversationId)
        .find((s) => s.summaryId === summaryId);
      if (!summary) {
        throwToolError("not_found", `No summary with id "${summaryId}" in this conversation.`, {
          hint: "Use ctx_search to find a valid summaryId, or check the <summary> footer.",
        });
      }

      // Compose the structural edges (the new region-walk methods).
      const children = deps.store.getSummaryChildren(conversationId, summaryId);
      const coveredMessageIds = deps.store.getSummaryMessages(conversationId, summaryId);

      // ids/counts/timestamps only — NEVER the summary content.
      deps.logger.debug(
        {
          toolName: "ctx_inspect",
          conversationId,
          summaryId,
          kind: summary.kind,
          depth: summary.depth,
          childCount: children.length,
          coveredMessageCount: coveredMessageIds.length,
          step: "ctx_inspect",
        },
        "ctx_inspect complete",
      );

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
