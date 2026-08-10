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

import {
  sessionEntryToContextMessages,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  getOriginalInboundMessages,
  INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  MAX_NORMALIZED_MESSAGE_TEXT_CHARS,
  parseInboundMessageProvenanceBatch,
  scrubSecretsFromText,
  systemDateFrom,
  type NormalizedMessage,
  type OriginalInboundMessage,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { z } from "zod";
import { stripInlineRecalledMemoryFromMessage } from "../rag/hybrid-memory-injector.js";

/** Leave headroom for the SDK JSONL record envelope under the reader's 1 MiB cap. */
const MAX_PROVENANCE_PAYLOAD_BYTES = 900 * 1024;

/** One append stays recoverable inside the ledger reader's 16 MiB file window. */
const MAX_PROVENANCE_LEDGER_APPEND_BYTES = 8 * 1024 * 1024;

/** Closed by the core payload schema and the bounded predecessor runway. */
const MAX_PROVENANCE_CHUNKS = 32;

/** SDK-only record that keeps trusted preprocessing output out of raw provenance. */
const INBOUND_CONVERSATION_TEXT_CUSTOM_TYPE = "comis.inbound-conversation-text";

const InboundConversationTextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batchId: z.guid(),
  text: z.string().max(MAX_NORMALIZED_MESSAGE_TEXT_CHARS),
});

type InboundConversationText = z.infer<typeof InboundConversationTextSchema>;

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
  /** Trusted model-facing text added after the immutable physical ledger commit. */
  readonly conversationText?: string;
}

export interface InboundMessageProvenancePlanError {
  readonly error: Error;
  readonly errorKind: "validation" | "precondition" | "resource";
}

export interface InboundConversationProjectionDiagnostics {
  readonly projectedUserMessages: number;
  readonly omittedLocaleRepairTurns: number;
  readonly duplicateProvenanceEntries: number;
  readonly invalidProvenanceEntries: number;
  readonly incompleteProvenanceBatches: number;
  /** User turns whose canonical history includes trusted preprocessing output. */
  readonly projectedConversationTextMessages: number;
  /** Malformed, conflicting, or unpaired SDK-only preprocessing records. */
  readonly invalidConversationTextEntries: number;
  /** Unpaired user turns whose transient inline-recall prefix was carved out. */
  readonly strippedRecallMessages: number;
}

export interface InboundConversationProjection {
  /** Canonical model/LCD history rebuilt from structured physical-message records. */
  readonly messages: AgentMessage[];
  /** Unmodified SDK context used only to reconcile an already-persisted dirty LCD epoch. */
  readonly sourceMessages: AgentMessage[];
  readonly diagnostics: InboundConversationProjectionDiagnostics;
}

interface PendingProvenanceBatch {
  readonly batchId: string;
  readonly recordedAt: number;
  readonly chunkCount: number;
  readonly chunks: Map<number, {
    readonly serialized: string;
    readonly messages: OriginalInboundMessage[];
  }>;
  conversationText?: string;
  invalid: boolean;
}

const GENERATED_LOCALE_REPAIR_PREFIX = "<response-locale-repair locale=\"";

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
  let conversationText: InboundConversationText | undefined;
  if (plan.conversationText !== undefined) {
    const batchId = plan.payloads[0]?.batchId;
    if (batchId === undefined) {
      return err(new Error("Inbound conversation text has no provenance batch identity"));
    }
    const scrubbed = scrubSecretsFromText(plan.conversationText);
    const parsed = InboundConversationTextSchema.safeParse({
      schemaVersion: 1,
      batchId,
      text: scrubbed.text,
    });
    if (!parsed.success) {
      return err(new Error("Inbound conversation text failed validation"));
    }
    conversationText = parsed.data;
  }

  return tryCatch(() => {
    let finalEntryId = "";
    for (const payload of plan.payloads) {
      finalEntryId = sessionManager.appendCustomEntry(
        INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
        payload,
      );
    }
    if (conversationText !== undefined) {
      finalEntryId = sessionManager.appendCustomEntry(
        INBOUND_CONVERSATION_TEXT_CUSTOM_TYPE,
        conversationText,
      );
    }
    return finalEntryId;
  });
}

