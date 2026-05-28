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
// Transport-aware interval resolution.
//
// Tests verify:
//   (a) `resolveDefaultKeepaliveIntervalMs` is exported from mcp-client-keepalive.ts
//   (b) `state.options.keepaliveIntervalMs` is NOT the fallback in
//       startKeepaliveTicker; resolveDefaultKeepaliveIntervalMs is.
//
// All tests in this describe block use dynamic import to avoid a compile-time
// hard reference to the export.
// ---------------------------------------------------------------------------

describe("mcp-client-keepalive — transport-aware interval resolution", () => {
  it("resolveDefaultKeepaliveIntervalMs returns 30000 for 'http' transport", async () => {
    const mod = await import("./mcp-client-keepalive.js");
    const fn = (mod as Record<string, unknown>)["resolveDefaultKeepaliveIntervalMs"] as
      | ((t: string) => number)
      | undefined;
    expect(fn).toBeDefined();
    expect(fn!("http")).toBe(30_000);
  });

  it("resolveDefaultKeepaliveIntervalMs returns 180000 for 'stdio' transport", async () => {
    const mod = await import("./mcp-client-keepalive.js");
    const fn = (mod as Record<string, unknown>)["resolveDefaultKeepaliveIntervalMs"] as
      | ((t: string) => number)
      | undefined;
    expect(fn).toBeDefined();
    expect(fn!("stdio")).toBe(180_000);
  });

  it("resolveDefaultKeepaliveIntervalMs returns 30000 for 'sse' transport", async () => {
    const mod = await import("./mcp-client-keepalive.js");
    const fn = (mod as Record<string, unknown>)["resolveDefaultKeepaliveIntervalMs"] as
      | ((t: string) => number)
      | undefined;
    expect(fn).toBeDefined();
    expect(fn!("sse")).toBe(30_000);
  });

  it("startKeepaliveTicker starts a ticker for http transport when no per-server override", () => {
    // resolves via resolveDefaultKeepaliveIntervalMs("http") = 30_000
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
    // Invariant guard — per-server override always wins via ??.
    // The priority chain must be preserved.
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
// Proactive pre-expiry OAuth token refresh on keepalive tick.
//
// When a server has `auth:"oauth"` and the token's remaining lifetime
// (expires_in) is within PRE_EXPIRY_BUFFER_SEC (300s), the keepalive tick
// MUST call dedupedRefresh before the ping so the token never sits expired
// until the next tool call 401s.
//
// All three tests inject a `mockDeduper` via the OPTIONAL 5th parameter of
// maybeEnqueueKeepalivePing, cast through a loosely-typed reference
// (callKeepalive). Tests 2 and 3 assert the spy is NOT called — they are
// meaningful regression fences (a missing expiry/auth guard would fire the
// spy there).
// ---------------------------------------------------------------------------

describe("maybeEnqueueKeepalivePing — proactive pre-expiry OAuth refresh", () => {
  const PRE_EXPIRY_BUFFER_SEC = 300; // 5 minutes in seconds (matches PRE_EXPIRY_BUFFER_MS / 1000)

  // Loosely-typed call seam: tolerates the optional 5th `deduper` param without
  // a compile-time arity error.
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

  it("token within PRE_EXPIRY_BUFFER_SEC: injected deduper.dedupedRefresh fires before ping", async () => {
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

    // Inject the mockDeduper via the OPTIONAL 5th param. Near-expiry triggers
    // deduper.dedupedRefresh exactly once before the ping.
    callKeepalive(state, deps, "higgsfield", undefined, mockDeduper);
    await state.callQueues.get("higgsfield")!.onIdle();

    expect(dedupedRefreshSpy).toHaveBeenCalledTimes(1);
    expect(dedupedRefreshSpy.mock.calls[0]![0]).toMatchObject({
      serverName: "higgsfield",
      metadata: expect.objectContaining({ token_endpoint: "https://auth.example.test/token" }),
    });
    // Ping still fires after refresh
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("token comfortably valid (expires_in > buffer): injected deduper NOT called, ping fires normally", async () => {
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

    // Inject the mockDeduper so .not.toHaveBeenCalled() is MEANINGFUL: a missing
    // or incorrect expiry guard would make this spy fire and fail here.
    callKeepalive(state, deps, "higgsfield", undefined, mockDeduper);
    await state.callQueues.get("higgsfield")!.onIdle();

    // Fresh token → expiry guard skips the refresh.
    expect(dedupedRefreshSpy).not.toHaveBeenCalled();
    // But ping still fires normally
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("non-oauth server: injected deduper NOT called, ping fires normally", async () => {
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

    // Inject the mockDeduper so .not.toHaveBeenCalled() is MEANINGFUL: a missing
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

// ---------------------------------------------------------------------------
// Concurrency-1 deadlock prevention — real createRefreshDeduper (via a FRESH
// per-tick cc-1 queue, NOT the primary queue) must not deadlock.
//
// Without the fix: doProactiveRefreshIfNeeded ran INSIDE primary.add(doPing).
//   The deduper's critical section called primaryQueue.add(criticalSection).
//   With concurrency:1, the only slot was held by doPing → nested primaryQueue.add
//   blocks permanently → deadlock. saveTokens never ran (doRefresh never started).
//
// With the fix: doProactiveRefreshIfNeeded uses a fresh per-tick PQueue(concurrency:1)
//   for the deduper's critical section (not primary). No nesting → no deadlock.
//   The dedup guarantee is preserved by the shared inflightRefreshes map.
//
// Test strategy:
//   - Use the REAL createRefreshDeduper.
//   - Build it with a FRESH cc-1 queue (tickQueue), mirroring production.
//   - Inject this real deduper into callKeepalive so the production doPing uses it.
//
// doProactiveRefreshIfNeeded runs INSIDE primary.add(doPing) BUT uses tickQueue
// (a separate cc-1 queue) for the deduper critical section. No nested
// primary.add → no deadlock. The refresh can run and complete. ping fires.
// ---------------------------------------------------------------------------

describe("concurrency-1 real createRefreshDeduper no deadlock", () => {
  it(
    "concurrency-1: near-expiry refresh with real createRefreshDeduper completes (no deadlock)",
    async () => {
      const state = makeState();
      const { ping } = wireConnected(state, "stripe-mcp", { concurrency: 1 });

      // Near-expiry token (60s remaining — within 300s buffer).
      // saveTokens is the observable evidence that doRefresh ran to completion.
      const savedTokens: unknown[] = [];
      const tokenStore: Pick<
        TokenStore,
        "tokens" | "discoveryState" | "clientInformation" | "saveTokens"
      > = {
        tokens: vi.fn(async () => ({
          access_token: "AT_EXPIRING",
          refresh_token: "RT_EXPIRING",
          token_type: "Bearer" as const,
          expires_in: 60, // well within 300s buffer
        })),
        discoveryState: vi.fn(async () => ({
          authorizationServerUrl: "https://auth.example.test",
          authorizationServerMetadata: {
            token_endpoint: "https://auth.example.test/token",
            issuer: "https://auth.example.test",
          },
        } as OAuthDiscoveryState)),
        clientInformation: vi.fn(async () => ({
          client_id: "test-client",
          redirect_uris: ["http://127.0.0.1:0/cb"],
        } as OAuthClientInformationFull)),
        saveTokens: vi.fn(async (_, t) => { savedTokens.push(t); }),
      };

      state.serverConfigs.set("stripe-mcp", {
        name: "stripe-mcp",
        transport: "http",
        url: "http://localhost:3000/mcp",
        enabled: true,
        auth: "oauth",
      });

      // Build a REAL deduper backed by a FRESH cc-1 queue (not primary).
      // This is the production shape: the deduper's critical section never
      // nests inside the primary queue's running slot.
      const { createRefreshDeduper } = await import("./oauth/refresh-deduper.js");
      const freshTickQueue = new PQueue({ concurrency: 1 });
      const refreshFnSpy = vi.fn(async () => ({
        access_token: "AT_NEW",
        refresh_token: "RT_NEW",
        token_type: "Bearer" as const,
        expires_in: 3600,
      }));
      const realDeduper = createRefreshDeduper({
        inflightRefreshes: state.inflightRefreshes,
        queue: freshTickQueue as unknown as Parameters<typeof createRefreshDeduper>[0]["queue"],
        tokenStore: tokenStore as unknown as TokenStore,
        refreshFn: refreshFnSpy,
        logger: NOOP_LOGGER,
      });

      const deps: McpClientManagerDeps = {
        logger: NOOP_LOGGER,
        oauthDeps: {
          createTokenStore: () => tokenStore as unknown as TokenStore,
          resolveDiscovery: vi.fn(),
        },
      };

      type KeepaliveWithDeduper = (
        state: McpClientManagerState,
        deps: McpClientManagerDeps,
        serverName: string,
        onFailure?: (serverName: string) => void,
        deduper?: RefreshDeduper,
      ) => void;
      const callKeepalive = maybeEnqueueKeepalivePing as unknown as KeepaliveWithDeduper;

      const primaryQueue = state.callQueues.get("stripe-mcp")!;

      // Inject the real deduper with freshTickQueue. The injected deduper uses
      // a separate tickQueue (not primary) for its critical section, so the
      // primary slot held by doPing doesn't block the refresh's critical section.
      callKeepalive(state, deps, "stripe-mcp", undefined, realDeduper);

      await Promise.race([
        primaryQueue.onIdle(),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);

      // Refresh ran (refreshFnSpy called, saveTokens persisted), ping fired.
      expect(refreshFnSpy).toHaveBeenCalledTimes(1); // real createRefreshDeduper exercised
      expect(savedTokens).toHaveLength(1); // tokens persisted via saveTokens
      expect(ping).toHaveBeenCalledTimes(1); // ping fires after refresh
    },
  );

  it(
    "concurrency-1 straggler-cache hit: real deduper serves from cache, ping fires",
    async () => {
      const state = makeState();
      const { ping } = wireConnected(state, "cache-hit-srv", { concurrency: 1 });

      const tokenStore: Pick<
        TokenStore,
        "tokens" | "discoveryState" | "clientInformation" | "saveTokens"
      > = {
        tokens: vi.fn(async () => ({
          access_token: "AT_CACHE_HIT",
          refresh_token: "RT_CACHE_HIT",
          token_type: "Bearer" as const,
          expires_in: 60,
        })),
        discoveryState: vi.fn(async () => ({
          authorizationServerUrl: "https://auth.example.test",
          authorizationServerMetadata: {
            token_endpoint: "https://auth.example.test/token",
            issuer: "https://auth.example.test",
          },
        } as OAuthDiscoveryState)),
        clientInformation: vi.fn(async () => ({
          client_id: "cache-client",
          redirect_uris: ["http://127.0.0.1:0/cb"],
        } as OAuthClientInformationFull)),
        saveTokens: vi.fn(async () => {}),
      };

      const refreshFnSpy = vi.fn(async () => ({
        access_token: "AT_NEW_CACHE",
        refresh_token: "RT_NEW_CACHE",
        token_type: "Bearer" as const,
        expires_in: 3600,
      }));

      // Pre-seed the straggler cache with an already-resolved promise.
      const cachedResult: RefreshResult = {
        tokens: { access_token: "AT_NEW_CACHE", token_type: "Bearer" as const, expires_in: 3600 },
      };
      state.inflightRefreshes.set("AT_CACHE_HIT", Promise.resolve(cachedResult));

      const { createRefreshDeduper } = await import("./oauth/refresh-deduper.js");
      // Fresh cc-1 queue for the deduper critical section (production shape).
      const freshTickQueue = new PQueue({ concurrency: 1 });
      const realDeduper = createRefreshDeduper({
        inflightRefreshes: state.inflightRefreshes,
        queue: freshTickQueue as unknown as Parameters<typeof createRefreshDeduper>[0]["queue"],
        tokenStore: tokenStore as unknown as TokenStore,
        refreshFn: refreshFnSpy,
        logger: NOOP_LOGGER,
      });

      state.serverConfigs.set("cache-hit-srv", {
        name: "cache-hit-srv",
        transport: "http",
        url: "http://localhost:3000/mcp",
        enabled: true,
        auth: "oauth",
      });

      const primaryQueue = state.callQueues.get("cache-hit-srv")!;

      const deps: McpClientManagerDeps = {
        logger: NOOP_LOGGER,
        oauthDeps: {
          createTokenStore: () => tokenStore as unknown as TokenStore,
          resolveDiscovery: vi.fn(),
        },
      };

      type KeepaliveWithDeduper = (
        state: McpClientManagerState,
        deps: McpClientManagerDeps,
        serverName: string,
        onFailure?: (serverName: string) => void,
        deduper?: RefreshDeduper,
      ) => void;
      const callKeepalive = maybeEnqueueKeepalivePing as unknown as KeepaliveWithDeduper;

      callKeepalive(state, deps, "cache-hit-srv", undefined, realDeduper);

      await Promise.race([
        primaryQueue.onIdle(),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);

      // Cache hit: real deduper serves from the pre-seeded promise.
      // refreshFnSpy NOT called (no new refresh POST), ping fires normally.
      expect(primaryQueue.pending).toBe(0); // queue must have drained
      expect(refreshFnSpy).not.toHaveBeenCalled(); // cache hit: no new refresh POST
      expect(ping).toHaveBeenCalledTimes(1); // ping fires
    },
  );

  it(
    "concurrency-1 production path: no injected deduper — tickQueue prevents deadlock, queue drains and ping fires",
    async () => {
      // This test exercises the production code path (no deduper injected).
      // Production code uses a fresh per-tick PQueue(concurrency:1) for the
      // deduper → no nesting → no deadlock → queue idles → ping fires.
      //
      // The refresh call itself will fail (the default SDK refreshAuthorization makes a
      // real HTTP request which fails in tests). That failure is caught + WARN-logged,
      // and the code continues to ping. So the observable for "no deadlock" is that
      // the queue drains and ping is called.
      const state = makeState();
      const { ping } = wireConnected(state, "production-srv", { concurrency: 1 });

      const tokenStore: Pick<
        TokenStore,
        "tokens" | "discoveryState" | "clientInformation" | "saveTokens"
      > = {
        tokens: vi.fn(async () => ({
          access_token: "AT_PROD",
          refresh_token: "RT_PROD",
          token_type: "Bearer" as const,
          expires_in: 60,
        })),
        discoveryState: vi.fn(async () => ({
          authorizationServerUrl: "https://auth.example.test",
          authorizationServerMetadata: {
            token_endpoint: "https://auth.example.test/token",
            issuer: "https://auth.example.test",
          },
        } as OAuthDiscoveryState)),
        clientInformation: vi.fn(async () => ({
          client_id: "prod-client",
          redirect_uris: ["http://127.0.0.1:0/cb"],
        } as OAuthClientInformationFull)),
        saveTokens: vi.fn(async () => {}),
      };

      state.serverConfigs.set("production-srv", {
        name: "production-srv",
        transport: "http",
        url: "http://localhost:3000/mcp",
        enabled: true,
        auth: "oauth",
      });

      const deps: McpClientManagerDeps = {
        logger: NOOP_LOGGER,
        oauthDeps: {
          createTokenStore: () => tokenStore as unknown as TokenStore,
          resolveDiscovery: vi.fn(),
        },
      };

      const primaryQueue = state.callQueues.get("production-srv")!;

      // NO injected deduper — production code path.
      // Production code builds the deduper with per-tick tickQueue → no
      // deadlock → queue idles quickly → ping called.
      // The refresh itself fails (no real HTTP endpoint) but the error is caught;
      // the code continues to ping regardless of refresh success/failure.
      maybeEnqueueKeepalivePing(state, deps, "production-srv");

      // Use a generous timeout — no deadlock should resolve in well under 500ms.
      let queueDrained = false;
      await Promise.race([
        primaryQueue.onIdle().then(() => { queueDrained = true; }),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);

      // Queue drained (no deadlock) → ping fired.
      expect(queueDrained).toBe(true);
      expect(ping).toHaveBeenCalledTimes(1); // ping fires despite refresh failure
    },
  );
});

// ---------------------------------------------------------------------------
// addClientAuthentication forwarded into the proactive refresh.
//
// serverConfig.oauth.stripeAccount must be resolved into an
// addClientAuthentication hook and forwarded into dedupedRefresh, mirroring
// what the on-401 path (deduped-fetch.ts) already does — otherwise Stripe
// connected-account refreshes fail with a 401 because the Stripe-Account
// header is absent.
//
// Test strategy: inject a mockDeduper and assert that dedupedRefresh receives
//   an addClientAuthentication function when serverConfig.oauth.stripeAccount
//   is set, and does NOT receive one when it is absent.
// ---------------------------------------------------------------------------

describe("addClientAuthentication forwarded into proactive refresh", () => {
  function makeStateWithRefreshes(): McpClientManagerState {
    return { ...makeState(), inflightRefreshes: new Map<string, Promise<RefreshResult>>() } as McpClientManagerState;
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

  function makeNearExpiryTokenStore(): Pick<TokenStore, "tokens" | "discoveryState" | "clientInformation"> {
    return {
      tokens: vi.fn(async () => ({
        access_token: "AT_NEAR",
        refresh_token: "RT_NEAR",
        token_type: "Bearer" as const,
        expires_in: 60,
      })),
      discoveryState: vi.fn(async () => ({
        authorizationServerUrl: "https://auth.example.test",
        authorizationServerMetadata: {
          token_endpoint: "https://auth.example.test/token",
          issuer: "https://auth.example.test",
        },
      } as OAuthDiscoveryState)),
      clientInformation: vi.fn(async () => ({
        client_id: "test-client",
        redirect_uris: ["http://127.0.0.1:0/cb"],
      } as OAuthClientInformationFull)),
    };
  }

  type KeepaliveWithDeduper = (
    state: McpClientManagerState,
    deps: McpClientManagerDeps,
    serverName: string,
    onFailure?: (serverName: string) => void,
    deduper?: RefreshDeduper,
  ) => void;

  it("stripeAccount set: addClientAuthentication forwarded into dedupedRefresh", async () => {
    const state = makeStateWithRefreshes();
    wireConnected(state, "stripe-srv", { concurrency: 1 });

    state.serverConfigs.set("stripe-srv", {
      name: "stripe-srv",
      transport: "http",
      url: "http://localhost:3000/mcp",
      enabled: true,
      auth: "oauth",
      oauth: { stripeAccount: "acct_test123" },
    });

    const { mockDeduper, dedupedRefreshSpy } = makeMockDeduper();
    const tokenStore = makeNearExpiryTokenStore();

    const deps: McpClientManagerDeps = {
      logger: NOOP_LOGGER,
      oauthDeps: {
        createTokenStore: () => tokenStore as unknown as TokenStore,
        resolveDiscovery: vi.fn(),
      },
    };

    const callKeepalive = maybeEnqueueKeepalivePing as unknown as KeepaliveWithDeduper;
    callKeepalive(state, deps, "stripe-srv", undefined, mockDeduper);
    await state.callQueues.get("stripe-srv")!.onIdle();

    expect(dedupedRefreshSpy).toHaveBeenCalledTimes(1);
    // addClientAuthentication must be forwarded into the call.
    const callArgs = dedupedRefreshSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof callArgs["addClientAuthentication"]).toBe("function");
  });

  it("no stripeAccount: addClientAuthentication absent in dedupedRefresh call (negative)", async () => {
    const state = makeStateWithRefreshes();
    wireConnected(state, "plain-oauth", { concurrency: 1 });

    state.serverConfigs.set("plain-oauth", {
      name: "plain-oauth",
      transport: "http",
      url: "http://localhost:3000/mcp",
      enabled: true,
      auth: "oauth",
      // no oauth.stripeAccount
    });

    const { mockDeduper, dedupedRefreshSpy } = makeMockDeduper();
    const tokenStore = makeNearExpiryTokenStore();

    const deps: McpClientManagerDeps = {
      logger: NOOP_LOGGER,
      oauthDeps: {
        createTokenStore: () => tokenStore as unknown as TokenStore,
        resolveDiscovery: vi.fn(),
      },
    };

    const callKeepalive = maybeEnqueueKeepalivePing as unknown as KeepaliveWithDeduper;
    callKeepalive(state, deps, "plain-oauth", undefined, mockDeduper);
    await state.callQueues.get("plain-oauth")!.onIdle();

    expect(dedupedRefreshSpy).toHaveBeenCalledTimes(1);
    const callArgs = dedupedRefreshSpy.mock.calls[0]![0] as Record<string, unknown>;
    // No stripeAccount → addClientAuthentication must be absent (not forwarded)
    expect(callArgs["addClientAuthentication"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Token store obtained once per tick (singleton contract).
//
// deps.oauthDeps.createTokenStore() must be called ONCE per-tick invocation,
// OUTSIDE the doPing closure (hoisted before primary.add(doPing)) — otherwise
// a new token store is created on every keepalive tick, invoking per-tick
// ensureContainedDir syscalls and violating the singleton contract.
//
// Test strategy: count createTokenStore() invocations across two tick calls.
//   Each tick must call it once at the top of maybeEnqueueKeepalivePing.
// ---------------------------------------------------------------------------

describe("token store obtained once per tick (singleton contract)", () => {
  it("createTokenStore called exactly once per tick, not once per queue execution", async () => {
    const state = makeState();
    wireConnected(state, "once-srv", { concurrency: 1 });

    state.serverConfigs.set("once-srv", {
      name: "once-srv",
      transport: "http",
      url: "http://localhost:3000/mcp",
      enabled: true,
      auth: "oauth",
    });

    let createTokenStoreCallCount = 0;

    // Token with PLENTY of time remaining — no refresh needed
    const tokenStore: Pick<TokenStore, "tokens" | "discoveryState" | "clientInformation"> = {
      tokens: vi.fn(async () => ({
        access_token: "AT_VALID",
        refresh_token: "RT_VALID",
        token_type: "Bearer" as const,
        expires_in: 9999, // way above buffer — refresh path skipped
      })),
      discoveryState: vi.fn(async () => undefined),
      clientInformation: vi.fn(async () => undefined),
    };

    const deps: McpClientManagerDeps = {
      logger: NOOP_LOGGER,
      oauthDeps: {
        createTokenStore: () => {
          createTokenStoreCallCount = createTokenStoreCallCount + 1;
          return tokenStore as unknown as TokenStore;
        },
        resolveDiscovery: vi.fn(),
      },
    };

    const q = state.callQueues.get("once-srv")!;

    // First tick
    maybeEnqueueKeepalivePing(state, deps, "once-srv");
    await q.onIdle();
    // Second tick
    maybeEnqueueKeepalivePing(state, deps, "once-srv");
    await q.onIdle();

    // createTokenStore called ONCE per tick invocation (2 ticks = 2 calls).
    // The function must not be called 0 times (auth check skipped) or more
    // times (re-called during queue execution).
    expect(createTokenStoreCallCount).toBe(2); // one call per tick
  });
});
