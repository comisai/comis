// SPDX-License-Identifier: Apache-2.0
/**
 * Scrub tool_use / tool_result pairs whose arguments were redacted by
 * sanitizeSessionSecrets() out of the LLM replay context.
 *
 * Why this exists:
 *   sanitizeSessionSecrets rewrites the on-disk JSONL to replace sensitive
 *   values (e.g. `env_value` in `gateway.env_set`) with the literal string
 *   "[REDACTED]". That makes the JSONL safe as an audit record, but the same
 *   JSONL is also what the SDK reads to rebuild the LLM context on the next
 *   turn. A model that sees its own prior `env_set` tool_use with
 *   `env_value: "[REDACTED]"` pattern-matches on it and sends "[REDACTED]"
 *   as the value on the NEXT env_set — which the daemon persists verbatim.
 *   Observed in production: CLOUDFLARE_ACCOUNT_ID stored as literal
 *   "[REDACTED]" in ~/.comis/.env after an env_set-triggered daemon restart.
 *
 * Fix shape:
 *   Walk `sm.fileEntries` in memory and neutralize any tool_use block whose
 *   arguments contain the redaction placeholder. Neutralize the matching
 *   tool_result. The on-disk JSONL is NOT rewritten — the scrub is for the
 *   LLM replay channel only, keeping the JSONL intact as the sanitized
 *   audit record. This separates the two channels cleanly and follows the
 *   precedent set by `scrubPoisonedThinkingBlocks`.
 *
 * The scrub keys on the redaction placeholder (not on `env_set` specifically)
 * so it automatically covers every sanitization rule in
 * sanitize-session-secrets.ts — sensitive-arg-names, api-key-patterns,
 * exec-command-keys — without coupling the two modules.
 *
 * @module
 */

import type { SessionManager } from "@mariozechner/pi-coding-agent";

/** Literal placeholder written by sanitizeSessionSecrets. */
const REDACTION_PLACEHOLDER = "[REDACTED]";

/** Result of scrubbing redacted tool calls. */
export interface RedactedScrubResult {
  scrubbed: boolean;
  /** Tool_use blocks rewritten (across all assistant messages). */
  blocksRewritten: number;
  /** Matching tool_result messages rewritten. */
  resultsRewritten: number;
}

/**
 * Scrub redacted tool_use/tool_result pairs from a SessionManager's in-memory
 * fileEntries. Does NOT call _rewriteFile — the on-disk JSONL is left as the
 * audit record. Intended to run right before `buildSessionContext()`.
 *
 * Best-effort: silently no-ops on unexpected session manager shapes.
 */
