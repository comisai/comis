// SPDX-License-Identifier: Apache-2.0
import type { ErrorKind, TypedEventBus } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import type { SchedulerLogger } from "../shared-types.js";
import {
  emitDurableCronStarted,
  emitDurableCronTerminal,
} from "../execution/cron-execution-events.js";
import {
  classifyCronDependencyOutcome,
  type CronExecutionStartedRow,
  type CronExecutionTerminalRow,
  type ExecutionTracker,
  type ExecutionTrackerError,
} from "../execution/index.js";
import type {
  CronActiveClaim,
  CronStore,
  CronStoreError,
} from "./cron-store.js";

export type CronOwnershipReconciliationErrorCode =
  | "invalid_input"
  | "store_read"
  | "ledger_read"
  | "identity_mismatch"
  | "orphan_start"
  | "ledger_write"
  | "store_write";

export type CronOwnershipReconciliationError = {
  code: CronOwnershipReconciliationErrorCode;
  errorKind: ErrorKind;
  message: string;
  executionId?: string;
};

export type CronOwnershipReconciliationResult = {
  recoveredBeforeStart: number;
  ownerLostAfterStart: number;
  settledFromTerminal: number;
  retainedCurrentBoot: number;
};

export async function reconcileCronOwnership(input: {
  store: CronStore;
  tracker: ExecutionTracker;
  eventBus: TypedEventBus;
  logger: SchedulerLogger;
  currentBootId: string;
  nowMs: number;
}): Promise<Result<CronOwnershipReconciliationResult, CronOwnershipReconciliationError>> {
  if (!validIdentifier(input.currentBootId) || !validEpochMs(input.nowMs)) {
    return err(reconciliationError("invalid_input", "validation", "Invalid cron ownership reconciliation input"));
  }
  const snapshot = input.store.getSnapshot();
  if (!snapshot.ok) return err(storeFailure("store_read", snapshot.error));
  const history = await input.tracker.listOwnershipGroups();
  if (!history.ok) return err(ledgerFailure("ledger_read", history.error));

  const claims = snapshot.value.activeClaims;
  const claimIds = new Set(claims.map((claim) => claim.executionId));
  const groups = new Map(history.value.map((group) => [group.start.executionId, group]));

  for (const group of history.value) {
    if (group.terminal === undefined && !claimIds.has(group.start.executionId)) {
      return err(reconciliationError(
        "orphan_start",
        "validation",
        "Cron execution ledger has an unmatched start without its ownership claim",
        group.start.executionId,
      ));
    }
  }
  for (const claim of claims) {
    const group = groups.get(claim.executionId);
    if (group !== undefined && !sameClaimAndStart(claim, group.start)) {
      return err(reconciliationError(
        "identity_mismatch",
        "validation",
        "Cron execution claim and ledger start identities differ",
        claim.executionId,
      ));
    }
    if (claim.bootId === input.currentBootId) continue;
    const provenAtMs = group?.terminal === undefined
      ? group?.start.startedAtMs ?? claim.claimedAtMs
      : undefined;
    if (provenAtMs !== undefined && input.nowMs < provenAtMs) {
      return err(reconciliationError(
        "invalid_input",
        "validation",
        "Cron ownership reconciliation time precedes its durable execution fact",
        claim.executionId,
      ));
    }
  }

  const protectedIds = new Set(claimIds);
  const result: CronOwnershipReconciliationResult = {
    recoveredBeforeStart: 0,
    ownerLostAfterStart: 0,
    settledFromTerminal: 0,
    retainedCurrentBoot: 0,
  };

  for (const claim of claims) {
    if (claim.bootId === input.currentBootId) {
      result.retainedCurrentBoot += 1;
      continue;
    }
    const group = groups.get(claim.executionId);
    if (group === undefined) {
      const start = startFromClaim(claim);
      const terminal = recoveryTerminal(start, input.nowMs);
      const appended = await input.tracker.appendRecoveredExecution(start, terminal, [...protectedIds]);
      if (!appended.ok) return err(ledgerFailure("ledger_write", appended.error, claim.executionId));
      emitDurableCronStarted({ eventBus: input.eventBus, logger: input.logger, start });
      emitDurableCronTerminal({ eventBus: input.eventBus, logger: input.logger, terminal });
      const settled = await settle(input.store, terminal);
      if (!settled.ok) return settled;
      protectedIds.delete(claim.executionId);
      result.recoveredBeforeStart += 1;
      continue;
    }
    if (group.terminal === undefined) {
      const terminal = ownerLostTerminal(group.start, input.nowMs);
      const appended = await input.tracker.appendTerminal(terminal, [...protectedIds]);
      if (!appended.ok) return err(ledgerFailure("ledger_write", appended.error, claim.executionId));
      emitDurableCronTerminal({ eventBus: input.eventBus, logger: input.logger, terminal });
      const settled = await settle(input.store, terminal);
      if (!settled.ok) return settled;
      protectedIds.delete(claim.executionId);
      result.ownerLostAfterStart += 1;
      continue;
    }
    const settled = await settle(input.store, group.terminal);
    if (!settled.ok) return settled;
    protectedIds.delete(claim.executionId);
    result.settledFromTerminal += 1;
  }

  return ok(result);
}

