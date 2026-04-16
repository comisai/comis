import { describe, it, expect, vi } from "vitest";
import { createRpcAdapters, type RpcAdapterDeps } from "./rpc-adapters.js";

/** Create mock deps with all adapters as vi.fn() */
function createMockDeps(overrides?: Partial<RpcAdapterDeps>): RpcAdapterDeps {
  return {
    executeAgent: vi.fn().mockResolvedValue({
      response: "Hello from agent",
      tokensUsed: 42,
      finishReason: "stop",
    }),
    searchMemory: vi.fn().mockResolvedValue({
      results: [{ id: "mem-1", content: "test content", score: 0.95 }],
    }),
    inspectMemory: vi.fn().mockResolvedValue({
      stats: { totalEntries: 10 },
    }),
    getConfig: vi.fn().mockResolvedValue({
      tenantId: "default",
      logLevel: "info",
    }),
    setConfig: vi.fn().mockResolvedValue({ ok: true, previous: "old-value" }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("createRpcAdapters", () => {
  describe("agent.execute", () => {
    it("calls executeAgent with valid params", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["agent.execute"](
        { message: "Hello" },
        { clientId: "c1", scopes: ["rpc"] },
      );

      expect(deps.executeAgent).toHaveBeenCalledWith({
        message: "Hello",
        agentId: undefined,
        sessionKey: undefined,
        connectionId: undefined,
        scopes: ["rpc"],
      });
      expect(result).toEqual({
        response: "Hello from agent",
        tokensUsed: 42,
        finishReason: "stop",
      });
    });

    it("returns error when message is missing", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["agent.execute"]({}, { clientId: "c1", scopes: ["rpc"] });

      expect(result).toEqual({ error: "Missing required parameter: message (string)" });
      expect(deps.executeAgent).not.toHaveBeenCalled();
    });

    it("returns error when params is null/undefined", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["agent.execute"](undefined, {
        clientId: "c1",
        scopes: ["rpc"],
      });

      expect(result).toEqual({ error: "Missing required parameter: message (string)" });
    });

    it("returns generic error when adapter throws", async () => {
      const deps = createMockDeps({
        executeAgent: vi.fn().mockRejectedValue(new Error("LLM timeout")),
      });
      const adapters = createRpcAdapters(deps);

      const result = await adapters["agent.execute"](
        { message: "test" },
        { clientId: "c1", scopes: ["rpc"] },
      );

      // Raw error must not reach client
      expect(result).toEqual({ error: "Internal error" });
      expect(JSON.stringify(result)).not.toContain("LLM timeout");
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.anything(),
          method: "agent.execute",
          hint: expect.any(String),
          errorKind: expect.any(String),
        }),
        expect.any(String),
      );
    });
  });

  describe("agent.stream", () => {
    it("falls back to non-streaming and calls executeAgent", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["agent.stream"](
        { message: "Stream me" },
        { clientId: "c1", scopes: ["rpc"] },
      );

      expect(deps.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Stream me", connectionId: undefined, scopes: ["rpc"] }),
      );
      expect(result).toEqual({
        response: "Hello from agent",
        tokensUsed: 42,
        finishReason: "stop",
      });
      expect(deps.logger.info).toHaveBeenCalled();
    });

    it("returns error when message is missing", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["agent.stream"]({}, { clientId: "c1", scopes: ["rpc"] });

      expect(result).toEqual({ error: "Missing required parameter: message (string)" });
    });
  });

  describe("memory.search", () => {
    it("calls searchMemory with valid params", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["memory.search"](
        { query: "hello", limit: 5 },
        { clientId: "c1", scopes: ["rpc"] },
      );

      expect(deps.searchMemory).toHaveBeenCalledWith({
        query: "hello",
        limit: 5,
        tenantId: undefined,
      });
      expect(result).toEqual({
        results: [{ id: "mem-1", content: "test content", score: 0.95 }],
      });
    });

    it("returns error when query is missing", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["memory.search"]({}, { clientId: "c1", scopes: ["rpc"] });

      expect(result).toEqual({ error: "Missing required parameter: query (string)" });
    });
  });

  describe("memory.inspect", () => {
    it("calls inspectMemory with optional params", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["memory.inspect"](
        { id: "entry-1" },
        { clientId: "c1", scopes: ["rpc"] },
      );

      expect(deps.inspectMemory).toHaveBeenCalledWith({
        id: "entry-1",
        tenantId: undefined,
      });
      expect(result).toEqual({ stats: { totalEntries: 10 } });
    });

    it("handles undefined params gracefully", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["memory.inspect"](undefined, {
        clientId: "c1",
        scopes: ["rpc"],
      });

      expect(deps.inspectMemory).toHaveBeenCalledWith({
        id: undefined,
        tenantId: undefined,
      });
      expect(result).toEqual({ stats: { totalEntries: 10 } });
    });
  });

  describe("config.get", () => {
    it("calls getConfig with section parameter", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["config.get"](
        { section: "gateway" },
        { clientId: "c1", scopes: ["admin"] },
      );

      expect(deps.getConfig).toHaveBeenCalledWith({ section: "gateway" });
      expect(result).toEqual({ tenantId: "default", logLevel: "info" });
    });

    it("handles undefined params (returns all config)", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["config.get"](undefined, { clientId: "c1", scopes: ["admin"] });

      expect(deps.getConfig).toHaveBeenCalledWith({ section: undefined });
      expect(result).toBeDefined();
    });
  });

  describe("config.set", () => {
    it("calls setConfig with valid params", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["config.set"](
        { section: "gateway", key: "port", value: 9443 },
        { clientId: "c1", scopes: ["admin"] },
      );

      expect(deps.setConfig).toHaveBeenCalledWith({
        section: "gateway",
        key: "port",
        value: 9443,
      });
      expect(result).toEqual({ ok: true, previous: "old-value" });
    });

    it("returns error when section or key is missing", async () => {
      const deps = createMockDeps();
      const adapters = createRpcAdapters(deps);

      const result = await adapters["config.set"](
        { key: "port", value: 9443 },
        { clientId: "c1", scopes: ["admin"] },
      );

      expect(result).toEqual({
        error: "Missing required parameters: section (string), key (string)",
      });
      expect(deps.setConfig).not.toHaveBeenCalled();
    });
  });

  describe("trust level scoping", () => {
    it("threads scopes from RPC context to executeAgent params", async () => {
      let receivedScopes: readonly string[] | undefined;
      const deps = createMockDeps({
        executeAgent: vi.fn().mockImplementation(async (params) => {
          receivedScopes = params.scopes;
          return { response: "ok", tokensUsed: { input: 0, output: 0, total: 0 }, finishReason: "stop" };
        }),
      });
      const adapters = createRpcAdapters(deps);
      const context = { clientId: "test", scopes: ["rpc", "admin"] as readonly string[], connectionId: "c1" };
      await adapters["agent.execute"]({ message: "hello" }, context);
      expect(receivedScopes).toEqual(["rpc", "admin"]);
    });

    it("threads scopes through agent.stream as well", async () => {
      let receivedScopes: readonly string[] | undefined;
      const deps = createMockDeps({
        executeAgent: vi.fn().mockImplementation(async (params) => {
          receivedScopes = params.scopes;
          return { response: "ok", tokensUsed: { input: 0, output: 0, total: 0 }, finishReason: "stop" };
        }),
      });
      const adapters = createRpcAdapters(deps);
      const context = { clientId: "test", scopes: ["rpc"] as readonly string[], connectionId: "c1" };
      await adapters["agent.stream"]({ message: "hello" }, context);
      expect(receivedScopes).toEqual(["rpc"]);
    });

    it("passes undefined scopes when context has no scopes", async () => {
      let receivedScopes: readonly string[] | undefined = ["should-be-overwritten"];
      const deps = createMockDeps({
        executeAgent: vi.fn().mockImplementation(async (params) => {
          receivedScopes = params.scopes;
          return { response: "ok", tokensUsed: { input: 0, output: 0, total: 0 }, finishReason: "stop" };
        }),
      });
      const adapters = createRpcAdapters(deps);
      const context = { clientId: "test", scopes: [] as readonly string[] };
      await adapters["agent.execute"]({ message: "hello" }, context);
      expect(receivedScopes).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("returns clean error for non-Error throws", async () => {
      const deps = createMockDeps({
        searchMemory: vi.fn().mockRejectedValue("string error"),
      });
      const adapters = createRpcAdapters(deps);

      const result = await adapters["memory.search"](
        { query: "test" },
        { clientId: "c1", scopes: ["rpc"] },
      );

      expect(result).toEqual({ error: "Internal error" });
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.anything(),
          method: "memory.search",
          hint: expect.any(String),
          errorKind: expect.any(String),
        }),
        expect.any(String),
      );
    });
  });
});
