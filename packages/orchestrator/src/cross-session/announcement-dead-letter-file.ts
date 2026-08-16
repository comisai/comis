// SPDX-License-Identifier: Apache-2.0
/** Atomic JSONL storage for the announcement dead-letter queue. */

import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  ChannelEndpointSchema,
  ConversationRefSchema,
  toSafeErrorLogString,
  type AnnouncementChannelType,
  type AnnouncementDeadLetterAttachmentSnapshot,
  type AnnouncementDeadLetterEntry,
  type AnnouncementParentDecisionReservation,
  type AnnouncementParentDecisionReservationRecord,
  type ChannelEndpoint,
  type DeliveryAuthority,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import {
  createInvalidDeadLetterRecord,
  isInvalidDeadLetterRecord,
  MAX_DEAD_LETTER_ROW_BYTES,
  type InvalidDeadLetterRecord,
} from "./announcement-dead-letter-invalid.js";
import { createAnnouncementOperationDigests } from "./announcement-outward-operation.js";

interface StorageLogger {
  warn(obj: Record<string, unknown>, message: string): void;
  error?(obj: Record<string, unknown>, message: string): void;
}

export type ChannelType = AnnouncementChannelType;

export function isAnnouncementChannelType(value: string): value is ChannelType {
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(value);
}

export type DeadLetterEntry = AnnouncementDeadLetterEntry;
export type ParentDecisionReservation = AnnouncementParentDecisionReservation;
export type ParentDecisionReservationRecord = AnnouncementParentDecisionReservationRecord;

function isDeliveryAuthority(value: unknown): value is DeliveryAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3
    && typeof record.tenantId === "string"
    && record.tenantId.length > 0
    && typeof record.agentId === "string"
    && record.agentId.length > 0
    && ConversationRefSchema.safeParse(record.conversationRef).success;
}

function isRecoveryRoute(
  record: Record<string, unknown>,
): record is Record<string, unknown> & {
  agentId: string;
  deliveryAuthority: DeliveryAuthority;
  destinationEndpoint: ChannelEndpoint;
} {
  if (
    typeof record.agentId !== "string"
    || !isDeliveryAuthority(record.deliveryAuthority)
  ) return false;
  const parsedEndpoint = ChannelEndpointSchema.safeParse(record.destinationEndpoint);
  if (!parsedEndpoint.success) return false;
  const endpoint = parsedEndpoint.data;
  return record.deliveryAuthority.agentId === record.agentId
    && endpoint.channelType === record.channelType
    && endpoint.conversationId === record.channelId
    && endpoint.threadId === record.threadId;
}

function sameDeliveryAuthority(
  left: DeliveryAuthority,
  right: DeliveryAuthority,
): boolean {
  return left.tenantId === right.tenantId
    && left.agentId === right.agentId
    && left.conversationRef === right.conversationRef;
}

function sameChannelEndpoint(
  left: ChannelEndpoint,
  right: ChannelEndpoint,
): boolean {
  return left.channelType === right.channelType
    && left.channelInstanceId === right.channelInstanceId
    && left.conversationId === right.conversationId
    && left.threadId === right.threadId
    && left.conversationKind === right.conversationKind;
}

export function isDeadLetterAttachmentSnapshot(
  value: unknown,
): value is AnnouncementDeadLetterAttachmentSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 8
    && record.kind === "snapshot"
    && typeof record.sourceAgentId === "string"
    && record.sourceAgentId.length > 0
    && typeof record.sourcePath === "string"
    && record.sourcePath.length > 0
    && typeof record.path === "string"
    && record.path.length > 0
    && typeof record.fileName === "string"
    && record.fileName.length > 0
    && typeof record.mimeType === "string"
    && record.mimeType.length > 0
    && typeof record.contentDigest === "string"
    && /^[a-f0-9]{64}$/u.test(record.contentDigest)
    && typeof record.sizeBytes === "number"
    && Number.isSafeInteger(record.sizeBytes)
    && record.sizeBytes >= 0;
}

function isCompletionKeys(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((key) => typeof key === "string" && key.length > 0)
    && new Set(value).size === value.length;
}

export type StoredDeadLetterEntry =
  | DeadLetterEntry
  | ParentDecisionReservationRecord
  | InvalidDeadLetterRecord;

export interface DeadLetterReadSnapshot {
  readonly entries: StoredDeadLetterEntry[];
  readonly invalidRowCount: number;
}

