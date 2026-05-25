// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the keepalive ticker.
 *
 * Exercises maybeEnqueueKeepalivePing / startKeepaliveTicker / stopKeepaliveTicker
 * against a hand-built McpClientManagerState. handleDisconnection is mocked so a
 * triggered reconnect surfaces as a spy call rather than a live reconnect loop.
 *
 * Load-bearing assertion: in the concurrency > 1 (parallel-mode) path
 * the ping body awaits primary.onIdle() before pinging. If a
 * disconnect→reconnect replaces the connection (new generation) during that
 * await, the ping must NOT fire against the stale closed client and must NOT
 * call handleDisconnection on the freshly-restored connection (which would kick
 * it offline with a spurious keepalive_failed reconnect).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import PQueue from "p-queue";
import {
  maybeEnqueueKeepalivePing,
  startKeepaliveTicker,
  stopKeepaliveTicker,
} from "./mcp-client-keepalive.js";
import { qualifyToolName } from "./mcp-client-types.js";
import type {
  McpClientManagerDeps,
  McpClientManagerOptions,
  McpClientManagerState,
  McpConnection,
  McpServerConfig,
} from "./mcp-client-types.js";

// Mock the reconnect module so handleDisconnection is a spy — a real call would
// mutate state to "reconnecting" and fire a background reconnect loop. We only
// need to assert whether it WAS or WAS NOT invoked.
const { handleDisconnectionStub } = vi.hoisted(() => ({ handleDisconnectionStub: vi.fn() }));
vi.mock("./mcp-client-reconnect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-client-reconnect.js")>();
  return { ...actual, handleDisconnection: handleDisconnectionStub };
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

function makeOptions(keepaliveIntervalMs = 0): McpClientManagerOptions {
  return {
    connectTimeoutMs: 30_000,
    callToolTimeoutMs: 60_000,
    stdioDefaultConcurrency: 1,
    httpDefaultConcurrency: 4,
    reconnectOpts: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 30_000, growFactor: 2 },
    keepaliveIntervalMs,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
  };
}

function makeState(keepaliveIntervalMs = 0): McpClientManagerState {
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
    options: makeOptions(keepaliveIntervalMs),
  };
}

/**
 * Wire a connected server. `concurrency` controls the primary call queue
 * concurrency (>1 selects the parallel-mode keepalive route). `ping` is a spy
 * so we can assert whether the keepalive pinged this specific (generation's)
 * client. Returns the connection object + the ping spy.
 */
