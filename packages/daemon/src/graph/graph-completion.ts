// SPDX-License-Identifier: Apache-2.0
/**
 * Graph completion, announcement, budget, and timeout handling.
 * Manages the final processing when a graph reaches terminal state:
 * timer cleanup, event emission, metadata persistence, announcement
 * delivery (with batcher/parent/direct channel fallbacks), budget
 * exceeded handling, and graph-level timeout cancellation.
 * @module
 */

import type { SessionKey } from "@comis/core";
import { withTimeout } from "@comis/shared";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANNOUNCE_PARENT_TIMEOUT_MS } from "../sub-agent-runner.js";
import { clearAllTimers } from "./graph-cleanup.js";
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
// Graph completion
// ---------------------------------------------------------------------------

/**
 * Handle graph completion: mark time, clear timers, emit events,
 * write metadata, build and deliver announcement.
 */
export function handleGraphCompletion(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "eventBus" | "logger" | "sendToChannel" | "announceToParent" | "batcher" | "tenantId" | "activeRunRegistry" | "touchParentSession">,
  gs: GraphRunState,
): void {
  // Prevent double-completion
  if (gs.completedAt !== undefined) return;

  // Touch parent lane one final time before announcement delivery
  if (gs.callerSessionKey) {
    deps.touchParentSession?.(gs.callerSessionKey);
  }

  // 1. Mark completion time
  gs.completedAt = Date.now();

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
  // 3.3: Compute cache rollup once -- shared by event emission and completion log
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

  deps.eventBus.emit("graph:completed", {
    graphId: gs.graphId,
    status: gs.stateMachine.getGraphStatus(),
    durationMs: gs.completedAt! - gs.startedAt,
    nodeCount: gs.graph.graph.nodes.length,
    nodesCompleted,
    nodesFailed,
    nodesSkipped,
    ...(gs.cancelReason !== undefined && { cancelReason: gs.cancelReason }),
    timestamp: Date.now(),
    // 3.3: Graph-level cache aggregation
    ...cacheRollupFields,
  });

  // 2c. Write _run-metadata.json to disk
  writeRunMetadata(deps, gs);

  // 3. Build announcement text (structured: text + optional buttons for long outputs)
  const { text: announcement, buttons: announcementButtons } = buildGraphAnnouncement(gs);
  const buttonOpts = announcementButtons ? { extra: { buttons: announcementButtons } } : undefined;

  // 4. Deliver announcement (fire-and-forget, errors logged)
  if (gs.announceChannelType && gs.announceChannelId) {
    if (gs.callerAgentId && gs.callerSessionKey) {
      // Check if parent session is still active before expensive announceToParent.
      // When parent is gone, skip batcher and announceToParent (avoids 5-min timeout),
      // go directly to sendToChannel.
      const parentActive = deps.activeRunRegistry?.has(gs.callerSessionKey) ?? true;
      if (!parentActive) {
        deps.logger?.info(
          { graphId: gs.graphId, callerSessionKey: gs.callerSessionKey },
          "Graph announcement: parent session unavailable, using direct channel send",
        );
        deps.sendToChannel(gs.announceChannelType, gs.announceChannelId, announcement, buttonOpts).catch((sendErr: unknown) => {
          deps.logger?.warn(
            { graphId: gs.graphId, err: sendErr, hint: "Failed to announce graph result to channel after parent-gone detection", errorKind: "network" },
            "Graph announcement delivery failed",
          );
        });
      } else {
        // Parent is active -- use existing 3-tier flow: batcher -> announceToParent -> sendToChannel
        // When buttons are present, bypass batcher (batcher only supports plain text)
        if (deps.batcher && !announcementButtons) {
          deps.batcher.enqueue({
            announcementText: announcement,
            announceChannelType: gs.announceChannelType,
            announceChannelId: gs.announceChannelId,
            callerAgentId: gs.callerAgentId,
            callerSessionKey: gs.callerSessionKey,
            runId: gs.graphId,
          });
        } else if (deps.announceToParent) {
          const sessionKey: SessionKey = {
            tenantId: deps.tenantId,
            userId: gs.callerAgentId,
            channelId: gs.callerSessionKey,
          };
          withTimeout(
            deps.announceToParent(
              gs.callerAgentId,
              sessionKey,
              announcement,
              gs.announceChannelType,
              gs.announceChannelId,
            ),
            ANNOUNCE_PARENT_TIMEOUT_MS,
            "graph announceToParent",
          ).catch((announceErr: unknown) => {
            deps.logger?.warn(
              { graphId: gs.graphId, err: announceErr, hint: "Parent announcement failed; falling back to direct channel send", errorKind: "internal" },
              "Graph parent announcement failed",
            );
            deps.sendToChannel(gs.announceChannelType!, gs.announceChannelId!, announcement, buttonOpts).catch((sendErr: unknown) => {
              deps.logger?.warn(
                { graphId: gs.graphId, err: sendErr, hint: "Failed to announce graph result to channel", errorKind: "network" },
                "Graph announcement delivery failed",
              );
            });
          });
        } else {
          deps.sendToChannel(gs.announceChannelType, gs.announceChannelId, announcement, buttonOpts).catch((sendErr: unknown) => {
            deps.logger?.warn(
              { graphId: gs.graphId, err: sendErr, hint: "Failed to announce graph result to channel", errorKind: "network" },
              "Graph announcement delivery failed",
            );
          });
        }
      }
    } else {
      deps.sendToChannel(gs.announceChannelType, gs.announceChannelId, announcement, buttonOpts).catch((sendErr: unknown) => {
        deps.logger?.warn(
          { graphId: gs.graphId, err: sendErr, hint: "Failed to announce graph result to channel", errorKind: "network" },
          "Graph announcement delivery failed",
        );
      });
    }
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
      // 3.3: Graph-level cache aggregation (computed above for event + log)
      ...cacheRollupFields,
    },
    "Graph execution complete",
  );
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
export function buildGraphAnnouncement(gs: GraphRunState): GraphAnnouncement {
  const maxAnnouncementChars = gs.maxAnnouncementChars ?? 3000;
  const snap = gs.stateMachine.snapshot();
  const label = gs.graph.graph.label ?? gs.graphId;
  const durationMs = (gs.completedAt ?? Date.now()) - gs.startedAt;

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

    const truncatedParts: string[] = [
      ...truncatedLeafOutputs,
      "",
      `\uD83D\uDCC4 Full report available (${totalLeafChars.toLocaleString()} chars) \u2014 tap below to receive as document.`,
      ...footerParts,
    ];

    return {
      text: truncatedParts.join("\n"),
      buttons: [[{ text: "\uD83D\uDCC4 Full Report", callback_data: `graph:report:${gs.graphId}` }]],
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
  deps: Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "sendToChannel" | "announceToParent" | "batcher" | "tenantId" | "activeRunRegistry" | "touchParentSession">,
  gs: GraphRunState,
  reason: string,
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

  handleGraphCompletion(state, deps, gs);

  deps.logger?.warn(
    { graphId: gs.graphId, cumulativeTokens: gs.cumulativeTokens, cumulativeCost: gs.cumulativeCost, hint: "Graph budget is configurable via graph.budget.maxTokens/maxCost", errorKind: "budget" },
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
  deps: Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "sendToChannel" | "announceToParent" | "batcher" | "tenantId" | "activeRunRegistry" | "touchParentSession">,
  gs: GraphRunState,
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

  handleGraphCompletion(state, deps, gs);

  deps.logger?.warn(
    { graphId: gs.graphId, timeoutMs: gs.graph.graph.timeoutMs, hint: "Graph timeout is configurable via graph.timeoutMs", errorKind: "timeout" },
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
      startedAt: new Date(gs.startedAt).toISOString(),
      completedAt: new Date(gs.completedAt ?? Date.now()).toISOString(),
      durationMs: (gs.completedAt ?? Date.now()) - gs.startedAt,
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

    writeFileSync(
      join(gs.sharedDir, "_run-metadata.json"),
      JSON.stringify(metadata, null, 2),
      "utf8",
    );
  } catch (writeErr) {
    deps.logger?.debug(
      { graphId: gs.graphId, err: writeErr },
      "Failed to write _run-metadata.json (non-critical)",
    );
  }
}
