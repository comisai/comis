// SPDX-License-Identifier: Apache-2.0
/** Atomic JSONL storage for the announcement dead-letter queue. */

import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { toSafeErrorLogString } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

interface StorageLogger {
  warn(obj: Record<string, unknown>, message: string): void;
  error?(obj: Record<string, unknown>, message: string): void;
}

export class MalformedDeadLetterFileError extends Error {
  override readonly name = "MalformedDeadLetterFileError";
}

export type ChannelType =
  | "discord"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "imessage"
  | "signal"
  | "irc"
  | "line"
  | "email"
  | "msteams"
  | "echo";

export function isAnnouncementChannelType(value: string): value is ChannelType {
  switch (value) {
    case "discord":
    case "telegram":
    case "slack":
    case "whatsapp":
    case "imessage":
    case "signal":
    case "irc":
    case "line":
    case "email":
    case "msteams":
    case "echo":
      return true;
    default:
      return false;
  }
}

export interface DeadLetterEntry {
  id: string;
  announcementText: string;
  channelType: ChannelType;
  channelId: string;
  agentId?: string;
  runId: string;
  failedAt: number;
  attemptCount: number;
  lastAttemptAt: number;
  lastError?: string;
  threadId?: string;
  extra?: Record<string, unknown>;
  idempotencyKey?: string;
  rootRunId?: string;
  stepIndex?: number;
}

export interface ParentDecisionReservation {
  idempotencyKey: string;
  agentId: string;
  runId: string;
  announcementText: string;
  channelType: ChannelType;
  channelId: string;
  failedAt: number;
  threadId?: string;
}

export interface ParentDecisionReservationRecord extends ParentDecisionReservation {
  recordType: "parent_decision_reservation";
  id: string;
}

export type StoredDeadLetterEntry = DeadLetterEntry | ParentDecisionReservationRecord;

interface ParentDecisionReservationStoreDeps {
  load(): Promise<Result<void, Error>>;
  hasDeliveryKey(idempotencyKey: string): boolean;
  getReservations(): readonly ParentDecisionReservationRecord[];
  persist(
    reservations: readonly ParentDecisionReservationRecord[],
  ): Promise<Result<void, Error>>;
  replaceReservations(reservations: readonly ParentDecisionReservationRecord[]): void;
  logger?: StorageLogger;
}

function publicDecision(
  record: ParentDecisionReservationRecord,
): ParentDecisionReservation {
  return {
    idempotencyKey: record.idempotencyKey,
    agentId: record.agentId,
    runId: record.runId,
    announcementText: record.announcementText,
    channelType: record.channelType,
    channelId: record.channelId,
    failedAt: record.failedAt,
    ...(record.threadId !== undefined ? { threadId: record.threadId } : {}),
  };
}

function sameDecision(
  left: ParentDecisionReservationRecord,
  right: ParentDecisionReservation,
): boolean {
  return left.idempotencyKey === right.idempotencyKey
    && left.agentId === right.agentId
    && left.runId === right.runId
    && left.announcementText === right.announcementText
    && left.channelType === right.channelType
    && left.channelId === right.channelId
    && left.threadId === right.threadId;
}

function validDecision(entry: ParentDecisionReservation): boolean {
  return typeof entry.idempotencyKey === "string"
    && entry.idempotencyKey.length > 0
    && typeof entry.agentId === "string"
    && entry.agentId.length > 0
    && typeof entry.runId === "string"
    && entry.runId.length > 0
    && typeof entry.announcementText === "string"
    && typeof entry.channelType === "string"
    && isAnnouncementChannelType(entry.channelType)
    && typeof entry.channelId === "string"
    && entry.channelId.length > 0
    && typeof entry.failedAt === "number"
    && Number.isFinite(entry.failedAt)
    && (entry.threadId === undefined || typeof entry.threadId === "string");
}

