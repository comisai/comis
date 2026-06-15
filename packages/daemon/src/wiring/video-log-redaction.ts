// SPDX-License-Identifier: Apache-2.0
/**
 * SEC-03 (Phase 192): redaction-safe shaping of a RAW provider/channel Error
 * before it rides a log line.
 *
 * The off-turn video poller logs failure causes — a FAL/Veo/Grok SDK error, a
 * channel-adapter send error, a SQLite store error — whose free-text `message`
 * can echo a key / bearer / the Veo `&key=AIza…` download URL. The Pino redact
 * set only scrubs credential-NAMED structured keys; it never touches free-text
 * inside `err.message`. So a raw cause logged as `err: cause` leaks any secret in
 * its message. `redactErr` runs the message through `sanitizeLogString` (the
 * SECOND line of defense — Bearer/sk-/AIza/etc. → `[REDACTED]`) and returns a
 * spreadable `{ errName, errMessage }` (bounded) for the log payload. The stack
 * (which can also carry a URL) is intentionally dropped — AGENTS.md §2.7 keeps
 * stack traces at DEBUG only, and the threat model forbids a credential at ANY
 * level, so the redacted message is the safe carrier on WARN/ERROR.
 *
 * @module
 */
import { sanitizeLogString } from "@comis/core";

/** Max logged message length (mirrors the pi-event-bridge sanitized-error bound). */
const MAX_ERR_MESSAGE_CHARS = 1500;

/**
 * Shape a raw Error for a log payload: the error name + its `sanitizeLogString`-
 * scrubbed, length-bounded message. Spread into the structured payload in place
 * of a raw `err: cause` field.
 */
export function redactErr(cause: Error): { errName: string; errMessage: string } {
  return {
    errName: cause.name,
    errMessage: sanitizeLogString(cause.message).slice(0, MAX_ERR_MESSAGE_CHARS),
  };
}
