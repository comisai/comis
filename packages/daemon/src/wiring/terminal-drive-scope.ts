// SPDX-License-Identifier: Apache-2.0
/**
 * The pure daemon-wiring drive-scope helpers —
 * the TWO-OWNER SPLIT that lets a promoted drive's fd3-woken turns run under a dedicated
 * `drive:<sessionId>` attribution key WITHOUT changing which session (or jail) the registry
 * resolves.
 *
 * The load-bearing nuance: a woken turn keeps two owners distinct.
 *   1. The **registry owner** ({@link registryOwnerFor}) — the `(agentId, sessionKey)` the
 *      registry's `get`/`status`/`read`/`sendText` are scoped by. It MUST stay the session's
 *      STAMPED owner (`sessionKey:""` for the forcing use case), because `ownedHandle`
 *      returns not-found on ANY owner mismatch (`sameOwner`, terminal-session-registry.ts:549).
 *      If a *drive*-scoped `sessionKey` (≠ the stamped `""`) reached the registry, `read`/
 *      `status` would return the empty `alive:false` not-found view and drive nothing (a
 *      silent strand). The same `allowId`/`scope`/`uid` (stamped
 *      ONCE at create, never re-derived on the wake path) therefore apply — scoping WHERE,
 *      not WHAT, by construction.
 *   2. The **drive-scope key** ({@link driveScopeKeyFor} → `drive:<sessionId>`) — what the FSM
 *      dedupe + the journal keying + the conversation/LCD attribution use. This is the
 *      isolation mechanism (a promoted drive's woken turns no longer pollute the user's
 *      primary `sessionKey:""` conversation). It is NOT the registry-authorization owner.
 *
 * {@link DRIVE_SCOPE_PREFIX} is a RESERVED prefix the session-key formatter never produces
 * (`formatSessionKey` emits `{tenantId}:{userId}:{channelId}…`; a subagent's channelId is
 * `sub-agent:<uuid>`, so a real owner key never starts with `drive:`). The
 * drive-scope attribution key therefore cannot collide with a real subagent owner; the
 * registry owner-gate stays the authorization boundary.
 *
 * Architecture invariants (binding — AGENTS.md house style; mirrors the pure,
 * never-throw daemon-wiring helpers in `terminal-wake-persistence.ts`):
 *   - PURE: free functions, NOT a factory. NO clock/timer reads, NO module-global mutable
 *     state, NO I/O.
 *   - TOTAL / NEVER throws: a degenerate owner (`undefined`, a missing `sessionKey`) yields
 *     the SAFE stamped owner — the woken-turn driver + the active-check call this on EVERY
 *     wake, so a throw would strand the turn.
 *   - Infra-free: value-imports NOTHING (only the TYPE-only `SessionOwner` /
 *     `PersistedWakeOwner`) — no platform runtime packages, no observability egress (the
 *     infra-runtime-scope architecture gate; this file names none of them).
 *
 * @module
 */

import type { SessionOwner } from "@comis/skills/tools";

import type { PersistedWakeOwner } from "./terminal-wake-persistence.js";

/**
 * The reserved attribution-key prefix for a promoted drive's woken turns
 * (`drive:<sessionId>`). `formatSessionKey` NEVER produces a value starting with this
 * prefix (a real owner key is `{tenantId}:{userId}:{channelId}…`), so a drive-scope key
 * cannot collide with a real subagent owner. The trailing colon makes the
 * prefix-check unambiguous (a session id cannot smuggle a leading `drive` segment).
 */
export const DRIVE_SCOPE_PREFIX = "drive:";

/**
 * Derive the drive-scope attribution `sessionKey` for a session's woken turn. Returns
 * `drive:<sessionId>` when the session is promoted (so its woken turns are isolated to the
 * dedicated drive scope, NOT the primary `sessionKey:""` conversation), else `""` (the
 * inline path — byte-identical).
 *
 * This is ONLY the FSM/journal/conversation attribution key; it is NEVER the
 * registry-authorization owner ({@link registryOwnerFor} strips it back for registry calls).
 *
 * @param sessionId - The opaque worker session handle.
 * @param promoted - Whether this session has been promoted to a backgrounded drive.
 * @returns `drive:<sessionId>` when promoted, else `""`.
 */
export function driveScopeKeyFor(sessionId: string, promoted: boolean): string {
  return promoted ? `${DRIVE_SCOPE_PREFIX}${sessionId}` : "";
}

/**
 * Is this wake owner drive-scoped (its `sessionKey` carries the reserved
 * {@link DRIVE_SCOPE_PREFIX})? The SINGLE total accessor for the drive-scope test — used by
 * both {@link registryOwnerFor} (the strip) and the woken-turn driver's `promoted` gate,
 * so ALL registry-owner resolution applies the identical defensive narrow.
 *
 * Total + never throws: a degenerate owner (`undefined`, a missing/non-string `sessionKey`)
 * yields `false` — the woken-turn driver + the active-check evaluate this on EVERY wake, so a
 * raw `owner.sessionKey.startsWith(...)` (which throws a `TypeError` on a degenerate owner)
 * would strand the turn; this narrows like {@link registryOwnerFor} instead.
 *
 * @param owner - The wake owner the FSM carries.
 * @returns `true` iff `owner.sessionKey` is a `drive:<id>` attribution key.
 */
export function isDriveScoped(owner: PersistedWakeOwner): boolean {
  return typeof owner?.sessionKey === "string" && owner.sessionKey.startsWith(DRIVE_SCOPE_PREFIX);
}

/**
 * Strip a `drive:`-scoped wake owner back to the session's STAMPED registry owner — the
 * stamped-owner anchor. A `sessionKey` starting with {@link DRIVE_SCOPE_PREFIX} is collapsed to the
 * stamped `""` (the forcing use case's owner), so the registry resolves the LIVE session
 * with its create-time `allowId`/`scope`/`uid`, never the not-found view. A `sessionKey`
 * NOT starting with the reserved prefix (a real subagent owner, or the today-path `""`)
 * passes through UNCHANGED — the strip only collapses the reserved drive scope, never a
 * genuine cross-owner key.
 *
 * Total + never throws: a degenerate owner (`undefined`, a missing/non-string `sessionKey`)
 * yields the safe stamped owner.
 *
 * @param owner - The wake owner the FSM carries (its `sessionKey` is `drive:<id>` for a
 *   promoted session, `""` otherwise, or a real subagent key on a subagent-driven session).
 * @returns The registry owner to scope `get`/`status`/`read`/`sendText` by.
 */
export function registryOwnerFor(owner: PersistedWakeOwner): SessionOwner {
  const agentId = owner?.agentId ?? "";
  const sessionKey = typeof owner?.sessionKey === "string" ? owner.sessionKey : "";
  // A drive-scoped key is a PURE attribution key — strip it to the stamped registry owner
  // (the same total drive-scope test as isDriveScoped, applied to the narrowed sessionKey).
  if (sessionKey.startsWith(DRIVE_SCOPE_PREFIX)) {
    return { agentId, sessionKey: "" };
  }
  // A real owner (a subagent key, or the today-path "") is preserved verbatim.
  return { agentId, sessionKey };
}