export function createParentDecisionReservationStore(
  deps: ParentDecisionReservationStoreDeps,
): {
  reserve(
    entry: ParentDecisionReservation,
  ): Promise<Result<{ created: boolean }, Error>>;
  lookup(
    idempotencyKey: string,
  ): Promise<Result<ParentDecisionReservation | undefined, Error>>;
  resolve(
    idempotencyKey: string,
    outcome: "receipt_committed" | "no_reply",
  ): Promise<Result<boolean, Error>>;
} {
  async function reserve(
    entry: ParentDecisionReservation,
  ): Promise<Result<{ created: boolean }, Error>> {
    const load = await deps.load();
    if (!load.ok) return load;
    if (!validDecision(entry)) {
      return err(new Error("Parent decision reservation is invalid"));
    }
    if (deps.hasDeliveryKey(entry.idempotencyKey)) return ok({ created: false });
    const existing = deps.getReservations().find(
      (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
    );
    if (existing) {
      if (sameDecision(existing, entry)) return ok({ created: false });
      deps.logger?.error?.(
        {
          errorKind: "validation" as const,
          hint: "reuse a parent decision key only with its exact original owner, destination, and content",
        },
        "Parent decision reservation identity mismatch",
      );
      return err(new Error("Parent decision reservation identity mismatch"));
    }
    const id = tryCatch(() => randomUUID());
    if (!id.ok) return id;
    const next = [
      ...deps.getReservations(),
      { ...entry, recordType: "parent_decision_reservation" as const, id: id.value },
    ];
    const persisted = await deps.persist(next);
    if (!persisted.ok) {
      deps.logger?.error?.(
        {
          err: toSafeErrorLogString(persisted.error),
          errorKind: "resource" as const,
          hint: "restore dead-letter storage before executing the reserved parent decision",
        },
        "Parent decision reservation was not durably persisted",
      );
      return persisted;
    }
    deps.replaceReservations(next);
    return ok({ created: true });
  }

  async function lookup(
    idempotencyKey: string,
  ): Promise<Result<ParentDecisionReservation | undefined, Error>> {
    const load = await deps.load();
    if (!load.ok) return load;
    const record = deps.getReservations().find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    return ok(record ? publicDecision(record) : undefined);
  }

  async function resolve(
    idempotencyKey: string,
    outcome: "receipt_committed" | "no_reply",
  ): Promise<Result<boolean, Error>> {
    const load = await deps.load();
    if (!load.ok) return load;
    switch (outcome) {
      case "receipt_committed":
      case "no_reply":
        break;
      default: {
        const _exhaustive: never = outcome;
        void _exhaustive;
        return err(new Error("Parent decision resolution outcome is invalid"));
      }
    }
    const next = deps.getReservations().filter(
      (candidate) => candidate.idempotencyKey !== idempotencyKey,
    );
    if (next.length === deps.getReservations().length) return ok(false);
    const persisted = await deps.persist(next);
    if (!persisted.ok) {
      deps.logger?.error?.(
        {
          errorKind: "resource" as const,
          hint: "restore dead-letter storage before acknowledging the parent decision resolution",
        },
        "Parent decision resolution was not durably persisted",
      );
      return persisted;
    }
    deps.replaceReservations(next);
    return ok(true);
  }

  return { reserve, lookup, resolve };
}

interface DeadLetterFileHandle {
  chmod(mode: number): Promise<void>;
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DeadLetterWriteOperations {
  open(path: string, flags: string, mode?: number): Promise<DeadLetterFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

export interface DeadLetterWriteFailure {
  state: "snapshot_unchanged" | "snapshot_visible";
  error: Error;
}

const systemWriteOperations: DeadLetterWriteOperations = {
  open,
  rename,
  unlink,
  chmod,
};

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isParentDecisionReservationRecord(
  value: unknown,
): value is ParentDecisionReservationRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.recordType === "parent_decision_reservation"
    && typeof record.id === "string"
    && typeof record.idempotencyKey === "string"
    && record.idempotencyKey.length > 0
    && typeof record.agentId === "string"
    && record.agentId.length > 0
    && typeof record.runId === "string"
    && typeof record.announcementText === "string"
    && typeof record.channelType === "string"
    && isAnnouncementChannelType(record.channelType)
    && typeof record.channelId === "string"
    && typeof record.failedAt === "number"
    && Number.isFinite(record.failedAt)
    && isOptionalString(record.threadId);
}

function isDeadLetterEntry(
  value: unknown,
): value is DeadLetterEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.recordType === undefined
    && typeof record.id === "string"
    && typeof record.announcementText === "string"
    && typeof record.channelType === "string"
    && isAnnouncementChannelType(record.channelType)
    && typeof record.channelId === "string"
    && typeof record.runId === "string"
    && typeof record.failedAt === "number"
    && Number.isFinite(record.failedAt)
    && typeof record.attemptCount === "number"
    && Number.isSafeInteger(record.attemptCount)
    && record.attemptCount >= 0
    && typeof record.lastAttemptAt === "number"
    && Number.isFinite(record.lastAttemptAt)
    && isOptionalString(record.agentId)
    && isOptionalString(record.lastError)
    && isOptionalString(record.threadId)
    && isOptionalString(record.idempotencyKey)
    && isOptionalString(record.rootRunId)
    && (
      record.stepIndex === undefined
      || (typeof record.stepIndex === "number" && Number.isSafeInteger(record.stepIndex) && record.stepIndex >= 0)
    )
    && (
      record.extra === undefined
      || (typeof record.extra === "object" && record.extra !== null && !Array.isArray(record.extra))
    );
}

export function isParentDecisionReservation(
  value: StoredDeadLetterEntry,
): value is ParentDecisionReservationRecord {
  return "recordType" in value
    && value.recordType === "parent_decision_reservation";
}

function parseEntries(
  content: string,
  logger?: StorageLogger,
): Result<StoredDeadLetterEntry[], Error> {
  const entries: StoredDeadLetterEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = tryCatch(() => JSON.parse(trimmed) as unknown);
    const value = parsed.ok ? parsed.value : undefined;
    if (parsed.ok && isDeadLetterEntry(value)) {
      entries.push(value);
      continue;
    }
    if (parsed.ok && isParentDecisionReservationRecord(value)) {
      entries.push(value);
      continue;
    }
    logger?.warn(
      {
        errorKind: "precondition" as const,
        hint: "repair or quarantine the malformed dead-letter file before accepting or draining announcements",
      },
      "Malformed dead-letter file blocked",
    );
    return err(new MalformedDeadLetterFileError("Malformed dead-letter JSONL row"));
  }
  return ok(entries);
}

