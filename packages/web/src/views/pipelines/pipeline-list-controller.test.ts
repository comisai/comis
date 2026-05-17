// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";
import { createPipelineListController } from "./pipeline-list-controller.js";

function makeHost(): ReactiveControllerHost & { _updates: number } {
  return {
    _updates: 0,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate(): void {
      (this as { _updates: number })._updates += 1;
    },
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost & { _updates: number };
}

describe("PipelineListController", () => {
  it("listGraphs: forwards limit to graph.list", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        entries: [
          { id: "g1", label: "Pipeline 1", nodeCount: 3, updatedAt: 1000 },
        ],
        total: 1,
      };
    });
    const controller = createPipelineListController(host, rpc);
    const result = await controller.listGraphs(100);
    expect((seen[0] as unknown[])[0]).toBe("graph.list");
    expect((seen[0] as unknown[])[1]).toEqual({ limit: 100 });
    expect(result.total).toBe(1);
    expect(result.entries?.[0]?.id).toBe("g1");
  });

  it("getGraphStatus: invokes graph.status with empty object", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        graphs: [
          { graphId: "g1", status: "running", startedAt: 1000 },
        ],
      };
    });
    const controller = createPipelineListController(host, rpc);
    const result = await controller.getGraphStatus();
    expect((seen[0] as unknown[])[0]).toBe("graph.status");
    expect((seen[0] as unknown[])[1]).toEqual({});
    expect(result.graphs?.[0]?.status).toBe("running");
  });

  it("calls loadGraph, executeGraph, and getAllChannels in sequence for the quick-execute approval-gate flow", async () => {
    const host = makeHost();
    const seen: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      seen.push(method);
      if (method === "graph.load") {
        return {
          nodes: [{ nodeId: "n1", task: "Hello", dependsOn: [] }],
          settings: { label: "Test", onFailure: "abort" },
        };
      }
      if (method === "obs.channels.all") {
        return {
          channels: [{ channelId: "c1", channelType: "telegram" }],
        };
      }
      if (method === "graph.execute") {
        return { graphId: "exec-1" };
      }
      return undefined;
    });
    const controller = createPipelineListController(host, rpc);
    const loaded = await controller.loadGraph("g1");
    expect(loaded.nodes[0]!.task).toBe("Hello");
    const channels = (await controller.getAllChannels()) as {
      channels: Array<{ channelId: string; channelType: string }>;
    };
    expect(channels.channels[0]!.channelType).toBe("telegram");
    const result = await controller.executeGraph({
      nodes: [],
      label: "Test",
      onFailure: "abort",
    });
    expect(result.graphId).toBe("exec-1");
    expect(seen).toEqual(["graph.load", "obs.channels.all", "graph.execute"]);
  });

  it("saveGraph: forwards full payload to graph.save (duplicate flow)", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createPipelineListController(host, rpc);
    await controller.saveGraph({
      id: "new-id",
      label: "New Pipeline",
      // Loose-types-but-acceptable shapes; the controller is opaque
      nodes: [],
      edges: [],
      settings: { label: "New Pipeline", onFailure: "abort" } as unknown as never,
    });
    expect((seen[0] as unknown[])[0]).toBe("graph.save");
    expect((seen[0] as unknown[])[1]).toMatchObject({
      id: "new-id",
      label: "New Pipeline",
    });
  });

  it("deleteGraph: invokes graph.delete with id param", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createPipelineListController(host, rpc);
    await controller.deleteGraph("g1");
    expect((seen[0] as unknown[])[0]).toBe("graph.delete");
    expect((seen[0] as unknown[])[1]).toEqual({ id: "g1" });
  });

  it("listGraphs + getGraphStatus: parallel fan-out for list bootstrap", async () => {
    const host = makeHost();
    const seen: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args[0] as string);
      const method = args[0] as string;
      // Different latencies to exercise parallel fan-out
      const isStatus = method === "graph.status";
      await new Promise((r) => setTimeout(r, isStatus ? 5 : 1));
      return method === "graph.list" ? { entries: [], total: 0 } : { graphs: [] };
    });
    const controller = createPipelineListController(host, rpc);
    await Promise.allSettled([
      controller.listGraphs(100),
      controller.getGraphStatus(),
    ]);
    expect(seen).toEqual(
      expect.arrayContaining(["graph.list", "graph.status"]),
    );
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon unreachable");
    });
    const controller = createPipelineListController(host, rpc);
    await expect(controller.listGraphs(10)).rejects.toThrow("daemon unreachable");
    await expect(controller.getGraphStatus()).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.loadGraph("g1")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.deleteGraph("g1")).rejects.toThrow(
      "daemon unreachable",
    );
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createPipelineListController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createPipelineListController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
