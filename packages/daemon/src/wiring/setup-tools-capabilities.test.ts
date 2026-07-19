// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for makeCreateAgentRpcCall (extracted from setup-tools.ts
 * for the file-size cap). Asserts the agent-scoped rpcCall builder
 * injects _agentId + the resolved _capabilities (from resolveAutonomy) plus the
 * caller's session/delivery/channel context into every forwarded RPC call, and
 * resolves a zero-config agent through the default-agent fallback.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

// Controllable AsyncLocalStorage context for the unit under test. Each test sets
// `currentCtx` before calling the agentRpc so the injection branches are driven.
let currentCtx: Record<string, unknown> | undefined;

const internalFieldNames = new Set([
  "_agentId",
  "_autonomyMode",
  "_callerChannelId",
  "_callerChannelType",
  "_callerConversationScope",
  "_callerMetadata",
  "_callerSessionKey",
  "_capabilities",
  "_channelType",
  "_chatType",
  "_context",
  "_deliveryTarget",
  "_originChannelId",
  "_outwardStepIndex",
  "_outwardOperationId",
  "_rootRunId",
  "_sessionKey",
  "_tenantId",
  "_traceId",
  "_trustLevel",
  "_userId",
]);

vi.mock("@comis/core", () => ({
  tryGetContext: () => currentCtx,
  stripInternalFields: (params: Record<string, unknown>) => Object.fromEntries(
    Object.entries(params).filter(([key]) => !internalFieldNames.has(key)),
  ),
  conversationScopeToSessionKey: (scope: {
    tenantId: string;
    agentId: string;
    partition: { principalId?: string };
  }) => ({
    ok: true,
    value: {
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      userId: scope.partition.principalId ?? "main",
      channelId: "telegram",
      ...(scope.partition.principalId ? { peerId: scope.partition.principalId } : {}),
    },
  }),
  // Stand-in autonomy resolver returning the `standard` floor capability set and a
  // `mode` derived from the input config's profile. The real resolver maps each
  // profile to its mode (standard->accept-reversible, unattended->unattended, …)
  // and is unit-tested against the schema in schema-agent-autonomy.test.ts; here we
  // need a deterministic caps list PLUS a mode that varies by the passed-in profile
  // so the _autonomyMode-injection assertions can drive distinct postures from ONE
  // resolve call (caps + mode come from the same returned object).
  resolveAutonomy: vi.fn((cfg?: { profile?: string }) => {
    const profileToMode: Record<string, string> = {
      assistant: "default",
      standard: "accept-reversible",
      unattended: "unattended",
      max: "max",
    };
    const profile = cfg?.profile ?? "standard";
    return {
      profile,
      capabilities: ["orch:spawn", "orch:graph", "orch:cron"],
      mode: profileToMode[profile] ?? "accept-reversible",
    };
  }),
  attenuateCaps: (parent: string[], requested: string[]) =>
    requested.filter((cap) => parent.includes(cap)),
  // buildAutonomyToolWiring (loaded via the setup-tools chain)
  // degrades the resolved posture via degradeAutonomy before gating orchestrate.
  // This seam never passes namespacePreflightOk (→ defaults true → no-op), so a
  // pass-through is faithful; the real fn is unit-tested in schema-agent-autonomy.test.ts.
  degradeAutonomy: vi.fn((resolved: unknown) => ({ resolved })),
}));

const { makeCreateAgentRpcCall } = await import("./setup-tools-capabilities.js");

const TURN_SCOPE = {
  conversation: {
    tenantId: "tenant-x",
    agentId: "agent-1",
    partition: { kind: "channel-principal", channelType: "telegram", principalId: "user-z" },
  },
  principal: { principalId: "user-z" },
  endpoint: {
    channelType: "telegram",
    channelInstanceId: "instance-a",
    conversationId: "chan-y",
    conversationKind: "direct",
  },
};

function inProcessContext(trustLevel = "user"): Record<string, unknown> {
  return {
    agentId: "agent-1",
    sessionKey: "tenant-x:agent:agent-1:user-z:telegram:peer:user-z",
    trustLevel,
    turnScope: TURN_SCOPE,
  };
}

