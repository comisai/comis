// SPDX-License-Identifier: Apache-2.0
/**
 * Pure parts <-> pi-ai canonical Message round-trip (F2/F3).
 *
 * Lives in core — the only non-agent package that depends on pi-ai. No
 * embedded database, no wall-clock reads — pure + unit-testable. Provider-
 * correct wire emission is pi-ai's job (its provider modules map the canonical
 * block to each provider's shape); this codec reconstructs the CANONICAL block
 * only.
 *
 * Anti-pattern: hand-rolling provider wire shapes (the Anthropic tool blocks,
 * the OpenAI Responses function-output blocks, etc.) here — pi-ai owns that
 * and is version-pinned.
 *
 * Fidelity model (F1/F2): every content block is emitted as one part whose
 * `metadata.raw` is the verbatim canonical block; the message-level envelope
 * (every top-level field except `content`) rides verbatim on the FIRST part's
 * `metadata.messageEnvelope`. A top-level `ToolResultMessage` is its own
 * message, so its whole verbatim value goes to the single part's
 * `metadata.raw`. Reconstruction prefers these verbatim captures so the
 * round-trip drops no field; the typed tool columns are the queryable
 * projection, not the source of truth.
 *
 * F3: a `thinking` block becomes a `reasoning` part marked
 * `topLevelReasoningOnly` and is NOT re-emitted as a visible content block on
 * reconstruction (excluded from visible content + summarizer input); its tokens
 * were already counted agent-side at write time (`estimateMessageTokens` counts
 * `thinking`), so the budget accounts for it even while it is invisible here.
 *
 * @module
 */

import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
} from "@earendil-works/pi-ai";
import type { LcdMessage, LcdMessagePart } from "../ports/context-store-types.js";

/**
 * The message-level envelope: the source `Message` minus its `content` (and,
 * for a tool result, minus the fields the typed columns already carry). It is
 * the verbatim carrier for every top-level field no content block holds — e.g.
 * an `AssistantMessage`'s `api`/`provider`/`model`/`usage`/`stopReason`/
 * `timestamp` and a `UserMessage`'s `timestamp`.
 */
function envelopeOf(msg: UserMessageLike | AssistantMessage): Record<string, unknown> {
  const { content: _content, ...rest } = msg;
  return { ...rest };
}

/** Narrowing alias for the pi-ai `UserMessage` (its content may be a string). */
type UserMessageLike = Extract<Message, { role: "user" }>;

/**
 * Decompose a canonical pi-ai `Message` into structured LCD parts (write path,
 * F1): one part per content block, plus a single `tool_result` part for a
 * top-level `ToolResultMessage`. Captures `metadata.raw` = the verbatim block
 * (or whole tool-result message), the F3 top-level reasoning marker, and the
 * message-level envelope on the first part.
 */
export function messageToParts(msg: Message): LcdMessagePart[] {
  if (msg.role === "toolResult") {
    return [toolResultToPart(msg)];
  }

  // user | assistant: one part per content block; the envelope rides the first.
  const envelope = envelopeOf(msg);
  const blocks: ReadonlyArray<unknown> =
    typeof msg.content === "string"
      ? [{ type: "text", text: msg.content } satisfies TextContent]
      : msg.content;

  const parts = blocks.map((block, index) => {
    const part = blockToPart(block);
    if (index === 0) {
      part.metadata.messageEnvelope = envelope;
    }
    return part;
  });

  // WR-01: an empty-content message (e.g. an aborted/errored assistant turn,
  // `content: []`) would otherwise emit zero parts, so the `index === 0`
  // envelope-attachment above never runs and the whole envelope
  // (api/provider/model/usage/stopReason/errorMessage/timestamp) is lost on
  // round-trip — a direct F2 violation. Emit a single envelope-carrier part
  // (no `raw` block) so the envelope always has a carrier; `partsToMessage`
  // restores the envelope from it and excludes it from the reconstructed
  // visible content, faithfully rebuilding an empty-content message.
  if (parts.length === 0) {
    parts.push({
      kind: "text",
      metadata: { raw: undefined, envelopeCarrier: true, messageEnvelope: envelope },
    });
  }
  return parts;
}

/**
 * Reconstruct a canonical pi-ai `Message` from a persisted `LcdMessage` (read
 * path, F2): rebuild blocks with STABLE ids (so tool_use<->tool_result pair),
 * preferring `metadata.raw` for exactness, restore the message envelope from
 * the first part, and exclude `topLevelReasoningOnly` reasoning from the
 * reconstructed VISIBLE content (F3).
 */
