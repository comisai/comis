import type { WSContext } from "hono/ws";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RpcContext } from "./method-router.js";
import type { WsLogger } from "./ws-handler.js";
import { createMethodRouter, createStubMethods } from "./method-router.js";
import { WsConnectionManager, createWsHandler } from "./ws-handler.js";
import { createMockLogger as _createMockLogger } from "../../../../test/support/mock-logger.js";

const createMockLogger = (): WsLogger => _createMockLogger() as unknown as WsLogger;


/** Create a mock WSContext */
function createMockWs(): WSContext {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    raw: undefined,
    binaryType: "arraybuffer" as BinaryType,
    url: null,
    protocol: null,
  } as unknown as WSContext;
}
/** Standard RPC context for tests */
const TEST_CTX: RpcContext = { clientId: "test-client", scopes: ["rpc"] };

describe("WsConnectionManager", () => {
  let manager: WsConnectionManager;

  beforeEach(() => {
    manager = new WsConnectionManager();
  });

  it("starts with zero connections", () => {
    expect(manager.size).toBe(0);
  });

  it("adds a connection", () => {
    const ws = createMockWs();
    manager.add("conn-1", "client-a", ws);
    expect(manager.size).toBe(1);
    expect(manager.has("conn-1")).toBe(true);
  });

  it("removes a connection", () => {
    const ws = createMockWs();
    manager.add("conn-1", "client-a", ws);
    manager.remove("conn-1");
    expect(manager.size).toBe(0);
    expect(manager.has("conn-1")).toBe(false);
  });

  it("removes nonexistent connection without error", () => {
    expect(() => manager.remove("nonexistent")).not.toThrow();
  });

  it("gets a connection by id", () => {
    const ws = createMockWs();
    manager.add("conn-1", "client-a", ws);
    const conn = manager.get("conn-1");
    expect(conn).toBeDefined();
    expect(conn!.clientId).toBe("client-a");
  });

  it("sendToClientId returns false when no connections match", () => {
    const result = manager.sendToClientId("nonexistent", "notification.message", { text: "hello" });
    expect(result).toBe(false);
  });

  it("sendToClientId sends JSON-RPC notification to matching client", () => {
    const ws = createMockWs();
    manager.add("conn-1", "web-user-1", ws);

    const result = manager.sendToClientId("web-user-1", "notification.message", { text: "hello" });

    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledOnce();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent).toEqual({
      jsonrpc: "2.0",
      method: "notification.message",
      params: { text: "hello" },
    });
  });

  it("sendToClientId sends to all connections for same clientId", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    manager.add("conn-1", "web-user-1", ws1);
    manager.add("conn-2", "web-user-1", ws2);

    const result = manager.sendToClientId("web-user-1", "notification.message", { text: "hello" });

    expect(result).toBe(true);
    expect(ws1.send).toHaveBeenCalledOnce();
    expect(ws2.send).toHaveBeenCalledOnce();
  });

  it("sendToClientId handles send errors gracefully", () => {
    const ws = createMockWs();
    (ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("connection closed"); });
    manager.add("conn-1", "web-user-1", ws);

    const result = manager.sendToClientId("web-user-1", "notification.message", { text: "hello" });

    expect(result).toBe(false);
  });

  it("broadcast returns false when no connections exist", () => {
    const result = manager.broadcast("notification.message", { text: "hello" });
    expect(result).toBe(false);
  });

  it("broadcast sends to all connections regardless of clientId", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    manager.add("conn-1", "client-a", ws1);
    manager.add("conn-2", "client-b", ws2);

    const result = manager.broadcast("notification.message", { text: "hello" });

    expect(result).toBe(true);
    expect(ws1.send).toHaveBeenCalledOnce();
    expect(ws2.send).toHaveBeenCalledOnce();
    const sent = JSON.parse((ws1.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent).toEqual({
      jsonrpc: "2.0",
      method: "notification.message",
      params: { text: "hello" },
    });
  });

  it("broadcast handles send errors gracefully", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    (ws1.send as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("closed"); });
    manager.add("conn-1", "client-a", ws1);
    manager.add("conn-2", "client-b", ws2);

    const result = manager.broadcast("notification.message", { text: "hello" });

    expect(result).toBe(true); // ws2 succeeded
    expect(ws2.send).toHaveBeenCalledOnce();
  });

  it("closeAll removes all connections", async () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    manager.add("conn-1", "client-a", ws1);
    manager.add("conn-2", "client-b", ws2);
    await manager.closeAll();
    expect(manager.size).toBe(0);
    expect(ws1.close).toHaveBeenCalledWith(1001, "Server shutting down");
    expect(ws2.close).toHaveBeenCalledWith(1001, "Server shutting down");
  });
});

