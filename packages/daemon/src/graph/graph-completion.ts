// SPDX-License-Identifier: Apache-2.0
/**
 * Graph completion, announcement, budget, and timeout handling.
 * Manages the final processing when a graph reaches terminal state:
 * timer cleanup, event emission, metadata persistence, announcement
 * receipt-aware governed delivery, budget
 * exceeded handling, and graph-level timeout cancellation.
 * @module
 */

import { safePath, systemNowMs, systemDateFrom, toSafeErrorLogString } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { writeRegularFile } from "@comis/observability";
import { clearAllTimers } from "./graph-cleanup.js";
import { deliverGovernedGraphAnnouncement } from "./graph-announcement-delivery.js";
import type {
  CoordinatorSharedState,
  GraphCoordinatorDeps,
  GraphRunState,
} from "./graph-coordinator-state.js";

// ---------------------------------------------------------------------------
// Announcement types
// ---------------------------------------------------------------------------

/** Structured announcement result with optional inline buttons for long outputs. */
export interface GraphAnnouncement {
  text: string;
  buttons?: import("@comis/core").RichButton[][];
}

// ---------------------------------------------------------------------------
// Per-subagent corrected-$ subtree rollup
// ---------------------------------------------------------------------------

/**
 * Sum a node's own corrected-$ cost plus the cost of every descendant (the
 * node's subtree), reading the per-node cumulative ledger `gs.nodeCost`
 * (populated in handleSubAgentCompleted from each completion's `event.cost`,
 * the same corrected dollars feeding `gs.cumulativeCost`).
 *
 * "Descendants" walk the node→children edges — the REVERSE of `dependsOn` (a
 * node lists its upstream parents in `dependsOn`, so a node's children are the
 * nodes that name it in their `dependsOn`). A child's cost therefore rolls into
 * its parent's subtree total; the recursion composes
 * (`rollup(p) === own(p) + Σ rollup(child)`) over CORRECTED dollars from
 * provider usage reports, never estimates.
 *
 * PURE + deterministic (no IO) — unit-testable in isolation and reusable by
 * read-side cost reporting. (tenant,agent)-scoped: reads ONLY the per-graph `gs` (which
 * IS that scope), so two graphs in different scopes never cross-contaminate.
 * A cycle-safe visited set guards against malformed graphs (sorted/validated
 * graphs are acyclic, but the rollup must never infinite-loop).
 *
 * @param gs - The per-graph run state (owns the gs.nodeCost ledger + the graph).
 * @param nodeId - The subtree root to roll up.
 * @returns The corrected-$ sum of the node + all transitive descendants.
 */
export function computeSubtreeCost(gs: GraphRunState, nodeId: string): number {
  // Build the node→children adjacency once (reverse of dependsOn).
  const children = new Map<string, string[]>();
  for (const node of gs.graph.graph.nodes) {
    for (const parentId of node.dependsOn) {
      const bucket = children.get(parentId);
      if (bucket) bucket.push(node.nodeId);
      else children.set(parentId, [node.nodeId]);
    }
  }

  const visited = new Set<string>();
  const walk = (id: string): number => {
    if (visited.has(id)) return 0; // cycle guard (acyclic by validation, defensive here)
    visited.add(id);
    let sum = gs.nodeCost.get(id) ?? 0; // absent → 0 (no NaN)
    for (const childId of children.get(id) ?? []) sum += walk(childId);
    return sum;
  };
  return walk(nodeId);
}

// ---------------------------------------------------------------------------
// Graph completion
// ---------------------------------------------------------------------------

/**
 * Handle graph completion: mark time, clear timers, emit events,
 * write metadata, build and deliver announcement.
 */
