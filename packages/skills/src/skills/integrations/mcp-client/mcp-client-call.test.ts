// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for callTool — R8 needs_reauth on 401, circuit-breaker auth trip.
 *
 * Covers:
 *   - 401/UnauthorizedError during a tool call → structured [needs_reauth] result
 *     (not a generic error, not a thrown exception)
 *   - Circuit breaker is tripped IMMEDIATELY on first 401 (bypasses threshold)
 *   - Subsequent call when breaker was tripped by auth → returns [needs_reauth],
 *     NOT [server_unavailable]
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import PQueue from "p-queue";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { runWithContext, type RequestContext } from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpConnection,
  McpClientManagerOptions,
  McpServerConfig,
} from "./mcp-client-types.js";
import type { CircuitState } from "./mcp-client-types.js";
import type { RefreshResult } from "./oauth/refresh-deduper.js";
import { callTool } from "./mcp-client-call.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeContext(): RequestContext {
  return {
    tenantId: "default",
    userId: "user_a",
    agentId: "agent_a",
    sessionKey: "default:user_a:telegram:chat_a",
    traceId: "40000000-0000-4000-8000-000000000004",
    startedAt: 1,
    trustLevel: "user",
    channelType: "telegram",
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
    keepaliveTickers: new Map(),
    circuitBreakers: new Map<string, CircuitState>(),
    idleEvictionTimers: new Map(),
    lastActivityMs: new Map<string, number>(),
    inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
    options: makeOptions(),
  };
}

/** Build a fake McpConnection with a client whose callTool behaviour is controlled by callImpl. */
function makeConnectedState(
  serverName: string,
  callImpl: () => Promise<unknown>,
): McpClientManagerState {
  const state = makeState();
  const fakeClient = {
    callTool: vi.fn(callImpl),
  };
  const conn: McpConnection = {
    name: serverName,
    client: fakeClient as unknown as McpConnection["client"],
    status: "connected",
    tools: [],
    lastHealthCheck: Date.now(),
    reconnectAttempt: 0,
    maxReconnectAttempts: 5,
    generation: 1,
  };
  state.connections.set(serverName, conn);
  const queue = new PQueue({ concurrency: 1 });
  state.callQueues.set(serverName, queue);
  return state;
}

// ---------------------------------------------------------------------------
// R8 needs_reauth tests
// ---------------------------------------------------------------------------

describe("R8 needs_reauth", () => {
  let logger: ReturnType<typeof makeLogger>;
  let deps: McpClientManagerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = makeLogger();
    deps = { logger } as unknown as McpClientManagerDeps;
  });

  it("returns needs_reauth result (not generic error) when tool call returns 401", async () => {
    const serverName = "higgsfield";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new UnauthorizedError("401 Unauthorized")),
    );

    const result = await callTool(state, deps, `mcp:${serverName}/generate_video`, {});

    // Must be ok (structured result), not err
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.value.content[0]?.text).toMatch(/^\[needs_reauth\]/);
    expect(result.value.isError).toBe(true);
  });

  it("trips circuit breaker immediately on 401 (bypass threshold)", async () => {
    const serverName = "higgsfield";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new UnauthorizedError("401 Unauthorized")),
    );

    // threshold is 3 — one 401 must trip it immediately, not after 3 failures
    await callTool(state, deps, `mcp:${serverName}/generate_video`, {});

    const breaker = state.circuitBreakers.get(serverName);
    expect(breaker?.status).toBe("open");
    // reason must be "auth" so subsequent calls return needs_reauth, not server_unavailable
    expect((breaker as { reason?: string })?.reason).toBe("auth");
  });

  it("returns needs_reauth (not server_unavailable) on subsequent call when breaker was tripped by auth", async () => {
    const serverName = "higgsfield";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new UnauthorizedError("401 Unauthorized")),
    );

    // First call: trips the breaker via 401
    await callTool(state, deps, `mcp:${serverName}/generate_video`, {});

    // Second call: breaker is open (tripped by auth), must return [needs_reauth]
    const result2 = await callTool(state, deps, `mcp:${serverName}/generate_video`, {});

    expect(result2.ok).toBe(true);
    if (!result2.ok) throw new Error("expected ok");

    expect(result2.value.content[0]?.text).toMatch(/^\[needs_reauth\]/);
    expect(result2.value.content[0]?.text).not.toMatch(/^\[server_unavailable\]/);
    expect(result2.value.isError).toBe(true);
  });
});

describe("request correlation", () => {
  it("registers MCP progress handling while forwarding the request trace separately", async () => {
    const serverName = "inventory";
    const state = makeConnectedState(serverName, () =>
      Promise.resolve({ content: [{ type: "text", text: "{}" }] }),
    );
    const deps = { logger: makeLogger() } as unknown as McpClientManagerDeps;

    const result = await runWithContext(makeContext(), () =>
      callTool(state, deps, `mcp:${serverName}/inventory_items_list`, { name_contains: "item" }),
    );

    expect(result.ok).toBe(true);
    expect(state.connections.get(serverName)?.client.callTool).toHaveBeenCalledWith(
      {
        name: "inventory_items_list",
        arguments: { name_contains: "item" },
        _meta: {
          "comis.ai/requestTraceId": "40000000-0000-4000-8000-000000000004",
        },
      },
      undefined,
      {
        timeout: 5000,
        onprogress: expect.any(Function),
        resetTimeoutOnProgress: true,
      },
    );
  });
});
