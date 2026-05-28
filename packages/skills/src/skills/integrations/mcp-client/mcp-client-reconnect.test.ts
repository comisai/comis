// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the reconnection engine.
 *
 * Covers:
 *
 *   isSelfHealedTransientError predicate narrowness.
 *     The SDK's StreamableHTTPClientTransport emits `onerror` with the prefix
 *     "SSE stream disconnected:" during internal GET-stream self-heal churn.
 *     The predicate must:
 *       (a) swallow those errors (counter stays 0, reconnect NOT triggered)
 *       (b) NOT swallow "Maximum reconnection attempts (…) exceeded."
 *       (c) NOT swallow generic McpError-shaped messages
 *
 *   Generation guard + close-ordering + log levels.
 *     Stale callbacks from a superseded connection generation must be ignored.
 *     reconnectionLoop must await client.close() BEFORE createTransport.
 *     Per-attempt failure log must be WARN, not DEBUG.
 *     Reconnect start must be logged at INFO.
 *
 *   Keepalive ticker active after auto-reconnect.
 *     After a successful auto-reconnect state.keepaliveTickers must contain the
 *     server entry.
 *
 * ESM module note: wireClientLifecycleCallbacks calls handleDisconnection via the
 * module's own internal binding — the partial mock of mcp-client-reconnect.js
 * replaces the *export* but not the internal call site. For invariant tests that
 * need to verify handleDisconnection was triggered, we instead observe the
 * side-effect: state.connections status flipping to "reconnecting" when
 * handleDisconnection fires and a reconnection loop starts.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import PQueue from "p-queue";
import { wireClientLifecycleCallbacks, handleDisconnection } from "./mcp-client-reconnect.js";
import { qualifyToolName } from "./mcp-client-types.js";
import type {
  McpClientManagerDeps,
  McpClientManagerOptions,
  McpClientManagerState,
  McpConnection,
  McpServerConfig,
  CircuitState,
} from "./mcp-client-types.js";

// ---------------------------------------------------------------------------
// vi.hoisted stubs — hoisted so vi.mock can reference them
// ---------------------------------------------------------------------------

const { createTransportStub } = vi.hoisted(() => ({
  createTransportStub: vi.fn(),
}));

