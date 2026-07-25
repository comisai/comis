// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClockPort, ErrorKind, FileLockPort } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { z } from "zod";
import { replaceDurableFile } from "../persistence/durable-file.js";
import { computeNextRunAtMs } from "./cron-expression.js";
import {
  CronPersistedJobSchema,
  type CronPersistedJob,
} from "./cron-types.js";

export const CRON_STORE_FORMAT_VERSION = 1;
export const MAX_CRON_STORE_BYTES = 32 * 1024 * 1024;
export const TERMINAL_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const IdentifierSchema = z.string().min(1).max(256);
const EpochMsSchema = z.number().int().nonnegative().safe();

export const CronWorkKindSchema = z.enum([
  "agent_turn",
  "heartbeat_event",
  "internal_action",
  "delivery_only",
]);
export type CronWorkKind = z.infer<typeof CronWorkKindSchema>;

export const CronTriggerSchema = z.enum(["scheduled", "manual", "catchup"]);
export type CronTrigger = z.infer<typeof CronTriggerSchema>;

export const CronActiveClaimSchema = z.strictObject({
  executionId: IdentifierSchema,
  bootId: IdentifierSchema,
  jobId: IdentifierSchema,
  agentId: IdentifierSchema,
  rootRunId: IdentifierSchema.nullable(),
  scheduledForMs: EpochMsSchema,
  claimedAtMs: EpochMsSchema,
  trigger: CronTriggerSchema,
  workKind: CronWorkKindSchema,
});
export type CronActiveClaim = z.infer<typeof CronActiveClaimSchema>;

export const CronStoreRootSchema = z.strictObject({
  formatVersion: z.literal(CRON_STORE_FORMAT_VERSION),
  agentSchedulerSeed: IdentifierSchema,
  jobs: z.array(CronPersistedJobSchema),
  activeClaims: z.array(CronActiveClaimSchema),
}).superRefine((root, ctx) => {
  const jobIds = new Set<string>();
  const jobNames = new Set<string>();
  for (const [index, job] of root.jobs.entries()) {
    if (jobIds.has(job.id)) {
      ctx.addIssue({ code: "custom", path: ["jobs", index, "id"], message: "job id must be unique" });
    }
    if (jobNames.has(job.name)) {
      ctx.addIssue({ code: "custom", path: ["jobs", index, "name"], message: "job name must be unique" });
    }
    jobIds.add(job.id);
    jobNames.add(job.name);
  }

  const executions = new Set<string>();
  const claimedJobs = new Set<string>();
  for (const [index, claim] of root.activeClaims.entries()) {
    if (executions.has(claim.executionId)) {
      ctx.addIssue({ code: "custom", path: ["activeClaims", index, "executionId"], message: "execution id must be unique" });
    }
    if (claimedJobs.has(claim.jobId)) {
      ctx.addIssue({ code: "custom", path: ["activeClaims", index, "jobId"], message: "a job may have only one active claim" });
    }
    executions.add(claim.executionId);
    claimedJobs.add(claim.jobId);
    const job = root.jobs.find((candidate) => candidate.id === claim.jobId);
    if (job === undefined) {
      ctx.addIssue({ code: "custom", path: ["activeClaims", index, "jobId"], message: "claim must reference an existing job" });
      continue;
    }
    if (job.agentId !== claim.agentId || workKindOf(job) !== claim.workKind) {
      ctx.addIssue({ code: "custom", path: ["activeClaims", index], message: "claim identity must match its job" });
    }
    if (requiresGovernedRoot(claim.workKind) !== (claim.rootRunId !== null)) {
      ctx.addIssue({ code: "custom", path: ["activeClaims", index, "rootRunId"], message: "claim root legality does not match work kind" });
    }
    if (claim.trigger !== "manual" && job.schedule.kind === "at") {
      if (
        job.lifecycle.status !== "one_shot_claimed"
        || job.lifecycle.executionId !== claim.executionId
        || job.lifecycle.scheduledForMs !== claim.scheduledForMs
        || job.lifecycle.claimedAtMs !== claim.claimedAtMs
      ) {
        ctx.addIssue({ code: "custom", path: ["jobs"], message: "one-shot lifecycle must match its active claim" });
      }
    }
  }
});
export type CronStoreRoot = z.infer<typeof CronStoreRootSchema>;

