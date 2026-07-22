// SPDX-License-Identifier: Apache-2.0
/** Conservative quarantine for malformed, referentially closed terminal task groups. */
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  WorkspacePolicySnapshotSchema,
  verifyWorkspacePolicySnapshot,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { z } from "zod";
import {
  FollowupTaskAttemptRecordSchema,
  FollowupTaskRecordSchema,
  parseFollowupTaskStoreFile,
  type FollowupTaskStoreError,
  type FollowupTaskStoreFile,
} from "./task-types.js";

export const MAX_FOLLOWUP_TASK_QUARANTINE_BYTES = 16 * 1_024 * 1_024;

const IdSchema = z.string().min(1).max(256);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const EpochMsSchema = z.number().int().nonnegative().safe();
const TerminalTaskStatusSchema = z.enum([
  "delivered",
  "delivery_partial",
  "dismissed",
  "delivery_unknown",
  "expired",
  "cancelled",
]);
const TerminalAttemptStatusSchema = z.enum([
  "failed",
  "dismissed",
  "delivered",
  "delivery_partial",
  "delivery_unknown",
]);
const TaskEnvelopeSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  status: z.enum([
    "pending",
    "checking",
    "delivering",
    "delivered",
    "delivery_partial",
    "dismissed",
    "delivery_unknown",
    "expired",
    "cancelled",
  ]),
  workspacePolicyHash: DigestSchema,
  activeAttemptId: IdSchema.optional(),
  terminalAttemptId: IdSchema.nullable().optional(),
}).passthrough().superRefine((task, context) => {
  if ((task.status === "checking" || task.status === "delivering") && task.activeAttemptId === undefined) {
    context.addIssue({ code: "custom", message: "active task envelope lacks attempt authority" });
  }
  if (
    task.status !== "pending"
    && task.status !== "checking"
    && task.status !== "delivering"
    && task.status !== "cancelled"
    && task.terminalAttemptId === undefined
  ) {
    context.addIssue({ code: "custom", message: "terminal task envelope lacks terminal authority" });
  }
});
const AttemptEnvelopeSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  status: z.enum([
    "checking",
    "delivering",
    "failed",
    "dismissed",
    "delivered",
    "delivery_partial",
    "delivery_unknown",
  ]),
  taskIds: z.array(IdSchema).min(1).max(8),
}).passthrough();
const PolicyEnvelopeSchema = z.object({ agentId: IdSchema, combinedHash: DigestSchema }).passthrough();
const QuarantineRowSchema = z.strictObject({
  formatVersion: z.literal(1),
  entryId: DigestSchema,
  quarantinedAtMs: EpochMsSchema,
  recordKind: z.enum(["task", "attempt", "policy_snapshot"]),
  recordId: IdSchema,
  recordHash: DigestSchema,
  record: z.unknown(),
});

type QuarantineRecordKind = z.infer<typeof QuarantineRowSchema>["recordKind"];

interface RawTaskRoot {
  readonly formatVersion: 1;
  readonly tasks: readonly unknown[];
  readonly attempts: readonly unknown[];
  readonly policySnapshots: readonly unknown[];
}

interface RawRecord {
  readonly kind: QuarantineRecordKind;
  readonly id: string;
  readonly value: unknown;
}

export interface TaskQuarantineResult {
  readonly root: FollowupTaskStoreFile;
  readonly quarantinedRecordCount: number;
}

export interface TaskQuarantineInspection {
  readonly exists: boolean;
  readonly bytes: number;
  readonly digest: string | null;
  readonly recordCount: number;
  readonly state: "valid" | "invalid";
}