export async function handleGraphCompletion(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "eventBus" | "logger" | "sendGovernedAnnouncement" | "tenantId" | "touchParentSession" | "graphRetentionMs" | "registerGraphReportCallback">,
  gs: GraphRunState,
): Promise<Result<void, Error>> {
  // Prevent double-completion
  if (gs.completedAt !== undefined) return ok(undefined);

  // Touch parent lane one final time before announcement delivery
  if (gs.callerSessionKey) {
    deps.touchParentSession?.(gs.callerSessionKey);
  }

  // 1. Mark completion time
  gs.completedAt = systemNowMs();

  // 1b. Clean up event-driven spawn gate on completion
  gs.cacheWarmCleanup?.();

  // 2. Clear all timers
  clearAllTimers(deps, gs);

  // 2b. Emit graph:completed event
  const snap = gs.stateMachine.snapshot();
  let nodesCompleted = 0;
  let nodesFailed = 0;
  let nodesSkipped = 0;
  for (const [, nState] of snap.nodes) {
    if (nState.status === "completed") nodesCompleted++;
    else if (nState.status === "failed") nodesFailed++;
    else if (nState.status === "skipped") nodesSkipped++;
  }
  // Compute cache rollup once -- shared by event emission and completion log
  let graphCacheReadTokens = 0;
  let graphCacheWriteTokens = 0;
  const nodeEffectiveness: Record<string, number> = {};

  for (const [nodeId, cacheData] of gs.nodeCacheData) {
    graphCacheReadTokens += cacheData.cacheReadTokens;
    graphCacheWriteTokens += cacheData.cacheWriteTokens;
    const nodeTotal = cacheData.cacheReadTokens + cacheData.cacheWriteTokens;
    if (nodeTotal > 0) {
      nodeEffectiveness[nodeId] = Math.round((cacheData.cacheReadTokens / nodeTotal) * 1000) / 1000;
    }
  }

  const cacheable = graphCacheReadTokens + graphCacheWriteTokens;
  const graphCacheEffectiveness = cacheable > 0
    ? Math.round((graphCacheReadTokens / cacheable) * 1000) / 1000
    : undefined;

  const cacheRollupFields = gs.nodeCacheData.size > 0
    ? { graphCacheReadTokens, graphCacheWriteTokens, graphCacheEffectiveness, nodeEffectiveness }
    : {};

  // Surface the per-node token-spend breakdown (the production reader of
  // gs.nodeTokenSpend, otherwise a dead write). Present only when at least one
  // node recorded spend — the payload is unchanged otherwise.
  const nodeTokenSpendFields = gs.nodeTokenSpend.size > 0
    ? { nodeTokenSpend: Object.fromEntries(gs.nodeTokenSpend) }
    : {};

  // Surface the per-node CUMULATIVE corrected-$ cost ledger (the
  // production reader of gs.nodeCost). Content-free (nodeId → number); present
  // only when non-empty — the payload is unchanged otherwise (same shape rule
  // as nodeTokenSpend). The subtree rollups derive from this via computeSubtreeCost.
  const nodeCostFields = gs.nodeCost.size > 0
    ? { nodeCost: Object.fromEntries(gs.nodeCost) }
    : {};

  deps.eventBus.emit("graph:completed", {
    graphId: gs.graphId,
    status: gs.stateMachine.getGraphStatus(),
    durationMs: gs.completedAt! - gs.startedAt,
    nodeCount: gs.graph.graph.nodes.length,
    nodesCompleted,
    nodesFailed,
    nodesSkipped,
    ...(gs.cancelReason !== undefined && { cancelReason: gs.cancelReason }),
    timestamp: systemNowMs(),
    // Graph-level cache aggregation
    ...cacheRollupFields,
    // Per-node token-spend breakdown
    ...nodeTokenSpendFields,
    // Per-node cumulative corrected-$ cost ledger
    ...nodeCostFields,
  });

  // 2c. Write _run-metadata.json to disk
  writeRunMetadata(deps, gs);

  const callerConversation = gs.callerConversationLocator;
  const callerEndpoint = gs.callerEndpoint;
  const hasCallerIdentity = gs.callerSessionKey !== undefined || gs.callerAgentId !== undefined;
  const hasDeclaredParent = gs.callerSessionKey !== undefined && gs.callerAgentId !== undefined;
  const parentIdentityValid = !hasCallerIdentity || (hasDeclaredParent
    && callerConversation !== undefined
    && gs.callerPrincipalId !== undefined
    && callerEndpoint !== undefined
    && callerConversation.conversationScope.tenantId === deps.tenantId
    && callerConversation.conversationScope.agentId === gs.callerAgentId
    && (gs.announceChannelType === undefined || callerEndpoint.channelType === gs.announceChannelType)
    && (gs.announceChannelId === undefined || callerEndpoint.conversationId === gs.announceChannelId)
  );
  const hasAnyAnnouncementRoute = gs.announceChannelType !== undefined
    || gs.announceChannelId !== undefined;
  const hasCompleteAnnouncementRoute = gs.announceChannelType !== undefined
    && gs.announceChannelId !== undefined;
  const announcementIdentityValid = !hasAnyAnnouncementRoute || (
    hasCompleteAnnouncementRoute
    && hasDeclaredParent
    && parentIdentityValid
  );
  if (!announcementIdentityValid) {
    deps.logger?.warn({
      graphId: gs.graphId,
      errorKind: "precondition" as const,
      hint: "Reject delivery and verify the caller session is canonical, complete, and matches the announcement route",
    }, "Graph parent identity is invalid");
  }

  // 3. Build announcement text. The callback factory is invoked only for a
  // truncated report, so short outputs do not allocate unused callback targets.
  const callerSessionKey = gs.callerSessionKey;
  const callerAgentId = gs.callerAgentId;
  const callerPrincipalId = gs.callerPrincipalId;
  const announceChannelType = gs.announceChannelType;
  const announceChannelId = gs.announceChannelId;
  const registerGraphReportCallback = deps.registerGraphReportCallback;
  const reportExpiresAt = gs.completedAt + (deps.graphRetentionMs ?? 3_600_000);
  const registerReportCallback = (): string | undefined => {
    if (
      !parentIdentityValid
      || callerConversation === undefined
      || callerPrincipalId === undefined
      || callerEndpoint === undefined
      || callerSessionKey === undefined
      || callerAgentId === undefined
      || announceChannelType === undefined
      || announceChannelId === undefined
      || registerGraphReportCallback === undefined
    ) return undefined;

    const registered = tryCatch(() => registerGraphReportCallback({
      graphId: gs.graphId,
      tenantId: callerConversation.conversationScope.tenantId,
      conversationRef: callerConversation.conversationRef,
      resolvingPrincipalId: callerPrincipalId,
      endpoint: callerEndpoint,
      userId: callerPrincipalId,
      sessionKey: callerSessionKey,
      agentId: callerAgentId,
      channelType: announceChannelType,
      channelKey: announceChannelId,
      expiresAt: reportExpiresAt,
    }));
    if (!registered.ok || !registered.value.ok) {
      deps.logger?.warn({
        graphId: gs.graphId,
        errorKind: "resource" as const,
        hint: "Retry the graph if a signed report callback is required; the inline preview remains available",
      }, "Graph report callback registration failed");
      return undefined;
    }
    return registered.value.value;
  };
  const { text: announcement, buttons: announcementButtons } = buildGraphAnnouncement(
    gs,
    registerReportCallback,
  );
  const deliveryOptions = callerEndpoint?.threadId !== undefined || announcementButtons !== undefined
    ? {
        ...(callerEndpoint?.threadId ? { threadId: callerEndpoint.threadId } : {}),
        ...(announcementButtons
          ? { extra: { buttons: announcementButtons } }
          : {}),
      }
    : undefined;

  const sendGoverned = async (
    finalText: string,
    options?: { threadId?: string; extra?: Record<string, unknown> },
  ) => deliverGovernedGraphAnnouncement(
    { send: deps.sendGovernedAnnouncement, logger: deps.logger },
    {
      graphId: gs.graphId,
      agentId: callerAgentId,
      callerSessionKey,
      callerConversation,
      destinationEndpoint: callerEndpoint,
      channelType: announceChannelType,
      channelId: announceChannelId,
      text: finalText,
      ...(options ? { options } : {}),
    },
  );

  // 4. Deliver deterministic graph output through one stable, receipt-aware
  // outward operation. Parent execution is intentionally outside this terminal
  // boundary because replaying it could repeat arbitrary tool effects.
  if (hasAnyAnnouncementRoute) {
    if (!announcementIdentityValid) {
      return err(new Error("Graph announcement identity or route is invalid"));
    }
    const delivery = await sendGoverned(announcement, deliveryOptions);
    if (!delivery.ok) return delivery;
  }

  // 5. Log at INFO level
  deps.logger?.info(
    {
      submodule: "graph-coordinator",
      graphId: gs.graphId,
      status: gs.stateMachine.getGraphStatus(),
      durationMs: gs.completedAt - gs.startedAt,
      nodesTotal: gs.graph.graph.nodes.length,
      nodesSucceeded: nodesCompleted,
      nodesFailed,
      totalCostUsd: gs.cumulativeCost > 0 ? gs.cumulativeCost : undefined,
      totalTokens: gs.cumulativeTokens > 0 ? gs.cumulativeTokens : undefined,
      // Graph-level cache aggregation (computed above for event + log)
      ...cacheRollupFields,
    },
    "Graph execution complete",
  );
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Preview truncation
// ---------------------------------------------------------------------------

/**
 * Truncate text to a word-boundary-aware preview with ellipsis.
 * Returns "(no output)" for empty/undefined input.
 * Strategy:
 * 1. If text fits within maxLen, return as-is.
 * 2. Extract first paragraph (up to first double-newline). If it fits, use it with ellipsis appended.
 * 3. Otherwise, find last space within maxLen and truncate there with ellipsis.
 * 4. If no space found (single massive word), hard-cut at maxLen with ellipsis.
 */
export function truncatePreview(text: string | undefined, maxLen: number = 500): string {
  if (!text || text.trim().length === 0) return "(no output)";
  if (text.length <= maxLen) return text;

  // Try first paragraph: if it fits, use it
  const firstPara = text.split(/\n\n/)[0]!;
  if (firstPara.length <= maxLen) return firstPara + "\u2026";

  // Find last space within maxLen for word-boundary truncation
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) return slice.slice(0, lastSpace) + "\u2026";

  // No space found (single massive word): hard-cut at maxLen
  return slice + "\u2026";
}