export type CronStoreErrorCode =
  | "not_initialized"
  | "invalid_path"
  | "invalid_state"
  | "lock_contended"
  | "lock_failed"
  | "io"
  | "not_found"
  | "conflict"
  | "already_running"
  | "invalid_claim"
  | "capacity"
  | "config_owned"
  | "active_claim";

export type CronStoreError = {
  code: CronStoreErrorCode;
  errorKind: ErrorKind;
  message: string;
};

export type CronClaimInput = {
  jobId: string;
  executionId: string;
  bootId: string;
  rootRunId: string | null;
  trigger: CronTrigger;
  scheduledForMs?: number;
  claimedAtMs: number;
};

export type CronClaimResult = {
  claim: CronActiveClaim;
  job: CronPersistedJob;
};

export type CronDependencyOutcome = "success" | "dependency_error" | "neutral";

export interface CronStoreOptions {
  filePath: string;
  lockPath: string;
  fileLock: FileLockPort;
  clock: ClockPort;
  idFactory: () => string;
  maxAuthoredJobs: number;
  maxConsecutiveDependencyErrors?: number;
  maxStoreBytes?: number;
  terminalRetentionMs?: number;
}

export interface CronStore {
  initialize(): Promise<Result<CronStoreRoot, CronStoreError>>;
  getSnapshot(): Result<CronStoreRoot, CronStoreError>;
  listJobs(): Result<readonly CronPersistedJob[], CronStoreError>;
  addJob(job: CronPersistedJob): Promise<Result<void, CronStoreError>>;
  replaceAuthoredJob(jobId: string, job: CronPersistedJob): Promise<Result<void, CronStoreError>>;
  removeJob(jobId: string): Promise<Result<boolean, CronStoreError>>;
  reconcileBuiltIns(jobs: readonly CronPersistedJob[]): Promise<Result<void, CronStoreError>>;
  claim(input: CronClaimInput): Promise<Result<CronClaimResult, CronStoreError>>;
  settleClaim(input: {
    executionId: string;
    terminalAtMs: number;
    dependencyOutcome: CronDependencyOutcome;
  }): Promise<Result<"settled" | "already_settled", CronStoreError>>;
}

const LOCK_OPTIONS = { staleMs: 30_000, updateMs: 5_000 } as const;

