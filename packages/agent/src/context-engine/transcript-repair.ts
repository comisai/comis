// SPDX-License-Identifier: Apache-2.0
/**
 * Transcript repair — the `tool_use`<->`tool_result` pairing invariant.
 *
 * A self-contained, pure transform over the canonical pi-ai `Message[]`
 * (`AgentMessage[]` at the boundary). It runs as the FINAL step of LCD
 * assembly (`lcd-assembler.ts`) on EVERY assembled array — in both the live
 * loop and the provider-boundary harness — which is what makes the invariant
 * un-skippable.
 *
 * Providers HARD-REJECT a transcript where an assistant `tool_use` block is
 * not immediately followed by its matching `tool_result`, where a `tool_result`
 * has no preceding call, or where a turn is left with a dangling unpaired call.
 * An assembler without such a pass can emit a flattened, unpaired array —
 * exactly what produces a provider-rejection tool-call loop. This module
 * guarantees a provider-valid pairing on ANY input:
 *
 *  - REORDER  — an out-of-order `tool_result` is re-placed immediately after
 *    its `tool_use` (in tool_use BLOCK order for a multi-call turn).
 *  - SYNTHESIZE — an assistant `tool_use` with no matching result gets a marked
 *    error placeholder ({@link makeMissingToolResult}); no call is left unpaired.
 *  - DROP ORPHAN — a `tool_result` whose `toolCallId` matches no call is dropped.
 *  - DROP DUPLICATE — a second `tool_result` for an already-resolved id is dropped.
 *  - STRIP ABORTED — an assistant turn with `stopReason "error" | "aborted"` has
 *    its dangling `tool_use` blocks removed (text/thinking preserved), so no
 *    unpaired call survives and no result is synthesized for the aborted call.
 *
 * Reasoning (`ThinkingContent`) is never re-introduced, reordered, or dropped:
 * the codec already excludes `topLevelReasoningOnly` reasoning on reconstruction
 * (parts-codec.ts:118) and this pass runs on reconstructed messages, so blocks
 * are carried through in place.
 *
 * Pure + deterministic: no DB, no clock read. The caller injects `now` for the
 * synthesized placeholder timestamp (the assembler passes `deps.clock.now()`),
 * which keeps the transform fully testable. Inputs are never mutated — every
 * emitted assistant rewrite, every synthesized result, and the output array are
 * fresh objects (the `orphaned-message-repair.ts` "preserve originals" stance).
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** The literal marker carried by every synthesized placeholder result. */
const SYNTHESIZED_RESULT_MARKER = "[tool result missing — synthesized placeholder]";

const ABORTED_STOP_REASONS = new Set(["error", "aborted"]);

// ---------------------------------------------------------------------------
// Structural narrowing over the opaque AgentMessage.
//
// AgentMessage = Message | CustomAgentMessages[...]; we narrow on `role` and a
// block's `.type` rather than importing the concrete pi-ai subtypes at runtime
// (type-only import only — keeps the agent free of any extra coupling). The
// repair reads exactly: a message's `role`, an assistant's `content` blocks +
// `stopReason`, and a tool_result's `toolCallId`.
// ---------------------------------------------------------------------------

/**
 * A content block as this transform reads it. Deliberately structural and NOT
 * an intersection with the concrete pi-ai `TextContent | ThinkingContent |
 * ToolCall` union — those subtypes have no string index signature, so widening
 * to them would reject the looser `[k: string]` shape. We narrow on `.type`.
 */
interface ContentBlock {
  type: string;
  [k: string]: unknown;
}

/** Structural view of an assistant message (own type, never `& AgentMessage`). */
interface AssistantLike {
  role: "assistant";
  content: ContentBlock[];
  stopReason?: string;
}

/**
 * The set of `type` aliases a tool-call (a.k.a. tool_use) content block can
 * carry at the context-engine boundary. The canonical pi-ai shape is
 * `"toolCall"`, but the PIPELINE path operates on raw, un-normalized messages
 * whose call blocks may also arrive as `"tool_call"`, `"toolUse"`, or
 * `"tool_use"` (the Anthropic Messages-API shape) depending on the provider /
 * persisted source. The other pipeline layers already accept these aliases
 * (history-window: toolCall|toolUse; dead-content-evictor: toolCall|tool_use;
 * signature-replay-scrubber: toolCall|tool_call) — transcript repair MUST too,
 * or it would mistake a legitimately-paired call for ABSENT and DROP its result
 * as an orphan. The DAG/LCD path only ever emits `"toolCall"`, so the extra
 * aliases are a strict superset there (no behavior change).
 */
const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "tool_call", "toolUse", "tool_use"]);

interface ToolCallBlock extends ContentBlock {
  type: "toolCall" | "tool_call" | "toolUse" | "tool_use";
  id: string;
  name?: string;
}

/** Structural view of a top-level tool_result message. */
interface ToolResultLike {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
}

function roleOf(m: AgentMessage): string | undefined {
  return (m as unknown as { role?: string }).role;
}

/**
 * Narrow to a structural {@link AssistantLike} (NOT `AgentMessage & ...`): the
 * intersection would resolve `.content` to the pi-ai union element type, which
 * lacks the index signature {@link isToolCallBlock} needs. We re-cast via
 * `unknown` so the body iterates `ContentBlock[]`.
 */
