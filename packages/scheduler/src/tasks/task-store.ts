// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  type ClockPort,
  type ConversationRef,
  type ErrorKind,
  type FileLockPort,
  safePath,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { replaceDurableFile } from "../persistence/durable-file.js";
import type { BoundTaskCandidate } from "./task-extractor.js";
import { admitTaskCandidate } from "./task-admission.js";
import {
  parseFollowupTaskStoreFile,
  FollowupTaskStoreEnvelopeSchema,
  SuccessfulTaskCheckExecutionEvidenceSchema,
  type FollowupTaskAttemptRecord,
  type FollowupTaskRecord,
  type FollowupTaskStoreFile,
  type FollowupTaskStoreError,
  type FollowupTaskStoreErrorCode,
  type SuccessfulTaskCheckExecutionEvidence,
  type TaskAdmissionResult,
  type TaskAttemptFailureStage,
  type TaskBeginDeliveryResult,
  type TaskCheckExecutionEvidence,
  type TaskDeliverySettlement,
} from "./task-types.js";
import { inspectTaskQuarantine, quarantineMalformedTerminalTaskGroups, type TaskQuarantineInspection } from "./task-quarantine.js";
import { planDueTaskClaim, type TaskClaimResult } from "./task-selector.js";
import {
  buildDeliveryTerminal,
  buildDismissedTerminal,
  buildRetryableFailure,
  createTaskStoreMutex,
  isTaskStoreNodeError,
  resolveClaimedTasks,
  snapshotTaskStoreRoot,
  terminalizeClosedWindow,
  terminalizeConfigurationDisabled,
  validTaskStoreId,
  validTaskStoreTime,
} from "./task-store-transitions.js";

export const MAX_FOLLOWUP_TASK_STORE_BYTES = 16 * 1_024 * 1_024;
export const MAX_ACTIVE_FOLLOWUP_TASKS = 256;
export const FOLLOWUP_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const ACTIVE_ATTEMPT_RESERVATION_BYTES = 128 * 1_024;
const LOCK_OPTIONS = { staleMs: 30_000, updateMs: 5_000 } as const;

export interface FollowupTaskStoreOptions {
  readonly filePath: string;
  readonly lockPath: string;
  readonly fileLock: FileLockPort;
  readonly clock: ClockPort;
  readonly idFactory: () => string;
  readonly getRuntimeConfig: (agentId: string) => {
    readonly enabled: boolean;
    readonly preAcceptanceRetryLimit: number;
    readonly quietUntilMs: number | null;
  };
}

export type TaskFailureInput =
  | {
    readonly attemptId: string;
    readonly failureStage: Exclude<TaskAttemptFailureStage, "delivery_rejected">;
    readonly errorKind: ErrorKind;
    readonly check: TaskCheckExecutionEvidence;
  }
  | {
    readonly attemptId: string;
    readonly failureStage: "delivery_rejected";
    readonly errorKind: ErrorKind;
    readonly failedChunks: number;
  };

export interface FollowupTaskOperatorRecord {
  readonly id: string;
  readonly agentId: string;
  readonly status: FollowupTaskRecord["status"];
  readonly dueEarliestMs: number;
  readonly dueLatestMs: number;
  readonly expiresAtMs: number;
  readonly attemptCount: number;
  readonly preAcceptanceFailureCount: number;
  readonly sourceExecutionId: string;
  readonly sourceOccurrenceCount: number;
  readonly conversationRef: ConversationRef;
}

export interface FollowupTaskStoreInspection {
  readonly fileDigest: string;
  readonly tasks: readonly FollowupTaskOperatorRecord[];
  readonly quarantine: TaskQuarantineInspection;
}

export type FollowupTaskCancellationOutcome =
  | { readonly status: "cancelled"; readonly taskIds: readonly string[]; readonly activeTaskIds: readonly string[] }
  | { readonly status: "active_attempt"; readonly taskId: string; readonly attemptId: string }
  | { readonly status: "already_terminal"; readonly taskId: string; readonly taskStatus: FollowupTaskRecord["status"] }
  | { readonly status: "not_found"; readonly taskId: string }
  | { readonly status: "nothing_pending"; readonly activeTaskIds: readonly string[] };

export interface TaskOwnershipRecoveredAttempt {
  readonly agentId: string;
  readonly attemptId: string;
  readonly rootRunId: string;
  readonly taskIds: readonly string[];
  readonly sourceExecutionIds: readonly string[];
  readonly originTraceIds: readonly string[];
  readonly outcome: "retry_scheduled" | "expired" | "delivery_unknown";
  readonly errorKind: "internal";
  readonly startedAtMs: number;
  readonly terminalAtMs: number;
}