function writeFailure(
  error: Error,
  state: DeadLetterWriteFailure["state"],
): Result<never, DeadLetterWriteFailure> {
  return err({ state, error });
}

async function closeAfter(
  handle: DeadLetterFileHandle,
  operation: Result<void, Error>,
): Promise<Result<void, Error>> {
  const closed = await fromPromise(handle.close());
  return operation.ok ? closed : operation;
}

async function syncPath(
  path: string,
  operations: DeadLetterWriteOperations,
): Promise<Result<void, Error>> {
  const opened = await fromPromise(operations.open(path, "r"));
  if (!opened.ok) return opened;
  const synced = await fromPromise(opened.value.sync());
  return closeAfter(opened.value, synced);
}

async function removeTemporary(
  temporaryPath: string,
  operations: DeadLetterWriteOperations,
): Promise<void> {
  await fromPromise(operations.unlink(temporaryPath));
}

async function atomicWrite(
  filePath: string,
  content: string,
  operations: DeadLetterWriteOperations,
): Promise<Result<void, DeadLetterWriteFailure>> {
  const nonce = tryCatch(() => randomBytes(4).toString("hex"));
  if (!nonce.ok) return writeFailure(nonce.error, "snapshot_unchanged");
  const temporaryPath = `${filePath}.tmp.${nonce.value}`;
  const opened = await fromPromise(operations.open(temporaryPath, "wx", 0o600));
  if (!opened.ok) return writeFailure(opened.error, "snapshot_unchanged");

  const written = await fromPromise(opened.value.writeFile(content, "utf8"));
  if (!written.ok) {
    await closeAfter(opened.value, written);
    await removeTemporary(temporaryPath, operations);
    return writeFailure(written.error, "snapshot_unchanged");
  }
  const synced = await fromPromise(opened.value.sync());
  const closed = await closeAfter(opened.value, synced);
  if (!closed.ok) {
    await removeTemporary(temporaryPath, operations);
    return writeFailure(closed.error, "snapshot_unchanged");
  }

  const renamed = await fromPromise(operations.rename(temporaryPath, filePath));
  if (!renamed.ok) {
    await removeTemporary(temporaryPath, operations);
    return writeFailure(renamed.error, "snapshot_unchanged");
  }
  const finalMode = await fromPromise(operations.chmod(filePath, 0o600));
  if (!finalMode.ok) return writeFailure(finalMode.error, "snapshot_visible");
  const fileSynced = await syncPath(filePath, operations);
  if (!fileSynced.ok) return writeFailure(fileSynced.error, "snapshot_visible");
  const directorySynced = await syncPath(dirname(filePath), operations);
  return directorySynced.ok
    ? directorySynced
    : writeFailure(directorySynced.error, "snapshot_visible");
}

export async function readDeadLetterEntries(
  filePath: string,
  logger?: StorageLogger,
): Promise<Result<StoredDeadLetterEntry[], Error>> {
  const read = await fromPromise(readFile(filePath, "utf-8"));
  if (read.ok) return parseEntries(read.value, logger);
  if ("code" in read.error && (read.error as NodeJS.ErrnoException).code === "ENOENT") {
    return ok([]);
  }
  return err(read.error);
}

export async function writeDeadLetterEntries(
  filePath: string,
  entries: readonly unknown[],
  operations: DeadLetterWriteOperations = systemWriteOperations,
): Promise<Result<void, DeadLetterWriteFailure>> {
  if (entries.length === 0) {
    const removed = await fromPromise(operations.unlink(filePath));
    if (removed.ok) {
      const directorySynced = await syncPath(dirname(filePath), operations);
      return directorySynced.ok
        ? directorySynced
        : writeFailure(directorySynced.error, "snapshot_visible");
    }
    if ("code" in removed.error && (removed.error as NodeJS.ErrnoException).code === "ENOENT") {
      return ok(undefined);
    }
    return writeFailure(removed.error, "snapshot_unchanged");
  }
  const serialized = tryCatch(
    () => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  if (!serialized.ok) return writeFailure(serialized.error, "snapshot_unchanged");
  return atomicWrite(filePath, serialized.value, operations);
}
