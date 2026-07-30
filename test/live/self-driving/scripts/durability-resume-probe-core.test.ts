// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  classifyInterruptEvidence,
  selectUnseenGraphId,
  verifyResumeOutcome,
} from "./durability-resume-probe-core.mjs";

const GRAPH_ID = "11111111-1111-4111-8111-111111111111";

function runningSnapshot() {
  return {
    graphId: GRAPH_ID,
    status: "running",
    isTerminal: false,
    nodes: {
      anchor: {
        status: "completed",
        runId: "run-anchor",
        output: "ANCHOR_MARKER",
      },
      approval: {
        status: "running",
        runId: "run-approval-before-restart",
      },
      finish: {
        status: "pending",
      },
    },
  };
}

function persistedCheckpoint() {
  return {
    graph: {
      nodes: [
        { nodeId: "anchor", task: "Return the anchor." },
        {
          nodeId: "approval",
          task: "Wait for the user.",
          dependsOn: ["anchor"],
          typeId: "approval-gate",
          typeConfig: { message: "ready?" },
        },
        {
          nodeId: "finish",
          task: "Return the marker.",
          dependsOn: ["anchor", "approval"],
        },
      ],
    },
    nodes: [
      {
        nodeId: "anchor",
        status: "completed",
        runId: "run-anchor",
        output: "ANCHOR_MARKER",
        retryAttempt: 0,
      },
      {
        nodeId: "approval",
        status: "running",
        runId: "run-approval-before-restart",
        retryAttempt: 0,
      },
      { nodeId: "finish", status: "pending", retryAttempt: 0 },
    ],
  };
}

describe("durable graph probe candidate selection", () => {
  it("selects the newest unseen canonical execution graph directory", () => {
    expect(selectUnseenGraphId(
      new Set(["22222222-2222-4222-8222-222222222222"]),
      [
        {
          graphId: "not-a-graph",
          mtimeMs: 50,
        },
        {
          graphId: "33333333-3333-4333-8333-333333333333",
          mtimeMs: 30,
        },
        {
          graphId: GRAPH_ID,
          mtimeMs: 40,
        },
        {
          graphId: "22222222-2222-4222-8222-222222222222",
          mtimeMs: 60,
        },
      ],
    )).toBe(GRAPH_ID);
  });
});

describe("durable graph probe interrupt evidence", () => {
  it("requires matching live and persisted approval-gate frontier evidence", () => {
    expect(classifyInterruptEvidence(
      GRAPH_ID,
      runningSnapshot(),
      persistedCheckpoint(),
    )).toEqual({
      ok: true,
      graphId: GRAPH_ID,
      completed: [{
        nodeId: "anchor",
        runId: "run-anchor",
        output: "ANCHOR_MARKER",
        retryAttempt: 0,
      }],
      runningNodeIds: ["approval"],
    });
  });

  it("refuses a restart when the persisted checkpoint disagrees with live state", () => {
    const checkpoint = persistedCheckpoint();
    checkpoint.nodes[1]!.status = "ready";

    expect(classifyInterruptEvidence(
      GRAPH_ID,
      runningSnapshot(),
      checkpoint,
    )).toEqual({
      ok: false,
      reason: "live and persisted running-node frontiers differ",
    });
  });

  it("refuses a merely slow regular node because the interrupt window is not guaranteed", () => {
    const checkpoint = persistedCheckpoint();
    checkpoint.graph.nodes[1] = {
      nodeId: "approval",
      task: "Maybe take a while.",
      dependsOn: ["anchor"],
    };

    expect(classifyInterruptEvidence(
      GRAPH_ID,
      runningSnapshot(),
      checkpoint,
    )).toEqual({
      ok: false,
      reason: "the running frontier is not an approval-gate",
    });
  });
});

describe("durable graph probe terminal verification", () => {
  it("proves the same graph resumed without re-running its completed anchor", () => {
    const evidence = classifyInterruptEvidence(
      GRAPH_ID,
      runningSnapshot(),
      persistedCheckpoint(),
    );
    if (!evidence.ok) throw new Error(evidence.reason);

    expect(verifyResumeOutcome({
      graphId: GRAPH_ID,
      marker: "DURABLE_RESUME_MARKER",
      beforeRestart: evidence,
      metadata: {
        graphId: GRAPH_ID,
        status: "completed",
        nodesTotal: 3,
        nodesSucceeded: 3,
        nodesFailed: 0,
        nodesSkipped: 0,
        nodes: {
          anchor: {
            status: "completed",
            subAgentRunId: "run-anchor",
            attemptsUsed: 1,
          },
          approval: {
            status: "completed",
            subAgentRunId: "run-approval-after-restart",
            attemptsUsed: 1,
          },
          finish: {
            status: "completed",
            subAgentRunId: "run-finish",
            attemptsUsed: 1,
          },
        },
      },
      runDetail: {
        graphId: GRAPH_ID,
        status: "completed",
        nodes: [
          { nodeId: "anchor", output: "ANCHOR_MARKER" },
          { nodeId: "approval", output: "Approved. User response: yes" },
          { nodeId: "finish", output: "DURABLE_RESUME_MARKER" },
        ],
      },
      incident: {
        graph: {
          graphId: GRAPH_ID,
          status: "completed",
          nodesTotal: 3,
          nodesSucceeded: 3,
          nodesFailed: 0,
          nodesSkipped: 0,
          nodes: [
            {
              nodeId: "anchor",
              status: "completed",
              subAgentRunId: "run-anchor",
              attemptsUsed: 1,
            },
            {
              nodeId: "approval",
              status: "completed",
              subAgentRunId: "run-approval-after-restart",
              attemptsUsed: 1,
            },
            {
              nodeId: "finish",
              status: "completed",
              subAgentRunId: "run-finish",
              attemptsUsed: 1,
            },
          ],
        },
      },
    })).toEqual({
      ok: true,
      graphId: GRAPH_ID,
      preservedCompletedNodeIds: ["anchor"],
      markerNodeId: "finish",
    });
  });

  it("rejects terminal evidence when the completed anchor was executed again", () => {
    const evidence = classifyInterruptEvidence(
      GRAPH_ID,
      runningSnapshot(),
      persistedCheckpoint(),
    );
    if (!evidence.ok) throw new Error(evidence.reason);

    expect(verifyResumeOutcome({
      graphId: GRAPH_ID,
      marker: "DURABLE_RESUME_MARKER",
      beforeRestart: evidence,
      metadata: {
        graphId: GRAPH_ID,
        status: "completed",
        nodesTotal: 3,
        nodesSucceeded: 3,
        nodesFailed: 0,
        nodesSkipped: 0,
        nodes: {
          anchor: {
            status: "completed",
            subAgentRunId: "run-anchor-reexecuted",
            attemptsUsed: 2,
          },
        },
      },
      runDetail: {
        graphId: GRAPH_ID,
        status: "completed",
        nodes: [
          { nodeId: "finish", output: "DURABLE_RESUME_MARKER" },
        ],
      },
      incident: {
        graph: {
          graphId: GRAPH_ID,
          status: "completed",
          nodesTotal: 3,
          nodesSucceeded: 3,
          nodesFailed: 0,
          nodesSkipped: 0,
          nodes: [],
        },
      },
    })).toEqual({
      ok: false,
      reason: "completed node anchor changed run identity across restart",
    });
  });
});