export interface TaskOwnershipRecoveryResult {
  readonly recoveredChecking: number;
  readonly recoveredDelivering: number;
  readonly recoveredAttempts: readonly TaskOwnershipRecoveredAttempt[];
}

export interface FollowupTaskStore {
  initialize(): Promise<Result<FollowupTaskStoreFile, FollowupTaskStoreError>>;
  read(): Promise<Result<FollowupTaskStoreFile, FollowupTaskStoreError>>;
  inspect(): Promise<Result<FollowupTaskStoreInspection, FollowupTaskStoreError>>;
  cancelPending(input: {
    readonly agentId: string;
    readonly taskId?: string;
  }): Promise<Result<FollowupTaskCancellationOutcome, FollowupTaskStoreError>>;
  admitCandidates(input: {
    readonly candidates: readonly BoundTaskCandidate[];
    readonly confidenceThreshold: number;
  }): Promise<Result<readonly TaskAdmissionResult[], FollowupTaskStoreError>>;
  claimDue(input: {
    readonly agentId: string;
    readonly bootId: string;
    readonly rootRunId: string;
    readonly attemptId: string;
    readonly maxPerCheck: number;
    readonly maxPerDayPerConversation: number;
  }): Promise<Result<TaskClaimResult | { readonly status: "disabled" }, FollowupTaskStoreError>>;
  beginDelivery(input: {
    readonly attemptId: string;
    readonly check: SuccessfulTaskCheckExecutionEvidence;
  }): Promise<Result<TaskBeginDeliveryResult, FollowupTaskStoreError>>;
  settleDelivery(input: {
    readonly attemptId: string;
    readonly outcome: TaskDeliverySettlement;
  }): Promise<Result<"settled" | "already_settled", FollowupTaskStoreError>>;
  dismissAttempt(input: {
    readonly attemptId: string;
    readonly check: SuccessfulTaskCheckExecutionEvidence;
  }): Promise<Result<"settled" | "already_settled", FollowupTaskStoreError>>;
  failAttempt(input: TaskFailureInput): Promise<Result<"retry_scheduled" | "expired" | "already_settled", FollowupTaskStoreError>>;
  reconcileOwnership(input: {
    readonly currentBootId: string;
    readonly exclusiveDataDirLockOwned: boolean;
  }): Promise<Result<TaskOwnershipRecoveryResult, FollowupTaskStoreError>>;
}