describe("createWsHandler", () => {
  let manager: WsConnectionManager;
  let logger: WsLogger;

  beforeEach(() => {
    manager = new WsConnectionManager();
    logger = createMockLogger();
  });

  function createHandlerDeps(overrides: { maxBatchSize?: number; maxMessageBytes?: number; messageRateLimit?: { maxMessages: number; windowMs: number } } = {}) {
    const rpcServer = createMethodRouter(createStubMethods());
    return {
      rpcServer,
      connections: manager,
      logger,
      maxBatchSize: overrides.maxBatchSize ?? 50,
      heartbeatMs: 0, // disable heartbeat in tests
      maxMessageBytes: overrides.maxMessageBytes ?? 1_048_576,
      messageRateLimit: overrides.messageRateLimit ?? { maxMessages: 60, windowMs: 60_000 },
    };
  }

  it("onOpen adds connection to manager", () => {
    const deps = createHandlerDeps();
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);
    expect(manager.size).toBe(1);
  });

  it("onClose removes connection from manager", () => {
    const deps = createHandlerDeps();
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);
    expect(manager.size).toBe(1);

    events.onClose!({ type: "close" } as CloseEvent, ws);
    expect(manager.size).toBe(0);
  });

  it("onMessage dispatches JSON-RPC request", async () => {
    const deps = createHandlerDeps();
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);

    const request = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent.execute",
      params: { query: "test" },
      id: 1,
    });

    await events.onMessage!(new MessageEvent("message", { data: request }), ws);

    expect(ws.send).toHaveBeenCalled();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.result).toBeDefined();
    expect(sent.result.stub).toBe(true);
    expect(sent.id).toBe(1);
  });

  it("rejects batch exceeding maxBatchSize", async () => {
    const deps = createHandlerDeps({ maxBatchSize: 2 }); // max 2
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);

    const batch = JSON.stringify([
      { jsonrpc: "2.0", method: "agent.execute", params: {}, id: 1 },
      { jsonrpc: "2.0", method: "agent.execute", params: {}, id: 2 },
      { jsonrpc: "2.0", method: "agent.execute", params: {}, id: 3 },
    ]);

    await events.onMessage!(new MessageEvent("message", { data: batch }), ws);

    expect(ws.send).toHaveBeenCalled();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.error.code).toBe(-32600);
    expect(sent.error.message).toContain("exceeds maximum");
  });

  it("allows batch within maxBatchSize", async () => {
    const deps = createHandlerDeps({ maxBatchSize: 5 });
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);

    const batch = JSON.stringify([
      { jsonrpc: "2.0", method: "agent.execute", params: {}, id: 1 },
      { jsonrpc: "2.0", method: "memory.search", params: {}, id: 2 },
    ]);

    await events.onMessage!(new MessageEvent("message", { data: batch }), ws);

    expect(ws.send).toHaveBeenCalled();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    // Batch response is an array
    expect(Array.isArray(sent)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("returns parse error for invalid JSON", async () => {
    const deps = createHandlerDeps();
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);

    await events.onMessage!(new MessageEvent("message", { data: "not json{" }), ws);

    expect(ws.send).toHaveBeenCalled();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.error.code).toBe(-32700);
    expect(sent.error.message).toBe("Parse error");
  });

  it("returns error for unregistered method via WebSocket", async () => {
    const deps = createHandlerDeps();
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);

    const request = JSON.stringify({
      jsonrpc: "2.0",
      method: "nonexistent",
      id: 99,
    });

    await events.onMessage!(new MessageEvent("message", { data: request }), ws);

    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.error).toBeDefined();
    expect(sent.error.code).toBe(-32601);
  });

  it("rejects message exceeding maxMessageBytes with JSON-RPC error -32600", async () => {
    const deps = createHandlerDeps({ maxMessageBytes: 50 }); // very small limit
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);

    // Create a message that exceeds 50 characters
    const bigMessage = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent.execute",
      params: { query: "a".repeat(100) },
      id: 1,
    });
    expect(bigMessage.length).toBeGreaterThan(50);

    await events.onMessage!(new MessageEvent("message", { data: bigMessage }), ws);

    expect(ws.send).toHaveBeenCalled();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.error.code).toBe(-32600);
    expect(sent.error.message).toContain("exceeds maximum");
    expect(sent.error.message).toContain("bytes");
  });

  it("processes messages within maxMessageBytes normally", async () => {
    const deps = createHandlerDeps({ maxMessageBytes: 10_000 });
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);

    const request = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent.execute",
      params: { query: "test" },
      id: 1,
    });

    await events.onMessage!(new MessageEvent("message", { data: request }), ws);

    expect(ws.send).toHaveBeenCalled();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.result).toBeDefined();
    expect(sent.id).toBe(1);
  });

  it("rejects messages exceeding rate limit with JSON-RPC error -32000", async () => {
    const deps = createHandlerDeps({ messageRateLimit: { maxMessages: 3, windowMs: 60_000 } });
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);

    const makeRequest = (id: number) =>
      JSON.stringify({ jsonrpc: "2.0", method: "agent.execute", params: {}, id });

    // Send 3 messages (within limit)
    for (let i = 1; i <= 3; i++) {
      await events.onMessage!(new MessageEvent("message", { data: makeRequest(i) }), ws);
    }

    // 4th message should be rate limited
    await events.onMessage!(new MessageEvent("message", { data: makeRequest(4) }), ws);

    const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
    const lastSent = JSON.parse(calls[calls.length - 1][0]);
    expect(lastSent.error.code).toBe(-32000);
    expect(lastSent.error.message).toBe("Message rate limit exceeded");
  });

  it("allows messages within rate limit", async () => {
    const deps = createHandlerDeps({ messageRateLimit: { maxMessages: 10, windowMs: 60_000 } });
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);

    const request = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent.execute",
      params: { query: "test" },
      id: 1,
    });

    // Send 5 messages (well within limit of 10)
    for (let i = 0; i < 5; i++) {
      await events.onMessage!(new MessageEvent("message", { data: request }), ws);
    }

    // All 5 should get normal responses (no rate limit errors)
    const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      const sent = JSON.parse(call[0]);
      expect(sent.error).toBeUndefined();
      expect(sent.result).toBeDefined();
    }
  });

  it("onError logs error", () => {
    const deps = createHandlerDeps();
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onError!(new Event("error"), ws);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "test-client",
        errorKind: "network",
        hint: expect.any(String),
      }),
      "WebSocket error",
    );
  });

  it("rejects binary messages with JSON-RPC -32700 error", async () => {
    const deps = createHandlerDeps();
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);

    // Simulate binary data (non-string evt.data)
    await events.onMessage!(
      new MessageEvent("message", { data: new ArrayBuffer(8) }),
      ws,
    );

    expect(ws.send).toHaveBeenCalled();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sent.error.code).toBe(-32700);
    expect(sent.error.message).toBe("Binary messages not supported");
  });

  it("onClose logs abnormal close at INFO level", () => {
    const deps = createHandlerDeps();
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);
    // Close code 1006 = abnormal (not 1000/1001/1005)
    events.onClose!(
      { type: "close", code: 1006, reason: "" } as CloseEvent,
      ws,
    );

    expect(manager.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        closeCode: 1006,
        closeType: "abnormal",
        clientId: "test-client",
      }),
      expect.stringContaining("WebSocket disconnected"),
    );
  });

  it("onClose with normal close (1000) logs at DEBUG level", () => {
    const deps = createHandlerDeps();
    const events = createWsHandler(deps, TEST_CTX);
    const ws = createMockWs();

    events.onOpen!(new Event("open"), ws);
    events.onClose!(
      { type: "close", code: 1000, reason: "" } as CloseEvent,
      ws,
    );

    expect(manager.size).toBe(0);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        closeCode: 1000,
        closeType: "normal",
      }),
      expect.stringContaining("WebSocket disconnected"),
    );
  });
});
