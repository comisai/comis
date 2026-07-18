// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-result clearing, thinking-block clearing, and content reordering.
 *
 * Exposes:
 *  - `MICROCOMPACT_MIN_CONTENT_LENGTH` (internal threshold)
 *  - `COMPACTABLE_TOOL_NAMES` (read-only tool-name set)
 *  - `CLEARABLE_USES_TOOL_NAMES` (edit/write tool-name set)
 *  - `clearStaleToolResults` (internal; consumed by factory)
 *  - `clearStaleThinkingBlocks` (public; also consumed by factory)
 *  - `reorderContentForStablePrefix` (internal; consumed by factory)
 *  - `stripTransientRecallFromHistory` (public; also consumed by factory)
 *
 * @module
 */

import {
  extractInlineRecalledMemory,
  stripInlineRecalledMemory,
} from "../../../rag/hybrid-memory-injector.js";

/** Minimum content length (chars) for a tool result to be considered clearable. */
export const MICROCOMPACT_MIN_CONTENT_LENGTH = 1000;

/**
 * Read-only tool names whose results are safely clearable during microcompact.
 * Edit/write tool results are preserved because they carry the LLM's understanding
 * of what was changed -- clearing them loses context.
 *
 * These are Comis's ACTUAL emitted builtin tool names (the `block.name` on the
 * `tool_use` blocks in the message stream), verified at the builtin registrations:
 * `read` (read-tool), `grep` (grep-tool), `find` (find-tool), `ls` (ls-tool),
 * `exec` (exec-tool), `web_fetch` (web-fetch-tool), `web_search` (web-search-tool).
 * The earlier set listed provider/SDK names (file_read/glob/exec_tool/list_dir/
 * search_files) that matched NONE of the builtins -- so the heaviest results
 * (read/find/ls/exec) were never compacted (the latent bug).
 */
export const COMPACTABLE_TOOL_NAMES = new Set<string>([
  "read",        // File read -- output is ephemeral
  "grep",        // Content search -- ephemeral
  "find",        // File search -- ephemeral
  "ls",          // Directory listing -- ephemeral
  "exec",        // Shell exec -- output is ephemeral
  "web_fetch",   // Fetched page content -- ephemeral
  "web_search",  // Search results -- ephemeral
]);

/**
 * Edit/write tool names whose tool_use INPUT blocks are clearable during microcompact.
 * Unlike COMPACTABLE_TOOL_NAMES (which clears tool_result output), this clears the
 * tool_use input (the request the LLM sent). The tool_result (what the tool returned)
 * is preserved because edit/write results carry confirmation of what changed.
 */
export const CLEARABLE_USES_TOOL_NAMES = new Set<string>([
  "file_edit",
  "file_write",
  "notebook_edit",
]);

/**
 * Clear stale tool results from messages, preserving the most recent ones.
 * Replaces long tool_result content with a placeholder to reduce cache-write
 * token cost when the cache has expired after an idle gap.
 *
 * Only clears read-only (compactable) tool types. Edit/write tool
 * results and orphaned results (no matching tool_use) are preserved.
 *
 * @param messages - The messages array (mutated in place)
 * @param keepWindow - Number of most recent tool_result messages to preserve
 * @returns Number of tool results cleared
 */