// ---------------------------------------------------------------------------
// Announcement preview extraction
// ---------------------------------------------------------------------------

/**
 * Extract a meaningful preview from a long markdown report for the
 * graph announcement. Unlike truncatePreview (which grabs the first
 * paragraph), this strips leading markdown noise (--- separators,
 * blank lines) and extracts substantive content up to maxLen.
 * Strategy:
 * 1. Strip leading `---` separator lines and blank lines.
 * 2. Take up to maxLen chars of the cleaned content.
 * 3. Cut at the last markdown section boundary (`\n\n---\n` or `\n\n##`)
 *    within the limit for a clean break. Falls back to paragraph boundary.
 * 4. Append ellipsis if truncated.
 */
export function extractAnnouncementPreview(text: string, maxLen: number): string {
  if (!text || text.trim().length === 0) return "(no output)";

  // Strip leading "---" separators and blank lines
  const cleaned = text.replace(/^(?:\s*---\s*\n)+/, "").trimStart();
  if (cleaned.length === 0) return truncatePreview(text, maxLen);
  if (cleaned.length <= maxLen) return cleaned;

  const slice = cleaned.slice(0, maxLen);

  // Try to cut at a markdown section boundary for a clean break
  // Look for the last "\n\n---\n" or "\n\n## " within the slice
  const sectionBreak = Math.max(
    slice.lastIndexOf("\n\n---\n"),
    slice.lastIndexOf("\n\n## "),
  );
  if (sectionBreak > maxLen * 0.3) {
    return slice.slice(0, sectionBreak).trimEnd() + "\n\n\u2026";
  }

  // Fall back to last double-newline (paragraph boundary)
  const paraBreak = slice.lastIndexOf("\n\n");
  if (paraBreak > maxLen * 0.3) {
    return slice.slice(0, paraBreak).trimEnd() + "\n\n\u2026";
  }

  // Last resort: word boundary
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) return slice.slice(0, lastSpace) + "\u2026";

  return slice + "\u2026";
}

