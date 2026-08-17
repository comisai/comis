// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import type { ManagedRunRecord } from "@comis/core";
import { createManagedRunHandlers } from "./managed-run-handlers.js";
import type { ManagedRunOperatorContext } from "./managed-run-context.js";

const NOW_MS = 1_800_000_600_000;

function record(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    schemaVersion: 1,
    managedRunId: "managed-run-a",
    serviceInstanceId: "service-instance-a",
    tenantId: "tenant-a",
    agentId: "agent-a",
    principalId: "principal-a",
    conversationRef: "c".repeat(64),
    rootRunId: "root-run-a",
    workspacePolicyHash: "b".repeat(64),
    capturedCapabilityViewHash: "d".repeat(64),
    capturedAgentCapabilities: ["orch:read"],
    capturedToolIds: ["managed_status"],
    executionAttachmentIds: [],
    terminalSessionIds: [],
    initiationSource: "user_request",
    status: "active",
    statusReason: "report_activity",
    lastAcceptedReportSequence: 3,
    lastReducedReportSequence: 3,
    pendingContinuation: false,
    openAttentionCount: 0,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_500,
    lastHeartbeatAtMs: NOW_MS - 1_000,
    ...overrides,
  } as ManagedRunRecord;
}

function context(overrides: Partial<ManagedRunOperatorContext> = {}): ManagedRunOperatorContext {
  return {
    store: {
      getForAdministration: vi.fn(async () => ok(record())),
      listForAdministration: vi.fn(async () => ok([record()])),
      listAttentionForAdministration: vi.fn(async () => ok([])),
    },
    cancellation: {
      cancel: vi.fn(async () => ok({
        kind: "cancelled" as const,
        managedRunId: "managed-run-a",
        serviceAcknowledged: true,
        serviceState: "cancelling" as const,
      })),
    },
    instances: [{
      serviceInstanceId: "service-instance-a",
      serviceDefinitionId: "example.service",
      enabled: true,
      mcpServerName: "example",
      allowedAgents: ["agent-a"],
      allowedWorkspaceRoots: [],
      allowedRuntimeRoots: [],
    }] as never,
    definitionScopes: () => ["health", "report"],
    instanceState: () => ({ state: "connected" as const, reasonCodes: [] }),
    heartbeatMaxAgeMs: 300_000,
    nowMs: () => NOW_MS,
    ...overrides,
  } as ManagedRunOperatorContext;
}

function handlers(overrides: Partial<ManagedRunOperatorContext> = {}) {
  return createManagedRunHandlers({ managedRuns: context(overrides) } as never);
}

describe("managed-run operator handlers", () => {
  it("renders a summary row without any service-authored content", async () => {
    const result = await handlers()["managedRuns.list"]!({}, {} as never);

    const row = (result as { rows: Record<string, unknown>[] }).rows[0]!;
    expect(row["managedRunId"]).toBe("managed-run-a");
    expect(row["openAttentionCount"]).toBe(0);
    const serialized = JSON.stringify(row);
    for (const forbidden of ["summary", "details", "artifact", "question", "body"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("reports a truncated page as truncated", async () => {
    // A caller that renders a capped page as the complete set tells an operator
    // there is nothing else to look at.
    const rows = Array.from({ length: 3 }, (_unused, index) => record({
      managedRunId: `managed-run-${index}`,
    }));
    const setup = handlers({
      store: {
        getForAdministration: vi.fn(async () => ok(record())),
        listForAdministration: vi.fn(async () => ok(rows)),
        listAttentionForAdministration: vi.fn(async () => ok([])),
      },
    });

    const result = await setup["managedRuns.list"]!({ limit: 3 }, {} as never);

    expect(result).toMatchObject({ total: 3, truncated: true });
  });

  it("labels a capability that has not shipped rather than omitting it", async () => {
    const result = await handlers()["managedRuns.get"]!(
      { managedRunId: "managed-run-a" },
      {} as never,
    );

    const run = (result as { run: Record<string, unknown> }).run;
    expect(run["custody"]).toEqual({ available: false, reasonCode: "stage_not_enabled" });
    expect(run["processSummary"]).toEqual({ available: false, reasonCode: "stage_not_enabled" });
  });

  it("names stale liveness as the likely cause and offers only reachable actions", async () => {
    const stale = record({ lastHeartbeatAtMs: NOW_MS - 400_000 });
    const setup = handlers({
      store: {
        getForAdministration: vi.fn(async () => ok(stale)),
        listForAdministration: vi.fn(async () => ok([stale])),
        listAttentionForAdministration: vi.fn(async () => ok([])),
      },
    });

    const result = await setup["managedRuns.explain"]!(
      { managedRunId: "managed-run-a" },
      {} as never,
    ) as { likelyRootCause: { code: string; hint: string }; nextSafeActions: string[] };

    expect(result.likelyRootCause.code).toBe("liveness_stale");
    expect(result.likelyRootCause.hint).toContain("service-instance-a");
    expect(result.nextSafeActions).toContain("inspect_service");
  });

  it("explains a waiting run as waiting on a human, not as a fault", async () => {
    const waiting = record({ status: "waiting", statusReason: "attention_pending", openAttentionCount: 1 });
    const setup = handlers({
      store: {
        getForAdministration: vi.fn(async () => ok(waiting)),
        listForAdministration: vi.fn(async () => ok([waiting])),
        listAttentionForAdministration: vi.fn(async () => ok([])),
      },
    });

    const result = await setup["managedRuns.explain"]!(
      { managedRunId: "managed-run-a" },
      {} as never,
    ) as { likelyRootCause: { code: string }; nextSafeActions: string[] };

    expect(result.likelyRootCause.code).toBe("waiting_on_human");
    expect(result.nextSafeActions).toEqual(expect.arrayContaining(["resolve_attention"]));
  });

  it("reports a missing run as not found rather than an empty successful row", async () => {
    const setup = handlers({
      store: {
        getForAdministration: vi.fn(async () => ok(undefined)),
        listForAdministration: vi.fn(async () => ok([])),
        listAttentionForAdministration: vi.fn(async () => ok([])),
      },
    });

    const explained = await setup["managedRuns.explain"]!(
      { managedRunId: "managed-run-zz" },
      {} as never,
    ) as { run?: unknown; likelyRootCause: { code: string } };

    expect(explained.run).toBeUndefined();
    expect(explained.likelyRootCause.code).toBe("run_not_found");
  });

  it("passes an operator cancel through the host coordinator", async () => {
    const cancel = vi.fn(async () => ok({
      kind: "cancelled" as const,
      managedRunId: "managed-run-a",
      serviceAcknowledged: false,
      serviceReasonCode: "instance_not_connected",
    }));
    const setup = handlers({ cancellation: { cancel } });

    const result = await setup["managedRuns.cancel"]!(
      { managedRunId: "managed-run-a", operationId: "operation-cancel-a" },
      {} as never,
    );

    expect(result).toMatchObject({
      outcome: "cancelled",
      serviceAcknowledged: false,
      serviceReasonCode: "instance_not_connected",
    });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ kind: "owner" }), expect.objectContaining({
      managedRunId: "managed-run-a",
      operationId: "operation-cancel-a",
      reason: "owner_cancelled",
    }));
  });
});
