// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the orchestrator-umbrella contract registry.
 *
 * Per-domain test pattern:
 *   - Aggregator sanity: count + method-name presence + scope assignments.
 *   - INTERNAL_FIELD_NAMES paired sanity (no contract request schema declares
 *     a dispatcher-injected `_X` key).
 *   - Route-scope invariant — only owner-scoped subagent lifecycle contracts
 *     expose both agent RPC and operator admin routes.
 *   - Per-contract spot-checks: request acceptance + rejection, response
 *     acceptance + rejection on representative strict wire shapes.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { createConversationRef } from "../domain/conversation-scope.js";
import {
  // cron-handlers.ts (8)
  CronAddContract,
  CronListContract,
  CronUpdateContract,
  CronRemoveContract,
  CronStatusContract,
  CronRunsContract,
  CronRunContract,
  CronResetContract,
  SchedulerWakeContract,
  // task-handlers.ts (3)
  TasksStatusContract,
  TasksListContract,
  TasksCancelContract,
  // graph-handlers.ts (12)
  GraphDefineContract,
  GraphExecuteContract,
  GraphStatusContract,
  GraphCancelContract,
  GraphSaveContract,
  GraphLoadContract,
  GraphListContract,
  GraphDeleteContract,
  GraphOutputsContract,
  GraphRunsContract,
  GraphRunDetailContract,
  GraphDeleteRunContract,
  // heartbeat-handlers.ts (4)
  HeartbeatStatesContract,
  HeartbeatGetContract,
  HeartbeatUpdateContract,
  HeartbeatTriggerContract,
  // subagent-handlers.ts (7)
  SubagentListContract,
  SubagentWaitContract,
  SubagentKillContract,
  SubagentSteerContract,
  SubagentPauseContract,
  SubagentResumeContract,
  SubagentStatusContract,
  // autonomy-handlers.ts (3) — admin-scoped autonomy live-control contracts
  LeaseRevokeContract,
  RunKillContract,
  AutonomyEvictContract,
  // replay-handlers.ts (1) — admin-scoped deterministic-replay contract
  OrchestrateReplayContract,
  ORCHESTRATOR_CONTRACTS,
  INTERNAL_FIELD_NAMES,
} from "./index.js";

// ===========================================================================
// Aggregator sanity
// ===========================================================================