export function createCronStore(options: CronStoreOptions): CronStore {
  const maxStoreBytes = options.maxStoreBytes ?? MAX_CRON_STORE_BYTES;
  const retentionMs = options.terminalRetentionMs ?? TERMINAL_JOB_RETENTION_MS;
  const globalDependencyLimit = options.maxConsecutiveDependencyErrors ?? 5;
  const mutex = createMutex();
  let state: CronStoreRoot | undefined;

  const pathError = validateOptions(options, maxStoreBytes);

  async function initialize(): Promise<Result<CronStoreRoot, CronStoreError>> {
    return mutex.serialize(async () => {
      if (pathError !== undefined) return err(pathError);
      const locked = await options.fileLock.withLock(options.lockPath, async () => {
        const read = await readRoot();
        if (!read.ok) return read;
        let root = read.value;
        const pruned = pruneTerminalJobs(root, options.clock.now(), retentionMs);
        if (pruned !== root) {
          const written = await writeRoot(pruned);
          if (!written.ok) return written;
          root = pruned;
        }
        state = root;
        return ok(snapshot(root));
      }, LOCK_OPTIONS);
      if (!locked.ok) return err(lockError(locked.error.kind, locked.error.message));
      return locked.value;
    });
  }

  function getSnapshot(): Result<CronStoreRoot, CronStoreError> {
    return state === undefined
      ? err(storeError("not_initialized", "precondition", "Cron store is not initialized"))
      : ok(snapshot(state));
  }

  function listJobs(): Result<readonly CronPersistedJob[], CronStoreError> {
    const current = getSnapshot();
    return current.ok ? ok(current.value.jobs) : current;
  }

  async function addJob(jobInput: CronPersistedJob): Promise<Result<void, CronStoreError>> {
    const parsed = CronPersistedJobSchema.safeParse(jobInput);
    if (!parsed.success) return err(storeError("invalid_state", "validation", "Invalid cron job"));
    return mutate((root) => {
      if (root.jobs.some((job) => job.id === parsed.data.id || job.name === parsed.data.name)) {
        return err(storeError("conflict", "precondition", "Cron job id and name must be unique"));
      }
      if (parsed.data.source === "authored" && authoredJobCount(root.jobs) >= options.maxAuthoredJobs) {
        return err(storeError("capacity", "resource", "Authored cron job capacity reached"));
      }
      return ok({ ...root, jobs: [...root.jobs, parsed.data] });
    });
  }

  async function replaceAuthoredJob(
    jobId: string,
    jobInput: CronPersistedJob,
  ): Promise<Result<void, CronStoreError>> {
    const parsed = CronPersistedJobSchema.safeParse(jobInput);
    if (!parsed.success || parsed.data.id !== jobId || parsed.data.source !== "authored") {
      return err(storeError("invalid_state", "validation", "Invalid authored cron replacement"));
    }
    return mutate((root) => {
      const index = root.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) return err(storeError("not_found", "validation", "Cron job not found"));
      if (root.jobs[index]!.source === "built_in") {
        return err(storeError("config_owned", "precondition", "Built-in cron jobs are config-owned"));
      }
      if (root.activeClaims.some((claim) => claim.jobId === jobId)) {
        return err(storeError("active_claim", "precondition", "Cron job has an active execution"));
      }
      if (root.jobs.some((job, candidate) => candidate !== index && job.name === parsed.data.name)) {
        return err(storeError("conflict", "precondition", "Cron job name must be unique"));
      }
      const jobs = [...root.jobs];
      jobs[index] = parsed.data;
      return ok({ ...root, jobs });
    });
  }

  async function removeJob(jobId: string): Promise<Result<boolean, CronStoreError>> {
    let removed = false;
    const result = await mutate((root) => {
      const job = root.jobs.find((candidate) => candidate.id === jobId);
      if (job === undefined) return ok(root);
      if (job.source === "built_in") {
        return err(storeError("config_owned", "precondition", "Built-in cron jobs are config-owned"));
      }
      if (root.activeClaims.some((claim) => claim.jobId === jobId)) {
        return err(storeError("active_claim", "precondition", "Cron job has an active execution"));
      }
      removed = true;
      return ok({ ...root, jobs: root.jobs.filter((candidate) => candidate.id !== jobId) });
    });
    return result.ok ? ok(removed) : result;
  }

  async function reconcileBuiltIns(
    desiredInput: readonly CronPersistedJob[],
  ): Promise<Result<void, CronStoreError>> {
    const desired: CronPersistedJob[] = [];
    for (const candidate of desiredInput) {
      const parsed = CronPersistedJobSchema.safeParse(candidate);
      if (!parsed.success || parsed.data.source !== "built_in") {
        return err(storeError("invalid_state", "validation", "Built-in reconciliation accepts only built-in jobs"));
      }
      desired.push(parsed.data);
    }
    return mutate((root) => {
      const desiredIds = new Set(desired.map((job) => job.id));
      const claimedIds = new Set(root.activeClaims.map((claim) => claim.jobId));
      const retained = root.jobs.filter((job) => (
        job.source === "authored" || desiredIds.has(job.id) || claimedIds.has(job.id)
      ));
      for (const wanted of desired) {
        const index = retained.findIndex((job) => job.id === wanted.id);
        if (index < 0) retained.push(wanted);
        else if (!claimedIds.has(wanted.id)) retained[index] = wanted;
      }
      return ok({ ...root, jobs: retained });
    });
  }

  async function claim(input: CronClaimInput): Promise<Result<CronClaimResult, CronStoreError>> {
    let claimed: CronClaimResult | undefined;
    const mutated = await mutate((root) => {
      if (root.activeClaims.some((candidate) => candidate.jobId === input.jobId)) {
        return err(storeError("already_running", "precondition", "Cron job already has an active execution"));
      }
      if (root.activeClaims.some((candidate) => candidate.executionId === input.executionId)) {
        return err(storeError("conflict", "precondition", "Cron execution id already exists"));
      }
      const index = root.jobs.findIndex((candidate) => candidate.id === input.jobId);
      if (index < 0) return err(storeError("not_found", "validation", "Cron job not found"));
      const original = root.jobs[index]!;
      const workKind = workKindOf(original);
      if (requiresGovernedRoot(workKind) !== (input.rootRunId !== null)) {
        return err(storeError("invalid_claim", "validation", "Cron claim root does not match its work kind"));
      }
      if (!validId(input.executionId) || !validId(input.bootId) || !Number.isSafeInteger(input.claimedAtMs) || input.claimedAtMs < 0) {
        return err(storeError("invalid_claim", "validation", "Invalid cron claim identity or time"));
      }

      let scheduledForMs: number;
      let claimedJob = original;
      if (input.trigger === "manual") {
        scheduledForMs = input.claimedAtMs;
      } else {
        if (
          input.scheduledForMs === undefined
          || original.lifecycle.status !== "scheduled"
          || original.lifecycle.nextRunAtMs !== input.scheduledForMs
        ) {
          return err(storeError("conflict", "precondition", "Scheduled occurrence no longer matches persisted eligibility"));
        }
        scheduledForMs = input.scheduledForMs;
        if (original.schedule.kind === "at") {
          claimedJob = {
            ...original,
            lifecycle: {
              status: "one_shot_claimed",
              executionId: input.executionId,
              scheduledForMs,
              claimedAtMs: input.claimedAtMs,
            },
          };
        } else {
          const nextRunAtMs = computeNextRunAtMs(original.schedule, input.claimedAtMs);
          if (nextRunAtMs === undefined) {
            return err(storeError("invalid_state", "validation", "Recurring schedule has no safe future occurrence"));
          }
          claimedJob = {
            ...original,
            lifecycle: {
              status: "scheduled",
              nextRunAtMs,
              consecutiveDependencyErrors: original.lifecycle.consecutiveDependencyErrors,
            },
          };
        }
      }

      const claimCandidate = {
        executionId: input.executionId,
        bootId: input.bootId,
        jobId: original.id,
        agentId: original.agentId,
        rootRunId: input.rootRunId,
        scheduledForMs,
        claimedAtMs: input.claimedAtMs,
        trigger: input.trigger,
        workKind,
      };
      const parsedClaim = CronActiveClaimSchema.safeParse(claimCandidate);
      if (!parsedClaim.success) {
        return err(storeError("invalid_claim", "validation", "Invalid cron claim"));
      }
      const jobs = [...root.jobs];
      jobs[index] = claimedJob;
      claimed = { claim: parsedClaim.data, job: claimedJob };
      return ok({ ...root, jobs, activeClaims: [...root.activeClaims, parsedClaim.data] });
    });
    if (!mutated.ok) return mutated;
    return claimed === undefined
      ? err(storeError("invalid_state", "internal", "Cron claim was not materialized"))
      : ok(snapshotClaim(claimed));
  }

  async function settleClaim(input: {
    executionId: string;
    terminalAtMs: number;
    dependencyOutcome: CronDependencyOutcome;
  }): Promise<Result<"settled" | "already_settled", CronStoreError>> {
    let disposition: "settled" | "already_settled" = "already_settled";
    const mutated = await mutate((root) => {
      const claimIndex = root.activeClaims.findIndex((claim) => claim.executionId === input.executionId);
      if (claimIndex < 0) return ok(root);
      if (!Number.isSafeInteger(input.terminalAtMs) || input.terminalAtMs < 0) {
        return err(storeError("invalid_state", "validation", "Invalid cron terminal timestamp"));
      }
      const claim = root.activeClaims[claimIndex]!;
      const jobIndex = root.jobs.findIndex((job) => job.id === claim.jobId);
      if (jobIndex < 0) return err(storeError("invalid_state", "validation", "Cron claim lost its job"));
      const job = root.jobs[jobIndex]!;
      let settledJob = job;
      if (claim.trigger !== "manual") {
        if (job.schedule.kind === "at") {
          settledJob = {
            ...job,
            lifecycle: {
              status: "one_shot_terminal",
              terminalExecutionId: input.executionId,
              terminalAtMs: input.terminalAtMs,
            },
          };
        } else if (job.lifecycle.status === "scheduled") {
          const priorErrors = job.lifecycle.consecutiveDependencyErrors;
          const nextErrors = input.dependencyOutcome === "success"
            ? 0
            : input.dependencyOutcome === "dependency_error"
              ? priorErrors + 1
              : priorErrors;
          if (!Number.isSafeInteger(nextErrors)) {
            return err(storeError("capacity", "resource", "Dependency error counter overflow"));
          }
          const limit = job.maxConsecutiveDependencyErrors ?? globalDependencyLimit;
          settledJob = input.dependencyOutcome === "dependency_error" && limit > 0 && nextErrors >= limit
            ? {
              ...job,
              lifecycle: {
                status: "paused",
                nextRunAtMs: job.lifecycle.nextRunAtMs,
                consecutiveDependencyErrors: nextErrors,
                reason: "dependency_errors",
              },
            }
            : {
              ...job,
              lifecycle: { ...job.lifecycle, consecutiveDependencyErrors: nextErrors },
            };
        }
      }
      const jobs = [...root.jobs];
      jobs[jobIndex] = settledJob;
      const activeClaims = root.activeClaims.filter((claim) => claim.executionId !== input.executionId);
      disposition = "settled";
      return ok({ ...root, jobs, activeClaims });
    });
    return mutated.ok ? ok(disposition) : mutated;
  }

  async function mutate(
    change: (root: CronStoreRoot) => Result<CronStoreRoot, CronStoreError>,
  ): Promise<Result<void, CronStoreError>> {
    return mutex.serialize(async () => {
      if (pathError !== undefined) return err(pathError);
      if (state === undefined) return err(storeError("not_initialized", "precondition", "Cron store is not initialized"));
      const locked = await options.fileLock.withLock(options.lockPath, async () => {
        const read = await readExistingRoot();
        if (!read.ok) return read;
        const current = pruneTerminalJobs(read.value, options.clock.now(), retentionMs);
        const changed = change(current);
        if (!changed.ok) return changed;
        const written = await writeRoot(changed.value);
        if (!written.ok) return written;
        state = changed.value;
        return ok(undefined);
      }, LOCK_OPTIONS);
      if (!locked.ok) return err(lockError(locked.error.kind, locked.error.message));
      return locked.value;
    });
  }

  async function readRoot(): Promise<Result<CronStoreRoot, CronStoreError>> {
    const read = await fromPromise(fs.readFile(options.filePath));
    if (!read.ok) {
      if (isNodeError(read.error, "ENOENT")) {
        const seed = options.idFactory();
        if (!validId(seed)) return err(storeError("invalid_state", "validation", "Opaque id factory returned an invalid scheduler seed"));
        const root: CronStoreRoot = {
          formatVersion: CRON_STORE_FORMAT_VERSION,
          agentSchedulerSeed: seed,
          jobs: [],
          activeClaims: [],
        };
        const written = await writeRoot(root);
        return written.ok ? ok(root) : written;
      }
      return err(storeError("io", "internal", "Unable to read cron store"));
    }
    return decodeRoot(read.value);
  }

  async function readExistingRoot(): Promise<Result<CronStoreRoot, CronStoreError>> {
    const read = await fromPromise(fs.readFile(options.filePath));
    return read.ok
      ? decodeRoot(read.value)
      : err(storeError("io", "internal", "Unable to read initialized cron store"));
  }

  function decodeRoot(raw: Buffer): Result<CronStoreRoot, CronStoreError> {
    if (raw.byteLength > maxStoreBytes) {
      return err(storeError("invalid_state", "validation", "Cron store exceeds its byte ceiling"));
    }
    const decoded = tryCatch(() => JSON.parse(raw.toString("utf8")) as unknown);
    if (!decoded.ok) return err(storeError("invalid_state", "validation", "Cron store contains invalid JSON"));
    const parsed = CronStoreRootSchema.safeParse(decoded.value);
    return parsed.success
      ? ok(parsed.data)
      : err(storeError("invalid_state", "validation", "Cron store does not match the strict format"));
  }

  async function writeRoot(rootInput: CronStoreRoot): Promise<Result<void, CronStoreError>> {
    const encoded = encodeCronStoreRoot(rootInput);
    if (!encoded.ok) return encoded;
    if (encoded.value.byteLength > maxStoreBytes) {
      return err(storeError("capacity", "resource", "Cron store byte capacity reached"));
    }
    const replaced = await replaceDurableFile({
      filePath: options.filePath,
      bytes: encoded.value,
      temporaryToken: options.idFactory,
    });
    if (replaced.ok) return replaced;
    return replaced.error.code === "invalid_input"
      ? err(storeError("invalid_state", replaced.error.errorKind, "Opaque id factory returned an invalid temporary-file token"))
      : err(storeError("io", replaced.error.errorKind, "Unable to durably replace cron store"));
  }

  return {
    initialize,
    getSnapshot,
    listJobs,
    addJob,
    replaceAuthoredJob,
    removeJob,
    reconcileBuiltIns,
    claim,
    settleClaim,
  };
}

