// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted for shared mock variables)
// ---------------------------------------------------------------------------

const mockStdin = vi.hoisted(() => ({
  write: vi.fn(),
  end: vi.fn(),
}));

const mockStdout = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    _listeners: listeners,
  };
});

const mockStderr = vi.hoisted(() => ({
  on: vi.fn(),
}));

const mockProc = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    stdin: mockStdin,
    stdout: mockStdout,
    stderr: mockStderr,
    killed: false,
    kill: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    _listeners: listeners,
    _emit(event: string, ...args: unknown[]) {
      const handlers = listeners.get(event) ?? [];
      for (const h of handlers) h(...args);
    },
  };
});

const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockCreateInterface = vi.fn();

vi.mock("node:readline", () => ({
  createInterface: (...args: unknown[]) => mockCreateInterface(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createImsgClient } from "./imessage-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

let readerLineHandler: ((line: string) => void) | undefined;

function setupSpawnSuccess() {
  // Reset listeners
  mockProc._listeners.clear();
  mockStdout._listeners.clear();
  mockProc.killed = false;
  mockProc.kill.mockClear();
  mockStdin.write.mockClear();
  mockStdin.end.mockClear();

  mockSpawn.mockReturnValue(mockProc);

  const mockReader = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "line") {
        readerLineHandler = handler as (line: string) => void;
      }
    }),
    close: vi.fn(),
  };
  mockCreateInterface.mockReturnValue(mockReader);

  return mockReader;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createImsgClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    readerLineHandler = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -- start() --

  describe("start()", () => {
    it("spawns imsg rpc process and returns ok", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });

      const result = await client.start();

      expect(result.ok).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith("imsg", ["rpc"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    });

    it("uses custom binaryPath", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({
        binaryPath: "/usr/local/bin/imsg",
        logger: makeLogger(),
      });

      await client.start();

      expect(mockSpawn).toHaveBeenCalledWith("/usr/local/bin/imsg", ["rpc"], expect.any(Object));
    });

    it("returns ok immediately on second call (already started)", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });

      await client.start();
      const result = await client.start();

      expect(result.ok).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("returns err when spawn throws", async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const client = createImsgClient({ logger: makeLogger() });

      const result = await client.start();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to spawn imsg rpc");
        expect(result.error.message).toContain("ENOENT");
      }
    });
  });

  // -- request() --

  describe("request()", () => {
    it("returns err when not started", async () => {
      const client = createImsgClient({ logger: makeLogger() });

      const result = await client.request("sendMessage", { to: "+1" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("imsg rpc not running");
      }
    });

    it("sends JSON-RPC 2.0 request and resolves with result", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      const requestPromise = client.request("sendMessage", { to: "+1234567890" });

      // Verify stdin was written
      expect(mockStdin.write).toHaveBeenCalledTimes(1);
      const written = mockStdin.write.mock.calls[0]![0] as string;
      const payload = JSON.parse(written.trim());
      expect(payload).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "sendMessage",
        params: { to: "+1234567890" },
      });

      // Simulate response
      readerLineHandler!(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sent: true } }));

      const result = await requestPromise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ sent: true });
      }
    });

    it("returns err for RPC error response", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      const requestPromise = client.request("getChats");

      readerLineHandler!(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Invalid Request" } }),
      );

      const result = await requestPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Invalid Request");
      }
    });

    it("returns err on timeout", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      const requestPromise = client.request("slowMethod");

      // Advance past 10s timeout
      await vi.advanceTimersByTimeAsync(10_001);

      const result = await requestPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("imsg rpc timeout");
        expect(result.error.message).toContain("slowMethod");
      }
    });

    it("uses empty object as default params", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      client.request("listChats");

      const written = mockStdin.write.mock.calls[0]![0] as string;
      const payload = JSON.parse(written.trim());
      expect(payload.params).toEqual({});
    });

    it("increments request ids", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      client.request("method1");
      client.request("method2");

      const call1 = JSON.parse((mockStdin.write.mock.calls[0]![0] as string).trim());
      const call2 = JSON.parse((mockStdin.write.mock.calls[1]![0] as string).trim());
      expect(call1.id).toBe(1);
      expect(call2.id).toBe(2);
    });
  });

  // -- onNotification() --

  describe("onNotification()", () => {
    it("dispatches notifications (lines without id, with method)", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      const handler = vi.fn();
      client.onNotification(handler);

      readerLineHandler!(
        JSON.stringify({ method: "messageReceived", params: { text: "hello" } }),
      );

      expect(handler).toHaveBeenCalledWith({
        method: "messageReceived",
        params: { text: "hello" },
      });
    });

    it("dispatches to multiple handlers", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      client.onNotification(handler1);
      client.onNotification(handler2);

      readerLineHandler!(JSON.stringify({ method: "event", params: {} }));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("catches handler errors without crashing", async () => {
      const logger = makeLogger();
      setupSpawnSuccess();
      const client = createImsgClient({ logger });
      await client.start();

      const badHandler = vi.fn(() => {
        throw new Error("handler boom");
      });
      const goodHandler = vi.fn();
      client.onNotification(badHandler);
      client.onNotification(goodHandler);

      readerLineHandler!(JSON.stringify({ method: "event" }));

      expect(badHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // -- close() --

  describe("close()", () => {
    it("returns ok when not started", async () => {
      const client = createImsgClient({ logger: makeLogger() });

      const result = await client.close();

      expect(result.ok).toBe(true);
    });

    it("closes reader, ends stdin, and sends SIGTERM", async () => {
      const mockReader = setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      // Start closing - it will set up timeouts, we need to simulate proc close
      const closePromise = client.close();

      // Simulate the process closing
      mockProc._emit("close", 0, null);

      const result = await closePromise;
      expect(result.ok).toBe(true);
      expect(mockReader.close).toHaveBeenCalled();
      expect(mockStdin.end).toHaveBeenCalled();
    });
  });

  // -- process error event --

  describe("process events", () => {
    it("rejects pending requests on process error", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      const requestPromise = client.request("test");

      // Emit error on process
      mockProc._emit("error", new Error("process crashed"));

      const result = await requestPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("process crashed");
      }
    });

    it("rejects pending requests on process close", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      const requestPromise = client.request("test");

      // Emit close on process
      mockProc._emit("close", 1, null);

      const result = await requestPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("imsg rpc exited");
      }
    });

    it("ignores empty/whitespace lines from stdout", async () => {
      setupSpawnSuccess();
      const client = createImsgClient({ logger: makeLogger() });
      await client.start();

      const handler = vi.fn();
      client.onNotification(handler);

      // Should not crash or dispatch
      readerLineHandler!("");
      readerLineHandler!("   ");

      expect(handler).not.toHaveBeenCalled();
    });

    it("handles unparseable JSON lines gracefully", async () => {
      const logger = makeLogger();
      setupSpawnSuccess();
      const client = createImsgClient({ logger });
      await client.start();

      readerLineHandler!("not json {{{");

      expect(logger.debug).toHaveBeenCalled();
    });
  });
});
