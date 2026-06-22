// SPDX-License-Identifier: Apache-2.0
/**
 * The SINGLE factored per-message token estimator shared by the pre-flight fit
 * check (lcd-preflight.ts) and the protected-fresh-tail total bound
 * (lcd-fresh-tail-bound.ts `boundFreshTailTotalToResidual`).
 *
 * ISSUE #3 (2026-06-22): these two had DIFFERENT estimators — the pre-flight used
 * `ceil(chars / (CHARS_PER_TOKEN_RATIO × scriptTokenFactor))` (≈3.5:1) while the
 * fresh-tail bound used `estimateMessageTokens` (≈4:1) plus a ×0.83 fudge to absorb
 * the gap. The ABSOLUTE gap scales with the residual, so on a SMALL system prompt
 * (large residual — e.g. OpenAI gpt-5-nano S=1145 → residual ~6279) the fudge was
 * insufficient and the bounded fresh tail still measured over the pre-flight bound →
 * exhaustion. Single-sourcing the estimator here makes the bound == the measure for
 * ANY system-prompt size, with no fudge factor and no possibility of future drift.
 *
 * Pure leaf — depends only on the chars/token ratio constant, the script factor, and
 * the `AgentMessage` type. No cycle risk (imports nothing from lcd-preflight /
 * lcd-fresh-tail-bound / lcd-assembler).
 *
 * @module
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { scriptTokenFactor } from "@comis/core";
import { CHARS_PER_TOKEN_RATIO } from "./constants.js";

/**
 * The exact text of one message that the factored estimate counts: string content,
 * or the `text ?? content` field of each array block (the IN-01 multi-part /
 * tool-result shape — NOT text+content summed). The concatenation feeds
 * scriptTokenFactor so the factor is computed over precisely the chars whose length
 * is divided (TOK-01 identity-by-construction).
 */
export function messageText(m: AgentMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (typeof block === "string") {
      out += block;
    } else if (block !== null && typeof block === "object") {
      const b = block as { text?: string; content?: string };
      out += b.text ?? b.content ?? "";
    }
  }
  return out;
}

/**
 * The factored token estimate for one message: `ceil(chars / (CHARS_PER_TOKEN_RATIO
 * × scriptTokenFactor(text)))`. This is the pre-flight's per-message formula
 * (lcd-preflight.ts freshTailMsgTokens) — the authority for "does the fresh tail fit
 * the window". TOK-01: dense scripts carry ~2-3× tokens/char; ASCII factor 1.0 →
 * the bare `ceil(chars / 3.5)` form.
 */
export function factoredMessageTokens(m: AgentMessage): number {
  const text = messageText(m);
  return Math.ceil(text.length / (CHARS_PER_TOKEN_RATIO * scriptTokenFactor(text)));
}
