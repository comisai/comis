// SPDX-License-Identifier: Apache-2.0
/**
 * Dead-letter record shapes and their validators.
 *
 * Everything persisted to the dead-letter JSONL is re-validated on the way
 * back in. The file is the trust boundary: rows survive restarts, can be
 * hand-edited, and can drift across versions, so a stored row is treated as
 * untrusted input and each shape carries the predicate that admits it.
 *
 * The `same*` comparators decide when a stored record still describes the
 * operation a caller is claiming, which is what keeps recovery from replaying
 * a row against a different destination or authority than it was written for.
 *
 * @module
 */
import { createHash } from "node:crypto";
import {
  ChannelEndpointSchema,
  ConversationRefSchema,
  SUBAGENT_RESULT_SUMMARY_MAX_CHARS,
  type AnnouncementChannelType,
  type AnnouncementDeadLetterAttachmentSnapshot,
  type AnnouncementDeadLetterEntry,
  type AnnouncementParentDecisionReservation,
  type AnnouncementParentDecisionReservationRecord,
  type AnnouncementProducerReservation,
  type AnnouncementProducerRecoveryOutcome,
  type AnnouncementProducerReservationRecord,
  ERROR_KINDS,
  type AnnouncementRetirementProducer,
  type ChannelEndpoint,
  type DeliveryAuthority,
  type ResultRef,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import {
  MAX_DEAD_LETTER_ROW_BYTES,
  type InvalidDeadLetterRecord,
} from "./announcement-dead-letter-invalid.js";
import { createAnnouncementOperationDigests } from "./announcement-outward-operation.js";

export interface StorageLogger {
  warn(obj: Record<string, unknown>, message: string): void;
  error?(obj: Record<string, unknown>, message: string): void;
}

export const MAX_DEAD_LETTER_SNAPSHOT_ROWS = 200;
export const MAX_DEAD_LETTER_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const DEAD_LETTER_READ_BUFFER_BYTES = 64 * 1024;
export const INVALID_ROW_EVIDENCE_BYTES = 16 * 1024;
export const ERROR_KIND_SET = new Set<string>(ERROR_KINDS);
export const ANNOUNCEMENT_TOOL_RESULT_RESPONSE_MAX_CHARS = 100_000;
export const RESULT_REF_KIND_SET = new Set(["jsonl", "json", "csv", "html", "text", "binary"]);

export interface DeadLetterReadLimits { readonly maxRows?: number; readonly maxBytes?: number }

export type ChannelType = AnnouncementChannelType;

export function isAnnouncementChannelType(value: string): value is ChannelType {
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(value);
}

export type DeadLetterEntry = AnnouncementDeadLetterEntry;
export type ParentDecisionReservation = AnnouncementParentDecisionReservation;
export type ParentDecisionReservationRecord = AnnouncementParentDecisionReservationRecord;
export type ProducerReservationRecord = AnnouncementProducerReservationRecord;

export interface AnnouncementProducerHandoffRecord {
  readonly recordType: "producer_handoff";
  readonly id: string;
  readonly transitionId: string;
  readonly expectedKeys: readonly string[];
  readonly operationCount: number;
  readonly groupDigest: string;
  readonly operations: readonly AnnouncementParentDecisionReservation[];
}

export function announcementProducerHandoffDigest(
  expectedKeys: readonly string[],
  operations: readonly AnnouncementParentDecisionReservation[],
): Result<string, Error> {
  return tryCatch(() => createHash("sha256")
    .update(JSON.stringify({ expectedKeys, operations }), "utf8")
    .digest("hex"));
}

export function isDeliveryAuthority(value: unknown): value is DeliveryAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3
    && typeof record.tenantId === "string"
    && record.tenantId.length > 0
    && typeof record.agentId === "string"
    && record.agentId.length > 0
    && ConversationRefSchema.safeParse(record.conversationRef).success;
}