// ---------------------------------------------------------------------------
// Announcement
// ---------------------------------------------------------------------------

/**
 * Build the announcement text for a completed graph.
 * Leaf nodes (no downstream dependents) get their full output surfaced so the
 * user sees the actual result (e.g. trading decision). Intermediate nodes get
 * truncated previews to keep the message concise.
 */
export function buildGraphAnnouncement(
  gs: GraphRunState,
  createReportCallback?: () => string | undefined,
): GraphAnnouncement {
  const maxAnnouncementChars = gs.maxAnnouncementChars ?? 3000;
  const snap = gs.stateMachine.snapshot();
  const label = gs.graph.graph.label ?? gs.graphId;
  const durationMs = (gs.completedAt ?? systemNowMs()) - gs.startedAt;

  // Identify leaf nodes — nodes that no other node depends on
  const depTargets = new Set(gs.graph.graph.nodes.flatMap(n => n.dependsOn));
  const leafNodeIds = new Set(
    gs.graph.graph.nodes
      .filter(n => !depTargets.has(n.nodeId))
      .map(n => n.nodeId),
  );

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const total = gs.graph.graph.nodes.length;

  const leafOutputs: string[] = [];
  const rawLeafOutputs: string[] = [];
  const summaryParts: string[] = [];

  for (const node of gs.graph.graph.nodes) {
    const nodeState = snap.nodes.get(node.nodeId);
    if (!nodeState) continue;

    if (nodeState.status === "completed") {
      completed++;
      if (leafNodeIds.has(node.nodeId)) {
        const raw = nodeState.output ?? "(no output)";
        rawLeafOutputs.push(raw);
        leafOutputs.push(raw);
      } else {
        summaryParts.push(`\u2705 ${node.nodeId}`);
      }
    } else if (nodeState.status === "failed") {
      failed++;
      summaryParts.push(`\u274C ${node.nodeId}: ${nodeState.error ?? "unknown error"}`);
    } else if (nodeState.status === "skipped") {
      skipped++;
      summaryParts.push(`\u23ED ${node.nodeId}`);
    }
  }

  // Build footer parts (always present)
  const footerParts: string[] = [
    "",
    "---",
    `\uD83D\uDCCA ${label} \u2014 ${completed}/${total} nodes | ${Math.round(durationMs / 1000)}s | GraphId: ${gs.graphId}`,
  ];

  if (failed > 0 || skipped > 0) {
    footerParts.push(`${failed} failed, ${skipped} skipped`);
  }

  if (summaryParts.length > 0) {
    footerParts.push(summaryParts.join(" | "));
  }

  // Build full announcement text
  const fullParts: string[] = [...leafOutputs, ...footerParts];
  const fullText = fullParts.join("\n");

  // Check if truncation is needed
  const totalLeafChars = rawLeafOutputs.reduce((sum, s) => sum + s.length, 0);

  if (maxAnnouncementChars > 0 && fullText.length > maxAnnouncementChars) {
    // Build a meaningful preview: strip leading separators and extract substantive content.
    // truncatePreview fails on markdown reports that start with "---" (returns just "---…").
    const previewLimit = Math.floor(maxAnnouncementChars * 0.8);
    const truncatedLeafOutputs = rawLeafOutputs.map(raw =>
      extractAnnouncementPreview(raw, previewLimit),
    );

    const callbackData = createReportCallback?.();
    const reportAvailability = callbackData === undefined
      ? `\uD83D\uDCC4 Full report is unavailable for attachment delivery (${totalLeafChars.toLocaleString()} chars).`
      : `\uD83D\uDCC4 Full report available (${totalLeafChars.toLocaleString()} chars) \u2014 tap below to receive as document.`;
    const truncatedParts: string[] = [
      ...truncatedLeafOutputs,
      "",
      reportAvailability,
      ...footerParts,
    ];

    return {
      text: truncatedParts.join("\n"),
      ...(callbackData === undefined
        ? {}
        : { buttons: [[{ text: "\uD83D\uDCC4 Full Report", callback_data: callbackData }]] }),
    };
  }

  return { text: fullText };
}

