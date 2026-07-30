// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphCoordinator } from "../../graph/graph-coordinator.js";
import { bindGraphQueryHandlers } from "./graph-query.js";
import type { GraphHandlerDeps } from "./graph-helpers.js";

const tempDirs: string[] = [];

function makeInterruptedRun(): {
  dataDir: string;
  graphId: string;
  deps: GraphHandlerDeps;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "comis-graph-query-"));
  tempDirs.push(dataDir);
  const graphId = "graph-interrupted";
  const graphDir = join(dataDir, "graph-runs", graphId);
  mkdirSync(graphDir, { recursive: true, mode: 0o700 });
  const endpoint = {
    channelType: "telegram",
    channelInstanceId: "telegram-main",
    conversationId: "chat-a",
    conversationKind: "direct" as const,
  };
  const checkpoint = {
    turnScope: {
      conversation: {
        tenantId: "tenant-a",
        agentId: "agent-a",
        partition: {
          kind: "channel-principal" as const,
          channelType: "telegram",
          principalId: "user-a",
        },
      },
      principal: { principalId: "user-a" },
      endpoint,
    },
    graph: {
      nodes: [
        { nodeId: "flights", task: "check flights", dependsOn: [] },
        { nodeId: "weather", task: "check weather", dependsOn: [] },
        { nodeId: "museum", task: "check museum", dependsOn: [] },
        { nodeId: "decision", task: "decide", dependsOn: ["flights", "weather", "museum"] },
      ],
    },
    executionOrder: ["flights", "weather", "museum", "decision"],
    nodes: [
      { nodeId: "flights", status: "running" as const, runId: "run-flights" },
      { nodeId: "weather", status: "completed" as const, output: "weather output" },
      { nodeId: "museum", status: "completed" as const, output: "museum output" },
      { nodeId: "decision", status: "pending" as const },
    ],
    startedAtMs: 1_000,
    cumulativeTokens: 100,
    cumulativeCost: 0.1,
    nodeCacheData: [],
    nodeTokenSpend: [],
    nodeCost: [],
    skippedNodesEmitted: [],
  };
  const content = JSON.stringify(checkpoint);
  const digest = createHash("sha256").update(content).digest("hex");
  writeFileSync(join(graphDir, `durable-checkpoint-${digest}.json`), content, { mode: 0o600 });
  writeFileSync(join(graphDir, "weather-output.md"), "weather output", { mode: 0o600 });
  writeFileSync(join(graphDir, "museum-output.md"), "museum output", { mode: 0o600 });

  const graphCoordinator = {
    getStatus: () => undefined,
  } as unknown as GraphCoordinator;
  const deps = {
    dataDir,
    graphCoordinator,
  } as unknown as GraphHandlerDeps;
  return { dataDir, graphId, deps };
}

function makeHardStoppedRun(): {
  dataDir: string;
  graphId: string;
  deps: GraphHandlerDeps;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "comis-graph-query-"));
  tempDirs.push(dataDir);
  const graphId = "graph-hard-stopped";
  const graphDir = join(dataDir, "graph-runs", graphId);
  mkdirSync(graphDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(graphDir, "_run-metadata.json"), JSON.stringify({
    graphId,
    status: "failed",
    cancelReason: "manual",
    nodes: {
      first: { status: "skipped" },
      second: { status: "skipped" },
    },
  }), { mode: 0o600 });
  writeFileSync(join(graphDir, "first-output.md"), "Killed by parent agent", { mode: 0o600 });

  const graphCoordinator = {
    getStatus: () => undefined,
  } as unknown as GraphCoordinator;
  const deps = {
    dataDir,
    graphCoordinator,
  } as unknown as GraphHandlerDeps;
  return { dataDir, graphId, deps };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("graph run history checkpoint truthfulness", () => {
  it("reports a nonterminal checkpoint as interrupted instead of completed", async () => {
    const { deps, graphId } = makeInterruptedRun();
    const result = await bindGraphQueryHandlers(deps)["graph.runs"]!({});

    expect(result).toEqual({
      runs: [
        expect.objectContaining({
          graphId,
          status: "interrupted",
          nodeCount: 4,
        }),
      ],
    });
  });

  it("lists every checkpoint node even when only some outputs reached disk", async () => {
    const { deps, graphId } = makeInterruptedRun();
    const result = await bindGraphQueryHandlers(deps)["graph.runDetail"]!({ graphId });

    expect(result).toEqual(expect.objectContaining({
      graphId,
      status: "interrupted",
      nodes: [
        expect.objectContaining({ nodeId: "flights", output: null }),
        expect.objectContaining({ nodeId: "weather", output: "weather output" }),
        expect.objectContaining({ nodeId: "museum", output: "museum output" }),
        expect.objectContaining({ nodeId: "decision", output: null }),
      ],
    }));
  });

  it("preserves a failed hard-stop status after the coordinator restarts", async () => {
    const { deps, graphId } = makeHardStoppedRun();
    const handlers = bindGraphQueryHandlers(deps);

    const runs = await handlers["graph.runs"]!({});
    const detail = await handlers["graph.runDetail"]!({ graphId });

    expect(runs).toEqual({
      runs: [
        expect.objectContaining({
          graphId,
          status: "failed",
          nodeCount: 2,
        }),
      ],
    });
    expect(detail).toEqual(expect.objectContaining({
      graphId,
      status: "failed",
      nodes: [
        expect.objectContaining({ nodeId: "first", output: "Killed by parent agent" }),
        expect.objectContaining({ nodeId: "second", output: null }),
      ],
    }));
  });
});