export async function quarantineMalformedTerminalTaskGroups(input: {
  readonly raw: RawTaskRoot;
  readonly quarantinePath: string;
  readonly quarantinedAtMs: number;
}): Promise<Result<TaskQuarantineResult, FollowupTaskStoreError>> {
  if (!path.isAbsolute(input.quarantinePath) || !validTime(input.quarantinedAtMs)) {
    return err(quarantineError("validation", "Task quarantine input is invalid"));
  }
  const planned = planQuarantine(input.raw);
  if (!planned.ok) return planned;
  const existing = await readQuarantine(input.quarantinePath);
  if (!existing.ok) return existing;
  const existingIds = new Set(existing.value.map((row) => row.entryId));
  const rows = planned.value.records.map((record) => buildRow(record, input.quarantinedAtMs));
  const missingRows = rows.filter((row) => !existingIds.has(row.entryId));
  if (missingRows.length > 0) {
    const bytes = Buffer.from(missingRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const appended = await appendPrivateFile(input.quarantinePath, bytes);
    if (!appended.ok) return appended;
  }
  return ok({
    root: planned.value.root,
    quarantinedRecordCount: planned.value.records.length,
  });
}

export async function inspectTaskQuarantine(
  quarantinePath: string,
): Promise<Result<TaskQuarantineInspection, FollowupTaskStoreError>> {
  if (!path.isAbsolute(quarantinePath)) {
    return err(quarantineError("validation", "Task quarantine path is invalid"));
  }
  const read = await readPrivateQuarantineFile(quarantinePath);
  if (!read.ok) {
    return read.error.errorKind === "validation"
      ? ok({ exists: true, bytes: 0, digest: null, recordCount: 0, state: "invalid" })
      : read;
  }
  if (read.value === null) {
    return ok({ exists: false, bytes: 0, digest: null, recordCount: 0, state: "valid" });
  }
  const digest = createHash("sha256").update(read.value).digest("hex");
  const rows = decodeQuarantineRows(read.value);
  return rows.ok
    ? ok({
      exists: true,
      bytes: read.value.byteLength,
      digest,
      recordCount: rows.value.length,
      state: "valid",
    })
    : ok({ exists: true, bytes: read.value.byteLength, digest, recordCount: 0, state: "invalid" });
}

function planQuarantine(
  raw: RawTaskRoot,
): Result<{ root: FollowupTaskStoreFile; records: RawRecord[] }, FollowupTaskStoreError> {
  const tasks = parseEnvelopes(raw.tasks, TaskEnvelopeSchema);
  const attempts = parseEnvelopes(raw.attempts, AttemptEnvelopeSchema);
  const policies = parseEnvelopes(raw.policySnapshots, PolicyEnvelopeSchema);
  if (!tasks.ok || !attempts.ok || !policies.ok) {
    return err(quarantineError("validation", "Malformed task authority lacks bounded quarantine metadata"));
  }
  if (
    hasDuplicate(tasks.value.map((task) => task.id))
    || hasDuplicate(attempts.value.map((attempt) => attempt.id))
    || hasDuplicate(policies.value.map((policy) => policy.combinedHash))
  ) {
    return err(quarantineError("validation", "Malformed task authority has ambiguous duplicate identifiers"));
  }

  const invalidTaskIds = new Set(tasks.value.flatMap((task, index) => (
    FollowupTaskRecordSchema.safeParse(raw.tasks[index]).success ? [] : [task.id]
  )));
  const invalidAttemptIds = new Set(attempts.value.flatMap((attempt, index) => (
    FollowupTaskAttemptRecordSchema.safeParse(raw.attempts[index]).success ? [] : [attempt.id]
  )));
  const invalidPolicyIds = new Set(policies.value.flatMap((policy, index) => {
    const parsed = WorkspacePolicySnapshotSchema.safeParse(raw.policySnapshots[index]);
    return parsed.success && verifyWorkspacePolicySnapshot(parsed.data).ok ? [] : [policy.combinedHash];
  }));
  if (invalidTaskIds.size + invalidAttemptIds.size + invalidPolicyIds.size === 0) {
    return err(quarantineError("validation", "Malformed task authority has an ambiguous reference graph"));
  }

  const taskById = new Map(tasks.value.map((task, index) => [task.id, { envelope: task, raw: raw.tasks[index] }]));
  const attemptById = new Map(attempts.value.map((attempt, index) => [attempt.id, { envelope: attempt, raw: raw.attempts[index] }]));
  const policyById = new Map(policies.value.map((policy, index) => [policy.combinedHash, { envelope: policy, raw: raw.policySnapshots[index] }]));
  const taskIds = new Set(invalidTaskIds);
  const attemptIds = new Set(invalidAttemptIds);
  const policyIds = new Set(invalidPolicyIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const taskId of [...taskIds]) {
      const task = taskById.get(taskId)?.envelope;
      if (task === undefined || !TerminalTaskStatusSchema.safeParse(task.status).success) return unsafeGroup();
      if (!policyIds.has(task.workspacePolicyHash)) {
        policyIds.add(task.workspacePolicyHash);
        changed = true;
      }
      if (task.terminalAttemptId !== undefined && task.terminalAttemptId !== null && !attemptIds.has(task.terminalAttemptId)) {
        attemptIds.add(task.terminalAttemptId);
        changed = true;
      }
    }
    for (const attemptId of [...attemptIds]) {
      const attempt = attemptById.get(attemptId)?.envelope;
      if (attempt === undefined || !TerminalAttemptStatusSchema.safeParse(attempt.status).success) return unsafeGroup();
      for (const taskId of attempt.taskIds) {
        if (!taskIds.has(taskId)) {
          taskIds.add(taskId);
          changed = true;
        }
      }
    }
    for (const policyId of [...policyIds]) {
      if (!policyById.has(policyId)) return unsafeGroup();
      for (const task of tasks.value) {
        if (task.workspacePolicyHash === policyId && !taskIds.has(task.id)) {
          taskIds.add(task.id);
          changed = true;
        }
      }
    }
  }

  if (
    tasks.value.some((task) => !taskIds.has(task.id) && (
      task.activeAttemptId !== undefined && attemptIds.has(task.activeAttemptId)
      || task.terminalAttemptId !== undefined && task.terminalAttemptId !== null && attemptIds.has(task.terminalAttemptId)
      || policyIds.has(task.workspacePolicyHash)
    ))
    || attempts.value.some((attempt) => !attemptIds.has(attempt.id) && attempt.taskIds.some((taskId) => taskIds.has(taskId)))
  ) return unsafeGroup();

  const remainingRaw = {
    formatVersion: 1 as const,
    tasks: raw.tasks.filter((_task, index) => !taskIds.has(tasks.value[index]!.id)),
    attempts: raw.attempts.filter((_attempt, index) => !attemptIds.has(attempts.value[index]!.id)),
    policySnapshots: raw.policySnapshots.filter((_policy, index) => !policyIds.has(policies.value[index]!.combinedHash)),
  };
  const remaining = parseFollowupTaskStoreFile(remainingRaw);
  if (!remaining.ok) return unsafeGroup();
  const records: RawRecord[] = [
    ...[...taskIds].map((id) => ({ kind: "task" as const, id, value: taskById.get(id)!.raw })),
    ...[...attemptIds].map((id) => ({ kind: "attempt" as const, id, value: attemptById.get(id)!.raw })),
    ...[...policyIds].map((id) => ({ kind: "policy_snapshot" as const, id, value: policyById.get(id)!.raw })),
  ];
  return ok({ root: remaining.value, records });
}