interface ParentDecisionReservationStoreDeps {
  load(): Promise<Result<void, Error>>;
  hasDeliveryKey(idempotencyKey: string): boolean;
  getReservations(): readonly ParentDecisionReservationRecord[];
  persist(
    reservations: readonly ParentDecisionReservationRecord[],
  ): Promise<Result<void, Error>>;
  canPersistReservationCount(count: number): boolean;
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
    sessionKey: record.sessionKey,
    announcementText: record.announcementText,
    channelType: record.channelType,
    channelId: record.channelId,
    failedAt: record.failedAt,
    ...(record.threadId !== undefined ? { threadId: record.threadId } : {}),
    ...(record.extra !== undefined ? { extra: record.extra } : {}),
    rootRunId: record.rootRunId,
    deliveryAuthority: record.deliveryAuthority,
    destinationEndpoint: record.destinationEndpoint,
    ...(record.attachment !== undefined ? { attachment: record.attachment } : {}),
    ...(record.partId !== undefined ? { partId: record.partId } : {}),
    completionKeys: record.completionKeys,
  };
}

function decisionFingerprint(
  entry: Pick<ParentDecisionReservation, "channelType" | "channelId" | "announcementText" | "threadId" | "extra">,
): string | undefined {
  const digests = createAnnouncementOperationDigests({
    channelType: entry.channelType,
    channelId: entry.channelId,
    text: entry.announcementText,
    ...(entry.threadId || entry.extra ? {
      options: {
        ...(entry.threadId ? { threadId: entry.threadId } : {}),
        ...(entry.extra ? { extra: entry.extra } : {}),
      },
    } : {}),
  });
  return digests.ok ? digests.value.operationFingerprint : undefined;
}

function sameDecision(
  left: ParentDecisionReservationRecord,
  right: ParentDecisionReservation,
): boolean {
  return left.idempotencyKey === right.idempotencyKey
    && left.agentId === right.agentId
    && left.runId === right.runId
    && left.sessionKey === right.sessionKey
    && left.announcementText === right.announcementText
    && left.channelType === right.channelType
    && left.channelId === right.channelId
    && left.threadId === right.threadId
    && left.rootRunId === right.rootRunId
    && left.partId === right.partId
    && JSON.stringify(left.attachment) === JSON.stringify(right.attachment)
    && decisionFingerprint(left) !== undefined
    && decisionFingerprint(left) === decisionFingerprint(right)
    && left.completionKeys.length === right.completionKeys.length
    && left.completionKeys.every((key, index) => key === right.completionKeys[index])
    && sameDeliveryAuthority(left.deliveryAuthority, right.deliveryAuthority)
    && sameChannelEndpoint(left.destinationEndpoint, right.destinationEndpoint);
}

