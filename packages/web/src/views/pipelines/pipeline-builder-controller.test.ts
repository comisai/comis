// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";
import { createPipelineBuilderController } from "./pipeline-builder-controller.js";

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

describe("PipelineBuilderController", () => {
  it("defineGraph: forwards full validation payload to graph.define + returns nodeCount + executionOrder", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        nodeCount: 3,
        executionOrder: ["a", "b", "c"],
      };
    });
    const controller = createPipelineBuilderController(host, rpc);
    const result = await controller.defineGraph({
      nodes: [
        { nodeId: "a", task: "Step 1", dependsOn: [] },
        { nodeId: "b", task: "Step 2", dependsOn: ["a"] },
        { nodeId: "c", task: "Step 3", dependsOn: ["b"] },
      ],
      label: "Test Graph",
      onFailure: "fail-fast",
    });
    expect((seen[0] as unknown[])[0]).toBe("graph.define");
    expect((seen[0] as unknown[])[1]).toMatchObject({
      label: "Test Graph",
      onFailure: "fail-fast",
    });
    expect(result.nodeCount).toBe(3);
    expect(result.executionOrder).toEqual(["a", "b", "c"]);
  });

  it("loadGraph: forwards graphId to graph.load + returns raw server graph (label + execution-format nodes)", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        label: "Loaded Graph",
        nodes: [
          { nodeId: "a", task: "Step 1", agent: "alpha", dependsOn: [] },
        ],
        edges: [],
        settings: { label: "Loaded Graph", onFailure: "abort" },
      };
    });
    const controller = createPipelineBuilderController(host, rpc);
    const result = await controller.loadGraph("g1");
    expect((seen[0] as unknown[])[0]).toBe("graph.load");
    expect((seen[0] as unknown[])[1]).toEqual({ id: "g1" });
    expect(result.label).toBe("Loaded Graph");
    expect(result.nodes.length).toBe(1);
  });

  it("saveGraph: forwards full save payload to graph.save (draft persistence)", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createPipelineBuilderController(host, rpc);
    await controller.saveGraph({
      id: "draft-1",
      label: "Draft 1",
      nodes: [] as never,
      edges: [] as never,
      settings: { label: "Draft 1", onFailure: "abort" } as never,
    });
    expect((seen[0] as unknown[])[0]).toBe("graph.save");
    expect((seen[0] as unknown[])[1]).toMatchObject({
      id: "draft-1",
      label: "Draft 1",
    });
  });

  it("executeGraph: forwards full execution payload to graph.execute + returns graphId", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { graphId: "exec-42" };
    });
    const controller = createPipelineBuilderController(host, rpc);
    const result = await controller.executeGraph({
      nodes: [
        { nodeId: "a", task: "Run me", dependsOn: [] },
      ],
      label: "Run Test",
      onFailure: "fail-fast",
      timeoutMs: 60_000,
    });
    expect((seen[0] as unknown[])[0]).toBe("graph.execute");
    expect((seen[0] as unknown[])[1]).toMatchObject({
      label: "Run Test",
      onFailure: "fail-fast",
      timeoutMs: 60_000,
    });
    expect(result.graphId).toBe("exec-42");
  });

  it("loadGraph: returns raw server payload even when nodes use execution-format keys (nodeId + agent + dependsOn)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => ({
      nodes: [
        { nodeId: "n1", agent: "alpha", task: "x", dependsOn: [] },
        { nodeId: "n2", agent: "beta", task: "y", dependsOn: ["n1"], context_mode: "summary" },
      ],
      edges: [],
      settings: { label: "Raw", onFailure: "abort" },
    }));
    const controller = createPipelineBuilderController(host, rpc);
    const result = await controller.loadGraph("g-raw");
    // Controller is a pass-through; the view performs the execution-format → canvas-format mapping.
    expect(result.nodes[0]).toMatchObject({ nodeId: "n1", agent: "alpha" });
    expect(result.nodes[1]).toMatchObject({ context_mode: "summary" });
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon unreachable");
    });
    const controller = createPipelineBuilderController(host, rpc);
    await expect(controller.defineGraph({})).rejects.toThrow("daemon unreachable");
    await expect(controller.loadGraph("g1")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(
      controller.saveGraph({
        id: "x",
        nodes: [] as never,
        edges: [] as never,
        settings: { label: "x", onFailure: "abort" } as never,
      }),
    ).rejects.toThrow("daemon unreachable");
    await expect(controller.executeGraph({})).rejects.toThrow(
      "daemon unreachable",
    );
  });

  it("hostConnected / hostDisconnected: are no-ops (view manages createGraphBuilderState lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createPipelineBuilderController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createPipelineBuilderController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