export function scrubRedactedToolCalls(
  sessionManager: SessionManager,
): RedactedScrubResult {
  /* eslint-disable @typescript-eslint/no-explicit-any -- SessionManager internals */
  const sm = sessionManager as any;
  const fileEntries = sm?.fileEntries;
  if (!Array.isArray(fileEntries)) {
    return { scrubbed: false, blocksRewritten: 0, resultsRewritten: 0 };
  }

  // Pass 1: find assistant messages whose tool_use blocks are ALL poisoned.
  // Mixed messages (some poisoned, some not) are skipped: rewriting a single
  // tool_use block while preserving sibling tool_use/tool_result pairs risks
  // Anthropic's schema rejecting dangling tool_result_ids. Mixed env_set is
  // rare in practice (env_set is always emitted standalone following the
  // confirmation flow); defense-in-depth is provided by the RPC+tool guards.
  //
  // Map<toolCallId, summaryText> for matching tool_result rewrites.
  const poisoned = new Map<string, string>();
  // Assistant entry indices marked for full content replacement.
  const fullyPoisonedAssistants = new Map<number, string>(); // idx -> summary

  for (let idx = 0; idx < fileEntries.length; idx++) {
    const entry = fileEntries[idx];
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    let toolBlockCount = 0;
    let poisonedInThisMessage = 0;
    const candidateIds: string[] = [];
    let firstSummary: string | null = null;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type !== "toolCall" && block.type !== "tool_use") continue;
      toolBlockCount++;

      const args = (block.arguments ?? block.input) as
        | Record<string, unknown>
        | undefined;
      if (!args || typeof args !== "object") continue;
      if (!argsContainPlaceholder(args)) continue;

      const toolCallId =
        typeof block.id === "string" ? block.id : undefined;
      const toolName = typeof block.name === "string" ? block.name : "tool";
      const summary = buildSummaryText(toolName, args);

      if (toolCallId) candidateIds.push(toolCallId);
      poisonedInThisMessage++;
      if (!firstSummary) firstSummary = summary;
    }

    // Only act when the entire set of tool_use blocks is poisoned — the
    // common case. Mixed messages left intact (see comment above).
    if (
      poisonedInThisMessage > 0 &&
      poisonedInThisMessage === toolBlockCount
    ) {
      fullyPoisonedAssistants.set(
        idx,
        firstSummary ?? "(prior tool call elided)",
      );
      for (const id of candidateIds) {
        poisoned.set(id, firstSummary ?? "(prior tool call elided)");
      }
    }
  }

  if (fullyPoisonedAssistants.size === 0) {
    return { scrubbed: false, blocksRewritten: 0, resultsRewritten: 0 };
  }

  // Pass 2: rewrite fully-poisoned assistant messages.
  // Preserve every other field on `msg` (usage, api, provider, stopReason,
  // timestamp) so token accounting and trace correlation stay accurate.
  let blocksRewritten = 0;
  for (const [idx, summary] of fullyPoisonedAssistants.entries()) {
    fileEntries[idx].message.content = [{ type: "text", text: summary }];
    blocksRewritten += 1;
  }

  // Pass 3: convert matching tool_result entries into plain user text.
  // The matching tool_use block is gone, so the tool_result would otherwise
  // dangle. Changing the role to "user" + plain text content is the safe
  // equivalent that keeps the conversation turn structure valid.
  let resultsRewritten = 0;
  for (const entry of fileEntries) {
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    const toolCallId =
      typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
    if (!toolCallId || !poisoned.has(toolCallId)) continue;
    if (msg.role !== "toolResult" && msg.role !== "tool") continue;

    msg.role = "user";
    msg.content = [
      { type: "text", text: "(prior secret operation — no output shown)" },
    ];
    delete msg.toolCallId;
    delete msg.toolName;
    resultsRewritten += 1;
  }

  return {
    scrubbed: true,
    blocksRewritten,
    resultsRewritten,
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True if any string value in args equals the redaction placeholder, or any
 * string value contains the placeholder substring (catches exec-command-keys
 * rule where the placeholder is embedded inside a larger command string).
 */
function argsContainPlaceholder(args: Record<string, unknown>): boolean {
  for (const key of Object.keys(args)) {
    const val = args[key];
    if (typeof val !== "string") continue;
    if (val === REDACTION_PLACEHOLDER) return true;
    if (val.includes(REDACTION_PLACEHOLDER)) return true;
  }
  return false;
}

/**
 * First-person summary text. Keeps the fact of the action so the model's
 * memory stays accurate; strips the arguments so there's no template to
 * mimic. Explicitly warns the model not to reuse the placeholder on future
 * calls.
 */
function buildSummaryText(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === "gateway" && args.action === "env_set") {
    const key =
      typeof args.env_key === "string" ? args.env_key : "the secret";
    return (
      `(Previously set secret ${key} via env_set — tool call details ` +
      `elided from replay. The action completed; do not retry. When the ` +
      `user provides a new secret value, pass their actual value to ` +
      `env_set — never a placeholder like [REDACTED].)`
    );
  }
  return (
    `(Previous ${toolName} call elided from replay because some ` +
    `arguments had been redacted. The action completed; do not retry. ` +
    `Use the user's actual values when making new calls — never ` +
    `reuse a [REDACTED] placeholder.)`
  );
}

