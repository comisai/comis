// SPDX-License-Identifier: Apache-2.0
/**
 * Orphaned message detection and repair.
 *
 * In Comis's multi-channel model, a message can be written to the session
 * but execution may fail or timeout before the assistant replies. The next
 * `session.prompt()` would see a user message followed by another user message,
 * which can confuse LLM providers expecting strict role alternation.
 *
 * This module detects and repairs session anomalies:
 *
 * **Tail anomalies (Cases 1-3, O(1) fast path):**
 * 1. **Orphaned user messages** -- trailing user turn without an assistant reply.
 * 2. **Tool-result tails** -- session ends with a tool result (role "tool" or
 *    "toolResult") after an assistant toolUse, or with an assistant message
 *    whose stopReason is "toolUse" (interrupted before tool results arrived).
 *    Both cases arise when a daemon restart kills execution mid-tool-call.
 *
 * **Mid-session anomalies (Case 4, full scan):**
 * 4. **Consecutive same-role messages** -- user-user or assistant-assistant at
 *    any position in the session. Detected via `getBranch()` tree traversal.
 *    Repaired by branching to the entry before the first anomaly and
 *    re-appending all subsequent entries with synthetic filler messages
 *    inserted between consecutive same-role messages. Preserves
 *    SessionManager's append-only tree semantics.
 *
 * In all cases synthetic messages are appended to restore valid role
 * alternation. The original messages are preserved (never deleted).
 *
 * @module
 */