export function createFollowupTaskStore(options: FollowupTaskStoreOptions): FollowupTaskStore {
  const mutex = createTaskStoreMutex();
  const pathError = validatePaths(options);
  const quarantinePath = pathError === undefined
    ? safePath(path.dirname(options.filePath), "tasks-quarantine.jsonl")
    : "";
  let initialized = false;

  async function initialize(): Promise<Result<FollowupTaskStoreFile, FollowupTaskStoreError>> {
    return mutex.serialize(async () => withStoreLock(async () => {
      if (pathError !== undefined) return err(pathError);
      const nowMs = options.clock.now();
      if (!validTaskStoreTime(nowMs)) return err(storeError("invalid_state", "internal", "Clock returned an invalid task-store time"));
      const read = await readRoot(true, nowMs);
      if (!read.ok) return read;
      const maintained = maintainRoot(read.value, nowMs);
      if (maintained !== read.value) {
        const written = await writeRoot(maintained);
        if (!written.ok) return written;
      }
      initialized = true;
      return ok(snapshotTaskStoreRoot(maintained));
    }));
  }

  async function read(): Promise<Result<FollowupTaskStoreFile, FollowupTaskStoreError>> {
    return mutex.serialize(async () => withStoreLock(async () => {
      if (pathError !== undefined) return err(pathError);
      if (!initialized) return err(storeError("not_initialized", "precondition", "Task store is not initialized"));
      const current = await readRoot(false);
      if (!current.ok) return current;
      const nowMs = options.clock.now();
      if (!validTaskStoreTime(nowMs)) return err(storeError("invalid_state", "internal", "Clock returned an invalid task-store time"));
      const maintained = maintainRoot(current.value, nowMs);
      if (maintained !== current.value) {
        const written = await writeRoot(maintained);
        if (!written.ok) return written;
      }
      return ok(snapshotTaskStoreRoot(maintained));
    }));
  }

  async function inspect(): Promise<Result<FollowupTaskStoreInspection, FollowupTaskStoreError>> {
    return mutex.serialize(async () => withStoreLock(async () => {
      if (pathError !== undefined) return err(pathError);
      if (!initialized) return err(storeError("not_initialized", "precondition", "Task store is not initialized"));
      const current = await readRoot(false);
      if (!current.ok) return current;
      const nowMs = options.clock.now();
      if (!validTaskStoreTime(nowMs)) return err(storeError("invalid_state", "internal", "Clock returned an invalid task-store time"));
      const maintained = maintainRoot(current.value, nowMs);
      if (maintained !== current.value) {
        const written = await writeRoot(maintained);
        if (!written.ok) return written;
      }
      const raw = await fromPromise(fs.readFile(options.filePath));
      if (!raw.ok) return err(storeError("io", "internal", "Unable to inspect follow-up task store"));
      const quarantine = await inspectTaskQuarantine(quarantinePath);
      if (!quarantine.ok) return quarantine;
      return ok({
        fileDigest: createHash("sha256").update(raw.value).digest("hex"),
        tasks: maintained.tasks.map(projectOperatorTask),
        quarantine: quarantine.value,
      });
    }));
  }

  async function cancelPending(input: {
    readonly agentId: string;
    readonly taskId?: string;
  }): Promise<Result<FollowupTaskCancellationOutcome, FollowupTaskStoreError>> {
    if (!validTaskStoreId(input.agentId) || (input.taskId !== undefined && !validTaskStoreId(input.taskId))) {
      return err(storeError("invalid_state", "validation", "Task cancellation input is invalid"));
    }
    return mutate<FollowupTaskCancellationOutcome>((root, nowMs) => {
      const matching = root.tasks.filter((task) => task.agentId === input.agentId);
      if (input.taskId !== undefined) {
        const task = matching.find((candidate) => candidate.id === input.taskId);
        if (task === undefined) return ok({ root, value: { status: "not_found" as const, taskId: input.taskId } });
        if (task.status === "checking" || task.status === "delivering") {
          return ok({
            root,
            value: { status: "active_attempt" as const, taskId: task.id, attemptId: task.activeAttemptId },
          });
        }
        if (task.status !== "pending") {
          return ok({
            root,
            value: { status: "already_terminal" as const, taskId: task.id, taskStatus: task.status },
          });
        }
        return ok({
          root: { ...root, tasks: root.tasks.map((candidate) => candidate.id === task.id ? cancelTask(candidate, nowMs) : candidate) },
          value: { status: "cancelled" as const, taskIds: [task.id], activeTaskIds: [] },
        });
      }
      const pendingIds = matching.filter((task) => task.status === "pending").map((task) => task.id);
      const activeTaskIds = matching.filter((task) => task.status === "checking" || task.status === "delivering")
        .map((task) => task.id);
      if (pendingIds.length === 0) {
        return ok({ root, value: { status: "nothing_pending" as const, activeTaskIds } });
      }
      const pending = new Set(pendingIds);
      return ok({
        root: {
          ...root,
          tasks: root.tasks.map((task) => pending.has(task.id) ? cancelTask(task, nowMs) : task),
        },
        value: { status: "cancelled" as const, taskIds: pendingIds, activeTaskIds },
      });
    });
  }

  async function admitCandidates(input: {
    readonly candidates: readonly BoundTaskCandidate[];
    readonly confidenceThreshold: number;
  }): Promise<Result<readonly TaskAdmissionResult[], FollowupTaskStoreError>> {
    if (
      !Number.isFinite(input.confidenceThreshold)
      || input.confidenceThreshold < 0
      || input.confidenceThreshold > 1
      || input.candidates.length > 64
    ) {
      return err(storeError("invalid_state", "validation", "Task admission input is invalid"));
    }
    return mutex.serialize(async () => withStoreLock(async () => {
      if (pathError !== undefined) return err(pathError);
      if (!initialized) return err(storeError("not_initialized", "precondition", "Task store is not initialized"));
      const current = await readRoot(false);
      if (!current.ok) return current;
      const nowMs = options.clock.now();
      if (!validTaskStoreTime(nowMs)) return err(storeError("invalid_state", "internal", "Clock returned an invalid task-store time"));
      let root = maintainRoot(current.value, nowMs);
      const results: TaskAdmissionResult[] = [];
      const agents = new Set(input.candidates.map((candidate) => candidate.item.origin.turnScope.conversation.agentId));
      if (agents.size > 1) return err(storeError("invalid_state", "validation", "Task admission batch spans multiple agents"));
      const agentId = agents.values().next().value as string | undefined;
      if (agentId !== undefined) {
        const config = resolveRuntimeConfig(options, agentId);
        if (!config.ok) return config;
        if (!config.value.enabled) {
          return err(storeError("disabled", "precondition", "Task inference was disabled before candidate persistence"));
        }
      }
      for (const candidate of input.candidates) {
        const admitted = admitTaskCandidate({
          root,
          candidate,
          confidenceThreshold: input.confidenceThreshold,
          nowMs,
          idFactory: options.idFactory,
          maxActiveTasks: MAX_ACTIVE_FOLLOWUP_TASKS,
          hasCapacity: encodedWithinCapacity,
        });
        if (!admitted.ok) return admitted;
        root = admitted.value.root;
        results.push(admitted.value.result);
      }
      if (root !== current.value) {
        const written = await writeRoot(root);
        if (!written.ok) return written;
      }
      return ok(results);
    }));
  }

  async function claimDue(input: {
    readonly agentId: string;
    readonly bootId: string;
    readonly rootRunId: string;
    readonly attemptId: string;
    readonly maxPerCheck: number;
    readonly maxPerDayPerConversation: number;
  }): Promise<Result<TaskClaimResult | { readonly status: "disabled" }, FollowupTaskStoreError>> {
    if (
      !validTaskStoreId(input.agentId)
      || !validTaskStoreId(input.bootId)
      || !validTaskStoreId(input.rootRunId)
      || !validTaskStoreId(input.attemptId)
      || !Number.isSafeInteger(input.maxPerCheck)
      || input.maxPerCheck < 1
      || input.maxPerCheck > 8
      || !Number.isSafeInteger(input.maxPerDayPerConversation)
      || input.maxPerDayPerConversation < 1
      || input.maxPerDayPerConversation > 24
    ) return err(storeError("invalid_state", "validation", "Task claim input is invalid"));
    return mutate<TaskClaimResult | { readonly status: "disabled" }>((root, nowMs) => {
      const config = resolveRuntimeConfig(options, input.agentId);
      if (!config.ok) return config;
      if (!config.value.enabled) return ok({ root, value: { status: "disabled" as const } });
      if (root.attempts.some((attempt) => attempt.id === input.attemptId)) {
        return err(storeError("invalid_state", "precondition", "Task attempt id already exists"));
      }
      const planned = planDueTaskClaim({
        ...input,
        root,
        nowMs,
        quietUntilMs: config.value.quietUntilMs,
      });
      if (!encodedWithinCapacity(planned.root)) {
        return err(storeError("store_full", "resource", "Follow-up task store cannot reserve terminal attempt capacity"));
      }
      return ok({ root: planned.root, value: planned.result });
    });
  }

  async function beginDelivery(input: {
    readonly attemptId: string;
    readonly check: SuccessfulTaskCheckExecutionEvidence;
  }): Promise<Result<TaskBeginDeliveryResult, FollowupTaskStoreError>> {
    const check = SuccessfulTaskCheckExecutionEvidenceSchema.safeParse(input.check);
    if (!validTaskStoreId(input.attemptId) || !check.success) {
      return err(storeError("invalid_state", "validation", "Task send-boundary input is invalid"));
    }
    return mutate((root, nowMs) => {
      const attempt = root.attempts.find((candidate) => candidate.id === input.attemptId);
      if (attempt === undefined || attempt.status !== "checking") {
        return err(storeError("invalid_state", "precondition", "Task attempt is not checking"));
      }
      const config = resolveRuntimeConfig(options, attempt.agentId);
      if (!config.ok) return config;
      if (!config.value.enabled) {
        return ok(terminalizeConfigurationDisabled(root, attempt, check.data, nowMs));
      }
      const claimed = resolveClaimedTasks(root, attempt);
      if (!claimed.ok) return claimed;
      if (claimed.value.some((task) => nowMs > task.dueLatestMs || nowMs > task.expiresAtMs)) {
        return ok(terminalizeClosedWindow(root, attempt, check.data, claimed.value, nowMs));
      }
      const deliveringAttempt: FollowupTaskAttemptRecord = {
        ...attempt,
        status: "delivering",
        check: check.data,
        deliveringAtMs: nowMs,
      };
      const ids = new Set(attempt.taskIds);
      const tasks = root.tasks.map((task): FollowupTaskRecord => (
        ids.has(task.id) && task.status === "checking"
          ? { ...task, status: "delivering" }
          : task
      ));
      const attempts = root.attempts.map((candidate) => candidate.id === attempt.id ? deliveringAttempt : candidate);
      return ok({
        root: { ...root, tasks, attempts },
        value: { status: "delivering" as const, deliveringAtMs: nowMs },
      });
    });
  }

  async function settleDelivery(input: {
    readonly attemptId: string;
    readonly outcome: TaskDeliverySettlement;
  }): Promise<Result<"settled" | "already_settled", FollowupTaskStoreError>> {
    if (!validTaskStoreId(input.attemptId)) {
      return err(storeError("invalid_state", "validation", "Task delivery settlement id is invalid"));
    }
    return mutate((root, nowMs) => {
      const attempt = root.attempts.find((candidate) => candidate.id === input.attemptId);
      if (attempt === undefined) return err(storeError("invalid_state", "validation", "Task attempt was not found"));
      if (attempt.status !== "delivering") return "terminalAtMs" in attempt
        ? ok({ root, value: "already_settled" as const })
        : err(storeError("invalid_state", "precondition", "Task attempt has not crossed the send boundary"));
      const settled = buildDeliveryTerminal(root, attempt, input.outcome, nowMs);
      if (!settled.ok) return settled;
      return ok({ root: settled.value, value: "settled" as const });
    });
  }

  async function dismissAttempt(input: {
    readonly attemptId: string;
    readonly check: SuccessfulTaskCheckExecutionEvidence;
  }): Promise<Result<"settled" | "already_settled", FollowupTaskStoreError>> {
    const check = SuccessfulTaskCheckExecutionEvidenceSchema.safeParse(input.check);
    if (!validTaskStoreId(input.attemptId) || !check.success) {
      return err(storeError("invalid_state", "validation", "Task dismissal evidence is invalid"));
    }
    return mutate((root, nowMs) => {
      const attempt = root.attempts.find((candidate) => candidate.id === input.attemptId);
      if (attempt === undefined) return err(storeError("invalid_state", "validation", "Task attempt was not found"));
      if (attempt.status !== "checking") return "terminalAtMs" in attempt
        ? ok({ root, value: "already_settled" as const })
        : err(storeError("invalid_state", "precondition", "Task attempt is not dismissible"));
      const terminal = buildDismissedTerminal(root, attempt, check.data, nowMs);
      return terminal.ok
        ? ok({ root: terminal.value, value: "settled" as const })
        : terminal;
    });
  }

  async function failAttempt(
    input: TaskFailureInput,
  ): Promise<Result<"retry_scheduled" | "expired" | "already_settled", FollowupTaskStoreError>> {
    if (!validTaskStoreId(input.attemptId)) {
      return err(storeError("invalid_state", "validation", "Task failure attempt id is invalid"));
    }
    return mutate((root, nowMs) => {
      const attempt = root.attempts.find((candidate) => candidate.id === input.attemptId);
      if (attempt === undefined) return err(storeError("invalid_state", "validation", "Task attempt was not found"));
      if (attempt.status !== "checking" && attempt.status !== "delivering") {
        return ok({ root, value: "already_settled" as const });
      }
      let check: TaskCheckExecutionEvidence;
      let failedChunks: number;
      if (input.failureStage === "delivery_rejected") {
        if (attempt.status !== "delivering") {
          return err(storeError("invalid_state", "precondition", "Delivery rejection requires the durable send boundary"));
        }
        check = attempt.check;
        failedChunks = input.failedChunks;
      } else {
        if (attempt.status !== "checking") {
          return err(storeError("invalid_state", "precondition", "Pre-send failure requires a checking attempt"));
        }
        check = input.check;
        failedChunks = 0;
      }
      const config = resolveRuntimeConfig(options, attempt.agentId);
      if (!config.ok) return config;
      const failed = buildRetryableFailure({
        root,
        attempt,
        check,
        failureStage: input.failureStage,
        errorKind: input.errorKind,
        failedChunks,
        nowMs,
        retryLimit: config.value.preAcceptanceRetryLimit,
      });
      return failed.ok
        ? ok({ root: failed.value.root, value: failed.value.disposition })
        : failed;
    });
  }

  async function reconcileOwnership(input: {
    readonly currentBootId: string;
    readonly exclusiveDataDirLockOwned: boolean;
  }): Promise<Result<TaskOwnershipRecoveryResult, FollowupTaskStoreError>> {
    if (!validTaskStoreId(input.currentBootId)) {
      return err(storeError("invalid_state", "validation", "Task recovery boot id is invalid"));
    }
    if (!input.exclusiveDataDirLockOwned) {
      return err(storeError("ownership_unproven", "precondition", "Task recovery requires exclusive data-directory ownership"));
    }
    return mutate((initialRoot, nowMs) => {
      let root = initialRoot;
      let recoveredChecking = 0;
      let recoveredDelivering = 0;
      const recoveredAttempts: TaskOwnershipRecoveredAttempt[] = [];
      const active = initialRoot.attempts.filter((attempt): attempt is Extract<FollowupTaskAttemptRecord, { status: "checking" | "delivering" }> => (
        attempt.bootId !== input.currentBootId
        && (attempt.status === "checking" || attempt.status === "delivering")
      ));
      for (const stale of active) {
        const evidence = recoveryEvidence(initialRoot, stale);
        if (stale.status === "checking") {
          const config = resolveRuntimeConfig(options, stale.agentId);
          if (!config.ok) return config;
          const failed = buildRetryableFailure({
            root,
            attempt: stale,
            check: { status: "not_returned" },
            failureStage: "owner_recovery_before_delivery",
            errorKind: "internal",
            failedChunks: 0,
            nowMs,
            retryLimit: config.value.preAcceptanceRetryLimit,
          });
          if (!failed.ok) return failed;
          root = failed.value.root;
          recoveredChecking += 1;
          recoveredAttempts.push({
            ...evidence,
            outcome: failed.value.disposition,
            errorKind: "internal",
            terminalAtMs: nowMs,
          });
          continue;
        }
        const unknown = buildDeliveryTerminal(root, stale, {
          status: "unknown",
          delivery: {
            source: "owner_recovery",
            errorKind: "internal",
            deliveredChunks: null,
            failedChunks: null,
            ambiguousChunks: null,
            lastPlatformMessageId: null,
          },
        }, nowMs);
        if (!unknown.ok) return unknown;
        root = unknown.value;
        recoveredDelivering += 1;
        recoveredAttempts.push({
          ...evidence,
          outcome: "delivery_unknown",
          errorKind: "internal",
          terminalAtMs: nowMs,
        });
      }
      return ok({ root, value: { recoveredChecking, recoveredDelivering, recoveredAttempts } });
    });
  }

  async function mutate<T>(
    change: (
      root: FollowupTaskStoreFile,
      nowMs: number,
    ) => Result<{ root: FollowupTaskStoreFile; value: T }, FollowupTaskStoreError>,
  ): Promise<Result<T, FollowupTaskStoreError>> {
    return mutex.serialize(async () => withStoreLock(async () => {
      if (pathError !== undefined) return err(pathError);
      if (!initialized) return err(storeError("not_initialized", "precondition", "Task store is not initialized"));
      const current = await readRoot(false);
      if (!current.ok) return current;
      const nowMs = options.clock.now();
      if (!validTaskStoreTime(nowMs)) return err(storeError("invalid_state", "internal", "Clock returned an invalid task-store time"));
      const maintained = maintainRoot(current.value, nowMs);
      const changed = change(maintained, nowMs);
      if (!changed.ok) return changed;
      if (!encodedWithinCapacity(changed.value.root)) {
        return err(storeError("store_full", "resource", "Follow-up task store capacity reached"));
      }
      if (changed.value.root !== current.value) {
        const written = await writeRoot(changed.value.root);
        if (!written.ok) return written;
      }
      return ok(changed.value.value);
    }));
  }

  async function withStoreLock<T>(
    operation: () => Promise<Result<T, FollowupTaskStoreError>>,
  ): Promise<Result<T, FollowupTaskStoreError>> {
    if (pathError !== undefined) return err(pathError);
    const locked = await options.fileLock.withLock(options.lockPath, operation, LOCK_OPTIONS);
    if (!locked.ok) return err(lockError(locked.error.kind, locked.error.message));
    return locked.value;
  }

  async function readRoot(createMissing: boolean, quarantineAtMs?: number): Promise<Result<FollowupTaskStoreFile, FollowupTaskStoreError>> {
    const read = await fromPromise(fs.readFile(options.filePath));
    if (!read.ok) {
      if (createMissing && isTaskStoreNodeError(read.error, "ENOENT")) {
        const empty: FollowupTaskStoreFile = { formatVersion: 1, tasks: [], attempts: [], policySnapshots: [] };
        const written = await writeRoot(empty);
        return written.ok ? ok(empty) : written;
      }
      return err(storeError("io", "internal", "Unable to read follow-up task store"));
    }
    if (read.value.byteLength > MAX_FOLLOWUP_TASK_STORE_BYTES) {
      return err(storeError("invalid_state", "validation", "Follow-up task store exceeds its byte ceiling"));
    }
    const decoded = tryCatch(() => JSON.parse(read.value.toString("utf8")) as unknown);
    if (!decoded.ok) return err(storeError("invalid_state", "validation", "Follow-up task store contains invalid JSON"));
    const parsed = parseFollowupTaskStoreFile(decoded.value);
    if (parsed.ok) return ok(parsed.value);
    if (quarantineAtMs === undefined) {
      return err(storeError("invalid_state", "validation", "Follow-up task store authority is invalid"));
    }
    const envelope = FollowupTaskStoreEnvelopeSchema.safeParse(decoded.value);
    if (!envelope.success) return err(storeError("invalid_state", "validation", "Follow-up task store authority is invalid"));
    const quarantined = await quarantineMalformedTerminalTaskGroups({
      raw: envelope.data,
      quarantinePath,
      quarantinedAtMs: quarantineAtMs,
    });
    if (!quarantined.ok) return quarantined;
    const written = await writeRoot(quarantined.value.root);
    return written.ok ? ok(quarantined.value.root) : written;
  }

  async function writeRoot(root: FollowupTaskStoreFile): Promise<Result<void, FollowupTaskStoreError>> {
    const encoded = encodeFollowupTaskStore(root);
    if (!encoded.ok) return encoded;
    if (encoded.value.byteLength > MAX_FOLLOWUP_TASK_STORE_BYTES) {
      return err(storeError("store_full", "resource", "Follow-up task store capacity reached"));
    }
    const replaced = await replaceDurableFile({
      filePath: options.filePath,
      bytes: encoded.value,
      temporaryToken: options.idFactory,
    });
    if (replaced.ok) return replaced;
    return replaced.error.code === "invalid_input"
      ? err(storeError("invalid_state", replaced.error.errorKind, "Opaque id factory returned an invalid temporary-file token"))
      : err(storeError("io", replaced.error.errorKind, "Unable to durably replace follow-up task store"));
  }

  return {
    initialize,
    read,
    inspect,
    cancelPending,
    admitCandidates,
    claimDue,
    beginDelivery,
    settleDelivery,
    dismissAttempt,
    failAttempt,
    reconcileOwnership,
  };
}

