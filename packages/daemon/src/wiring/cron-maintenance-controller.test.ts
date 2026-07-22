// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { TypedEventBus } from "@comis/core";
import {
  createCronMaintenanceController,
  type CronMaintenanceControllerDeps,
} from "./cron-maintenance-controller.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);

function deps(overrides: Partial<CronMaintenanceControllerDeps> = {}): CronMaintenanceControllerDeps {
  const snapshot = {
    formatVersion: 1 as const,
    agentSchedulerSeed: "seed-a",
    jobs: [],
    activeClaims: [],
  };
  return {
    agentId: "agent-a",
    tenantId: "tenant-a",
    configuredEnabled: true,
    authority: {
      inspect: vi.fn(async () => ok({
        store: { exists: true, bytes: 10, digest: DIGEST_A },
        ledger: { exists: true, bytes: 20, digest: DIGEST_B },
        intent: { status: "none" as const },
      })),
      recoverPendingReset: vi.fn(async () => ok({ status: "none" as const })),
      reset: vi.fn(async () => ok({
        operationId: "operation-a",
        target: "all" as const,
        beforeDigests: { store: DIGEST_A, ledger: DIGEST_B },
        afterDigests: { store: DIGEST_C, ledger: DIGEST_D },
      })),
    },
    store: {
      initialize: vi.fn(async () => ok(snapshot)),
      getSnapshot: vi.fn(() => ok(snapshot)),
      reconcileBuiltIns: vi.fn(async () => ok(undefined)),
    } as never,
    tracker: { initialize: vi.fn(async () => ok({ executions: 0, fileDigest: DIGEST_B })) } as never,
    scheduler: {
      initialize: vi.fn(async () => ok(undefined)),
      reload: vi.fn(async () => ok(undefined)),
      activate: vi.fn(() => ok(undefined)),
      enterMaintenance: vi.fn(() => ok({ activeExecutions: 0 })),
      getJobs: vi.fn(() => ok([])),
    } as never,
    reconcileOwnership: vi.fn(async () => ok({
      recoveredBeforeStart: 0,
      ownerLostAfterStart: 0,
      settledFromTerminal: 0,
      retainedCurrentBoot: 0,
    })),
    desiredBuiltIns: vi.fn(() => []),
    dependenciesReady: vi.fn(() => true),
    onReady: vi.fn(),
    onQuiesced: vi.fn(),
    emitReset: vi.fn(),
    eventBus: new TypedEventBus(),
    logger: createMockLogger() as never,
    clock: { now: () => 1_000, nowDate: () => new Date(1_000) },
    ...overrides,
  };
}

