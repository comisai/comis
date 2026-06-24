// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for makeCreateAgentRpcCall (extracted from setup-tools.ts,
 * Phase 210 CAP-03 file-size cap). Asserts the agent-scoped rpcCall builder
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

vi.mock("@comis/core", () => ({
  tryGetContext: () => currentCtx,
  // Parse "tenantId:channelId:userId" — mirrors the real formatter used in tests.
  parseFormattedSessionKey: (k: string) => {
    const [tenantId, channelId, userId] = k.split(":");
    if (!tenantId || !channelId || !userId) return undefined;
    return { tenantId, channelId, userId };
  },
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
  // PROFILE-05/JAIL-03: buildAutonomyToolWiring (loaded via the setup-tools chain)
  // degrades the resolved posture via degradeAutonomy before gating orchestrate.
  // This seam never passes namespacePreflightOk (→ defaults true → no-op), so a
  // pass-through is faithful; the real fn is unit-tested in schema-agent-autonomy.test.ts.
  degradeAutonomy: vi.fn((resolved: unknown) => ({ resolved })),
}));

const { makeCreateAgentRpcCall } = await import("./setup-tools-capabilities.js");

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

  // -------------------------------------------------------------------------
  // Phase 217 (UNATT-01 / EVICT-02): the in-process leg injects the trusted
  // _autonomyMode from the SAME resolveAutonomy call that yields _capabilities.
  // This is the forgery-proof channel the Wave-2 chokepoint reads to learn the
  // run's mode (a forged inbound value is stripped by INTERNAL_FIELD_NAMES first).
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
    // BOTH caps and mode — one source of truth, no divergence (T-217-11).
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
      sessionKey: "tenant-x:chan-y:user-z",
      channelType: "telegram",
      deliveryOrigin: { channelType: "telegram", channelId: "chan-y" },
    };
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    });

    await create("agent-1")("cron.add", { schedule: "* * * * *" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._callerSessionKey).toBe("tenant-x:chan-y:user-z");
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
  // Phase 216 (HIGH-1 / NEW-4): the in-process leg allocates a monotonic
  // _outwardStepIndex for an OUTWARD message method. Without it, an in-process
  // agent-loop message.send is an un-ledgered pass-through and a second send in
  // one run would collide on (rootRunId, 0) and be silently dropped.
  // -------------------------------------------------------------------------

  /** A durableRuns stub whose allocateOutwardStep returns a monotonic 0,1,2,… per root. */
  function makeAllocStore() {
    const counters = new Map<string, number>();
    const calls: string[] = [];
    return {
      calls,
      durableRuns: {
        allocateOutwardStep: vi.fn(async (rootRunId: string) => {
          calls.push(rootRunId);
          const next = counters.has(rootRunId) ? counters.get(rootRunId)! + 1 : 0;
          counters.set(rootRunId, next);
          return { ok: true as const, value: next };
        }),
      } as never,
    };
  }

  it("NEW-4: an in-process-leg outward send (with a sessionKey) gets a real _outwardStepIndex (not absent → not a silent pass-through)", async () => {
    currentCtx = { sessionKey: "tenant-x:chan-y:user-z" };
    const rpcCall = vi.fn(async () => "ok");
    const { durableRuns } = makeAllocStore();
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
      durableRuns,
      resolveRootRunId: () => "root-IP",
    });

    await create("agent-1")("message.send", { channelId: "chan-y", text: "hello" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._outwardStepIndex).toBe(0);
    expect(durableRuns.allocateOutwardStep).toHaveBeenCalledWith("root-IP");
  });

  it("HIGH-1: two distinct outward sends in one run get _outwardStepIndex 0 then 1 (NOT 0,0)", async () => {
    currentCtx = { sessionKey: "tenant-x:chan-y:user-z" };
    const rpcCall = vi.fn(async () => "ok");
    const { durableRuns } = makeAllocStore();
    const agentRpc = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
      durableRuns,
      resolveRootRunId: () => "root-SAME",
    })("agent-1");

    await agentRpc("message.send", { channelId: "chan-y", text: "one" });
    await agentRpc("message.reply", { channelId: "chan-y", text: "two" });

    const first = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    const second = rpcCall.mock.calls[1][1] as Record<string, unknown>;
    expect(first._outwardStepIndex).toBe(0);
    expect(second._outwardStepIndex).toBe(1);
    // Both still dispatch (neither is dropped) — proven by two forwarded calls.
    expect(rpcCall).toHaveBeenCalledTimes(2);
  });

  it("does NOT inject _outwardStepIndex for a NON-outward method (no un-needed ledger key)", async () => {
    currentCtx = { sessionKey: "tenant-x:chan-y:user-z" };
    const rpcCall = vi.fn(async () => "ok");
    const { durableRuns } = makeAllocStore();
    await makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
      durableRuns,
      resolveRootRunId: () => "root-X",
    })("agent-1")("session.spawn", { task: "t" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._outwardStepIndex).toBeUndefined();
    expect(durableRuns.allocateOutwardStep).not.toHaveBeenCalled();
  });

  it("is a pass-through (no index) when no durableRuns store is wired (byte-identical pre-216)", async () => {
    currentCtx = { sessionKey: "tenant-x:chan-y:user-z" };
    const rpcCall = vi.fn(async () => "ok");
    // No durableRuns / resolveRootRunId — the default install.
    await makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    })("agent-1")("message.send", { channelId: "chan-y", text: "hi" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._outwardStepIndex).toBeUndefined();
  });
});
