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
    expect(result.error).toMatchObject({
      code: "mcp_call_deadline_exceeded",
      configKey: "integrations.mcp.callToolTimeoutMs",
      configuredMs: state.options.callToolTimeoutMs,
      queueWaitedMs: expect.any(Number),
      requestBudgetMs: expect.any(Number),
    });
  });

  it("tells the caller NOT to retry unchanged (the retry storm is the failure mode)", async () => {
    const serverName = "vendor-mcp";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
    );

    const result = await callTool(
      state,
      deps,
      `mcp:${serverName}/vendor_activity_report`,
      { report_range: "month" },
    );
    if (result.ok) throw new Error("expected err");
    // An identical retry deterministically re-expires the same deadline.
    expect(result.error.message).toMatch(/do not retry (it |the call )?unchanged/i);
    // …and it names the two things that DO change the outcome.
    expect(result.error.message).toMatch(/narrow/i);
  });

  it("does not recommend narrowing a timed-out call that supplied no input arguments", async () => {
    const serverName = "vendor-mcp";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
    );

    const result = await callTool(state, deps, `mcp:${serverName}/status`, {});
    if (result.ok) throw new Error("expected err");

    expect(result.error.message).toMatch(/no input arguments/i);
    expect(result.error.message).not.toMatch(/narrow the request|smaller page|fewer entities/i);
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
        // Remaining budget, not the raw configured deadline (see the queue-wait tests).
        timeout: expect.any(Number),
        onprogress: expect.any(Function),
        resetTimeoutOnProgress: true,
        maxTotalTimeout: expect.any(Number),
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
    // A ceiling derived from the deadline, less whatever the queue wait already spent
    // (~0 here). Banded rather than exact so it asserts the ceiling exists and derives
    // from the configured deadline, without re-breaking on scheduling jitter.
    expect(opts.maxTotalTimeout).toBeGreaterThan(state.options.callToolTimeoutMs / 2);
    expect(opts.maxTotalTimeout).toBeLessThanOrEqual(state.options.callToolTimeoutMs);
  });

  // The ceiling must not be scoped to the tracing branch. Tying it to
  // `requestTraceId` left every untraced path — which is where long-running
  // background calls run — with no ceiling at all. Live: after a first cut that
  // gated it, a background task still recorded 140233ms against a 120000ms cap.
  it("applies the absolute ceiling even with no request trace context", async () => {
    const serverName = "inventory";
    const state = makeConnectedState(serverName, () =>
      Promise.resolve({ content: [{ type: "text", text: "{}" }] }),
    );
    const deps = { logger: makeLogger() } as unknown as McpClientManagerDeps;

    // No runWithContext → no requestTraceId.
    await callTool(state, deps, `mcp:${serverName}/inventory_items_list`, {});

    const opts = (state.connections.get(serverName)?.client.callTool as ReturnType<typeof vi.fn>)
      .mock.calls[0]![2] as Record<string, number>;
    expect(opts.maxTotalTimeout).toBeGreaterThan(state.options.callToolTimeoutMs / 2);
    expect(opts.maxTotalTimeout).toBeLessThanOrEqual(state.options.callToolTimeoutMs);
  });
});

// ---------------------------------------------------------------------------
// Caller-visible deadline: queue wait counts against the budget
// ---------------------------------------------------------------------------

/**
 * `callToolTimeoutMs` is documented, surfaced, and reconciled against the enclosing
 * sub-agent stall budget as THE call deadline. But it was handed to the SDK as the
 * budget for the request alone, while the interval a caller (and any enclosing budget)
 * actually experiences also covers the per-server PQueue wait — concurrency 1 for stdio.
 * So N sub-agents fanning out onto one server serialize, and the (N+1)-th call's
 * caller-visible latency is N x deadline + its own.
 *
 * Live: a 120000ms deadline produced a 186570ms caller-visible call (55% over) while the
 * expiry hint told the agent the deadline was deterministic and to narrow its request
 * scope — misdirecting it, since the call had spent most of that time queued behind a
 * sibling, not being slow. It also makes the `config_posture:tool_deadline_collision`
 * check unsound: "lower callToolTimeoutMs below subagent.timeout" cannot hold when the
 * deadline bounds only part of the interval the sub-agent budget encloses.
 */