describe("orchestrator-umbrella domain contracts", () => {
  it("ORCHESTRATOR_CONTRACTS has exactly 40 entries", () => {
    expect(ORCHESTRATOR_CONTRACTS.length).toBe(40);
  });

  it("method names match the 4 handler-factory PropertyAssignment keys", () => {
    const methods = ORCHESTRATOR_CONTRACTS.map((c) => c.method).sort();
    expect(methods).toEqual(
      [
        // cron-handlers.ts (8 — 7 cron.* + scheduler.wake)
        "cron.add",
        "cron.list",
        "cron.update",
        "cron.remove",
        "cron.status",
        "cron.runs",
        "cron.run",
        "cron.reset",
        "scheduler.wake",
        // task-handlers.ts (4)
        "tasks.status",
        "tasks.list",
        "tasks.cancel",
        "tasks.reset",
        // graph-handlers.ts (12)
        "graph.define",
        "graph.execute",
        "graph.status",
        "graph.cancel",
        "graph.save",
        "graph.load",
        "graph.list",
        "graph.delete",
        "graph.outputs",
        "graph.runs",
        "graph.runDetail",
        "graph.deleteRun",
        // heartbeat-handlers.ts (4)
        "heartbeat.states",
        "heartbeat.get",
        "heartbeat.update",
        "heartbeat.trigger",
        // subagent-handlers.ts (7)
        "subagent.list",
        "subagent.wait",
        "subagent.kill",
        "subagent.steer",
        "subagent.pause",
        "subagent.resume",
        "subagent.status",
        // autonomy-handlers.ts (3)
        "lease.revoke",
        "run.kill",
        "autonomy.evict",
        // replay-handlers.ts (1)
        "orchestrate.replay",
      ].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // Route-scope invariant
  // -------------------------------------------------------------------------

  it("only owner-scoped subagent lifecycle methods expose both agent and admin routes", () => {
    const dualScopeMethods = new Set([
      "subagent.list",
      "subagent.wait",
      "subagent.kill",
      "subagent.steer",
    ]);
    for (const c of ORCHESTRATOR_CONTRACTS) {
      expect(c.scopes, `${c.method} route scopes`).toEqual(
        dualScopeMethods.has(c.method) ? ["rpc", "admin"] : [c.scopes[0]],
      );
    }
  });

  // -------------------------------------------------------------------------
  // Scope assignment per handler-file cluster
  // -------------------------------------------------------------------------

  it("cron-handlers and graph-handlers are scoped to rpc per setup-gateway-api.ts:130-157 + 317-321", () => {
    const cronAndGraph = [
      CronAddContract,
      CronListContract,
      CronUpdateContract,
      CronRemoveContract,
      CronStatusContract,
      CronRunsContract,
      CronRunContract,
      SchedulerWakeContract,
      GraphDefineContract,
      GraphExecuteContract,
      GraphStatusContract,
      GraphCancelContract,
      GraphSaveContract,
      GraphLoadContract,
      GraphListContract,
      GraphDeleteContract,
      GraphOutputsContract,
      GraphRunsContract,
      GraphRunDetailContract,
      GraphDeleteRunContract,
    ];
    for (const c of cronAndGraph) expect(c.scopes, `${c.method} scopes`).toEqual(["rpc"]);
    expect(CronResetContract.scopes).toEqual(["admin"]);
  });

  it("heartbeat-handlers: all 4 admin-scoped per setup-gateway-api.ts:327-329", () => {
    const heartbeats = [
      HeartbeatStatesContract,
      HeartbeatGetContract,
      HeartbeatUpdateContract,
      HeartbeatTriggerContract,
    ];
    for (const c of heartbeats) expect(c.scopes, `${c.method} scopes`).toEqual(["admin"]);
  });

  it("follow-up task operator contracts stay admin-only", () => {
    for (const contract of [TasksStatusContract, TasksListContract, TasksCancelContract]) {
      expect(contract.scopes).toEqual(["admin"]);
    }
  });

  it("owner-scoped subagent methods expose dual routes while the global gate stays admin-only", () => {
    const subagents = [
      SubagentListContract,
      SubagentWaitContract,
      SubagentKillContract,
      SubagentSteerContract,
    ];
    for (const c of subagents) expect(c.scopes, `${c.method} scopes`).toEqual(["rpc", "admin"]);
    for (const c of [SubagentPauseContract, SubagentResumeContract, SubagentStatusContract]) {
      expect(c.scopes, `${c.method} scopes`).toEqual(["admin"]);
    }
  });

  it("autonomy-handlers: all 3 admin-scoped (→ ADMIN_METHODS → deny-by-origin)", () => {
    // scopes:["admin"] is LOAD-BEARING: it is what puts each method in the
    // DERIVED ADMIN_METHODS set so assertNotAgentOrigin denies any _agentId-
    // bearing (agent-origin) call automatically — no manual _agentId check.
    // autonomy.evict joins lease.revoke/run.kill: an agent cannot
    // self-un-evict (elevation-of-privilege guard).
    const autonomy = [LeaseRevokeContract, RunKillContract, AutonomyEvictContract];
    for (const c of autonomy) expect(c.scopes, `${c.method} scopes`).toEqual(["admin"]);
  });

  it("replay-handlers: orchestrate.replay admin-scoped (→ ADMIN_METHODS → deny-by-origin)", () => {
    // scopes:["admin"] is the confused-deputy mitigation: it lands
    // orchestrate.replay in the DERIVED ADMIN_METHODS set so assertNotAgentOrigin
    // denies any _agentId-bearing (agent-origin) call automatically — an agent
    // cannot self-invoke a replay of a run (INV-3), with no manual _agentId check.
    expect(OrchestrateReplayContract.scopes, "orchestrate.replay scopes").toEqual(["admin"]);
  });

  // -------------------------------------------------------------------------
  // INTERNAL_FIELD_NAMES paired sanity test
  // -------------------------------------------------------------------------

  it("INTERNAL_FIELD_NAMES is non-empty and stable", () => {
    expect(INTERNAL_FIELD_NAMES.length).toBeGreaterThan(0);
    expect(INTERNAL_FIELD_NAMES).toContain("_trustLevel");
    expect(INTERNAL_FIELD_NAMES).toContain("_agentId");
  });

  it("no contract request schema declares any INTERNAL_FIELD_NAMES key", () => {
    // Probe input carrying every internal-field name. Each request schema
    // should either silently strip it (z.object default) or accept-without-echo
    // (z.record / loose-record passthrough) — never echo an internal back as
    // a TOP-LEVEL declared field.
    const internalPayload: Record<string, unknown> = Object.fromEntries(
      INTERNAL_FIELD_NAMES.map((n) => [n, "probe-value"]),
    );

    for (const c of ORCHESTRATOR_CONTRACTS) {
      // Skip loose-record contracts: they're pass-through by design
      // (accepting any input including internals — same pattern as
      // channels.test.ts platform-action exclusion).
      // graph.execute + graph.load + graph.status are root-level
      // z.record(z.string(), z.unknown()) loose-records.
      const isLooseRecord = c.request._def.type === "record";
      if (isLooseRecord) continue;

      const minimalValid: Record<string, unknown> = {
        // common required fields across the registry — at least one
        // satisfies each contract's required-field check (or it's an empty
        // request which trivially accepts everything stripped).
        name: "x",
        jobName: "x",
        target: "x",
        message: "x",
        graphId: "x",
        agentId: "x",
        label: "x",
        id: "x",
        nodes: [{ nodeId: "n", task: "t" }],
      };
      const probe = { ...minimalValid, ...internalPayload };

      const parsed = c.request.safeParse(probe);
      if (parsed.success) {
        const outKeys = Object.keys(parsed.data as Record<string, unknown>);
        for (const internalKey of INTERNAL_FIELD_NAMES) {
          expect(outKeys, `${c.method} echoes internal "${internalKey}"`).not.toContain(internalKey);
        }
      }
      // If !success, the schema rejected the probe (e.g. on a required-field
      // mismatch); that's a valid outcome — the architectural test at
      // test/architecture/contract-internal-fields.test.ts is the
      // authoritative gate (asserts no contract DECLARES the internal field
      // as a top-level z.object field, regardless of strict-mode behavior).
    }
  });
});

// ===========================================================================
// cron.add
// ===========================================================================

function cronDeliveryTarget() {
  const destinationEndpoint = {
    channelType: "telegram",
    channelInstanceId: "bot-a",
    conversationId: "chat-a",
    threadId: "thread-a",
    conversationKind: "direct" as const,
  };
  const conversationScope = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "endpoint-conversation" as const, endpoint: destinationEndpoint },
  };
  const conversationRef = createConversationRef(conversationScope);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    conversation: { conversationScope, conversationRef: conversationRef.value },
    destinationEndpoint,
  };
}

