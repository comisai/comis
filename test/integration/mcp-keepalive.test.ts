// SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for the per-server keepalive ticker.
 *
 * Exercises the @comis/skills barrel (via dist/) end-to-end:
 *   - createMcpClientManager wires the ticker on connect
 *   - startKeepaliveTicker schedules Client.ping() every keepaliveIntervalMs
 *   - maybeEnqueueKeepalivePing skips when the per-server PQueue is busy
 *   - Ping failure routes through handleDisconnection(..., "keepalive_failed")
 *     and emits "mcp:server:disconnected" with that reason union literal
 *
 * Harness mirrors packages/skills/src/skills/integrations/mcp-client.test.ts
 * (SDK Client mock + fake timers). Critical bridge: vi.mock uses the ABSOLUTE
 * resolved path of the SDK module (the path the dist code actually loads).
 * Vitest 4 does not bridge specifier-based mocks across module graphs when
 * the consumer is compiled dist .js code; mocking the resolved absolute path
 * is the working pattern.
 *
 * Per CLAUDE.md: integration tests import from `dist/`; requires `pnpm build`
 * before vitest runs. The vitest workspace alias `@comis/skills` resolves to
 * `packages/skills/dist/skills/index.js`.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// SDK module path resolution — see file docblock for the cross-module-graph
// rationale. createRequire is rooted at a dist .js file so pnpm's symlink
// chain is followed the same way the dist code's own imports are resolved.
// require.resolve returns the CJS variant; we swap to ESM since the dist
// code (and Node, when --conditions=import is active) loads the ESM build.
// ---------------------------------------------------------------------------

const sdkPaths = vi.hoisted(() => {
  const Module = require("node:module") as typeof import("node:module");
  const path = require("node:path") as typeof import("node:path");
  const testDir = path.dirname(import.meta.url.replace("file://", ""));
  const worktreeRoot = path.resolve(testDir, "..", "..");
  const skillsDistFile = path.resolve(
    worktreeRoot,
    "packages",
    "skills",
    "dist",
    "skills",
    "integrations",
    "mcp-client",
    "mcp-client-discover.js",
  );
  const req = Module.createRequire(skillsDistFile);
  const toEsm = (p: string) => p.replace("/dist/cjs/", "/dist/esm/");
  return {
    clientIndex: toEsm(req.resolve("@modelcontextprotocol/sdk/client/index.js")),
    stdio: toEsm(req.resolve("@modelcontextprotocol/sdk/client/stdio.js")),
    sse: toEsm(req.resolve("@modelcontextprotocol/sdk/client/sse.js")),
    streamableHttp: toEsm(req.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")),
  };
});

// ---------------------------------------------------------------------------
// SDK Client mock — vi.hoisted ensures the closure variables are initialised
// before the (also-hoisted) vi.mock factories execute.
// ---------------------------------------------------------------------------

const sdkMocks = vi.hoisted(() => {
  interface MockedClientInstance {
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    getInstructions: ReturnType<typeof vi.fn>;
    getServerCapabilities: ReturnType<typeof vi.fn>;
    getServerVersion: ReturnType<typeof vi.fn>;
  }
  return {
    mockPing: vi.fn(),
    mockCallTool: vi.fn(),
    mockConnect: vi.fn(),
    mockClose: vi.fn(),
    mockListTools: vi.fn(),
    clientInstances: [] as MockedClientInstance[],
  };
});

vi.mock(sdkPaths.clientIndex, () => ({
  Client: vi.fn().mockImplementation(function () {
    const instance = {
      connect: sdkMocks.mockConnect,
      close: sdkMocks.mockClose,
      listTools: sdkMocks.mockListTools,
      callTool: sdkMocks.mockCallTool,
      ping: sdkMocks.mockPing,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
      getInstructions: vi.fn().mockReturnValue(undefined),
      getServerCapabilities: vi.fn().mockReturnValue({}),
      getServerVersion: vi.fn().mockReturnValue({ name: "test", version: "1.0" }),
    };
    sdkMocks.clientInstances.push(instance);
    return instance;
  }),
}));

vi.mock(sdkPaths.stdio, () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return { type: "stdio" };
  }),
}));

vi.mock(sdkPaths.sse, () => ({
  SSEClientTransport: vi.fn().mockImplementation(function () {
    return { type: "sse" };
  }),
}));

