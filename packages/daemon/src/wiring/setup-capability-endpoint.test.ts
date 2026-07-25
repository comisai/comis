// SPDX-License-Identifier: Apache-2.0
/**
 * `createCapabilityEndpoint` — the loopback capability endpoint deny-matrix.
 *
 * The endpoint is a NEAR-CLONE of the shipped `createAgentRpcCall`: validate the
 * bearer against the LeaseManager (timing-safe, not-expired, not-revoked,
 * audience-bound) → inject `_capabilities` (= lease.caps) AND `_agentId`
 * (= lease.agentId) → dispatch through the SAME `createRpcDispatch` sink. So
 * the deny matrix is MOSTLY the automatic consequence of the two
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
 *     sink logic + real `assertNotAgentOrigin`).
 *   - admin method → because the endpoint injects `_agentId`, the real
 *     `assertNotAgentOrigin` chokepoint denies-by-origin.
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
  conversationScopeToSessionKey,
  formatSessionKey,
  tryGetContext,
  type AgentCapability,
  type ClockPort,
  type DeliveryOrigin,
  type ResolvedTurnScope,
} from "@comis/core";
import { resolveAutonomy } from "@comis/core";
import { assertNotAgentOrigin } from "../api/shared/assert-not-agent-origin.js";
import type { RpcCall } from "@comis/skills/platform-tools";
import { createResultRefStore } from "@comis/skills/tools";
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createCapabilityEndpoint,
  createReplayRecorder,
  replayParamsDigest,
  type ReplayRecorder,
} from "./setup-capability-endpoint.js";
import type { BoundedAutonomy } from "../autonomy/bounded-autonomy.js";

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

function leaseIdentity(agentId: string, origin: DeliveryOrigin): {
  turnScope: ResolvedTurnScope;
  sessionKey: string;
} {
  const endpoint = {
    channelType: origin.channelType,
    channelInstanceId: "capability-test",
    conversationId: origin.channelId,
    ...(origin.threadId !== undefined ? { threadId: origin.threadId } : {}),
    conversationKind: "direct" as const,
  };
  const turnScope: ResolvedTurnScope = {
    conversation: {
      tenantId: origin.tenantId,
      agentId,
      partition: {
        kind: "endpoint-conversation-principal",
        endpoint,
        principalId: origin.userId,
      },
    },
    principal: { principalId: origin.userId },
    endpoint,
  };
  const projected = conversationScopeToSessionKey(turnScope.conversation);
  if (!projected.ok) throw projected.error;
  return { turnScope, sessionKey: formatSessionKey(projected.value) };
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
  const emitSafely = vi.fn((event: string, payload: unknown) => {
    captured.emit(event, payload);
    return { hadListeners: false, failures: [], pendingFailures: Promise.resolve([]) };
  });
  const sinkDeps = {
    container: {
      eventBus: { emit: captured.emit, emitSafely },
      config: { tenantId: "test" },
    },
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
  const endpoint = {
    channelType: "internal",
    channelInstanceId: "capability-test",
    conversationId: "user",
    conversationKind: "direct" as const,
  };
  const { bearer } = mgr.mintLease({
    agentId,
    caps,
    budgetRef: "budget-1",
    sessionKey: "tenant:channel:user",
    trustLevel: "user",
    deliveryOrigin: {
      channelType: endpoint.channelType,
      channelId: endpoint.conversationId,
      userId: "user",
      tenantId: "tenant",
    },
    turnScope: {
      conversation: {
        tenantId: "tenant",
        agentId,
        partition: {
          kind: "endpoint-conversation-principal",
          endpoint,
          principalId: "user",
        },
      },
      principal: { principalId: "user" },
      endpoint,
    },
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

  // A valid lease over an in-audience method dispatches with the
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

  // At the socket boundary the wire `params` are
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
    // Forged values are replaced by the validated lease principal.
    expect(calledParams._trustLevel).toBe("user");
    expect(calledParams._userId).toBe("user");
    expect(calledParams._callerChannelId).toBe("user");
    expect(calledParams._tenantId).toBe("tenant");
  });

  it("dispatches session.spawn inside a locked principal derived only from the validated lease", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const deliveryOrigin = {
      channelType: "telegram",
      channelId: "chat-a",
      userId: "user-a",
      tenantId: "tenant-a",
      threadId: "topic-a",
    };
    const identity = leaseIdentity("parent-agent", deliveryOrigin);
    const leaseInput = {
      agentId: "parent-agent",
      caps: ["orch:spawn"] as AgentCapability[],
      budgetRef: "budget-spawn",
      sessionKey: identity.sessionKey,
      trustLevel: "user" as const,
      rootRunId: "root-spawn",
      deliveryOrigin,
      turnScope: identity.turnScope,
    };
    const { bearer } = leaseManager.mintLease(leaseInput);
    const rpcCall = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      const context = tryGetContext();
      expect(context).toMatchObject({
        tenantId: "tenant-a",
        userId: "user-a",
        sessionKey: identity.sessionKey,
        agentId: "parent-agent",
        channelType: "telegram",
        trustLevel: "user",
        deliveryOrigin: leaseInput.deliveryOrigin,
      });
      expect(Object.getOwnPropertyDescriptor(context, "agentId")).toMatchObject({
        writable: false,
        configurable: false,
      });
      expect(Object.isFrozen(context?.deliveryOrigin)).toBe(true);
      return { accepted: true, params };
    });
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await endpoint.handleCapCall(bearer, "session.spawn", {
      task: "bounded task",
      agent_id: "child-agent",
      _agentId: "forged-agent",
      _callerSessionKey: "forged:session:key",
      _callerChannelType: "discord",
      _callerChannelId: "forged-channel",
    });

    const [, calledParams] = rpcCall.mock.calls[0]!;
    expect(calledParams).toMatchObject({
      task: "bounded task",
      agent_id: "child-agent",
      _agentId: "parent-agent",
      _callerSessionKey: identity.sessionKey,
      _callerChannelType: "telegram",
      _callerChannelId: "chat-a",
      _capabilities: ["orch:spawn"],
    });
  });

  it("reconstructs the lease principal and trusted routing fields for every direct RPC", async () => {
    const leaseManager = createLeaseManager({ clock: createTestClock() });
    const deliveryOrigin = {
      channelType: "telegram",
      channelId: "chat-a",
      userId: "user-a",
      tenantId: "tenant-a",
    };
    const identity = leaseIdentity("agent-a", deliveryOrigin);
    const issued = leaseManager.mintLease({
      agentId: "agent-a",
      caps: ["orch:cron"],
      budgetRef: "budget-a",
      sessionKey: "tenant-a:user-a:chat-a",
      trustLevel: "user",
      deliveryOrigin,
      ...identity,
      rootRunId: "root-a",
      checkpointId: "checkpoint-a",
      parentLeaseId: "lease-parent",
    });
    const rpcCall = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      expect(tryGetContext()).toMatchObject({
        tenantId: "tenant-a",
        userId: "user-a",
        sessionKey: identity.sessionKey,
        agentId: "agent-a",
        trustLevel: "user",
        deliveryOrigin,
      });
      expect(params).toMatchObject({
        _agentId: "agent-a",
        _capabilities: ["orch:cron"],
        _rootRunId: "root-a",
        _leaseId: issued.leaseId,
        _parentLeaseId: "lease-parent",
        _checkpointId: "checkpoint-a",
        _trustLevel: "user",
        _callerSessionKey: identity.sessionKey,
        _callerChannelType: "telegram",
        _callerChannelId: "chat-a",
        _deliveryTarget: {
          channelType: "telegram",
          channelId: "chat-a",
          userId: "user-a",
          tenantId: "tenant-a",
        },
      });
      return { ok: true };
    });
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await endpoint.handleCapCall(issued.bearer, "cron.add", {
      payload_kind: "agent_turn",
      _trustLevel: "admin",
      _callerChannelId: "forged",
    });
  });

  it("reconstructs the same lease principal for RPC-backed tool.invoke routes", async () => {
    const leaseManager = createLeaseManager({ clock: createTestClock() });
    const deliveryOrigin = {
      channelType: "telegram",
      channelId: "chat-a",
      userId: "user-a",
      tenantId: "tenant-a",
    };
    const identity = leaseIdentity("agent-a", deliveryOrigin);
    const issued = leaseManager.mintLease({
      agentId: "agent-a",
      caps: ["orch:read"],
      budgetRef: "budget-a",
      sessionKey: "tenant-a:user-a:chat-a",
      trustLevel: "guest",
      deliveryOrigin,
      ...identity,
      rootRunId: "root-a",
      checkpointId: "checkpoint-a",
    });
    const rpcCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe("memory.search_files");
      expect(tryGetContext()).toMatchObject({
        agentId: "agent-a",
        trustLevel: "guest",
        deliveryOrigin,
      });
      expect(params).toMatchObject({
        query: "needle",
        _agentId: "agent-a",
        _rootRunId: "root-a",
        _checkpointId: "checkpoint-a",
        _callerSessionKey: identity.sessionKey,
        _callerChannelId: "chat-a",
      });
      return { matches: [] };
    });
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await endpoint.handleCapCall(issued.bearer, "tool.invoke", {
      tool: "memory_search",
      args: { query: "needle", _rootRunId: "forged" },
    });
  });

  it("preserves a child session and its distinct requester channel and thread exactly", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const deliveryOrigin = {
      channelType: "telegram",
      channelId: "parent-chat",
      userId: "user-a",
      tenantId: "tenant-a",
      threadId: "parent-topic",
    };
    const identity = leaseIdentity("child-agent", deliveryOrigin);
    const leaseInput = {
      agentId: "child-agent",
      caps: ["orch:spawn"] as AgentCapability[],
      budgetRef: "budget-child",
      sessionKey: identity.sessionKey,
      trustLevel: "user" as const,
      rootRunId: "root-spawn",
      deliveryOrigin,
      turnScope: identity.turnScope,
    };
    const { bearer } = leaseManager.mintLease(leaseInput);
    const rpcCall = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      expect(tryGetContext()).toMatchObject({
        sessionKey: leaseInput.sessionKey,
        agentId: "child-agent",
        deliveryOrigin,
      });
      return params;
    });
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await endpoint.handleCapCall(bearer, "session.spawn", { task: "nested task" });

    expect(rpcCall).toHaveBeenCalledWith("session.spawn", expect.objectContaining({
      _callerSessionKey: leaseInput.sessionKey,
      _callerChannelType: "telegram",
      _callerChannelId: "parent-chat",
    }));
  });

  it.each([
    {
      name: "missing origin",
      sessionKey: "tenant-a:user-a:chat-a",
      deliveryOrigin: undefined,
    },
    {
      name: "malformed session",
      sessionKey: "not-a-session",
      deliveryOrigin: {
        channelType: "telegram", channelId: "chat-a", userId: "user-a", tenantId: "tenant-a",
      },
    },
    {
      name: "cross-user origin",
      sessionKey: "tenant-a:user-a:chat-a",
      deliveryOrigin: {
        channelType: "telegram", channelId: "chat-a", userId: "user-b", tenantId: "tenant-a",
      },
    },
    {
      name: "cross-tenant origin",
      sessionKey: "tenant-a:user-a:chat-a",
      deliveryOrigin: {
        channelType: "telegram", channelId: "chat-a", userId: "user-a", tenantId: "tenant-b",
      },
    },
    {
      name: "malformed origin",
      sessionKey: "tenant-a:user-a:chat-a",
      deliveryOrigin: {
        channelType: "", channelId: "chat-a", userId: "user-a", tenantId: "tenant-a",
      },
    },
  ])("rejects session.spawn with $name before dispatch", async ({ sessionKey, deliveryOrigin }) => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const leaseInput = {
      agentId: "parent-agent",
      caps: ["orch:spawn"] as AgentCapability[],
      budgetRef: "budget-spawn",
      sessionKey,
      trustLevel: "user" as const,
      rootRunId: "root-spawn",
      ...(deliveryOrigin !== undefined ? { deliveryOrigin } : {}),
    };
    const { bearer } = leaseManager.mintLease(leaseInput);
    const rpcCall = vi.fn(async () => ({ accepted: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await expect(endpoint.handleCapCall(bearer, "session.spawn", {
      task: "bounded task",
      agent_id: "child-agent",
    })).rejects.toThrow(/principal/i);
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // A bad/garbage bearer is denied (validate returns null), and the
  // dispatch sink is NOT called.
  it("denies a bad bearer (validate null) and never dispatches", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await expect(endpoint.handleCapCall("not-a-real-bearer", "cron.add", {})).rejects.toThrow();
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // An expired (soft-expired) lease is denied.
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

  // A revoked lease is denied.
  it("denies a revoked lease and never dispatches", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const { bearer, leaseId } = leaseManager.mintLease({
      agentId: "agent-r",
      caps: ["orch:cron"],
      budgetRef: "b",
      sessionKey: "t:c:u",
      trustLevel: "user",
      rootRunId: "run-r",
    });
    leaseManager.revoke(leaseId);
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await expect(endpoint.handleCapCall(bearer, "cron.add", {})).rejects.toThrow();
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // Audience: a valid lease replayed at a method OUTSIDE its caps'
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

  // Denylist: a denylisted tool is denied by the pre-check BEFORE
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

  // Denylist (admin family): a denylisted admin tool (agents.create)
  // is also denied by the pre-check before dispatch (defense-in-depth on top of
  // the audience + deny-by-origin boundaries).
  it("denies a denylisted agents.create via the pre-check before dispatch", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const { bearer } = leaseManager.mintLease({
      agentId: "admin-agent",
      caps: ["orch:cron"],
      budgetRef: "budget-admin",
      sessionKey: "tenant-a:user-a:chat-a",
      trustLevel: "admin",
      rootRunId: "root-admin",
    });
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall });

    await expect(endpoint.handleCapCall(bearer, "agents.create", {})).rejects.toThrow(/denylist/);
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // Cap-not-held: the endpoint injects the lease caps VERBATIM and
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

  // Unknown method: a valid bearer over an IN-AUDIENCE method that
  // is nonetheless ABSENT from the handler map is denied by the REAL dispatch
  // sink's `if (!handler) throw` — distinct from the denylist pre-check and NOT
  // satisfied by a valid lease alone.
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

  it("denies an admin method for a non-admin lease and never dispatches", async () => {
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

  it("dispatches a non-management admin method for an exact admin-trust lease", async () => {
    const leaseManager = createLeaseManager({ clock: createTestClock() });
    const deliveryOrigin = {
      channelType: "telegram",
      channelId: "chat-a",
      userId: "user-a",
      tenantId: "tenant-a",
    };
    const issued = leaseManager.mintLease({
      agentId: "admin-agent",
      caps: [],
      budgetRef: "budget-admin",
      sessionKey: "tenant-a:user-a:chat-a",
      trustLevel: "admin",
      deliveryOrigin,
      ...leaseIdentity("admin-agent", deliveryOrigin),
      rootRunId: "root-admin",
    });
    const handler = vi.fn(async (params: Record<string, unknown>) => {
      expect(params._trustLevel).toBe("admin");
      expect(tryGetContext()?.trustLevel).toBe("admin");
      return { edited: true };
    });
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall: createRealSinkOver({ "message.edit": handler }),
    });

    expect(leaseManager.validate(issued.bearer, "message.edit")?.trustLevel).toBe("admin");
    await expect(endpoint.handleCapCall(issued.bearer, "message.edit", {
      channel_type: "telegram",
      channel_id: "chat-a",
      message_id: "message-a",
      text: "updated",
    })).resolves.toEqual({ edited: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  // The deny-by-origin chokepoint is load-bearing:
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
    // signal assertNotAgentOrigin reads). The lease path carries NO admin trust
    // (no _trustLevel), so the sink must deny-by-origin (the non-admin floor).
    await expect(sink(adminMethod, { _agentId: "agent-x", _capabilities: [] })).rejects.toThrow(
      /not reachable from a non-admin agent origin/,
    );

    // And the SAME admin method with NO _agentId (operator origin) passes the
    // chokepoint — proving the guard keys on the injected _agentId, not the method.
    await expect(sink(adminMethod, {})).resolves.toEqual({ shouldNotReach: true });
  });
});

// ---------------------------------------------------------------------------
// tool.invoke — the one-route dispatch
// ---------------------------------------------------------------------------

describe("createCapabilityEndpoint tool.invoke dispatch", () => {
  // Rpc route: tool.invoke({tool:"memory_search"}) for an orch:read
  // lease routes to the registered RPC method with strip-then-inject (the lease's
  // _agentId is the only one the sink sees — self-scoping).
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

  // Executor route: tool.invoke({tool:"web_fetch"}) for an orch:web
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

  // Default-deny: an unmapped tool → CapabilityDeniedError.
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

  // Denylist (defense-in-depth): an unmapped AND denylisted tool is
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

  // requireCapability: tool.invoke({tool:"web_fetch"}) with a lease
  // holding ONLY orch:read is denied at requireCapability — orch:web is the cap
  // for web_fetch. NOTE: the lease audience ALSO denies this at validate
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

  // Loose args contract: an ARRAY passed as `args` must NOT slip through
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

  // Strip-then-inject: forged _agentId/_trustLevel in the inner
  // args are stripped; the rpc route receives the lease's _agentId (NOT the forged
  // "victim") — the self-scoping integrity prerequisite.
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
    expect(params._trustLevel).toBe("user"); // forged escalation replaced by lease trust
  });

  // Admin unreachable: no admin tool is cap-mapped, so tool.invoke
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

  // A client that connects and pushes > MAX_LINE_BYTES without ever
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

  // stopSocket() must not hang on a non-terminating client. A bare
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

  // The socket boundary is observable through the injected logger
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

// ---------------------------------------------------------------------------
// Per-root + per-socket rate limit + cron self-ownership at the cap ENDPOINT.
// The lease's agentId is authoritative ONLY here (NOT in the shared
// cron-handlers.ts); the cap socket is the agent's only orchestrate egress, so
// the rate limit + cron self-ownership belong at handleCapCall.
// ---------------------------------------------------------------------------

/** A configurable BoundedAutonomy stub for the endpoint's rate-limit + cron-cap
 *  consults. `tryCall`/`tryChurn` default to allow; `cronCount` is provider-backed
 *  (so a test can prove the cap reads the NAMED accessor, not a local counter). */