describe("CronAddContract strict authoring projection", () => {
  it("exposes the canonical method name", () => {
    expect(CronAddContract.method).toBe("cron.add");
  });

  it("accepts an every schedule with an agent-turn payload", () => {
    expect(() =>
      CronAddContract.request.parse({
        name: "test-job",
        agentId: "default",
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "agent_turn", message: "hello" },
      }),
    ).not.toThrow();
  });

  it("accepts cron-style schedule (kind=cron + expr + tz)", () => {
    expect(() =>
      CronAddContract.request.parse({
        name: "morning",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Los_Angeles" },
        payload: { kind: "agent_turn", message: "good morning" },
      }),
    ).not.toThrow();
  });

  it("accepts at-style schedule (kind=at + at)", () => {
    expect(() =>
      CronAddContract.request.parse({
        name: "once",
        schedule: { kind: "at", at: "2026-06-01T12:00:00Z" },
        payload: { kind: "delivery", text: "happy june" },
        deliveryTarget: cronDeliveryTarget(),
      }),
    ).not.toThrow();
  });

  it("rejects the removed flattened scheduler payload shape", () => {
    expect(() =>
      CronAddContract.request.parse({
        name: "heartbeat-check",
        schedule_kind: "every",
        schedule_every_ms: 30000,
        payload_kind: "delivery",
        payload_text: "check-health",
      }),
    ).toThrow();
  });

  it("rejects request missing name", () => {
    expect(() =>
      CronAddContract.request.parse({
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "agent_turn", message: "hello" },
      }),
    ).toThrow();
  });

  it("accepts a resolved persisted schedule response", () => {
    expect(() =>
      CronAddContract.response.parse({
        jobId: "uuid-1",
        name: "test-job",
        schedule: { kind: "every", everyMs: 60000, anchorMs: 1_800_000_000_000 },
      }),
    ).not.toThrow();
  });

  it("rejects an unresolved every schedule response", () => {
    expect(() =>
      CronAddContract.response.parse({
        jobId: "uuid-1",
        name: "test-job",
        schedule: { kind: "every", everyMs: 60000 },
      }),
    ).toThrow();
  });
});

// ===========================================================================
// CronListContract
// ===========================================================================

describe("CronListContract", () => {
  it("accepts empty request", () => {
    expect(() => CronListContract.request.parse({})).not.toThrow();
  });

  it("accepts response with empty jobs", () => {
    expect(() => CronListContract.response.parse({ jobs: [] })).not.toThrow();
  });

  it("accepts strict authored and built-in job projections", () => {
    expect(() =>
      CronListContract.response.parse({
        jobs: [
          {
            id: "j1",
            name: "first",
            agentId: "agent-a",
            source: "authored",
            schedule: { kind: "every", everyMs: 60000, anchorMs: 1_800_000_000_000 },
            lifecycle: { status: "scheduled", nextRunAtMs: 1_800_000_060_000, consecutiveDependencyErrors: 0 },
            payload: { kind: "agent_turn", message: "hello" },
            sessionPolicy: { strategy: "fresh" },
            continuationMode: "none",
          },
          {
            id: "j2",
            name: "second",
            agentId: "agent-a",
            source: "built_in",
            schedule: { kind: "cron", expr: "0 4 * * *", tz: "UTC" },
            lifecycle: { status: "paused", nextRunAtMs: 1_800_086_400_000, consecutiveDependencyErrors: 2, reason: "dependency_errors" },
            payload: { kind: "internal_action", action: "reflection" },
          },
        ],
      }),
    ).not.toThrow();
  });
});

