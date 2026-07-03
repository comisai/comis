// SPDX-License-Identifier: Apache-2.0
/**
 * Pure zone/estimation helpers for the LLM compaction layer.
 *
 * Extracted from llm-compaction.ts (file-size invariant: ≤800 lines) — these
 * are factory-independent pure functions over `AgentMessage[]`:
 *
 * - `extendHeadForPairSafety` — head-zone boundary extension so a trailing
 *   assistant tool_use and its tool_results never split across zones
 * - `estimateRangeChars` — char total for a half-open message range
 * - `clampFactorText` — the text of one message used to compute its
 *   scriptTokenFactor at the compaction span-clamp walk
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { dominantScript } from "@comis/core";
import type { TypedEventBus, ComisLogger, ErrorKind } from "@comis/core";
import { estimateMessageChars } from "../safety/token-estimator.js";

/**
 * Extend head boundary forward to include trailing tool_use/tool_result exchanges.
 * If the last message in the head zone is a user message followed by an assistant
 * with tool_use calls, extend to include the assistant + all matching tool_results.
 * This prevents orphaned tool results in the middle zone.
 */
export function extendHeadForPairSafety(
  messages: AgentMessage[],
  headEndIndex: number,
): number {
  let extended = headEndIndex;
  while (extended < messages.length) {
    const msg = messages[extended]!;
    // If next message is an assistant with tool_use, include it
    if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const hasToolUse = content.some(
        (block: any) => block.type === "tool_use" || block.type === "toolCall",
      );
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (hasToolUse) {
        extended++;
        // Include all subsequent tool_result messages
        while (
          extended < messages.length &&
          messages[extended]!.role === "toolResult"
        ) {
          extended++;
        }
        continue;
      }
    }
    break;
  }
  return extended;
}

/**
 * Estimate total chars for a range of messages [startIdx, endIdx).
 */
export function estimateRangeChars(
  messages: AgentMessage[],
  startIdx: number,
  endIdx: number,
): number {
  let total = 0;
  for (let i = startIdx; i < endIdx; i++) {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    total += estimateMessageChars(messages[i] as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  return total;
}

/**
 * The text of one message used to compute its
 * scriptTokenFactor at the compaction span-clamp walk — string content, or for
 * array content the concatenated text/thinking fields plus JSON.stringify of
 * toolCall arguments, mirroring what estimateContextCharsWithDualRatio counts.
 * A plain concat is sufficient for the FACTOR; the dual-ratio CHAR COUNT stays
 * authoritative and untouched (image/unknown blocks contribute flat synthetic
 * chars there and need no factor input here).
 */
export function clampFactorText(m: AgentMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (typeof block === "string") {
      out += block;
      continue;
    }
    if (block === null || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; thinking?: string; arguments?: unknown };
    if (typeof b.text === "string") {
      out += b.text;
    } else if (typeof b.thinking === "string") {
      out += b.thinking;
    } else if (b.type === "toolCall") {
      try {
        out += JSON.stringify(b.arguments ?? {});
      } catch {
        // Unstringifiable args contribute no factor text (the char walk's
        // TOOL_STRINGIFY_FALLBACK still counts them flat).
      }
    }
  }
  return out;
}

/**
 * The small-summarizer language-drift detector. Compare the dominant script
 * of a completed summary against its source chunk; when a NON-Latin source
 * produced a Latin summary, emit `context:summary_language_mismatch` (a weak
 * local summarizer silently writing English summaries of Hebrew chunks becomes
 * a counted `comis fleet` finding with the `strongerSummarizerModel` remedy hint).
 *
 * VISIBILITY ONLY — no gating, no rejection, no behavior change to the summarize
 * paths (validation-gating is deliberately rejected: a mixed code-heavy chunk
 * legitimately skews Latin via the 0.3 dominance threshold in `dominantScript`,
 * so this is a count an operator reviews, not an error to block). The emit is
 * strictly additive and GUARDED: a throwing subscriber NEVER fails the
 * summarize/compaction pass (the `onCondensed` non-fatal contract). The payload
 * carries the closed `ScriptClass` enums + a depth count + ids ONLY — NEVER the
 * summary or source body (log/event payloads never carry message content);
 * `dominantScript` reads the text locally and nothing leaks.
 *
 * @param eventBus - the site's typed bus (absent ⇒ a silent no-op via the `?.`)
 * @param logger   - structured logger for the guarded-emit failure WARN
 * @param args.sourceText  - the summarizer INPUT text (the source chunk)
 * @param args.summaryText - the completed summary text
 * @param args.depth       - dag depth (0 = leaf, >0 = condense); -1 = pipeline
 * @param args.nowMs       - the injected clock read for the event timestamp
 */
export function emitSummaryLanguageMismatch(
  eventBus: TypedEventBus | undefined,
  logger: Pick<ComisLogger, "warn">,
  args: {
    agentId: string;
    sessionKey: string;
    sourceText: string;
    summaryText: string;
    depth: number;
    nowMs: number;
  },
): void {
  // One O(n) dominantScript pass each. Fire ONLY on the predictable
  // small-summarizer failure: a non-Latin source whose summary came back Latin.
  const sourceScript = dominantScript(args.sourceText);
  if (sourceScript === "latin") return; // Latin (or code-heavy ⇒ latin) source — silent.
  const summaryScript = dominantScript(args.summaryText);
  if (summaryScript !== "latin") return; // summary preserved a non-Latin script — silent.

  try {
    eventBus?.emit("context:summary_language_mismatch", {
      agentId: args.agentId,
      sessionKey: args.sessionKey,
      sourceScript,
      summaryScript,
      depth: args.depth,
      timestamp: args.nowMs,
    });
  } catch (err) {
    // Guarded-emit (the onCondensed isolation pattern): observability NEVER
    // fails the summarize/compaction pass. Content-free WARN — no message bodies.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        agentId: args.agentId,
        sessionKey: args.sessionKey,
        hint: "context:summary_language_mismatch subscriber threw; signal dropped, summarization unaffected — inspect the failing event subscriber (trajectory writer / health-signal sink)",
        errorKind: "dependency" as ErrorKind,
      },
      "summary_language_mismatch emit failed (non-fatal)",
    );
  }
}
