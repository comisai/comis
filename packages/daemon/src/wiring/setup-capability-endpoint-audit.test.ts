// SPDX-License-Identifier: Apache-2.0
/**
 * AUDIT-01 (Phase 215 Plan 01 Task 3): the per-cap audit at the SOCKET
 * chokepoint (`setup-capability-endpoint.ts handleToolInvoke`) — emitted for an
 * ALLOWED *and* a DENIED `tool.invoke` with the FULL lease tuple (the socket
 * path carries the real lease, no asymmetry). RED-first.
 *
 * The socket path's realistic cap-deny for `tool.invoke` is the lease-AUDIENCE
 * deny at `validate` (RFC 8707), which returns null BEFORE `handleToolInvoke`
 * and so carries no `LeaseInfo`. The dispatch-layer `requireCapability` at the
 * top of `handleToolInvoke` is therefore the defense-in-depth gate where a
 * cap-deny WITH the real lease tuple is emittable. To exercise that branch
 * deterministically (it cannot diverge from the audience check through the
 * normal flow — both read the same TOOL_CAPABILITY_MAP), this file mocks
 * `requireCapability` to throw on demand while keeping everything else real.
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Controllable `requireCapability`: real pass-through by default; throws a real
// CapabilityDeniedError when `denyNext` is set (to drive the defense-in-depth
// deny branch in handleToolInvoke). Everything else in @comis/core stays REAL.
let denyNextCap: string | null = null;
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    requireCapability: (held: readonly string[] | undefined, cap: string) => {
      if (denyNextCap !== null) {
        const toThrow = denyNextCap;
        denyNextCap = null;
        throw new actual.CapabilityDeniedError(toThrow as Parameters<typeof actual.requireCapability>[1]);
      }
      return actual.requireCapability(held, cap as Parameters<typeof actual.requireCapability>[1]);
    },
  };
});

const { createLeaseManager } = await import("@comis/infra");
const { createCapabilityEndpoint } = await import("./setup-capability-endpoint.js");

/** A test ClockPort backed by a mutable epoch. */
function createTestClock(startMs = 1_700_000_000_000): { now: () => number; advance(ms: number): void } {
  let nowMs = startMs;
  return { now: () => nowMs, advance(ms: number) { nowMs += ms; } };
}

/**
 * Build the audit-capturing deps the socket emit reads (`container.eventBus` +
 * `container.config.tenantId`) — the NEW structural field Task 3 adds to
 * CapabilityEndpointDeps. Captures both bus channels.
 */
function makeAuditCapture(): {
  container: { eventBus: { emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }; config: { tenantId: string } };
  audit: () => Array<Record<string, unknown>>;
  tree: () => Array<Record<string, unknown>>;
} {
  const emit = vi.fn();
  const container = {
    eventBus: { emit, on: vi.fn() },
    config: { tenantId: "tenant-sock" },
  };
  const pull = (name: string) =>
    emit.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, unknown>);
  return { container, audit: () => pull("audit:event"), tree: () => pull("capability:audited") };
}

beforeEach(() => {
  denyNextCap = null;
  vi.clearAllMocks();
});