// ===========================================================================
// CronUpdateContract
// ===========================================================================

describe("CronUpdateContract", () => {
  it("accepts request with jobId and a paused mutation", () => {
    expect(() =>
      CronUpdateContract.request.parse({ jobId: "j1", paused: true }),
    ).not.toThrow();
  });

  it("accepts request with jobName, schedule, and payload", () => {
    expect(() =>
      CronUpdateContract.request.parse({
        jobName: "old",
        schedule: { kind: "every", everyMs: 120000 },
        payload: { kind: "agent_turn", message: "updated" },
      }),
    ).not.toThrow();
  });

  it("accepts deliveryTarget = null (clears the binding)", () => {
    expect(() =>
      CronUpdateContract.request.parse({ jobId: "j1", deliveryTarget: null }),
    ).not.toThrow();
  });

  it("accepts deliveryTarget = object (sets channel binding)", () => {
    expect(() =>
      CronUpdateContract.request.parse({
        jobId: "j1",
        deliveryTarget: cronDeliveryTarget(),
      }),
    ).not.toThrow();
  });

  it("response carries jobName + updated", () => {
    expect(() =>
      CronUpdateContract.response.parse({ jobName: "x", updated: true }),
    ).not.toThrow();
  });
});

// ===========================================================================
// CronRemoveContract
// ===========================================================================

describe("CronRemoveContract", () => {
  it("accepts request with jobName", () => {
    expect(() => CronRemoveContract.request.parse({ jobName: "x" })).not.toThrow();
  });

  it("rejects request missing jobName", () => {
    expect(() => CronRemoveContract.request.parse({})).toThrow();
  });

  it("response carries jobName + removed", () => {
    expect(() =>
      CronRemoveContract.response.parse({ jobName: "x", removed: true }),
    ).not.toThrow();
  });
});

// ===========================================================================
// CronStatusContract / CronRunsContract / CronRunContract / SchedulerWakeContract
// ===========================================================================

describe("CronStatusContract", () => {
  it("response: running + jobCount", () => {
    expect(() =>
      CronStatusContract.response.parse({
        state: "active",
        configuredEnabled: true,
        running: true,
        strictAuthoritiesValid: true,
        ownershipReconciled: true,
        jobCount: 3,
        activeClaimCount: 0,
        resolvedAgentId: "agent-a",
        store: { exists: true, bytes: 10, digest: "a".repeat(64) },
        ledger: { exists: true, bytes: 20, digest: "b".repeat(64) },
        intent: { status: "none" },
      }),
    ).not.toThrow();
  });

  it("response rejects non-numeric jobCount", () => {
    expect(() =>
      CronStatusContract.response.parse({
        state: "active",
        configuredEnabled: true,
        running: true,
        strictAuthoritiesValid: true,
        ownershipReconciled: true,
        jobCount: "x" as unknown as number,
        activeClaimCount: 0,
        resolvedAgentId: "agent-a",
        store: { exists: true, bytes: 10, digest: "a".repeat(64) },
        ledger: { exists: true, bytes: 20, digest: "b".repeat(64) },
        intent: { status: "none" },
      }),
    ).toThrow();
  });
});

describe("CronRunsContract", () => {
  it("request with jobName only", () => {
    expect(() => CronRunsContract.request.parse({ jobName: "x" })).not.toThrow();
  });

  it("request with jobName + limit", () => {
    expect(() =>
      CronRunsContract.request.parse({ jobName: "x", limit: 50 }),
    ).not.toThrow();
  });

  it("response with empty runs", () => {
    expect(() => CronRunsContract.response.parse({ runs: [] })).not.toThrow();
  });

  it("response preserves bounded internal-action diagnostic counters", () => {
    const run = {
      executionId: "execution-a",
      jobId: "job-a",
      agentId: "agent-a",
      scheduledForMs: 1_800_000_000_000,
      trigger: "scheduled",
      workKind: "internal_action",
      rootRunId: "root-cron-execution-a",
      startedAtMs: 1_800_000_000_000,
      terminalAtMs: 1_800_000_000_050,
      durationMs: 50,
      status: "failed",
      deliveryStatus: "not_requested",
      errorKind: "dependency",
      counters: [
        { name: "selected", value: 8 },
        { name: "dependency_failures", value: 1 },
      ],
    };

    expect(CronRunsContract.response.parse({ runs: [run] })).toEqual({ runs: [run] });
    expect(() => CronRunsContract.response.parse({
      runs: [{
        ...run,
        counters: Array.from({ length: 33 }, (_, index) => ({ name: `counter_${index}`, value: index })),
      }],
    })).toThrow();
  });
});

