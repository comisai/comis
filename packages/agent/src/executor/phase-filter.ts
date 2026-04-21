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
 * Extract user-visible text from the last assistant message in a session.
 *
 * When the last assistant message contains commentary-phase text blocks,
 * filters them out and returns only visible text. Otherwise delegates to
 * the SDK's getLastAssistantText() method.
 */
export function getVisibleAssistantText(session: any): string {
  const messages: any[] | undefined = session?.messages;

  // Find last non-aborted assistant message
  const lastAssistant = Array.isArray(messages)
    ? messages
        .slice()
        .reverse()
        .find((m: any) => {
          if (m.role !== "assistant") return false;
          if (m.stopReason === "aborted" && m.content?.length === 0) return false;
          return true;
        })
    : undefined;

  // Only activate phase filtering when commentary blocks are present
  const hasCommentary = lastAssistant?.content?.some(
    (b: any) => b?.type === "text" && parsePhase(b.textSignature) === "commentary",
  ) ?? false;

  if (hasCommentary) {
    return lastAssistant.content
      .filter(isVisibleTextBlock)
      .map((b: any) => b.text)
      .join("");
  }

  // No commentary — delegate to SDK method
  return session?.getLastAssistantText?.() ?? "";
}
/* eslint-enable @typescript-eslint/no-explicit-any */