describe("createCapabilityEndpoint — per-cap audit at the socket chokepoint (AUDIT-01)", () => {
  it("a SUCCESSFUL tool.invoke emits audit:event + capability:audited with the FULL lease tuple (leaseId/rootRunId/tool/cap, decision=allow, parentLeaseId)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const { bearer, leaseId } = leaseManager.mintLease({
      agentId: "agent-sock",
      caps: ["orch:read"],
      budgetRef: "budget-1",
      sessionKey: "tenant-sock:user-1:chan-1",
      rootRunId: "run-root-1",
      parentLeaseId: "lease-parent-9",
    });

    const rpcCall = vi.fn(async () => ({ hits: [] }));
    const cap = makeAuditCapture();
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      container: cap.container,
    } as never);

    await endpoint.handleCapCall(bearer, "tool.invoke", { tool: "memory_search", args: { q: "x" } });

    // audit:event — durable trail, full metadata tuple INCLUDING leaseId.
    const audits = cap.audit();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.kind).toBe("audit");
    expect(audits[0]!.outcome).toBe("success");
    const md = audits[0]!.metadata as Record<string, unknown>;
    expect(md.decision).toBe("allow");
    expect(md.capability).toBe("orch:read");
    expect(md.tool).toBe("memory_search");
    expect(md.method).toBe("tool.invoke");
    expect(md.leaseId).toBe(leaseId);
    expect(md.rootRunId).toBe("run-root-1");

    // capability:audited — the trajectory record, carrying the parent edge.
    const tree = cap.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]!.decision).toBe("allow");
    expect(tree[0]!.capability).toBe("orch:read");
    expect(tree[0]!.tool).toBe("memory_search");
    expect(tree[0]!.leaseId).toBe(leaseId);
    expect(tree[0]!.parentLeaseId).toBe("lease-parent-9");
    expect(tree[0]!.rootRunId).toBe("run-root-1");
    expect(tree[0]!.agentId).toBe("agent-sock");
  });

  it("a requireCapability-denied tool.invoke emits decision=deny / kind=capability_denied with the lease tuple (leaseId/rootRunId/tool)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const { bearer, leaseId } = leaseManager.mintLease({
      agentId: "agent-sock",
      caps: ["orch:read"], // in-audience for memory_search → validate passes
      budgetRef: "budget-1",
      sessionKey: "tenant-sock:user-1:chan-1",
      rootRunId: "run-root-1",
    });

    const rpcCall = vi.fn(async () => ({ hits: [] }));
    const cap = makeAuditCapture();
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      container: cap.container,
    } as never);

    // Force the defense-in-depth requireCapability to throw for this call.
    denyNextCap = "orch:read";
    await expect(
      endpoint.handleCapCall(bearer, "tool.invoke", { tool: "memory_search", args: { q: "x" } }),
    ).rejects.toBeInstanceOf((await import("@comis/core")).CapabilityDeniedError);
    // The route never ran (denied before dispatch).
    expect(rpcCall).not.toHaveBeenCalled();

    const denyAudits = cap.audit().filter((a) => (a.metadata as Record<string, unknown>)?.decision === "deny");
    expect(denyAudits).toHaveLength(1);
    expect(denyAudits[0]!.kind).toBe("capability_denied");
    expect(denyAudits[0]!.outcome).toBe("denied");
    const md = denyAudits[0]!.metadata as Record<string, unknown>;
    expect(md.capability).toBe("orch:read");
    expect(md.tool).toBe("memory_search");
    expect(md.leaseId).toBe(leaseId);
    expect(md.rootRunId).toBe("run-root-1");

    const treeDeny = cap.tree().filter((a) => a.decision === "deny");
    expect(treeDeny).toHaveLength(1);
    expect(treeDeny[0]!.leaseId).toBe(leaseId);
  });

  it("content-hygiene: the socket emit carries the tool NAME only — never the inner args", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const { bearer } = leaseManager.mintLease({
      agentId: "agent-sock",
      caps: ["orch:read"],
      budgetRef: "budget-1",
      sessionKey: "tenant-sock:user-1:chan-1",
      rootRunId: "run-root-1",
    });

    const rpcCall = vi.fn(async () => ({ hits: [] }));
    const cap = makeAuditCapture();
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      container: cap.container,
    } as never);

    await endpoint.handleCapCall(bearer, "tool.invoke", {
      tool: "memory_search",
      args: { q: "PLANTED-SEARCH-BODY", apiKey: "sk-PLANTED-SECRET" },
    });

    const auditJson = JSON.stringify(cap.audit()[0]);
    const treeJson = JSON.stringify(cap.tree()[0]);
    for (const blob of [auditJson, treeJson]) {
      expect(blob).not.toContain("PLANTED-SEARCH-BODY");
      expect(blob).not.toContain("sk-PLANTED-SECRET");
      // The tool NAME is present; the args object is not.
      expect(blob).toContain("memory_search");
      expect(blob).not.toContain("\"args\"");
    }
  });
});

