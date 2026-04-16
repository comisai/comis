/**
 * Tests for createRpcClient WebSocket JSON-RPC 2.0 transport and
 * withClient config resolution / lifecycle management.
 *
 * Covers: successful request/response, connection refused,
 * connection timeout, JSON-RPC error responses,
 * unexpected close, malformed messages,
 * config file resolution, config missing fallback,
 * env var precedence, bearer token authentication,
 * TLS URL construction, and cleartext transport warning.
 */

import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Mock WebSocket class that simulates ws behavior for testing.
 * Extends EventEmitter to support on/emit event patterns.
 */
class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];

  url: string;
  options: { headers?: Record<string, string> };
  sentMessages: string[] = [];
  terminated = false;

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    this.options = options ?? {};
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  closed = false;
  connected = false;

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.terminated = true;
  }
}

vi.mock("ws", () => ({ default: MockWebSocket }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock("node:os", () => ({ default: { homedir: vi.fn(() => "/fake/home") } }));

function getLastWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

// Dynamic import after mock is registered
const { createRpcClient, withClient, checkTransportSecurity, InsecureTransportError } = await import("./rpc-client.js");

/**
 * Schedule the mock WebSocket 'open' event to fire once the WebSocket is constructed.
 * withClient internally calls createRpcClient which awaits 'open', so this must be
 * started before calling withClient.
 */
function connectLastWsAsync(): void {
  const interval = setInterval(() => {
    const ws = getLastWs();
    if (ws && !ws.connected) {
      ws.connected = true;
      ws.emit("open");
      clearInterval(interval);
    }
  }, 1);
}

describe("createRpcClient", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  describe("successful request/response", () => {
    it("sends JSON-RPC 2.0 request with correct format", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const callPromise = client.call("test.method", { key: "value" });

      const sent = JSON.parse(ws.sentMessages[0]!);
      expect(sent).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "test.method",
        params: { key: "value" },
      });

      ws.emit(
        "message",
        Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" })),
      );

      const result = await callPromise;
      expect(result).toBe("ok");
    });

    it("assigns incrementing message IDs", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const call1 = client.call("method1");
      const call2 = client.call("method2");
      const call3 = client.call("method3");

      const ids = ws.sentMessages.map(
        (m) => (JSON.parse(m) as { id: number }).id,
      );
      expect(ids).toEqual([1, 2, 3]);

      ws.emit(
        "message",
        Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "r1" })),
      );
      ws.emit(
        "message",
        Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "r2" })),
      );
      ws.emit(
        "message",
        Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 3, result: "r3" })),
      );

      const results = await Promise.all([call1, call2, call3]);
      expect(results).toEqual(["r1", "r2", "r3"]);
    });

    it("resolves correct response when multiple calls are pending", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const callA = client.call("a");
      const callB = client.call("b");

      // Respond out of order: ID 2 first, then ID 1
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 2, result: "response-b" }),
        ),
      );
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "response-a" }),
        ),
      );

      expect(await callA).toBe("response-a");
      expect(await callB).toBe("response-b");
    });
  });

  describe("JSON-RPC error responses", () => {
    it("rejects with error message from JSON-RPC error response", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const callPromise = client.call("bad.method");

      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "Invalid Request" },
          }),
        ),
      );

      await expect(callPromise).rejects.toThrow("Invalid Request");
    });

    it("handles error response with data field", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const callPromise = client.call("error.with.data");

      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32602,
              message: "Invalid params",
              data: { field: "name", reason: "required" },
            },
          }),
        ),
      );

      await expect(callPromise).rejects.toThrow("Invalid params");
    });
  });

  describe("bearer token authentication", () => {
    it("sends Bearer token in authorization header when token is provided", async () => {
      const clientPromise = createRpcClient(
        "ws://localhost:3100/ws",
        "my-secret-token",
      );
      const ws = getLastWs();

      expect(ws.options.headers).toBeDefined();
      expect(ws.options.headers!["authorization"]).toBe(
        "Bearer my-secret-token",
      );

      // Clean up: connect and close
      ws.emit("open");
      const client = await clientPromise;
      client.close();
    });

    it("omits authorization header when no token is provided", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();

      expect(ws.options.headers).toBeDefined();
      expect(ws.options.headers!["authorization"]).toBeUndefined();

      // Clean up: connect and close
      ws.emit("open");
      const client = await clientPromise;
      client.close();
    });
  });

  describe("connection refused", () => {
    it("rejects with daemon-not-running message on ECONNREFUSED", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();

      const err = Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
      ws.emit("error", err);

      await expect(clientPromise).rejects.toThrow(
        "Cannot connect to daemon",
      );
    });

    it("rejects with original error for non-ECONNREFUSED errors", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();

      ws.emit("error", new Error("socket hung up"));

      await expect(clientPromise).rejects.toThrow("socket hung up");
    });
  });

  describe("connection timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects after timeout period when connection is not established", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");

      vi.advanceTimersByTime(2000);

      await expect(clientPromise).rejects.toThrow(
        "Connection to daemon timed out after 2000ms",
      );
    });

    it("calls terminate on WebSocket when timeout fires", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();

      expect(ws.terminated).toBe(false);

      vi.advanceTimersByTime(2000);

      // Allow microtask queue to flush
      await clientPromise.catch(() => {
        // expected rejection
      });

      expect(ws.terminated).toBe(true);
    });
  });

  describe("unexpected WebSocket close", () => {
    it("rejects all pending requests when WebSocket closes unexpectedly", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const call1 = client.call("method1");
      const call2 = client.call("method2");

      ws.emit("close");

      await expect(call1).rejects.toThrow("Connection closed unexpectedly");
      await expect(call2).rejects.toThrow("Connection closed unexpectedly");
    });

    it("does not affect already-resolved requests", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const callPromise = client.call("resolved.method");

      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "success" }),
        ),
      );

      const result = await callPromise;
      expect(result).toBe("success");

      // Close after resolution -- should not cause double-rejection
      ws.emit("close");

      // The resolved value is still correct
      expect(result).toBe("success");
    });
  });

  describe("notification handling", () => {
    it("invokes onNotification handler when server sends a notification", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const handler = vi.fn();
      client.onNotification(handler);

      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notification.message",
            params: { text: "hello", timestamp: 123 },
          }),
        ),
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith("notification.message", {
        text: "hello",
        timestamp: 123,
      });
    });

    it("ignores heartbeat notifications", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const handler = vi.fn();
      client.onNotification(handler);

      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "heartbeat",
            params: { ts: 123 },
          }),
        ),
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it("does not affect pending request resolution", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const handler = vi.fn();
      client.onNotification(handler);

      const callPromise = client.call("test.method");

      // Emit notification first
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notification.message",
            params: { text: "hi" },
          }),
        ),
      );

      // Then emit response for pending call
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }),
        ),
      );

      expect(handler).toHaveBeenCalledWith("notification.message", {
        text: "hi",
      });
      const result = await callPromise;
      expect(result).toBe("ok");
    });

    it("supports multiple notification handlers", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      client.onNotification(handler1);
      client.onNotification(handler2);

      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notification.message",
            params: { text: "broadcast" },
          }),
        ),
      );

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it("notification handler error does not crash client", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      client.onNotification(() => {
        throw new Error("handler boom");
      });

      // Emit notification (handler throws)
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notification.message",
            params: { text: "crash" },
          }),
        ),
      );

      // Client should still work -- send a call and resolve it
      const callPromise = client.call("after.crash");
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "still-alive" }),
        ),
      );

      const result = await callPromise;
      expect(result).toBe("still-alive");
    });
  });

  describe("malformed messages", () => {
    it("ignores non-JSON messages without crashing", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const callPromise = client.call("some.method");

      // Send invalid JSON -- should be silently ignored
      ws.emit("message", Buffer.from("not valid json"));

      // Call should still be pending, so send the real response
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "recovered" }),
        ),
      );

      const result = await callPromise;
      expect(result).toBe("recovered");
    });

    it("ignores messages without id field", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const callPromise = client.call("id.test");

      // Message without id field -- should be ignored
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", result: "no-id" }),
        ),
      );

      // Send correct response
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "correct" }),
        ),
      );

      const result = await callPromise;
      expect(result).toBe("correct");
    });

    it("ignores messages with unknown id", async () => {
      const clientPromise = createRpcClient("ws://localhost:3100/ws");
      const ws = getLastWs();
      ws.emit("open");
      const client = await clientPromise;

      const callPromise = client.call("unknown.id.test");

      // Message with non-matching id -- should be ignored
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 999, result: "wrong-id" }),
        ),
      );

      // Send correct response
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "right-id" }),
        ),
      );

      const result = await callPromise;
      expect(result).toBe("right-id");
    });
  });
});