async function settle(
  store: CronStore,
  terminal: CronExecutionTerminalRow,
): Promise<Result<void, CronOwnershipReconciliationError>> {
  const settled = await store.settleClaim({
    executionId: terminal.executionId,
    terminalAtMs: terminal.terminalAtMs,
    dependencyOutcome: classifyCronDependencyOutcome(terminal.outcome),
  });
  return settled.ok
    ? ok(undefined)
    : err(storeFailure("store_write", settled.error, terminal.executionId));
}

function startFromClaim(claim: CronActiveClaim): CronExecutionStartedRow {
  return {
    executionId: claim.executionId,
    bootId: claim.bootId,
    jobId: claim.jobId,
    agentId: claim.agentId,
    scheduledForMs: claim.scheduledForMs,
    trigger: claim.trigger,
    recordType: "started",
    workKind: claim.workKind,
    rootRunId: claim.rootRunId,
    startedAtMs: claim.claimedAtMs,
  };
}

function recoveryTerminal(
  start: CronExecutionStartedRow,
  terminalAtMs: number,
): CronExecutionTerminalRow {
  return terminalFromStart(start, terminalAtMs, {
    kind: "pre_dispatch_failure",
    stage: "start_record_recovery",
    errorKind: "internal",
  });
}

function ownerLostTerminal(
  start: CronExecutionStartedRow,
  terminalAtMs: number,
): CronExecutionTerminalRow {
  return terminalFromStart(start, terminalAtMs, {
    kind: "unsettled",
    reason: "owner_lost_after_start",
    rootRunId: start.rootRunId,
    errorKind: "internal",
  });
}

function terminalFromStart(
  start: CronExecutionStartedRow,
  terminalAtMs: number,
  outcome: CronExecutionTerminalRow["outcome"],
): CronExecutionTerminalRow {
  return {
    executionId: start.executionId,
    bootId: start.bootId,
    jobId: start.jobId,
    agentId: start.agentId,
    scheduledForMs: start.scheduledForMs,
    trigger: start.trigger,
    recordType: "terminal",
    workKind: start.workKind,
    terminalAtMs,
    durationMs: terminalAtMs - start.startedAtMs,
    outcome,
  };
}

function sameClaimAndStart(claim: CronActiveClaim, start: CronExecutionStartedRow): boolean {
  return claim.executionId === start.executionId
    && claim.bootId === start.bootId
    && claim.jobId === start.jobId
    && claim.agentId === start.agentId
    && claim.rootRunId === start.rootRunId
    && claim.scheduledForMs === start.scheduledForMs
    && claim.trigger === start.trigger
    && claim.workKind === start.workKind;
}

function storeFailure(
  code: Extract<CronOwnershipReconciliationErrorCode, "store_read" | "store_write">,
  cause: CronStoreError,
  executionId?: string,
): CronOwnershipReconciliationError {
  return reconciliationError(code, cause.errorKind, cause.message, executionId);
}

function ledgerFailure(
  code: Extract<CronOwnershipReconciliationErrorCode, "ledger_read" | "ledger_write">,
  cause: ExecutionTrackerError,
  executionId?: string,
): CronOwnershipReconciliationError {
  return reconciliationError(code, cause.errorKind, cause.message, executionId);
}

function reconciliationError(
  code: CronOwnershipReconciliationErrorCode,
  errorKind: ErrorKind,
  message: string,
  executionId?: string,
): CronOwnershipReconciliationError {
  return { code, errorKind, message, ...(executionId === undefined ? {} : { executionId }) };
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 256 && Buffer.byteLength(value, "utf8") <= 256;
}

function validEpochMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