function makeBoundedAutonomyStub(over: {
  tryCall?: BoundedAutonomy["tryCall"];
  tryChurn?: BoundedAutonomy["tryChurn"];
  cronCount?: (agentId: string) => number;
} = {}): BoundedAutonomy {
  return {
    tryAcquireSpawn: () => ({ ok: true }),
    releaseSpawn: () => {},
    tryCall: over.tryCall ?? (() => ({ ok: true })),
    tryChurn: over.tryChurn ?? (() => ({ ok: true })),
    reserveBudget: () => ({ kind: "ok" }) as ReturnType<BoundedAutonomy["reserveBudget"]>,
    tryOutward: () => ({ ok: true }) as ReturnType<BoundedAutonomy["tryOutward"]>,
    registerRoot: () => {},
    leaseIdsForRoot: () => new Set<string>(),
    cronCount: over.cronCount ?? (() => 0),
    destroy: () => {},
  };
}

describe("createCapabilityEndpoint rate-limit + cron self-ownership", () => {
  // When the bounded-autonomy rate limiter denies (per-root or per-socket
  // over cap), handleCapCall is DENIED before the dispatch sink is reached.
  it("denies a cap call when the rate limiter trips, before dispatch", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-rl");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const boundedAutonomy = makeBoundedAutonomyStub({
      tryCall: () => ({ ok: false, reason: "rate" }),
    });
    const endpoint = createCapabilityEndpoint({
      leaseManager, rpcCall, boundedAutonomy, autonomyConfig: resolveAutonomy({ profile: "standard" }),
    });

    await expect(endpoint.handleCapCall(bearer, "cron.add", { schedule: "x" })).rejects.toThrow();
    // The rate limit denied BEFORE the dispatch sink ran.
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("dispatches normally when under the rate cap", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-ok");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const boundedAutonomy = makeBoundedAutonomyStub(); // tryCall → allow
    const endpoint = createCapabilityEndpoint({
      leaseManager, rpcCall, boundedAutonomy, autonomyConfig: resolveAutonomy({ profile: "standard" }),
    });

    await endpoint.handleCapCall(bearer, "cron.add", { schedule: "x" });
    expect(rpcCall).toHaveBeenCalledTimes(1);
  });

  // A cron mutation forwards with agentId FORCED to the lease's agentId
  // (the forged "OTHER-AGENT" is overwritten) — on BOTH agentId AND _agentId
  // (cron-handlers reads both).
  it("forces agentId := lease.agentId on a cron mutation, overwriting a forged agentId", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "self-agent");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const boundedAutonomy = makeBoundedAutonomyStub();
    const endpoint = createCapabilityEndpoint({
      leaseManager, rpcCall, boundedAutonomy, autonomyConfig: resolveAutonomy({ profile: "standard" }),
    });

    await endpoint.handleCapCall(bearer, "cron.add", {
      agentId: "OTHER-AGENT", payload_kind: "agent_turn", schedule: "* * * * *",
    });

    expect(rpcCall).toHaveBeenCalledTimes(1);
    const [, params] = rpcCall.mock.calls[0];
    // The forged agentId is overwritten by the lease identity on BOTH fields.
    expect(params.agentId).toBe("self-agent");
    expect(params._agentId).toBe("self-agent");
  });

  // A system_event cron is REJECTED (only agent_turn is self-ownable).
  it("rejects a cron mutation with payload_kind:system_event", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "self-agent");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const boundedAutonomy = makeBoundedAutonomyStub();
    const endpoint = createCapabilityEndpoint({
      leaseManager, rpcCall, boundedAutonomy, autonomyConfig: resolveAutonomy({ profile: "standard" }),
    });

    await expect(
      endpoint.handleCapCall(bearer, "cron.add", { payload_kind: "system_event", schedule: "x" }),
    ).rejects.toThrow();
    expect(rpcCall).not.toHaveBeenCalled();
  });

  // agentId:"*" is neutralized to the lease's single agentId (the "*"
  // never reaches the handler from the endpoint path). Uses cron.run (a mutation
  // in the orch:cron audience) — cron.list is `ungated`/out-of-audience, so a
  // cap-lease cannot reach it at all (validate denies it).
  it("neutralizes agentId:'*' to the lease's single agentId on a cron mutation", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "self-agent");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const boundedAutonomy = makeBoundedAutonomyStub();
    const endpoint = createCapabilityEndpoint({
      leaseManager, rpcCall, boundedAutonomy, autonomyConfig: resolveAutonomy({ profile: "standard" }),
    });

    await endpoint.handleCapCall(bearer, "cron.run", { agentId: "*", jobId: "j1" });
    expect(rpcCall).toHaveBeenCalledTimes(1);
    const [, params] = rpcCall.mock.calls[0];
    expect(params.agentId).toBe("self-agent");
    expect(params._agentId).toBe("self-agent");
  });

  // cronSelfMax is enforced via the NAMED boundedAutonomy.cronCount(agentId)
  // accessor (provider-backed) — NOT a handleCapCall-local counter. A wrong/missing
  // production accessor would FAIL this test.
  it("caps cron mutations at cronSelfMax via boundedAutonomy.cronCount(lease.agentId)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "busy-agent");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const cfg = resolveAutonomy({ profile: "standard" });
    // cronCount returns exactly cronSelfMax for THIS lease's agent → at the cap.
    const cronCount = vi.fn((agentId: string) => (agentId === "busy-agent" ? cfg.cronSelfMax : 0));
    const boundedAutonomy = makeBoundedAutonomyStub({ cronCount });
    const endpoint = createCapabilityEndpoint({
      leaseManager, rpcCall, boundedAutonomy, autonomyConfig: cfg,
    });

    await expect(
      endpoint.handleCapCall(bearer, "cron.add", { payload_kind: "agent_turn", schedule: "x" }),
    ).rejects.toThrow();
    expect(rpcCall).not.toHaveBeenCalled();
    // The deny is driven by the NAMED accessor with the lease's agentId.
    expect(cronCount).toHaveBeenCalledWith("busy-agent");
  });

  it("dispatches a cron mutation when under cronSelfMax (cronCount < cap)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "calm-agent");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const cfg = resolveAutonomy({ profile: "standard" });
    const boundedAutonomy = makeBoundedAutonomyStub({ cronCount: () => 0 }); // well under cap
    const endpoint = createCapabilityEndpoint({
      leaseManager, rpcCall, boundedAutonomy, autonomyConfig: cfg,
    });

    await endpoint.handleCapCall(bearer, "cron.add", { payload_kind: "agent_turn", schedule: "x" });
    expect(rpcCall).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // The jail leg allocates a monotonic
  // _outwardStepIndex for an OUTWARD message method (orch:message) and strips a
  // forged inbound value before re-injecting the trusted allocated one.
  //
  // Retained-operation duplicate suppression is active only when the outward
  // ledger is wired. Otherwise the send is a pass-through without an allocated key.
  // -------------------------------------------------------------------------

  /** An outward ledger stub that persists one step per caller operation identity. */
  function makeAllocStore() {
    const counters = new Map<string, number>();
    const operations = new Map<string, number>();
    return {
      allocateStep: vi.fn(async (rootRunId: string, operationId: string) => {
        const operationKey = `${rootRunId}:${operationId}`;
        const existing = operations.get(operationKey);
        if (existing !== undefined) return { ok: true as const, value: existing };
        const next = counters.has(rootRunId) ? counters.get(rootRunId)! + 1 : 0;
        counters.set(rootRunId, next);
        operations.set(operationKey, next);
        return { ok: true as const, value: next };
      }),
    } as never;
  }

  it("two outward message.send calls in one run get _outwardStepIndex 0 then 1 and BOTH dispatch", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    // orch:message is the audience for message.send/reply/react.
    const bearer = mintValidLease(leaseManager, ["orch:message"], "agent-out");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const outwardLedger = makeAllocStore();
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, outwardLedger });

    await endpoint.handleCapCall(bearer, "message.send", { channelId: "c", text: "one" }, "operation-send");
    await endpoint.handleCapCall(bearer, "message.reply", { channelId: "c", text: "two" }, "operation-reply");

    expect(rpcCall).toHaveBeenCalledTimes(2); // both deliver — neither dropped
    expect((rpcCall.mock.calls[0][1] as Record<string, unknown>)._outwardStepIndex).toBe(0);
    expect((rpcCall.mock.calls[1][1] as Record<string, unknown>)._outwardStepIndex).toBe(1);
  });

  // The typed SDK method rides the shipped ledger: comis_tools.message_send(...)
  // dispatches callCapSocket("message.send", args) → the endpoint's DIRECT-method
  // branch of handleCapCall (NOT tool.invoke), so allocateOutwardStepIfNeeded fires.
  // Two attempts for ONE logical message.send carry the SAME caller operation
  // identity and therefore receive the SAME step, so the downstream ledger can
  // dedupe a response-loss retry. This exercises the SAME wire path the typed
  // method takes, against the real allocateOutwardStepIfNeeded and an outward
  // ledger stub, not a mock of the endpoint helper.
  it("a response-loss retry with the same caller operation identity reuses one _outwardStepIndex", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:message"], "agent-dup");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const outwardLedger = makeAllocStore();
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, outwardLedger });

    // The SAME outward method twice in one run (mintValidLease pins rootRunId "run-1").
    await endpoint.handleCapCall(bearer, "message.send", { channelId: "c", text: "first" }, "logical-send-1");
    await endpoint.handleCapCall(bearer, "message.send", { channelId: "c", text: "retry" }, "logical-send-1");

    expect(rpcCall).toHaveBeenCalledTimes(2); // downstream ledger owns the dedup
    expect((rpcCall.mock.calls[0][1] as Record<string, unknown>)._outwardStepIndex).toBe(0);
    expect((rpcCall.mock.calls[1][1] as Record<string, unknown>)._outwardStepIndex).toBe(0);
    const alloc = (outwardLedger as unknown as { allocateStep: ReturnType<typeof vi.fn> })
      .allocateStep;
    expect(alloc).toHaveBeenCalledTimes(2);
    expect(alloc).toHaveBeenNthCalledWith(1, "run-1", "logical-send-1");
    expect(alloc).toHaveBeenNthCalledWith(2, "run-1", "logical-send-1");
  });

  it("blocks a durable socket outward call that has no caller operation identity", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:message"], "agent-missing-id");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const outwardLedger = makeAllocStore();
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, outwardLedger });

    await expect(endpoint.handleCapCall(
      bearer,
      "message.send",
      { channelId: "c", text: "blocked" },
    )).rejects.toThrow(/operation identity/i);
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("a forged inbound _outwardStepIndex is stripped, then the trusted allocated index is injected", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:message"], "agent-out");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const outwardLedger = makeAllocStore();
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, outwardLedger });

    // The jailed client forges _outwardStepIndex: 999 to try to self-collide /
    // perturb ordering. The strip drops it; the allocated 0 replaces it.
    await endpoint.handleCapCall(bearer, "message.send", { channelId: "c", text: "x", _outwardStepIndex: 999 }, "operation-forgery-test");

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._outwardStepIndex).toBe(0); // trusted allocation, NOT the forged 999
  });

  it("does NOT inject _outwardStepIndex for a non-outward method (cron.add)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-cron");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const outwardLedger = makeAllocStore();
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, outwardLedger });

    await endpoint.handleCapCall(bearer, "cron.add", { schedule: "x" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._outwardStepIndex).toBeUndefined();
    expect((outwardLedger as { allocateStep: ReturnType<typeof vi.fn> }).allocateStep).not.toHaveBeenCalled();
  });

  it("is a pass-through when no outward ledger is wired", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:message"], "agent-out");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall }); // no outward ledger

    await endpoint.handleCapCall(bearer, "message.send", { channelId: "c", text: "x" }, "operation-pass-through");

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._outwardStepIndex).toBeUndefined();
  });

  it("fails closed before RPC dispatch when the wired durable counter rejects the lease trust", async () => {
    const leaseManager = createLeaseManager({ clock: createTestClock() });
    const bearer = mintValidLease(leaseManager, ["orch:message"], "agent-out");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const outwardLedger = {
      allocateStep: vi.fn(async () => ({ ok: false as const, error: new Error("trust mismatch") })),
    } as never;
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, outwardLedger });

    await expect(
      endpoint.handleCapCall(bearer, "message.send", { channelId: "c", text: "blocked" }, "operation-allocation-error"),
    ).rejects.toThrow(/trust mismatch/);
    expect(rpcCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The content-free replay recorder at the handleCapCall chokepoint.
// After a SUCCESSFUL cap-socket call on a run with orchestrateResume ON, ONE
// content-free `{seq, method, paramsDigest} → pointer` line is appended to
// <recording-root>/results/<run>/replay.jsonl contains digests and ResultRef pointers only,
// never raw params, result bodies, or bearers, even for a small inline result.
// Nothing is written when the run's replay recording is off (default posture).
// ---------------------------------------------------------------------------

/** A silent ComisLogger for the real ResultRef store the recorder writes through. */
function makeSilentLogger(): Parameters<typeof createResultRefStore>[0]["logger"] {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l };
  return l as unknown as Parameters<typeof createResultRefStore>[0]["logger"];
}