vi.mock(sdkPaths.streamableHttp, () => {
  class _StreamableHTTPError extends Error {
    code: number | undefined;
    constructor(code: number | undefined, message: string | undefined) {
      super(message);
      this.code = code;
      this.name = "StreamableHTTPError";
    }
  }
  return {
    StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
      return { type: "http" };
    }),
    StreamableHTTPError: _StreamableHTTPError,
  };
});

import { createMcpClientManager } from "@comis/skills";

const { mockPing, mockCallTool, mockConnect, mockClose, mockListTools, clientInstances } = sdkMocks;

// ---------------------------------------------------------------------------
// Logger + eventBus fixtures
// ---------------------------------------------------------------------------

function makeLogger() {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: "debug",
    isLevelEnabled: vi.fn(() => true),
  };
  logger.child = vi.fn(() => logger);
  return logger;
}

function makeEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests — keepalive ticker
// ---------------------------------------------------------------------------

describe("keepalive ticker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPing.mockReset().mockResolvedValue({});
    mockCallTool.mockReset();
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockClose.mockReset().mockResolvedValue(undefined);
    mockListTools.mockReset().mockResolvedValue({ tools: [] });
    clientInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires client.ping() every keepaliveIntervalMs when queue is idle", async () => {
    const mgr = createMcpClientManager({ logger: makeLogger() });
    const result = await mgr.connect({
      name: "test-server",
      transport: "stdio",
      command: "/usr/bin/test",
      keepaliveIntervalMs: 60_000,
      enabled: true,
    });
    expect(result.ok).toBe(true);

    // No ping at t=0 -- the ticker fires AFTER one interval has elapsed.
    expect(mockPing).toHaveBeenCalledTimes(0);

    // First tick: advance one full interval; queue is idle; ping fires.
    await vi.advanceTimersByTimeAsync(60_000);
    // Flush p-queue microtask schedules + the queue.add promise body.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPing).toHaveBeenCalledTimes(1);

    // Second tick: ping fires again at the next interval boundary.
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPing).toHaveBeenCalledTimes(2);
  });

  it("skips ping when callQueue has pending items", async () => {
    const mgr = createMcpClientManager({ logger: makeLogger() });
    await mgr.connect({
      name: "test-server",
      transport: "stdio",
      command: "/usr/bin/test",
      keepaliveIntervalMs: 60_000,
      enabled: true,
    });

    // Slow tool call: holds the per-server PQueue open (pending=1) so the
    // keepalive tick MUST skip its ping.
    let resolveSlowCall: ((v: unknown) => void) | undefined;
    mockCallTool.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveSlowCall = resolve;
      }),
    );

    // Kick off the slow tool call.
    const callPromise = mgr.callTool("mcp:test-server/slow", {});
    // Allow the queue to register the pending call.
    await Promise.resolve();
    await Promise.resolve();

    // Advance to the first tick. Queue.pending > 0 -> ping skipped.
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPing).toHaveBeenCalledTimes(0);

    // Resolve the slow call; queue drains.
    resolveSlowCall!({ content: [{ type: "text", text: "ok" }], isError: false });
    await callPromise;
    await Promise.resolve();
    await Promise.resolve();

    // Next tick: queue is idle so the keepalive ping fires.
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPing).toHaveBeenCalledTimes(1);
  });

  it("triggers mcp:server:disconnected with reason='keepalive_failed' on ping failure", async () => {
    const eventBus = makeEventBus();
    const mgr = createMcpClientManager({
      logger: makeLogger(),
      eventBus: eventBus as never,
    });
    await mgr.connect({
      name: "test-server",
      transport: "stdio",
      command: "/usr/bin/test",
      keepaliveIntervalMs: 60_000,
      enabled: true,
    });

    // First tick: ping rejects -> handleDisconnection(..., "keepalive_failed").
    mockPing.mockRejectedValueOnce(new Error("pipe closed"));

    await vi.advanceTimersByTimeAsync(60_000);
    // Flush queue.add microtask + the inner catch handler that emits.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(eventBus.emit).toHaveBeenCalledWith(
      "mcp:server:disconnected",
      expect.objectContaining({
        serverName: "test-server",
        reason: "keepalive_failed",
      }),
    );
  });
});