describe("makeCreateAgentRpcCall — the agent-scoped rpcCall capability-injection builder", () => {
  it("injects _agentId and the resolved _capabilities into every forwarded rpcCall", async () => {
    currentCtx = undefined;
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    });

    const agentRpc = create("agent-1");
    await agentRpc("session.spawn", { task: "do a thing" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._agentId).toBe("agent-1");
    expect(Array.isArray(forwarded._capabilities)).toBe(true);
    expect(forwarded._capabilities).toContain("orch:spawn");
    expect(forwarded._capabilities).toContain("orch:graph");
    expect(forwarded._capabilities).toContain("orch:cron");
    // Original params survive the merge.
    expect(forwarded.task).toBe("do a thing");
  });

  it("attenuates every in-process RPC call to the delegated capability ceiling", async () => {
    currentCtx = undefined;
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    });

    await create("agent-1", ["orch:graph"])("session.spawn", { task: "must stay bounded" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._capabilities).toEqual(["orch:graph"]);
  });

  // -------------------------------------------------------------------------
  // Trust-tier re-injection: the in-process leg re-injects the run's
  // REAL per-message trust from the framework ALS as a forgery-proof _trustLevel —
  // the deny-by-origin chokepoint reads it to let an ADMIN-trust agent reach admin
  // methods (and deny a guest/user one). Injected AFTER `...params` so a tool- or
  // agent-supplied value cannot override the authentic trust.
  // -------------------------------------------------------------------------

  it("injects the framework ctx.trustLevel as a forgery-proof _trustLevel, OVERRIDING a params-supplied value", async () => {
    currentCtx = { agentId: "agent-1", trustLevel: "admin" };
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    });

    // A forged/tool-supplied `_trustLevel:"user"` in params MUST lose to the real
    // ctx trust (post-spread injection) — this is the chokepoint's trusted signal.
    await create("agent-1")("secrets.set", { name: "X", _trustLevel: "user" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._trustLevel).toBe("admin");
  });

  it("omits _trustLevel when the context has no resolved trust (absent ⇒ non-admin ⇒ denied at the chokepoint, never a silent admin)", async () => {
    currentCtx = { agentId: "agent-1" }; // a context with no trustLevel (runWithContext stores raw — no schema default)
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    });

    await create("agent-1")("session.spawn", { task: "x" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect("_trustLevel" in forwarded).toBe(false);
  });

  it("strips forged internal fields when no framework context exists", async () => {
    currentCtx = undefined;
    const rpcCall = vi.fn(async () => "ok");
    const agentRpc = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    })("agent-1");

    const forgedParams = Object.fromEntries(
      [...internalFieldNames].map((field) => [field, "forged"]),
    );
    await agentRpc("secrets.set", { name: "keep", ...forgedParams });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded.name).toBe("keep");
    expect(forwarded._agentId).toBe("agent-1");
    expect(forwarded._capabilities).toEqual(["orch:spawn", "orch:graph", "orch:cron"]);
    expect(forwarded._autonomyMode).toBe("accept-reversible");
    for (const field of internalFieldNames) {
      if (field === "_agentId" || field === "_capabilities" || field === "_autonomyMode") {
        continue;
      }
      expect(field in forwarded).toBe(false);
    }
  });

  it("does not inject authorization fields from another agent context", async () => {
    currentCtx = {
      agentId: "agent-2",
      trustLevel: "admin",
      sessionKey: "tenant-x:chan-y:user-z",
      channelType: "telegram",
      deliveryOrigin: { channelType: "telegram", channelId: "chan-y" },
    };
    const rpcCall = vi.fn(async () => "ok");
    const agentRpc = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    })("agent-1");

    await agentRpc("secrets.set", {
      name: "keep",
      _trustLevel: "admin",
      _callerSessionKey: "forged:session:key",
    });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._agentId).toBe("agent-1");
    expect("_trustLevel" in forwarded).toBe(false);
    expect("_callerSessionKey" in forwarded).toBe(false);
    expect("_deliveryTarget" in forwarded).toBe(false);
    expect("_callerChannelType" in forwarded).toBe(false);
    expect("_callerChannelId" in forwarded).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The in-process leg injects the trusted
  // _autonomyMode from the SAME resolveAutonomy call that yields _capabilities.
  // This is the forgery-proof channel the unattended-mode chokepoint reads to learn
  // the run's mode (a forged inbound value is stripped by INTERNAL_FIELD_NAMES first).
  // -------------------------------------------------------------------------

  it("injects _autonomyMode:'unattended' for an agent whose autonomy resolves the unattended mode", async () => {
    currentCtx = undefined;
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": { autonomy: { profile: "unattended" } } as never },
      defaultAgentId: "agent-1",
    });

    await create("agent-1")("session.spawn", { task: "run unattended" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._autonomyMode).toBe("unattended");
    // Caps injection is unchanged by the refactor to a single resolve call.
    expect(forwarded._capabilities).toEqual(["orch:spawn", "orch:graph", "orch:cron"]);
    expect(forwarded._agentId).toBe("agent-1");
  });

  it("injects _autonomyMode:'accept-reversible' for a standard-profile agent (the standard default mode)", async () => {
    currentCtx = undefined;
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": { autonomy: { profile: "standard" } } as never },
      defaultAgentId: "agent-1",
    });

    await create("agent-1")("cron.add", { schedule: "* * * * *" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._autonomyMode).toBe("accept-reversible");
    // The refactor must not drop or alter caps.
    expect(forwarded._capabilities).toEqual(["orch:spawn", "orch:graph", "orch:cron"]);
  });

  it("sources _autonomyMode and _capabilities from ONE resolve call (a zero-config agent gets the standard default mode)", async () => {
    // A zero-config agent (no autonomy block) resolves to the standard posture for
    // BOTH caps and mode — one source of truth, no divergence.
    currentCtx = undefined;
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    });

    await create("agent-1")("session.spawn", {});

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._autonomyMode).toBe("accept-reversible");
    expect(forwarded._capabilities).toEqual(["orch:spawn", "orch:graph", "orch:cron"]);
  });

  it("derives _callerSessionKey, _deliveryTarget, and caller channel metadata from the request context", async () => {
    currentCtx = {
      agentId: "agent-1",
      sessionKey: "tenant-x:agent:agent-1:user-z:telegram:peer:user-z",
      channelType: "telegram",
      deliveryOrigin: { channelType: "telegram", channelId: "chan-y" },
      turnScope: TURN_SCOPE,
    };
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    });

    await create("agent-1")("cron.add", { schedule: "* * * * *" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._callerSessionKey).toBe("tenant-x:agent:agent-1:user-z:telegram:peer:user-z");
    expect(forwarded._callerConversationScope).toEqual(currentCtx.turnScope?.conversation);
    expect(forwarded._deliveryTarget).toEqual({
      channelId: "chan-y",
      userId: "user-z",
      tenantId: "tenant-x",
      channelType: "telegram",
    });
    expect(forwarded._callerChannelType).toBe("telegram");
    expect(forwarded._callerChannelId).toBe("chan-y");
  });

  it("resolves a zero-config agentId through the default-agent fallback for capability resolution", async () => {
    currentCtx = undefined;
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "default-agent": {} as never },
      defaultAgentId: "default-agent",
    });

    // "unknown-agent" is absent from `agents` — the builder must fall back to
    // the default agent's autonomy rather than crash, and still stamp the caps.
    const forwarded = await (async () => {
      await create("unknown-agent")("session.spawn", {});
      return rpcCall.mock.calls[0][1] as Record<string, unknown>;
    })();
    expect(forwarded._agentId).toBe("unknown-agent");
    expect(forwarded._capabilities).toContain("orch:spawn");
  });

  // -------------------------------------------------------------------------
  // The in-process leg allocates a monotonic
  // _outwardStepIndex for an OUTWARD message method. Without it, an in-process
  // agent-loop message.send is an un-ledgered pass-through and a second send in
  // one run would collide on (rootRunId, 0) and be silently dropped.
  // -------------------------------------------------------------------------

  /** An outward ledger stub that persists one step per caller operation identity. */
  function makeAllocStore() {
    const counters = new Map<string, number>();
    const operations = new Map<string, number>();
    const calls: Array<[string, string]> = [];
    return {
      calls,
      outwardLedger: {
        allocateStep: vi.fn(async (rootRunId: string, operationId: string) => {
          calls.push([rootRunId, operationId]);
          const operationKey = `${rootRunId}:${operationId}`;
          const existing = operations.get(operationKey);
          if (existing !== undefined) return { ok: true as const, value: existing };
          const next = counters.has(rootRunId) ? counters.get(rootRunId)! + 1 : 0;
          counters.set(rootRunId, next);
          operations.set(operationKey, next);
          return { ok: true as const, value: next };
        }),
      } as never,
    };
  }

  it("an in-process-leg outward send (with a sessionKey) gets a real _outwardStepIndex (not absent → not a silent pass-through)", async () => {
    currentCtx = inProcessContext();
    const rpcCall = vi.fn(async () => "ok");
    const { outwardLedger } = makeAllocStore();
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
      outwardLedger,
      resolveRootRunId: () => "root-IP",
    });

    await create("agent-1")(
      "message.send",
      { channelId: "chan-y", text: "hello" },
      { outwardOperationId: "tool-call-1" },
    );

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._outwardStepIndex).toBe(0);
    expect(outwardLedger.allocateStep).toHaveBeenCalledWith("root-IP", "tool-call-1");
  });

  it("two distinct outward sends in one run get _outwardStepIndex 0 then 1 (NOT 0,0)", async () => {
    currentCtx = inProcessContext();
    const rpcCall = vi.fn(async () => "ok");
    const { outwardLedger } = makeAllocStore();
    const agentRpc = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
      outwardLedger,
      resolveRootRunId: () => "root-SAME",
    })("agent-1");

    await agentRpc("message.send", { channelId: "chan-y", text: "one" }, { outwardOperationId: "tool-call-one" });
    await agentRpc("message.reply", { channelId: "chan-y", text: "two" }, { outwardOperationId: "tool-call-two" });

    const first = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    const second = rpcCall.mock.calls[1][1] as Record<string, unknown>;
    expect(first._outwardStepIndex).toBe(0);
    expect(second._outwardStepIndex).toBe(1);
    // Both still dispatch (neither is dropped) — proven by two forwarded calls.
    expect(rpcCall).toHaveBeenCalledTimes(2);
  });

  it("an in-process response-loss retry reuses one step when the tool call identity is unchanged", async () => {
    currentCtx = inProcessContext();
    const rpcCall = vi.fn(async () => "ok");
    const { outwardLedger } = makeAllocStore();
    const agentRpc = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
      outwardLedger,
      resolveRootRunId: () => "root-RETRY",
    })("agent-1");

    const identity = { outwardOperationId: "stable-tool-call" };
    await agentRpc("message.send", { channelId: "chan-y", text: "one" }, identity);
    await agentRpc("message.send", { channelId: "chan-y", text: "one" }, identity);

    expect((rpcCall.mock.calls[0][1] as Record<string, unknown>)._outwardStepIndex).toBe(0);
    expect((rpcCall.mock.calls[1][1] as Record<string, unknown>)._outwardStepIndex).toBe(0);
    expect(outwardLedger.allocateStep).toHaveBeenNthCalledWith(1, "root-RETRY", "stable-tool-call");
    expect(outwardLedger.allocateStep).toHaveBeenNthCalledWith(2, "root-RETRY", "stable-tool-call");
  });

  it("blocks a durable in-process outward call without a tool call operation identity", async () => {
    currentCtx = { agentId: "agent-1", sessionKey: "tenant-x:chan-y:user-z", trustLevel: "user" };
    const rpcCall = vi.fn(async () => "must-not-dispatch");
    const { outwardLedger } = makeAllocStore();
    const agentRpc = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
      outwardLedger,
      resolveRootRunId: () => "root-NO-ID",
    })("agent-1");

    await expect(agentRpc("message.send", { channelId: "chan-y", text: "blocked" }))
      .rejects.toThrow(/operation identity/i);
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("does NOT inject _outwardStepIndex for a NON-outward method (no un-needed ledger key)", async () => {
    currentCtx = { agentId: "agent-1", sessionKey: "tenant-x:chan-y:user-z", trustLevel: "user" };
    const rpcCall = vi.fn(async () => "ok");
    const { outwardLedger } = makeAllocStore();
    await makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
      outwardLedger,
      resolveRootRunId: () => "root-X",
    })("agent-1")("session.spawn", { task: "t" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._outwardStepIndex).toBeUndefined();
    expect(outwardLedger.allocateStep).not.toHaveBeenCalled();
  });

  it("threads the caller operation identity to a cross-session RPC without allocating a direct-message step", async () => {
    currentCtx = { agentId: "agent-1", sessionKey: "tenant-x:chan-y:user-z", trustLevel: "user" };
    const rpcCall = vi.fn(async () => "ok");
    const { outwardLedger } = makeAllocStore();
    const agentRpc = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
      outwardLedger,
      resolveRootRunId: () => "root-X",
    })("agent-1");

    await agentRpc(
      "session.send",
      { session_key: "tenant-x:chan-y:target", text: "hello", mode: "wait" },
      { outwardOperationId: "sessions-send-tool-call" },
    );

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._outwardOperationId).toBe("sessions-send-tool-call");
    expect(forwarded._outwardStepIndex).toBeUndefined();
    expect(outwardLedger.allocateStep).not.toHaveBeenCalled();
  });

  it("is a pass-through when no outward ledger is wired", async () => {
    currentCtx = { agentId: "agent-1", sessionKey: "tenant-x:chan-y:user-z" };
    const rpcCall = vi.fn(async () => "ok");
    // No outwardLedger / resolveRootRunId.
    await makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    })("agent-1")("message.send", { channelId: "chan-y", text: "hi" }, { outwardOperationId: "pass-through-id" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._outwardStepIndex).toBeUndefined();
  });

  it("fails closed before in-process RPC dispatch when the wired durable counter rejects trust", async () => {
    currentCtx = {
      ...inProcessContext("guest"),
    };
    const rpcCall = vi.fn(async () => "must-not-dispatch");
    const outwardLedger = {
      allocateStep: vi.fn(async () => ({ ok: false as const, error: new Error("trust mismatch") })),
    } as never;
    const agentRpc = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
      outwardLedger,
      resolveRootRunId: () => "root-IP",
    })("agent-1");

    await expect(agentRpc("message.send", { channelId: "chan-y", text: "blocked" }, { outwardOperationId: "allocation-failure-id" }))
      .rejects.toThrow(/trust mismatch/);
    expect(rpcCall).not.toHaveBeenCalled();
  });
});