describe("CronRunContract", () => {
  it("request: force mode with jobName", () => {
    expect(() =>
      CronRunContract.request.parse({ jobName: "x", mode: "force" }),
    ).not.toThrow();
  });

  it("request: due mode without jobName (handler runs all missed)", () => {
    expect(() => CronRunContract.request.parse({ mode: "due" })).not.toThrow();
  });

  it("response: triggered + mode + optional jobName", () => {
    expect(() =>
      CronRunContract.response.parse({
        triggered: true,
        mode: "force",
        jobName: "x",
        resolvedAgentId: "agent-a",
        executionId: "execution-a",
      }),
    ).not.toThrow();
  });
});

describe("SchedulerWakeContract (registration-plane-agnostic)", () => {
  it("method name + rpc scope", () => {
    expect(SchedulerWakeContract.method).toBe("scheduler.wake");
    expect(SchedulerWakeContract.scopes).toEqual(["rpc"]);
  });

  it("accepts an exact agent target kind", () => {
    expect(() => SchedulerWakeContract.request.parse({ target: "agent" })).not.toThrow();
  });

  it("accepts the monitoring target kind", () => {
    expect(() =>
      SchedulerWakeContract.request.parse({ target: "monitoring" }),
    ).not.toThrow();
  });

  it("response carries the coordinator admission identity", () => {
    expect(() =>
      SchedulerWakeContract.response.parse({
        status: "accepted",
        disposition: "new_occurrence",
        correlationId: "wake-1",
        lane: "normal",
        retainedReason: "wake",
      }),
    ).not.toThrow();
  });
});

// ===========================================================================
// GraphDefineContract / GraphExecuteContract (loose-record)
// ===========================================================================

describe("GraphDefineContract", () => {
  it("accepts minimal nodes request", () => {
    expect(() =>
      GraphDefineContract.request.parse({
        nodes: [{ nodeId: "a", task: "do something" }],
      }),
    ).not.toThrow();
  });

  it("accepts request with label + onFailure + timeoutMs", () => {
    expect(() =>
      GraphDefineContract.request.parse({
        nodes: [{ nodeId: "a", task: "x" }],
        label: "pipeline-1",
        onFailure: "stop",
        timeoutMs: 30000,
      }),
    ).not.toThrow();
  });

  it("response carries valid + nodeCount + executionOrder + warnings + errors + userVariables", () => {
    expect(() =>
      GraphDefineContract.response.parse({
        valid: true,
        nodeCount: 2,
        executionOrder: ["a", "b"],
        warnings: [],
        errors: [],
        userVariables: ["ticker"],
      }),
    ).not.toThrow();
  });
});

describe("GraphExecuteContract (loose-record)", () => {
  it("method name + rpc scope", () => {
    expect(GraphExecuteContract.method).toBe("graph.execute");
    expect(GraphExecuteContract.scopes).toEqual(["rpc"]);
  });

  it("request is z.record(z.string(), z.unknown()) — accepts any record", () => {
    expect(() =>
      GraphExecuteContract.request.parse({
        nodes: [{ nodeId: "a", task: "x" }],
        variables: { ticker: "AAPL" },
      }),
    ).not.toThrow();
  });

  it("response is z.record(z.string(), z.unknown()) — accepts the typed-any return shape", () => {
    expect(() =>
      GraphExecuteContract.response.parse({
        graphId: "g1",
        async: true,
        nodeCount: 3,
        label: "test",
        hint: "Graph running",
      }),
    ).not.toThrow();
  });
});

describe("GraphStatusContract", () => {
  it("accepts request without graphId (list variant)", () => {
    expect(() => GraphStatusContract.request.parse({})).not.toThrow();
  });

  it("accepts request with graphId (per-graph variant)", () => {
    expect(() =>
      GraphStatusContract.request.parse({ graphId: "g1" }),
    ).not.toThrow();
  });

  it("response is loose-record (2-variant discriminated by graphId presence)", () => {
    expect(() =>
      GraphStatusContract.response.parse({
        graphs: [{ graphId: "g1" }],
        concurrency: { running: 1, queued: 0 },
      }),
    ).not.toThrow();
  });
});

describe("GraphCancelContract", () => {
  it("accepts graphId or graph_id", () => {
    expect(() =>
      GraphCancelContract.request.parse({ graphId: "g1" }),
    ).not.toThrow();
    expect(() =>
      GraphCancelContract.request.parse({ graph_id: "g1" }),
    ).not.toThrow();
  });

  it("accepts the canonical response shape", () => {
    expect(() =>
      GraphCancelContract.response.parse({ cancelled: true, graphId: "g1" }),
    ).not.toThrow();
  });
});

