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
import type { TokenStore } from "./oauth/token-store.js";
import type { RefreshDeduper, RefreshResult } from "./oauth/refresh-deduper.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

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

function makeOptions(): McpClientManagerOptions {
  return {
    connectTimeoutMs: 30_000,
    callToolTimeoutMs: 60_000,
    stdioDefaultConcurrency: 1,
    httpDefaultConcurrency: 4,
    reconnectOpts: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 30_000, growFactor: 2 },
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
  };
}

function makeState(): McpClientManagerState {
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
    inflightRefreshes: new Map(),
    options: makeOptions(),
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
    const state = makeState();
    wireConnected(state, "tick", { concurrency: 1 });
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };
    const config: McpServerConfig = { name: "tick", transport: "stdio", command: "node", enabled: true };

    startKeepaliveTicker(state, deps, config);
    expect(state.keepaliveTickers.has("tick")).toBe(true);

    stopKeepaliveTicker(state, "tick");
    expect(state.keepaliveTickers.has("tick")).toBe(false);
  });

  it("startKeepaliveTicker is a no-op when interval resolves to 0 (disabled)", () => {
    const state = makeState();
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };
    const config: McpServerConfig = { name: "off", transport: "stdio", command: "node", enabled: true, keepaliveIntervalMs: 0 };

    startKeepaliveTicker(state, deps, config);
    expect(state.keepaliveTickers.has("off")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCPX-02 RED tests: transport-aware interval resolution.
//
// Plan 04-03 will:
//   (a) export `resolveDefaultKeepaliveIntervalMs` from mcp-client-keepalive.ts
//   (b) remove `state.options.keepaliveIntervalMs` as the fallback in
//       startKeepaliveTicker, replacing it with resolveDefaultKeepaliveIntervalMs.
//
// All tests in this describe block use dynamic import to avoid a compile-time
// hard reference to the (not-yet-existing) export, which would turn the entire
// file's passing tests RED today.  Instead, each test fails at assertion time
// with a clear message — guaranteeing these are genuine RED failures, not
// infrastructure failures.
//
// RED tests:
//   RED-KA-01: resolveDefaultKeepaliveIntervalMs returns 30000 for "http"
//   RED-KA-02: resolveDefaultKeepaliveIntervalMs returns 180000 for "stdio"
//   RED-KA-03: resolveDefaultKeepaliveIntervalMs returns 30000 for "sse"
//   RED-KA-04: startKeepaliveTicker starts a ticker for http when no per-server override
//              (currently resolves to state.options.keepaliveIntervalMs which is 0 → no-op)
//   RED-KA-05 (invariant guard): per-server keepaliveIntervalMs override wins over
//              transport-aware default. Already passes; must survive GREEN.
// ---------------------------------------------------------------------------

describe("mcp-client-keepalive — MCPX-02 transport-aware interval resolution", () => {
  it("resolveDefaultKeepaliveIntervalMs returns 30000 for 'http' transport", async () => {
    const mod = await import("./mcp-client-keepalive.js");
    // RED: resolveDefaultKeepaliveIntervalMs does not exist yet → assertion fails.
    // GREEN (Plan 04-03): the function is exported and returns 30_000 for http.
    const fn = (mod as Record<string, unknown>)["resolveDefaultKeepaliveIntervalMs"] as
      | ((t: string) => number)
      | undefined;
    expect(fn).toBeDefined();
    expect(fn!("http")).toBe(30_000);
  });

  it("resolveDefaultKeepaliveIntervalMs returns 180000 for 'stdio' transport", async () => {
    const mod = await import("./mcp-client-keepalive.js");
    // RED: function does not exist yet → assertion fails.
    const fn = (mod as Record<string, unknown>)["resolveDefaultKeepaliveIntervalMs"] as
      | ((t: string) => number)
      | undefined;
    expect(fn).toBeDefined();
    expect(fn!("stdio")).toBe(180_000);
  });

  it("resolveDefaultKeepaliveIntervalMs returns 30000 for 'sse' transport", async () => {
    const mod = await import("./mcp-client-keepalive.js");
    // RED: function does not exist yet → assertion fails.
    const fn = (mod as Record<string, unknown>)["resolveDefaultKeepaliveIntervalMs"] as
      | ((t: string) => number)
      | undefined;
    expect(fn).toBeDefined();
    expect(fn!("sse")).toBe(30_000);
  });

  it("startKeepaliveTicker starts a ticker for http transport when no per-server override (RED-KA-04)", () => {
    // GREEN (Plan 04-03): resolves via resolveDefaultKeepaliveIntervalMs("http") = 30_000
    // → ticker starts and state.keepaliveTickers.has("http-srv") is true.
    const state = makeState();
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };
    const config: McpServerConfig = {
      name: "http-srv",
      transport: "http",
      url: "http://localhost:3000/mcp",
      enabled: true,
      // no keepaliveIntervalMs override
    };
    startKeepaliveTicker(state, deps, config);
    expect(state.keepaliveTickers.has("http-srv")).toBe(true);
  });

  it("per-server keepaliveIntervalMs override wins over transport-aware default (invariant guard)", () => {
    // Invariant guard — already passes (per-server override always wins via ??).
    // Must remain passing after GREEN so the priority chain is preserved.
    const state = makeState();
    const deps: McpClientManagerDeps = { logger: NOOP_LOGGER };
    const config: McpServerConfig = {
      name: "override-srv",
      transport: "http",
      url: "http://localhost:3000/mcp",
      enabled: true,
      keepaliveIntervalMs: 60_000,
    };
    startKeepaliveTicker(state, deps, config);
    expect(state.keepaliveTickers.has("override-srv")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R6 #2: Proactive pre-expiry OAuth token refresh on keepalive tick.
//
// When a server has `auth:"oauth"` and the token's remaining lifetime
// (expires_in) is within PRE_EXPIRY_BUFFER_SEC (300s), the keepalive tick
// MUST call dedupedRefresh before the ping so the token never sits expired
// until the next tool call 401s.
//
// SEAM (D-TS-01, Option A): all three tests inject a `mockDeduper` via the
// OPTIONAL 5th parameter of maybeEnqueueKeepalivePing, cast through a
// loosely-typed reference (callKeepalive) so the call does NOT produce a
// compile-time arity error on pre-patch code. Pre-patch JS ignores the extra
// argument at runtime → test 1 fails at ASSERTION time (genuine RED). Tests
// 2 and 3 assert the spy is NOT called — they are meaningful regression
// fences post-patch (a missing expiry/auth guard would fire the spy there).
// ---------------------------------------------------------------------------

describe("maybeEnqueueKeepalivePing — R6 #2 proactive pre-expiry OAuth refresh", () => {
  const PRE_EXPIRY_BUFFER_SEC = 300; // 5 minutes in seconds (matches PRE_EXPIRY_BUFFER_MS / 1000)

  // Loosely-typed call seam: tolerates the optional 5th `deduper` param across the
  // RED (param absent) → GREEN (param present) transition without a compile-time arity
  // error. Pre-patch JS ignores the extra arg at runtime → the test fails at the
  // dedupedRefresh assertion (genuine RED), not at compile time.
  type KeepaliveWithDeduper = (
    state: McpClientManagerState,
    deps: McpClientManagerDeps,
    serverName: string,
    onFailure?: (serverName: string) => void,
    deduper?: RefreshDeduper,
  ) => void;
  const callKeepalive = maybeEnqueueKeepalivePing as unknown as KeepaliveWithDeduper;

  function makeStateWithRefreshes(): McpClientManagerState {
    return {
      ...makeState(), // spread existing makeState fields
      inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
    } as McpClientManagerState;
  }

  function makeTokenStoreMock(expiresIn: number): Pick<TokenStore, "tokens" | "discoveryState" | "clientInformation"> {
    return {
      tokens: vi.fn(async () => ({
        access_token: "AT_EXPIRING",
        refresh_token: "RT_CURRENT",
        token_type: "Bearer" as const,
        expires_in: expiresIn,
      })),
      discoveryState: vi.fn(async () => ({
        authorizationServerUrl: "https://auth.example.test",
        authorizationServerMetadata: {
          token_endpoint: "https://auth.example.test/token",
          issuer: "https://auth.example.test",
        },
      } as OAuthDiscoveryState)),
      clientInformation: vi.fn(async () => ({
        client_id: "c",
        redirect_uris: ["http://127.0.0.1:0/cb"],
      } as OAuthClientInformationFull)),
    };
  }

  function makeMockDeduper(): { mockDeduper: RefreshDeduper; dedupedRefreshSpy: ReturnType<typeof vi.fn> } {
    const dedupedRefreshSpy = vi.fn(async () => ({
      tokens: { access_token: "AT_NEW", token_type: "Bearer" as const, expires_in: 3600 },
    }));
    const mockDeduper: RefreshDeduper = {
      dedupedRefresh: dedupedRefreshSpy as unknown as RefreshDeduper["dedupedRefresh"],
    };
    return { mockDeduper, dedupedRefreshSpy };
  }

  it("token within PRE_EXPIRY_BUFFER_SEC: injected deduper.dedupedRefresh fires before ping (R6 #2)", async () => {
    const state = makeStateWithRefreshes();
    const { ping } = wireConnected(state, "higgsfield", { concurrency: 1 });

    // Set auth:"oauth" config for this server
    state.serverConfigs.set("higgsfield", {
      name: "higgsfield",
      transport: "http",
      url: "http://localhost:3000/mcp",
      enabled: true,
      auth: "oauth",
    });

    const { mockDeduper, dedupedRefreshSpy } = makeMockDeduper();
    const mockTokenStore = makeTokenStoreMock(60); // 60s remaining — within 300s buffer

    const deps: McpClientManagerDeps = {
      logger: NOOP_LOGGER,
      oauthDeps: {
        createTokenStore: () => mockTokenStore as unknown as TokenStore,
        resolveDiscovery: vi.fn(),
      },
    };

    // Inject the mockDeduper via the OPTIONAL 5th param (D-TS-01). Pre-patch: the param is
    // ignored at runtime (no proactive-refresh logic) → dedupedRefreshSpy stays uncalled (RED).
    // Post-patch: near-expiry triggers deduper.dedupedRefresh exactly once before the ping.
    callKeepalive(state, deps, "higgsfield", undefined, mockDeduper);
    await state.callQueues.get("higgsfield")!.onIdle();

    // RED pre-patch (Expected: 1 / Received: 0); GREEN post-patch.
    expect(dedupedRefreshSpy).toHaveBeenCalledTimes(1);
    expect(dedupedRefreshSpy.mock.calls[0]![0]).toMatchObject({
      serverName: "higgsfield",
      metadata: expect.objectContaining({ token_endpoint: "https://auth.example.test/token" }),
    });
    // Ping still fires after refresh
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("token comfortably valid (expires_in > buffer): injected deduper NOT called, ping fires normally (R6 #2)", async () => {
    const state = makeStateWithRefreshes();
    const { ping } = wireConnected(state, "higgsfield", { concurrency: 1 });

    state.serverConfigs.set("higgsfield", {
      name: "higgsfield",
      transport: "http",
      url: "http://localhost:3000/mcp",
      enabled: true,
      auth: "oauth",
    });

    const { mockDeduper, dedupedRefreshSpy } = makeMockDeduper();
    const mockTokenStore = makeTokenStoreMock(3600); // 1h remaining — well outside 300s buffer

    const deps: McpClientManagerDeps = {
      logger: NOOP_LOGGER,
      oauthDeps: {
        createTokenStore: () => mockTokenStore as unknown as TokenStore,
        resolveDiscovery: vi.fn(),
      },
    };

    // Inject the mockDeduper so .not.toHaveBeenCalled() is MEANINGFUL: post-patch the refresh
    // path exists, so a missing/incorrect expiry guard would make this spy fire and fail here.
    callKeepalive(state, deps, "higgsfield", undefined, mockDeduper);
    await state.callQueues.get("higgsfield")!.onIdle();

    // Fresh token → expiry guard skips the refresh.
    expect(dedupedRefreshSpy).not.toHaveBeenCalled();
    // But ping still fires normally
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("non-oauth server: injected deduper NOT called, ping fires normally (R6 #2)", async () => {
    const state = makeStateWithRefreshes();
    const { ping } = wireConnected(state, "plain-http", { concurrency: 1 });

    // No auth:"oauth" on this server
    state.serverConfigs.set("plain-http", {
      name: "plain-http",
      transport: "http",
      url: "http://localhost:3000/mcp",
      enabled: true,
      // auth is absent (defaults to "none" behavior)
    });

    const { mockDeduper, dedupedRefreshSpy } = makeMockDeduper();
    const mockTokenStore = makeTokenStoreMock(60); // would be near-expiry if it mattered

    const deps: McpClientManagerDeps = {
      logger: NOOP_LOGGER,
      oauthDeps: {
        createTokenStore: () => mockTokenStore as unknown as TokenStore,
        resolveDiscovery: vi.fn(),
      },
    };

    // Inject the mockDeduper so .not.toHaveBeenCalled() is MEANINGFUL: post-patch a missing
    // auth==="oauth" guard would make the spy fire on this non-oauth server and fail here.
    callKeepalive(state, deps, "plain-http", undefined, mockDeduper);
    await state.callQueues.get("plain-http")!.onIdle();

    // auth!=="oauth" → refresh path skipped entirely.
    expect(dedupedRefreshSpy).not.toHaveBeenCalled();
    // Ping fires normally
    expect(ping).toHaveBeenCalledTimes(1);
  });

  void PRE_EXPIRY_BUFFER_SEC; // referenced in test comments; satisfies unused-variable checks
});