import type {
  SessionManager,
  SessionEntry,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of orphaned message repair. */
export interface RepairResult {
  /** Whether a repair was performed. */
  repaired: boolean;
  /** Reason for repair, if any. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect and repair orphaned messages in a session.
 *
 * Handles three tail anomalies (O(1) fast path) and one full-scan case:
 * 1. Trailing user message without an assistant reply (orphaned user message).
 * 2. Trailing tool result (role "tool" or "toolResult") -- execution was
 *    interrupted by a restart after tool calls completed but before the
 *    assistant processed results.
 * 3. Trailing assistant message with stopReason "toolUse" -- execution was
 *    interrupted before tool results arrived.
 * 4. Mid-session consecutive same-role messages (user-user or
 *    assistant-assistant) at any position. Detected by scanning the
 *    getBranch() entry path. Repaired via branch() + re-append with
 *    synthetic filler messages inserted.
 *
 * In all cases synthetic messages are appended to restore valid role
 * alternation. The `api` and `provider` values are set to "synthetic"
 * to distinguish repair messages from real LLM responses.
 *
 * @param sessionManager - The SessionManager for the current session
 * @returns RepairResult indicating whether repair was performed
 */
export function repairOrphanedMessages(sessionManager: SessionManager): RepairResult {
  const context = sessionManager.buildSessionContext();
  const messages = context.messages;

  if (!messages || messages.length === 0) {
    return { repaired: false };
  }

  const lastMsg = messages[messages.length - 1];
  if (!lastMsg) {
    return { repaired: false };
  }

  // Case 1: Orphaned user message -- append synthetic assistant reply
  if (lastMsg.role === "user") {
    appendSyntheticAssistant(sessionManager, "(previous response was interrupted)");
    return {
      repaired: true,
      reason: "trailing user message without assistant reply",
    };
  }

  // Case 2: Tool-result tail -- session ends with tool/toolResult after
  // an assistant toolUse, but execution was interrupted by a restart.
  // Content-aware (CONTEXT.md §Change 1A): the synthetic assistant text
  // reflects the actual trailing toolResult body so the model is not given
  // a prompt that contradicts the real successful result already on disk.
  /* eslint-disable @typescript-eslint/no-explicit-any -- role "tool"/"toolResult" not in SDK AgentMessage union */
  const isToolResult =
    (lastMsg as any).role === "tool" || (lastMsg as any).role === "toolResult";
  /* eslint-enable @typescript-eslint/no-explicit-any */

  if (isToolResult) {
    let text: string;
    if (isErroredToolResult(lastMsg)) {
      text = "(previous tool errored before I could react)";
    } else {
      const body = parseToolResultBody(lastMsg);
      if (body && body.restarting === true) {
        text = "(daemon restarted to apply the change — continuing)";
      } else {
        text = "(continuing after daemon restart)";
      }
    }
    appendSyntheticAssistant(sessionManager, text);
    return {
      repaired: true,
      reason: "trailing tool result without assistant reply (interrupted by restart)",
    };
  }

  // Case 3: Assistant message with stopReason "toolUse" -- the assistant
  // requested tool calls but execution was interrupted before results arrived.
  /* eslint-disable @typescript-eslint/no-explicit-any -- stopReason "toolUse" internal SDK value */
  const isInterruptedToolUse =
    lastMsg.role === "assistant" &&
    (lastMsg as any).stopReason === "toolUse";
  /* eslint-enable @typescript-eslint/no-explicit-any */

  if (isInterruptedToolUse) {
    appendSyntheticAssistant(
      sessionManager,
      "(previous tool execution was interrupted by a system restart)",
    );
    return {
      repaired: true,
      reason: "assistant toolUse interrupted before processing results",
    };
  }

  // Case 4: Mid-session role alternation anomalies.
  // Consecutive same-role messages (user-user or assistant-assistant) in the
  // middle of the history. Happens when a daemon restart writes a synthetic
  // repair at the tail, then a new execution adds another message of the
  // same role. Tail checks above won't catch these because the tail is clean.

  // Strategy: use getBranch() to get the entry path (root to leaf).
  // Detect anomalies among SessionMessageEntry entries. When found,
  // branch() back to the parent of the first anomaly and re-append
  // all subsequent entries with synthetic fillers inserted between
  // consecutive same-role messages.
  const midSessionResult = repairMidSessionAnomalies(sessionManager);
  if (midSessionResult.repaired) {
    return midSessionResult;
  }

  return { repaired: false };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic marker values bypass SDK type constraints */

/**
 * Create a synthetic message for either role.
 *
 * Assistant messages include the full usage/api/provider shape expected by
 * the SDK. User messages use the simpler {role, content, timestamp} shape.
 */
function createSyntheticMessage(role: "user" | "assistant", text: string): any {
  if (role === "assistant") {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "synthetic",
      provider: "synthetic",
      model: "synthetic",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
  }
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

/** Append a synthetic assistant message with the given text. */
function appendSyntheticAssistant(sessionManager: SessionManager, text: string): void {
  sessionManager.appendMessage(createSyntheticMessage("assistant", text) as any);
}

/**
 * Best-effort parse of a trailing toolResult message into its tool-body
 * shape. The SDK wire format stores the body as one or more text content
 * blocks containing JSON. Returns null when the content isn't parseable
 * JSON (e.g., raw string output from a non-structured tool). Per CONTEXT.md
 * §Change 1A, parsing is best-effort, not a domain operation, so Result<T,E>
 * is intentionally not used here.
 */
function parseToolResultBody(
  msg: unknown,
): { restarting?: boolean; [k: string]: unknown } | null {
  const m = msg as { content?: unknown } | null | undefined;
  if (!m || !Array.isArray(m.content)) return null;
  const first = m.content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== "text" || typeof first.text !== "string") return null;
  const trimmed = first.text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort detection of an errored toolResult. The SDK and various tool
 * adapters surface errors either via `isError: true` on the message envelope
 * or on the first content block. Inspect both.
 */
function isErroredToolResult(msg: unknown): boolean {
  const m = msg as { isError?: unknown; content?: unknown } | null | undefined;
  if (!m) return false;
  if (m.isError === true) return true;
  if (Array.isArray(m.content) && m.content.length > 0) {
    const first = m.content[0] as { isError?: unknown } | undefined;
    if (first && first.isError === true) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Case 4: Mid-session full-scan repair
// ---------------------------------------------------------------------------

/**
 * Detect and repair consecutive same-role messages anywhere in the session.
 *
 * Walks the entry tree via getBranch(), identifies anomalies among message
 * entries, then uses branch() + re-append to insert synthetic filler messages.
 * Non-message entries (model changes, thinking level changes, custom entries,
 * custom message entries) between the branch point and the leaf are also
 * re-appended to preserve context.
 *
 * Structural entries (compaction, branch_summary, label, session_info) are
 * skipped during re-append -- they are metadata that would corrupt context
 * if duplicated.
 */
function repairMidSessionAnomalies(sessionManager: SessionManager): RepairResult {
  const branch = sessionManager.getBranch(); // root-to-leaf order
  if (branch.length < 2) {
    return { repaired: false };
  }

  // Collect message entries with their index in the full branch path
  const messageIndices: number[] = [];
  for (let i = 0; i < branch.length; i++) {
    if (branch[i]!.type === "message") {
      messageIndices.push(i);
    }
  }

  if (messageIndices.length < 2) {
    return { repaired: false };
  }

  // Scan for consecutive same-role anomalies among message entries.
  // Record the branch-path index of the SECOND entry in each anomalous pair.
  const anomalyBranchIndices: number[] = [];
  for (let mi = 1; mi < messageIndices.length; mi++) {
    const prevEntry = branch[messageIndices[mi - 1]!] as SessionMessageEntry;
    const currEntry = branch[messageIndices[mi]!] as SessionMessageEntry;
    const prevRole = prevEntry.message.role;
    const currRole = currEntry.message.role;

    if (
      (prevRole === "user" && currRole === "user") ||
      (prevRole === "assistant" && currRole === "assistant")
    ) {
      anomalyBranchIndices.push(messageIndices[mi]!);
    }
  }

  if (anomalyBranchIndices.length === 0) {
    return { repaired: false };
  }

  // Find the branch point: the entry just BEFORE the first anomalous entry
  // in the full branch path.
  const firstAnomalyIdx = anomalyBranchIndices[0]!;

  if (firstAnomalyIdx === 0) {
    // Anomaly starts at the very first entry -- reset leaf to before any entries
    sessionManager.resetLeaf();
  } else {
    const branchPointEntry = branch[firstAnomalyIdx - 1]!;
    sessionManager.branch(branchPointEntry.id);
  }

  // Re-append all entries from firstAnomalyIdx onward, inserting fillers
  // between consecutive same-role message entries.
  let lastReappendedRole: string | null = null;

  // If we branched to an entry before the anomaly, we need to know the role
  // of the last message before the branch point to detect the first anomaly.
  if (firstAnomalyIdx > 0) {
    // Walk backwards from firstAnomalyIdx-1 to find the last message entry
    for (let i = firstAnomalyIdx - 1; i >= 0; i--) {
      const entry = branch[i]!;
      if (entry.type === "message") {
        lastReappendedRole = (entry as SessionMessageEntry).message.role;
        break;
      }
    }
  }

  for (let i = firstAnomalyIdx; i < branch.length; i++) {
    const entry = branch[i]!;

    switch (entry.type) {
      case "message": {
        const msgEntry = entry as SessionMessageEntry;
        const currentRole = msgEntry.message.role;

        // Insert filler if consecutive same role
        if (lastReappendedRole !== null && lastReappendedRole === currentRole) {
          const fillerRole = currentRole === "user" ? "assistant" : "user";
          const fillerText =
            fillerRole === "assistant"
              ? "(previous response was interrupted)"
              : "(continued from previous message)";
          sessionManager.appendMessage(
            createSyntheticMessage(fillerRole, fillerText) as any,
          );
        }

        sessionManager.appendMessage(msgEntry.message as any);
        lastReappendedRole = currentRole;
        break;
      }
      case "thinking_level_change": {
        const tlEntry = entry as SessionEntry & { type: "thinking_level_change"; thinkingLevel: string };
        sessionManager.appendThinkingLevelChange(tlEntry.thinkingLevel);
        break;
      }
      case "model_change": {
        const mcEntry = entry as SessionEntry & { type: "model_change"; provider: string; modelId: string };
        sessionManager.appendModelChange(mcEntry.provider, mcEntry.modelId);
        break;
      }
      case "custom": {
        const cEntry = entry as SessionEntry & { type: "custom"; customType: string; data?: unknown };
        sessionManager.appendCustomEntry(cEntry.customType, cEntry.data);
        break;
      }
      case "custom_message": {
        const cmEntry = entry as SessionEntry & {
          type: "custom_message";
          customType: string;
          content: string | { type: string; text: string }[];
          display: boolean;
          details?: unknown;
        };
        sessionManager.appendCustomMessageEntry(
          cmEntry.customType,
          cmEntry.content as any,
          cmEntry.display,
          cmEntry.details,
        );
        // custom_message entries become "custom" role in context, not user/assistant
        // so they don't affect role alternation tracking
        break;
      }
      // Skip structural entries: compaction, branch_summary, label, session_info
      // These are metadata that should not be duplicated on the new branch.
      default:
        break;
    }
  }

  const count = anomalyBranchIndices.length;
  return {
    repaired: true,
    reason: `mid-session role alternation: repaired ${count} consecutive same-role anomal${count === 1 ? "y" : "ies"}`,
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// One-time scrub for sessions poisoned by an earlier on-disk thinking-signature
// stripper (removed in this same commit series). That stripper deleted
// `thinkingSignature` while keeping the `thinking` text, producing a hybrid
// that causes pi-ai to silently convert thinking→text on replay, which
// Anthropic then rejects with a 400 signature-validation error. We drop any
// such hybrid block entirely from fileEntries, matching the in-memory cleaner's
// behavior so disk and memory are finally in sync.
// ---------------------------------------------------------------------------

/** Result of scrubbing poisoned thinking blocks. */
export interface ScrubResult {
  /** True iff at least one poisoned block was dropped. */
  scrubbed: boolean;
  /** Number of thinking blocks removed from fileEntries. */
  blocksRemoved: number;
}

/**
 * Scrub poisoned thinking blocks from the session's on-disk fileEntries.
 *
 * A block is "poisoned" when it has `type:"thinking"` with non-empty `thinking`
 * text but missing/empty `thinkingSignature` and `redacted !== true`. Such
 * blocks are legacy artifacts of an earlier persister that deleted the
 * signature but left the block in place; they cause Anthropic to reject
 * subsequent extended-thinking continuations.
 *
 * Removes poisoned blocks entirely from `message.content` (does not attempt
 * to repair them) and flushes via `_rewriteFile()` exactly once if any
 * mutation occurred.
 *
 * Best-effort: silently no-ops if the session manager shape is unexpected.
 */
export function scrubPoisonedThinkingBlocks(sessionManager: SessionManager): ScrubResult {
  /* eslint-disable @typescript-eslint/no-explicit-any -- SessionManager internals */
  const sm = sessionManager as any;
  const fileEntries = sm?.fileEntries;
  if (!Array.isArray(fileEntries)) return { scrubbed: false, blocksRemoved: 0 };

  let blocksRemoved = 0;
  for (const entry of fileEntries) {
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    // Walk backwards so splice() doesn't shift subsequent indices.
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (!block || typeof block !== "object") continue;
      if (block.type !== "thinking") continue;
      if (block.redacted === true) continue;
      const sig = block.thinkingSignature;
      const hasValidSig = typeof sig === "string" && sig.length > 0;
      if (hasValidSig) continue;
      const text = block.thinking;
      if (typeof text !== "string" || text.length === 0) continue;
      content.splice(i, 1);
      blocksRemoved++;
    }
  }

  if (blocksRemoved > 0 && typeof sm._rewriteFile === "function") {
    sm._rewriteFile();
  }
  return { scrubbed: blocksRemoved > 0, blocksRemoved };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