export function clearStaleToolResults(
  messages: Array<Record<string, unknown>>,
  keepWindow: number,
  fenceIndex: number = -1,
): number {
  // Build tool_use_id -> tool_name map for type filtering
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          toolNameById.set(block.id as string, block.name as string);
        }
      }
    }
  }

  // Find all tool_result indices (role === "tool" in Anthropic API format)
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "tool") {
      toolResultIndices.push(i);
    }
  }

  // Protect the last `keepWindow` tool results
  const clearableIndices = toolResultIndices.slice(0, Math.max(0, toolResultIndices.length - keepWindow));

  let cleared = 0;
  for (const idx of clearableIndices) {
    // Protect messages within the cached prefix (at or below the fence).
    if (idx <= fenceIndex) continue;

    const msg = messages[idx]!;

    // Only clear compactable (read-only) tool types
    const toolUseId = msg.tool_use_id as string | undefined;
    if (toolUseId) {
      const toolName = toolNameById.get(toolUseId);
      if (toolName && !COMPACTABLE_TOOL_NAMES.has(toolName)) {
        continue; // Preserve edit/write tool results
      }
      // If tool name not found (orphaned result), skip clearing (conservative)
      if (!toolName) {
        continue;
      }
    }

    const content = msg.content;
    if (Array.isArray(content)) {
      // Check if any content block exceeds the threshold
      let totalLen = 0;
      for (const block of content as Array<Record<string, unknown>>) {
        if (typeof block.text === "string") {
          totalLen += (block.text as string).length;
        }
      }
      if (totalLen >= MICROCOMPACT_MIN_CONTENT_LENGTH) {
        // Replace content with lightweight placeholder
        msg.content = [{ type: "text", text: "[Stale tool result cleared: idle > TTL]" }];
        cleared++;
      }
    } else if (typeof content === "string" && content.length >= MICROCOMPACT_MIN_CONTENT_LENGTH) {
      msg.content = [{ type: "text", text: "[Stale tool result cleared: idle > TTL]" }];
      cleared++;
    }
  }

  // Second pass -- clear tool_use input blocks for edit/write tools.
  // These tool_use blocks contain the full file content the LLM wanted to write/edit.
  // After the result is confirmed, the input is no longer needed and just wastes cache space.
  const assistantWithToolUseIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const content = msg.content as Array<Record<string, unknown>>;
      if (content.some(b => b.type === "tool_use")) {
        assistantWithToolUseIndices.push(i);
      }
    }
  }
  const clearableAssistantIndices = assistantWithToolUseIndices.slice(
    0, Math.max(0, assistantWithToolUseIndices.length - keepWindow),
  );
  for (const idx of clearableAssistantIndices) {
    // Protect messages within the cached prefix.
    if (idx <= fenceIndex) continue;

    const msg = messages[idx]!;
    const content = msg.content as Array<Record<string, unknown>>;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const toolName = block.name as string;
      if (!CLEARABLE_USES_TOOL_NAMES.has(toolName)) continue;
      const inputStr = JSON.stringify(block.input);
      if (inputStr.length >= MICROCOMPACT_MIN_CONTENT_LENGTH) {
        block.input = { _cleared: true, reason: "stale edit/write input" };
        cleared++;
      }
    }
  }

  return cleared;
}

/**
 * Clear non-redacted thinking blocks from old assistant messages.
 * Thinking blocks (5-20K tokens each) waste cache_creation budget when the cache
 * is cold. This function strips them from assistant messages beyond the keepWindow,
 * preserving redacted thinking blocks (which carry encrypted signatures for API continuity).
 *
 * Mutates messages in place (same pattern as clearStaleToolResults).
 *
 * @param messages - The messages array (mutated in place)
 * @param keepWindow - Number of most recent assistant messages to preserve thinking blocks in
 * @returns Number of thinking blocks cleared
 */
export function clearStaleThinkingBlocks(
  messages: Array<Record<string, unknown>>,
  keepWindow: number,
  fenceIndex: number = -1,
): number {
  // Collect assistant message indices
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "assistant") {
      assistantIndices.push(i);
    }
  }

  // Calculate how many are clearable (beyond keepWindow)
  const clearableCount = Math.max(0, assistantIndices.length - keepWindow);
  if (clearableCount === 0) return 0;

  const clearableIndices = new Set(assistantIndices.slice(0, clearableCount));

  let cleared = 0;
  for (const idx of clearableIndices) {
    // Protect messages within the cached prefix.
    if (idx <= fenceIndex) continue;

    const msg = messages[idx]!;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    // Filter: keep everything EXCEPT non-redacted thinking blocks
    const filtered = (content as Array<Record<string, unknown>>).filter(block => {
      if (block.type !== "thinking") return true;
      // Preserve redacted thinking blocks (encrypted signatures for API continuity)
      return (block as { redacted?: boolean }).redacted === true;
    });

    if (filtered.length < (content as unknown[]).length) {
      cleared += (content as unknown[]).length - filtered.length;
      msg.content = filtered;
    }
  }

  return cleared;
}