describe("withClient", () => {
  const mockedExistsSync = vi.mocked(existsSync);
  const mockedReadFileSync = vi.mocked(readFileSync);

  beforeEach(() => {
    MockWebSocket.instances = [];
    delete process.env["COMIS_GATEWAY_URL"];
    delete process.env["COMIS_GATEWAY_TOKEN"];
    delete process.env["COMIS_INSECURE"];
    mockedExistsSync.mockReset();
    mockedReadFileSync.mockReset();
  });

  afterEach(() => {
    delete process.env["COMIS_GATEWAY_URL"];
    delete process.env["COMIS_GATEWAY_TOKEN"];
    delete process.env["COMIS_INSECURE"];
  });

  describe("config file resolution", () => {
    it("resolves gateway URL from config.yaml host and port", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        "gateway:\n  host: custom-host\n  port: 4200\n",
      );

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.url).toBe("ws://custom-host:4200/ws");
    });

    it("extracts bearer token from config.yaml gateway tokens", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        [
          "gateway:",
          "  host: localhost",
          "  port: 3100",
          "  tokens:",
          "    - name: cli-token",
          "      secret: config-secret-abc",
        ].join("\n"),
      );

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.options.headers!["authorization"]).toBe(
        "Bearer config-secret-abc",
      );
    });

    it("handles config file with only host (uses default port)", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue("gateway:\n  host: myhost\n");

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.url).toBe("ws://myhost:4766/ws");
    });
  });

  describe("config file missing fallback", () => {
    it("falls back to localhost:4766 when config file does not exist", async () => {
      mockedExistsSync.mockReturnValue(false);

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.url).toBe("ws://localhost:4766/ws");
    });

    it("falls back to localhost:4766 when config file read throws", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.url).toBe("ws://localhost:4766/ws");
    });
  });

  describe("environment variable precedence", () => {
    it("COMIS_GATEWAY_URL overrides config file URL", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        "gateway:\n  host: config-host\n  port: 4200\n",
      );
      process.env["COMIS_GATEWAY_URL"] = "ws://env-host:5000/ws";

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.url).toBe("ws://env-host:5000/ws");
    });

    it("COMIS_GATEWAY_TOKEN overrides config file token", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        [
          "gateway:",
          "  host: localhost",
          "  port: 3100",
          "  tokens:",
          "    - name: cli-token",
          "      secret: config-token",
        ].join("\n"),
      );
      process.env["COMIS_GATEWAY_TOKEN"] = "env-token-override";

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.options.headers!["authorization"]).toBe(
        "Bearer env-token-override",
      );
    });

    it("env URL overrides config URL while config token still used when no env token", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        [
          "gateway:",
          "  host: config-host",
          "  port: 4200",
          "  tokens:",
          "    - name: cli-token",
          "      secret: config-token",
        ].join("\n"),
      );
      process.env["COMIS_GATEWAY_URL"] = "ws://env-host:5000/ws";
      // COMIS_GATEWAY_TOKEN deliberately not set
      // Allow insecure transport for this test (testing URL override, not transport security)
      process.env["COMIS_INSECURE"] = "1";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.url).toBe("ws://env-host:5000/ws");
      expect(ws.options.headers!["authorization"]).toBe(
        "Bearer config-token",
      );

      warnSpy.mockRestore();
    });

    it("uses defaults when neither env vars nor config file exist", async () => {
      mockedExistsSync.mockReturnValue(false);
      // No env vars set (deleted in beforeEach)

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.url).toBe("ws://localhost:4766/ws");
      expect(ws.options.headers!["authorization"]).toBeUndefined();
    });
  });

  describe("client lifecycle", () => {
    it("closes client after callback completes", async () => {
      mockedExistsSync.mockReturnValue(false);

      connectLastWsAsync();
      await withClient(async () => "result");

      const ws = getLastWs();
      expect(ws.closed).toBe(true);
    });

    it("closes client even when callback throws", async () => {
      mockedExistsSync.mockReturnValue(false);

      connectLastWsAsync();
      await withClient(async () => {
        throw new Error("callback failed");
      }).catch(() => {
        // Expected rejection
      });

      const ws = getLastWs();
      expect(ws.closed).toBe(true);
    });

    it("returns callback result", async () => {
      mockedExistsSync.mockReturnValue(false);

      connectLastWsAsync();
      const result = await withClient(async () => 42);

      expect(result).toBe(42);
    });
  });

  describe("TLS URL construction", () => {
    it("produces wss:// URL when TLS cert is configured in gateway", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        [
          "gateway:",
          "  host: secure-host",
          "  port: 4766",
          "  tls:",
          "    cert: /etc/comis/cert.pem",
          "    key: /etc/comis/key.pem",
        ].join("\n"),
      );

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.url).toBe("wss://secure-host:4766/ws");
    });

    it("produces wss:// URL when TLS enabled: true is set", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        [
          "gateway:",
          "  host: tls-host",
          "  port: 9443",
          "  tls:",
          "    enabled: true",
        ].join("\n"),
      );

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.url).toBe("wss://tls-host:9443/ws");
    });

    it("produces ws:// URL when no TLS section exists", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        "gateway:\n  host: plain-host\n  port: 8080\n",
      );

      connectLastWsAsync();
      await withClient(async () => "done");

      const ws = getLastWs();
      expect(ws.url).toBe("ws://plain-host:8080/ws");
    });
  });

  describe("cleartext transport hard-fail", () => {
    afterEach(() => {
      delete process.env["COMIS_INSECURE"];
    });

    it("throws InsecureTransportError when sending token over ws:// to non-localhost host", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        [
          "gateway:",
          "  host: remote-host",
          "  port: 4766",
          "  tokens:",
          "    - name: cli-token",
          "      secret: my-token",
        ].join("\n"),
      );

      await expect(withClient(async () => "done")).rejects.toThrow(InsecureTransportError);
    });

    it("proceeds with warning when COMIS_INSECURE=1 is set", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env["COMIS_INSECURE"] = "1";

      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        [
          "gateway:",
          "  host: remote-host",
          "  port: 4766",
          "  tokens:",
          "    - name: cli-token",
          "      secret: my-token",
        ].join("\n"),
      );

      connectLastWsAsync();
      const result = await withClient(async () => "done");

      expect(result).toBe("done");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("unencrypted WebSocket"),
      );

      warnSpy.mockRestore();
    });

    it("does not throw for ws:// to localhost", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        [
          "gateway:",
          "  host: localhost",
          "  port: 4766",
          "  tokens:",
          "    - name: cli-token",
          "      secret: my-token",
        ].join("\n"),
      );

      connectLastWsAsync();
      const result = await withClient(async () => "done");

      expect(result).toBe("done");
    });

    it("does not throw for wss:// connections", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        [
          "gateway:",
          "  host: remote-host",
          "  port: 4766",
          "  tls:",
          "    cert: /etc/comis/cert.pem",
          "  tokens:",
          "    - name: cli-token",
          "      secret: my-token",
        ].join("\n"),
      );

      connectLastWsAsync();
      const result = await withClient(async () => "done");

      expect(result).toBe("done");
    });
  });
});

