// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus, type ComisLogger } from "@comis/core";
import type {
  FollowupTaskStore,
  FollowupTaskStoreInspection,
  TaskAuthorityInspection,
  TaskAuthorityMaintenance,
} from "@comis/scheduler";
import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createTaskMaintenanceController } from "./task-maintenance-controller.js";

const RAW: TaskAuthorityInspection = {
  store: { exists: true, bytes: 66, digest: "a".repeat(64) },
  intent: { status: "none" },
};
const EMPTY_INSPECTION: FollowupTaskStoreInspection = { fileDigest: "a".repeat(64), tasks: [] };

function make(overrides: Partial<Parameters<typeof createTaskMaintenanceController>[0]> = {}) {
  const calls: string[] = [];
  const authority = {
    inspect: vi.fn(async () => ok(RAW)),
    recoverPendingReset: vi.fn(async () => { calls.push("recover"); return ok({ status: "none" as const }); }),
    reset: vi.fn(async () => {
      calls.push("reset");
      return ok({ operationId: "reset_1", beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64) });
    }),
  } satisfies TaskAuthorityMaintenance;
  const store = {
    initialize: vi.fn(async () => { calls.push("initialize"); return ok({ formatVersion: 1 as const, tasks: [], attempts: [], policySnapshots: [] }); }),
    inspect: vi.fn(async () => ok(EMPTY_INSPECTION)),
  } as unknown as FollowupTaskStore;
  const logger = {
    audit: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ComisLogger;
  const eventBus = new TypedEventBus();
  const deps = {
    agentId: "agent-a",
    tenantId: "tenant-a",
    configuredEnabled: false,
    authority,
    store,
    exclusiveDataDirLockOwned: () => true,
    reconcileOwnership: vi.fn(async () => { calls.push("ownership"); return ok({ recoveredChecking: 0, recoveredDelivering: 0 }); }),
    enterMaintenance: vi.fn(async () => {
      calls.push("maintenance");
      return ok({ taskCheckActiveCount: 0, extractionActiveCount: 0 });
    }),
    emitReset: vi.fn(),
    eventBus,
    logger,
    clock: { now: () => 50_000, nowDate: () => new Date(50_000) },
    ...overrides,
  };
  return { controller: createTaskMaintenanceController(deps), deps, authority, store, logger, eventBus, calls };
}