function parseEnvelopes<T>(
  values: readonly unknown[],
  schema: z.ZodType<T>,
): Result<T[], FollowupTaskStoreError> {
  const parsed: T[] = [];
  for (const value of values) {
    const envelope = schema.safeParse(value);
    if (!envelope.success) return err(quarantineError("validation", "Task quarantine envelope is invalid"));
    parsed.push(envelope.data);
  }
  return ok(parsed);
}

function buildRow(record: RawRecord, quarantinedAtMs: number): z.infer<typeof QuarantineRowSchema> {
  const recordHash = hashRecord(record.value);
  return {
    formatVersion: 1,
    entryId: quarantineEntryId(record.kind, record.id, recordHash),
    quarantinedAtMs,
    recordKind: record.kind,
    recordId: record.id,
    recordHash,
    record: record.value,
  };
}

async function readQuarantine(
  quarantinePath: string,
): Promise<Result<Array<z.infer<typeof QuarantineRowSchema>>, FollowupTaskStoreError>> {
  const read = await readPrivateQuarantineFile(quarantinePath);
  if (!read.ok) return read;
  if (read.value === null) return ok([]);
  return decodeQuarantineRows(read.value);
}

function decodeQuarantineRows(
  bytes: Buffer,
): Result<Array<z.infer<typeof QuarantineRowSchema>>, FollowupTaskStoreError> {
  const rows: Array<z.infer<typeof QuarantineRowSchema>> = [];
  const entryIds = new Set<string>();
  for (const line of bytes.toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    const decoded = tryCatch(() => JSON.parse(line) as unknown);
    if (!decoded.ok) return err(quarantineError("validation", "Follow-up task quarantine contains invalid JSON"));
    const row = QuarantineRowSchema.safeParse(decoded.value);
    if (
      !row.success
      || row.data.recordHash !== hashRecord(row.data.record)
      || row.data.entryId !== quarantineEntryId(row.data.recordKind, row.data.recordId, row.data.recordHash)
      || entryIds.has(row.data.entryId)
    ) {
      return err(quarantineError("validation", "Follow-up task quarantine contains invalid evidence"));
    }
    entryIds.add(row.data.entryId);
    rows.push(row.data);
  }
  return ok(rows);
}

