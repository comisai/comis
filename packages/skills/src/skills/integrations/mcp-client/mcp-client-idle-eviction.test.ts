// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the idle-eviction module.
 *
 * Exercises startIdleTicker / stopIdleTicker / resetIdleActivity against a
 * hand-built McpClientManagerState + fake timers. These unit tests cover the
 * module + the lazy-reconnect call-site branch without depending on a live
 * transport.
 *
 * Load-bearing assertions:
 *  - eviction fires after idleTtlMs and deletes the connection
 *  - eviction does NOT add the server to userDisconnectedFlags (auto-reconnect
 *    stays enabled — the divergence from disconnectServer)
 *  - eviction RETAINS serverConfigs (lazy reconnect reads it)
 *  - idleTtlMs:0 → ticker is never scheduled (opt-in only)
 *  - a successful callTool resets the idle timer (resetIdleActivity)
 *  - callTool against an evicted-but-configured server reconnects transparently
 *  - callTool against a user-disconnected / config-less server still errs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import PQueue from "p-queue";
import { callTool } from "./mcp-client-call.js";
import {
  resetIdleActivity,
  startIdleTicker,
  stopIdleTicker,
} from "./mcp-client-idle-eviction.js";
import { disconnectServer } from "./mcp-client-connect.js";
import { qualifyToolName } from "./mcp-client-types.js";
import type {
  McpClientManagerDeps,
  McpClientManagerOptions,
  McpClientManagerState,
  McpConnection,
  McpServerConfig,
} from "./mcp-client-types.js";

// Stub reconnectServer so the lazy-reconnect branch in callTool can be driven
// without a live transport. The stub repopulates state.connections + the call
// queue (what a real reconnect would do) so the subsequent callTool succeeds.
// All other mcp-client-connect.js exports are preserved via importActual.
const { reconnectStub } = vi.hoisted(() => ({ reconnectStub: vi.fn() }));
vi.mock("./mcp-client-connect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-client-connect.js")>();
  return { ...actual, reconnectServer: reconnectStub };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const NOOP_LOGGER: McpClientManagerDeps["logger"] = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeOptions(): McpClientManagerOptions {
  return {
    connectTimeoutMs: 30_000,
    callToolTimeoutMs: 60_000,
    stdioDefaultConcurrency: 1,
    httpDefaultConcurrency: 4,
    reconnectOpts: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 30_000, growFactor: 2 },
    keepaliveIntervalMs: 0,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
  };
}

function makeState(deps?: { logger: McpClientManagerDeps["logger"] }): McpClientManagerState {
  void deps;
  return {
    connections: new Map<string, McpConnection>(),
    reconnectionAbortControllers: new Map<string, AbortController>(),
    userDisconnectedFlags: new Set<string>(),
    serverConfigs: new Map<string, McpServerConfig>(),
    generations: new Map<string, number>(),
    callQueues: new Map<string, PQueue>(),
    keepaliveQueues: new Map<string, PQueue>(),
    consecutiveErrors: new Map<string, number>(),
    keepaliveTickers: new Map(),
    circuitBreakers: new Map(),
    idleEvictionTimers: new Map(),
    lastActivityMs: new Map<string, number>(),
    options: makeOptions(),
  };
}

/**
 * Wire a fake "connected" server into state: a stub Client whose close() is a
 * spy, a connection entry, a call queue, a stored config, and a keepalive
 * ticker handle (so we can assert eviction stops it). Mirrors what
 * connectServer would have produced.
 */