describe("follow-up task maintenance controller", () => {
  it("recovers an incomplete reset before interpreting the ordinary task store", async () => {
    const data = make();

    expect(await data.controller.initialize()).toEqual(ok(undefined));
    expect(data.calls).toEqual(["recover", "initialize", "ownership"]);
    expect(await data.controller.status()).toMatchObject({
      ok: true,
      value: {
        state: "disabled",
        configuredEnabled: false,
        strictAuthorityValid: true,
        ownershipReconciled: true,
        taskCount: 0,
        activeAttemptCount: 0,
      },
    });
  });

  it("keeps a schema-invalid store available for guarded raw reset", async () => {
    const data = make();
    data.store.initialize = vi.fn(async () => err({
      code: "invalid_state" as const,
      errorKind: "validation" as const,
      message: "invalid authority",
    }));

    expect(await data.controller.initialize()).toMatchObject({
      ok: false,
      error: { code: "initialization_failed", errorKind: "validation" },
    });
    data.store.initialize = vi.fn(async () => ok({ formatVersion: 1 as const, tasks: [], attempts: [], policySnapshots: [] }));
    expect(await data.controller.reset({
      expectedDigest: "a".repeat(64),
      confirmed: true,
      actorScope: "admin",
    })).toMatchObject({ ok: true, value: { state: "disabled", reinitialized: true } });
    expect(data.calls).toEqual(["recover", "maintenance", "reset", "ownership"]);
  });

  it("rejects reset while enabled before closing runtime admission", async () => {
    const data = make({ configuredEnabled: true });
    await data.controller.initialize();

    expect(await data.controller.reset({
      expectedDigest: "a".repeat(64),
      confirmed: true,
      actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "feature_enabled" } });
    expect(data.deps.enterMaintenance).not.toHaveBeenCalled();
    expect(data.authority.reset).not.toHaveBeenCalled();
  });

  it("requires singleton ownership and empty current-boot execution registries", async () => {
    const noLock = make({ exclusiveDataDirLockOwned: () => false });
    await noLock.controller.initialize();
    expect(await noLock.controller.reset({
      expectedDigest: "a".repeat(64), confirmed: true, actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "ownership_unproven" } });
    expect(noLock.deps.enterMaintenance).not.toHaveBeenCalled();

    const active = make({
      enterMaintenance: vi.fn(async () => ok({ taskCheckActiveCount: 1, extractionActiveCount: 2 })),
    });
    await active.controller.initialize();
    expect(await active.controller.reset({
      expectedDigest: "a".repeat(64), confirmed: true, actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "active_execution" } });
    expect(active.authority.reset).not.toHaveBeenCalled();
  });

  it("refuses valid-store reset until ownership is reconciled and attempts are inactive", async () => {
    const unreconciled = make({
      reconcileOwnership: vi.fn(async () => err({ errorKind: "precondition" as const, message: "not owned" })),
    });
    expect((await unreconciled.controller.initialize()).ok).toBe(false);
    expect(await unreconciled.controller.reset({
      expectedDigest: "a".repeat(64), confirmed: true, actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "ownership_reconciliation_failed" } });

    const activeAttempt = make();
    await activeAttempt.controller.initialize();
    activeAttempt.store.inspect = vi.fn(async () => ok({
      fileDigest: "a".repeat(64),
      tasks: [{
        id: "task_1", agentId: "agent-a", status: "checking", dueEarliestMs: 1, dueLatestMs: 2,
        expiresAtMs: 3, attemptCount: 1, preAcceptanceFailureCount: 0, sourceExecutionId: "exec_1",
        sourceOccurrenceCount: 1, conversationRef: "c".repeat(64),
      }],
    }));
    expect(await activeAttempt.controller.reset({
      expectedDigest: "a".repeat(64), confirmed: true, actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "active_attempt" } });
    expect(activeAttempt.authority.reset).not.toHaveBeenCalled();
  });

  it("rejects unknown store I/O state rather than treating it as corruption", async () => {
    const data = make();
    data.store.initialize = vi.fn(async () => err({
      code: "io" as const,
      errorKind: "internal" as const,
      message: "unreadable",
    }));

    expect((await data.controller.initialize()).ok).toBe(false);
    expect(await data.controller.reset({
      expectedDigest: "a".repeat(64), confirmed: true, actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "store_state_unknown" } });
    expect(data.authority.reset).not.toHaveBeenCalled();
  });

  it("audits and emits only content-free reset evidence after strict reinitialization", async () => {
    const data = make();
    const auditEvent = vi.fn();
    data.eventBus.on("audit:event", auditEvent);
    await data.controller.initialize();

    expect(await data.controller.reset({
      expectedDigest: "a".repeat(64), confirmed: true, actorScope: "admin",
    })).toMatchObject({
      ok: true,
      value: {
        operationId: "reset_1",
        beforeDigest: "a".repeat(64),
        afterDigest: "b".repeat(64),
        state: "disabled",
        reinitialized: true,
      },
    });
    expect(data.calls).toEqual([
      "recover", "initialize", "ownership", "maintenance", "reset", "initialize", "ownership",
    ]);
    expect(data.deps.emitReset).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a", operationId: "reset_1", timestamp: 50_000,
    }));
    expect(auditEvent).toHaveBeenCalledWith({
      timestamp: 50_000,
      agentId: "agent-a",
      tenantId: "tenant-a",
      actionType: "tasks.reset",
      kind: "audit",
      classification: "destructive",
      outcome: "success",
      metadata: {
        actorScope: "admin",
        decision: "accepted",
        expectedDigest: "a".repeat(64),
        operationId: "reset_1",
        beforeDigest: "a".repeat(64),
        afterDigest: "b".repeat(64),
      },
    });
  });

  it("retains valid ownership after a compare-and-set rejection so an exact retry can proceed", async () => {
    const data = make();
    await data.controller.initialize();
    data.authority.reset
      .mockResolvedValueOnce(err({
        code: "digest_mismatch" as const,
        errorKind: "precondition" as const,
        message: "changed",
      }))
      .mockResolvedValueOnce(ok({
        operationId: "reset_2",
        beforeDigest: "a".repeat(64),
        afterDigest: "b".repeat(64),
      }));

    expect(await data.controller.reset({
      expectedDigest: "0".repeat(64), confirmed: true, actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "digest_mismatch" } });
    expect(await data.controller.reset({
      expectedDigest: "a".repeat(64), confirmed: true, actorScope: "admin",
    })).toMatchObject({ ok: true, value: { operationId: "reset_2" } });
  });
});
