// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for connectServer's OAuth path.
 *
 * Coverage for the connect-time OAuth wiring:
 *
 *   8. needs_oauth_login: a connect against an
 *      auth:"oauth" server whose client.connect throws the SDK UnauthorizedError
 *      resolves a Result.err TAGGED `needs_oauth_login` (NOT a thrown error, NOT
 *      a browser launch). Asserts no openUrl/browser side effect occurred.
 *   9. pre-flight discovery: connecting an auth:"oauth" server with no
 *      persisted discoveryState triggers resolveDiscovery exactly once BEFORE the
 *      connect, and the resolved provider is threaded onto the runtime config so
 *      createTransport attaches it.
 *
 * The MCP SDK Client is mocked so we control whether connect throws
 * UnauthorizedError without standing up a real OAuth-protected transport. The
 * token store + deduper are real (tmpdir + discovery is stubbed via an injected
 * resolveDiscovery spy).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import PQueue from "p-queue";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { connectServer, isNeedsOAuthLoginError } from "./mcp-client-connect.js";
import { createTokenStore, type TokenStore } from "./oauth/token-store.js";
import type { RefreshResult } from "./oauth/refresh-deduper.js";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpConnection,
  McpClientManagerOptions,
  CircuitState,
  McpServerConfig,
} from "./mcp-client-types.js";

// ---------------------------------------------------------------------------
// Mock the MCP SDK Client so connect() throwing UnauthorizedError is
// deterministic. createClient (in mcp-client-discover.ts) constructs a
// `new Client(...)`; we replace the class with a configurable fake.
// ---------------------------------------------------------------------------

let connectImpl: () => Promise<void>;

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class FakeClient {
    async connect(): Promise<void> {
      return connectImpl();
    }
    async listTools(): Promise<{ tools: unknown[] }> {
      return { tools: [] };
    }
    getInstructions(): undefined {
      return undefined;
    }
    getServerCapabilities(): undefined {
      return undefined;
    }
    getServerVersion(): undefined {
      return undefined;
    }
    async close(): Promise<void> {
      /* noop */
    }
    onclose?: () => void;
    onerror?: (e: Error) => void;
  }
  return { Client: FakeClient };
});

// The redirect-policy fetch is irrelevant here (we never reach the network); the
// real createTransport runs but the FakeClient.connect ignores the transport.

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeOptions(): McpClientManagerOptions {
  return {
    connectTimeoutMs: 5000,
    callToolTimeoutMs: 5000,
    stdioDefaultConcurrency: 1,
    httpDefaultConcurrency: 4,
    reconnectOpts: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 30_000, growFactor: 2 },
    keepaliveIntervalMs: 0,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
  };
}

function makeState(): McpClientManagerState {
  return {
    connections: new Map<string, McpConnection>(),
    reconnectionAbortControllers: new Map(),
    userDisconnectedFlags: new Set<string>(),
    serverConfigs: new Map<string, McpServerConfig>(),
    generations: new Map<string, number>(),
    callQueues: new Map<string, PQueue>(),
    keepaliveQueues: new Map<string, PQueue>(),
    consecutiveErrors: new Map<string, number>(),
    lastStderr: new Map<string, string>(),
    keepaliveTickers: new Map(),
    circuitBreakers: new Map<string, CircuitState>(),
    idleEvictionTimers: new Map(),
    lastActivityMs: new Map<string, number>(),
    inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
    options: makeOptions(),
  };
}

