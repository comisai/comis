// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createSessionDetailController } from "./session-detail-controller.js";

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

describe("SessionDetailController", () => {
  it("getPipelineSnapshots: forwards agentId + limit to obs.context.pipeline", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return [
        { sessionKey: "s1", agentId: "alpha", budgetUtilization: 50 },
        { sessionKey: "s2", agentId: "alpha", budgetUtilization: 30 },
      ];
    });
    const controller = createSessionDetailController(host, rpc);
    const result = await controller.getPipelineSnapshots("alpha", 100);
    expect((seen[0] as unknown[])[0]).toBe("obs.context.pipeline");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha", limit: 100 });
    expect(result.length).toBe(2);
    expect(result[0]!.sessionKey).toBe("s1");
  });

  it("getDagCompactions: forwards agentId + limit to obs.context.dag", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return [
        { sessionKey: "s1", agentId: "alpha", tokensCompacted: 1000 },
      ];
    });
    const controller = createSessionDetailController(host, rpc);
    const result = await controller.getDagCompactions("alpha", 50);
    expect((seen[0] as unknown[])[0]).toBe("obs.context.dag");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha", limit: 50 });
    expect(result.length).toBe(1);
  });

  it("getSessionBilling: forwards sessionKey to obs.billing.bySession", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { totalTokens: 5000, totalCost: 0.42, callCount: 12 };
    });
    const controller = createSessionDetailController(host, rpc);
    const result = await controller.getSessionBilling("alpha:channel:123");
    expect((seen[0] as unknown[])[0]).toBe("obs.billing.bySession");
    expect((seen[0] as unknown[])[1]).toEqual({
      sessionKey: "alpha:channel:123",
    });
    expect(result.totalTokens).toBe(5000);
    expect(result.totalCost).toBe(0.42);
    expect(result.callCount).toBe(12);
  });

  it("getPipelineSnapshots + getDagCompactions: parallel fan-out in same micro-task batches", async () => {
    const host = makeHost();
    const seen: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args[0] as string);
      // Different latencies to exercise parallel fan-out
      const isDag = (args[0] as string) === "obs.context.dag";
      await new Promise((r) => setTimeout(r, isDag ? 5 : 1));
      return [];
    });
    const controller = createSessionDetailController(host, rpc);
    const [p, d] = await Promise.all([
      controller.getPipelineSnapshots("a", 100),
      controller.getDagCompactions("a", 50),
    ]);
    expect(seen).toEqual(
      expect.arrayContaining(["obs.context.pipeline", "obs.context.dag"]),
    );
    expect(p).toEqual([]);
    expect(d).toEqual([]);
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon unreachable");
    });
    const controller = createSessionDetailController(host, rpc);
    await expect(controller.getPipelineSnapshots("a", 100)).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.getDagCompactions("a", 50)).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.getSessionBilling("s1")).rejects.toThrow(
      "daemon unreachable",
    );
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createSessionDetailController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createSessionDetailController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
