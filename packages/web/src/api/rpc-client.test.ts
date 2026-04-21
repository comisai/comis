// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRpcClient, type RpcClient } from "./rpc-client.js";

// -- Mock WebSocket --

class MockWebSocket {
  url: string;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  readyState = 1;
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    MockWebSocket.lastInstance = this;
  }
  static lastInstance: MockWebSocket | null = null;
  static instances: MockWebSocket[] = [];
}
vi.stubGlobal("WebSocket", MockWebSocket);

// -- Tests --

const WS_URL = "ws://localhost:3000/ws";
const TOKEN = "test-token-123";

describe("createRpcClient", () => {
  let client: RpcClient;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.lastInstance = null;
    MockWebSocket.instances = [];
    client = createRpcClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  // -- Factory and interface --

  it("returns object with connect, disconnect, call, onStatusChange, onNotification, status", () => {
    expect(typeof client.connect).toBe("function");
    expect(typeof client.disconnect).toBe("function");
    expect(typeof client.call).toBe("function");
    expect(typeof client.onStatusChange).toBe("function");
    expect(typeof client.onNotification).toBe("function");
    expect(client.status).toBeDefined();
  });

  // -- Connection --

  it("creates WebSocket with correct URL format", () => {
    client.connect(WS_URL, TOKEN);
    expect(MockWebSocket.lastInstance).not.toBeNull();
    expect(MockWebSocket.lastInstance!.url).toBe(
      `${WS_URL}?token=${encodeURIComponent(TOKEN)}`,
    );
  });

  it("status starts as disconnected", () => {
    expect(client.status).toBe("disconnected");
  });

  it("status becomes connected on WebSocket open", () => {
    client.connect(WS_URL, TOKEN);
    MockWebSocket.lastInstance!.onopen!();
    expect(client.status).toBe("connected");
  });

  // -- Status change handlers --

  it("onStatusChange fires handler on status transitions", () => {
    const handler = vi.fn();
    client.onStatusChange(handler);

    client.connect(WS_URL, TOKEN);
    MockWebSocket.lastInstance!.onopen!();

    expect(handler).toHaveBeenCalledWith("connected");
  });

  it("onStatusChange returns unsubscribe function", () => {
    const handler = vi.fn();
    const unsubscribe = client.onStatusChange(handler);

    unsubscribe();
    client.connect(WS_URL, TOKEN);
    MockWebSocket.lastInstance!.onopen!();

    expect(handler).not.toHaveBeenCalled();
  });

  // -- JSON-RPC calls --

  it("call sends JSON-RPC 2.0 formatted message with auto-incrementing id", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    // Catch rejections from disconnect in afterEach
    client.call("system.health").catch(() => {});
    client.call("agents.list").catch(() => {});

    expect(ws.send).toHaveBeenCalledTimes(2);
    const msg1 = JSON.parse(ws.send.mock.calls[0][0] as string);
    const msg2 = JSON.parse(ws.send.mock.calls[1][0] as string);

    expect(msg1.jsonrpc).toBe("2.0");
    expect(msg1.method).toBe("system.health");
    expect(msg1.id).toBe(1);

    expect(msg2.id).toBe(2);
    expect(msg2.method).toBe("agents.list");
  });

  it("call resolves with result from matching response", async () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    const promise = client.call<{ uptime: number }>("system.health");

    // Extract the id from the sent message
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);

    // Simulate server response
    ws.onmessage!({
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: sent.id,
        result: { uptime: 12345 },
      }),
    } as MessageEvent);

    const result = await promise;
    expect(result).toEqual({ uptime: 12345 });
  });

  it("call rejects when error response received", async () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    const promise = client.call("invalid.method");
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);

    ws.onmessage!({
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: sent.id,
        error: { code: -32601, message: "Method not found" },
      }),
    } as MessageEvent);

    await expect(promise).rejects.toThrow("RPC error (-32601): Method not found");
  });

  it("call rejects on 30-second timeout", async () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    const promise = client.call("slow.method");

    // The first send is our call. Heartbeat may also fire at 30s.
    expect(ws.send).toHaveBeenCalledTimes(1);

    // Advance past the 30s timeout
    vi.advanceTimersByTime(30_001);

    await expect(promise).rejects.toThrow("RPC request timed out");
  });

  it("call rejects when not connected", async () => {
    await expect(client.call("some.method")).rejects.toThrow("Not connected");
  });

  it("call includes params when provided", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    client.call("agent.get", { id: "agent-1" }).catch(() => {});

    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.params).toEqual({ id: "agent-1" });
  });

  it("call omits params when not provided", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    client.call("system.health").catch(() => {});

    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.params).toBeUndefined();
  });

  // -- Reconnect --

  it("status changes to reconnecting on WebSocket close", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();
    ws.onclose!({ code: 1006, reason: "" });

    expect(client.status).toBe("reconnecting");
  });

  it("exponential backoff: 1s, 2s, 4s delays between reconnect attempts", () => {
    client.connect(WS_URL, TOKEN);
    const ws1 = MockWebSocket.lastInstance!;
    ws1.onopen!();
    ws1.onclose!({ code: 1006, reason: "" });

    // After 1s, should attempt first reconnect
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second reconnect: close immediately, wait 2s
    MockWebSocket.lastInstance!.onclose!({ code: 1006, reason: "" });
    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // Third reconnect: close immediately, wait 4s
    MockWebSocket.lastInstance!.onclose!({ code: 1006, reason: "" });
    vi.advanceTimersByTime(3999);
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it("backoff caps at 30 seconds", () => {
    client.connect(WS_URL, TOKEN);
    MockWebSocket.lastInstance!.onopen!();

    // Trigger enough reconnects to exceed 30s cap
    // Delays: 1s, 2s, 4s, 8s, 16s, 32s->30s, ...
    for (let i = 0; i < 5; i++) {
      MockWebSocket.lastInstance!.onclose!({ code: 1006, reason: "" });
      vi.advanceTimersByTime(Math.min(1000 * Math.pow(2, i), 30000));
    }

    // At attempt 5, delay should be min(32000, 30000) = 30000
    const instancesBefore = MockWebSocket.instances.length;
    MockWebSocket.lastInstance!.onclose!({ code: 1006, reason: "" });
    vi.advanceTimersByTime(29999);
    expect(MockWebSocket.instances).toHaveLength(instancesBefore);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(instancesBefore + 1);
  });

  it("max 10 retries then status becomes disconnected", () => {
    const handler = vi.fn();
    client.onStatusChange(handler);

    client.connect(WS_URL, TOKEN);
    MockWebSocket.lastInstance!.onopen!();

    // Trigger 10 reconnect attempts
    for (let i = 0; i < 10; i++) {
      MockWebSocket.lastInstance!.onclose!({ code: 1006, reason: "" });
      vi.advanceTimersByTime(Math.min(1000 * Math.pow(2, i), 30000));
    }

    // 11th close should exhaust retries
    MockWebSocket.lastInstance!.onclose!({ code: 1006, reason: "" });

    expect(client.status).toBe("disconnected");
  });

  it("successful reconnect resets attempt counter", () => {
    client.connect(WS_URL, TOKEN);
    MockWebSocket.lastInstance!.onopen!();

    // Fail 3 times
    for (let i = 0; i < 3; i++) {
      MockWebSocket.lastInstance!.onclose!({ code: 1006, reason: "" });
      vi.advanceTimersByTime(Math.min(1000 * Math.pow(2, i), 30000));
    }

    // Now succeed
    MockWebSocket.lastInstance!.onopen!();
    expect(client.status).toBe("connected");

    // Fail again -- should start from attempt 0 (1s delay)
    const instancesBefore = MockWebSocket.instances.length;
    MockWebSocket.lastInstance!.onclose!({ code: 1006, reason: "" });
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(instancesBefore);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(instancesBefore + 1);
  });

  // -- Heartbeat --

  it("heartbeat sends system.ping every 30 seconds", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    // No ping yet
    expect(ws.send).not.toHaveBeenCalled();

    // After 30s, first ping
    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledTimes(1);

    const pingMsg = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(pingMsg.method).toBe("system.ping");
    expect(pingMsg.jsonrpc).toBe("2.0");
    expect(pingMsg.id).toBeDefined();
  });

  it("heartbeat reject handler clears timeout (error response still proves connection alive)", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    // Trigger heartbeat ping
    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledTimes(1);

    const pingMsg = JSON.parse(ws.send.mock.calls[0][0] as string);
    const pingId = pingMsg.id;

    // Simulate an error response (e.g., Method not found) - still proves connection alive
    ws.onmessage!({
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: pingId,
        error: { code: -32601, message: "Method not found" },
      }),
    } as MessageEvent);

    // Advance past the 10s heartbeat timeout - connection should NOT be closed
    vi.advanceTimersByTime(10_000);
    expect(ws.close).not.toHaveBeenCalled();
    expect(client.status).toBe("connected");
  });

  // -- Disconnect --

  it("disconnect sets status to disconnected and closes WebSocket", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    client.disconnect();

    expect(client.status).toBe("disconnected");
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("disconnect rejects all pending calls", async () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    const promise1 = client.call("method1");
    const promise2 = client.call("method2");

    client.disconnect();

    await expect(promise1).rejects.toThrow("Client disconnected");
    await expect(promise2).rejects.toThrow("Client disconnected");
  });

  it("disconnect clears reconnect timer", () => {
    client.connect(WS_URL, TOKEN);
    MockWebSocket.lastInstance!.onopen!();
    MockWebSocket.lastInstance!.onclose!({ code: 1006, reason: "" });

    expect(client.status).toBe("reconnecting");

    const instancesBefore = MockWebSocket.instances.length;
    client.disconnect();

    // Advance time well past backoff delay -- no new connection should be created
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(instancesBefore);
    expect(client.status).toBe("disconnected");
  });

  // -- Edge cases --

  it("ignores server heartbeat notifications (no id)", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    // Should not throw
    ws.onmessage!({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "heartbeat",
        params: { ts: Date.now() },
      }),
    } as MessageEvent);
  });

  it("ignores unparseable messages", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    // Should not throw
    ws.onmessage!({ data: "not valid json" } as MessageEvent);
  });

  // -- Notification handler --

  it("onNotification fires handler for server-pushed notifications", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    const handler = vi.fn();
    client.onNotification(handler);

    ws.onmessage!({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "notification.message",
        params: { text: "hello", timestamp: 123 },
      }),
    } as MessageEvent);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("notification.message", {
      text: "hello",
      timestamp: 123,
    });
  });

  it("onNotification does not fire for heartbeat notifications", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    const handler = vi.fn();
    client.onNotification(handler);

    ws.onmessage!({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "heartbeat",
        params: { ts: 123 },
      }),
    } as MessageEvent);

    expect(handler).not.toHaveBeenCalled();
  });

  it("onNotification does not fire for request-response messages", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    const handler = vi.fn();
    client.onNotification(handler);

    ws.onmessage!({
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true },
      }),
    } as MessageEvent);

    expect(handler).not.toHaveBeenCalled();
  });

  it("onNotification returns unsubscribe function", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    const handler = vi.fn();
    const unsub = client.onNotification(handler);
    unsub();

    ws.onmessage!({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "notification.message",
        params: { text: "hello" },
      }),
    } as MessageEvent);

    expect(handler).not.toHaveBeenCalled();
  });

  it("onNotification handler errors do not crash message processing", () => {
    client.connect(WS_URL, TOKEN);
    const ws = MockWebSocket.lastInstance!;
    ws.onopen!();

    const badHandler = vi.fn().mockImplementation(() => { throw new Error("boom"); });
    const goodHandler = vi.fn();
    client.onNotification(badHandler);
    client.onNotification(goodHandler);

    ws.onmessage!({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "notification.message",
        params: { text: "test" },
      }),
    } as MessageEvent);

    expect(badHandler).toHaveBeenCalledOnce();
    expect(goodHandler).toHaveBeenCalledOnce();
  });
});