function wireConnected(
  state: McpClientManagerState,
  name: string,
  config: Partial<McpServerConfig> = {},
): { close: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {});
  const callToolFn = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], isError: false }));
  const client = { close, callTool: callToolFn } as unknown as Client;
  const fullConfig: McpServerConfig = {
    name,
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    enabled: true,
    ...config,
  };
  state.serverConfigs.set(name, fullConfig);
  state.generations.set(name, 0);
  state.callQueues.set(name, new PQueue({ concurrency: 1 }));
  state.connections.set(name, {
    name,
    client,
    status: "connected",
    tools: [{ name: "some_tool", qualifiedName: qualifyToolName(name, "some_tool"), inputSchema: {} }],
    lastHealthCheck: 0,
    reconnectAttempt: 0,
    maxReconnectAttempts: 5,
    generation: 0,
  });
  return { close, callTool: callToolFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("idle eviction — startIdleTicker / evict", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Test 1: evicts a server after idleTtlMs of no activity", async () => {
    const state = makeState();
    const { close } = wireConnected(state, "alpha", { idleTtlMs: 60_000 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    startIdleTicker(state, deps, state.serverConfigs.get("alpha")!);
    expect(state.idleEvictionTimers.has("alpha")).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(state.connections.get("alpha")).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    // Keepalive + idle ticker handles + call queue torn down.
    expect(state.callQueues.get("alpha")).toBeUndefined();
    expect(state.idleEvictionTimers.get("alpha")).toBeUndefined();
  });

  it("Test 2: eviction does NOT add the server to userDisconnectedFlags", async () => {
    const state = makeState();
    wireConnected(state, "beta", { idleTtlMs: 60_000 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    startIdleTicker(state, deps, state.serverConfigs.get("beta")!);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(state.connections.get("beta")).toBeUndefined();
    expect(state.userDisconnectedFlags.has("beta")).toBe(false);
  });

  it("Test 3: idleTtlMs:0 → ticker never scheduled (opt-in only)", async () => {
    const state = makeState();
    wireConnected(state, "gamma", { idleTtlMs: 0 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    startIdleTicker(state, deps, state.serverConfigs.get("gamma")!);
    expect(state.idleEvictionTimers.has("gamma")).toBe(false);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(state.connections.get("gamma")).toBeDefined();
  });

  it("Test 3b: omitted idleTtlMs → ticker never scheduled", async () => {
    const state = makeState();
    wireConnected(state, "gamma2");
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    startIdleTicker(state, deps, state.serverConfigs.get("gamma2")!);
    expect(state.idleEvictionTimers.has("gamma2")).toBe(false);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(state.connections.get("gamma2")).toBeDefined();
  });

  it("Test 4: eviction RETAINS serverConfigs (precondition for lazy reconnect)", async () => {
    const state = makeState();
    wireConnected(state, "delta", { idleTtlMs: 60_000 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    startIdleTicker(state, deps, state.serverConfigs.get("delta")!);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(state.connections.get("delta")).toBeUndefined();
    expect(state.serverConfigs.get("delta")).toBeDefined();
  });

  it("Test 5: a reset before the deadline delays eviction by another window", async () => {
    const state = makeState();
    wireConnected(state, "epsilon", { idleTtlMs: 60_000 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    startIdleTicker(state, deps, state.serverConfigs.get("epsilon")!);

    // Halfway through the window, register activity.
    await vi.advanceTimersByTimeAsync(30_000);
    resetIdleActivity(state, "epsilon");

    // The original deadline passes — connection must survive (activity reset it).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.connections.get("epsilon")).toBeDefined();

    // After a further full idle window with no activity, it evicts.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.connections.get("epsilon")).toBeUndefined();
  });

  it("eviction always fires at last-activity + full idleTtlMs even after multiple activity bounces", async () => {
    // Regression for the TTL-drift bug: pre-fix each reschedule passed
    // `ttl - idleFor` as the NEW ttl, so the effective eviction threshold
    // shrank with every bounce, causing premature eviction. With TTL=60s and
    // two bounces, the buggy code evicted after only ~50s of true idleness.
    const state = makeState();
    wireConnected(state, "drift", { idleTtlMs: 60_000 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    startIdleTicker(state, deps, state.serverConfigs.get("drift")!);

    // Bounce 1: activity at t=50s.
    await vi.advanceTimersByTimeAsync(50_000);
    resetIdleActivity(state, "drift"); // lastActivity = 50_000

    // Timer fires at t=60s (idleFor=10s) and must reschedule for the FULL
    // remaining window relative to the original TTL, not a shrunk one.
    await vi.advanceTimersByTimeAsync(10_000); // t=60s

    // Bounce 2: activity at t=105s.
    await vi.advanceTimersByTimeAsync(45_000); // t=105s
    resetIdleActivity(state, "drift"); // lastActivity = 105_000

    // At t=160s only 55s have elapsed since the last activity (< 60s TTL), so
    // the server MUST still be connected. Buggy code evicts here (~t=155s).
    await vi.advanceTimersByTimeAsync(55_000); // t=160s
    expect(state.connections.get("drift")).toBeDefined();

    // After the full 60s idle window from the last activity (t=165s) it evicts.
    await vi.advanceTimersByTimeAsync(10_000); // t=170s (>= 105_000 + 60_000)
    expect(state.connections.get("drift")).toBeUndefined();
  });

  it("does not evict while a tool call is in-flight on the server's queue", async () => {
    // Race guard: the idle timer fires exactly while a callTool is still
    // running on the per-server PQueue. An in-flight call IS activity — the
    // connection must survive (eviction would race the in-flight call and
    // surface a misleading error). Once the call drains, eviction resumes.
    const state = makeState();
    wireConnected(state, "inflight", { idleTtlMs: 60_000 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    startIdleTicker(state, deps, state.serverConfigs.get("inflight")!);

    // Enqueue a long-running task that stays pending past the TTL deadline.
    const queue = state.callQueues.get("inflight")!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    void queue.add(async () => { await gate; });
    // Let the task start running so queue.pending becomes 1.
    await Promise.resolve();
    expect(queue.pending).toBe(1);

    // Timer fires at the TTL deadline while the call is in-flight: must NOT evict.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.connections.get("inflight")).toBeDefined();
    expect(state.idleEvictionTimers.has("inflight")).toBe(true);

    // Drain the in-flight call; with no further activity the next full window
    // elapses and the server evicts.
    release();
    await queue.onIdle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.connections.get("inflight")).toBeUndefined();
  });

  it("the idle-eviction INFO log carries no errorKind (errorKind is for WARN/ERROR only)", async () => {
    // errorKind is required ONLY on ERROR/WARN logs; its presence on the INFO
    // eviction notification misleads observability tooling that filters on
    // errorKind into treating normal scheduled eviction as a degraded/broken
    // condition. Pre-fix: the info() fields included `errorKind: "dependency"`.
    const info = vi.fn();
    const spyLogger: McpClientManagerDeps["logger"] = {
      info,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const state = makeState();
    wireConnected(state, "loggy", { idleTtlMs: 60_000 });
    const deps: McpClientManagerDeps = { logger: spyLogger };

    startIdleTicker(state, deps, state.serverConfigs.get("loggy")!);
    await vi.advanceTimersByTimeAsync(60_000);

    // Locate the eviction INFO call by its message.
    const evictionCall = info.mock.calls.find(
      ([, msg]) => msg === "MCP server idle eviction",
    );
    expect(evictionCall).toBeDefined();
    const fields = evictionCall![0] as Record<string, unknown>;
    expect(fields).not.toHaveProperty("errorKind");
    // The serverName identifier remains useful for correlation.
    expect(fields).toMatchObject({ serverName: "loggy" });
  });

  it("stopIdleTicker clears the handle and lastActivity entry", () => {
    const state = makeState();
    wireConnected(state, "zeta", { idleTtlMs: 60_000 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    startIdleTicker(state, deps, state.serverConfigs.get("zeta")!);
    expect(state.idleEvictionTimers.has("zeta")).toBe(true);
    expect(state.lastActivityMs.has("zeta")).toBe(true);

    stopIdleTicker(state, "zeta");
    expect(state.idleEvictionTimers.has("zeta")).toBe(false);
    expect(state.lastActivityMs.has("zeta")).toBe(false);
  });

  it("resetIdleActivity is a no-op when no timer is armed (idleTtlMs disabled)", () => {
    const state = makeState();
    wireConnected(state, "eta", { idleTtlMs: 0 });
    // No ticker armed.
    resetIdleActivity(state, "eta");
    expect(state.lastActivityMs.has("eta")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lazy reconnect (getOrReconnect branch in callTool)
// ---------------------------------------------------------------------------

/**
 * Wire an "idle-evicted" state: serverConfigs retains the entry but there is
 * NO connection and NO call queue, and userDisconnectedFlags is empty. This is
 * exactly the post-evictIdleServer shape the lazy-reconnect branch must heal.
 */
function wireEvicted(state: McpClientManagerState, name: string): McpServerConfig {
  const config: McpServerConfig = {
    name,
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    enabled: true,
  };
  state.serverConfigs.set(name, config);
  state.generations.set(name, 1);
  // Deliberately: no connections entry, no call queue, flag NOT set.
  return config;
}

describe("idle eviction — lazy reconnect on missing connection", () => {
  beforeEach(() => {
    reconnectStub.mockReset();
  });

  it("Test 1: callTool after eviction reconnects transparently and succeeds", async () => {
    const state = makeState();
    wireEvicted(state, "alpha");
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    // Stub repopulates connections + call queue, as a real reconnect would.
    reconnectStub.mockImplementation(async (s: McpClientManagerState, _d: unknown, name: string) => {
      wireConnected(s, name);
      return { ok: true, value: s.connections.get(name) };
    });

    const result = await callTool(state, deps, qualifyToolName("alpha", "some_tool"), {});

    expect(reconnectStub).toHaveBeenCalledTimes(1);
    expect(reconnectStub).toHaveBeenCalledWith(state, deps, "alpha");
    expect(result.ok).toBe(true);
    expect(state.connections.get("alpha")).toBeDefined();
  });

  it("Test 2: no reconnect when the server is user-disconnected", async () => {
    const state = makeState();
    wireEvicted(state, "beta");
    state.userDisconnectedFlags.add("beta"); // operator disconnect — stay down
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    const result = await callTool(state, deps, qualifyToolName("beta", "some_tool"), {});

    expect(reconnectStub).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not connected");
  });

  it("Test 3: no reconnect when there is no stored config", async () => {
    const state = makeState();
    // No serverConfigs entry, no connection.
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    const result = await callTool(state, deps, qualifyToolName("gamma", "some_tool"), {});

    expect(reconnectStub).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not connected");
  });

  it("Test 3b: surfaces an idle-reconnect failure as an error", async () => {
    const state = makeState();
    wireEvicted(state, "delta");
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    reconnectStub.mockResolvedValue({ ok: false, error: new Error("spawn failed") });

    const result = await callTool(state, deps, qualifyToolName("delta", "some_tool"), {});

    expect(reconnectStub).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("idle-reconnect failed");
  });

  it("Test 4: a successful tool call resets idle activity", async () => {
    vi.useFakeTimers();
    try {
      const state = makeState();
      wireConnected(state, "epsilon", { idleTtlMs: 60_000 });
      const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

      // Arm the idle ticker, then let real time advance under fake timers.
      startIdleTicker(state, deps, state.serverConfigs.get("epsilon")!);
      const seeded = state.lastActivityMs.get("epsilon");
      expect(seeded).toBeDefined();

      await vi.advanceTimersByTimeAsync(30_000);
      const result = await callTool(state, deps, qualifyToolName("epsilon", "some_tool"), {});
      expect(result.ok).toBe(true);

      // The success path must have refreshed lastActivityMs (resetIdleActivity).
      const refreshed = state.lastActivityMs.get("epsilon");
      expect(refreshed).toBeDefined();
      expect(refreshed!).toBeGreaterThan(seeded!);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Dedicated keepalive queue teardown (no leak)
// ---------------------------------------------------------------------------
//
// When the primary call queue concurrency > 1, maybeEnqueueKeepalivePing
// lazily creates a dedicated cc-1 PQueue in state.keepaliveQueues. That entry
// MUST be cleared + deleted on BOTH disconnect and idle-eviction (mirroring
// callQueues) so it cannot leak across reconnect generations. These tests seed
// the map entry directly (the shape after a concurrency>1 keepalive tick) and
// assert teardown removes it. Pre-patch: nothing deletes it → the entry leaks.

/** Seed a dedicated keepalive queue entry, as a concurrency>1 tick would. */
function wireKeepaliveQueue(state: McpClientManagerState, name: string): PQueue {
  const ka = new PQueue({ concurrency: 1 });
  state.keepaliveQueues.set(name, ka);
  return ka;
}

describe("keepalive queue teardown", () => {
  it("disconnect clears + deletes the dedicated keepalive queue", async () => {
    const state = makeState();
    wireConnected(state, "alpha", { supportsParallelToolCalls: true });
    wireKeepaliveQueue(state, "alpha");
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    expect(state.keepaliveQueues.has("alpha")).toBe(true);

    await disconnectServer(state, deps, "alpha");

    // Pre-patch FAILS: disconnectServer tears down callQueues but leaves the
    // keepaliveQueues entry dangling.
    expect(state.keepaliveQueues.has("alpha")).toBe(false);
    // Sanity: the primary call queue is torn down too (existing behavior).
    expect(state.callQueues.has("alpha")).toBe(false);
  });

  it("idle-eviction clears + deletes the dedicated keepalive queue", async () => {
    vi.useFakeTimers();
    try {
      const state = makeState();
      wireConnected(state, "beta", { idleTtlMs: 60_000, supportsParallelToolCalls: true });
      wireKeepaliveQueue(state, "beta");
      const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

      startIdleTicker(state, deps, state.serverConfigs.get("beta")!);
      expect(state.keepaliveQueues.has("beta")).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);

      // Pre-patch FAILS: evictIdleServer mirrors disconnectServer's callQueues
      // teardown but not the keepaliveQueues teardown → the entry leaks.
      expect(state.connections.get("beta")).toBeUndefined();
      expect(state.keepaliveQueues.has("beta")).toBe(false);
      expect(state.callQueues.has("beta")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