describe("GraphSaveContract", () => {
  it("accepts valid request with label + nodes", () => {
    expect(() =>
      GraphSaveContract.request.parse({
        label: "saved-graph-1",
        nodes: [{ nodeId: "a", task: "x" }],
      }),
    ).not.toThrow();
  });

  it("rejects request without label", () => {
    expect(() =>
      GraphSaveContract.request.parse({
        nodes: [{ nodeId: "a", task: "x" }],
      }),
    ).toThrow();
  });

  it("response: id + saved", () => {
    expect(() =>
      GraphSaveContract.response.parse({ id: "graph-id", saved: true }),
    ).not.toThrow();
  });
});

describe("GraphLoadContract", () => {
  it("rejects requests missing the required id field", () => {
    expect(() => GraphLoadContract.request.parse({ id: "g1" })).not.toThrow();
    expect(() => GraphLoadContract.request.parse({})).toThrow();
  });

  it("response is loose-record (full entry shape)", () => {
    expect(() =>
      GraphLoadContract.response.parse({
        id: "g1",
        tenantId: "default",
        nodes: [],
        edges: [],
      }),
    ).not.toThrow();
  });
});

describe("GraphListContract", () => {
  it("accepts empty request", () => {
    expect(() => GraphListContract.request.parse({})).not.toThrow();
  });

  it("accepts request with limit + offset", () => {
    expect(() =>
      GraphListContract.request.parse({ limit: 50, offset: 0 }),
    ).not.toThrow();
  });

  it("response: entries + total", () => {
    expect(() =>
      GraphListContract.response.parse({ entries: [], total: 0 }),
    ).not.toThrow();
  });
});

describe("GraphDeleteContract", () => {
  it("accepts request with id", () => {
    expect(() => GraphDeleteContract.request.parse({ id: "g1" })).not.toThrow();
  });

  it("rejects request without id", () => {
    expect(() => GraphDeleteContract.request.parse({})).toThrow();
  });

  it("response: id + deleted", () => {
    expect(() =>
      GraphDeleteContract.response.parse({ id: "g1", deleted: true }),
    ).not.toThrow();
  });
});

describe("GraphOutputsContract", () => {
  it("accepts graphId or graph_id request", () => {
    expect(() =>
      GraphOutputsContract.request.parse({ graphId: "g1" }),
    ).not.toThrow();
  });

  it("response carries graphId + outputs (nodeId → string|null) + source", () => {
    expect(() =>
      GraphOutputsContract.response.parse({
        graphId: "g1",
        outputs: { a: "output text", b: null },
        source: "memory",
      }),
    ).not.toThrow();
  });
});