// ---------------------------------------------------------------------------
// Budget exceeded
// ---------------------------------------------------------------------------

/**
 * Handle budget exceeded: kill all running nodes (regular and driver),
 * cancel the graph, and trigger completion.
 */
export function handleBudgetExceeded(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "sendGovernedAnnouncement" | "tenantId" | "touchParentSession" | "graphRetentionMs" | "registerGraphReportCallback">,
  gs: GraphRunState,
  reason: string,
  complete: () => void = () => handleGraphCompletion(state, deps, gs),
): void {
  gs.cancelReason = "budget";
  // Kill all running nodes
  for (const [runId, nodeId] of gs.runIdToNode) {
    deps.subAgentRunner.killRun(runId);
    gs.stateMachine.markNodeFailed(nodeId, `Budget exceeded (${reason})`);
  }
  gs.runIdToNode.clear();

  // Kill active driver runs
  for (const [nodeId, ds] of gs.driverStates) {
    if (ds.currentRunId) {
      deps.subAgentRunner.killRun(ds.currentRunId);
      gs.driverRunIdMap.delete(ds.currentRunId);
    }
    if (ds.pendingParallel) {
      for (const [runId] of ds.pendingParallel) {
        deps.subAgentRunner.killRun(runId);
        gs.driverRunIdMap.delete(runId);
      }
    }
    ds.driver.onAbort(ds.ctx);
    gs.stateMachine.markNodeFailed(nodeId, `Budget exceeded (${reason})`);
  }
  gs.driverStates.clear();

  gs.runningCount = 0;

  if (!gs.stateMachine.isTerminal()) {
    gs.stateMachine.cancel();
  }

  complete();

  // The graph cumulative-budget seam (this function) interoperates with the
  // daemon-wide spend kill-switch via the OPEN `reason` param — a
  // spend-ceiling breach routes through HERE with `"spend_exceeded"`, not a parallel
  // graph kill-path. The two ceilings are DISTINCT: `graph.budget.maxTokens/maxCost`
  // is the per-graph cumulative cap (reasons `"tokens"`/`"cost"`); the spend ceiling
  // is the per-(agent|tenant|global) dollar kill-switch (`observability.spend.*`).
  // Name the right knob so an operator drilling the WARN tunes the ceiling that
  // actually fired. Counts-only payload — dollar amounts ride structured fields,
  // never the log-message body.
  const hint =
    reason === "spend_exceeded"
      ? "A spend ceiling (observability.spend.{perAgentUsd,perTenantUsd,daemonGlobalUsd}) was exceeded during graph execution; raise it or set observability.spend.action"
      : "Graph budget is configurable via graph.budget.maxTokens/maxCost";
  deps.logger?.warn(
    { graphId: gs.graphId, cumulativeTokens: gs.cumulativeTokens, cumulativeCost: gs.cumulativeCost, reason, hint, errorKind: "resource" as const },
    "Graph execution budget exceeded",
  );
}

