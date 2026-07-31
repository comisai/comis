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
 *   as the value on the NEXT env_set — which the daemon persists verbatim,
 *   leaving a real key (e.g. CLOUDFLARE_ACCOUNT_ID) stored as the literal
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

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { REDACTED_TOOL_RESULT_USER_MESSAGE } from "./synthetic-user-messages.js";
import { tryCatch } from "@comis/shared";
import { getSessionFileEntries } from "./session-manager-internals.js";

/** Literal placeholder written by sanitizeSessionSecrets. */
// eslint-disable-next-line no-restricted-syntax -- session-scrub placeholder constant (not the Pino censor literal)
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
  /* eslint-disable @typescript-eslint/no-explicit-any -- persisted-entry payloads are untyped JSONL shapes */
  const rawEntries = getSessionFileEntries(sessionManager);
  if (!rawEntries) {
    return { scrubbed: false, blocksRewritten: 0, resultsRewritten: 0 };
  }
  const fileEntries = rawEntries as any[];

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
  // Historical persistence could replace distinct provider call IDs with the
  // same placeholder. Match those results by their adjacent turn position
  // instead of globally conflating unrelated calls.
  const adjacentRedactedResultCounts = new Map<number, number>();

  // Pass 0: index the APPROVAL-GATED results by toolCallId.
  //
  // A gated call returns `requiresConfirmation: true` plus an opaque
  // `pending_action_id`; the secret value stays server-side and the model is told
  // to re-call with that id and `_confirmed: true`, OMITTING the value — precisely
  // because the value is about to be redacted out of its context. Scrubbing that
  // RESULT away destroys the only handle that can complete the action, and the
  // model's sole remaining move is to ask the user to re-paste the secret in
  // cleartext. The tool_use ARGS carry the secret and must still be scrubbed; the
  // result carries no secret, so the handle survives (nothing else does — the id
  // is extracted, never the surrounding payload).
  const pendingActionIdByToolCallId = new Map<string, string>();
  for (const entry of fileEntries) {
    if (!entry || entry.type !== "message") continue;
    const m = entry.message;
    if (!m || (m.role !== "toolResult" && m.role !== "tool")) continue;
    const id = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
    if (id === undefined) continue;
    const pendingId = extractPendingActionId(m.content);
    if (pendingId !== undefined) pendingActionIdByToolCallId.set(id, pendingId);
  }

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
    let adjacentRedactedResultCount = 0;
    let firstSummary: string | null = null;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type !== "toolCall" && block.type !== "tool_use") continue;
      toolBlockCount++;

      const args = (block.arguments ?? block.input) as
        | Record<string, unknown>
        | undefined;
      const identityUnavailable =
        block.name === REDACTION_PLACEHOLDER
        || block.id === REDACTION_PLACEHOLDER;
      if (
        !identityUnavailable
        && (!args || typeof args !== "object" || !argsContainPlaceholder(args))
      ) {
        continue;
      }

      const toolCallId =
        typeof block.id === "string" ? block.id : undefined;
      const toolName = typeof block.name === "string" ? block.name : "tool";
      const safeArgs = args && typeof args === "object" ? args : {};
      const summary = identityUnavailable
        ? unavailableProtocolIdentitySummary()
        : buildSummaryText(
          toolName,
          safeArgs,
          toolCallId === undefined
            ? undefined
            : pendingActionIdByToolCallId.get(toolCallId),
        );

      if (toolCallId === REDACTION_PLACEHOLDER) {
        adjacentRedactedResultCount += 1;
      } else if (toolCallId) {
        candidateIds.push(toolCallId);
      }
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
      if (adjacentRedactedResultCount > 0) {
        adjacentRedactedResultCounts.set(idx, adjacentRedactedResultCount);
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

    rewriteToolResultMessage(
      msg,
      pendingActionIdByToolCallId.get(toolCallId),
      false,
    );
    resultsRewritten++;
  }

  // Placeholder IDs are not unique. Pair them only with immediately following
  // tool results, stopping at the next conversational turn.
  for (const [assistantIdx, expectedResults] of adjacentRedactedResultCounts) {
    let remaining = expectedResults;
    for (let idx = assistantIdx + 1; idx < fileEntries.length; idx++) {
      const entry = fileEntries[idx];
      if (!entry || entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg) continue;
      if (msg.role === "assistant" || msg.role === "user") break;
      if (
        (msg.role === "toolResult" || msg.role === "tool")
        && msg.toolCallId === REDACTION_PLACEHOLDER
      ) {
        rewriteToolResultMessage(
          msg,
          extractPendingActionId(msg.content),
          true,
        );
        resultsRewritten++;
        remaining--;
        if (remaining === 0) break;
      }
    }
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

/** Neutral replay summary for historical records with unusable tool identity. */
function unavailableProtocolIdentitySummary(): string {
  return (
    "(Prior tool call elided from replay because its persisted protocol " +
    "identity was unavailable. The call cannot be replayed safely; do not " +
    "retry solely because this repair occurred.)"
  );
}

/**
 * Convert a now-unpaired tool result to ordinary conversation context.
 *
 * Identity-only corruption leaves already-sanitized result content safe and
 * useful, while argument redaction keeps the established opaque replacement.
 */
function rewriteToolResultMessage(
  msg: Record<string, unknown>,
  pendingActionId: string | undefined,
  preserveContent: boolean,
): void {
  msg.role = "user";
  if (!preserveContent) {
    msg.content = [
      {
        type: "text",
        text: pendingActionId === undefined
          ? REDACTED_TOOL_RESULT_USER_MESSAGE
          : pendingApprovalReplayText(pendingActionId),
      },
    ];
  }
  delete msg.toolCallId;
  delete msg.toolName;
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
  pendingActionId?: string,
): string {
  // A gated call did NOT run. Telling the model it "completed" while its result
  // is scrubbed away is how the live deadlock started: the model believed the
  // secrets were stored, listed them, found nothing, and asked the user to paste
  // the password again. State the truth and name the handle that finishes it.
  if (pendingActionId !== undefined) {
    const key =
      typeof args.env_key === "string" ? args.env_key : "the secret";
    return (
      `(Awaiting your confirmation to set secret ${key} — the call was gated ` +
      `and has NOT run. Its arguments are elided from replay. Once the user ` +
      `approves, re-call the SAME action with pending_action_id: ` +
      `"${pendingActionId}" and _confirmed: true, OMITTING the value — it is ` +
      `replayed server-side. Never ask the user to resend the secret, and ` +
      `never pass a placeholder like [REDACTED].)`
    );
  }
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

/**
 * The user-role replacement for a scrubbed APPROVAL-GATED tool result.
 *
 * Carries ONLY the opaque `pending_action_id` — never the surrounding payload —
 * so the confirm remains issuable while the secret stays out of replay. Without
 * it the model loses its only route to completing the action and falls back to
 * asking the user to resend the credential in cleartext.
 */
function pendingApprovalReplayText(pendingActionId: string): string {
  return (
    `(prior secret operation — output withheld. It is still PENDING your ` +
    `confirmation. To complete it, re-call the same action with ` +
    `pending_action_id: "${pendingActionId}" and _confirmed: true, omitting ` +
    `the value — it is replayed server-side. Do not ask for the secret again.)`
  );
}

/**
 * Pull an approval gate's `pending_action_id` out of a tool result's content.
 *
 * Gated results are JSON text blocks. Parse when possible; fall back to a
 * bounded regex so a wrapper (offload notice, security banner) around the JSON
 * still yields the handle. Returns undefined for every non-gated result, which
 * keeps the ungated scrub path byte-identical.
 */
function extractPendingActionId(content: unknown): string | undefined {
  const text = collectText(content);
  if (text === undefined || !text.includes("pending_action_id")) return undefined;
  const parsed = tryCatch(() => JSON.parse(text) as unknown);
  if (parsed.ok) {
    const value = (parsed.value as { pending_action_id?: unknown } | null)
      ?.pending_action_id;
    if (typeof value === "string" && value.length > 0) return value;
  }
  const match = /"pending_action_id"\s*:\s*"([^"]{1,200})"/.exec(text);
  return match?.[1];
}

/** Flatten a tool result's content blocks (or string shorthand) to text. */
function collectText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
