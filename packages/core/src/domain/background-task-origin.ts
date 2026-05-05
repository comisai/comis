// SPDX-License-Identifier: Apache-2.0
/**
 * Background task origin: captures the originating session attribution
 * (agent + session + channel + trace + hop count) at the moment a tool
 * execution is promoted to a background task. Persisted on the task so
 * completion can route a re-entry announcement back to the right session
 * even after a daemon restart.
 *
 * Lives in @comis/core (not @comis/agent) so the event-bus payload type
 * in core/src/event-bus/events-infra.ts can carry it without violating
 * the inward-only dependency direction (AGENTS.md §1).
 *
 * @module
 */

import { z } from "zod";

/**
 * Origin context captured at promote() time. All string fields are
 * non-empty so the runner can reconstruct a valid SessionKey via
 * parseFormattedSessionKey() and dispatch executor.execute() to the
 * correct session.
 */
export const BackgroundTaskOriginSchema = z.strictObject({
  /** The agent that owned the tool call. */
  agentId: z.string().min(1),
  /** Formatted session key string (parseFormattedSessionKey-compatible). */
  sessionKey: z.string().min(1),
  /** Channel type the originating message arrived on (e.g., "telegram"). */
  channelType: z.string().min(1),
  /** Channel-specific identifier for the originating user/group. */
  channelId: z.string().min(1),
  /** Per-execution trace identifier; null when no trace was active. */
  traceId: z.string().nullable(),
  /** Recursion-bound counter (SPEC R4 + AC-7). Captured at promote-time
   *  from the inbound NormalizedMessage's metadata.backgroundHopCount
   *  (defaults to 0 for top-level user messages). The Phase 14 completion
   *  runner increments this when constructing the outgoing synthetic
   *  message, and falls back to fallbackNotifyFn when
   *  (incomingHopCount + 1) >= maxBackgroundHops. */
  backgroundHopCount: z.number().int().nonnegative().default(0),
});

export type BackgroundTaskOrigin = z.infer<typeof BackgroundTaskOriginSchema>;