// ---------------------------------------------------------------------------
// Graph timeout
// ---------------------------------------------------------------------------

/**
 * Handle graph-level timeout: kill all running nodes, cancel,
 * and trigger completion.
 */
export function handleGraphTimeout(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "sendGovernedAnnouncement" | "tenantId" | "touchParentSession" | "graphRetentionMs" | "registerGraphReportCallback">,
  gs: GraphRunState,
  complete: () => void = () => handleGraphCompletion(state, deps, gs),
): void {
  gs.cancelReason = "timeout";
  for (const [runId, nodeId] of gs.runIdToNode) {
    deps.subAgentRunner.killRun(runId);
    gs.stateMachine.markNodeFailed(nodeId, "Graph timeout");
  }
  gs.runIdToNode.clear();

  // Kill active driver runs
  for (const [nodeId, ds] of gs.driverStates) {
    if (ds.currentRunId) {
      deps.subAgentRunner.killRun(ds.currentRunId);
      gs.driverRunIdMap.delete(ds.currentRunId);
    }
    if (ds.pendingParallel) {
      for (const [runId] of ds.pendingParallel) {
        deps.subAgentRunner.killRun(runId);
        gs.driverRunIdMap.delete(runId);
      }
    }
    ds.driver.onAbort(ds.ctx);
    gs.stateMachine.markNodeFailed(nodeId, "Graph timeout");
  }
  gs.driverStates.clear();

  gs.runningCount = 0;

  if (!gs.stateMachine.isTerminal()) {
    gs.stateMachine.cancel();
  }

  complete();

  deps.logger?.warn(
    { graphId: gs.graphId, timeoutMs: gs.graph.graph.timeoutMs, hint: "Graph timeout is configurable via graph.timeoutMs", errorKind: "timeout" as const },
    "Graph execution timed out",
  );
}

// ---------------------------------------------------------------------------
// Run metadata
// ---------------------------------------------------------------------------

/**
 * Write a _run-metadata.json file to the graph's shared directory.
 * Non-critical: failures are logged at DEBUG and never crash the coordinator.
 */