describe("connectServer — OAuth path", () => {
  let dir: string;
  let store: TokenStore;
  let logger: ReturnType<typeof makeLogger>;
  let openUrl: ReturnType<typeof vi.fn>;
  let resolveDiscoverySpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-connect-oauth-"));
    logger = makeLogger();
    openUrl = vi.fn();
    store = createTokenStore({
      tokensDir: dir,
      confinedBaseDir: dir,
      logger,
      watchPersistent: false,
    });
    resolveDiscoverySpy = vi.fn(
      async (): Promise<OAuthDiscoveryState> =>
        ({ authorizationServerUrl: "http://127.0.0.1:1/" }) as OAuthDiscoveryState,
    );
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDeps(): McpClientManagerDeps {
    return {
      logger,
      oauthDeps: {
        createTokenStore: () => store,
        resolveDiscovery: resolveDiscoverySpy,
        openUrl,
      },
    } as unknown as McpClientManagerDeps;
  }

  const OAUTH_CONFIG: McpServerConfig = {
    name: "notion",
    transport: "http",
    url: "http://127.0.0.1:9/mcp",
    enabled: true,
    auth: "oauth",
    oauth: { scope: "read" },
  };

  it("returns a needs_oauth_login-tagged Result.err on UnauthorizedError (no browser launch)", async () => {
    connectImpl = () => Promise.reject(new UnauthorizedError("auth required"));

    const state = makeState();
    const deps = makeDeps();
    const result = await connectServer(state, deps, OAUTH_CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    // The error is TAGGED so the daemon RPC layer can surface needs_oauth_login.
    expect(isNeedsOAuthLoginError(result.error)).toBe(true);
    // No browser was launched daemon-side.
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("returns needs_oauth_login on StreamableHTTPError 401 (no provider attached, first-install)", async () => {
    connectImpl = () =>
      Promise.reject(
        new StreamableHTTPError(401, 'Error POSTing to endpoint: {"error":"Unauthorized"}'),
      );

    const state = makeState();
    const deps = makeDeps();
    const result = await connectServer(state, deps, {
      name: "higgsfield",
      transport: "http",
      url: "https://mcp.higgsfield.ai/mcp",
      enabled: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    // The error MUST be tagged so mcp-handlers.ts sees isNeedsOAuthLoginError.
    expect(isNeedsOAuthLoginError(result.error)).toBe(true);
    // No browser was launched daemon-side.
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("runs pre-flight discovery exactly once before connect for an auth:'oauth' server with no meta", async () => {
    // A successful connect (no 401) — discovery must still have run first.
    connectImpl = () => Promise.resolve();

    const state = makeState();
    const deps = makeDeps();
    const result = await connectServer(state, deps, OAUTH_CONFIG);

    expect(result.ok).toBe(true);
    expect(resolveDiscoverySpy).toHaveBeenCalledTimes(1);
    // The provider was threaded onto the stored runtime config so a reconnect /
    // createTransport sees it.
    const stored = state.serverConfigs.get("notion");
    expect(stored?.oauthProvider).toBeDefined();
  });

  it("does NOT run pre-flight discovery when discoveryState is already persisted (warm load)", async () => {
    connectImpl = () => Promise.resolve();
    // Persist a discovery state so the pre-flight is skipped.
    await store.saveDiscoveryState("notion", {
      authorizationServerUrl: "http://127.0.0.1:1/",
    } as OAuthDiscoveryState);

    const state = makeState();
    const deps = makeDeps();
    const result = await connectServer(state, deps, OAUTH_CONFIG);

    expect(result.ok).toBe(true);
    expect(resolveDiscoverySpy).not.toHaveBeenCalled();
  });

  it("does NOT construct an OAuth provider for a non-oauth server", async () => {
    connectImpl = () => Promise.resolve();

    const state = makeState();
    const deps = makeDeps();
    const result = await connectServer(state, deps, {
      name: "plain",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
      enabled: true,
    });

    expect(result.ok).toBe(true);
    expect(resolveDiscoverySpy).not.toHaveBeenCalled();
    expect(state.serverConfigs.get("plain")?.oauthProvider).toBeUndefined();
  });

  it("a non-Unauthorized connect failure is NOT tagged needs_oauth_login", async () => {
    connectImpl = () => Promise.reject(new Error("ECONNREFUSED"));

    const state = makeState();
    const deps = makeDeps();
    const result = await connectServer(state, deps, OAUTH_CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(isNeedsOAuthLoginError(result.error)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// connectServer — stdio failure DIAGNOSABILITY. Regression for the credentialed
// stdio-MCP install investigation: a server that spawns credential-less exits
// with the opaque SDK "Connection closed"; the child's OWN error text ("… is
// required") + a class-specific hint + a lifecycle event must reach the caller
// and the obs layer — not just a separate DEBUG log line to hand-correlate.
// ---------------------------------------------------------------------------
describe("connectServer — stdio failure diagnosability", () => {
  const STDIO_CONFIG: McpServerConfig = {
    name: "svc",
    transport: "stdio",
    command: "npx",
    args: ["-y", "example-mcp"],
    enabled: true,
    osvCheckEnabled: false, // skip the network OSV lookup in unit tests
  };

  function makeBus(): { bus: { emit: (e: string, p: unknown) => void }; emitted: Array<{ event: string; payload: unknown }> } {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    return { bus: { emit: (event, payload) => { emitted.push({ event, payload }); } }, emitted };
  }

  it("folds the child's captured stderr into the returned error + error-state entry", async () => {
    const state = makeState();
    // Simulate the child writing its OWN error to stderr during the attempt (→
    // captured on state.lastStderr by wireStderrCapture in production) and THEN
    // the transport closing — the real "Connection closed" sequence.
    connectImpl = () => {
      state.lastStderr.set("svc", "Error: SERVICE_USERNAME is a required environment variable\n");
      return Promise.reject(new Error("MCP error -32000: Connection closed"));
    };
    const { bus } = makeBus();
    const deps = { logger: makeLogger(), eventBus: bus } as unknown as McpClientManagerDeps;

    const result = await connectServer(state, deps, STDIO_CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.message).toContain("SERVICE_USERNAME is a required");
    expect(state.connections.get("svc")?.error).toContain("SERVICE_USERNAME is a required");
  });

  it("sanitizes a credential leaked in the child stderr before folding it into the error + error-state entry", async () => {
    const state = makeState();
    // A credentialed server that dies while echoing its own connection string to
    // stderr — the exact leak vector for a stdio server given secrets via env.
    connectImpl = () => {
      state.lastStderr.set(
        "svc",
        "FATAL: could not connect: postgres://admin:s3cr3tPassw0rd@db.internal:5432/prod\n",
      );
      return Promise.reject(new Error("MCP error -32000: Connection closed"));
    };
    const { bus } = makeBus();
    const deps = { logger: makeLogger(), eventBus: bus } as unknown as McpClientManagerDeps;

    const result = await connectServer(state, deps, STDIO_CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    // The raw password must NOT survive into any sink the agent/operator sees.
    expect(result.error.message).not.toContain("s3cr3tPassw0rd");
    expect(state.connections.get("svc")?.error).not.toContain("s3cr3tPassw0rd");
    // …and the folded stderr is redacted, not simply dropped.
    expect(result.error.message).toContain("[REDACTED_CONN_STRING]");
    expect(state.connections.get("svc")?.error).toContain("[REDACTED_CONN_STRING]");
  });

  it("emits mcp:server:connect_failed with reason server_exited on a stdio crash", async () => {
    const state = makeState();
    connectImpl = () => {
      state.lastStderr.set("svc", "boom");
      return Promise.reject(new Error("MCP error -32000: Connection closed"));
    };
    const { bus, emitted } = makeBus();
    const deps = { logger: makeLogger(), eventBus: bus } as unknown as McpClientManagerDeps;

    await connectServer(state, deps, STDIO_CONFIG);

    const ev = emitted.find((e) => e.event === "mcp:server:connect_failed");
    expect(ev).toBeDefined();
    expect((ev!.payload as { reason: string }).reason).toBe("server_exited");
    expect((ev!.payload as { serverName: string }).serverName).toBe("svc");
  });

  it("classifies an ENOENT spawn failure as command_not_found", async () => {
    connectImpl = () => Promise.reject(new Error("spawn npx ENOENT"));
    const state = makeState();
    const { bus, emitted } = makeBus();
    const deps = { logger: makeLogger(), eventBus: bus } as unknown as McpClientManagerDeps;

    const result = await connectServer(state, deps, STDIO_CONFIG);

    expect(result.ok).toBe(false);
    const ev = emitted.find((e) => e.event === "mcp:server:connect_failed");
    expect((ev!.payload as { reason: string }).reason).toBe("command_not_found");
  });

  it("on a stdio failure with NO stderr, the failure log names the missing-env class", async () => {
    connectImpl = () => Promise.reject(new Error("MCP error -32000: Connection closed"));
    const state = makeState();
    const logger = makeLogger();
    const { bus } = makeBus();
    const deps = { logger, eventBus: bus } as unknown as McpClientManagerDeps;

    await connectServer(state, deps, STDIO_CONFIG);

    const errCalls = logger.error.mock.calls.map((c: unknown[]) => JSON.stringify(c));
    expect(errCalls.some((s: string) => /missing.*env|required env|env var/i.test(s))).toBe(true);
  });

  it("emits mcp:server:connected on a successful connect", async () => {
    connectImpl = () => Promise.resolve();
    const state = makeState();
    const { bus, emitted } = makeBus();
    const deps = { logger: makeLogger(), eventBus: bus } as unknown as McpClientManagerDeps;

    const result = await connectServer(state, deps, STDIO_CONFIG);

    expect(result.ok).toBe(true);
    const ev = emitted.find((e) => e.event === "mcp:server:connected");
    expect(ev).toBeDefined();
    expect((ev!.payload as { serverName: string }).serverName).toBe("svc");
  });
});