const { createClientStub } = vi.hoisted(() => ({
  createClientStub: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Partial mock of mcp-client-discover.js:
//   createTransport and createClient are replaced by configurable stubs.
//   Used in reconnect-loop ordering tests.
// ---------------------------------------------------------------------------
vi.mock("./mcp-client-discover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-client-discover.js")>();
  return {
    ...actual,
    createTransport: createTransportStub,
    createClient: createClientStub,
  };
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

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeOptions(): McpClientManagerOptions {
  return {
    connectTimeoutMs: 5_000,
    callToolTimeoutMs: 5_000,
    stdioDefaultConcurrency: 1,
    httpDefaultConcurrency: 4,
    reconnectOpts: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 10, growFactor: 1 },
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
  };
}

type StateOpts = {
  serverName?: string;
  serverConfig?: Partial<McpServerConfig>;
};

function makeState(opts: StateOpts = {}): McpClientManagerState {
  const state: McpClientManagerState = {
    connections: new Map<string, McpConnection>(),
    reconnectionAbortControllers: new Map<string, AbortController>(),
    userDisconnectedFlags: new Set<string>(),
    serverConfigs: new Map<string, McpServerConfig>(),
    generations: new Map<string, number>(),
    callQueues: new Map<string, PQueue>(),
    keepaliveQueues: new Map<string, PQueue>(),
    consecutiveErrors: new Map<string, number>(),
    keepaliveTickers: new Map(),
    circuitBreakers: new Map<string, CircuitState>(),
    idleEvictionTimers: new Map(),
    lastActivityMs: new Map<string, number>(),
    inflightRefreshes: new Map(),
    options: makeOptions(),
  };

  if (opts.serverName) {
    const base: McpServerConfig = {
      name: opts.serverName,
      transport: "http",
      url: "http://localhost:3000/mcp",
      enabled: true,
    };
    const config: McpServerConfig = { ...base, ...opts.serverConfig } as McpServerConfig;
    state.serverConfigs.set(opts.serverName, config);
    state.generations.set(opts.serverName, 0);
    state.callQueues.set(opts.serverName, new PQueue({ concurrency: 1 }));
    state.circuitBreakers.set(opts.serverName, { status: "closed", failureCount: 0 });
  }

  return state;
}

/**
 * Creates a minimal mock Client and wires it at generation 0.
 * The onerror / onclose callbacks are intentionally left undefined until
 * wireClientLifecycleCallbacks assigns them.
 */
function makeFakeClient(opts: {
  closeImpl?: () => Promise<void>;
  connectImpl?: () => Promise<void>;
} = {}): Client {
  return {
    onerror: undefined as ((e: Error) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    close: vi.fn(opts.closeImpl ?? (async () => {})),
    ping: vi.fn(async () => {}),
    connect: vi.fn(opts.connectImpl ?? (async () => {})),
    listTools: vi.fn(async () => ({ tools: [] })),
    getInstructions: vi.fn(() => undefined),
    getServerCapabilities: vi.fn(() => undefined),
    getServerVersion: vi.fn(() => undefined),
  } as unknown as Client;
}

function wireConnected(
  state: McpClientManagerState,
  name: string,
  client?: Client,
): Client {
  const c = client ?? makeFakeClient();
  state.generations.set(name, 0);
  const conn: McpConnection = {
    name,
    client: c,
    status: "connected",
    tools: [{ name: "t", qualifiedName: qualifyToolName(name, "t"), inputSchema: {} }],
    lastHealthCheck: 0,
    reconnectAttempt: 0,
    maxReconnectAttempts: 5,
    generation: 0,
  };
  state.connections.set(name, conn);
  return c;
}

// ---------------------------------------------------------------------------
// Tests: self-heal predicate narrowness
// ---------------------------------------------------------------------------

describe("wireClientLifecycleCallbacks — self-heal predicate narrowness", () => {
  beforeEach(() => {
    createTransportStub.mockClear();
    createClientStub.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("five consecutive 'SSE stream disconnected:' errors leave consecutiveErrors at zero and do not trigger reconnect", () => {
    // isSelfHealedTransientError returns true for this prefix and the handler
    // early-returns without touching the counter. Otherwise the counter would
    // increment on every onerror call and after 3 errors reach
    // MAX_ERRORS_BEFORE_RECONNECT (3) and call handleDisconnection, flipping
    // the connection status to "reconnecting".
    const state = makeState({ serverName: "srv" });
    const client = wireConnected(state, "srv");

    wireClientLifecycleCallbacks(state, { logger: NOOP_LOGGER }, client, "srv");

    for (let i = 0; i < 5; i++) {
      client.onerror!(new Error("SSE stream disconnected: connection reset"));
    }

    // Counter must stay 0 (no increments)
    expect(state.consecutiveErrors.get("srv") ?? 0).toBe(0);

    // Connection must NOT have been pushed into reconnecting status by a
    // handleDisconnection call (proving the callbacks did not escalate)
    const conn = state.connections.get("srv");
    expect(conn?.status).toBe("connected");
  });

  it("'Maximum reconnection attempts (2) exceeded.' error escalates: triggers reconnect after threshold", () => {
    // Invariant guard — the predicate must not swallow this message.
    // Observable side-effect: after threshold (3) errors, handleDisconnection
    // fires, which sets connection status to "reconnecting".
    const state = makeState({ serverName: "srv" });
    const client = wireConnected(state, "srv");

    wireClientLifecycleCallbacks(state, { logger: NOOP_LOGGER }, client, "srv");

    // makeOptions sets maxAttempts: 2 and reconnectOpts.initialDelayMs: 1
    // handleDisconnection sets status = "reconnecting" synchronously
    for (let i = 0; i < 3; i++) {
      client.onerror!(new Error("Maximum reconnection attempts (2) exceeded."));
    }

    const conn = state.connections.get("srv");
    expect(conn?.status).toBe("reconnecting");
  });

  it("McpError-shaped message escalates: predicate does not match 'MCP error <code>: …'", () => {
    // Invariant guard — proves predicate narrowness.
    // Uses new Error instead of McpError to avoid importing the SDK class.
    const state = makeState({ serverName: "srv" });
    const client = wireConnected(state, "srv");

    wireClientLifecycleCallbacks(state, { logger: NOOP_LOGGER }, client, "srv");

    for (let i = 0; i < 3; i++) {
      client.onerror!(new Error("MCP error -32000: Connection closed"));
    }

    const conn = state.connections.get("srv");
    expect(conn?.status).toBe("reconnecting");
  });
});

// ---------------------------------------------------------------------------
// Tests: generation guard
// ---------------------------------------------------------------------------

describe("wireClientLifecycleCallbacks — generation guard", () => {
  beforeEach(() => {
    createTransportStub.mockClear();
    createClientStub.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("onerror from a superseded generation leaves the live connection's consecutiveErrors at zero", () => {
    // wireClientLifecycleCallbacks captures wiredGeneration and returns early
    // when state.generations.get(serverName) !== wiredGeneration. A stale gen-0
    // onerror fires after the generation has been bumped to 1.
    const state = makeState({ serverName: "srv" });
    const gen0Client = wireConnected(state, "srv"); // sets generation to 0

    wireClientLifecycleCallbacks(state, { logger: NOOP_LOGGER }, gen0Client, "srv");

    // Simulate a reconnect bumping the generation to 1
    state.generations.set("srv", 1);

    // Fire an error on the gen-0 client (stale callback)
    gen0Client.onerror!(new Error("Maximum reconnection attempts (2) exceeded."));

    expect(state.consecutiveErrors.get("srv") ?? 0).toBe(0);

    // The live connection (gen 1) must NOT be pushed into reconnecting
    const conn = state.connections.get("srv");
    expect(conn?.status).toBe("connected");
  });

  it("onclose from a superseded generation does not trigger reconnect on the live connection", () => {
    // onclose must include the generation check too.
    const state = makeState({ serverName: "srv" });
    const gen0Client = wireConnected(state, "srv");

    wireClientLifecycleCallbacks(state, { logger: NOOP_LOGGER }, gen0Client, "srv");

    // Bump generation so the gen-0 client becomes stale
    state.generations.set("srv", 1);

    gen0Client.onclose!();

    // Live connection must remain connected (stale onclose must not trigger reconnect)
    const conn = state.connections.get("srv");
    expect(conn?.status).toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// Tests: log levels (reconnectionLoop via the real handleDisconnection)
//
// These tests call handleDisconnection directly (imported from the module under
// test). Because the vi.mock of mcp-client-discover.js replaces createTransport
// and createClient, reconnectionLoop uses our stubs — we can control whether
// attempts succeed or fail and observe log output.
// ---------------------------------------------------------------------------

describe("reconnectionLoop — log levels", () => {
  beforeEach(() => {
    createTransportStub.mockClear();
    createClientStub.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("per-attempt reconnect failure is logged at WARN level, not DEBUG", async () => {
    // Per-attempt reconnect failures must be logged at WARN, not DEBUG.
    const logger = makeLogger();
    const state = makeState({ serverName: "srv" });

    const existingClient = wireConnected(state, "srv");
    // Make createTransport throw so every attempt fails — no need for a real transport
    createTransportStub.mockImplementation(() => {
      throw new Error("connection refused");
    });
    // createClient will never be reached (throws before it), but mock anyway
    createClientStub.mockReturnValue(makeFakeClient());

    // Call the real handleDisconnection (imported from the module under test,
    // which is the real implementation since this test file is NOT the mock target).
    handleDisconnection(state, { logger }, "srv", "client_error");

    // Run all backoff timers to exhaust all reconnect attempts
    await vi.runAllTimersAsync();

    // The per-attempt failure must have been logged at WARN
    const warnCalls = logger.warn.mock.calls;
    const hasAttemptFailWarn = warnCalls.some((args) => {
      const msg = typeof args[1] === "string" ? args[1] : "";
      return msg.includes("MCP reconnection attempt failed");
    });
    expect(hasAttemptFailWarn).toBe(true);

    // Verify DEBUG was NOT used for the per-attempt failure message
    const debugCalls = logger.debug.mock.calls;
    const hasAttemptFailDebug = debugCalls.some((args) => {
      const msg = typeof args[1] === "string" ? args[1] : "";
      return msg.includes("MCP reconnection attempt failed");
    });
    expect(hasAttemptFailDebug).toBe(false);
  });

  it("reconnect start is logged at INFO before the first attempt", async () => {
    // reconnect start must be logged at INFO before any attempt; the success
    // INFO log fires only on a successful reconnect.
    const logger = makeLogger();
    const state = makeState({ serverName: "srv" });

    wireConnected(state, "srv");
    // Make createTransport throw so we never reach the success INFO log
    createTransportStub.mockImplementation(() => {
      throw new Error("connection refused");
    });
    createClientStub.mockReturnValue(makeFakeClient());

    handleDisconnection(state, { logger }, "srv", "client_error");

    // Drain backoff timers for all attempts
    await vi.runAllTimersAsync();

    // Must have an INFO log that indicates reconnect starting (before any attempt)
    const infoCalls = logger.info.mock.calls;
    const hasReconnectStartInfo = infoCalls.some((args) => {
      const msg = typeof args[1] === "string" ? args[1] : "";
      // Must contain "reconnect" but NOT be the success message "MCP server reconnected"
      // (which only fires on success — we never succeed here)
      return msg.toLowerCase().includes("reconnect");
    });
    expect(hasReconnectStartInfo).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: close-before-create ordering
// ---------------------------------------------------------------------------

describe("reconnectionLoop — close-before-create ordering", () => {
  beforeEach(() => {
    createTransportStub.mockClear();
    createClientStub.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the prior client before calling createTransport in a reconnect attempt", async () => {
    // priorConn.client.close() must be called (and awaited) before createTransport.
    const callOrder: string[] = [];

    const priorClose = vi.fn(async () => {
      callOrder.push("close");
    });

    createTransportStub.mockImplementation(() => {
      callOrder.push("createTransport");
      throw new Error("fail after tracking order");
    });
    createClientStub.mockReturnValue(makeFakeClient());

    const state = makeState({ serverName: "srv" });

    // Pre-populate with a prior "connected" connection whose client has a close spy
    const priorClient = makeFakeClient({ closeImpl: priorClose });
    wireConnected(state, "srv", priorClient);

    handleDisconnection(state, { logger: NOOP_LOGGER }, "srv", "client_error");

    await vi.runAllTimersAsync();

    const closeIdx = callOrder.indexOf("close");
    const createIdx = callOrder.indexOf("createTransport");

    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(closeIdx);
  });
});

// ---------------------------------------------------------------------------
// Tests: keepalive ticker active after successful auto-reconnect
// ---------------------------------------------------------------------------

describe("reconnectionLoop — keepalive ticker after auto-reconnect", () => {
  beforeEach(() => {
    createTransportStub.mockClear();
    createClientStub.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("state.keepaliveTickers.has(serverName) is true after a successful auto-reconnect", async () => {
    // reconnectionLoop's success block must call startKeepaliveTicker so the
    // ticker is registered after auto-reconnect.
    //
    // Server config: transport "http" so resolveDefaultKeepaliveIntervalMs
    // returns 30_000 ms (> 0 → ticker actually starts, not a no-op).
    const state = makeState({
      serverName: "srv",
      serverConfig: {
        name: "srv",
        transport: "http",
        url: "http://localhost:3000/mcp",
        enabled: true,
      },
    });

    const fakeTransport = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      onclose: undefined,
      onerror: undefined,
      onmessage: undefined,
    };
    createTransportStub.mockReturnValue(fakeTransport);

    const successClient = makeFakeClient({ connectImpl: async () => {} });
    createClientStub.mockReturnValue(successClient);

    // Pre-existing connected connection
    wireConnected(state, "srv");

    handleDisconnection(state, { logger: NOOP_LOGGER }, "srv", "client_error");

    // Advance 100 ms — enough to fire the 1 ms backoff timer so reconnectionLoop
    // runs to completion and calls startKeepaliveTicker, but NOT enough to fire
    // the 30 000 ms keepalive interval (which would loop forever in runAllTimersAsync).
    await vi.advanceTimersByTimeAsync(100);

    expect(state.keepaliveTickers.has("srv")).toBe(true);
  });
});