export function writeRunMetadata(
  deps: Pick<GraphCoordinatorDeps, "logger">,
  gs: GraphRunState,
): void {
  try {
    const snap = gs.stateMachine.snapshot();
    let nodesSucceeded = 0;
    let nodesFailed = 0;
    let nodesSkipped = 0;
    let nodesRetried = 0;
    const nodesMap: Record<string, {
      status: string;
      durationMs: number | null;
      subAgentRunId: string | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      cacheEffectiveness: number | null;
      attemptsUsed: number;
    }> = {};

    for (const [nodeId, nState] of snap.nodes) {
      if (nState.status === "completed") nodesSucceeded++;
      else if (nState.status === "failed") nodesFailed++;
      else if (nState.status === "skipped") nodesSkipped++;

      const durationMs = (nState.startedAt && nState.completedAt)
        ? nState.completedAt - nState.startedAt
        : null;

      const cacheData = gs.nodeCacheData.get(nodeId);
      const cacheRead = cacheData?.cacheReadTokens ?? null;
      const cacheWrite = cacheData?.cacheWriteTokens ?? null;
      const cacheable = (cacheRead ?? 0) + (cacheWrite ?? 0);

      // retryAttempt is 0 on first execution, N after the Nth retry. Total
      // attempts = retryAttempt + 1 so operators can distinguish "landed on
      // first try" (1) from "succeeded after a silent-LLM-failure retry" (2).
      // This makes retries visible in _run-metadata.json instead of hiding in
      // daemon.log.
      const attemptsUsed = (nState.retryAttempt ?? 0) + 1;
      if (attemptsUsed > 1) nodesRetried++;

      nodesMap[nodeId] = {
        status: nState.status,
        durationMs,
        subAgentRunId: nState.runId ?? null,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        cacheEffectiveness: cacheable > 0 ? (cacheRead ?? 0) / cacheable : null,
        attemptsUsed,
      };
    }

    // Compute degradedNodes -- completed nodes with failed/skipped upstream deps
    const degradedNodes: Record<string, {
      missingUpstream: string[];
      availableUpstream: string[];
    }> = {};

    for (const node of gs.graph.graph.nodes) {
      const nState = snap.nodes.get(node.nodeId);
      if (!nState || nState.status !== "completed") continue;
      if (node.dependsOn.length === 0) continue;

      const missing: string[] = [];
      const available: string[] = [];
      for (const depId of node.dependsOn) {
        const depState = snap.nodes.get(depId);
        if (depState?.status === "completed") {
          available.push(depId);
        } else {
          missing.push(depId);
        }
      }

      if (missing.length > 0) {
        degradedNodes[node.nodeId] = { missingUpstream: missing, availableUpstream: available };
      }
    }

    const metadata = {
      graphId: gs.graphId,
      graphName: gs.graph.graph.label ?? gs.graphId,
      startedAt: systemDateFrom(gs.startedAt).toISOString(),
      completedAt: systemDateFrom(gs.completedAt ?? systemNowMs()).toISOString(),
      durationMs: (gs.completedAt ?? systemNowMs()) - gs.startedAt,
      status: gs.stateMachine.getGraphStatus(),
      traceId: gs.graphTraceId,
      nodesTotal: gs.graph.graph.nodes.length,
      nodesSucceeded,
      nodesFailed,
      nodesSkipped,
      nodesRetried,
      totalCostUsd: gs.cumulativeCost > 0 ? gs.cumulativeCost : undefined,
      totalTokens: gs.cumulativeTokens > 0 ? gs.cumulativeTokens : undefined,
      cancelReason: gs.cancelReason,
      ...(Object.keys(degradedNodes).length > 0 && { degradedNodes }),
      nodes: nodesMap,
    };

    // Persist via fs-safe substrate; DEBUG on Result.err
    // preserves existing "non-critical" semantics.
    const writeResult = writeRegularFile({ path: safePath(gs.sharedDir, "_run-metadata.json"), content: JSON.stringify(metadata, null, 2), confinedBaseDir: gs.sharedDir });
    if (!writeResult.ok) {
      deps.logger?.debug(
        { graphId: gs.graphId, err: toSafeErrorLogString(writeResult.error), hint: "Run metadata write failed; downstream artifact consumers will see no _run-metadata.json", errorKind: "resource" as const },
        "Failed to write _run-metadata.json (non-critical)",
      );
    }
  } catch (writeErr) {
    deps.logger?.debug(
      { graphId: gs.graphId, err: toSafeErrorLogString(writeErr) },
      "Failed to write _run-metadata.json (non-critical)",
    );
  }
}
