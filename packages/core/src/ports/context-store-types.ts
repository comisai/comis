// SPDX-License-Identifier: Apache-2.0
/**
 * Row DTOs for the LCD (Lossless Context DAG) ContextStorePort. Type-only.
 *
 * These are the raw row shapes for the `lcd_messages` / `lcd_message_parts`
 * store. They are pi-ai-AGNOSTIC: the pi-ai-typed seam is the codec
 * (`core/src/context-store/parts-codec.ts`), NOT these DTOs.
 *
 * They stay in core/src/ports/ (NOT core/src/domain/) to preserve the
 * domain/persistence boundary — they are raw row shapes, NOT domain
 * entities. Type-only, NO zod: the zod row schemas live consumer-side in
 * memory's row-schemas.ts (core ports are zero-runtime-zod by rule).
 *
 * The summary/context_items half of the contract is the `LcdSummary` row, the
 * ordered model-facing `LcdContextItem` view row, and the `AppendSummaryInput`
 * compaction write-path DTO (depth-0 LEAF summaries). The multi-tier
 * condensation half is the `"condensed"` member of the `LcdSummaryKind` union
 * and `AppendCondensedSummaryInput`, which carries the depth>0
 * summary-of-summaries write path (linking CHILD SUMMARIES, not messages).
 *
 * @module
 */

// Type-only import: LcdSearchResult.scriptZeroHit is typed as the script enum
// (the trigram lane covers every non-Latin class). Zero-runtime
// (the rule for core ports) — `import type` erases at build.
import type { ScriptClass } from "../text/script-classes.js";

/**
 * The block kind of an LCD message part.
 *
 * Maps 1:1 from the pi-ai canonical content block on the write path:
 *   - assistant `TextContent`        -> `text`
 *   - assistant `ThinkingContent`    -> `reasoning` (held as metadata, excluded from visible content)
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
 * is what makes the round-trip exact: a reconstructed block backfills from
 * `raw` when a typed column is NULL. Stored verbatim by design (lossless
 * store); sanitization happens at assembly/presentation, never at storage.
 */
