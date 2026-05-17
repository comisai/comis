// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";
import { createAgentListController } from "./agent-list-controller.js";

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

describe("AgentListController", () => {
  it("listModels: invokes models.list with no params + returns providers", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        providers: [
          { id: "anthropic", models: [{ id: "claude-opus-4-7" }] },
          { id: "openai", models: [{ id: "gpt-5" }] },
        ],
        totalModels: 2,
      };
    });
    const controller = createAgentListController(host, rpc);
    const result = await controller.listModels();
    expect((seen[0] as unknown[])[0]).toBe("models.list");
    expect((seen[0] as unknown[]).length).toBe(1);
    expect(result.providers?.length).toBe(2);
    expect(result.totalModels).toBe(2);
  });

  it("getAgentBilling: forwards agentId to obs.billing.byAgent", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { totalCost: 0.42, totalTokens: 4200, costToday: 0.12 };
    });
    const controller = createAgentListController(host, rpc);
    const result = await controller.getAgentBilling("alpha");
    expect((seen[0] as unknown[])[0]).toBe("obs.billing.byAgent");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha" });
    expect(result.totalCost).toBe(0.42);
  });

  it("suspendAgent / resumeAgent: invoke agents.suspend + agents.resume with agentId", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createAgentListController(host, rpc);
    await controller.suspendAgent("alpha");
    await controller.resumeAgent("beta");
    expect((seen[0] as unknown[])[0]).toBe("agents.suspend");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha" });
    expect((seen[1] as unknown[])[0]).toBe("agents.resume");
    expect((seen[1] as unknown[])[1]).toEqual({ agentId: "beta" });
  });

  it("deleteAgent: invokes agents.delete with agentId", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createAgentListController(host, rpc);
    await controller.deleteAgent("alpha");
    expect((seen[0] as unknown[])[0]).toBe("agents.delete");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha" });
  });

  it("createAgent: forwards full payload to agents.create", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createAgentListController(host, rpc);
    await controller.createAgent({
      agentId: "new-agent",
      config: {
        name: "New Agent",
        provider: "anthropic",
        model: "claude-opus-4-7",
        skills: { toolPolicy: { profile: "full" } },
      },
    });
    expect((seen[0] as unknown[])[0]).toBe("agents.create");
    expect((seen[0] as unknown[])[1]).toEqual({
      agentId: "new-agent",
      config: {
        name: "New Agent",
        provider: "anthropic",
        model: "claude-opus-4-7",
        skills: { toolPolicy: { profile: "full" } },
      },
    });
  });

  it("getAgentBilling: parallel fan-out for 50 agents accumulates into a map", async () => {
    const host = makeHost();
    const seen: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const params = args[1] as { agentId: string };
      seen.push(params.agentId);
      return { totalCost: 0.01, totalTokens: 100 };
    });
    const controller = createAgentListController(host, rpc);
    const ids = Array.from({ length: 50 }, (_, i) => `agent-${i}`);
    const results = await Promise.allSettled(
      ids.map((id) => controller.getAgentBilling(id)),
    );
    expect(seen.length).toBe(50);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(seen[0]).toBe("agent-0");
    expect(seen[49]).toBe("agent-49");
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon unreachable");
    });
    const controller = createAgentListController(host, rpc);
    await expect(controller.listModels()).rejects.toThrow("daemon unreachable");
    await expect(controller.getAgentBilling("a")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.suspendAgent("a")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.deleteAgent("a")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(
      controller.createAgent({
        agentId: "x",
        config: { provider: "p", model: "m" },
      }),
    ).rejects.toThrow("daemon unreachable");
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createAgentListController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createAgentListController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
