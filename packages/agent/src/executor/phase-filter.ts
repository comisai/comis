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

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { tryCatch } from "@comis/shared";

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
 *     belong to prior turns.
 *
 * When the resulting last assistant contains commentary-phase text
 * blocks, drops them and returns only visible text. Otherwise returns
 * the visible (non-commentary) text blocks of the last assistant
 * directly — does NOT delegate to session.getLastAssistantText(),
 * which walks past empty messages and would re-introduce the
 * synthetic-leak.
 */
export function getVisibleAssistantText(session: any): string {
  const messages: any[] | undefined = session?.messages;

  // Find last "real" assistant message in the CURRENT execution window —
  // skip aborted-empty, error-empty, and synthetic-injected; stop at the
  // first user message (turn boundary) to avoid leaking prior-turn text.
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
  // synthetic-leak (post-restart-resumption rate-limit returned synthetic
  // placeholder instead of the "Rate limit exceeded" terminal error).
  if (!lastAssistant?.content || !Array.isArray(lastAssistant.content)) return "";
  return lastAssistant.content
    .filter(isVisibleTextBlock)
    .map((b: any) => b.text)
    .join("");
}

export type FinalAssistantResponseSync =
  | "unchanged"
  | "updated"
  | "updated_memory_only"
  | "missing";

/**
 * Why a durable replacement could not be written.
 *
 * `leaf_precondition_mismatch` — the append-only leaf was not the assistant message being
 * corrected (usually a benign race). `append_failed` — the branch/append itself threw, which is
 * the genuine storage fault. These were previously indistinguishable at every surface: one
 * `updated_memory_only` result, one audit reason, and one WARN hint pointing at disk health.
 */
export type DurableReplacementFailureReason =
  | "leaf_precondition_mismatch"
  | "append_failed";

type DurablePersistOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DurableReplacementFailureReason };

/** Optional sink so callers can report WHICH durable failure occurred. */
export interface FinalAssistantSyncDiagnostics {
  durableFailureReason?: DurableReplacementFailureReason;
}

function matchingAssistantLeaf(persisted: any, live: any): boolean {
  if (persisted === live) return true;
  if (persisted?.role !== "assistant" || live?.role !== "assistant") return false;
  if (
    typeof persisted.timestamp !== "number"
    || persisted.timestamp !== live.timestamp
  ) {
    return false;
  }
  const persistedText = Array.isArray(persisted.content)
    ? persisted.content.filter(isVisibleTextBlock).map((block: any) => block.text).join("")
    : "";
  const liveText = Array.isArray(live.content)
    ? live.content.filter(isVisibleTextBlock).map((block: any) => block.text).join("")
    : "";
  return persistedText === liveText
    && persisted.provider === live.provider
    && persisted.model === live.model
    && persisted.stopReason === live.stopReason;
}

function persistAssistantReplacement(
  sessionManager: SessionManager,
  current: any,
  replacement: any,
): DurablePersistOutcome {
  const leaf = sessionManager.getLeafEntry();
  if (
    leaf?.type !== "message"
    || leaf.message.role !== "assistant"
    || !matchingAssistantLeaf(leaf.message, current)
  ) {
    // The append-only leaf is not the assistant message being corrected, so the replacement
    // cannot be branched onto it. This is normally a benign race (the leaf moved on), NOT the
    // disk fault an undifferentiated failure signal implies.
    return { ok: false, reason: "leaf_precondition_mismatch" };
  }

  const persisted = tryCatch(() => {
    if (leaf.parentId === null) {
      sessionManager.resetLeaf();
    } else {
      sessionManager.branch(leaf.parentId);
    }
    sessionManager.appendMessage(
      replacement as Parameters<SessionManager["appendMessage"]>[0],
    );
  });
  return persisted.ok ? { ok: true } : { ok: false, reason: "append_failed" };
}

/**
 * Keep the live canonical transcript aligned with the response that
 * post-processing will deliver.
 *
 * Runtime honesty, locale, and degradation guards may replace the model's
 * visible prose after the SDK appended its assistant message. Preserve
 * non-visible protocol blocks (reasoning, tool calls, commentary) and replace
 * only user-visible text so subsequent LCD ingest cannot persist a rejected
 * draft as conversation ground truth.
 */
export function synchronizeFinalAssistantResponse(
  session: any,
  response: string,
  sessionManager?: SessionManager,
  diagnostics?: FinalAssistantSyncDiagnostics,
): FinalAssistantResponseSync {
  const messages: any[] | undefined = session?.messages;
  if (!Array.isArray(messages)) return "missing";

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]; // eslint-disable-line security/detect-object-injection
    if (message?.role === "user") return "missing";
    if (message?.role !== "assistant") continue;
    if (
      (message.stopReason === "aborted" || message.stopReason === "error")
      && message.content?.length === 0
    ) {
      continue;
    }
    if (message.model === "synthetic") continue;

    const content = Array.isArray(message.content) ? message.content : [];
    const visible = content
      .filter(isVisibleTextBlock)
      .map((block: any) => block.text)
      .join("");
    if (visible === response) return "unchanged";

    const protocolBlocks = content.filter(
      (block: any) => !isVisibleTextBlock(block),
    );
    const replacement = {
      ...message,
      content: [...protocolBlocks, { type: "text", text: response }],
    };
    const durable: DurablePersistOutcome = sessionManager === undefined
      ? { ok: true }
      : persistAssistantReplacement(sessionManager, message, replacement);
    messages[index] = replacement; // eslint-disable-line security/detect-object-injection
    if (durable.ok) return "updated";
    if (diagnostics !== undefined) diagnostics.durableFailureReason = durable.reason;
    return "updated_memory_only";
  }

  return "missing";
}
/* eslint-enable @typescript-eslint/no-explicit-any */