describe("daemon cron maintenance controller", () => {
  it("keeps raw status available when strict scheduler initialization fails", async () => {
    const input = deps();
    vi.mocked(input.scheduler!.initialize).mockResolvedValueOnce(err({
      code: "initialization_failed",
      errorKind: "validation",
      message: "store is corrupt",
    }));
    const controller = createCronMaintenanceController(input);

    expect(await controller.initialize()).toMatchObject({
      ok: false,
      error: { code: "initialization_failed", errorKind: "validation" },
    });
    expect(await controller.status()).toEqual(ok({
      state: "failed",
      configuredEnabled: true,
      strictAuthoritiesValid: false,
      ownershipReconciled: false,
      jobCount: 0,
      activeClaimCount: 0,
      store: { exists: true, bytes: 10, digest: DIGEST_A },
      ledger: { exists: true, bytes: 20, digest: DIGEST_B },
      intent: { status: "none" },
      lastError: { code: "initialization_failed", errorKind: "validation" },
    }));
    expect(input.onReady).not.toHaveBeenCalled();
  });

  it("refuses reset while a current-boot execution is active and stays quiesced", async () => {
    const input = deps();
    const auditEvent = vi.fn();
    input.eventBus.on("audit:event", auditEvent);
    vi.mocked(input.scheduler!.enterMaintenance).mockReturnValueOnce(ok({ activeExecutions: 1 }));
    const controller = createCronMaintenanceController(input);
    expect((await controller.initialize()).ok).toBe(true);
    expect(controller.activate()).toEqual(ok(undefined));

    expect(await controller.reset({
      target: "all",
      expectedDigests: { store: DIGEST_A, ledger: DIGEST_B },
      confirmed: true,
      actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "active_execution" } });
    expect(input.onQuiesced).toHaveBeenCalledWith("agent-a");
    expect(input.authority.reset).not.toHaveBeenCalled();
    expect((await controller.status()).ok && (await controller.status()).value.state).toBe("maintenance");
    expect(auditEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      tenantId: "tenant-a",
      actionType: "cron.reset",
      classification: "destructive",
      outcome: "denied",
      metadata: expect.objectContaining({ decision: "rejected", code: "active_execution", target: "all" }),
    }));
  });

  it("requires strict ownership proof for either single-file reset", async () => {
    const input = deps();
    const controller = createCronMaintenanceController(input);

    expect(await controller.reset({
      target: "store",
      expectedDigests: { store: DIGEST_A },
      confirmed: true,
      actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "unsafe_single_file" } });
    expect(input.authority.reset).not.toHaveBeenCalled();
  });

  it("rejects a single-file reset when a valid store still has active claims", async () => {
    const input = deps();
    vi.mocked(input.store.getSnapshot).mockReturnValue(ok({
      formatVersion: 1,
      agentSchedulerSeed: "seed-a",
      jobs: [],
      activeClaims: [{ executionId: "execution-a" }],
    } as never));
    const controller = createCronMaintenanceController(input);
    expect((await controller.initialize()).ok).toBe(true);

    expect(await controller.reset({
      target: "ledger",
      expectedDigests: { ledger: DIGEST_B },
      confirmed: true,
      actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "unsafe_single_file" } });
    expect(input.authority.reset).not.toHaveBeenCalled();
  });

  it("reloads, reconciles built-ins, and reactivates after a successful all reset", async () => {
    const input = deps();
    const auditEvent = vi.fn();
    input.eventBus.on("audit:event", auditEvent);
    const controller = createCronMaintenanceController(input);
    expect((await controller.initialize()).ok).toBe(true);
    expect(controller.activate()).toEqual(ok(undefined));
    vi.mocked(input.store.getSnapshot).mockReturnValue(ok({
      formatVersion: 1,
      agentSchedulerSeed: "seed-after",
      jobs: [],
      activeClaims: [],
    }));

    expect(await controller.reset({
      target: "all",
      expectedDigests: { store: DIGEST_A, ledger: DIGEST_B },
      confirmed: true,
      actorScope: "admin",
    })).toMatchObject({
      ok: true,
      value: { operationId: "operation-a", target: "all", reactivated: true, state: "active" },
    });
    expect(input.scheduler!.reload).toHaveBeenCalledOnce();
    expect(input.reconcileOwnership).toHaveBeenCalledTimes(2);
    expect(input.store.reconcileBuiltIns).toHaveBeenCalledTimes(2);
    expect(input.onReady).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: "agent-a",
      seed: "seed-after",
    }));
    expect(input.scheduler!.activate).toHaveBeenCalledTimes(2);
    expect(input.emitReset).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      operationId: "operation-a",
      target: "all",
      reactivated: true,
    }));
    expect(auditEvent).toHaveBeenCalledWith({
      timestamp: 1_000,
      agentId: "agent-a",
      tenantId: "tenant-a",
      actionType: "cron.reset",
      kind: "audit",
      classification: "destructive",
      outcome: "success",
      metadata: {
        actorScope: "admin",
        decision: "accepted",
        target: "all",
        expectedDigests: { store: DIGEST_A, ledger: DIGEST_B },
        operationId: "operation-a",
        beforeDigests: { store: DIGEST_A, ledger: DIGEST_B },
        afterDigests: { store: DIGEST_C, ledger: DIGEST_D },
      },
    });
  });

  it("keeps the subsystem in maintenance when strict post-reset reload fails", async () => {
    const input = deps();
    const controller = createCronMaintenanceController(input);
    expect((await controller.initialize()).ok).toBe(true);
    vi.mocked(input.scheduler!.reload).mockResolvedValueOnce(err({
      code: "initialization_failed",
      errorKind: "internal",
      message: "disk read failed",
    }));

    expect(await controller.reset({
      target: "all",
      expectedDigests: { store: DIGEST_A, ledger: DIGEST_B },
      confirmed: true,
      actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "post_reset_initialization_failed" } });
    expect(input.onReady).toHaveBeenCalledTimes(1);
    expect(input.onQuiesced).toHaveBeenCalledWith("agent-a");
    expect((await controller.status()).ok && (await controller.status()).value.state).toBe("maintenance");
  });

  it("does not republish reloaded state when runtime dependencies became unavailable", async () => {
    const input = deps();
    const controller = createCronMaintenanceController(input);
    expect((await controller.initialize()).ok).toBe(true);
    expect(controller.activate()).toEqual(ok(undefined));
    vi.mocked(input.dependenciesReady).mockReturnValue(false);

    expect(await controller.reset({
      target: "all",
      expectedDigests: { store: DIGEST_A, ledger: DIGEST_B },
      confirmed: true,
      actorScope: "admin",
    })).toMatchObject({ ok: false, error: { code: "dependency_not_ready" } });
    expect(input.onReady).toHaveBeenCalledTimes(1);
    expect(input.onQuiesced).toHaveBeenCalledWith("agent-a");
  });
});
