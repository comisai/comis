/**
 * Telegram thread context resolution and param builders.
 *
 * Pure functions for determining thread scope from inbound messages,
 * building outbound API parameters with the General Topic ID=1
 * asymmetry handled correctly, and detecting thread-related errors.
 *
 * @module
 */

/**
 * The Telegram-assigned ID for the General Topic in forum groups.
 * All forum groups have this topic implicitly, even when no custom
 * topics have been created.
 */
export const TELEGRAM_GENERAL_TOPIC_ID = 1;

/**
 * Describes how a message relates to Telegram threading:
 * - `"forum"` -- message is inside a forum group topic
 * - `"dm"` -- message is in a DM with an explicit topic ID
 * - `"none"` -- no thread context (regular group, regular DM)
 */
export type TelegramThreadScope = "forum" | "dm" | "none";

/**
 * Resolved thread context from an inbound Telegram message.
 */
export interface TelegramThreadContext {
  /** Numeric topic/thread ID, or undefined when no thread context applies. */
  threadId: number | undefined;
  /** The scope classification for this message's threading. */
  scope: TelegramThreadScope;
}

/**
 * Metadata keys set on `NormalizedMessage.metadata` for thread context.
 * Used for cleanup, propagation checks, and documentation.
 */
export const TELEGRAM_THREAD_META_KEYS: readonly string[] = [
  "telegramThreadId",
  "telegramIsForum",
  "telegramThreadScope",
  "threadId",
] as const;

/**
 * Resolve thread context from inbound Telegram message fields.
 *
 * Five branching rules (order matters):
 * 1. Forum group with explicit threadId => forum scope
 * 2. Forum group without threadId => General Topic default (ID=1)
 * 3. Non-forum group => scope "none" (ignore reply-chain message_thread_id)
 * 4. DM with rawThreadId => dm scope
 * 5. Otherwise => scope "none"
 */
export function resolveTelegramThreadContext(params: {
  isForum: boolean;
  isGroup: boolean;
  rawThreadId: number | undefined;
}): TelegramThreadContext {
  const { isForum, isGroup, rawThreadId } = params;

  // Rule 1: Forum group with explicit thread ID
  if (isForum && isGroup && rawThreadId != null) {
    return { threadId: rawThreadId, scope: "forum" };
  }

  // Rule 2: Forum group without thread ID => General Topic default
  if (isForum && isGroup && rawThreadId == null) {
    return { threadId: TELEGRAM_GENERAL_TOPIC_ID, scope: "forum" };
  }

  // Rule 3: Non-forum group -- ignore message_thread_id from reply chains
  if (!isForum && isGroup) {
    return { threadId: undefined, scope: "none" };
  }

  // Rule 4: DM with explicit topic
  if (!isGroup && rawThreadId != null) {
    return { threadId: rawThreadId, scope: "dm" };
  }

  // Rule 5: Regular DM or anything else
  return { threadId: undefined, scope: "none" };
}

/**
 * Build `message_thread_id` param for send-type API calls.
 *
 * Handles the General Topic asymmetry:
 * - Forum scope with ID=1 => undefined (API rejects message_thread_id=1 for send)
 * - DM scope with ID=1 => includes it (DM topics always need the param)
 */
export function buildSendThreadParams(
  threadId: number | undefined,
  scope: TelegramThreadScope,
): { message_thread_id: number } | undefined {
  if (threadId == null || threadId < 1 || scope === "none") {
    return undefined;
  }

  // General Topic asymmetry: do NOT send message_thread_id=1 for forum scope
  if (scope === "forum" && threadId === TELEGRAM_GENERAL_TOPIC_ID) {
    return undefined;
  }

  return { message_thread_id: threadId };
}

/**
 * Build `message_thread_id` param for typing/action API calls.
 *
 * Unlike send, typing ALWAYS includes message_thread_id, even for
 * General Topic ID=1. This is the asymmetric counterpart to
 * `buildSendThreadParams`.
 */
export function buildTypingThreadParams(
  threadId: number | undefined,
): { message_thread_id: number } | undefined {
  if (threadId == null || threadId < 1) {
    return undefined;
  }

  return { message_thread_id: threadId };
}

/**
 * Detect Telegram API errors related to missing or closed forum topics.
 *
 * Matches: "message thread not found", "TOPIC_CLOSED", "TOPIC_DELETED"
 */
export function isTelegramThreadNotFoundError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";

  return (
    /message thread not found/i.test(message) ||
    /TOPIC_CLOSED/i.test(message) ||
    /TOPIC_DELETED/i.test(message)
  );
}

/**
 * Resolve outbound thread params from `SendMessageOptions`.
 *
 * Extracts `threadId` (string) from options, parses as integer,
 * looks up scope from `extra.telegramThreadScope`, and delegates
 * to `buildSendThreadParams`.
 */
export function resolveOutboundThreadParams(
  options?: { threadId?: string; extra?: Record<string, unknown> },
): { message_thread_id: number } | undefined {
  const raw = options?.threadId;
  if (raw == null) return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;

  const scope =
    (options?.extra?.telegramThreadScope as TelegramThreadScope) ?? "forum";

  return buildSendThreadParams(Math.trunc(parsed), scope);
}
