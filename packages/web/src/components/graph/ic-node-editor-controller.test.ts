// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";
import { createIcNodeEditorController } from "./ic-node-editor-controller.js";

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

describe("IcNodeEditorController", () => {
  it("listAgents: invokes agents.list and returns the agent-id array", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { agents: ["alpha", "beta", "gamma"] };
    });
    const controller = createIcNodeEditorController(host, rpc);
    const result = await controller.listAgents();
    expect((seen[0] as unknown[])[0]).toBe("agents.list");
    expect(result.agents).toEqual(["alpha", "beta", "gamma"]);
  });

  it("getAgent: forwards agentId param + returns the full agent record", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        agentId: "alpha",
        config: { model: "gpt-4", provider: "openai" },
        suspended: false,
      };
    });
    const controller = createIcNodeEditorController(host, rpc);
    const result = await controller.getAgent("alpha");
    expect((seen[0] as unknown[])[0]).toBe("agents.get");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha" });
    expect(result.agentId).toBe("alpha");
    expect(result.config.model).toBe("gpt-4");
    expect(result.config.provider).toBe("openai");
    expect(result.suspended).toBe(false);
  });

  it("listModels: invokes models.list with empty payload + returns provider catalog", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        providers: [
          {
            name: "openai",
            models: ["gpt-4", { modelId: "gpt-4o" }],
          },
          {
            name: "anthropic",
            models: [{ modelId: "claude-opus-4" }],
          },
        ],
      };
    });
    const controller = createIcNodeEditorController(host, rpc);
    const result = await controller.listModels();
    expect((seen[0] as unknown[])[0]).toBe("models.list");
    expect((seen[0] as unknown[])[1]).toEqual({});
    expect(result.providers.length).toBe(2);
    expect(result.providers[0]!.name).toBe("openai");
  });

  it("readSecurityConfig: invokes config.read with section=security + returns allowAgents", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        agentToAgent: { allowAgents: ["alpha", "beta"] },
      };
    });
    const controller = createIcNodeEditorController(host, rpc);
    const result = await controller.readSecurityConfig();
    expect((seen[0] as unknown[])[0]).toBe("config.read");
    expect((seen[0] as unknown[])[1]).toEqual({ section: "security" });
    expect(result.agentToAgent?.allowAgents).toEqual(["alpha", "beta"]);
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon unreachable");
    });
    const controller = createIcNodeEditorController(host, rpc);
    await expect(controller.listAgents()).rejects.toThrow("daemon unreachable");
    await expect(controller.getAgent("alpha")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.listModels()).rejects.toThrow("daemon unreachable");
    await expect(controller.readSecurityConfig()).rejects.toThrow(
      "daemon unreachable",
    );
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createIcNodeEditorController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createIcNodeEditorController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