/** Build a REAL recorder over a REAL ResultRef store + a REAL temp workspace — the
 *  recorded pointer is a real file on disk (ground truth, never a mock). */
function makeRecorder(
  workspacePath: string,
  clock: { now(): number },
  enabled = true,
): ReplayRecorder {
  const store = createResultRefStore({ logger: makeSilentLogger() });
  return createReplayRecorder({
    isEnabled: () => enabled,
    recordingRootPath: workspacePath,
    materialize: (payload, ctx) => store.materialize(payload, "orchestrate_replay", {
      ...ctx,
      workspacePath: ctx.recordingRootPath,
    }),
    nowMs: () => clock.now(),
  });
}

function findReplayLogs(workspacePath: string): string[] {
  return readdirSync(workspacePath, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith("replay.jsonl"))
    .map((path) => join(workspacePath, path));
}

function findReplayLog(workspacePath: string): string {
  const matches = findReplayLogs(workspacePath);
  if (matches.length !== 1) {
    throw new Error(`expected one replay log, found ${matches.length}`);
  }
  return matches[0]!;
}

describe("createCapabilityEndpoint content-free replay recorder", () => {
  it("serializes same-run materialization and replay lines by record invocation order", async () => {
    const clock = createTestClock();
    const dir = mkdtempSync(join(tmpdir(), "replay-order-"));
    const store = createResultRefStore({ logger: makeSilentLogger() });
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const recorder = createReplayRecorder({
      isEnabled: () => true,
      recordingRootPath: dir,
      materialize: async (payload, ctx) => {
        if (payload.includes("first")) await firstGate;
        return store.materialize(payload, "orchestrate_replay", {
          ...ctx,
          workspacePath: ctx.recordingRootPath,
        });
      },
      nowMs: () => clock.now(),
    });
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-order");
    const lease = leaseManager.validate(bearer, "cron.add");
    if (lease === null) throw new Error("expected a valid lease");

    const first = recorder.record(lease, "cron.add", { n: 1 }, { first: true });
    const second = recorder.record(lease, "cron.run", { n: 2 }, { second: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirst();
    await Promise.all([first, second]);

    const lines = readFileSync(findReplayLog(dir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; method: string });
    expect(lines).toEqual([
      expect.objectContaining({ seq: 0, method: "cron.add" }),
      expect.objectContaining({ seq: 1, method: "cron.run" }),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("isolates concurrent runs' replay logs and pointers so per-run cleanup removes only its owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-isolation-"));
    const store = createResultRefStore({ logger: makeSilentLogger() });
    const recorder = createReplayRecorder({
      isEnabled: () => true,
      recordingRootPath: dir,
      materialize: (payload, ctx) => store.materialize(payload, "orchestrate_replay", {
        ...ctx,
        workspacePath: ctx.recordingRootPath,
      }),
      nowMs: () => 1_700_000_000_000,
    });
    const leaseA = {
      agentId: "agent-a", rootRunId: "shared-root", checkpointId: "run-a", sessionKey: "t:u:c",
    } as never;
    const leaseB = {
      agentId: "agent-a", rootRunId: "shared-root", checkpointId: "run-b", sessionKey: "t:u:c",
    } as never;

    await Promise.all([
      recorder.record(leaseA, "cron.add", { run: "a" }, { owner: "a" }),
      recorder.record(leaseB, "cron.add", { run: "b" }, { owner: "b" }),
    ]);
    expect(findReplayLogs(dir)).toHaveLength(2);

    await store.cleanupRun({ workspacePath: dir, runId: "run-a" });

    const survivorLogs = findReplayLogs(dir);
    expect(survivorLogs).toHaveLength(1);
    const survivor = JSON.parse(readFileSync(survivorLogs[0]!, "utf8").trim()) as {
      result: string;
    };
    expect(JSON.parse(readFileSync(join(dir, survivor.result), "utf8"))).toEqual({ owner: "b" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("best-effort recording contains circular and bigint serialization failures without exposing content", async () => {
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(),
      fatal: vi.fn(), trace: vi.fn(), audit: vi.fn(), level: "silent",
      child: vi.fn().mockReturnThis(),
    } as never;
    const recorder = createReplayRecorder({
      isEnabled: () => true,
      recordingRootPath: "/tmp/unused-replay-workspace",
      materialize: vi.fn(async () => {
        throw new Error("materializer rejected tok-secret-materializer-sentinel");
      }),
      nowMs: () => 1,
      logger,
    });
    const lease = {
      leaseId: "lease-a",
      parentLeaseId: undefined,
      rootRunId: "run-a",
      sessionKey: "tenant-a:user-a:chat-a",
      agentId: "agent-a",
      caps: ["orch:cron"],
      issuedAt: 0,
      expiresAt: 10,
      audience: ["cron.add"],
    } as never;
    const circular: Record<string, unknown> = { marker: "tok-secret-circular-sentinel" };
    circular.self = circular;

    await expect(
      recorder.record(lease, "cron.add", {}, circular),
    ).resolves.toBeUndefined();
    await expect(
      recorder.record(lease, "cron.add", {}, { amount: 1n }),
    ).resolves.toBeUndefined();
    await expect(
      recorder.record(lease, "cron.add", {}, { serializable: true }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain("tok-secret-circular-sentinel");
    expect(serialized).not.toContain("tok-secret-materializer-sentinel");
    expect(warn.mock.calls.every(([fields]) =>
      (fields as Record<string, unknown>).errorKind === "internal"
      && typeof (fields as Record<string, unknown>).hint === "string"
    )).toBe(true);
  });

  it("does not turn a completed RPC effect into failure when an injected recorder rejects", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-best-effort");
    const rpcCall = vi.fn(async () => ({ applied: true }));
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(),
      fatal: vi.fn(), trace: vi.fn(), audit: vi.fn(), level: "silent",
      child: vi.fn().mockReturnThis(),
    } as never;
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      replayRecorder: {
        record: vi.fn(async () => {
          throw new Error("tok-secret-recorder-rejection");
        }),
      },
      logger,
    });

    await expect(
      endpoint.handleCapCall(bearer, "cron.add", { schedule: "x" }),
    ).resolves.toEqual({ applied: true });
    expect(rpcCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("tok-secret-recorder-rejection");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "internal", hint: expect.any(String) }),
      expect.any(String),
    );
  });

  it("appends exactly one integrity-bound content-free replay line with no params/body/bearer", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-rec");
    // The dispatch result carries a distinctive body substring; the params carry a
    // distinctive substring — NEITHER may appear in the content-free log.
    const rpcCall = vi.fn(async () => ({ token: "SECRET_BODY_MARKER", ok: true }));
    const dir = mkdtempSync(join(tmpdir(), "replay-rec-"));
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      replayRecorder: makeRecorder(dir, clock),
    });

    await endpoint.handleCapCall(bearer, "cron.add", { schedule: "SENSITIVE_PARAM_MARKER" });

    const logPath = findReplayLog(dir);
    const raw = readFileSync(logPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]) as {
      seq: number;
      method: string;
      paramsDigest: string;
      resultDigest: string;
      result: string;
    };
    expect(entry.seq).toBe(0);
    expect(entry.method).toBe("cron.add");
    // The digest is sha256(canonical(params)) — the platform hash, keyed on the
    // ORIGINAL wire params (what the re-spawned script re-sends), never the raw params.
    expect(entry.paramsDigest).toBe(replayParamsDigest({ schedule: "SENSITIVE_PARAM_MARKER" }));
    expect(entry.paramsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.resultDigest).toBe(
      createHash("sha256").update(JSON.stringify({ token: "SECRET_BODY_MARKER", ok: true })).digest("hex"),
    );
    // The result is a POINTER into results/, never the body.
    expect(entry.result).toMatch(/^results\//);

    // The serialized line contains no raw params, result body, or bearer.
    expect(raw).not.toContain("SENSITIVE_PARAM_MARKER");
    expect(raw).not.toContain("SECRET_BODY_MARKER");
    expect(raw).not.toContain(bearer);

    // The pointer file exists on disk and holds the materialized body (byte-identical
    // replay is possible) — the log stayed content-free, the bytes live in results/.
    const pointerPath = join(dir, entry.result);
    expect(existsSync(pointerPath)).toBe(true);
    expect(readFileSync(pointerPath, "utf8")).toContain("SECRET_BODY_MARKER");

    rmSync(dir, { recursive: true, force: true });
  });

  it("materializes even a small inline result to an on-disk pointer (A3)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-small");
    // A tiny result that would ordinarily be inlined — it MUST still be materialized.
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const dir = mkdtempSync(join(tmpdir(), "replay-small-"));
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      replayRecorder: makeRecorder(dir, clock),
    });

    await endpoint.handleCapCall(bearer, "cron.add", { schedule: "x" });

    const entry = JSON.parse(
      readFileSync(findReplayLog(dir), "utf8").trim(),
    ) as { result: string };
    expect(entry.result).toMatch(/^results\//);
    const pointerPath = join(dir, entry.result);
    expect(existsSync(pointerPath)).toBe(true);
    expect(JSON.parse(readFileSync(pointerPath, "utf8"))).toEqual({ ok: true });

    rmSync(dir, { recursive: true, force: true });
  });

  it("writes nothing when replay recording is off for the run (default posture)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-off");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const dir = mkdtempSync(join(tmpdir(), "replay-off-"));
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      replayRecorder: makeRecorder(dir, clock, false), // gate OFF
    });

    await endpoint.handleCapCall(bearer, "cron.add", { schedule: "x" });

    // No results/ dir, no replay.jsonl — the recorder was a complete no-op.
    expect(existsSync(join(dir, "results", "replay.jsonl"))).toBe(false);
    // The dispatch itself still happened (recording is orthogonal to dispatch).
    expect(rpcCall).toHaveBeenCalledTimes(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("increments seq in dispatch order across calls in the same run (keyed on rootRunId)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    // mintValidLease pins rootRunId "run-1" — both calls share the same run.
    const bearer = mintValidLease(leaseManager, ["orch:cron"], "agent-seq");
    const rpcCall = vi.fn(async () => ({ ok: true }));
    const dir = mkdtempSync(join(tmpdir(), "replay-seq-"));
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      replayRecorder: makeRecorder(dir, clock),
    });

    await endpoint.handleCapCall(bearer, "cron.add", { schedule: "one" });
    await endpoint.handleCapCall(bearer, "cron.run", { jobId: "j1" });

    const lines = readFileSync(findReplayLog(dir), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { seq: number; method: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ seq: 0, method: "cron.add" });
    expect(lines[1]).toMatchObject({ seq: 1, method: "cron.run" });

    rmSync(dir, { recursive: true, force: true });
  });

  it("records a tool.invoke call under method 'tool.invoke' with the {tool,args} digest", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const bearer = mintValidLease(leaseManager, ["orch:read"], "agent-tinv");
    const rpcCall = vi.fn(async () => ({ hits: [] }));
    const dir = mkdtempSync(join(tmpdir(), "replay-tinv-"));
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      replayRecorder: makeRecorder(dir, clock),
    });

    // memory_search is an rpc-route orch:read tool — the wire method is tool.invoke.
    await endpoint.handleCapCall(bearer, "tool.invoke", {
      tool: "memory_search",
      args: { q: "x" },
    });

    const entry = JSON.parse(
      readFileSync(findReplayLog(dir), "utf8").trim(),
    ) as { method: string; paramsDigest: string };
    // The recorded method is the WIRE method (tool.invoke), and the digest is over
    // the ORIGINAL wire params {tool, args} the re-spawned script re-sends.
    expect(entry.method).toBe("tool.invoke");
    expect(entry.paramsDigest).toBe(replayParamsDigest({ tool: "memory_search", args: { q: "x" } }));

    rmSync(dir, { recursive: true, force: true });
  });
});