export interface LcdPartMetadata {
  /** Verbatim canonical pi-ai content block (exact round-trip). Opaque here. */
  raw: unknown;
  /** The `type` discriminator of the captured `raw` block (e.g. `"toolCall"`), for fast dispatch on read. */
  rawType?: string;
  /**
   * Reasoning-exclusion marker: when true, this `reasoning` part is excluded
   * from the reconstructed VISIBLE content (and from summarizer input), but
   * its tokens are still counted at write time. Restored as message metadata,
   * never as a visible content block.
   */
  topLevelReasoningOnly?: boolean;
  /**
   * Verbatim message-level envelope (exact round-trip): the source pi-ai
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
   * Envelope-carrier marker: when true, this part exists ONLY to carry the
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
 * canonical block always lives in `metadata.raw`.
 */
export interface LcdMessagePart {
  /** Block kind. */
  kind: LcdPartKind;
  /** Stable tool-call id (pairs a tool_use with its tool_result): `ToolCall.id` / `ToolResultMessage.toolCallId`. */
  toolCallId?: string;
  /** Tool name: `ToolCall.name` / `ToolResultMessage.toolName`. */
  toolName?: string;
  /** Tool arguments (`ToolCall.arguments`) — structured, JSON-serialized at the row layer. */
  toolInput?: unknown;
  /** Tool output (`ToolResultMessage.content` blocks) — structured, JSON-serialized at the row layer. */
  toolOutput?: unknown;
  /** Tool-result error flag (`ToolResultMessage.isError`); absent for non-`tool_result` parts. */
  isError?: boolean;
  /** Verbatim block + reasoning-exclusion marker. */
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
 * Every scoping column is PRESENT in the contract so per-tenant/agent/session
 * filtering is enforced on ONE schema — a missing scoping field would be a
 * latent cross-tenant hole.
 */
export interface ContextStoreScope {
  conversationId: string;
  tenantId: string;
  agentId: string;
  sessionKey: string;
}

/**
 * The write-path DTO for `ContextStorePort.append`.
 *
 * `tokenCount` is carried as a PRE-COMPUTED number: the caller computes it
 * agent-side via `estimateMessageTokens` (which counts the `thinking`
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

/**
 * The kind of an LCD summary. Closed string-literal union (AGENTS.md §2.8 — a
 * `switch` on it needs an exhaustive `never` default).
 *
 * `"leaf"` is a depth-0 condensation of a contiguous run of messages.
 * `"condensed"` is a depth>0 summary-of-summaries — the multi-tier
 * condensation tier. The union is closed: every new kind extends
 * it here, keeping the discriminator exhaustive at every switch.
 */
export type LcdSummaryKind = "leaf" | "condensed";

/**
 * A reconstructed LCD summary (one row of `lcd_summaries`). Returned by the
 * summary read paths. Mirrors `LcdMessage` shape + comment style.
 *
 * Like `LcdMessage`, `tokenCount` is PRE-COMPUTED agent-side — the store NEVER
 * computes tokens. `content` is the leaf summary plaintext and is never logged
 * (lossless store; sanitization happens at assembly/presentation).
 */
export interface LcdSummary {
  summaryId: string;
  conversationId: string;
  /** `"leaf"` (depth-0 condensation of messages) or `"condensed"` (depth>0 summary-of-summaries). */
  kind: LcdSummaryKind;
  /** 0 for a leaf; `max(child depths) + 1` for a condensed summary. */
  depth: number;
  /** Min `createdAt` of the covered messages. */
  earliestAt: number;
  /** Max `createdAt` of the covered messages. */
  latestAt: number;
  /** Count of messages this summary covers. */
  descendantCount: number;
  /** Pre-computed agent-side; the store NEVER computes tokens. */
  tokenCount: number;
  /** The leaf summary text (plaintext; never logged). */
  content: string;
  /** File references covered by the chunk (JSON-stored). */
  fileIds: string[];
  /** Untrusted-content flag (enforced at assembly/presentation, never at storage). */
  taint: boolean;
  /** True ⇒ deterministic Level-3 truncation produced this summary. */
  fallback: boolean;
  /** Injected wall-clock epoch milliseconds (the store does not stamp it). */
  createdAt: number;
}

/**
 * The ref kind of an `LcdContextItem`. Closed string-literal discriminator
 * (AGENTS.md §2.8): a context item points either at a raw message or at a
 * leaf summary.
 */
export type LcdRefKind = "message" | "summary";

/**
 * One row of the ordered model-facing `context_items` view. The view is the
 * dense, gap-free sequence the assembler walks to build the model-facing
 * context; each item references either an `lcd_messages` row or an
 * `lcd_summaries` row.
 */
export interface LcdContextItem {
  /** Position in the model-facing order (dense, gap-free). */
  ordinal: number;
  /** `"message"` | `"summary"`. */
  refKind: LcdRefKind;
  /** `lcd_messages.id` OR `lcd_summaries.summaryId`. */
  refId: string;
}

/**
 * The agent+tenant isolation key for the operator browse surface
 * ({@link ContextBrowsePort}). Unlike {@link ContextStoreScope} this names NO
 * single conversation — it is the (tenant, agent) bucket whose distinct
 * conversations are being enumerated. Both fields are mandatory so the
 * browse query can never widen past one agent within one tenant.
 */
export interface ContextBrowseScope {
  tenantId: string;
  agentId: string;
}

/**
 * One distinct LCD conversation row returned by
 * {@link ContextBrowsePort.listConversations}. The LCD store has no per-
 * conversation title column, so `title` is always null; `createdAt` /
 * `updatedAt` are the min / max message `created_at` for the conversation, and
 * `messageCount` is the number of `lcd_messages` rows in the (conversation,
 * agent, tenant) scope. IDs/counts only — NEVER carries message or summary
 * content (the browse list is a metadata index; content recovery is a separate,
 * taint-wrapped read).
 */
export interface LcdConversationSummary {
  conversationId: string;
  tenantId: string;
  agentId: string;
  /** Equal to conversationId in the current single-session-per-conversation model. */
  sessionKey: string;
  /** Always null — the LCD store has no per-conversation title. */
  title: string | null;
  /** Min `created_at` (epoch ms) across the conversation's messages. */
  createdAt: number;
  /** Max `created_at` (epoch ms) across the conversation's messages. */
  updatedAt: number;
  /** Count of `lcd_messages` rows in the (conversation, agent, tenant) scope. */
  messageCount: number;
}

/**
 * A page of {@link LcdConversationSummary} rows plus the unpaginated `total`
 * (so the operator UI can render "showing N of TOTAL" + enable/disable paging).
 */
export interface LcdConversationPage {
  conversations: LcdConversationSummary[];
  total: number;
}

/**
 * One FTS/scan hit from {@link ContextStorePort.searchLcd}. `snippet` is
 * recovered/UNTRUSTED content — the calling tool MUST taint-wrap it via
 * wrapExternalContent before it re-enters the model context, and MUST NEVER
 * log it (ids/counts only). `rank` is the BM25 rank when FTS5 was used;
 * undefined for the LIKE fallback (no ranking).
 */
export interface LcdSearchHit {
  /** Closed discriminator (AGENTS.md §2.8) — mirrors LcdRefKind. */
  kind: "message" | "summary";
  /** `lcd_messages.id` (kind="message") OR `lcd_summaries.summaryId` (kind="summary"). */
  refId: string;
  /** The matched text (UNTRUSTED — the tool taint-wraps; never logged). */
  snippet: string;
  /** BM25 rank when FTS5 was used; undefined for the LIKE fallback. */
  rank?: number;
}

/**
 * Wrapper returned by {@link ContextStorePort.searchLcd} and
 * `searchLcdImpl` to carry the script-routing diagnostics alongside the hits.
 *
 * `cjkZeroHit` is kept as a DERIVED compatibility boolean (`scriptZeroHit ===
 * "cjk"`); `scriptZeroHit` generalizes it to every non-Latin script (the
 * trigram lane covers he/ar/ru/CJK). All diagnostics are content-free —
 * enums/booleans only, NEVER the query text (mirror the `LcdSearchHit.snippet`
 * "UNTRUSTED — never logged" contract). The caller's logging boundary
 * (skills/agent — NOT @comis/memory, which is logger-free per AGENTS.md §2.4)
 * emits the `script_zero_hit` event when `scriptZeroHit` is set.
 */
export interface LcdSearchResult {
  hits: LcdSearchHit[];
  /** Derived compatibility flag — true iff scriptZeroHit === "cjk". */
  cjkZeroHit: boolean;
  /** Set iff the query's dominant script is non-Latin, the search executed CLEANLY
   *  (matchErrored false), and hits.length === 0. Enum only — never query text. */
  scriptZeroHit?: ScriptClass;
  /** The lane that served the query. "word" covers the word FTS AND its LIKE floor.
   *  REQUIRED, not optional-with-defaults — staleness must fail the compile, not hide. */
  lane: "word" | "tri" | "scan";
  /** True iff a MATCH threw and was degraded to [] — an errored zero-result is NOT
   *  a lane gap (signal purity). REQUIRED — same staleness-fails-compile rationale. */
  matchErrored: boolean;
  /** lane === "scan" only: the bounded floor hit its row cap before exhausting the
   *  conversation (the tool notes the cap to the model). */
  scanCapped?: boolean;
}

/**
 * The write-path DTO for the compaction transaction: persist one leaf
 * summary, link it to the covered messages, and range-replace the covered
 * context_items message-refs with one summary-ref — all atomically.
 *
 * Mirrors `AppendMessageInput`: scope-first + a PRE-COMPUTED `tokenCount` (the
 * store NEVER computes tokens). The `[startOrdinal, endOrdinal]` inclusive
 * range names the contiguous run of message-refs the new summary-ref replaces.
 */
export interface AppendSummaryInput {
  scope: ContextStoreScope;
  /** Pre-computed agent-side via `estimateMessageTokens`; the store NEVER computes tokens. */
  tokenCount: number;
  content: string;
  descendantCount: number;
  earliestAt: number;
  latestAt: number;
  fileIds: string[];
  /** Level-3 deterministic-truncation marker; default false. */
  fallback: boolean;
  /** Untrusted-content flag (enforced at assembly/presentation, never at storage); default false. */
  taint: boolean;
  /** Injected wall-clock epoch milliseconds (the caller supplies it). */
  createdAt: number;
  /**
   * The contiguous context_items ordinal range [startOrdinal, endOrdinal]
   * (inclusive) of message-refs to replace with one summary-ref
   * (the range-replacement step of the compaction transaction).
   */
  startOrdinal: number;
  endOrdinal: number;
}

/**
 * The write-path DTO for the condensation transaction: persist one
 * condensed (depth>0) summary, link it to its CHILD SUMMARIES (not
 * messages), and range-replace the contiguous run of summary-refs it
 * covers with one condensed summary-ref — all atomically.
 *
 * Mirrors AppendSummaryInput, adding: `childSummaryIds`
 * (advisory — the store DERIVES the `lcd_summary_parents` links from the
 * summary-refs in the replaced range) and `depth` (= max(child depths)
 * + 1). `descendantCount`/`earliestAt`/`latestAt` are likewise advisory — the
 * store recomputes them from the range-derived child rows (the store is the
 * authority; the range is the single source of truth for the linked set).
 */
export interface AppendCondensedSummaryInput {
  scope: ContextStoreScope;
  /** Pre-computed agent-side via estimateMessageTokens; the store NEVER computes tokens. */
  tokenCount: number;
  content: string;
  /** Advisory — the store recomputes = Σ child.descendantCount. */
  descendantCount: number;
  /** Advisory — the store recomputes = min(child.earliestAt). */
  earliestAt: number;
  /** Advisory — the store recomputes = max(child.latestAt). */
  latestAt: number;
  fileIds: string[];
  /** True ⇒ condensation itself hit the deterministic Level-3 floor. */
  fallback: boolean;
  /** Untrusted-content flag (enforced at assembly/presentation, never at storage). */
  taint: boolean;
  /** Injected wall-clock epoch milliseconds (the caller supplies it). */
  createdAt: number;
  /** Inclusive context_items ordinal range of SUMMARY-refs to replace. */
  startOrdinal: number;
  endOrdinal: number;
  /**
   * Advisory — the agent's intended child summary ids. The store DERIVES the
   * actual `lcd_summary_parents` links FROM the summary-refs in the replaced
   * `[startOrdinal,endOrdinal]` range (the range is the single authority),
   * exactly as the leaf path derives its message links from the read range. A
   * range that still holds a surviving `message`-ref is rejected (a condensed run
   * is summary-refs only). Pass the same set the run was selected from.
   */
  childSummaryIds: string[];
  /** = max(child depths) + 1. */
  depth: number;
}

/**
 * The write-path DTO for
 * ContextStorePort.appendProvenance — persists one lcd_memory_provenance row.
 *
 * Links a distilled episodic memory (memoryId) to the LCD condensed summary
 * (summaryId) it was distilled from. Scoped via conversationId / agentId /
 * tenantId. No FK on summaryId (a provenance row must survive an LCD reset).
 */
export interface AppendProvenanceInput {
  /** UUID for the new provenance row (caller-supplied, randomUUID). */
  provenanceId: string;
  /** ID of the distilled episodic memory row in the memories table (FK ON DELETE CASCADE). */
  memoryId: string;
  /** ID of the lcd_summaries row that was distilled (intentionally NOT a FK — survives resets). */
  summaryId: string;
  /** Formatted session key; used by the `session.reset_conversation --memory` delete path. */
  sourceSessionKey: string;
  /** Isolation: tenant+agent+session composite. */
  conversationId: string;
  /** Isolation: agent boundary. */
  agentId: string;
  /** Isolation: tenant boundary. */
  tenantId: string;
  /** Caller-supplied epoch ms (the store never reads the clock). */
  createdAt: number;
}