/**
 * Reorder content blocks within user messages for deterministic cache prefix.
 * Moves non-text blocks (images, media) before text blocks within each user message.
 * This ensures attachments always appear at the start of a message, preventing
 * cache prefix invalidation when the user sends text+image in varying orders.
 *
 * Only reorders within user messages. Assistant and tool messages are unchanged.
 * Must run AFTER structuredClone and BEFORE any cache_control marker placement.
 */
export function reorderContentForStablePrefix(messages: Array<Record<string, unknown>>): void {
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    const content = msg.content as Array<Record<string, unknown>>;
    if (content.length <= 1) continue;

    // Partition: non-text blocks first, then text blocks (stable sort within groups)
    const nonText: Array<Record<string, unknown>> = [];
    const text: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (block.type === "text") {
        text.push(block);
      } else {
        nonText.push(block);
      }
    }

    // Only reorder if there are both types (avoid unnecessary mutations)
    if (nonText.length > 0 && text.length > 0) {
      msg.content = [...nonText, ...text];
    }
  }
}

/**
 * Strip thinking blocks from EVERY assistant message in the outgoing (replayed) request.
 *
 * Why: the LCD codec (parts-codec) reconstructs assistant messages WITHOUT thinking
 * (topLevelReasoningOnly), but the SDK's in-memory conversation carries thinking on the
 * ACTIVE tool cycle (the last assistant in the request). Keeping only that last
 * assistant's thinking is exactly what breaks the cache: the block is written WITH
 * thinking (this call, where it is the active/last assistant) and re-sent WITHOUT
 * thinking the next call (when a newer assistant arrives and it becomes
 * historical → stripped) → the cached prefix mutates at that index every turn boundary →
 * read collapse + re-write on thinking-heavy (coding) turns. Stripping thinking from
 * EVERY replayed assistant (no keep-last exception) makes the cached form byte-identical to
 * the durable LCD form (zero historical thinking) so the prefix never mutates. Anthropic
 * tolerates a tool-use assistant with no thinking block as the active cycle — validated live
 * (zero 400s, correct multi-step coding, total cache-read +5%, cache-write -38%). This only
 * strips messages being REPLAYED; the model's generation-time thinking is unaffected.
 * Mirrors `stripTransientRecallFromHistory`.
 *
 * Mutates messages in place. Returns the number of messages whose thinking was stripped.
 */
export function stripReplayThinking(messages: Array<Record<string, unknown>>): number {
  let stripped = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const content = msg.content as Array<Record<string, unknown>>;
    const filtered = content.filter(b => b.type !== "thinking");
    if (filtered.length < content.length) { msg.content = filtered; stripped++; }
  }
  return stripped;
}

/**
 * Strip the TRANSIENT inline-recall block from every HISTORICAL user message,
 * keeping it only on the latest user message (the current turn).
 *
 * Why: `envelope-wrapper` prepends a top-1 RAG recall block
 * (`[Relevant context from memory: … (recorded …)]`) to the current user turn
 * for attention. That block is query-varying and per-turn — it is meant to be
 * TRANSIENT (the LCD store strips it at ingest for exactly this reason). But the
 * SDK's in-memory conversation accumulates the un-stripped, recall-prefixed
 * messages, so the message list sent to Anthropic carries the recall block on
 * historical turns. Whether a given historical message still shows the block then
 * diverges between requests, mutating the CACHED PREFIX every turn → the prefix
 * never matches → cache_creation is re-paid on the whole growing suffix.
 *
 * Removing it from the cached prefix (all but the latest user message) makes those
 * messages byte-stable turn-over-turn while preserving the inline recall on the
 * current turn (the uncached tail). Mirrors `clearStaleThinkingBlocks` — a
 * prefix-stabilizing strip that runs after structuredClone and before any
 * cache_control marker placement.
 *
 * Mutates messages in place. Returns the number of messages whose text changed.
 */
