// SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for the per-server circuit breaker.
 *
 * Exercises the @comis/skills barrel (via dist/) end-to-end:
 *   - Breaker opens after N consecutive failures, and the next call
 *     returns ok({ isError: true, content: [{ text: "[server_unavailable] ..." }] })
 *     without occupying a queue slot
 *   - Open -> half-open transition exactly at circuitBreakerCooldownMs
 *     elapsed (probe attempt allowed)
 *   - Breaker resets to closed after reconnect succeeds, so a
 *     fresh tool call lands as ok({ isError: false }), NOT [server_unavailable]
 *
 * SDK mocking strategy mirrors mcp-keepalive.test.ts — vi.mock targets the
 * absolute resolved path of the SDK module computed via createRequire from a
 * dist .js file (the same path the dist consumer code uses). See that file's
 * docblock for why specifier-based mocks don't bridge module graphs in
 * Vitest 4.
 *
 * Integration tests import from `dist/`; requires `pnpm build`.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// SDK module path resolution (see mcp-keepalive.test.ts for the rationale).
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
// SDK Client mock — vi.hoisted ensures closures resolve before factories run.
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
// Tests — open + [server_unavailable] / cooldown half-open /
//         reset on reconnect
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
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

  it("opens breaker after 3 consecutive callTool failures and returns [server_unavailable]", async () => {
    const mgr = createMcpClientManager({
      logger: makeLogger(),
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 60_000,
      // Disable keepalive ticker for this test (focus on the breaker).
      keepaliveIntervalMs: 0,
    });
    await mgr.connect({
      name: "test-server",
      transport: "stdio",
      command: "/usr/bin/test",
      enabled: true,
    });

    // Use timeout errors so the production code preserves connection status
    // across failures (non-timeout errors mark the connection as "error" on
    // the first failure, which short-circuits subsequent calls at the status
    // check BEFORE the breaker counter increments — see mcp-client-call.ts
    // catch block's `!isTimeout` branch).
    mockCallTool.mockRejectedValue(new Error("Request timed out"));

    // 3 failures -> breaker opens at the 3rd. The 4th call is pre-checked and
    // returns the synthetic [server_unavailable] without invoking the SDK.
    const r1 = await mgr.callTool("mcp:test-server/foo", {});
    const r2 = await mgr.callTool("mcp:test-server/foo", {});
    const r3 = await mgr.callTool("mcp:test-server/foo", {});
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);

    const r4 = await mgr.callTool("mcp:test-server/foo", {});
    expect(r4.ok).toBe(true);
    if (r4.ok) {
      expect(r4.value.isError).toBe(true);
      expect(r4.value.content[0]?.text).toContain("[server_unavailable]");
    }

    // 4th call short-circuited at the pre-check -- mockCallTool was hit 3
    // times total, NOT 4.
    expect(mockCallTool).toHaveBeenCalledTimes(3);
  });

  it("transitions open -> half-open after circuitBreakerCooldownMs elapsed", async () => {
    const mgr = createMcpClientManager({
      logger: makeLogger(),
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 60_000,
      keepaliveIntervalMs: 0,
    });
    await mgr.connect({
      name: "test-server",
      transport: "stdio",
      command: "/usr/bin/test",
      enabled: true,
    });

    // Open the breaker with 3 timeout failures (timeout path preserves
    // connection status; see the previous test for the rationale).
    mockCallTool.mockRejectedValue(new Error("Request timed out"));
    await mgr.callTool("mcp:test-server/foo", {});
    await mgr.callTool("mcp:test-server/foo", {});
    await mgr.callTool("mcp:test-server/foo", {});

    // Advance past cooldown (60s + buffer).
    await vi.advanceTimersByTimeAsync(60_001);

    // Next call: pre-check sees status="open" + cooldown elapsed -> transitions
    // to half-open + falls through. mockCallTool resolves successfully -> the
    // success path resets the breaker to closed.
    mockCallTool.mockReset();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    const probe = await mgr.callTool("mcp:test-server/foo", {});
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.value.isError).toBe(false);
    }
    // Probe DID hit the SDK (half-open allows exactly one probe).
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it("breaker resets to closed after reconnect succeeds", async () => {
    const eventBus = makeEventBus();
    const mgr = createMcpClientManager({
      logger: makeLogger(),
      eventBus: eventBus as never,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 60_000,
      keepaliveIntervalMs: 0,
      reconnectOptions: { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 5000, growFactor: 2 },
    });
    await mgr.connect({
      name: "test-server",
      transport: "stdio",
      command: "/usr/bin/test",
      enabled: true,
    });

    // Open the breaker with 3 timeout failures (timeout path preserves
    // connection status; see the first test for the rationale).
    mockCallTool.mockRejectedValue(new Error("Request timed out"));
    await mgr.callTool("mcp:test-server/foo", {});
    await mgr.callTool("mcp:test-server/foo", {});
    await mgr.callTool("mcp:test-server/foo", {});
    const opened = await mgr.callTool("mcp:test-server/foo", {});
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.content[0]?.text).toContain("[server_unavailable]");
    }

    // Trigger reconnect via onclose -> the reconnect engine fires the
    // success block in mcp-client-reconnect.ts, which resets state.circuitBreakers
    // to { status: "closed", failureCount: 0 }.
    const client = clientInstances[0]!;
    expect(client.onclose).toBeDefined();
    mockConnect.mockResolvedValueOnce(undefined); // next reconnect succeeds
    client.onclose!();

    // Advance past the first backoff window (initialDelayMs=100 + jitter).
    await vi.advanceTimersByTimeAsync(2_000);
    // Flush microtasks for the reconnect success block.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Confirm the reconnect succeeded — emits mcp:server:reconnected.
    expect(eventBus.emit).toHaveBeenCalledWith(
      "mcp:server:reconnected",
      expect.objectContaining({ serverName: "test-server" }),
    );

    // Post-reconnect tool call: breaker was reset to closed, so a normal
    // mock-resolved call returns ok({ isError: false }) — NOT the synthetic
    // [server_unavailable] sentinel.
    mockCallTool.mockReset();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "post-reconnect ok" }],
      isError: false,
    });
    const recovered = await mgr.callTool("mcp:test-server/foo", {});
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.isError).toBe(false);
      // Defensive: the recovered result is the resolved mock value, not the
      // synthetic [server_unavailable] (which would have an "isError: true"
      // content array starting with that bracketed code).
      expect(recovered.value.content[0]?.text ?? "").not.toContain("[server_unavailable]");
    }
    // SDK was hit once (post-reconnect probe) — confirming the breaker did
    // NOT pre-check-and-short-circuit.
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });
});
