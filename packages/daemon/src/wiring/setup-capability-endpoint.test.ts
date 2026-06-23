// SPDX-License-Identifier: Apache-2.0
/**
 * `createCapabilityEndpoint` — the loopback capability endpoint deny-matrix
 * (ENDPOINT-01 / ENDPOINT-02; Phase 211 Plan 06).
 *
 * The endpoint is a NEAR-CLONE of the shipped `createAgentRpcCall`: validate the
 * bearer against the LeaseManager (timing-safe, not-expired, not-revoked,
 * audience-bound) → inject `_capabilities` (= lease.caps) AND `_agentId`
 * (= lease.agentId) → dispatch through the SAME `createRpcDispatch` sink. So
 * ENDPOINT-02's deny matrix is MOSTLY the automatic consequence of the two
 * injections + a denylist pre-check + the validate function — not new gate code:
 *   - bad/expired/revoked lease → `validate` returns null → deny, no dispatch.
 *   - cap-not-held → the lease caps are injected verbatim → the handler's
 *     `requireCapability` throws `CapabilityDeniedError` (the endpoint adds NO
 *     second gate; it injects caps and lets the shipped gate fire).
 *   - denylisted tool → the `SUB_AGENT_TOOL_DENYLIST` pre-check denies BEFORE
 *     dispatch.
 *   - unknown method → the dispatch sink's own `if (!handler) throw` fires when
 *     the method is absent from `handlers[]` (a valid lease is NOT sufficient —
 *     this is distinct from the denylist pre-check; proven through the REAL
 *     sink logic + real `assertNotAgentOrigin`, FIX-1 in the plan revision).
 *   - admin method → because the endpoint injects `_agentId`, the real
 *     `assertNotAgentOrigin` chokepoint denies-by-origin (RESEARCH Pitfall 2).
 *
 * This suite uses the REAL `createLeaseManager` (@comis/infra — shipped,
 * unit-proven) for the lease lifecycle, and a faithful minimal dispatch sink
 * built from the REAL `assertNotAgentOrigin` + the exact `if (!handler) throw`
 * + `ADMIN_METHODS` logic of `rpc-dispatch.ts:494-513` for the unknown-method
 * and admin-deny-by-origin cases, so the deny matrix is unit-testable WITHOUT a
 * real socket or the full `createRpcDispatch` deps superset.
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { createLeaseManager, type LeaseManager } from "@comis/infra";
import {
  API_CONTRACTS_ORDERED,
  requireCapability,
  CapabilityDeniedError,
  type AgentCapability,
  type ClockPort,
} from "@comis/core";
import { assertNotAgentOrigin } from "../api/shared/assert-not-agent-origin.js";
import type { RpcCall } from "@comis/skills/platform-tools";
import { createCapabilityEndpoint } from "./setup-capability-endpoint.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A test ClockPort backed by a mutable epoch so soft/hard expiry is steerable. */
function createTestClock(startMs = 1_700_000_000_000): ClockPort & { advance(ms: number): void } {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

/** The set of admin-scoped RPC methods, derived EXACTLY as rpc-dispatch.ts:159-161 does. */
const ADMIN_METHODS: ReadonlySet<string> = new Set(
  API_CONTRACTS_ORDERED.filter((c) => c.scopes.includes("admin")).map((c) => c.method),
);

/**
 * A faithful minimal replica of the createRpcDispatch sink (rpc-dispatch.ts:494-513):
 * the SAME `if (!handler) throw` unknown-method deny, the SAME ADMIN_METHODS →
 * `assertNotAgentOrigin` deny-by-origin chokepoint (using the REAL guard), over
 * the supplied handler map. Used to prove the endpoint's injections trigger the
 * shipped sink behavior, without constructing the full ApiDispatchDeps superset.
 */
function createRealSinkOver(
  handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>>,
): RpcCall {
  const captured: { emit: ReturnType<typeof vi.fn> } = { emit: vi.fn() };
  const sinkDeps = {
    container: { eventBus: { emit: captured.emit }, config: { tenantId: "test" } },
  };
  return async (method: string, params: Record<string, unknown>) => {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unknown RPC method: ${method}`);
    }
    if (ADMIN_METHODS.has(method)) {
      assertNotAgentOrigin(params, sinkDeps, method);
    }
    return handler(params);
  };
}

/** Mint a valid lease over the real LeaseManager and return the bearer. */
function mintValidLease(
  mgr: LeaseManager,
  caps: AgentCapability[],
  agentId = "agent-test",
): string {
  const { bearer } = mgr.mintLease({
    agentId,
    caps,
    budgetRef: "budget-1",
    sessionKey: "tenant:channel:user",
    rootRunId: "run-1",
  });
  return bearer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCapabilityEndpoint deny-matrix and dispatch", () => {
  // The real audience surface (HANDLER_CAPABILITY_MAP) maps exactly 5 caps to
  // methods: orch:cron→cron.*, orch:graph→graph.*, orch:message→message.send/…,
  // orch:skill→skills.*, orch:spawn→session.spawn. So in-audience test methods
  // MUST come from that set; `cron.add` (orch:cron) is the canonical valid call.

  // ENDPOINT-01: a valid lease over an in-audience method dispatches with the
  // injected _agentId + _capabilities (mirroring createAgentRpcCall).
  it("dispatches a valid lease call injecting _agentId and _capabilities from the lease", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const caps: AgentCapability[] = ["orch:cron"];
    const bearer = mintValidLease(leaseManager, caps, "agent-42");

    const rpcCall = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    // cron.add is an orch:cron method (in audience for caps=["orch:cron"]).
    const result = await endpoint.handleCapCall(bearer, "cron.add", { schedule: "x" });

    expect(rpcCall).toHaveBeenCalledTimes(1);
    const [calledMethod, calledParams] = rpcCall.mock.calls[0];
    expect(calledMethod).toBe("cron.add");
    // The Pitfall-2 injection: BOTH _agentId AND _capabilities, from the lease.
    expect(calledParams._agentId).toBe("agent-42");
    expect(calledParams._capabilities).toEqual(["orch:cron"]);
    // The original params survive the spread.
    expect(calledParams.schedule).toBe("x");
    expect(result).toEqual({ ok: true });
  });

  // CR-01 (ORIGIN-02 at the socket boundary): the wire `params` are
  // FULLY attacker-controlled (the jailed script the lease authenticates). A
  // forged `_X` control field MUST NOT reach the dispatch sink — only the
  // lease-derived `_agentId`/`_capabilities` are trusted. Without the
  // stripInternalFields() at this boundary, a forged `_trustLevel:"admin"`
  // reaches `authorizeChannelAccess` (which early-returns admin) and a forged
  // `_agentId` impersonates another agent, defeating deny-by-origin. This
  // mirrors the strip the external gateway path applies (setup-gateway-api.ts).
  it("strips forged internal _X fields from the wire params before injecting the trusted lease ones", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-real");

    const rpcCall = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    // The wire payload forges EVERY high-value control field: a privilege
    // escalation (_trustLevel:"admin"), an agent impersonation (_agentId), a
    // caps broadening (_capabilities), plus origin/identity spoofs.
    await endpoint.handleCapCall(bearer, "cron.add", {
      schedule: "x",
      _trustLevel: "admin",
      _agentId: "someone-else",
      _capabilities: ["admin"],
      _userId: "victim",
      _callerChannelId: "forged-channel",
      _tenantId: "forged-tenant",
    });

    expect(rpcCall).toHaveBeenCalledTimes(1);
    const [, calledParams] = rpcCall.mock.calls[0];

    // The legitimate non-internal param survives.
    expect(calledParams.schedule).toBe("x");
    // ONLY the lease-derived trusted values reach the sink — the forged ones
    // were stripped, then the lease values injected on top.
    expect(calledParams._agentId).toBe("agent-real");
    expect(calledParams._capabilities).toEqual(["orch:cron"]);
    // The forged control fields are ABSENT (not merely overridden): every
    // INTERNAL_FIELD_NAME the wire carried must be gone before injection.
    expect("_trustLevel" in calledParams).toBe(false);
    expect("_userId" in calledParams).toBe(false);
    expect("_callerChannelId" in calledParams).toBe(false);
    expect("_tenantId" in calledParams).toBe(false);
  });

  // ENDPOINT-02: a bad/garbage bearer is denied (validate returns null), and the
  // dispatch sink is NOT called.
  it("denies a bad bearer (validate null) and never dispatches", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await expect(endpoint.handleCapCall("not-a-real-bearer", "cron.add", {})).rejects.toThrow();
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // ENDPOINT-02: an expired (soft-expired) lease is denied.
  it("denies an expired lease and never dispatches", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"]);
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    // Advance past the default 15-min soft TTL (the lease was minted at t0;
    // the default maxTtl is also 15 min, so advancing 16 min soft-then-hard
    // expires it — either way validate returns null).
    clock.advance(16 * 60 * 1000);

    await expect(endpoint.handleCapCall(bearer, "cron.add", {})).rejects.toThrow();
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // ENDPOINT-02: a revoked lease is denied.
  it("denies a revoked lease and never dispatches", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const { bearer, leaseId } = leaseManager.mintLease({
      agentId: "agent-r",
      caps: ["orch:cron"],
      budgetRef: "b",
      sessionKey: "t:c:u",
      rootRunId: "run-r",
    });
    leaseManager.revoke(leaseId);
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await expect(endpoint.handleCapCall(bearer, "cron.add", {})).rejects.toThrow();
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // ENDPOINT-02 (audience): a valid lease replayed at a method OUTSIDE its caps'
  // audience is denied by validate (the requested method is threaded into
  // validate, so a captured lease cannot be replayed elsewhere).
  it("denies a valid lease replayed at a method outside its capability audience", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    // caps grant orch:cron only; graph.define requires orch:graph → out of audience.
    const bearer = mintValidLease(leaseManager, ["orch:cron"]);
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await expect(endpoint.handleCapCall(bearer, "graph.define", {})).rejects.toThrow();
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // ENDPOINT-02 (denylist): a denylisted tool is denied by the pre-check BEFORE
  // dispatch (the rpcCall is never reached) — even with a lease minted for it.
  // skills.create is the LOAD-BEARING case: it is orch:skill (so a lease holding
  // orch:skill PASSES audience) AND non-admin (so deny-by-origin does NOT fire) —
  // ONLY the SUB_AGENT_TOOL_DENYLIST pre-check stops it.
  it("denies a denylisted skills.create via the pre-check before dispatch even with an in-audience lease", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    // The lease HOLDS orch:skill — so audience for skills.create would pass; the
    // denylist pre-check is the only thing that can deny it.
    const bearer = mintValidLease(leaseManager, ["orch:skill"]);
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await expect(endpoint.handleCapCall(bearer, "skills.create", {})).rejects.toThrow(/denylist/);
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // ENDPOINT-02 (denylist, admin family): a denylisted admin tool (agents.create)
  // is also denied by the pre-check before dispatch (defense-in-depth on top of
  // the audience + deny-by-origin boundaries).
  it("denies a denylisted agents.create via the pre-check before dispatch", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"]);
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await expect(endpoint.handleCapCall(bearer, "agents.create", {})).rejects.toThrow(/denylist/);
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // ENDPOINT-02 (cap-not-held): the endpoint injects the lease caps VERBATIM and
  // adds NO second gate, so the shipped per-handler requireCapability fires for a
  // cap the lease lacks. Proven by dispatching through a sink whose handler runs
  // the REAL requireCapability against the injected _capabilities. The lease
  // holds orch:cron (so cron.add passes audience); the handler requires orch:graph
  // (a cap the lease does NOT hold) → CapabilityDeniedError.
  it("passes lease caps through faithfully so a cap-not-held call hits requireCapability", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"]);

    const sink = createRealSinkOver({
      "cron.add": async (params: Record<string, unknown>) => {
        // The injected _capabilities are exactly the lease caps (orch:cron only);
        // requiring orch:graph proves the endpoint did NOT broaden them and the
        // shipped gate fires on a cap-not-held.
        expect(params._capabilities).toEqual(["orch:cron"]);
        requireCapability(params._capabilities as string[], "orch:graph");
        return { ran: true };
      },
    });
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall: sink });

    await expect(endpoint.handleCapCall(bearer, "cron.add", {})).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });

  // ENDPOINT-02 (unknown method): a valid bearer over an IN-AUDIENCE method that
  // is nonetheless ABSENT from the handler map is denied by the REAL dispatch
  // sink's `if (!handler) throw` — distinct from the denylist pre-check and NOT
  // satisfied by a valid lease alone (FIX-1 in the plan revision).
  it("denies an unknown method through the real dispatch sink's !handler throw", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    // The lease is in-audience for cron.add (orch:cron) — so validate PASSES; the
    // deny must come from the sink because cron.add is absent from handlers[].
    const bearer = mintValidLease(leaseManager, ["orch:cron"]);
    const sink = createRealSinkOver({
      // intentionally NO "cron.add" entry — only an unrelated handler.
      "graph.list": async () => ({ unused: true }),
    });
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall: sink });

    await expect(endpoint.handleCapCall(bearer, "cron.add", {})).rejects.toThrow(
      /Unknown RPC method/,
    );
  });

  // ENDPOINT-02 (admin → denied): an admin method is DENIED through the endpoint.
  // By design NO admin method maps to an orch:* cap (the capability model grants
  // only non-admin orchestration), so the lease audience denies every admin
  // method at `validate` (the first gate) — the handler is never reached, with
  // ALL caps granted. (The deny-by-origin chokepoint is the defense-in-depth
  // SECOND gate, proven independently below.)
  it("denies an admin method (out of every lease's audience) and never dispatches", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });

    // Grant the lease ALL caps so audience cannot be circumvented by a missing
    // cap — yet an admin method is still denied (no admin method is in audience).
    const allCaps: AgentCapability[] = [
      "orch:spawn",
      "orch:graph",
      "orch:cron",
      "orch:message",
      "orch:skill",
      "orch:read",
      "orch:web",
      "orch:analyze",
      "orch:write",
      "orch:browse",
    ];
    const bearer = mintValidLease(leaseManager, allCaps);

    // gateway.restart is an admin method (and denylisted) — denied long before
    // any handler. Pick a NON-denylisted admin method too to prove the audience
    // gate (not only the denylist) denies admin. `secrets.get` is admin and not
    // in DENYLISTED_RPC_METHODS, so its deny is the audience gate.
    const adminNonDenylisted = "secrets.get";
    expect(ADMIN_METHODS.has(adminNonDenylisted)).toBe(true);

    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await expect(endpoint.handleCapCall(bearer, adminNonDenylisted, {})).rejects.toThrow();
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // ENDPOINT-02 (Pitfall 2 — the deny-by-origin chokepoint is load-bearing):
  // the endpoint injects _agentId, so IF an _agentId-bearing call reached an
  // admin method at the dispatch sink, the REAL assertNotAgentOrigin would deny
  // it by origin. This proves the second gate fires on exactly the shape the
  // endpoint injects (independent of the audience gate above).
  it("the injected _agentId triggers the real assertNotAgentOrigin at an admin method in the sink", async () => {
    const adminMethod = [...ADMIN_METHODS][0];
    expect(adminMethod).toBeDefined();

    const sink = createRealSinkOver({
      [adminMethod]: async () => ({ shouldNotReach: true }),
    });

    // The exact params the endpoint injects (the _agentId is the agent-origin
    // signal assertNotAgentOrigin reads). The sink must deny-by-origin.
    await expect(sink(adminMethod, { _agentId: "agent-x", _capabilities: [] })).rejects.toThrow(
      /not reachable from an agent origin/,
    );

    // And the SAME admin method with NO _agentId (operator origin) passes the
    // chokepoint — proving the guard keys on the injected _agentId, not the method.
    await expect(sink(adminMethod, {})).resolves.toEqual({ shouldNotReach: true });
  });
});

// ---------------------------------------------------------------------------
// tool.invoke — the one-route dispatch (DISPATCH-01/02; Phase 212 Plan 02)
// ---------------------------------------------------------------------------

describe("createCapabilityEndpoint tool.invoke dispatch", () => {
  // DISPATCH-01 (rpc route): tool.invoke({tool:"memory_search"}) for an orch:read
  // lease routes to the registered RPC method with strip-then-inject (the lease's
  // _agentId is the only one the sink sees — self-scoping CR-01).
  it("routes an rpc-kind tool to its registered method with strip-then-inject", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:read"], "agent-read");

    const rpcCall = vi.fn(async (_m: string, _p: Record<string, unknown>) => ({ hits: [] }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    const result = await endpoint.handleCapCall(bearer, "tool.invoke", {
      tool: "memory_search",
      args: { q: "x" },
    });

    expect(rpcCall).toHaveBeenCalledTimes(1);
    const [method, params] = rpcCall.mock.calls[0];
    // TOOL_ROUTE_MAP["memory_search"] === { kind:"rpc", method:"memory.search_files" }.
    expect(method).toBe("memory.search_files");
    // The inner args reach the sink, stripped + with the lease-derived identity.
    expect(params.q).toBe("x");
    expect(params._agentId).toBe("agent-read");
    expect(params._capabilities).toEqual(["orch:read"]);
    expect(result).toEqual({ hits: [] });
  });

  // DISPATCH-01 (executor route): tool.invoke({tool:"web_fetch"}) for an orch:web
  // lease routes to the INJECTED toolInvokeExecutor (NOT rpcCall).
  it("routes an executor-kind tool to the injected toolInvokeExecutor (not rpcCall)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:web"], "agent-web");

    const rpcCall = vi.fn(async () => ({ unused: true }));
    const toolInvokeExecutor = vi.fn(async () => ({ url: "https://x", text: "body" }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, toolInvokeExecutor });

    const result = await endpoint.handleCapCall(bearer, "tool.invoke", {
      tool: "web_fetch",
      args: { url: "https://x" },
    });

    expect(rpcCall).not.toHaveBeenCalled(); // executor route — the sink is bypassed
    expect(toolInvokeExecutor).toHaveBeenCalledTimes(1);
    const [tool, args, lease] = toolInvokeExecutor.mock.calls[0];
    expect(tool).toBe("web_fetch");
    expect(args).toEqual({ url: "https://x" });
    expect(lease).toMatchObject({ agentId: "agent-web", caps: ["orch:web"] });
    expect(result).toEqual({ url: "https://x", text: "body" });
  });

  // DISPATCH-02 (default-deny): an unmapped tool → CapabilityDeniedError.
  it("denies an unmapped tool with CapabilityDeniedError (default-deny by absence)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:read", "orch:web"]);

    const rpcCall = vi.fn(async () => ({ ok: true }));
    const toolInvokeExecutor = vi.fn(async () => ({}));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, toolInvokeExecutor });

    await expect(
      endpoint.handleCapCall(bearer, "tool.invoke", { tool: "definitely_not_a_tool", args: {} }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(rpcCall).not.toHaveBeenCalled();
    expect(toolInvokeExecutor).not.toHaveBeenCalled();
  });

  // DISPATCH (denylist, defense-in-depth): an unmapped AND denylisted tool is
  // denied. `gateway` is not on the cap-map (unmapped → CapabilityDeniedError);
  // the deny fires either way. (The cap-map absence is the first gate.)
  it("denies an unmapped+denylisted tool (gateway) — never dispatched", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:read"]);

    const rpcCall = vi.fn(async () => ({ ok: true }));
    const toolInvokeExecutor = vi.fn(async () => ({}));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, toolInvokeExecutor });

    await expect(
      endpoint.handleCapCall(bearer, "tool.invoke", { tool: "gateway", args: {} }),
    ).rejects.toThrow();
    expect(rpcCall).not.toHaveBeenCalled();
    expect(toolInvokeExecutor).not.toHaveBeenCalled();
  });

  // DISPATCH (requireCapability): tool.invoke({tool:"web_fetch"}) with a lease
  // holding ONLY orch:read is denied at requireCapability — orch:web is the cap
  // for web_fetch. NOTE: the lease audience (Task 1) ALSO denies this at validate
  // (the inner tool's cap is out of audience), so the deny may surface there; the
  // point is web_fetch is unreachable with an orch:read-only lease.
  it("denies web_fetch for an orch:read-only lease (cap not held)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:read"]); // NOT orch:web

    const rpcCall = vi.fn(async () => ({ ok: true }));
    const toolInvokeExecutor = vi.fn(async () => ({}));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, toolInvokeExecutor });

    await expect(
      endpoint.handleCapCall(bearer, "tool.invoke", { tool: "web_fetch", args: { url: "https://x" } }),
    ).rejects.toThrow();
    expect(toolInvokeExecutor).not.toHaveBeenCalled();
  });

  // IN-02 (loose args contract): an ARRAY passed as `args` must NOT slip through
  // the `typeof === "object"` branch as an index-keyed object (`{0:…,1:…}`) — it
  // is not a valid named-args object. Tighten the guard so an array degrades to
  // empty named args (like any other non-object), never index-keyed fields the
  // sink would mis-read.
  it("treats an array args as empty named args (does not forward index-keyed fields)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:read"], "agent-arr");

    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await endpoint.handleCapCall(bearer, "tool.invoke", {
      tool: "memory_search",
      args: ["a", "b", "c"],
    });

    const [, params] = rpcCall.mock.calls[0];
    // No index-keyed fields from the array leaked into the dispatched params.
    expect("0" in params).toBe(false);
    expect("1" in params).toBe(false);
    expect("2" in params).toBe(false);
    // The lease-derived identity is still injected (the dispatch path is intact).
    expect(params._agentId).toBe("agent-arr");
  });

  // DISPATCH (strip-then-inject / S2): forged _agentId/_trustLevel in the inner
  // args are stripped; the rpc route receives the lease's _agentId (NOT the forged
  // "victim") — the self-scoping integrity prerequisite (CR-01 / T-212-06).
  it("strips forged _X fields from the inner args on the rpc route", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:read"], "agent-honest");

    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await endpoint.handleCapCall(bearer, "tool.invoke", {
      tool: "memory_search",
      args: { q: "x", _agentId: "victim", _trustLevel: "admin", _capabilities: ["admin"] },
    });

    const [, params] = rpcCall.mock.calls[0];
    expect(params.q).toBe("x");
    expect(params._agentId).toBe("agent-honest"); // lease wins, not "victim"
    expect(params._capabilities).toEqual(["orch:read"]);
    expect("_trustLevel" in params).toBe(false); // forged escalation stripped
  });

  // DISPATCH (admin unreachable): no admin tool is cap-mapped, so tool.invoke
  // cannot reach an admin handler — an admin-ish tool name is unmapped → denied.
  it("cannot reach an admin tool via tool.invoke (agents_create unmapped → denied)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:read", "orch:web"]);

    const rpcCall = vi.fn(async () => ({ ok: true }));
    const toolInvokeExecutor = vi.fn(async () => ({}));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, toolInvokeExecutor });

    await expect(
      endpoint.handleCapCall(bearer, "tool.invoke", { tool: "agents_create", args: {} }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // The existing handleCapCall method-path is UNCHANGED — a direct method call
  // (cron.add) still dispatches with the injection (regression guard for the
  // tool.invoke special-case not perturbing the default path).
  it("leaves the direct-method handleCapCall path unchanged (cron.add regression)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-cron");

    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await endpoint.handleCapCall(bearer, "cron.add", { schedule: "x" });
    const [method, params] = rpcCall.mock.calls[0];
    expect(method).toBe("cron.add");
    expect(params._agentId).toBe("agent-cron");
  });
});

// ---------------------------------------------------------------------------
// Socket server lifecycle (0600 owner-only, mirroring mitm-broker.startUnixSocket)
// ---------------------------------------------------------------------------

describe("createCapabilityEndpoint socket server", () => {
  it("starts a 0600 owner-only socket and stops it cleanly", async () => {
    const { mkdtempSync, statSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    const dir = mkdtempSync(join(tmpdir(), "cap-sock-"));
    const socketPath = join(dir, "cap.sock");

    await endpoint.startSocket(socketPath);
    expect(existsSync(socketPath)).toBe(true);
    // Owner-only: rw------- (0o600). Mask the permission bits.
    const mode = statSync(socketPath).mode & 0o777;
    expect(mode).toBe(0o600);

    await endpoint.stopSocket();
    // The socket file is unlinked on stop.
    expect(existsSync(socketPath)).toBe(false);
  });

  // WR-01: a client that connects and pushes > MAX_LINE_BYTES without ever
  // sending a newline must have its connection destroyed (bounded receive
  // buffer) — otherwise `buf` grows without bound (OOM vector from a jailed
  // client). Assert the socket is closed by the server after oversize input.
  it("destroys a connection that overflows the receive buffer without a newline", async () => {
    const net = await import("node:net");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    const dir = mkdtempSync(join(tmpdir(), "cap-sock-ovf-"));
    const socketPath = join(dir, "cap.sock");
    await endpoint.startSocket(socketPath);

    const client = net.connect(socketPath);
    // Swallow the client-side EPIPE/ECONNRESET that the server's destroy() races
    // against the client's in-flight write — that's the expected outcome here,
    // not a test failure (an unhandled "error" would surface as an uncaught).
    client.on("error", () => {});
    await new Promise<void>((res) => client.on("connect", () => res()));

    const closed = new Promise<void>((res) => client.on("close", () => res()));
    // Push 128 KiB with NO newline — over the 64 KiB cap. The server must
    // destroy the connection (the client observes "close").
    client.write("x".repeat(128 * 1024));

    await closed; // resolves only because the server destroyed the connection.
    // rpcCall was never reached (no complete line was ever parsed).
    expect(rpcCall).not.toHaveBeenCalled();

    await endpoint.stopSocket();
  });

  // WR-01: stopSocket() must not hang on a non-terminating client. A bare
  // net.Server.close() waits for live connections to drain, so a connection
  // that never sends a newline (and never closes) would wedge shutdown forever.
  // The endpoint destroys tracked sockets before close — assert stop resolves.
  it("stops cleanly even with a connected client that never sends a newline", async () => {
    const net = await import("node:net");
    const { mkdtempSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    const dir = mkdtempSync(join(tmpdir(), "cap-sock-hang-"));
    const socketPath = join(dir, "cap.sock");
    await endpoint.startSocket(socketPath);

    const client = net.connect(socketPath);
    await new Promise<void>((res) => client.on("connect", () => res()));
    // Send a partial line (no newline) and then just sit there — the connection
    // stays open and idle. Without socket tracking + destroy, stopSocket hangs.
    client.write('{"bearer":"x","method":"cron.add"');

    // If stopSocket hangs, this race rejects and the test fails (vs a silent
    // timeout); on the fix it resolves well under the budget.
    await Promise.race([
      endpoint.stopSocket(),
      new Promise<never>((_res, rej) =>
        setTimeout(() => rej(new Error("stopSocket did not resolve — stuck connection wedged shutdown")), 2000),
      ),
    ]);
    expect(existsSync(socketPath)).toBe(false);
    client.destroy();
  });

  // WR-02 (§2.7): the socket boundary is observable through the injected logger
  // — the bind emits an INFO and a receive-buffer overflow emits a WARN carrying
  // the canonical errorKind/hint (not an empty catch). This proves the logger is
  // threaded and that a boundary event is reconstructable from logs.
  it("logs the socket bind and a receive-buffer overflow with canonical errorKind and hint", async () => {
    const net = await import("node:net");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const rpcCall = vi.fn(async () => ({ ok: true }));

    const info = vi.fn();
    const warn = vi.fn();
    // A minimal logger whose child() returns a logger carrying the spies (the
    // endpoint binds a `submodule` child, mirroring the production logger).
    const childLogger = { debug: vi.fn(), info, warn, error: vi.fn() };
    const logger = { child: vi.fn(() => childLogger) } as unknown as Parameters<
      typeof createCapabilityEndpoint
    >[0]["logger"];
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, logger });

    const dir = mkdtempSync(join(tmpdir(), "cap-sock-log-"));
    const socketPath = join(dir, "cap.sock");
    await endpoint.startSocket(socketPath);

    // The bind is logged once at INFO.
    expect(info).toHaveBeenCalledTimes(1);

    const client = net.connect(socketPath);
    client.on("error", () => {}); // expected EPIPE when the server destroys mid-write
    await new Promise<void>((res) => client.on("connect", () => res()));
    const closed = new Promise<void>((res) => client.on("close", () => res()));
    client.write("x".repeat(128 * 1024)); // > 64 KiB cap, no newline → overflow
    await closed;

    // The overflow is logged at WARN with the canonical fields.
    expect(warn).toHaveBeenCalledTimes(1);
    const [overflowFields] = warn.mock.calls[0];
    expect((overflowFields as { errorKind?: unknown }).errorKind).toBe("validation");
    expect(typeof (overflowFields as { hint?: unknown }).hint).toBe("string");

    await endpoint.stopSocket();
  });
});