describe("GraphRunsContract", () => {
  it("accepts empty request", () => {
    expect(() => GraphRunsContract.request.parse({})).not.toThrow();
  });

  it("response carries runs with completed status", () => {
    expect(() =>
      GraphRunsContract.response.parse({
        runs: [
          {
            graphId: "g1",
            name: "AAPL Analysis",
            status: "completed",
            nodeCount: 3,
            date: "2026-05-13T00:00:00Z",
            fileCount: 6,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects unknown status enum", () => {
    expect(() =>
      GraphRunsContract.response.parse({
        runs: [
          {
            graphId: "g1",
            name: "x",
            status: "pending" as unknown as "completed",
            nodeCount: 1,
            date: "x",
            fileCount: 1,
          },
        ],
      }),
    ).toThrow();
  });
});

describe("GraphRunDetailContract", () => {
  it("response carries name + status + nodes with artifacts", () => {
    expect(() =>
      GraphRunDetailContract.response.parse({
        graphId: "g1",
        name: "AAPL Analysis",
        status: "completed",
        date: "2026-05-13T00:00:00Z",
        nodes: [
          {
            nodeId: "a",
            output: "node output",
            artifacts: [{ filename: "a_chart.md", content: "x" }],
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("GraphDeleteRunContract", () => {
  it("accepts the canonical response shape", () => {
    expect(() =>
      GraphDeleteRunContract.response.parse({ graphId: "g1", deleted: true }),
    ).not.toThrow();
  });
});

// ===========================================================================
// Heartbeat contracts
// ===========================================================================

describe("HeartbeatStatesContract", () => {
  it("accepts empty request", () => {
    expect(() => HeartbeatStatesContract.request.parse({})).not.toThrow();
  });

  it("accepts response with one state entry", () => {
    expect(() =>
      HeartbeatStatesContract.response.parse({
        agents: [
          {
            agentId: "default",
            enabled: true,
            intervalMs: 60000,
            nextDueAtMs: 61000,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts a disabled agent with no armed periodic phase", () => {
    expect(() =>
      HeartbeatStatesContract.response.parse({
        agents: [
          {
            agentId: "x",
            enabled: false,
            intervalMs: 1,
            nextDueAtMs: null,
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("HeartbeatGetContract", () => {
  it("accepts request with agentId", () => {
    expect(() =>
      HeartbeatGetContract.request.parse({ agentId: "default" }),
    ).not.toThrow();
  });

  it("response: agentId + perAgent loose-record + optional effective", () => {
    expect(() =>
      HeartbeatGetContract.response.parse({
        agentId: "default",
        perAgent: { enabled: true, intervalMs: 60000 },
        effective: { enabled: true, intervalMs: 60000, prompt: "..." },
      }),
    ).not.toThrow();
  });
});

describe("HeartbeatUpdateContract", () => {
  it("accepts request with agentId + intervalMs patch", () => {
    expect(() =>
      HeartbeatUpdateContract.request.parse({
        agentId: "default",
        intervalMs: 30000,
      }),
    ).not.toThrow();
  });

  it("accepts a complete exact delivery endpoint", () => {
    expect(() =>
      HeartbeatUpdateContract.request.parse({
        agentId: "default",
        target: {
          channelType: "telegram",
          channelInstanceId: "bot-main",
          conversationId: "chat-1",
          threadId: "thread-1",
          conversationKind: "shared",
        },
      }),
    ).not.toThrow();
  });

  it("rejects legacy flattened and incomplete delivery targets", () => {
    expect(() =>
      HeartbeatUpdateContract.request.parse({
        agentId: "default",
        targetChannelType: "telegram",
        targetChannelId: "bot-main",
        targetChatId: "chat-1",
        targetIsDm: false,
      }),
    ).toThrow();
    expect(() =>
      HeartbeatUpdateContract.request.parse({
        agentId: "default",
        target: { channelType: "telegram", conversationId: "chat-1" },
      }),
    ).toThrow();
  });

  it("response: agentId + config + updated", () => {
    expect(() =>
      HeartbeatUpdateContract.response.parse({
        agentId: "default",
        config: { enabled: true, intervalMs: 60000 },
        updated: true,
        nextDueAtMs: 61000,
      }),
    ).not.toThrow();
  });
});

describe("HeartbeatTriggerContract", () => {
  it("accepts request with agentId", () => {
    expect(() =>
      HeartbeatTriggerContract.request.parse({ agentId: "default" }),
    ).not.toThrow();
  });

  it("accepts the canonical response shape", () => {
    expect(() =>
      HeartbeatTriggerContract.response.parse({
        agentId: "default",
        admission: {
          status: "accepted",
          disposition: "new_occurrence",
          correlationId: "heartbeat-1",
          lane: "normal",
          retainedReason: "manual",
        },
      }),
    ).not.toThrow();
  });
});

// ===========================================================================
// Subagent contracts
// ===========================================================================

describe("SubagentListContract", () => {
  it("accepts empty request", () => {
    expect(() => SubagentListContract.request.parse({})).not.toThrow();
  });

  it("accepts request with recentMinutes", () => {
    expect(() =>
      SubagentListContract.request.parse({ recentMinutes: 60 }),
    ).not.toThrow();
  });

  it("response: runs (loose-record array) + total", () => {
    expect(() =>
      SubagentListContract.response.parse({
        runs: [{ runId: "r1", agentId: "default", task: "x", state: "running" }],
        total: 1,
      }),
    ).not.toThrow();
  });
});

describe("SubagentKillContract", () => {
  it("accepts request with target", () => {
    expect(() =>
      SubagentKillContract.request.parse({ target: "r1" }),
    ).not.toThrow();
  });

  it("rejects request without target", () => {
    expect(() => SubagentKillContract.request.parse({})).toThrow();
  });

  it("accepts the canonical response shape", () => {
    expect(() =>
      SubagentKillContract.response.parse({ killed: true, runId: "r1" }),
    ).not.toThrow();
  });
});

describe("SubagentSteerContract", () => {
  it("accepts request with target + message", () => {
    expect(() =>
      SubagentSteerContract.request.parse({ target: "r1", message: "new task" }),
    ).not.toThrow();
  });

  it("rejects request missing target", () => {
    expect(() =>
      SubagentSteerContract.request.parse({ message: "x" }),
    ).toThrow();
  });

  it("rejects request missing message", () => {
    expect(() =>
      SubagentSteerContract.request.parse({ target: "r1" }),
    ).toThrow();
  });

  it("response: status = 'steered' literal + oldRunId + newRunId", () => {
    expect(() =>
      SubagentSteerContract.response.parse({
        status: "steered",
        oldRunId: "r1",
        newRunId: "r2",
      }),
    ).not.toThrow();
  });

  it("rejects response with non-'steered' status", () => {
    expect(() =>
      SubagentSteerContract.response.parse({
        status: "rejected" as unknown as "steered",
        oldRunId: "r1",
        newRunId: "r2",
      }),
    ).toThrow();
  });
});

// ===========================================================================
// Autonomy contracts (admin RPC: lease.revoke + run.kill)
// ===========================================================================
//
// The two operator-facing live-control methods. `scopes:["admin"]` is the
// load-bearing declaration: it puts each method in the DERIVED ADMIN_METHODS
// set (rpc-dispatch.ts:159) so `assertNotAgentOrigin` denies any agent-origin
// (_agentId-bearing) call automatically — the deny-by-origin guarantee, with NO
// manual _agentId check anywhere (a manual check would drift). The daemon
// handlers drive the LeaseManager revoke fan-outs + the runner's
// killByRootRun; these tests pin the CONTRACT surface.

describe("LeaseRevokeContract (revoke by leaseId OR rootRunId)", () => {
  it("exposes the canonical method name + admin scope", () => {
    expect(LeaseRevokeContract.method).toBe("lease.revoke");
    expect(LeaseRevokeContract.scopes).toEqual(["admin"]);
  });

  it("accepts a leaseId-only request (revoke a single lease)", () => {
    expect(() => LeaseRevokeContract.request.parse({ leaseId: "lease-1" })).not.toThrow();
  });

  it("accepts a rootRunId-only request (revoke a whole tree's leases)", () => {
    expect(() => LeaseRevokeContract.request.parse({ rootRunId: "root-1" })).not.toThrow();
  });

  it("accepts an empty request (both selectors optional — one-of enforced in the handler)", () => {
    expect(() => LeaseRevokeContract.request.parse({})).not.toThrow();
  });

  it("response carries the non-negative revoked count", () => {
    expect(() => LeaseRevokeContract.response.parse({ revoked: 2 })).not.toThrow();
    expect(() => LeaseRevokeContract.response.parse({ revoked: 0 })).not.toThrow();
  });

  it("rejects a negative revoked count", () => {
    expect(() => LeaseRevokeContract.response.parse({ revoked: -1 })).toThrow();
  });
});

describe("RunKillContract (kill a whole tree by rootRunId)", () => {
  it("exposes the canonical method name + admin scope", () => {
    expect(RunKillContract.method).toBe("run.kill");
    expect(RunKillContract.scopes).toEqual(["admin"]);
  });

  it("accepts a rootRunId request", () => {
    expect(() => RunKillContract.request.parse({ rootRunId: "root-1" })).not.toThrow();
  });

  it("rejects a request missing rootRunId", () => {
    expect(() => RunKillContract.request.parse({})).toThrow();
  });

  it("response carries the non-negative killed count", () => {
    expect(() => RunKillContract.response.parse({ killed: 3 })).not.toThrow();
    expect(() => RunKillContract.response.parse({ killed: 0 })).not.toThrow();
  });

  it("rejects a negative killed count", () => {
    expect(() => RunKillContract.response.parse({ killed: -1 })).toThrow();
  });
});

describe("AutonomyEvictContract (demote a whole tree by rootRunId)", () => {
  it("exposes the canonical method name + admin scope", () => {
    expect(AutonomyEvictContract.method).toBe("autonomy.evict");
    expect(AutonomyEvictContract.scopes).toEqual(["admin"]);
  });

  it("accepts a rootRunId request", () => {
    expect(() => AutonomyEvictContract.request.parse({ rootRunId: "root-1" })).not.toThrow();
  });

  it("rejects a request missing rootRunId", () => {
    expect(() => AutonomyEvictContract.request.parse({})).toThrow();
  });

  it("response carries the evicted boolean", () => {
    expect(() => AutonomyEvictContract.response.parse({ evicted: true })).not.toThrow();
    expect(() => AutonomyEvictContract.response.parse({ evicted: false })).not.toThrow();
  });

  it("rejects a non-boolean evicted value", () => {
    expect(() => AutonomyEvictContract.response.parse({ evicted: 1 })).toThrow();
  });
});

describe("Autonomy admin contracts — registry membership + deny-by-origin set", () => {
  it("all three methods are present in ORCHESTRATOR_CONTRACTS", () => {
    const methods = ORCHESTRATOR_CONTRACTS.map((c) => c.method);
    expect(methods).toContain("lease.revoke");
    expect(methods).toContain("run.kill");
    expect(methods).toContain("autonomy.evict");
  });

  it("all three methods land in the admin-derived set (the deny-by-origin guarantee — ADMIN_METHODS)", () => {
    const adminMethods = ORCHESTRATOR_CONTRACTS.filter((c) => c.scopes.includes("admin")).map(
      (c) => c.method,
    );
    expect(adminMethods).toContain("lease.revoke");
    expect(adminMethods).toContain("run.kill");
    expect(adminMethods).toContain("autonomy.evict");
  });
});