function validDecision(entry: ParentDecisionReservation): boolean {
  return decisionFingerprint(entry) !== undefined
    && typeof entry.idempotencyKey === "string"
    && entry.idempotencyKey.length > 0
    && typeof entry.agentId === "string"
    && entry.agentId.length > 0
    && typeof entry.runId === "string"
    && entry.runId.length > 0
    && typeof entry.sessionKey === "string"
    && entry.sessionKey.length > 0
    && typeof entry.announcementText === "string"
    && typeof entry.channelType === "string"
    && isAnnouncementChannelType(entry.channelType)
    && typeof entry.channelId === "string"
    && entry.channelId.length > 0
    && typeof entry.failedAt === "number"
    && Number.isFinite(entry.failedAt)
    && (entry.threadId === undefined || typeof entry.threadId === "string")
    && typeof entry.rootRunId === "string"
    && entry.rootRunId.length > 0
    && (entry.partId === undefined || (typeof entry.partId === "string" && entry.partId.length > 0))
    && (entry.attachment === undefined || isDeadLetterAttachmentSnapshot(entry.attachment))
    && isCompletionKeys(entry.completionKeys)
    && isRecoveryRoute(entry as unknown as Record<string, unknown>);
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
  replace(
    expectedKeys: readonly string[],
    operations: readonly ParentDecisionReservation[],
    settledCompletionKeys?: readonly string[],
  ): Promise<Result<{ created: boolean }, Error>>;
} {
  async function reserve(
    entry: ParentDecisionReservation,
  ): Promise<Result<{ created: boolean }, Error>> {
    const load = await deps.load();
    if (!load.ok) return load;
    if (!validDecision(entry)) {
      return err(new Error("Parent decision reservation is invalid"));
    }
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
    if (deps.hasDeliveryKey(entry.idempotencyKey)) return ok({ created: false });
    if (deps.getReservations().some(
      (candidate) => candidate.completionKeys.includes(entry.idempotencyKey),
    )) return ok({ created: false });
    const id = tryCatch(() => randomUUID());
    if (!id.ok) return id;
    const next = [
      ...deps.getReservations(),
      { ...entry, recordType: "parent_decision_reservation" as const, id: id.value },
    ];
    if (!deps.canPersistReservationCount(next.length)) {
      return err(new Error("Dead-letter quarantine capacity exhausted"));
    }
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

  async function replace(
    expectedKeys: readonly string[],
    operations: readonly ParentDecisionReservation[],
    settledCompletionKeys: readonly string[] = [],
  ): Promise<Result<{ created: boolean }, Error>> {
    const load = await deps.load();
    if (!load.ok) return load;
    if (
      new Set(expectedKeys).size !== expectedKeys.length
      || expectedKeys.some((key) => typeof key !== "string" || key.length === 0)
      || new Set(settledCompletionKeys).size !== settledCompletionKeys.length
      || settledCompletionKeys.some((key) => typeof key !== "string" || key.length === 0)
      || operations.length + settledCompletionKeys.length === 0
      || operations.some((operation) => !validDecision(operation))
      || new Set(operations.map((operation) => operation.idempotencyKey)).size
        !== operations.length
    ) {
      return err(new Error("Announcement operation reservation transition is invalid"));
    }

    const current = deps.getReservations();
    const expected = new Set(expectedKeys);
    const completionKeys = new Set([
      ...operations.flatMap((operation) => operation.completionKeys),
      ...settledCompletionKeys,
    ]);
    const expectedReservations = current.filter((reservation) =>
      expected.has(reservation.idempotencyKey));
    const alreadyTransitioned = current.some((reservation) =>
      reservation.completionKeys.some((key) => completionKeys.has(key))
      && !expected.has(reservation.idempotencyKey));
    if (alreadyTransitioned || [...completionKeys].some(deps.hasDeliveryKey)) {
      return ok({ created: false });
    }
    if (expectedReservations.length !== expectedKeys.length) {
      return err(new Error("Announcement decision reservation transition lost its expected owner"));
    }
    if (expectedKeys.length > 0) {
      const expectedCompletionKeys = new Set(
        expectedReservations.flatMap((reservation) => reservation.completionKeys),
      );
      if (
        completionKeys.size !== expectedCompletionKeys.size
        || [...expectedCompletionKeys].some((key) => !completionKeys.has(key))
      ) {
        return err(new Error("Announcement operation reservations do not preserve their owners"));
      }
    }

    const retained = current.filter((reservation) => !expected.has(reservation.idempotencyKey));
    if (!deps.canPersistReservationCount(retained.length + operations.length)) {
      return err(new Error("Dead-letter quarantine capacity exhausted"));
    }
    const records: ParentDecisionReservationRecord[] = [];
    for (const operation of operations) {
      const id = tryCatch(() => randomUUID());
      if (!id.ok) return id;
      records.push({
        ...operation,
        recordType: "parent_decision_reservation",
        id: id.value,
      });
    }
    const next = [...retained, ...records];
    const persisted = await deps.persist(next);
    if (!persisted.ok) return persisted;
    deps.replaceReservations(next);
    return ok({ created: operations.length > 0 });
  }

  return { reserve, lookup, resolve, replace };
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
    && typeof record.sessionKey === "string"
    && record.sessionKey.length > 0
    && typeof record.announcementText === "string"
    && typeof record.channelType === "string"
    && isAnnouncementChannelType(record.channelType)
    && typeof record.channelId === "string"
    && typeof record.failedAt === "number"
    && Number.isFinite(record.failedAt)
    && isOptionalString(record.threadId)
    && (
      record.extra === undefined
      || (typeof record.extra === "object" && record.extra !== null && !Array.isArray(record.extra))
    )
    && typeof record.rootRunId === "string"
    && record.rootRunId.length > 0
    && isCompletionKeys(record.completionKeys)
    && isOptionalString(record.partId)
    && (record.attachment === undefined || isDeadLetterAttachmentSnapshot(record.attachment))
    && isRecoveryRoute(record);
}

function isDeadLetterEntry(
  value: unknown,
): value is DeadLetterEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const carriesGovernedIdentity = record.rootRunId !== undefined
    || record.stepIndex !== undefined;
  const carriesRecoveryRoute = record.deliveryAuthority !== undefined
    || record.destinationEndpoint !== undefined;
  return record.recordType === undefined
    && typeof record.id === "string"
    && typeof record.announcementText === "string"
    && typeof record.channelType === "string"
    && isAnnouncementChannelType(record.channelType)
    && typeof record.channelId === "string"
    && typeof record.runId === "string"
    && typeof record.sessionKey === "string"
    && record.sessionKey.length > 0
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
    && isOptionalString(record.partId)
    && (record.attachment === undefined || isDeadLetterAttachmentSnapshot(record.attachment))
    && (record.completionKeys === undefined || isCompletionKeys(record.completionKeys))
    && (
      record.stepIndex === undefined
      || (typeof record.stepIndex === "number" && Number.isSafeInteger(record.stepIndex) && record.stepIndex >= 0)
    )
    && (
      record.extra === undefined
      || (typeof record.extra === "object" && record.extra !== null && !Array.isArray(record.extra))
    )
    && (!carriesGovernedIdentity || carriesRecoveryRoute)
    && (!carriesRecoveryRoute || isRecoveryRoute(record));
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
): Result<DeadLetterReadSnapshot, Error> {
  const entries: StoredDeadLetterEntry[] = [];
  let invalidRowCount = 0;
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (Buffer.byteLength(trimmed, "utf8") > MAX_DEAD_LETTER_ROW_BYTES) {
      const invalid = createInvalidDeadLetterRecord(trimmed, index + 1, false);
      if (!invalid.ok) return invalid;
      entries.push(invalid.value);
      invalidRowCount++;
      continue;
    }
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
    if (parsed.ok && isInvalidDeadLetterRecord(value)) {
      entries.push(value);
      continue;
    }
    const invalid = createInvalidDeadLetterRecord(trimmed, index + 1, parsed.ok);
    if (!invalid.ok) return invalid;
    entries.push(invalid.value);
    invalidRowCount++;
  }
  if (invalidRowCount > 0) {
    logger?.warn(
      {
        invalidRowCount,
        errorKind: "precondition" as const,
        hint: "review and explicitly release invalid dead-letter records; valid announcements remain available",
      },
      "Invalid dead-letter rows quarantined",
    );
  }
  return ok({ entries, invalidRowCount });
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
  const snapshot = await readDeadLetterSnapshot(filePath, logger);
  return snapshot.ok ? ok(snapshot.value.entries) : snapshot;
}