export function encodeCronStoreRoot(rootInput: CronStoreRoot): Result<Buffer, CronStoreError> {
  const parsed = CronStoreRootSchema.safeParse(rootInput);
  if (!parsed.success) return err(storeError("invalid_state", "validation", "Invalid cron store root"));
  return ok(Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8"));
}

function workKindOf(job: CronPersistedJob): CronWorkKind {
  switch (job.payload.kind) {
    case "agent_turn": return "agent_turn";
    case "heartbeat_event": return "heartbeat_event";
    case "internal_action": return "internal_action";
    case "delivery": return "delivery_only";
    default: {
      const _exhaustive: never = job.payload;
      return _exhaustive;
    }
  }
}

function requiresGovernedRoot(kind: CronWorkKind): boolean {
  return kind === "agent_turn" || kind === "internal_action";
}

function authoredJobCount(jobs: readonly CronPersistedJob[]): number {
  return jobs.filter((job) => job.source === "authored" && job.lifecycle.status !== "one_shot_terminal").length;
}

function pruneTerminalJobs(root: CronStoreRoot, nowMs: number, retentionMs: number): CronStoreRoot {
  const claimedJobs = new Set(root.activeClaims.map((claim) => claim.jobId));
  const jobs = root.jobs.filter((job) => !(
    job.lifecycle.status === "one_shot_terminal"
    && nowMs - job.lifecycle.terminalAtMs >= retentionMs
    && !claimedJobs.has(job.id)
  ));
  return jobs.length === root.jobs.length ? root : { ...root, jobs };
}

function validateOptions(options: CronStoreOptions, maxStoreBytes: number): CronStoreError | undefined {
  if (!path.isAbsolute(options.filePath) || !path.isAbsolute(options.lockPath)) {
    return storeError("invalid_path", "validation", "Cron store and lock paths must be absolute");
  }
  if (!Number.isSafeInteger(options.maxAuthoredJobs) || options.maxAuthoredJobs <= 0 || options.maxAuthoredJobs > 10_000) {
    return storeError("invalid_state", "validation", "Authored cron capacity must be between 1 and 10000");
  }
  if (!Number.isSafeInteger(maxStoreBytes) || maxStoreBytes <= 0 || maxStoreBytes > MAX_CRON_STORE_BYTES) {
    return storeError("invalid_state", "validation", "Cron store byte capacity is invalid");
  }
  return undefined;
}

function lockError(kind: "locked" | "error", message: string): CronStoreError {
  return kind === "locked"
    ? storeError("lock_contended", "resource", message)
    : storeError("lock_failed", "internal", message);
}

function storeError(code: CronStoreErrorCode, errorKind: ErrorKind, message: string): CronStoreError {
  return { code, errorKind, message };
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && Buffer.byteLength(value, "utf8") <= 256;
}

function isNodeError(error: Error, code: string): boolean {
  return "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function snapshot(root: CronStoreRoot): CronStoreRoot {
  return structuredClone(root);
}

function snapshotClaim(result: CronClaimResult): CronClaimResult {
  return structuredClone(result);
}

function createMutex() {
  let tail = Promise.resolve();
  return {
    serialize<T>(operation: () => Promise<T>): Promise<T> {
      const current = tail.then(operation, operation);
      tail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
}
