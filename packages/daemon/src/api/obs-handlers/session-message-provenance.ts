// SPDX-License-Identifier: Apache-2.0
/** Contiguous occurrence assembly for structured inbound-message provenance. */

import {
  INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  parseInboundMessageProvenanceBatch,
  type OriginalInboundMessage,
} from "@comis/core";

/** Writer-side aggregate contract for one physical inbound batch. */
const MAX_PROVENANCE_OCCURRENCE_MESSAGES = 10_000;

export type DecodedProvenanceRecord =
  | { kind: "other" }
  | { kind: "invalid" }
  | {
    kind: "valid";
    batchId: string;
    chunkIndex: number;
    chunkCount: number;
    recordedAt: number;
    messages: OriginalInboundMessage[];
  };

export interface CompletedProvenanceOccurrence {
  messages: OriginalInboundMessage[];
  recordedAt: number;
  containsOrdinaryRecord: boolean;
}

export interface ProvenanceAssemblyUpdate {
  /** Whether this input was a structured provenance custom entry. */
  structured: boolean;
  /** Schema- and path-valid structured records consumed. */
  validRecords: number;
  /** Invalid records or incomplete/conflicting occurrences closed by this step. */
  invalidOccurrences: number;
  /** Occurrences completed by this step. */
  completed: CompletedProvenanceOccurrence[];
}

interface PendingOccurrence {
  batchId: string;
  chunkCount: number;
  nextChunkIndex: number;
  recordedAt: number;
  messages: OriginalInboundMessage[];
  containsOrdinaryRecord: boolean;
}

export interface ProvenanceAssembler {
  consume(
    record: DecodedProvenanceRecord,
    contextOnly?: boolean,
  ): ProvenanceAssemblyUpdate;
  finish(): ProvenanceAssemblyUpdate;
}

const EMPTY_UPDATE = (): ProvenanceAssemblyUpdate => ({
  structured: false,
  validRecords: 0,
  invalidOccurrences: 0,
  completed: [],
});

/** Whether physical channel identity is compatible with a projected session channel. */
function messageMatchesSessionChannel(
  message: OriginalInboundMessage,
  sessionChannelId: string,
): boolean {
  // Direct projections store the physical conversation id.
  if (message.channelId === sessionChannelId) return true;
  // A channel-principal projection stores the channel type (for example,
  // "telegram") while the provenance retains the physical chat id.
  if (message.channelType === sessionChannelId) return true;
  // Endpoint projections encode channel type, instance, and conversation.
  return sessionChannelId.startsWith(`${message.channelType}:`)
    && sessionChannelId.endsWith(`:${message.channelId}`);
}

/** Decode and bind one possible provenance custom entry to its session projection. */
export function decodeProvenanceRecord(
  record: Record<string, unknown>,
  sessionChannelId: string,
): DecodedProvenanceRecord {
  if (
    record["type"] !== "custom" ||
    record["customType"] !== INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE
  ) {
    return { kind: "other" };
  }
  const parsed = parseInboundMessageProvenanceBatch(record["data"]);
  if (!parsed.ok) return { kind: "invalid" };
  if (parsed.value.messages.some((message) =>
    !messageMatchesSessionChannel(message, sessionChannelId))) {
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    batchId: parsed.value.batchId,
    chunkIndex: parsed.value.chunkIndex,
    chunkCount: parsed.value.chunkCount,
    recordedAt: parsed.value.recordedAt,
    messages: parsed.value.messages,
  };
}

/** Assemble only physically contiguous, strictly ordered chunk occurrences. */
export function createProvenanceAssembler(): ProvenanceAssembler {
  let pending: PendingOccurrence | undefined;

  const start = (
    record: Extract<DecodedProvenanceRecord, { kind: "valid" }>,
    contextOnly: boolean,
  ): CompletedProvenanceOccurrence[] => {
    if (record.chunkIndex !== 0) return [];
    pending = {
      batchId: record.batchId,
      chunkCount: record.chunkCount,
      nextChunkIndex: 1,
      recordedAt: record.recordedAt,
      messages: [...record.messages],
      containsOrdinaryRecord: !contextOnly,
    };
    if (record.chunkCount !== 1) return [];
    const completed = [{
      messages: pending.messages,
      recordedAt: pending.recordedAt,
      containsOrdinaryRecord: pending.containsOrdinaryRecord,
    }];
    pending = undefined;
    return completed;
  };

  return {
    consume(record, contextOnly = false) {
      const update = EMPTY_UPDATE();
      update.structured = record.kind !== "other";
      if (record.kind === "other") {
        if (pending !== undefined) {
          update.invalidOccurrences++;
          pending = undefined;
        }
        return update;
      }
      if (record.kind === "invalid") {
        update.invalidOccurrences++;
        pending = undefined;
        return update;
      }

      update.validRecords++;
      if (record.messages.length > MAX_PROVENANCE_OCCURRENCE_MESSAGES) {
        update.invalidOccurrences++;
        pending = undefined;
        return update;
      }
      if (pending === undefined) {
        if (record.chunkIndex !== 0) {
          update.invalidOccurrences++;
          return update;
        }
        update.completed = start(record, contextOnly);
        return update;
      }

      const expected = record.batchId === pending.batchId &&
        record.chunkCount === pending.chunkCount &&
        record.recordedAt === pending.recordedAt &&
        record.chunkIndex === pending.nextChunkIndex;
      if (!expected) {
        update.invalidOccurrences++;
        pending = undefined;
        if (record.chunkIndex === 0) {
          update.completed = start(record, contextOnly);
        }
        return update;
      }

      if (
        pending.messages.length + record.messages.length >
        MAX_PROVENANCE_OCCURRENCE_MESSAGES
      ) {
        update.invalidOccurrences++;
        pending = undefined;
        return update;
      }

      pending.messages.push(...record.messages);
      pending.nextChunkIndex++;
      pending.containsOrdinaryRecord ||= !contextOnly;
      if (pending.nextChunkIndex !== pending.chunkCount) return update;
      update.completed = [{
        messages: pending.messages,
        recordedAt: pending.recordedAt,
        containsOrdinaryRecord: pending.containsOrdinaryRecord,
      }];
      pending = undefined;
      return update;
    },

    finish() {
      const update = EMPTY_UPDATE();
      if (pending !== undefined) {
        update.invalidOccurrences = 1;
        pending = undefined;
      }
      return update;
    },
  };
}