describe("createCapabilityEndpoint — per-cap audit on the SOCKET DIRECT-METHOD path (CR-01)", () => {
  // CR-01 (BLOCKER): a validated cap-socket lease dispatching a DIRECT cap-gated
  // method (NOT tool.invoke — e.g. message.send/session.spawn/graph.execute) was
  // structurally UNAUDITED: handleCapCall's direct branch injected _agentId but
  // no _callerSessionKey, so the dispatch-closure audit was unreachable and
  // handleCapCall emitted nothing. A sub-agent spawning a grandchild / authoring
  // a graph/cron / sending an outward message over the socket produced NEITHER
  // the durable audit:event NOR the capability:audited tree record — breaking
  // AUDIT-01 + TREE-01/02 for exactly the case that matters most. These assert
  // the direct branch now emits BOTH events with the FULL lease tuple, allow AND
  // deny, content-free.
  it("an ALLOWED direct message.send emits audit:event + capability:audited with the FULL lease tuple (decision=allow, leaseId/rootRunId/parentLeaseId, method=message.send, cap=orch:message)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const { bearer, leaseId } = leaseManager.mintLease({
      agentId: "agent-sock",
      caps: ["orch:message"], // in-audience for message.send (orch:message)
      budgetRef: "budget-1",
      sessionKey: "tenant-sock:user-1:chan-1",
      rootRunId: "run-root-1",
      parentLeaseId: "lease-parent-9",
    });

    const rpcCall = vi.fn(async () => ({ delivered: true }));
    const cap = makeAuditCapture();
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      container: cap.container,
    } as never);

    await endpoint.handleCapCall(bearer, "message.send", {
      channelId: "chan-1",
      text: "hi",
    });

    // The call dispatched through the sink (the audit does not block dispatch).
    expect(rpcCall).toHaveBeenCalledTimes(1);

    // audit:event — durable trail, full metadata tuple INCLUDING leaseId.
    const audits = cap.audit();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.kind).toBe("audit");
    expect(audits[0]!.outcome).toBe("success");
    const md = audits[0]!.metadata as Record<string, unknown>;
    expect(md.decision).toBe("allow");
    expect(md.capability).toBe("orch:message");
    expect(md.method).toBe("message.send");
    expect(md.leaseId).toBe(leaseId);
    expect(md.rootRunId).toBe("run-root-1");
    // A direct method has no inner tool — `tool` is honestly ABSENT.
    expect(md.tool).toBeUndefined();

    // capability:audited — the trajectory record, carrying the parent edge.
    const tree = cap.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]!.decision).toBe("allow");
    expect(tree[0]!.capability).toBe("orch:message");
    expect(tree[0]!.method).toBe("message.send");
    expect(tree[0]!.leaseId).toBe(leaseId);
    expect(tree[0]!.parentLeaseId).toBe("lease-parent-9");
    expect(tree[0]!.rootRunId).toBe("run-root-1");
    expect(tree[0]!.agentId).toBe("agent-sock");
    expect(tree[0]!.tool).toBeUndefined();
  });

  it("a DENIED direct session.spawn (the per-handler requireCapability throws CapabilityDeniedError downstream of the sink) emits decision=deny / kind=capability_denied with the lease tuple", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const { bearer, leaseId } = leaseManager.mintLease({
      agentId: "agent-sock",
      caps: ["orch:spawn"], // in-audience for session.spawn → validate passes
      budgetRef: "budget-1",
      sessionKey: "tenant-sock:user-1:chan-1",
      rootRunId: "run-root-1",
    });

    // The sink's per-handler requireCapability denies (a cap-not-held downstream
    // of the lease audience) — the realistic direct-method cap-deny WITH a real
    // lease in scope. The endpoint must record it as an audited deny.
    const { CapabilityDeniedError } = await import("@comis/core");
    const rpcCall = vi.fn(async () => {
      throw new CapabilityDeniedError("orch:spawn");
    });
    const cap = makeAuditCapture();
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      container: cap.container,
    } as never);

    await expect(
      endpoint.handleCapCall(bearer, "session.spawn", { agentId: "child" }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);

    const denyAudits = cap
      .audit()
      .filter((a) => (a.metadata as Record<string, unknown>)?.decision === "deny");
    expect(denyAudits).toHaveLength(1);
    expect(denyAudits[0]!.kind).toBe("capability_denied");
    expect(denyAudits[0]!.outcome).toBe("denied");
    const md = denyAudits[0]!.metadata as Record<string, unknown>;
    expect(md.capability).toBe("orch:spawn");
    expect(md.method).toBe("session.spawn");
    expect(md.leaseId).toBe(leaseId);
    expect(md.rootRunId).toBe("run-root-1");

    const treeDeny = cap.tree().filter((a) => a.decision === "deny");
    expect(treeDeny).toHaveLength(1);
    expect(treeDeny[0]!.leaseId).toBe(leaseId);
    expect(treeDeny[0]!.method).toBe("session.spawn");
  });

  it("an ALLOWED direct cron.add (the cron branch) emits audit:event + capability:audited with the lease tuple (decision=allow, method=cron.add, cap=orch:cron)", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const { bearer, leaseId } = leaseManager.mintLease({
      agentId: "agent-sock",
      caps: ["orch:cron"], // in-audience for cron.add (orch:cron)
      budgetRef: "budget-1",
      sessionKey: "tenant-sock:user-1:chan-1",
      rootRunId: "run-root-1",
    });

    const rpcCall = vi.fn(async () => ({ jobId: "job-1" }));
    const cap = makeAuditCapture();
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      container: cap.container,
    } as never);

    await endpoint.handleCapCall(bearer, "cron.add", { schedule: "* * * * *" });

    expect(rpcCall).toHaveBeenCalledTimes(1);

    const audits = cap.audit();
    expect(audits).toHaveLength(1);
    const md = audits[0]!.metadata as Record<string, unknown>;
    expect(md.decision).toBe("allow");
    expect(md.capability).toBe("orch:cron");
    expect(md.method).toBe("cron.add");
    expect(md.leaseId).toBe(leaseId);
    expect(md.rootRunId).toBe("run-root-1");

    const tree = cap.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]!.decision).toBe("allow");
    expect(tree[0]!.capability).toBe("orch:cron");
    expect(tree[0]!.method).toBe("cron.add");
    expect(tree[0]!.leaseId).toBe(leaseId);
  });

  it("content-hygiene: the direct-method socket emit carries the method NAME only — never the params", async () => {
    const clock = createTestClock();
    const leaseManager = createLeaseManager({ clock });
    const { bearer } = leaseManager.mintLease({
      agentId: "agent-sock",
      caps: ["orch:message"],
      budgetRef: "budget-1",
      sessionKey: "tenant-sock:user-1:chan-1",
      rootRunId: "run-root-1",
    });

    const rpcCall = vi.fn(async () => ({ delivered: true }));
    const cap = makeAuditCapture();
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      container: cap.container,
    } as never);

    await endpoint.handleCapCall(bearer, "message.send", {
      channelId: "chan-1",
      text: "PLANTED-MESSAGE-BODY",
      bearer: "should-never-be-here",
      apiKey: "sk-PLANTED-SECRET",
    });

    const auditJson = JSON.stringify(cap.audit()[0]);
    const treeJson = JSON.stringify(cap.tree()[0]);
    for (const blob of [auditJson, treeJson]) {
      expect(blob).not.toContain("PLANTED-MESSAGE-BODY");
      expect(blob).not.toContain("sk-PLANTED-SECRET");
      // The method NAME is present; no param values are.
      expect(blob).toContain("message.send");
      expect(blob).not.toContain("channelId");
      expect(blob).not.toContain("\"text\"");
    }
  });
});
