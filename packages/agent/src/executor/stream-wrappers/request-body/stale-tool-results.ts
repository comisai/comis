// SPDX-License-Identifier: Apache-2.0
/**
 * Stale tool-result microcompaction.
 *
 * Lifted out of `tool-result-clearing.ts` (at its size cap) so the traversal below has room to be
 * shape-correct rather than provider-specific.
 *
 * A tool result reaches this layer in one of TWO structural arrangements, not merely under two field
 * names:
 *
 *  - **message-level** — a top-level `role: "tool"` message whose `tool_use_id` names the call
 *    (the Anthropic Messages arrangement);
 *  - **block-level** — a `user` message carrying one or more `{toolResult}` blocks, each naming its
 *    own call (the Bedrock Converse arrangement, where several results are deliberately packed into
 *    a single user message).
 *
 * The previous implementation understood only the first, and identified calls by
 * `block.type === "tool_use"`. On Bedrock that meant the tool-name map came out EMPTY, no message
 * ever matched `role === "tool"`, and the edit/write input pass found nothing — so tool-result
 * compaction did not run at all on that provider and context grew without bound.
 *
 * Both arrangements are enumerated as {@link ToolResultUnit}s so the keep-window, the cache fence,
 * and the compactable-tool filter apply identically regardless of provider.
 *
 * @module
 */

import {
  blockKind,
  setToolCallInput,
  setToolResultPlaceholder,
  toolCallId,
  toolCallInput,
  toolCallName,
  toolResultCallId,
  toolResultTextLength,
} from "./block-kind.js";

/** The placeholder a compacted result carries. Byte-stable, so re-sending it never moves the prefix. */
const CLEARED_PLACEHOLDER = "[Stale tool result cleared: idle > TTL]";

/**
 * One compactable tool result, wherever it structurally lives. `messageIndex` drives the cache-fence
 * check; `clear()` writes the placeholder into whichever arrangement produced this unit.
 */
interface ToolResultUnit {
  messageIndex: number;
  callId: string | undefined;
  textLength: number;
  clear: () => boolean;
}

/** Map every tool call id seen on an assistant turn to its tool name, across both wire shapes. */
function indexToolNames(messages: Array<Record<string, unknown>>): Map<string, string> {
  const byId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (blockKind(block) !== "tool_use") continue;
      const id = toolCallId(block);
      const name = toolCallName(block);
      if (id !== undefined && name !== undefined) byId.set(id, name);
    }
  }
  return byId;
}

/**
 * Enumerate every tool result in message order — message-level units first-class alongside
 * block-level ones, so ordering (and therefore the keep-window) matches the conversation.
 */
function collectToolResultUnits(messages: Array<Record<string, unknown>>): ToolResultUnit[] {
  const units: ToolResultUnit[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === "tool") {
      units.push({
        messageIndex: i,
        callId: toolResultCallId(msg),
        textLength: toolResultTextLength(msg),
        clear: () => {
          msg.content = [{ type: "text", text: CLEARED_PLACEHOLDER }];
          return true;
        },
      });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (blockKind(block) !== "tool_result") continue;
      units.push({
        messageIndex: i,
        callId: toolResultCallId(block),
        textLength: toolResultTextLength(block),
        clear: () => setToolResultPlaceholder(block, CLEARED_PLACEHOLDER),
      });
    }
  }
  return units;
}

/**
 * Clear stale tool results, preserving the most recent `keepWindow` of them.
 *
 * Only read-only (compactable) tools are cleared: an edit/write result carries confirmation of what
 * changed. A result whose call cannot be identified is left alone — the conservative branch, since an
 * unmatched id means the map is incomplete rather than that the result is disposable.
 *
 * @param messages - the request's messages (mutated in place)
 * @param keepWindow - number of most recent tool results to preserve
 * @param fenceIndex - highest cached message index; nothing at/below it is rewritten
 * @param compactableToolNames - read-only tool names whose output is safe to drop
 * @param clearableUsesToolNames - edit/write tool names whose INPUT is safe to drop
 * @param minContentLength - only compact a payload at least this long
 * @returns number of results (and inputs) cleared
 */
export function clearStaleToolResults(
  messages: Array<Record<string, unknown>>,
  keepWindow: number,
  fenceIndex: number,
  compactableToolNames: ReadonlySet<string>,
  clearableUsesToolNames: ReadonlySet<string>,
  minContentLength: number,
): number {
  const toolNameById = indexToolNames(messages);
  const units = collectToolResultUnits(messages);
  const clearable = units.slice(0, Math.max(0, units.length - keepWindow));

  let cleared = 0;
  for (const unit of clearable) {
    if (unit.messageIndex <= fenceIndex) continue;
    // The tool-name filter applies only when the result names its call. A result carrying no call id
    // cannot be attributed to an edit/write tool, so it stays clearable — preserved from the
    // pre-extraction behaviour, which the microcompact trigger tests pin. An id that IS present but
    // unknown means the map is incomplete, which is the conservative skip.
    if (unit.callId !== undefined) {
      const toolName = toolNameById.get(unit.callId);
      if (toolName === undefined) continue;
      if (!compactableToolNames.has(toolName)) continue;
    }
    if (unit.textLength < minContentLength) continue;
    if (unit.clear()) cleared++;
  }

  // Second pass — drop the ARGUMENTS of a settled edit/write call. They hold the full content the
  // model asked to write, which is dead weight once the result confirmed it.
  const callTurns: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    if ((msg.content as Array<Record<string, unknown>>).some(b => blockKind(b) === "tool_use")) {
      callTurns.push(i);
    }
  }
  for (const idx of callTurns.slice(0, Math.max(0, callTurns.length - keepWindow))) {
    if (idx <= fenceIndex) continue;
    for (const block of messages[idx]!.content as Array<Record<string, unknown>>) {
      if (blockKind(block) !== "tool_use") continue;
      const name = toolCallName(block);
      if (name === undefined || !clearableUsesToolNames.has(name)) continue;
      if (JSON.stringify(toolCallInput(block) ?? null).length < minContentLength) continue;
      setToolCallInput(block, { _cleared: true, reason: "stale edit/write input" });
      cleared++;
    }
  }

  return cleared;
}
