// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createDashboardController } from "./dashboard-controller.js";

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

describe("DashboardController", () => {
  it("getBillingTotal: invokes obs.billing.total with sinceMs param", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { totalCost: 1.23, totalTokens: 456 };
    });
    const controller = createDashboardController(host, rpc);
    const result = await controller.getBillingTotal(86_400_000);
    expect((seen[0] as unknown[])[0]).toBe("obs.billing.total");
    expect((seen[0] as unknown[])[1]).toEqual({ sinceMs: 86_400_000 });
    expect(result.totalCost).toBe(1.23);
    expect(result.totalTokens).toBe(456);
  });

  it("getUsage24h: invokes obs.billing.usage24h with no params + returns hourly histogram", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return [
        { hour: 0, tokens: 100 },
        { hour: 1, tokens: 50 },
      ];
    });
    const controller = createDashboardController(host, rpc);
    const result = await controller.getUsage24h();
    expect((seen[0] as unknown[])[0]).toBe("obs.billing.usage24h");
    expect((seen[0] as unknown[]).length).toBe(1);
    expect(result.length).toBe(2);
    expect(result[0]!.tokens).toBe(100);
  });

  it("getBillingByAgent: forwards agentId param + returns per-agent rollup", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { totalCost: 0.99, totalTokens: 1000 };
    });
    const controller = createDashboardController(host, rpc);
    const result = await controller.getBillingByAgent("alpha");
    expect((seen[0] as unknown[])[0]).toBe("obs.billing.byAgent");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha" });
    expect(result.totalCost).toBe(0.99);
  });

  it("parallel fan-out: 7 days of obs.billing.total accumulate into a sparkline", async () => {
    const host = makeHost();
    const calls: number[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const params = args[1] as { sinceMs: number };
      calls.push(params.sinceMs);
      return { totalCost: params.sinceMs / 1_000_000 };
    });
    const controller = createDashboardController(host, rpc);
    const dayMs = 86_400_000;
    const results = await Promise.allSettled(
      Array.from({ length: 7 }, (_, i) =>
        controller.getBillingTotal(dayMs * (i + 1)),
      ),
    );
    expect(calls.length).toBe(7);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(calls[0]).toBe(dayMs);
    expect(calls[6]).toBe(dayMs * 7);
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon unreachable");
    });
    const controller = createDashboardController(host, rpc);
    await expect(controller.getBillingTotal(1000)).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.getUsage24h()).rejects.toThrow("daemon unreachable");
    await expect(controller.getBillingByAgent("alpha")).rejects.toThrow(
      "daemon unreachable",
    );
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createDashboardController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createDashboardController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