export function stripTransientRecallFromHistory(messages: Array<Record<string, unknown>>): number {
  // Index of the latest user message — its recall block is the current turn's and stays.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx <= 0) return 0; // nothing historical to strip

  let stripped = 0;
  for (let i = 0; i < lastUserIdx; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    const content = msg.content;

    if (typeof content === "string") {
      const cleaned = stripInlineRecalledMemory(content);
      if (cleaned !== content) { msg.content = cleaned; stripped++; }
      continue;
    }

    if (Array.isArray(content)) {
      // The recall block was prepended to the message text → it lives at the start
      // of the first text block (image/media blocks may precede it after reorder).
      const blocks = content as Array<Record<string, unknown>>;
      const textBlock = blocks.find(b => b.type === "text");
      if (textBlock && typeof textBlock.text === "string") {
        const cleaned = stripInlineRecalledMemory(textBlock.text);
        if (cleaned !== textBlock.text) { textBlock.text = cleaned; stripped++; }
      }
    }
  }
  return stripped;
}

/** Matches a deferred trailing recall block (used to detect/skip it on later passes). */
const RECALL_PREFIX_RE = /^\s*\[Relevant context from memory:/;

/**
 * Move the inline-recall block on the CURRENT (latest) user message off the cached
 * prefix and onto the UNCACHED tail.
 *
 * Why: `envelope-wrapper` prepends the top-1 RAG recall block to the
 * current user query, and pi-ai marks that message's last block with cache_control — so
 * the recall is CACHED while it's the current turn. The next call, that message goes
 * historical and `stripTransientRecallFromHistory` removes the recall → the
 * cached prefix mutates at that message → read collapse + a re-write of everything after
 * it (the dominant turn-boundary re-write).
 *
 * Unlike thinking (regenerated, so strippable everywhere — see `stripReplayThinking`),
 * recall is FUNCTIONAL input the model needs on the current turn, so it can't be removed.
 * Instead: split it out of the cache-marked query block (the query KEEPS its cache_control,
 * staying cached and byte-stable) and append it as a SEPARATE trailing block with NO
 * cache_control. Anthropic caches up to the marked query block; the trailing recall block
 * sits AFTER the fence → visible to the model, never cached → no mutation when it later
 * goes historical and is stripped. The query block is byte-identical to its
 * recall-stripped historical form next turn, so it stays a cache hit.
 *
 * Runs AFTER `stripTransientRecallFromHistory` (which keeps recall on the latest message)
 * and BEFORE/independent of marker placement (the SDK marker is already on the last block).
 * Mutates messages in place. Returns 1 if it deferred a recall block, else 0.
 */
export function deferRecallToUncachedTail(messages: Array<Record<string, unknown>>): number {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return 0;
  const msg = messages[lastUserIdx]!;
  const content = msg.content;

  if (typeof content === "string") {
    const { recall, rest } = extractInlineRecalledMemory(content);
    if (!recall || rest.trim().length === 0) return 0;
    msg.content = [
      { type: "text", text: rest },
      { type: "text", text: recall.trim() },
    ];
    return 1;
  }

  if (Array.isArray(content)) {
    const blocks = content as Array<Record<string, unknown>>;
    // The recall-bearing block (recall is prepended to the message text). Target it by
    // content so the cache_control (on the last block) is preserved on the query remainder.
    const recallBlock = blocks.find(
      b => b.type === "text" && typeof b.text === "string" && RECALL_PREFIX_RE.test(b.text as string),
    );
    if (!recallBlock) return 0;
    const { recall, rest } = extractInlineRecalledMemory(recallBlock.text as string);
    if (!recall || rest.trim().length === 0) return 0;
    recallBlock.text = rest; // query remainder keeps its cache_control → stays cached + stable
    // Append the recall AFTER the cache fence (the SDK marker is on the last block) so it
    // rides the uncached tail. No cache_control on this block.
    blocks.push({ type: "text", text: recall.trim() });
    return 1;
  }
  return 0;
}

/**
 * Strip the TRANSIENT inline-recall block from every HISTORICAL user-message item in an
 * OpenAI **Responses-API `input`** array, keeping it only on the latest user message.
 *
 * Why: the Anthropic prefix-stabilizers (`stripTransientRecallFromHistory` /
 * `deferRecallToUncachedTail`) are gated to
 * Anthropic-family providers (the cache_control machinery would 400 the Responses tools), so
 * they NEVER run for openai-codex — and Comis's request-body injector passes through entirely
 * for it. Result: the recall block on a user item is present while it's the current turn but
 * gets dropped once it goes historical (SDK-conversation vs LCD-reconstruction divergence) →
 * the OpenAI `input` prefix MUTATES at that user item → automatic prefix-cache collapse to the
 * instructions+tools floor (confirmed live: every cached_tokens drop coincided with a user
 * item going r1→none). Consistently stripping recall from all HISTORICAL user items (keeping
 * the latest for the model) makes the input prefix byte-stable → the auto-cache holds.
 *
 * TOOL-SAFE: only touches `type:"message", role:"user"` items' text — never the `type:"function"`
 * tools / `function_call` / `reasoning` items (so it cannot trigger the Responses 400 the
 * cache_control machinery does). Mutates in place. Returns the number of items changed.
 */
export function stripTransientRecallFromResponsesInput(input: Array<Record<string, unknown>>): number {
  let lastUserIdx = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i]!.role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx <= 0) return 0; // nothing historical to strip

  let stripped = 0;
  for (let i = 0; i < lastUserIdx; i++) {
    const it = input[i]!;
    // Match user items by ROLE only. pi-ai emits Responses user items as
    // { role:"user", content:[{type:"input_text",text}] } with NO item-level `type`
    // (only assistant items carry type:"message"). function_call/function_call_output/
    // reasoning items have no user role, so this stays tool-safe.
    if (it.role !== "user") continue;
    const content = it.content;
    if (typeof content === "string") {
      const cleaned = stripInlineRecalledMemory(content);
      if (cleaned !== content) { it.content = cleaned; stripped++; }
      continue;
    }
    if (Array.isArray(content)) {
      // Responses user content = [{ type: "input_text", text }] (recall prepended to the text).
      const textBlock = (content as Array<Record<string, unknown>>).find(b => typeof b.text === "string");
      if (textBlock && typeof textBlock.text === "string") {
        const cleaned = stripInlineRecalledMemory(textBlock.text);
        if (cleaned !== textBlock.text) { textBlock.text = cleaned; stripped++; }
      }
    }
  }
  return stripped;
}