export function isRecoveryRoute(
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

export function sameDeliveryAuthority(
  left: DeliveryAuthority,
  right: DeliveryAuthority,
): boolean {
  return left.tenantId === right.tenantId
    && left.agentId === right.agentId
    && left.conversationRef === right.conversationRef;
}

export function sameChannelEndpoint(
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

export function isCompletionKeys(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((key) => typeof key === "string" && key.length > 0)
    && new Set(value).size === value.length;
}

export function isAnnouncementTextChunks(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((chunk) => typeof chunk === "string" && chunk.length > 0);
}

export function isAnnouncementProducerRecoveryOutcome(
  value: unknown,
): value is AnnouncementProducerRecoveryOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "session") {
    const resultRef = record.resultRef;
    const validResultRef = resultRef === undefined || isAnnouncementResultRef(resultRef);
    return Object.keys(record).every((key) =>
      key === "kind"
      || key === "terminalReason"
      || key === "completedAtMs"
      || key === "errorKind"
      || key === "summary"
      || key === "resultRef")
      && (record.terminalReason === "completed" || record.terminalReason === "failed")
      && typeof record.completedAtMs === "number"
      && Number.isSafeInteger(record.completedAtMs)
      && record.completedAtMs >= 0
      && (record.summary === undefined
        || (typeof record.summary === "string"
          && record.summary.length <= SUBAGENT_RESULT_SUMMARY_MAX_CHARS))
      && validResultRef
      && (record.terminalReason === "completed"
        ? record.errorKind === undefined
        : typeof record.errorKind === "string" && ERROR_KIND_SET.has(record.errorKind));
  }
  if (record.kind === "graph") {
    return Object.keys(record).every((key) =>
      key === "kind"
      || key === "terminalReason"
      || key === "completedAtMs"
      || key === "announcementText"
      || key === "extra")
      && record.terminalReason === "completed"
      && typeof record.completedAtMs === "number"
      && Number.isSafeInteger(record.completedAtMs)
      && record.completedAtMs >= 0
      && typeof record.announcementText === "string"
      && record.announcementText.length > 0
      && record.announcementText.length <= ANNOUNCEMENT_TOOL_RESULT_RESPONSE_MAX_CHARS
      && (record.extra === undefined
        || (typeof record.extra === "object"
          && record.extra !== null
          && !Array.isArray(record.extra)));
  }
  if (record.kind !== "tool_result") return false;
  if (record.terminalReason === "failed") {
    return Object.keys(record).every((key) =>
      key === "kind"
      || key === "terminalReason"
      || key === "completedAtMs"
      || key === "errorKind"
      || key === "summary")
      && typeof record.completedAtMs === "number"
      && Number.isSafeInteger(record.completedAtMs)
      && record.completedAtMs >= 0
      && typeof record.errorKind === "string"
      && ERROR_KIND_SET.has(record.errorKind)
      && typeof record.summary === "string"
      && record.summary.length > 0
      && record.summary.length <= SUBAGENT_RESULT_SUMMARY_MAX_CHARS;
  }
  if (record.terminalReason !== "completed") return false;
  if (typeof record.completedAtMs !== "number"
    || !Number.isSafeInteger(record.completedAtMs)
    || record.completedAtMs < 0) return false;
  if (typeof record.response !== "string"
    || record.response.length > ANNOUNCEMENT_TOOL_RESULT_RESPONSE_MAX_CHARS) return false;
  if (record.responseRef !== undefined) {
    if (typeof record.responseRef !== "object"
      || record.responseRef === null
      || Array.isArray(record.responseRef)) return false;
    const responseRef = record.responseRef as Record<string, unknown>;
    if (Object.keys(responseRef).some((key) => key !== "kind" && key !== "operationId")
      || responseRef.kind !== "session_metadata"
      || typeof responseRef.operationId !== "string"
      || responseRef.operationId.length === 0
      || responseRef.operationId.length > 256) return false;
  }
  if (record.turnsCompleted !== undefined
    && (typeof record.turnsCompleted !== "number"
      || !Number.isSafeInteger(record.turnsCompleted)
      || record.turnsCompleted < 0)) return false;
  if (record.announced !== undefined && typeof record.announced !== "boolean") return false;
  if (typeof record.stats !== "object" || record.stats === null || Array.isArray(record.stats)) {
    return false;
  }
  const stats = record.stats as Record<string, unknown>;
  return Object.keys(record).every((key) =>
    key === "kind"
    || key === "terminalReason"
    || key === "completedAtMs"
    || key === "response"
    || key === "responseRef"
    || key === "turnsCompleted"
    || key === "announced"
    || key === "stats")
    && Object.keys(stats).length === 3
    && typeof stats.runtimeMs === "number"
    && Number.isFinite(stats.runtimeMs)
    && stats.runtimeMs >= 0
    && typeof stats.totalTokens === "number"
    && Number.isFinite(stats.totalTokens)
    && stats.totalTokens >= 0
    && typeof stats.totalCost === "number"
    && Number.isFinite(stats.totalCost)
    && stats.totalCost >= 0;
}