function wireConnected(
  state: McpClientManagerState,
  name: string,
  opts: { concurrency: number; generation?: number; pingImpl?: () => Promise<void> },
): { connection: McpConnection; ping: ReturnType<typeof vi.fn> } {
  const ping = vi.fn(opts.pingImpl ?? (async () => {}));
  const close = vi.fn(async () => {});
  const client = { ping, close } as unknown as Client;
  const generation = opts.generation ?? 0;
  state.generations.set(name, generation);
  state.callQueues.set(name, new PQueue({ concurrency: opts.concurrency }));
  const connection: McpConnection = {
    name,
    client,
    status: "connected",
    tools: [{ name: "t", qualifiedName: qualifyToolName(name, "t"), inputSchema: {} }],
    lastHealthCheck: 0,
    reconnectAttempt: 0,
    maxReconnectAttempts: 5,
    generation,
  };
  state.connections.set(name, connection);
  return { connection, ping };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("keepalive ticker — maybeEnqueueKeepalivePing", () => {
  beforeEach(() => {
    handleDisconnectionStub.mockClear();
  });

  it("concurrency-1: pings via the primary queue when idle", async () => {
    const state = makeState();
    const { ping } = wireConnected(state, "alpha", { concurrency: 1 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    maybeEnqueueKeepalivePing(state, deps, "alpha");
    await state.callQueues.get("alpha")!.onIdle();

    expect(ping).toHaveBeenCalledTimes(1);
    expect(handleDisconnectionStub).not.toHaveBeenCalled();
  });

  it("concurrency-1: skips the ping when the primary queue is busy", async () => {
    const state = makeState();
    const { ping } = wireConnected(state, "alpha", { concurrency: 1 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    // Occupy the queue with a task that stays pending.
    const queue = state.callQueues.get("alpha")!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    void queue.add(async () => { await gate; });
    await Promise.resolve(); // let the task start (pending = 1)

    maybeEnqueueKeepalivePing(state, deps, "alpha");
    await Promise.resolve();
    expect(ping).not.toHaveBeenCalled();

    release();
    await queue.onIdle();
  });

  it("concurrency>1: routes the ping through a dedicated cc-1 queue after primary.onIdle()", async () => {
    const state = makeState();
    const { ping } = wireConnected(state, "par", { concurrency: 4 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };

    maybeEnqueueKeepalivePing(state, deps, "par");
    // A dedicated keepalive queue is lazily created for parallel-mode servers.
    expect(state.keepaliveQueues.has("par")).toBe(true);
    await state.keepaliveQueues.get("par")!.onIdle();

    expect(ping).toHaveBeenCalledTimes(1);
    expect(handleDisconnectionStub).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Stale-connection closure race in the parallel-mode keepalive path.
  //
  // If doPing closed over the `conn` captured at tick time and pinged
  // `conn.client` unconditionally after `await primary.onIdle()`, then when a
  // disconnect→reconnect replaced the connection during that await, the
  // ping would hit the STALE closed client (throwing) and the catch would call
  // handleDisconnection on the freshly-restored connection — a spurious
  // keepalive_failed reconnect that kicked the healthy connection offline.
  //
  // The guard captures the generation at tick time and bails in doPing when the
  // current connection is gone / not connected / a different generation.
  // -------------------------------------------------------------------------
  it("does NOT ping the stale client or trigger reconnect when the connection is replaced mid-wait", async () => {
    const state = makeState();
    // Generation 0 = the connection live at tick time. Its ping THROWS to model
    // a closed transport (a real stale client would reject).
    const stale = wireConnected(state, "race", {
      concurrency: 4,
      generation: 0,
      pingImpl: async () => { throw new Error("transport closed"); },
    });

    // Block the primary queue so the keepalive body parks on primary.onIdle().
    const primary = state.callQueues.get("race")!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    void primary.add(async () => { await gate; });
    await Promise.resolve(); // let the blocking task start

    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };
    maybeEnqueueKeepalivePing(state, deps, "race");
    expect(state.keepaliveQueues.has("race")).toBe(true);

    // Simulate disconnect→reconnect completing WHILE the keepalive body waits:
    // replace the connection with a fresh generation-1 client (healthy).
    const fresh = wireConnected(state, "race", { concurrency: 4, generation: 1 });
    // wireConnected replaced the primary queue too; restore the blocked queue so
    // the parked keepalive body (which captured the OLD primary) can unblock.
    state.callQueues.set("race", primary);

    // Unblock the primary queue → the keepalive body resumes and runs doPing.
    release();
    await primary.onIdle();
    await state.keepaliveQueues.get("race")!.onIdle();

    // The stale client must NOT have been pinged (its ping throws → would
    // trigger the spurious reconnect).
    expect(stale.ping).not.toHaveBeenCalled();
    // The fresh connection has a different generation than the one captured at
    // tick time, so doPing bails without pinging it either.
    expect(fresh.ping).not.toHaveBeenCalled();
    // Crucially: NO spurious reconnect on the healthy restored connection.
    expect(handleDisconnectionStub).not.toHaveBeenCalled();
  });

  it("still pings normally in parallel mode when the same connection survives the wait", async () => {
    // Control: when the connection is NOT replaced (same generation), the ping
    // proceeds as before — the bail guard must not over-fire.
    const state = makeState();
    const { ping } = wireConnected(state, "stable", { concurrency: 4, generation: 7 });

    const primary = state.callQueues.get("stable")!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    void primary.add(async () => { await gate; });
    await Promise.resolve();

    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };
    maybeEnqueueKeepalivePing(state, deps, "stable");

    release();
    await primary.onIdle();
    await state.keepaliveQueues.get("stable")!.onIdle();

    expect(ping).toHaveBeenCalledTimes(1);
    expect(handleDisconnectionStub).not.toHaveBeenCalled();
  });

  it("startKeepaliveTicker registers an unref'd ticker; stopKeepaliveTicker clears it", () => {
    const state = makeState(180_000);
    wireConnected(state, "tick", { concurrency: 1 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };
    const config: McpServerConfig = { name: "tick", transport: "stdio", command: "node", enabled: true };

    startKeepaliveTicker(state, deps, config);
    expect(state.keepaliveTickers.has("tick")).toBe(true);

    stopKeepaliveTicker(state, "tick");
    expect(state.keepaliveTickers.has("tick")).toBe(false);
  });

  it("startKeepaliveTicker is a no-op when interval resolves to 0 (disabled)", () => {
    const state = makeState(0);
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };
    const config: McpServerConfig = { name: "off", transport: "stdio", command: "node", enabled: true, keepaliveIntervalMs: 0 };

    startKeepaliveTicker(state, deps, config);
    expect(state.keepaliveTickers.has("off")).toBe(false);
  });
});