/**
 * Strip ALL replayed `reasoning` items from an OpenAI Responses `input` array — the OpenAI
 * analog of {@link stripReplayThinking}.
 *
 * Why: on the native openai Responses API (`store: false`), the
 * pi-coding-agent conversation manager keeps `reasoning` items (which carry `encrypted_content`
 * for cross-step continuity) for RECENT turns but DROPS them from OLDER turns as the
 * conversation grows. A reasoning item present at an early index one turn is therefore gone the
 * next → the auto-cached prefix MUTATES at that index → a floor-collapse (confirmed live:
 * `DIV@2 reasoning->function_call` coincided with a cacheRead drop to the ~22.5k floor; with
 * this strip the same conversation is fully monotonic 19968→35840, zero collapses).
 *
 * Stripping only the OLD ones can't byte-stabilise (a kept current-turn reasoning item is cached
 * this turn, then goes historical and is dropped next turn — the same boundary mutation). The
 * only byte-stable option is removing them CONSISTENTLY, every call. SAFE: the SDK already drops
 * aged reasoning and OpenAI still returns 200 (verified live: all turns ok, no 400). QUALITY
 * CAVEAT (bounded, reversible — the same tradeoff as {@link stripReplayThinking}): the model
 * re-reasons each step instead of
 * resuming the encrypted chain; reasoning-quality impact is unmeasured but the conclusions
 * (assistant messages + tool results) remain in context. Gated by the caller to the native
 * `openai`/Azure Responses path (codex keeps its reasoning stable and was already optimal).
 *
 * TOOL-SAFE: only removes `type:"reasoning"` items — never function_call / function_call_output
 * / message items. Mutates in place. Returns the count removed.
 */