export function isAnnouncementResultRef(value: unknown): value is ResultRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) =>
    key === "ref"
    || key === "kind"
    || key === "bytes"
    || key === "rows"
    || key === "schema"
    || key === "preview"
    || key === "expiresAt")
    && typeof record.ref === "string"
    && record.ref.length > 0
    && record.ref.length <= 1_024
    && typeof record.kind === "string"
    && RESULT_REF_KIND_SET.has(record.kind)
    && typeof record.bytes === "number"
    && Number.isSafeInteger(record.bytes)
    && record.bytes >= 0
    && (record.rows === undefined
      || (typeof record.rows === "number" && Number.isSafeInteger(record.rows) && record.rows >= 0))
    && (record.schema === undefined
      || (Array.isArray(record.schema)
        && record.schema.length <= 256
        && record.schema.every((field) => typeof field === "string" && field.length <= 256)))
    && typeof record.preview === "string"
    && record.preview.length <= 4_096
    && typeof record.expiresAt === "string"
    && record.expiresAt.length > 0
    && record.expiresAt.length <= 64;
}

export type StoredDeadLetterEntry =
  | DeadLetterEntry
  | ParentDecisionReservationRecord
  | ProducerReservationRecord
  | AnnouncementProducerHandoffRecord
  | InvalidDeadLetterRecord;

export function isDeadLetterSnapshotCapacityError(error: Error): boolean {
  return error.message === "Dead-letter snapshot exceeds the row limit"
    || error.message === "Dead-letter snapshot exceeds the byte limit"
    || error.message === "Dead-letter quarantine capacity exhausted"
    || error.message === "Announcement producer capacity exhausted";
}

export function reservedDeadLetterSnapshotBytes(
  entries: readonly StoredDeadLetterEntry[],
): Result<number, Error> {
  if (entries.length > MAX_DEAD_LETTER_SNAPSHOT_ROWS) {
    return err(new Error("Dead-letter snapshot exceeds the row limit"));
  }
  const serializedRows = tryCatch(() => entries.map((entry) => JSON.stringify(entry)));
  if (!serializedRows.ok) return serializedRows;
  let total = 0;
  for (let index = 0; index < entries.length; index++) {
    const rowBytes = Buffer.byteLength(serializedRows.value[index]!, "utf8");
    if (rowBytes > MAX_DEAD_LETTER_ROW_BYTES) {
      return err(new Error("Dead-letter snapshot contains an oversized record"));
    }
    const entry = entries[index]!;
    total += isAnnouncementProducerReservationRecord(entry)
      && entry.recoveryOutcome === undefined
      && (
        entry.lifecycleState === "active"
        || entry.lifecycleState === "delivery_owned"
        || entry.lifecycleState === "promotion_ready"
      )
      ? MAX_DEAD_LETTER_ROW_BYTES + 1
      : rowBytes + 1;
  }
  return ok(total);
}

