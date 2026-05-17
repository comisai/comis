// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";
import { createAgentEditorController } from "./agent-editor-controller.js";

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

describe("AgentEditorController", () => {
  it("loadModelCatalog: returns models.list response with providers", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "models.list") {
        return {
          providers: [
            { name: "anthropic", models: [{ modelId: "claude-sonnet-4-5", cost: { input: 3, output: 15 } }] },
          ],
          totalModels: 1,
        };
      }
      return {};
    });
    const controller = createAgentEditorController(host, rpc);
    const result = await controller.loadModelCatalog();
    expect(result.providers?.length).toBe(1);
    expect(result.providers?.[0]?.name).toBe("anthropic");
  });

  it("loadTopLevelConfig: returns config.read response with top-level sections", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "config.read") {
        return {
          config: {
            streaming: { enabled: true },
            deliveryQueue: { enabled: false },
          },
          sections: ["streaming", "deliveryQueue"],
        };
      }
      return {};
    });
    const controller = createAgentEditorController(host, rpc);
    const result = await controller.loadTopLevelConfig();
    expect(result.config.streaming).toEqual({ enabled: true });
    expect(result.sections).toContain("streaming");
  });

  it("patchConfig: forwards section + key + value to config.patch", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createAgentEditorController(host, rpc);
    await controller.patchConfig("streaming", "enabled", false);
    expect(seen.length).toBe(1);
    expect((seen[0] as unknown[])[0]).toBe("config.patch");
    expect((seen[0] as unknown[])[1]).toEqual({ section: "streaming", key: "enabled", value: false });
  });

  it("setLogLevel: omits module when not provided", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createAgentEditorController(host, rpc);
    await controller.setLogLevel("debug");
    expect((seen[0] as unknown[])[0]).toBe("daemon.setLogLevel");
    expect((seen[0] as unknown[])[1]).toEqual({ level: "debug" });
  });

  it("setLogLevel: includes module when provided", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createAgentEditorController(host, rpc);
    await controller.setLogLevel("trace", "agent.executor");
    expect((seen[0] as unknown[])[1]).toEqual({ level: "trace", module: "agent.executor" });
  });

  it("loadAgent / createAgent / updateAgent: invoke matching agents.* methods", async () => {
    const host = makeHost();
    const calls: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      calls.push(method);
      if (method === "agents.get") return { agentId: "alice", config: { name: "Alice" } };
      if (method === "agents.create") return { agentId: "bob" };
      return {};
    });
    const controller = createAgentEditorController(host, rpc);
    const loaded = await controller.loadAgent("alice");
    expect(loaded.agentId).toBe("alice");
    const created = await controller.createAgent("bob", { name: "Bob" });
    expect(created.agentId).toBe("bob");
    await controller.updateAgent("alice", { name: "Alice v2" });
    expect(calls).toEqual(["agents.get", "agents.create", "agents.update"]);
  });

  it("validateAgent: invokes agents.update with dryRun=true", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createAgentEditorController(host, rpc);
    await controller.validateAgent("alice", { name: "Alice" });
    expect((seen[0] as unknown[])[0]).toBe("agents.update");
    const params = (seen[0] as unknown[])[1] as { agentId: string; dryRun: boolean };
    expect(params.agentId).toBe("alice");
    expect(params.dryRun).toBe(true);
  });

  it("RPC errors propagate to caller (errorMessage preserved)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("Connection refused");
    });
    const controller = createAgentEditorController(host, rpc);
    await expect(controller.loadModelCatalog()).rejects.toThrow("Connection refused");
    await expect(controller.loadAgent("alice")).rejects.toThrow("Connection refused");
  });
});