export async function readDeadLetterSnapshot(
  filePath: string,
  logger?: StorageLogger,
): Promise<Result<DeadLetterReadSnapshot, Error>> {
  const read = await fromPromise(readFile(filePath, "utf-8"));
  if (read.ok) return parseEntries(read.value, logger);
  if ("code" in read.error && (read.error as NodeJS.ErrnoException).code === "ENOENT") {
    return ok({ entries: [], invalidRowCount: 0 });
  }
  return err(read.error);
}

export async function writeDeadLetterEntries(
  filePath: string,
  entries: readonly StoredDeadLetterEntry[],
  operations: DeadLetterWriteOperations = systemWriteOperations,
): Promise<Result<void, DeadLetterWriteFailure>> {
  if (entries.some((entry) =>
    !isDeadLetterEntry(entry)
    && !isParentDecisionReservationRecord(entry)
    && !isInvalidDeadLetterRecord(entry))) {
    return writeFailure(
      new Error("Dead-letter snapshot contains an invalid record"),
      "snapshot_unchanged",
    );
  }
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
  const serializedRows = tryCatch(() => entries.map((entry) => JSON.stringify(entry)));
  if (!serializedRows.ok) {
    return writeFailure(serializedRows.error, "snapshot_unchanged");
  }
  if (serializedRows.value.some(
    (row) => Buffer.byteLength(row, "utf8") > MAX_DEAD_LETTER_ROW_BYTES,
  )) {
    return writeFailure(
      new Error("Dead-letter snapshot contains an oversized record"),
      "snapshot_unchanged",
    );
  }
  const serialized = `${serializedRows.value.join("\n")}\n`;
  return atomicWrite(filePath, serialized, operations);
}
