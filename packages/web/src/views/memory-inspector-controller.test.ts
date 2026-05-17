// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createMemoryInspectorController } from "./memory-inspector-controller.js";

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

describe("MemoryInspectorController", () => {
  it("getEmbeddingCache: returns memory.embeddingCache response", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "memory.embeddingCache") return { hits: 42, misses: 3 };
      return {};
    });
    const controller = createMemoryInspectorController(host, rpc);
    const result = await controller.getEmbeddingCache();
    expect(result).toEqual({ hits: 42, misses: 3 });
  });

  it("storeEntry: forwards content + tags + trustLevel to memory.store", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createMemoryInspectorController(host, rpc);
    await controller.storeEntry({
      content: "test memory",
      tags: ["tag1", "tag2"],
      trustLevel: "learned",
    });
    expect((seen[0] as unknown[])[0]).toBe("memory.store");
    expect((seen[0] as unknown[])[1]).toEqual({
      content: "test memory",
      tags: ["tag1", "tag2"],
      trustLevel: "learned",
    });
  });

  it("storeEntry: omits tags when empty array", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createMemoryInspectorController(host, rpc);
    await controller.storeEntry({
      content: "no-tags entry",
      tags: [],
      trustLevel: "system",
    });
    const params = (seen[0] as unknown[])[1] as { tags?: string[] };
    expect(params.tags).toBeUndefined();
  });

  it("storeEntry: omits tags when not provided", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createMemoryInspectorController(host, rpc);
    await controller.storeEntry({
      content: "no-tags",
      trustLevel: "external",
    });
    const params = (seen[0] as unknown[])[1] as { tags?: string[] };
    expect(params.tags).toBeUndefined();
  });

  it("flushMemory: forwards agent_id to memory.flush", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createMemoryInspectorController(host, rpc);
    await controller.flushMemory("alpha");
    expect((seen[0] as unknown[])[0]).toBe("memory.flush");
    expect((seen[0] as unknown[])[1]).toEqual({ agent_id: "alpha" });
  });

  it("flushMemory: forwards undefined when agentId is omitted (flush-all)", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createMemoryInspectorController(host, rpc);
    await controller.flushMemory();
    const params = (seen[0] as unknown[])[1] as { agent_id?: string };
    expect(params.agent_id).toBeUndefined();
  });

  it("RPC errors propagate to caller", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("memory store offline");
    });
    const controller = createMemoryInspectorController(host, rpc);
    await expect(controller.getEmbeddingCache()).rejects.toThrow("memory store offline");
    await expect(
      controller.storeEntry({ content: "x", trustLevel: "learned" }),
    ).rejects.toThrow("memory store offline");
    await expect(controller.flushMemory("alpha")).rejects.toThrow("memory store offline");
  });
});