export function stripReplayReasoningFromResponsesInput(input: Array<Record<string, unknown>>): number {
  let removed = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i]!.type === "reasoning") {
      input.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

/**
 * Defer the inline-recall block on the CURRENT (latest) user item of an OpenAI Responses
 * `input` array off the cacheable prefix and onto the UNCACHED tail.
 *
 * Why: stripping recall from HISTORICAL items alone
 * (`stripTransientRecallFromResponsesInput`) is INSUFFICIENT — the LATEST user item still
 * carries recall, so this turn's auto-cache WRITE includes "U_latest + recall". Next turn that
 * item goes historical and the LCD rebuild emits it CLEAN (recall is transient, never
 * persisted) → the cached prefix MUTATES at that item → automatic prefix-cache collapse to the
 * instructions+tools floor. Confirmed live: every cached_tokens drop coincided with a user
 * item going r1→none one turn AFTER it was the current turn. Stripping historical items cannot
 * undo a cache WRITE that already happened with recall embedded.
 *
 * Fix (mirrors the Anthropic `deferRecallToUncachedTail`): strip recall from the latest user
 * item — so it is byte-identical to its future historical/clean form — and re-attach the recall
 * as a SEPARATE trailing user item. The model still sees the recall this turn (last item =
 * freshest position), but recall never embeds in a user item that gets cached-then-rebuilt-clean.
 * The trailing item is transient (onPayload only, never persisted), so next turn it is simply
 * absent and the prefix up to the clean latest user item is byte-stable → the auto-cache holds.
 *
 * TOOL-SAFE: only reads/writes type:"message",role:"user" items and appends one trailing user
 * item — never touches function/function_call/reasoning items. Mutates in place. Returns 1 if it
 * deferred a recall block, else 0.
 */
export function deferRecallToTrailingResponsesItem(input: Array<Record<string, unknown>>): number {
  let lastUserIdx = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    // Match by ROLE only — pi-ai user items have no item-level `type` (see
    // stripTransientRecallFromResponsesInput). tool/reasoning items have no user role.
    if (input[i]!.role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return 0;
  const msg = input[lastUserIdx]!;
  const content = msg.content;
  const wasString = typeof content === "string";

  let recall: string;
  if (wasString) {
    const ex = extractInlineRecalledMemory(content as string);
    // Keep recall inline if removing it would leave the query empty (recall-only turn): an
    // empty user item is invalid, and a recall-only turn has no stable prefix to protect.
    if (!ex.recall || ex.rest.trim().length === 0) return 0;
    recall = ex.recall.trim();
    msg.content = ex.rest;
  } else if (Array.isArray(content)) {
    const blocks = content as Array<Record<string, unknown>>;
    const textBlock = blocks.find(
      b => typeof b.text === "string" && RECALL_PREFIX_RE.test(b.text as string),
    );
    if (!textBlock) return 0;
    const ex = extractInlineRecalledMemory(textBlock.text as string);
    if (!ex.recall || ex.rest.trim().length === 0) return 0;
    recall = ex.recall.trim();
    textBlock.text = ex.rest;
  } else {
    return 0;
  }

  // Append the recall as a SEPARATE trailing user item (uncached tail), mirroring the latest
  // item's shape: same content form (raw string vs input_text-block array) and the same
  // item-level `type` presence (pi-ai user items have none; assistant items use "message").
  const trailing: Record<string, unknown> = {
    role: "user",
    content: wasString
      ? recall
      : [
          { type: "input_text", text: recall },
        ],
  };
  if (typeof msg.type !== "undefined") trailing.type = msg.type;
  input.push(trailing);
  return 1;
}
