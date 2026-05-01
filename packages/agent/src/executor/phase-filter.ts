// SPDX-License-Identifier: Apache-2.0
/**
 * Phase-aware text extraction for multi-block LLM responses.
 *
 * The OpenAI Responses API returns text content blocks with a textSignature
 * field encoding a phase ("commentary" or "final_answer"). Commentary
 * blocks are internal model narration that must not reach users.
 *
 * @module
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Parse phase from a textSignature JSON string. */
export function parsePhase(textSignature: unknown): string | undefined {
  if (typeof textSignature !== "string" || textSignature[0] !== "{") return undefined;
  try {
    const parsed = JSON.parse(textSignature);
    if (parsed.v === 1) return parsed.phase;
  } catch { /* malformed signature — treat as no phase */ }
  return undefined;
}

/** True if a content block is user-visible text (not commentary). */
export function isVisibleTextBlock(block: any): boolean {
  return (
    block?.type === "text" &&
    typeof block.text === "string" &&
    parsePhase(block.textSignature) !== "commentary"
  );
}

/**
 * Extract user-visible text from the last "real" assistant message.
 *
 * Filters non-real assistants from the tail walk:
 *   - aborted-empty (stopReason "aborted" + empty content) — original.
 *   - error-empty (stopReason "error" + empty content) — sibling of
 *     aborted-empty, marks failed LLM calls (e.g. 429 / 5xx swallowed
 *     inside pi-ai's stream wrapper, surfaced as empty content).
 *   - synthetic-injected (model === "synthetic") — appended by
 *     orphaned-message-repair.ts to restore role alternation after a
 *     daemon restart; not user-visible LLM output.
 *   - cross-turn boundary (role === "user" encountered before a
 *     qualifying assistant) — return "" because the user message marks
 *     the start of the current execution window; assistants before it
 *     belong to prior turns (260501-gyy).
 *
 * When the resulting last assistant contains commentary-phase text
 * blocks, drops them and returns only visible text. Otherwise returns
 * the visible (non-commentary) text blocks of the last assistant
 * directly — does NOT delegate to session.getLastAssistantText(),
 * which walks past empty messages and would re-introduce the
 * synthetic-leak (260501-egj).
 */
export function getVisibleAssistantText(session: any): string {
  const messages: any[] | undefined = session?.messages;

  // Find last "real" assistant message in the CURRENT execution window —
  // skip aborted-empty, error-empty, and synthetic-injected; stop at the
  // first user message (turn boundary) to avoid leaking prior-turn text
  // (260501-gyy).
  const lastAssistant = (() => {
    if (!Array.isArray(messages)) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]; // eslint-disable-line security/detect-object-injection
      // Crossed turn boundary — assistants before this user message belong
      // to a prior turn and must not be returned.
      if (m?.role === "user") return undefined;
      // toolResult / tool / other roles — keep walking within current turn.
      if (m?.role !== "assistant") continue;
      // Skip aborted-empty (existing behavior — preserved).
      if (m.stopReason === "aborted" && m.content?.length === 0) continue;
      // Skip error-empty — failed LLM calls (e.g. 429 swallowed inside
      // pi-ai's stream wrapper).
      if (m.stopReason === "error" && m.content?.length === 0) continue;
      // Skip synthetic-injected — orphaned-message-repair scaffolding.
      if (m.model === "synthetic") continue;
      return m;
    }
    return undefined;
  })();

  // Only activate phase filtering when commentary blocks are present.
  const hasCommentary = lastAssistant?.content?.some(
    (b: any) => b?.type === "text" && parsePhase(b.textSignature) === "commentary",
  ) ?? false;

  if (hasCommentary) {
    return lastAssistant.content
      .filter(isVisibleTextBlock)
      .map((b: any) => b.text)
      .join("");
  }

  // No commentary — return lastAssistant's visible text directly.
  // Do NOT delegate to session.getLastAssistantText() because it walks
  // past empty messages (aborted/error/etc.) and re-introduces the
  // synthetic-leak (production bug 260501-egj: post-restart-resumption
  // rate-limit returned synthetic placeholder instead of the
  // 260501-cur "Rate limit exceeded" terminal error).
  if (!lastAssistant?.content || !Array.isArray(lastAssistant.content)) return "";
  return lastAssistant.content
    .filter(isVisibleTextBlock)
    .map((b: any) => b.text)
    .join("");
}
/* eslint-enable @typescript-eslint/no-explicit-any */