function asAssistant(m: AgentMessage): AssistantLike | null {
  if (roleOf(m) !== "assistant") return null;
  const content = (m as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  return m as unknown as AssistantLike;
}

function asToolResult(m: AgentMessage): ToolResultLike | null {
  if (roleOf(m) !== "toolResult") return null;
  if (typeof (m as unknown as { toolCallId?: unknown }).toolCallId !== "string") return null;
  return m as unknown as ToolResultLike;
}

function isToolCallBlock(b: ContentBlock): b is ToolCallBlock {
  return TOOL_CALL_BLOCK_TYPES.has(b.type) && typeof (b as ToolCallBlock).id === "string";
}

function isAbortedAssistant(m: AssistantLike): boolean {
  const sr = m.stopReason;
  return typeof sr === "string" && ABORTED_STOP_REASONS.has(sr);
}

// ---------------------------------------------------------------------------
// Synthetic / rewrite builders (never mutate inputs).
// ---------------------------------------------------------------------------

/**
 * Build a synthesized placeholder for an assistant `tool_use` that has no
 * matching `tool_result`. Providers reject an unpaired call, so the invariant
 * fills the gap rather than dropping the call.
 *
 * SECURITY: the placeholder is marked `isError: true` AND its only
 * content is the explicit literal {@link SYNTHESIZED_RESULT_MARKER}, so the
 * model can never read it as a genuine tool output. Both markers are asserted
 * by the synthesize-missing test.
 */
function makeMissingToolResult(
  toolCallId: string,
  toolName: string | undefined,
  now: number,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: toolName ?? "unknown",
    content: [{ type: "text", text: SYNTHESIZED_RESULT_MARKER }],
    isError: true,
    timestamp: now,
  } as unknown as AgentMessage;
}

/**
 * Return a NEW assistant message with all `toolCall` blocks removed from its
 * content, preserving text/thinking and every other field
 * (strip-dangling-blocks-keep-text). Used for aborted/errored turns whose calls
 * never completed — leaving the calls would put an unpaired `tool_use` in front
 * of the provider. Never mutates the input.
 */
function stripDanglingToolUseBlocks(m: AgentMessage, a: AssistantLike): AgentMessage {
  const kept = a.content.filter((b) => !isToolCallBlock(b));
  return { ...(m as object), content: kept } as unknown as AgentMessage;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transcript repair: guarantee a provider-valid `tool_use`<->`tool_result`
 * pairing on the assembled array. The FINAL assembly step (`lcd-assembler.ts`).
 *
 * Three passes:
 *  - **Pass A** — index every assistant `toolCall.id` into `toolUseSeen`.
 *  - **Pass B** — collect `tool_result` messages by `toolCallId`; DROP an orphan
 *    (id not in `toolUseSeen`) and DROP a duplicate (id already collected).
 *  - **Pass C** — rebuild in original order, SKIPPING `tool_result` messages
 *    (re-placed here). For an aborted/errored assistant turn, push the
 *    dangling-call-stripped rewrite and continue. For any other assistant turn,
 *    push it, then for each `toolCall` block in BLOCK order push its collected
 *    result or a synthesized placeholder. Every other message is passed through.
 *
 * Pure + deterministic — the caller injects `now` for synthesized timestamps.
 *
 * @param messages - the assembled pi-ai `Message[]` (may be malformed)
 * @param now - injected wall-clock ms for synthesized placeholder timestamps
 * @returns a provider-valid array where every `tool_use` is immediately
 *   followed by its matching `tool_result`
 */
export function sanitizeToolUseResultPairing(
  messages: AgentMessage[],
  now: number,
): AgentMessage[] {
  // A non-array input degrades to a PASS-THROUGH, never an empty array: the SDK
  // transformContext contract is "return the original messages or another safe
  // fallback" (context-engine.ts's "never no-op the whole context" stance), so
  // nuking a malformed shape to [] would silently drop the entire conversation.
  // An EMPTY well-formed array is a genuine no-op and returns [].
  if (!Array.isArray(messages)) return messages;
  if (messages.length === 0) return [];

  // Pass A — index every tool_use id an assistant turn emitted.
  const toolUseSeen = new Set<string>();
  for (const m of messages) {
    const a = asAssistant(m);
    if (!a) continue;
    for (const b of a.content) {
      if (isToolCallBlock(b)) {
        toolUseSeen.add(b.id);
      }
    }
  }

  // Pass B — collect results by toolCallId; drop orphans and duplicates.
  const resultByCallId = new Map<string, AgentMessage>();
  for (const m of messages) {
    const r = asToolResult(m);
    if (!r) continue;
    const id = r.toolCallId;
    if (!toolUseSeen.has(id)) continue; // orphan — no matching call
    if (resultByCallId.has(id)) continue; // duplicate — keep the first
    resultByCallId.set(id, m);
  }

  // Pass C — rebuild: each tool_use turn immediately followed by its result(s).
  const out: AgentMessage[] = [];
  for (const m of messages) {
    if (asToolResult(m)) {
      continue; // re-placed below, after its call
    }

    const a = asAssistant(m);
    if (a) {
      if (isAbortedAssistant(a)) {
        // Incomplete turn: strip dangling calls (keep text), synthesize nothing.
        out.push(stripDanglingToolUseBlocks(m, a));
        continue;
      }

      out.push(m);
      for (const b of a.content) {
        if (!isToolCallBlock(b)) continue;
        const result = resultByCallId.get(b.id);
        out.push(result ?? makeMissingToolResult(b.id, b.name, now));
      }
      continue;
    }

    // user (and any other top-level role) — passed through unchanged.
    out.push(m);
  }

  return out;
}
