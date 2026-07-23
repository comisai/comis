// SPDX-License-Identifier: Apache-2.0
/**
 * Durable structured provenance for physical inbound channel messages.
 *
 * Queue coalescing changes the prompt presented to the model, but must not
 * erase the operator's ability to recover each original message identity. A
 * dedicated append-only ledger is committed before model setup, while matching
 * SDK custom entries keep completed transcripts self-describing. Credential
 * assignments are redacted in both durable forms without changing the live
 * message delivered to the model. Neither record type enters
 * `buildSessionContext()` or alters model context.
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  getOriginalInboundMessages,
  INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  parseInboundMessageProvenanceBatch,
  scrubSecretsFromText,
  type NormalizedMessage,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

/** Leave headroom for the SDK JSONL record envelope under the reader's 1 MiB cap. */
const MAX_PROVENANCE_PAYLOAD_BYTES = 900 * 1024;

/** One append stays recoverable inside the ledger reader's 16 MiB file window. */
const MAX_PROVENANCE_LEDGER_APPEND_BYTES = 8 * 1024 * 1024;

/** Closed by the core payload schema and the bounded predecessor runway. */
const MAX_PROVENANCE_CHUNKS = 32;

export interface InboundMessageProvenancePayload {
  schemaVersion: 1;
  batchId: string;
  chunkIndex: number;
  chunkCount: number;
  recordedAt: number;
  messages: ReturnType<typeof getOriginalInboundMessages>;
}

export interface InboundMessageProvenancePlan {
  readonly payloads: readonly InboundMessageProvenancePayload[];
  readonly ledgerContent: string;
}

export interface InboundMessageProvenancePlanError {
  readonly error: Error;
  readonly errorKind: "validation" | "precondition" | "resource";
}

/** Validate and fully bound every durable record before any file append occurs. */
export function planInboundMessageProvenance(
  message: NormalizedMessage,
  recordedAt: number,
): Result<InboundMessageProvenancePlan, InboundMessageProvenancePlanError> {
  const sourceMessages = getOriginalInboundMessages(message);
  let rawMessageBytes = 0;
  for (const original of sourceMessages) {
    const serialized = tryCatch(() => JSON.stringify(original));
    if (!serialized.ok || serialized.value === undefined) {
      return err({
        error: serialized.ok
          ? new Error("Inbound provenance message is not JSON serializable")
          : serialized.error,
        errorKind: "validation",
      });
    }
    rawMessageBytes += Buffer.byteLength(serialized.value, "utf8");
    if (rawMessageBytes > MAX_PROVENANCE_LEDGER_APPEND_BYTES) {
      return err({
        error: new Error("Inbound provenance batch exceeds the durable ledger window"),
        errorKind: "resource",
      });
    }
  }
  const originalMessages = sourceMessages.map((original) => {
    const scrubbed = scrubSecretsFromText(original.text);
    return scrubbed.redactions === 0
      ? original
      : { ...original, text: scrubbed.text };
  });
  const parsed = parseInboundMessageProvenanceBatch({
    schemaVersion: 1,
    batchId: message.id,
    chunkIndex: 0,
    chunkCount: 1,
    recordedAt,
    messages: originalMessages,
  });
  if (!parsed.ok) {
    return err({ error: parsed.error, errorKind: "validation" });
  }

  const emptyPayloadBytes = Buffer.byteLength(JSON.stringify({
    schemaVersion: 1,
    batchId: message.id,
    chunkIndex: 9_999,
    chunkCount: 10_000,
    recordedAt,
    messages: [],
  }), "utf8");
  const chunks: Array<InboundMessageProvenancePayload["messages"]> = [];
  let current: InboundMessageProvenancePayload["messages"] = [];
  let currentBytes = emptyPayloadBytes;

  for (const original of parsed.value.messages) {
    const messageBytes = Buffer.byteLength(JSON.stringify(original), "utf8");
    const candidateBytes = currentBytes + messageBytes + (current.length === 0 ? 0 : 1);
    if (candidateBytes > MAX_PROVENANCE_PAYLOAD_BYTES && current.length > 0) {
      chunks.push(current);
      current = [];
      currentBytes = emptyPayloadBytes;
    }
    if (currentBytes + messageBytes > MAX_PROVENANCE_PAYLOAD_BYTES) {
      return err({
        error: new Error("One inbound provenance message exceeds the durable record ceiling"),
        errorKind: "resource",
      });
    }
    current.push(original);
    currentBytes += messageBytes + (current.length === 1 ? 0 : 1);
  }
  chunks.push(current);

  if (chunks.length > MAX_PROVENANCE_CHUNKS) {
    return err({
      error: new Error("Inbound provenance requires too many durable chunks"),
      errorKind: "resource",
    });
  }

  const payloads: InboundMessageProvenancePayload[] = chunks.map((messages, chunkIndex) => ({
    schemaVersion: 1,
    batchId: message.id,
    chunkIndex,
    chunkCount: chunks.length,
    recordedAt,
    messages,
  }));
  const ledgerLines = payloads.map((payload) => `${JSON.stringify({
    type: "custom",
    customType: INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
    data: payload,
  })}\n`);
  if (ledgerLines.some((line) => Buffer.byteLength(line, "utf8") >= 1024 * 1024)) {
    return err({
      error: new Error("Inbound provenance record exceeds the offline reader ceiling"),
      errorKind: "resource",
    });
  }
  const ledgerContent = ledgerLines.join("");
  if (Buffer.byteLength(ledgerContent, "utf8") > MAX_PROVENANCE_LEDGER_APPEND_BYTES) {
    return err({
      error: new Error("Inbound provenance batch exceeds the durable ledger window"),
      errorKind: "resource",
    });
  }

  return ok({ payloads, ledgerContent });
}

/** Append one fully planned occurrence to the SDK session tree. */
export function appendInboundMessageProvenance(
  sessionManager: SessionManager,
  plan: InboundMessageProvenancePlan,
): Result<string, Error> {
  return tryCatch(() => {
    let finalEntryId = "";
    for (const payload of plan.payloads) {
      finalEntryId = sessionManager.appendCustomEntry(
        INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
        payload,
      );
    }
    return finalEntryId;
  });
}