export function partsToMessage(row: LcdMessage): Message {
  if (row.role === "toolResult") {
    return toolResultFromPart(row);
  }

  // user | assistant: restore the envelope from the first part, then rebuild
  // the visible content blocks (F3: skip topLevelReasoningOnly reasoning;
  // WR-01: skip an envelope-carrier placeholder — it holds the envelope of an
  // empty-content message, not a real block, so it must not become content).
  const envelope = (row.parts[0]?.metadata.messageEnvelope ?? {}) as Record<string, unknown>;
  const content = row.parts
    .filter((part) => !(part.kind === "reasoning" && part.metadata.topLevelReasoningOnly === true))
    .filter((part) => part.metadata.envelopeCarrier !== true)
    .map((part) => blockFromPart(part));

  return { ...envelope, role: row.role, content } as Message;
}

// --- per-block helpers -----------------------------------------------------

/** Map one canonical pi-ai content block to an `LcdMessagePart`. */
function blockToPart(block: unknown): LcdMessagePart {
  const typed = block as { type?: string };
  switch (typed.type) {
    case "text":
      return { kind: "text", metadata: { raw: block, rawType: "text" } };

    case "image":
      // F1: the verbatim ImageContent (data + mimeType) is kept in metadata.raw;
      // no externalization in Phase 127.
      return { kind: "file", metadata: { raw: block, rawType: "image" } };

    case "thinking":
      // F3: reasoning is captured as a marked part, excluded from visible
      // content on reconstruction, but its tokens are counted at write time.
      return {
        kind: "reasoning",
        metadata: { raw: block, rawType: "thinking", topLevelReasoningOnly: true },
      };

    case "toolCall": {
      const tc = block as { id: string; name: string; arguments?: unknown };
      return {
        kind: "tool_use",
        toolCallId: tc.id,
        toolName: tc.name,
        toolInput: tc.arguments ?? {},
        metadata: { raw: block, rawType: "toolCall" },
      };
    }

    default:
      // Unknown/forward-compat block: keep it verbatim so nothing is dropped.
      return { kind: "text", metadata: { raw: block, rawType: typed.type } };
  }
}

/**
 * Rebuild a canonical content block from a part — prefer the verbatim
 * `metadata.raw`, backfilling from the typed columns only when `raw` is absent
 * (the stable-id requirement: a rebuilt `toolCall.id` === the persisted
 * `toolCallId`).
 */
function blockFromPart(part: LcdMessagePart): unknown {
  // Return the verbatim block ONLY when it is a well-formed content block (an
  // object carrying a string `type`). A null / undefined / malformed `raw` must
  // NEVER become a content block: a sparse block crashes every downstream
  // `.type` consumer (token estimator, transcript-repair) inside the LCD
  // assembler's transformContext — BEFORE the LLM call — aborting the whole turn
  // and surfacing to the user as a silent "AI didn't produce a response"
  // (LCD-codec regression 2026-06-14: openai-codex on a fresh install).
  const raw = part.metadata.raw;
  if (raw != null && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string") {
    return raw;
  }

  // Backfill (raw absent/malformed): reconstruct from the typed columns. A
  // text/file part's verbatim data lived only in `raw` and is unrecoverable, so
  // emit a valid (possibly empty) block rather than a sparse one — never
  // undefined.
  switch (part.kind) {
    case "tool_use":
      return {
        type: "toolCall",
        id: part.toolCallId,
        name: part.toolName,
        arguments: part.toolInput ?? {},
      };
    case "reasoning":
      return { type: "thinking", thinking: "" };
    default:
      return { type: "text", text: "" };
  }
}

// --- tool-result helpers ---------------------------------------------------

/**
 * Map a top-level `ToolResultMessage` to a single `tool_result` part: the whole
 * verbatim message goes to `metadata.raw`, with the typed columns projected for
 * indexing/querying.
 */
function toolResultToPart(msg: ToolResultMessage): LcdMessagePart {
  return {
    kind: "tool_result",
    toolCallId: msg.toolCallId,
    toolName: msg.toolName,
    toolOutput: msg.content,
    isError: msg.isError,
    metadata: { raw: msg, rawType: "toolResult" },
  };
}

/**
 * Reconstruct the top-level `ToolResultMessage` from its single part — prefer
 * the verbatim `metadata.raw`, backfilling from the typed columns when absent.
 */
function toolResultFromPart(row: LcdMessage): Message {
  const part = row.parts[0];
  if (part?.metadata.raw !== undefined) {
    return part.metadata.raw as ToolResultMessage;
  }

  // Backfill (raw absent): rebuild from the typed columns.
  return {
    role: "toolResult",
    toolCallId: part?.toolCallId ?? "",
    toolName: part?.toolName ?? "",
    content: (part?.toolOutput ?? []) as ToolResultMessage["content"],
    isError: part?.isError ?? false,
    timestamp: row.createdAt,
  };
}