export function validateDeadLetterSnapshotAdmission(
  currentEntries: readonly StoredDeadLetterEntry[],
  nextEntries: readonly StoredDeadLetterEntry[],
): Result<void, Error> {
  const currentBytes = reservedDeadLetterSnapshotBytes(currentEntries);
  if (!currentBytes.ok) return currentBytes;
  const nextBytes = reservedDeadLetterSnapshotBytes(nextEntries);
  if (!nextBytes.ok) return nextBytes;
  if (
    nextBytes.value > MAX_DEAD_LETTER_SNAPSHOT_BYTES
    && nextBytes.value >= currentBytes.value
  ) {
    return err(new Error("Dead-letter snapshot exceeds the byte limit"));
  }
  return ok(undefined);
}

export interface DeadLetterReadSnapshot {
  readonly entries: StoredDeadLetterEntry[];
  readonly invalidRowCount: number;
}

export interface ParentDecisionReservationStoreDeps {
  load(): Promise<Result<void, Error>>;
  hasDeliveryKey(idempotencyKey: string): boolean;
  getReservations(): readonly ParentDecisionReservationRecord[];
  persist(
    reservations: readonly ParentDecisionReservationRecord[],
    consumedProducerKeys?: readonly string[],
  ): Promise<Result<void, Error>>;
  canPersistReservationCount(count: number): boolean;
  replaceReservations(reservations: readonly ParentDecisionReservationRecord[]): void;
  logger?: StorageLogger;
}

export function publicDecision(
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
    ...(record.retirementKeys !== undefined ? { retirementKeys: record.retirementKeys } : {}),
    ...(record.terminalGroupKey !== undefined
      ? { terminalGroupKey: record.terminalGroupKey }
      : {}),
    ...(record.textChunks !== undefined ? { textChunks: record.textChunks } : {}),
  };
}

export function decisionFingerprint(
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

export function sameDecision(
  left: ParentDecisionReservation,
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
    && (
      right.textChunks === undefined
      || (
        left.textChunks !== undefined
        && left.textChunks.length === right.textChunks.length
        && left.textChunks.every((chunk, index) => chunk === right.textChunks?.[index])
      )
    )
    && decisionFingerprint(left) !== undefined
    && decisionFingerprint(left) === decisionFingerprint(right)
    && left.completionKeys.length === right.completionKeys.length
    && left.completionKeys.every((key, index) => key === right.completionKeys[index])
    && JSON.stringify(left.retirementKeys) === JSON.stringify(right.retirementKeys)
    && left.terminalGroupKey === right.terminalGroupKey
    && sameDeliveryAuthority(left.deliveryAuthority, right.deliveryAuthority)
    && sameChannelEndpoint(left.destinationEndpoint, right.destinationEndpoint);
}

export function isValidAnnouncementDecision(entry: ParentDecisionReservation): boolean {
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
    && (entry.textChunks === undefined || isAnnouncementTextChunks(entry.textChunks))
    && isCompletionKeys(entry.completionKeys)
    && (entry.retirementKeys === undefined || isCompletionKeys(entry.retirementKeys))
    && (entry.terminalGroupKey === undefined
      || (typeof entry.terminalGroupKey === "string" && entry.terminalGroupKey.length > 0))
    && isRecoveryRoute(entry as unknown as Record<string, unknown>);
}

export function sameAnnouncementProducerReservation(
  left: ProducerReservationRecord,
  right: AnnouncementProducerReservation,
): boolean {
  return sameDecision(left, right) && sameRetirementProducer(left.producer, right.producer);
}

export function sameRetirementProducer(
  left: AnnouncementRetirementProducer,
  right: AnnouncementRetirementProducer,
): boolean {
  if (left.kind !== right.kind || left.tenantId !== right.tenantId) return false;
  if (left.kind === "graph") return right.kind === "graph" && left.graphId === right.graphId;
  if (right.kind === "graph") return false;
  if (
    left.agentId !== right.agentId
    || left.conversationRef !== right.conversationRef
  ) return false;
  if (left.kind === "tool_result") {
    return right.kind === "tool_result"
      && left.toolCallId === right.toolCallId
      && left.operationId === right.operationId;
  }
  if (right.kind === "tool_result") return false;
  return left.checkpointId === right.checkpointId;
}

export function isAnnouncementRetirementProducer(
  value: unknown,
): value is AnnouncementRetirementProducer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const producer = value as Record<string, unknown>;
  if (typeof producer.tenantId !== "string" || producer.tenantId.length === 0) return false;
  switch (producer.kind) {
    case "session":
      return typeof producer.agentId === "string"
        && producer.agentId.length > 0
        && ConversationRefSchema.safeParse(producer.conversationRef).success
        && typeof producer.checkpointId === "string"
        && producer.checkpointId.length > 0;
    case "tool_result":
      return typeof producer.agentId === "string"
        && producer.agentId.length > 0
        && ConversationRefSchema.safeParse(producer.conversationRef).success
        && typeof producer.toolCallId === "string"
        && producer.toolCallId.length > 0
        && typeof producer.operationId === "string"
        && producer.operationId.length > 0;
    case "graph":
      return typeof producer.graphId === "string" && producer.graphId.length > 0;
    default:
      return false;
  }
}

