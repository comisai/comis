// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";
import { createPipelineMonitorController } from "./pipeline-monitor-controller.js";

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

describe("PipelineMonitorController", () => {
  it("loadGraph: forwards graph id to graph.load + returns raw payload (server execution format)", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        nodes: [
          { nodeId: "n1", agent: "default", task: "step", dependsOn: [] },
          { nodeId: "n2", agent: "default", task: "step", dependsOn: ["n1"] },
        ],
        edges: [],
        settings: { onFailure: "fail-fast" },
      };
    });
    const controller = createPipelineMonitorController(host, rpc);
    const result = await controller.loadGraph("graph-alpha");
    expect((seen[0] as unknown[])[0]).toBe("graph.load");
    expect((seen[0] as unknown[])[1]).toEqual({ id: "graph-alpha" });
    expect(result.nodes.length).toBe(2);
  });

  it("getGraphStatus: forwards graphId to graph.status + returns executionOrder", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { executionOrder: ["alpha", "beta", "gamma"] };
    });
    const controller = createPipelineMonitorController(host, rpc);
    const result = await controller.getGraphStatus("graph-alpha");
    expect((seen[0] as unknown[])[0]).toBe("graph.status");
    expect((seen[0] as unknown[])[1]).toEqual({ graphId: "graph-alpha" });
    expect(result.executionOrder).toEqual(["alpha", "beta", "gamma"]);
  });

  it("cancelGraph: invokes graph.cancel with graphId", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createPipelineMonitorController(host, rpc);
    await controller.cancelGraph("graph-alpha");
    expect((seen[0] as unknown[])[0]).toBe("graph.cancel");
    expect((seen[0] as unknown[])[1]).toEqual({ graphId: "graph-alpha" });
  });

  it("steerSubagent: forwards target + message to subagent.steer", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createPipelineMonitorController(host, rpc);
    await controller.steerSubagent({
      target: "run-42",
      message: "Please use a smaller batch",
    });
    expect((seen[0] as unknown[])[0]).toBe("subagent.steer");
    expect((seen[0] as unknown[])[1]).toEqual({
      target: "run-42",
      message: "Please use a smaller batch",
    });
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("graph offline");
    });
    const controller = createPipelineMonitorController(host, rpc);
    await expect(controller.loadGraph("g")).rejects.toThrow("graph offline");
    await expect(controller.getGraphStatus("g")).rejects.toThrow(
      "graph offline",
    );
    await expect(controller.cancelGraph("g")).rejects.toThrow("graph offline");
    await expect(
      controller.steerSubagent({ target: "t", message: "m" }),
    ).rejects.toThrow("graph offline");
  });

  it("loadGraph fallback: when graph.load rejects, caller can still call getGraphStatus", async () => {
    const host = makeHost();
    let call = 0;
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      call += 1;
      const topic = args[0] as string;
      if (topic === "graph.load") {
        throw new Error("not found");
      }
      if (topic === "graph.status") {
        return { executionOrder: ["a", "b"] };
      }
      return undefined;
    });
    const controller = createPipelineMonitorController(host, rpc);
    await expect(controller.loadGraph("missing")).rejects.toThrow("not found");
    const result = await controller.getGraphStatus("missing");
    expect(call).toBe(2);
    expect(result.executionOrder).toEqual(["a", "b"]);
  });

  it("hostConnected / hostDisconnected: are no-ops (view manages createMonitorState lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createPipelineMonitorController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createPipelineMonitorController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
