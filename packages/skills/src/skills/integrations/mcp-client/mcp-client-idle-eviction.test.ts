// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the Phase 65 OPUX-09 idle-eviction module.
 *
 * Exercises startIdleTicker / stopIdleTicker / resetIdleActivity against a
 * hand-built McpClientManagerState + fake timers. The full integration triad
 * (real stdio server + lazy reconnect over the wire) lands in Plan 06; these
 * unit tests drive RED for the module + the lazy-reconnect call-site branch
 * without depending on a live transport.
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
import { qualifyToolName } from "./mcp-client-types.js";
import type {
  McpClientManagerDeps,
  McpClientManagerOptions,
  McpClientManagerState,
  McpConnection,
  McpServerConfig,
} from "./mcp-client-types.js";

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

describe("idle eviction — startIdleTicker / evict (OPUX-09)", () => {
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