describe("checkTransportSecurity", () => {
  it("throws InsecureTransportError when token sent over ws:// to non-localhost", () => {
    expect(() => {
      checkTransportSecurity("ws://remote-host:4766/ws", "my-token");
    }).toThrow(InsecureTransportError);
  });

  it("throws with descriptive message including host", () => {
    expect(() => {
      checkTransportSecurity("ws://remote-host:4766/ws", "my-token");
    }).toThrow("remote-host");
  });

  it("warns but does not throw when allowInsecure=true", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => {
      checkTransportSecurity("ws://remote-host:4766/ws", "my-token", true);
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unencrypted WebSocket"),
    );

    warnSpy.mockRestore();
  });

  it("does not throw for ws://localhost", () => {
    expect(() => {
      checkTransportSecurity("ws://localhost:4766/ws", "my-token");
    }).not.toThrow();
  });

  it("does not throw for ws://127.0.0.1", () => {
    expect(() => {
      checkTransportSecurity("ws://127.0.0.1:4766/ws", "my-token");
    }).not.toThrow();
  });

  it("does not throw for wss:// URLs", () => {
    expect(() => {
      checkTransportSecurity("wss://remote-host:4766/ws", "my-token");
    }).not.toThrow();
  });

  it("does not throw when no token is provided", () => {
    expect(() => {
      checkTransportSecurity("ws://remote-host:4766/ws", undefined);
    }).not.toThrow();
  });
});