async function readPrivateQuarantineFile(
  filePath: string,
): Promise<Result<Buffer | null, FollowupTaskStoreError>> {
  const existing = await fromPromise(fs.lstat(filePath));
  if (!existing.ok) {
    return isNodeError(existing.error, "ENOENT")
      ? ok(null)
      : err(quarantineError("internal", "Unable to inspect follow-up task quarantine"));
  }
  if (
    !existing.value.isFile()
    || existing.value.isSymbolicLink()
    || (existing.value.mode & 0o777) !== 0o600
    || existing.value.size > MAX_FOLLOWUP_TASK_QUARANTINE_BYTES
  ) return err(quarantineError("validation", "Follow-up task quarantine file authority is invalid"));

  const noFollow = "O_NOFOLLOW" in fsConstants
    ? (fsConstants as typeof fsConstants & { O_NOFOLLOW: number }).O_NOFOLLOW
    : 0;
  const opened = await fromPromise(fs.open(filePath, fsConstants.O_RDONLY | noFollow));
  if (!opened.ok) return err(quarantineError("internal", "Unable to open follow-up task quarantine"));
  const handle = opened.value;
  const status = await fromPromise(handle.stat());
  if (
    !status.ok
    || !status.value.isFile()
    || (status.value.mode & 0o777) !== 0o600
    || status.value.size > MAX_FOLLOWUP_TASK_QUARANTINE_BYTES
  ) return closeWithError(handle, "Follow-up task quarantine file authority changed during inspection");
  const read = await fromPromise(handle.readFile());
  if (!read.ok) return closeWithError(handle, "Unable to read follow-up task quarantine");
  if (read.value.byteLength > MAX_FOLLOWUP_TASK_QUARANTINE_BYTES) {
    const closed = await fromPromise(handle.close());
    return closed.ok
      ? err(quarantineError("validation", "Follow-up task quarantine exceeds its byte ceiling"))
      : err(quarantineError("internal", "Unable to close follow-up task quarantine"));
  }
  const closed = await fromPromise(handle.close());
  return closed.ok
    ? ok(read.value)
    : err(quarantineError("internal", "Unable to close follow-up task quarantine"));
}

