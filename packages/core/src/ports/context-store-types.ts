// SPDX-License-Identifier: Apache-2.0
/**
 * Row DTOs for the LCD (Lossless Context DAG) ContextStorePort. Type-only.
 *
 * These are the raw row shapes for the `lcd_messages` / `lcd_message_parts`
 * store reintroduced in v2.12 (Phase 127). They are pi-ai-AGNOSTIC: the
 * pi-ai-typed seam is the codec (`core/src/context-store/parts-codec.ts`),
 * NOT these DTOs.
 *
 * They stay in core/src/ports/ (NOT core/src/domain/) to preserve the
 * domain/persistence boundary — they are raw row shapes, NOT domain
 * entities. Type-only, NO zod: the zod row schemas live consumer-side in
 * memory's row-schemas.ts (core ports are zero-runtime-zod by rule).
 *
 * @module
 */

/**
 * The block kind of an LCD message part.
 *
 * Maps 1:1 from the pi-ai canonical content block on the write path (F1):
 *   - assistant `TextContent`        -> `text`
 *   - assistant `ThinkingContent`    -> `reasoning` (F3: held as metadata, excluded from visible content)
 *   - assistant `ToolCall`           -> `tool_use`
 *   - top-level `ToolResultMessage`  -> `tool_result`
 *   - user `ImageContent` / attached -> `file`
 */
export type LcdPartKind = "text" | "tool_use" | "tool_result" | "reasoning" | "file";

/**
 * The role of an LCD message. These are the pi-ai role strings verbatim —
 * note `"toolResult"` is camelCase (a `ToolResultMessage` is a TOP-LEVEL pi-ai
 * message, not a content block).
 */
export type LcdRole = "user" | "assistant" | "toolResult";

/**
 * Per-part metadata persisted as the JSON `metadata` column.
 *
 * `raw` is the verbatim canonical pi-ai block — opaque at the DTO layer — and
 * is what gives F1 its exact round-trip: a reconstructed block backfills from
 * `raw` when a typed column is NULL. Stored verbatim by design (lossless
 * store); sanitization happens at assembly/presentation, never at storage.
 */
export interface LcdPartMetadata {
  /** Verbatim canonical pi-ai content block (F1 exact round-trip). Opaque here. */
  raw: unknown;
  /** The `type` discriminator of the captured `raw` block (e.g. `"toolCall"`), for fast dispatch on read. */
  rawType?: string;
  /**
   * F3 marker: when true, this `reasoning` part is excluded from the
   * reconstructed VISIBLE content (and from summarizer input), but its
   * tokens are still counted at write time. Restored as message metadata,
   * never as a visible content block.
   */
  topLevelReasoningOnly?: boolean;
  /**
   * Verbatim message-level envelope (F2 exact round-trip): the source pi-ai
   * `Message` with its `content` blocks stripped — i.e. `role` plus the
   * per-role envelope fields (`UserMessage.timestamp`; `AssistantMessage.api`/
   * `provider`/`model`/`usage`/`stopReason`/`timestamp`/…). Carried on the
   * FIRST part of a message so `partsToMessage` can restore every top-level
   * field no content block holds; absent on subsequent parts. A top-level
   * `ToolResultMessage` keeps its whole message in `raw`, so it needs no
   * separate envelope. Opaque at the DTO layer (the codec is the pi-ai seam).
   */
  messageEnvelope?: unknown;
  /**
   * F2 marker (WR-01): when true, this part exists ONLY to carry the
   * `messageEnvelope` of an empty-content message (a realistic aborted/errored
   * assistant turn: `content: []`). Without a carrier such a turn would emit
   * zero parts and lose its whole envelope on round-trip. It holds NO real
   * content block (`raw` is absent), so `partsToMessage` restores the envelope
   * from it but EXCLUDES it from the reconstructed visible content —
   * reconstructing a faithful empty-content message.
   */
  envelopeCarrier?: boolean;
}

/**
 * One structured part of an LCD message (one row of `lcd_message_parts`).
 *
 * The typed tool columns are present for indexing/round-trip; the verbatim
 * canonical block always lives in `metadata.raw` (F1).
 */
export interface LcdMessagePart {
  /** Block kind (F1). */
  kind: LcdPartKind;
  /** Stable tool-call id (F2 pairing): `ToolCall.id` / `ToolResultMessage.toolCallId`. */
  toolCallId?: string;
  /** Tool name: `ToolCall.name` / `ToolResultMessage.toolName`. */
  toolName?: string;
  /** Tool arguments (`ToolCall.arguments`) — structured, JSON-serialized at the row layer. */
  toolInput?: unknown;
  /** Tool output (`ToolResultMessage.content` blocks) — structured, JSON-serialized at the row layer. */
  toolOutput?: unknown;
  /** Tool-result error flag (`ToolResultMessage.isError`); absent for non-`tool_result` parts. */
  isError?: boolean;
  /** Verbatim block + F3 reasoning marker (F1). */
  metadata: LcdPartMetadata;
}

/**
 * A reconstructed LCD message (one row of `lcd_messages` plus its ordered
 * parts). Returned by `ContextStorePort.getMessages`.
 */
export interface LcdMessage {
  id: string;
  conversationId: string;
  /** Monotonic per conversation. */
  seq: number;
  role: LcdRole;
  /** Pre-computed agent-side via `estimateMessageTokens`; the store NEVER computes tokens. */
  tokenCount: number;
  /** Injected wall-clock epoch milliseconds (the store does not stamp it). */
  createdAt: number;
  parts: LcdMessagePart[];
}

/**
 * The tenant + agent + session isolation key for a conversation.
 *
 * The R4 scoping columns are PRESENT in the contract from the start so Phase
 * 132 can enforce per-tenant/agent/session filtering on the SAME schema
 * without a migration — a missing scoping field now would be a latent
 * cross-tenant hole (CONTEXT.md multi-tenant `<decisions>`).
 */
export interface ContextStoreScope {
  conversationId: string;
  tenantId: string;
  agentId: string;
  sessionKey: string;
}

/**
 * The write-path DTO for `ContextStorePort.append` (F1).
 *
 * `tokenCount` is carried as a PRE-COMPUTED number: the caller computes it
 * agent-side via `estimateMessageTokens` (which counts the F3 `thinking`
 * block, so reasoning tokens are budgeted even though the block is excluded
 * from visible content on reconstruction). The store NEVER computes tokens —
 * that keeps core/memory free of the `@comis/agent` estimator dependency.
 */
export interface AppendMessageInput {
  scope: ContextStoreScope;
  /** Monotonic per conversation. */
  seq: number;
  role: LcdRole;
  /** Pre-computed agent-side; the store persists it verbatim, never computes it. */
  tokenCount: number;
  /** Injected wall-clock epoch milliseconds (the caller supplies it). */
  createdAt: number;
  parts: LcdMessagePart[];
}
