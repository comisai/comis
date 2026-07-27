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
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
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

describe("call timeout names its knob", () => {
  // Observed live: a heavy report tool hit the 120s
  // `integrations.mcp.callToolTimeoutMs` FOUR times. The surfaced error was the bare
  // SDK string "MCP error -32001: Request timed out", with a wrapper hint saying
  // "retry the underlying operation when appropriate" — so the agent retried 4x,
  // burned 8 minutes of the user's time, and tripped the circuit breaker. The error
  // must name the knob + the value that expired, and must NOT invite a blind retry.
  let logger: ReturnType<typeof makeLogger>;
  let deps: McpClientManagerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = makeLogger();
    deps = { logger } as unknown as McpClientManagerDeps;
  });

  it("names integrations.mcp.callToolTimeoutMs and the configured value in the error", async () => {
    const serverName = "vendor-mcp";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
    );

    const result = await callTool(state, deps, `mcp:${serverName}/vendor_activity_report`, {});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    const message = result.error.message;
    expect(message).toContain("integrations.mcp.callToolTimeoutMs");
    // the ACTUAL configured value, so the operator does not have to go look it up
    expect(message).toContain(String(state.options.callToolTimeoutMs));
    expect(message).toContain(serverName);
  });

  it("tells the caller NOT to retry unchanged (the retry storm is the failure mode)", async () => {
    const serverName = "vendor-mcp";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
    );

    const result = await callTool(state, deps, `mcp:${serverName}/vendor_activity_report`, {});
    if (result.ok) throw new Error("expected err");
    // An identical retry deterministically re-expires the same deadline.
    expect(result.error.message).toMatch(/do not retry (it |the call )?unchanged/i);
    // …and it names the two things that DO change the outcome.
    expect(result.error.message).toMatch(/narrow/i);
  });

  it("does not send the agent to patch the knob — that config path is immutable at runtime", async () => {
    // Observed live: the hint's closing clause read "or raise
    // `integrations.mcp.callToolTimeoutMs` for this deployment", so the agent did
    // exactly that — one `gateway` patch call, rejected by the immutable-path guard
    // ("Cannot patch immutable config path: integrations.mcp.callToolTimeoutMs.
    // Patchable: integrations.mcp.servers."). The rejection surfaced in the chat as a
    // bare "[tool failure] gateway reported an error" on top of the real answer.
    // Naming the knob is right (an operator needs it); telling the AGENT to raise it
    // is not — the only remedy available to the caller is narrowing the request.
    const serverName = "vendor-mcp";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
    );

    const result = await callTool(state, deps, `mcp:${serverName}/vendor_activity_report`, {});
    if (result.ok) throw new Error("expected err");
    const message = result.error.message;

    // Still names the knob and its value — the operator-facing half is unchanged.
    expect(message).toContain("integrations.mcp.callToolTimeoutMs");
    // But never phrases it as an action the caller can take.
    expect(message).not.toMatch(/\braise\b|\bincrease\b/i);
    // …and says whose job it is, so the agent stops instead of trying a patch.
    expect(message).toMatch(/operator/i);
  });

  it("emits a WARN carrying the same hint + a dependency errorKind", async () => {
    const serverName = "vendor-mcp";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
    );

    await callTool(state, deps, `mcp:${serverName}/vendor_activity_report`, {});

    const timeoutWarn = logger.warn.mock.calls.find(
      (c) => typeof c[1] === "string" && /timed out/i.test(c[1] as string),
    );
    expect(timeoutWarn).toBeDefined();
    const fields = timeoutWarn![0] as Record<string, unknown>;
    expect(fields.errorKind).toBe("dependency");
    expect(String(fields.hint)).toContain("integrations.mcp.callToolTimeoutMs");
    expect(fields.timeoutMs).toBe(state.options.callToolTimeoutMs);
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
        maxTotalTimeout: 5000,
      },
    );
  });

  // `resetTimeoutOnProgress` restarts the timeout on EVERY progress
  // notification, and the SDK applies no total ceiling unless `maxTotalTimeout`
  // is passed ("If not specified, there is no maximum total timeout"). So a
  // server that emits progress held a call open indefinitely while the config
  // key, the docs, and the expiry hint all called it the call deadline. Live:
  // a 120000ms cap with observed call durations of 139478ms and 110004ms, and
  // single calls free to consume the whole turn budget.
  it("bounds a progress-emitting call with an absolute ceiling, not just a per-gap timeout", async () => {
    const serverName = "inventory";
    const state = makeConnectedState(serverName, () =>
      Promise.resolve({ content: [{ type: "text", text: "{}" }] }),
    );
    const deps = { logger: makeLogger() } as unknown as McpClientManagerDeps;

    await runWithContext(makeContext(), () =>
      callTool(state, deps, `mcp:${serverName}/inventory_items_list`, {}),
    );

    const opts = (state.connections.get(serverName)?.client.callTool as ReturnType<typeof vi.fn>)
      .mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.resetTimeoutOnProgress).toBe(true);
    expect(opts.maxTotalTimeout).toBe(state.options.callToolTimeoutMs);
  });
});