function messageText(message: AgentMessage): string {
  const content = (message as unknown as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object"
      && block !== null
      && (block as { type?: string }).type === "text"
      && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("");
}

function replaceUserText(message: AgentMessage, text: string): AgentMessage {
  const user = message as unknown as { content?: unknown };
  if (typeof user.content === "string" || !Array.isArray(user.content)) {
    return { ...message, content: text } as AgentMessage;
  }
  let insertedText = false;
  const content = user.content.flatMap((block) => {
    if (
      typeof block !== "object"
      || block === null
      || (block as { type?: string }).type !== "text"
    ) {
      return [block];
    }
    if (insertedText) return [];
    insertedText = true;
    return [{ ...block, text }];
  });
  if (!insertedText) content.unshift({ type: "text", text });
  return { ...message, content } as AgentMessage;
}

function renderPhysicalMessages(
  messages: readonly OriginalInboundMessage[],
  conversationText?: string,
): string {
  if (conversationText !== undefined && messages.length === 1) {
    const message = messages[0]!;
    return `[${message.channelType}] ${message.senderId} `
      + `(${systemDateFrom(message.timestamp).toISOString()}):\n${conversationText}`;
  }
  return messages.map((message) =>
    `[${message.channelType}] ${message.senderId} `
    + `(${systemDateFrom(message.timestamp).toISOString()}):\n${message.text}`,
  ).join("\n\n") + (conversationText === undefined
    ? ""
    : `\n\n[Preprocessed context for the preceding inbound batch]:\n${conversationText}`);
}

function collectProjectedUserText(
  branch: readonly SessionEntry[],
  diagnostics: {
    projectedUserMessages: number;
    duplicateProvenanceEntries: number;
    invalidProvenanceEntries: number;
    incompleteProvenanceBatches: number;
    projectedConversationTextMessages: number;
    invalidConversationTextEntries: number;
  },
): Map<string, string> {
  const projectedByEntryId = new Map<string, string>();
  const pendingByBatchId = new Map<string, PendingProvenanceBatch>();
  const pendingOrder: string[] = [];

  for (const entry of branch) {
    if (
      entry.type === "custom"
      && entry.customType === INBOUND_CONVERSATION_TEXT_CUSTOM_TYPE
    ) {
      const parsed = InboundConversationTextSchema.safeParse(entry.data);
      if (!parsed.success) {
        diagnostics.invalidConversationTextEntries++;
        continue;
      }
      const batch = pendingByBatchId.get(parsed.data.batchId);
      if (batch === undefined) {
        diagnostics.invalidConversationTextEntries++;
        continue;
      }
      if (batch.conversationText === undefined) {
        batch.conversationText = parsed.data.text;
      } else if (batch.conversationText !== parsed.data.text) {
        batch.invalid = true;
        diagnostics.invalidConversationTextEntries++;
      }
      continue;
    }

    if (
      entry.type === "custom"
      && entry.customType === INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE
    ) {
      const parsed = parseInboundMessageProvenanceBatch(entry.data);
      if (!parsed.ok) {
        diagnostics.invalidProvenanceEntries++;
        continue;
      }
      const payload = parsed.value;
      const serialized = JSON.stringify(payload.messages);
      const existing = pendingByBatchId.get(payload.batchId);
      if (existing === undefined) {
        pendingOrder.push(payload.batchId);
        pendingByBatchId.set(payload.batchId, {
          batchId: payload.batchId,
          recordedAt: payload.recordedAt,
          chunkCount: payload.chunkCount,
          chunks: new Map([[
            payload.chunkIndex,
            { serialized, messages: payload.messages },
          ]]),
          invalid: false,
        });
        continue;
      }
      if (
        existing.recordedAt !== payload.recordedAt
        || existing.chunkCount !== payload.chunkCount
      ) {
        existing.invalid = true;
        diagnostics.invalidProvenanceEntries++;
        continue;
      }
      const priorChunk = existing.chunks.get(payload.chunkIndex);
      if (priorChunk === undefined) {
        existing.chunks.set(payload.chunkIndex, {
          serialized,
          messages: payload.messages,
        });
      } else if (priorChunk.serialized === serialized) {
        diagnostics.duplicateProvenanceEntries++;
      } else {
        existing.invalid = true;
        diagnostics.invalidProvenanceEntries++;
      }
      continue;
    }

    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const renderedBatches: string[] = [];
    for (const batchId of pendingOrder) {
      const batch = pendingByBatchId.get(batchId);
      if (batch === undefined || batch.invalid) continue;
      if (batch.chunks.size !== batch.chunkCount) {
        diagnostics.incompleteProvenanceBatches++;
        continue;
      }
      const physicalMessages: OriginalInboundMessage[] = [];
      for (let chunkIndex = 0; chunkIndex < batch.chunkCount; chunkIndex++) {
        const chunk = batch.chunks.get(chunkIndex);
        if (chunk === undefined) {
          diagnostics.incompleteProvenanceBatches++;
          break;
        }
        physicalMessages.push(...chunk.messages);
      }
      if (physicalMessages.length > 0) {
        renderedBatches.push(renderPhysicalMessages(
          physicalMessages,
          batch.conversationText,
        ));
        if (batch.conversationText !== undefined) {
          diagnostics.projectedConversationTextMessages++;
        }
      }
    }
    if (renderedBatches.length > 0) {
      projectedByEntryId.set(entry.id, renderedBatches.join("\n\n"));
      diagnostics.projectedUserMessages++;
    }
    pendingByBatchId.clear();
    pendingOrder.length = 0;
  }

  return projectedByEntryId;
}

/**
 * Rebuild the active conversation from structured inbound provenance.
 *
 * Dynamic prompt sections remain in the append-only SDK JSONL for forensics,
 * but never become canonical model or LCD history. A generated locale-repair
 * instruction replaces its rejected assistant draft with the finalized
 * assistant response. A user who types the same protocol-shaped text keeps
 * their message because their structured record is paired first.
 */
export function projectInboundConversation(
  sessionManager: SessionManager,
): Result<InboundConversationProjection, Error> {
  const read = tryCatch(() => ({
    branch: sessionManager.getBranch(),
    contextEntries: sessionManager.buildContextEntries(),
    sourceMessages: sessionManager.buildSessionContext().messages,
  }));
  if (!read.ok) return read;

  const diagnostics = {
    projectedUserMessages: 0,
    omittedLocaleRepairTurns: 0,
    duplicateProvenanceEntries: 0,
    invalidProvenanceEntries: 0,
    incompleteProvenanceBatches: 0,
    projectedConversationTextMessages: 0,
    invalidConversationTextEntries: 0,
    strippedRecallMessages: 0,
  };
  const projectedByEntryId = collectProjectedUserText(
    read.value.branch,
    diagnostics,
  );
  const messages: AgentMessage[] = [];
  let replaceLocaleRepairDraft = false;

  for (const entry of read.value.contextEntries) {
    if (entry.type === "message" && entry.message.role === "user") {
      const projectedText = projectedByEntryId.get(entry.id);
      if (projectedText !== undefined) {
        replaceLocaleRepairDraft = false;
        messages.push(replaceUserText(entry.message, projectedText));
        continue;
      }
      if (messageText(entry.message).trimStart().startsWith(GENERATED_LOCALE_REPAIR_PREFIX)) {
        if (messages.at(-1)?.role === "assistant") messages.pop();
        replaceLocaleRepairDraft = true;
        diagnostics.omittedLocaleRepairTurns++;
        continue;
      }
      replaceLocaleRepairDraft = false;
    } else if (
      replaceLocaleRepairDraft
      && entry.type === "message"
      && entry.message.role === "assistant"
    ) {
      replaceLocaleRepairDraft = false;
      messages.push(...sessionEntryToContextMessages(entry));
      continue;
    }
    messages.push(...sessionEntryToContextMessages(entry));
  }

  // The transient inline-recall block is per-turn rendered prompt context, not
  // conversation. Provenance-paired turns already lost it with the rest of the
  // rendered wrapper (their text is the physical render); an UNPAIRED turn
  // (internally dispatched — cron, queue steer) passes through verbatim above
  // and must not carry the recall into canonical model/LCD history either:
  // replayed, it re-presents a block that is stripped from the wire form each
  // request, and the message mutates once every time it crosses the cache
  // fence. The model still sees the recall on the turn it was rendered for —
  // this projection reads only completed turns. The append-only SDK JSONL
  // keeps the rendered forensic form untouched.
  for (let i = 0; i < messages.length; i++) {
    const carved = stripInlineRecalledMemoryFromMessage(
      messages[i] as unknown as Message,
    ) as unknown as AgentMessage;
    if (carved !== messages[i]) {
      messages[i] = carved;
      diagnostics.strippedRecallMessages++;
    }
  }

  return ok({
    messages,
    sourceMessages: read.value.sourceMessages,
    diagnostics,
  });
}