export function isAnnouncementProducerHandoffRecord(
  value: unknown,
): value is AnnouncementProducerHandoffRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!(record.recordType === "producer_handoff"
    && typeof record.id === "string"
    && record.id.length > 0
    && typeof record.transitionId === "string"
    && record.transitionId.length > 0
    && record.id === `handoff:${record.transitionId}`
    && Array.isArray(record.expectedKeys)
    && new Set(record.expectedKeys).size === record.expectedKeys.length
    && record.expectedKeys.every((key) => typeof key === "string" && key.length > 0)
    && typeof record.operationCount === "number"
    && Number.isSafeInteger(record.operationCount)
    && record.operationCount > 0
    && Array.isArray(record.operations)
    && record.operations.length === record.operationCount
    && record.operations.every((operation) => isValidAnnouncementDecision(
      operation as AnnouncementParentDecisionReservation,
    ))
    && new Set(record.operations.map((operation) =>
      (operation as AnnouncementParentDecisionReservation).idempotencyKey)).size
      === record.operations.length
    && typeof record.groupDigest === "string"
    && /^[a-f0-9]{64}$/u.test(record.groupDigest))) return false;
  const digest = announcementProducerHandoffDigest(
    record.expectedKeys as string[],
    record.operations as AnnouncementParentDecisionReservation[],
  );
  return digest.ok && digest.value === record.groupDigest;
}

export function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isParentDecisionReservationRecord(
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
    && (record.retirementKeys === undefined || isCompletionKeys(record.retirementKeys))
    && (record.terminalGroupKey === undefined
      || (typeof record.terminalGroupKey === "string" && record.terminalGroupKey.length > 0))
    && isOptionalString(record.partId)
    && (record.attachment === undefined || isDeadLetterAttachmentSnapshot(record.attachment))
    && (record.textChunks === undefined || isAnnouncementTextChunks(record.textChunks))
    && isRecoveryRoute(record);
}

export function isAnnouncementProducerReservationRecord(
  value: unknown,
): value is ProducerReservationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!isParentDecisionReservationRecord({
    ...(value as Record<string, unknown>),
    recordType: "parent_decision_reservation",
  })) return false;
  const record = value as Record<string, unknown>;
  return record.recordType === "producer_reservation"
    && typeof record.id === "string"
    && record.id.length > 0
    && isAnnouncementRetirementProducer(record.producer)
    && (
      record.lifecycleState === "active"
      || record.lifecycleState === "delivery_owned"
      || record.lifecycleState === "promotion_ready"
      || record.lifecycleState === "no_reply_pending"
      || record.lifecycleState === "no_reply"
      || record.lifecycleState === "cancel_pending"
    )
    && (record.recoveryOutcome === undefined
      || isAnnouncementProducerRecoveryOutcome(record.recoveryOutcome));
}

export function isDeadLetterEntry(
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
    && (record.textChunks === undefined || isAnnouncementTextChunks(record.textChunks))
    && (record.completionKeys === undefined || isCompletionKeys(record.completionKeys))
    && (record.retirementKeys === undefined || isCompletionKeys(record.retirementKeys))
    && (record.terminalGroupKey === undefined
      || (typeof record.terminalGroupKey === "string" && record.terminalGroupKey.length > 0))
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
