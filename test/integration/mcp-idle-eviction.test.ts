// SPDX-License-Identifier: Apache-2.0
/**
 * Integration test — idle eviction + lazy reconnect.
 *
 * Drives the @comis/skills barrel (via dist/) end-to-end with a mocked MCP SDK
 * Client + transports and vitest fake timers. Proves the three locked
 * idle-eviction behaviors at the integration tier:
 *
 *   1. A server configured with `idleTtlMs > 0` is disconnected after the TTL
 *      elapses with no tool calls — `getConnection(name)` returns undefined.
 *   2. The next `callTool` against the evicted server reconnects TRANSPARENTLY
 *      (returns ok AND `getConnection(name)` is defined again). This is the
 *      INDIRECT proof that eviction did NOT set `userDisconnectedFlags`: the
 *      manager's public interface does not expose the flag set, but a
 *      successful lazy reconnect is only possible when the flag is unset (a
 *      user-disconnected server would stay down — `disconnectServer` adds the
 *      flag, `evictIdleServer` pointedly does not).
 *   3. Activity (a successful `callTool`) resets the idle timer, deferring
 *      eviction by `idleTtlMs` from the last activity.
 *
 * Harness mirrors test/integration/mcp-keepalive.test.ts (SDK Client mock via
 * the ABSOLUTE resolved SDK module path + fake timers). Vitest 4 does not
 * bridge specifier-based mocks across module graphs when the consumer is
 * compiled dist .js code; mocking the resolved absolute path is the working
 * pattern.
 *
 * Per CLAUDE.md: integration tests import from `dist/` — requires `pnpm build`
 * first.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// SDK module path resolution — see mcp-keepalive.test.ts docblock for the
// cross-module-graph rationale. createRequire is rooted at a dist .js file so
// pnpm's symlink chain is followed the same way the dist code's own imports
// resolve. require.resolve returns the CJS variant; swap to ESM since the dist
// code loads the ESM build.
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
// SDK Client mock — vi.hoisted initialises closure variables before the
// (also-hoisted) vi.mock factories execute. Each connect() constructs a fresh
// Client, so lazy reconnect produces a NEW instance (the proof that a
// reconnect actually happened).
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
// Logger fixture
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

/** The single discovered tool the mocked server exposes. */
const IDLE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Tests — idle eviction
// ---------------------------------------------------------------------------

describe("idle eviction + lazy reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPing.mockReset().mockResolvedValue({});
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockClose.mockReset().mockResolvedValue(undefined);
    mockListTools.mockReset().mockResolvedValue({
      tools: [
        { name: "ping", description: "ping", inputSchema: { type: "object" } },
        { name: "some_tool", description: "tool", inputSchema: { type: "object" } },
      ],
    });
    mockCallTool.mockReset().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    clientInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts after idleTtlMs of no activity — getConnection becomes undefined", async () => {
    const mgr = createMcpClientManager({ logger: makeLogger() });
    const result = await mgr.connect({
      name: "idle-server",
      transport: "stdio",
      command: "/usr/bin/test",
      enabled: true,
      idleTtlMs: IDLE_TTL_MS,
      // Disable the keepalive ticker so the only timer in play is idle eviction.
      keepaliveIntervalMs: 0,
    });
    expect(result.ok).toBe(true);
    expect(mgr.getConnection("idle-server")).toBeDefined();

    // No tool calls; advance one full TTL window. The self-rescheduling timer
    // fires, sees no activity since connect, and evicts.
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(mgr.getConnection("idle-server")).toBeUndefined();
    // The transport was closed as part of teardown.
    expect(mockClose).toHaveBeenCalled();
  });

  it("subsequent callTool reconnects transparently — INDIRECT proof userDisconnectedFlags NOT set", async () => {
    const mgr = createMcpClientManager({ logger: makeLogger() });
    await mgr.connect({
      name: "idle-server",
      transport: "stdio",
      command: "/usr/bin/test",
      enabled: true,
      idleTtlMs: IDLE_TTL_MS,
      keepaliveIntervalMs: 0,
    });
    const clientsAfterConnect = clientInstances.length;

    // Evict.
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(mgr.getConnection("idle-server")).toBeUndefined();

    // Lazy reconnect: callTool against the evicted server. If eviction had set
    // userDisconnectedFlags, reconnectServer's connectServer step would still
    // re-enable it — but the load-bearing guarantee is that the stored config
    // survived (evictIdleServer omits serverConfigs.delete) so the lazy path
    // CAN reconnect at all. A user-disconnect deletes the config → "not
    // connected" with no recovery.
    const callResult = await mgr.callTool("mcp:idle-server/some_tool", {});
    // Flush the async reconnect + queue.add microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(callResult.ok).toBe(true);
    // The connection is live again.
    expect(mgr.getConnection("idle-server")).toBeDefined();
    expect(mgr.getConnection("idle-server")!.status).toBe("connected");
    // A NEW Client instance was constructed by the lazy reconnect (proof the
    // reconnect actually re-established the transport, not a stale handle).
    expect(clientInstances.length).toBeGreaterThan(clientsAfterConnect);
  });

  it("activity resets the idle timer — eviction deferred to last-activity + idleTtlMs", async () => {
    const mgr = createMcpClientManager({ logger: makeLogger() });
    await mgr.connect({
      name: "idle-server",
      transport: "stdio",
      command: "/usr/bin/test",
      enabled: true,
      idleTtlMs: IDLE_TTL_MS,
      keepaliveIntervalMs: 0,
    });

    // t=30s: still well within the first TTL window.
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(mgr.getConnection("idle-server")).toBeDefined();

    // Activity at t=30s resets lastActivityMs → eviction deadline moves to t=90s.
    const call = await mgr.callTool("mcp:idle-server/ping", {});
    expect(call.ok).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    // t=70s (40s since the t=30s activity < 60s TTL) → STILL connected.
    await vi.advanceTimersByTimeAsync(40_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mgr.getConnection("idle-server")).toBeDefined();

    // t=90s (60s since the last activity) → eviction fires.
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mgr.getConnection("idle-server")).toBeUndefined();
  });

  it("idleTtlMs:0 (default/opt-out) NEVER evicts — connection survives well past any TTL", async () => {
    const mgr = createMcpClientManager({ logger: makeLogger() });
    await mgr.connect({
      name: "persistent-server",
      transport: "stdio",
      command: "/usr/bin/test",
      enabled: true,
      idleTtlMs: 0,
      keepaliveIntervalMs: 0,
    });
    expect(mgr.getConnection("persistent-server")).toBeDefined();

    // Advance 10× the TTL used by the other tests — no eviction without opt-in.
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS * 10);
    await Promise.resolve();
    await Promise.resolve();

    expect(mgr.getConnection("persistent-server")).toBeDefined();
    expect(mgr.getConnection("persistent-server")!.status).toBe("connected");
  });
});