function recoveryEvidence(
  root: FollowupTaskStoreFile,
  attempt: Extract<FollowupTaskAttemptRecord, { status: "checking" | "delivering" }>,
): Omit<TaskOwnershipRecoveredAttempt, "outcome" | "errorKind" | "terminalAtMs"> {
  const taskIds = new Set(attempt.taskIds);
  const tasks = root.tasks.filter((task) => taskIds.has(task.id));
  return {
    agentId: attempt.agentId,
    attemptId: attempt.id,
    rootRunId: attempt.rootRunId,
    taskIds: [...attempt.taskIds],
    sourceExecutionIds: unique(tasks.map((task) => task.sourceExecutionId)),
    originTraceIds: unique(tasks.flatMap((task) => task.origin.traceId === null ? [] : [task.origin.traceId])),
    startedAtMs: attempt.startedAtMs,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function resolveRuntimeConfig(
  options: FollowupTaskStoreOptions,
  agentId: string,
): Result<{ enabled: boolean; preAcceptanceRetryLimit: number; quietUntilMs: number | null }, FollowupTaskStoreError> {
  const resolved = tryCatch(() => options.getRuntimeConfig(agentId));
  if (
    !resolved.ok
    || typeof resolved.value.enabled !== "boolean"
    || !Number.isSafeInteger(resolved.value.preAcceptanceRetryLimit)
    || resolved.value.preAcceptanceRetryLimit < 0
    || resolved.value.preAcceptanceRetryLimit > 3
    || (resolved.value.quietUntilMs !== null && (
      !Number.isSafeInteger(resolved.value.quietUntilMs)
      || resolved.value.quietUntilMs < 0
    ))
  ) return err(storeError("invalid_state", "config", "Task runtime configuration is invalid"));
  return ok(resolved.value);
}

function maintainRoot(root: FollowupTaskStoreFile, nowMs: number): FollowupTaskStoreFile {
  let changed = false;
  let tasks = root.tasks.map((task): FollowupTaskRecord => {
    if (task.status === "pending" && (task.dueLatestMs < nowMs || task.expiresAtMs < nowMs)) {
      changed = true;
      const { nextAttemptAtMs: _nextAttemptAtMs, ...base } = task;
      return { ...base, status: "expired", terminalAttemptId: null, terminalAtMs: nowMs };
    }
    return task;
  });
  const cutoff = nowMs - FOLLOWUP_TASK_RETENTION_MS;
  const removableAttempts = new Set(root.attempts.filter((attempt) => (
    "terminalAtMs" in attempt
    && attempt.terminalAtMs <= cutoff
    && attempt.taskIds.every((id) => {
      const task = tasks.find((candidate) => candidate.id === id);
      return task !== undefined && "terminalAtMs" in task && task.terminalAtMs <= cutoff;
    })
  )).map((attempt) => attempt.id));
  const attempts = root.attempts.filter((attempt) => !removableAttempts.has(attempt.id));
  tasks = tasks.filter((task) => {
    if (!("terminalAtMs" in task) || task.terminalAtMs > cutoff) return true;
    if ("terminalAttemptId" in task && task.terminalAttemptId !== null) {
      return !removableAttempts.has(task.terminalAttemptId);
    }
    return root.attempts.some((attempt) => attempt.taskIds.includes(task.id));
  });
  if (attempts.length !== root.attempts.length || tasks.length !== root.tasks.length) changed = true;
  const policyHashes = new Set(tasks.map((task) => task.workspacePolicyHash));
  const policySnapshots = root.policySnapshots.filter((policy) => policyHashes.has(policy.combinedHash));
  if (policySnapshots.length !== root.policySnapshots.length) changed = true;
  return changed ? { ...root, tasks, attempts, policySnapshots } : root;
}

function projectOperatorTask(task: FollowupTaskRecord): FollowupTaskOperatorRecord {
  return {
    id: task.id,
    agentId: task.agentId,
    status: task.status,
    dueEarliestMs: task.dueEarliestMs,
    dueLatestMs: task.dueLatestMs,
    expiresAtMs: task.expiresAtMs,
    attemptCount: task.attemptCount,
    preAcceptanceFailureCount: task.preAcceptanceFailureCount,
    sourceExecutionId: task.sourceExecutionId,
    sourceOccurrenceCount: task.sourceOccurrenceCount,
    conversationRef: task.origin.conversationRef,
  };
}

function cancelTask(task: FollowupTaskRecord, nowMs: number): FollowupTaskRecord {
  if (task.status !== "pending") return task;
  const { nextAttemptAtMs: _nextAttemptAtMs, ...base } = task;
  return { ...base, status: "cancelled", terminalAttemptId: null, terminalAtMs: nowMs };
}

export function encodeFollowupTaskStore(
  root: FollowupTaskStoreFile,
): Result<Buffer, FollowupTaskStoreError> {
  const parsed = parseFollowupTaskStoreFile(root);
  return parsed.ok
    ? ok(Buffer.from(`${JSON.stringify(parsed.value)}\n`, "utf8"))
    : err(storeError("invalid_state", "validation", "Follow-up task store mutation produced invalid authority"));
}

function encodedWithinCapacity(root: FollowupTaskStoreFile): boolean {
  const encoded = encodeFollowupTaskStore(root);
  if (!encoded.ok) return false;
  const activeAttempts = root.attempts.filter((attempt) => attempt.status === "checking" || attempt.status === "delivering").length;
  const reservedBytes = activeAttempts * ACTIVE_ATTEMPT_RESERVATION_BYTES;
  return Number.isSafeInteger(reservedBytes)
    && encoded.value.byteLength + reservedBytes <= MAX_FOLLOWUP_TASK_STORE_BYTES;
}

function validatePaths(options: FollowupTaskStoreOptions): FollowupTaskStoreError | undefined {
  return path.isAbsolute(options.filePath) && path.isAbsolute(options.lockPath)
    ? undefined
    : storeError("invalid_path", "validation", "Task store and lock paths must be absolute");
}

function lockError(kind: "locked" | "error", message: string): FollowupTaskStoreError {
  return kind === "locked"
    ? storeError("lock_contended", "resource", message)
    : storeError("lock_failed", "internal", message);
}

function storeError(code: FollowupTaskStoreErrorCode, errorKind: ErrorKind, message: string): FollowupTaskStoreError {
  return { code, errorKind, message };
}