describe("call deadline covers the queue wait", () => {
  const deps = { logger: makeLogger() } as unknown as McpClientManagerDeps;

  it("deducts the queue wait from the deadline handed to the SDK", async () => {
    const serverName = "inventory";
    // First call holds the concurrency-1 slot long enough to be measurable.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let callIndex = 0;
    const state = makeConnectedState(serverName, () => {
      callIndex += 1;
      return callIndex === 1
        ? gate.then(() => ({ content: [{ type: "text", text: "{}" }] }))
        : Promise.resolve({ content: [{ type: "text", text: "{}" }] });
    });

    const first = callTool(state, deps, `mcp:${serverName}/slow_report`, {});
    const second = callTool(state, deps, `mcp:${serverName}/slow_report`, {});
    await new Promise((r) => setTimeout(r, 250));
    release?.();
    await Promise.all([first, second]);

    const calls = (state.connections.get(serverName)?.client.callTool as ReturnType<typeof vi.fn>)
      .mock.calls;
    const secondOpts = calls[1]![2] as Record<string, number>;
    // The queued call must not receive the FULL deadline — it already spent ~250ms of it.
    expect(secondOpts.maxTotalTimeout).toBeLessThan(state.options.callToolTimeoutMs);
    expect(secondOpts.timeout).toBe(secondOpts.maxTotalTimeout);
  });

  it("fails fast naming queue contention when the wait alone exhausts the deadline", async () => {
    const serverName = "inventory";
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let callIndex = 0;
    const state = makeConnectedState(serverName, () => {
      callIndex += 1;
      return callIndex === 1
        ? gate.then(() => ({ content: [{ type: "text", text: "{}" }] }))
        : Promise.resolve({ content: [{ type: "text", text: "{}" }] });
    });
    state.options = { ...state.options, callToolTimeoutMs: 200 };

    const first = callTool(state, deps, `mcp:${serverName}/slow_report`, {});
    const second = callTool(state, deps, `mcp:${serverName}/slow_report`, {});
    await new Promise((r) => setTimeout(r, 400));
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult.ok).toBe(false);
    const message = secondResult.ok ? "" : secondResult.error.message;
    // Must blame contention, not the server's speed, and name the knob that fixes it.
    expect(message).toMatch(/queue|contention|concurren/i);
    expect(message).toContain("maxConcurrency");
    // And it must state the budget floor the remainder fell under — without it, a
    // refusal that still had deadline left reads as a self-contradiction.
    expect(message).toMatch(/\d+ms a request needs to be worth issuing/);
    // And it must NOT have issued a doomed request against an already-blown budget.
    const calls = (state.connections.get(serverName)?.client.callTool as ReturnType<typeof vi.fn>)
      .mock.calls;
    expect(calls.length).toBe(1);
    // The FIRST call held the slot from an EMPTY queue — it must have been issued.
    // (Clamping the viability floor to a sub-floor deadline refused it after a 1ms
    // wait, which flipped the gated call onto `second` and made this test a coin toss.)
    expect(firstResult.ok).toBe(true);
  });

  // Deadlines at or below MIN_VIABLE_CALL_BUDGET_MS (250ms) clamp the viability floor
  // to the deadline itself, so `remainingMs < floor` was true for ANY non-zero wait:
  // a call was refused for "queue contention" after waiting 1ms on an idle server,
  // pointing the operator at `maxConcurrency` for a queue that was never contended.
  it("issues calls whose short wait leaves a sub-floor deadline nearly intact", async () => {
    const serverName = "inventory";
    let callIndex = 0;
    const state = makeConnectedState(serverName, () => {
      callIndex += 1;
      // The first call holds the concurrency-1 slot for a few ms — a real but tiny
      // slice of the deadline, nothing like exhausting it.
      return callIndex === 1
        ? new Promise((r) => setTimeout(() => r({ content: [{ type: "text", text: "{}" }] }), 5))
        : Promise.resolve({ content: [{ type: "text", text: "{}" }] });
    });
    state.options = { ...state.options, callToolTimeoutMs: 200 };

    const first = callTool(state, deps, `mcp:${serverName}/slow_report`, {});
    const second = callTool(state, deps, `mcp:${serverName}/slow_report`, {});
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    // Both reached the server: ~195ms of a 200ms deadline is the budget the operator
    // chose, not a contention refusal.
    const calls = (state.connections.get(serverName)?.client.callTool as ReturnType<typeof vi.fn>)
      .mock.calls;
    expect(calls.length).toBe(2);
  });

  it("removes a cancelled queued call before it consumes the server slot", async () => {
    const serverName = "inventory";
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callIndex = 0;
    const state = makeConnectedState(serverName, () => {
      callIndex += 1;
      return callIndex === 1
        ? gate.then(() => ({ content: [{ type: "text", text: "first" }] }))
        : Promise.resolve({ content: [{ type: "text", text: "cancelled call ran" }] });
    });
    const ac = new AbortController();
    const abortableCallTool = callTool as unknown as (
      state: McpClientManagerState,
      deps: McpClientManagerDeps,
      qualifiedName: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => ReturnType<typeof callTool>;

    const first = callTool(state, deps, `mcp:${serverName}/slow_report`, {});
    const second = abortableCallTool(
      state,
      deps,
      `mcp:${serverName}/slow_report`,
      {},
      ac.signal,
    );
    ac.abort();
    release?.();
    const [, secondResult] = await Promise.all([first, second]);

    expect(secondResult.ok).toBe(false);
    expect(state.connections.get(serverName)?.client.callTool).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// MCP breaker trips must reach the observability pipeline
// ---------------------------------------------------------------------------

/**
 * There are TWO circuit breakers. The agent-side tool-retry breaker emits
 * `tool:breaker_opened`, which is what feeds `bridgeResult.breakerTripCount` → the
 * session-health rollup → the trajectory `tool.breaker_opened` record → the OTel
 * `comis.breaker_trips` metric → `system-health`'s breaker trips and `explain`'s breaker
 * timeline. The MCP per-server breaker emitted NOTHING: it flipped
 * `state.circuitBreakers`, started returning `[server_unavailable]`, logged a WARN, and
 * left every counter at zero.
 *
 * Live: an MCP server was circuit-broken — visible only as bracketed sentinel text inside
 * tool results and one daemon.log WARN — while every session rollup reported
 * `breakerTripCount: 0`. A number that reads as "no breaker ever tripped" when one had is
 * worse than a missing field, because triage trusts it and stops looking.
 */
describe("MCP breaker trips are observable", () => {
  function makeBus() {
    return { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  }

  // Repeated TIMEOUTS, which is how the threshold is actually reached in production: a
  // non-timeout failure marks the connection "error", so the next call short-circuits at the
  // status pre-check and the counter never climbs. A timeout deliberately preserves
  // connection status, so successive heavy calls accumulate against the threshold — the live
  // shape, where the same slow report expired its deadline until the breaker opened.
  it("emits tool:breaker_opened when the failure threshold trips the breaker", async () => {
    const serverName = "inventory";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
    );
    const bus = makeBus();
    const deps = { logger: makeLogger(), eventBus: bus } as unknown as McpClientManagerDeps;

    // Threshold is 3 (makeOptions) — the third failure opens it.
    for (let i = 0; i < 3; i += 1) {
      await callTool(state, deps, `mcp:${serverName}/slow_report`, {});
    }

    const trips = bus.emit.mock.calls.filter((c) => c[0] === "tool:breaker_opened");
    expect(trips.length).toBe(1);
    const payload = trips[0]![1] as Record<string, unknown>;
    expect(payload.consecutiveFailures).toBe(3);
    expect(String(payload.toolName)).toContain(serverName);
    expect(typeof payload.reason).toBe("string");
    expect(typeof payload.errorTag).toBe("string");
    expect(typeof payload.timestamp).toBe("number");
  });

  it("emits tool:breaker_opened on the immediate 401 auth trip", async () => {
    const serverName = "higgsfield";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new UnauthorizedError("401 Unauthorized")),
    );
    const bus = makeBus();
    const deps = { logger: makeLogger(), eventBus: bus } as unknown as McpClientManagerDeps;

    await callTool(state, deps, `mcp:${serverName}/generate_video`, {});

    const trips = bus.emit.mock.calls.filter((c) => c[0] === "tool:breaker_opened");
    expect(trips.length).toBe(1);
    // The auth trip must be distinguishable from a threshold trip — the remediation differs
    // (re-authenticate vs wait out a cooldown).
    expect(String((trips[0]![1] as Record<string, unknown>).reason)).toMatch(/auth/i);
  });

  it("does not emit while failures remain below the threshold", async () => {
    const serverName = "inventory";
    const state = makeConnectedState(serverName, () =>
      Promise.reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
    );
    const bus = makeBus();
    const deps = { logger: makeLogger(), eventBus: bus } as unknown as McpClientManagerDeps;

    await callTool(state, deps, `mcp:${serverName}/slow_report`, {});

    expect(bus.emit.mock.calls.filter((c) => c[0] === "tool:breaker_opened").length).toBe(0);
  });
});
