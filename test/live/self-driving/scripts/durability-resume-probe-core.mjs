// SPDX-License-Identifier: Apache-2.0
/**
 * Pure evidence rules for the live durable execution-graph restart probe.
 *
 * The driver deliberately keeps I/O in `durability-resume-probe.mjs`. These
 * functions define the proof bar so the live script cannot declare success
 * from a chat reply, a fixed delay, or one transient signal.
 */

const GRAPH_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameStrings(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * The live inject remains a natural user request. It describes the desired
 * relationship between three steps without naming any runtime mechanism.
 */
export function buildProbeMessage(anchor, marker) {
  return [
    "hey can u set up one connected three step job all at once before any step starts",
    `first have one helper reply exactly ${anchor}`,
    "second after the first is done pause and ask me if im ready and actually wait for yes",
    `third only after both earlier steps have finished have another helper check the first answer and reply exactly ${marker}`,
    "start the connected job now",
    "this might restart while its paused so dont lose the finished first step",
  ].join(" ");
}

function callbackButtons(event) {
  const raw = event?.replyMarkup ?? event?.raw?.reply_markup;
  if (raw === null || raw === undefined) return [];
  let markup = raw;
  if (typeof raw === "string") {
    try {
      markup = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(markup?.inline_keyboard)
    ? markup.inline_keyboard.flat()
    : [];
}

/**
 * Select the signed approval control emitted for this probe's pipeline call.
 * The baseline watermark excludes stale controls from earlier turns. Requiring
 * the exact operation label prevents an unrelated pending approval from being
 * accepted by the durability harness.
 */
export function selectPipelineApproval(events, afterMessageId) {
  const candidates = events
    .filter((event) =>
      Number(event?.messageId) > afterMessageId
      && typeof event?.text === "string"
      && event.text.trim().toLowerCase()
        === "approval required: pipeline graph.execute\n(running 0 s)"
    )
    .map((event) => {
      const approvals = callbackButtons(event).filter((button) =>
        typeof button?.callback_data === "string"
        && button.callback_data.startsWith("v1.approve.")
      );
      return approvals.length === 1
        ? {
            botMessageId: Number(event.messageId),
            callbackData: approvals[0].callback_data,
          }
        : undefined;
    })
    .filter((candidate) => candidate !== undefined);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Pick the newest canonical graph directory that did not exist before the
 * Telegram turn. A model may finish unrelated background work while the probe
 * starts, so invalid names and pre-existing graph IDs are excluded first.
 */
export function selectUnseenGraphId(beforeIds, entries) {
  return entries
    .filter(({ graphId }) =>
      GRAPH_ID_PATTERN.test(graphId) && !beforeIds.has(graphId)
    )
    .sort((left, right) =>
      right.mtimeMs - left.mtimeMs || left.graphId.localeCompare(right.graphId)
    )[0]?.graphId;
}

/**
 * Require two matching views of a guaranteed interrupt window:
 *
 * 1. the coordinator's live `graph.status` snapshot;
 * 2. the content-addressed checkpoint already written to disk.
 *
 * A running regular agent node is not accepted because model/tool latency is
 * not a reliable window. The running frontier must be an approval-gate, which
 * stays blocked until the probe sends the approval after restart.
 */
export function classifyInterruptEvidence(graphId, liveSnapshot, checkpoint) {
  if (
    liveSnapshot === null
    || typeof liveSnapshot !== "object"
    || liveSnapshot.graphId !== graphId
    || liveSnapshot.status !== "running"
    || liveSnapshot.isTerminal !== false
  ) {
    return {
      ok: false,
      reason: "live graph status is not the requested non-terminal graph",
    };
  }
  if (
    checkpoint === null
    || typeof checkpoint !== "object"
    || !Array.isArray(checkpoint.nodes)
    || checkpoint.graph === null
    || typeof checkpoint.graph !== "object"
    || !Array.isArray(checkpoint.graph.nodes)
  ) {
    return {
      ok: false,
      reason: "persisted graph checkpoint is missing or malformed",
    };
  }

  const liveEntries = Object.entries(liveSnapshot.nodes ?? {});
  const liveRunning = sortedUnique(
    liveEntries
      .filter(([, state]) => state?.status === "running")
      .map(([nodeId]) => nodeId),
  );
  const persistedRunning = sortedUnique(
    checkpoint.nodes
      .filter((state) => state?.status === "running")
      .map((state) => state.nodeId),
  );
  if (
    liveRunning.length === 0
    || !sameStrings(liveRunning, persistedRunning)
  ) {
    return {
      ok: false,
      reason: "live and persisted running-node frontiers differ",
    };
  }

  const topologyByNode = new Map(
    checkpoint.graph.nodes.map((node) => [node.nodeId, node]),
  );
  if (
    liveRunning.some((nodeId) =>
      topologyByNode.get(nodeId)?.typeId !== "approval-gate"
    )
  ) {
    return {
      ok: false,
      reason: "the running frontier is not an approval-gate",
    };
  }

  const checkpointByNode = new Map(
    checkpoint.nodes.map((state) => [state.nodeId, state]),
  );
  const completed = liveEntries
    .filter(([, state]) => state?.status === "completed")
    .map(([nodeId, liveState]) => {
      const persisted = checkpointByNode.get(nodeId);
      if (
        persisted?.status !== "completed"
        || persisted.runId !== liveState.runId
        || persisted.output !== liveState.output
      ) {
        return null;
      }
      return {
        nodeId,
        runId: persisted.runId,
        output: persisted.output,
        retryAttempt: persisted.retryAttempt ?? 0,
      };
    });
  if (completed.length === 0) {
    return {
      ok: false,
      reason: "no completed node exists before the restart",
    };
  }
  if (completed.some((entry) => entry === null)) {
    return {
      ok: false,
      reason: "live and persisted completed-node evidence differs",
    };
  }

  return {
    ok: true,
    graphId,
    completed,
    runningNodeIds: liveRunning,
  };
}

function terminalGraphShapeIsComplete(graph) {
  return graph?.status === "completed"
    && graph.nodesTotal > 0
    && graph.nodesSucceeded === graph.nodesTotal
    && graph.nodesFailed === 0
    && graph.nodesSkipped === 0;
}

/**
 * Reconcile all terminal lenses after restart. Success requires:
 *
 * - the exact same graph ID in metadata, run detail, and IncidentReport;
 * - every node succeeded;
 * - the final marker is a real persisted node output;
 * - every node completed before restart kept the same child run identity and
 *   attempt count in both metadata and `explain`.
 */
export function verifyResumeOutcome({
  graphId,
  marker,
  beforeRestart,
  metadata,
  runDetail,
  incident,
}) {
  if (
    metadata?.graphId !== graphId
    || runDetail?.graphId !== graphId
    || incident?.graph?.graphId !== graphId
  ) {
    return {
      ok: false,
      reason: "terminal evidence does not identify the interrupted graph",
    };
  }
  if (
    !terminalGraphShapeIsComplete(metadata)
    || runDetail.status !== "completed"
    || !terminalGraphShapeIsComplete(incident.graph)
  ) {
    return {
      ok: false,
      reason: "terminal graph evidence is not an all-succeeded completion",
    };
  }

  const detailByNode = new Map(
    (runDetail.nodes ?? []).map((node) => [node.nodeId, node]),
  );
  const incidentByNode = new Map(
    (incident.graph.nodes ?? []).map((node) => [node.nodeId, node]),
  );
  for (const completed of beforeRestart.completed) {
    const metadataNode = metadata.nodes?.[completed.nodeId];
    const incidentNode = incidentByNode.get(completed.nodeId);
    if (
      metadataNode?.subAgentRunId !== completed.runId
      || incidentNode?.subAgentRunId !== completed.runId
    ) {
      return {
        ok: false,
        reason:
          `completed node ${completed.nodeId} changed run identity across restart`,
      };
    }
    const expectedAttempts = completed.retryAttempt + 1;
    if (
      metadataNode.attemptsUsed !== expectedAttempts
      || incidentNode.attemptsUsed !== expectedAttempts
    ) {
      return {
        ok: false,
        reason:
          `completed node ${completed.nodeId} changed attempt count across restart`,
      };
    }
    if (
      metadataNode.status !== "completed"
      || incidentNode.status !== "completed"
      || detailByNode.get(completed.nodeId)?.output !== completed.output
    ) {
      return {
        ok: false,
        reason:
          `completed node ${completed.nodeId} changed terminal evidence across restart`,
      };
    }
  }

  const markerNode = (runDetail.nodes ?? []).find(
    (node) => typeof node.output === "string" && node.output.trim() === marker,
  );
  if (markerNode === undefined) {
    return {
      ok: false,
      reason: "the post-restart marker is not a persisted node output",
    };
  }

  return {
    ok: true,
    graphId,
    preservedCompletedNodeIds: beforeRestart.completed.map(
      ({ nodeId }) => nodeId,
    ),
    markerNodeId: markerNode.nodeId,
  };
}