async function appendPrivateFile(
  filePath: string,
  bytes: Buffer,
): Promise<Result<void, FollowupTaskStoreError>> {
  const directory = path.dirname(filePath);
  const made = await fromPromise(fs.mkdir(directory, { recursive: true, mode: 0o700 }));
  if (!made.ok) return err(quarantineError("internal", "Unable to create follow-up task quarantine directory"));
  const securedDirectory = await fromPromise(fs.chmod(directory, 0o700));
  if (!securedDirectory.ok) return err(quarantineError("internal", "Unable to secure follow-up task quarantine directory"));
  const existing = await fromPromise(fs.lstat(filePath));
  if (existing.ok && (!existing.value.isFile() || existing.value.isSymbolicLink())) {
    return err(quarantineError("validation", "Follow-up task quarantine path is not a regular file"));
  }
  if (!existing.ok && !isNodeError(existing.error, "ENOENT")) {
    return err(quarantineError("internal", "Unable to inspect follow-up task quarantine"));
  }
  const currentBytes = existing.ok ? existing.value.size : 0;
  if (
    !Number.isSafeInteger(currentBytes + bytes.byteLength)
    || currentBytes + bytes.byteLength > MAX_FOLLOWUP_TASK_QUARANTINE_BYTES
  ) return err(quarantineError("resource", "Follow-up task quarantine capacity reached"));

  const noFollow = "O_NOFOLLOW" in fsConstants
    ? (fsConstants as typeof fsConstants & { O_NOFOLLOW: number }).O_NOFOLLOW
    : 0;
  const opened = await fromPromise(fs.open(
    filePath,
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | noFollow,
    0o600,
  ));
  if (!opened.ok) return err(quarantineError("internal", "Unable to open follow-up task quarantine"));
  const handle = opened.value;
  const status = await fromPromise(handle.stat());
  if (!status.ok || !status.value.isFile()) return closeWithError(handle, "Follow-up task quarantine is not regular");
  const secured = await fromPromise(handle.chmod(0o600));
  if (!secured.ok) return closeWithError(handle, "Unable to secure follow-up task quarantine");
  const wrote = await fromPromise(handle.writeFile(bytes));
  if (!wrote.ok) return closeWithError(handle, "Unable to append follow-up task quarantine");
  const synced = await fromPromise(handle.sync());
  if (!synced.ok) return closeWithError(handle, "Unable to flush follow-up task quarantine");
  const closed = await fromPromise(handle.close());
  if (!closed.ok) return err(quarantineError("internal", "Unable to close follow-up task quarantine"));
  const directoryHandle = await fromPromise(fs.open(directory, "r"));
  if (!directoryHandle.ok) return err(quarantineError("internal", "Unable to open task quarantine directory"));
  const directorySynced = await fromPromise(directoryHandle.value.sync());
  const directoryClosed = await fromPromise(directoryHandle.value.close());
  return directorySynced.ok && directoryClosed.ok
    ? ok(undefined)
    : err(quarantineError("internal", "Unable to flush task quarantine directory"));
}

async function closeWithError<T>(
  handle: fs.FileHandle,
  message: string,
): Promise<Result<T, FollowupTaskStoreError>> {
  await fromPromise(handle.close());
  return err(quarantineError("internal", message));
}

function hashRecord(record: unknown): string {
  return createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex");
}

function quarantineEntryId(kind: QuarantineRecordKind, id: string, recordHash: string): string {
  return createHash("sha256").update(`${kind}\0${id}\0${recordHash}`, "utf8").digest("hex");
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function unsafeGroup(): Result<never, FollowupTaskStoreError> {
  return err(quarantineError("validation", "Malformed task authority is not an isolated terminal group"));
}

function quarantineError(
  errorKind: "validation" | "internal" | "resource",
  message: string,
): FollowupTaskStoreError {
  return {
    code: errorKind === "resource" ? "store_full" : errorKind === "internal" ? "io" : "invalid_state",
    errorKind,
    message,
  };
}

function isNodeError(error: Error, code: string): boolean {
  return "code" in error && (error as NodeJS.ErrnoException).code === code;
}
