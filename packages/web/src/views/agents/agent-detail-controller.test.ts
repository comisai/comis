// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";
import { createAgentDetailController } from "./agent-detail-controller.js";

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

describe("AgentDetailController", () => {
  it("getAgent: forwards agentId to agents.get + returns raw payload", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        agentId: "alpha",
        config: { name: "Alpha", provider: "anthropic", model: "claude-opus-4-7" },
        suspended: false,
      };
    });
    const controller = createAgentDetailController(host, rpc);
    const result = await controller.getAgent("alpha");
    expect((seen[0] as unknown[])[0]).toBe("agents.get");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha" });
    expect(result.agentId).toBe("alpha");
    expect(result.config.name).toBe("Alpha");
    expect(result.suspended).toBe(false);
  });

  it("getAgentBilling / listSkills / getHeartbeatStates: parallel-fan-out reads with verbatim params", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      const topic = args[0] as string;
      if (topic === "obs.billing.byAgent") {
        return { totalCost: 1.23, totalTokens: 1234, costToday: 0.4 };
      }
      if (topic === "skills.list") {
        return {
          skills: [
            { name: "code-search", description: "search the repo", location: "bundled" },
          ],
        };
      }
      if (topic === "heartbeat.states") {
        return {
          agents: [
            {
              agentId: "alpha",
              enabled: true,
              intervalMs: 60000,
              lastRunMs: 1000,
              nextDueMs: 2000,
              backoffUntilMs: 0,
              consecutiveErrors: 0,
              tickStartedAtMs: 0,
            },
          ],
        };
      }
      return undefined;
    });
    const controller = createAgentDetailController(host, rpc);
    const [billing, skills, hb] = await Promise.all([
      controller.getAgentBilling("alpha"),
      controller.listSkills("alpha"),
      controller.getHeartbeatStates(),
    ]);
    expect(billing.totalCost).toBe(1.23);
    expect(skills.skills?.[0]?.name).toBe("code-search");
    expect(hb.agents?.[0]?.agentId).toBe("alpha");
    expect((seen[0] as unknown[])[0]).toBe("obs.billing.byAgent");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha" });
    expect((seen[1] as unknown[])[0]).toBe("skills.list");
    expect((seen[1] as unknown[])[1]).toEqual({ agentId: "alpha" });
    expect((seen[2] as unknown[])[0]).toBe("heartbeat.states");
    expect((seen[2] as unknown[])[1]).toEqual({});
  });

  it("suspendAgent / resumeAgent: invoke agents.suspend + agents.resume with agentId", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createAgentDetailController(host, rpc);
    await controller.suspendAgent("alpha");
    await controller.resumeAgent("alpha");
    expect((seen[0] as unknown[])[0]).toBe("agents.suspend");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha" });
    expect((seen[1] as unknown[])[0]).toBe("agents.resume");
    expect((seen[1] as unknown[])[1]).toEqual({ agentId: "alpha" });
  });

  it("deleteAgent: invokes agents.delete with agentId", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const controller = createAgentDetailController(host, rpc);
    await controller.deleteAgent("zeta");
    expect((seen[0] as unknown[])[0]).toBe("agents.delete");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "zeta" });
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon unreachable");
    });
    const controller = createAgentDetailController(host, rpc);
    await expect(controller.getAgent("a")).rejects.toThrow("daemon unreachable");
    await expect(controller.getAgentBilling("a")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.listSkills("a")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.getHeartbeatStates()).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.suspendAgent("a")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.resumeAgent("a")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.deleteAgent("a")).rejects.toThrow(
      "daemon unreachable",
    );
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createAgentDetailController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createAgentDetailController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
