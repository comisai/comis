// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createModelsController } from "./models-controller.js";

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

describe("ModelsController", () => {
  it("readConfig: returns config.read response with providers + models", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "config.read") {
        return {
          config: {
            providers: { entries: { anthropic: { type: "anthropic" } } },
            models: { aliases: [], defaultProvider: "anthropic", defaultModel: "claude" },
          },
          sections: ["providers", "models"],
        };
      }
      return {};
    });
    const controller = createModelsController(host, rpc);
    const result = await controller.readConfig();
    expect(result.sections).toEqual(["providers", "models"]);
    const providers = result.config.providers as { entries: Record<string, unknown> };
    expect(providers.entries.anthropic).toBeDefined();
  });

  it("listModels: returns models.list response", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "models.list") {
        return {
          providers: [{ name: "anthropic", models: ["claude-sonnet-4-5"], modelCount: 1 }],
          totalModels: 1,
        };
      }
      return {};
    });
    const controller = createModelsController(host, rpc);
    const result = await controller.listModels();
    expect(result.providers?.length).toBe(1);
    expect(result.totalModels).toBe(1);
  });

  it("listAgents / getAgent: forward to matching RPC methods", async () => {
    const host = makeHost();
    const calls: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      calls.push(method);
      if (method === "agents.list") return { agents: ["alpha", "beta"] };
      if (method === "agents.get") {
        return {
          agentId: (args[1] as { agentId: string }).agentId,
          config: { provider: "anthropic", model: "claude" },
        };
      }
      return {};
    });
    const controller = createModelsController(host, rpc);
    const list = await controller.listAgents();
    expect(list.agents).toEqual(["alpha", "beta"]);
    const alpha = await controller.getAgent("alpha");
    expect(alpha.agentId).toBe("alpha");
    expect(alpha.config.provider).toBe("anthropic");
    expect(calls).toEqual(["agents.list", "agents.get"]);
  });

  it("patchConfig: forwards section + key + value to config.patch", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createModelsController(host, rpc);
    await controller.patchConfig("providers", "anthropic.apiKeyName", "env:ANTHROPIC_API_KEY");
    expect((seen[0] as unknown[])[0]).toBe("config.patch");
    expect((seen[0] as unknown[])[1]).toEqual({
      section: "providers",
      key: "anthropic.apiKeyName",
      value: "env:ANTHROPIC_API_KEY",
    });
  });

  it("patchConfig: forwards undefined key when path has no dot (whole-section)", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createModelsController(host, rpc);
    await controller.patchConfig("models", undefined, { aliases: [] });
    const params = (seen[0] as unknown[])[1] as { key: string | undefined };
    expect(params.key).toBeUndefined();
  });

  it("testProvider: returns models.test response with status", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { status: "ok" };
    });
    const controller = createModelsController(host, rpc);
    const result = await controller.testProvider("anthropic");
    expect(result.status).toBe("ok");
    expect((seen[0] as unknown[])[1]).toEqual({ provider: "anthropic" });
  });

  it("updateAgent: forwards agentId + config to agents.update", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createModelsController(host, rpc);
    await controller.updateAgent("alpha", { provider: "openai", model: "gpt-4o" });
    expect((seen[0] as unknown[])[0]).toBe("agents.update");
    expect((seen[0] as unknown[])[1]).toEqual({
      agentId: "alpha",
      config: { provider: "openai", model: "gpt-4o" },
    });
  });

  it("RPC errors propagate to caller", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon offline");
    });
    const controller = createModelsController(host, rpc);
    await expect(controller.readConfig()).rejects.toThrow("daemon offline");
    await expect(controller.testProvider("anthropic")).rejects.toThrow("daemon offline");
    await expect(
      controller.updateAgent("alpha", { provider: "openai" }),
    ).rejects.toThrow("daemon offline");
  });
});
