// SPDX-License-Identifier: Apache-2.0
/**
 * Invite auto-join gate: a pure decision over an incoming room invite.
 *
 * A federated homeserver lets anyone invite the bot into any room, so the
 * adapter must decide — without touching the network — whether to accept.
 * This is the channel's default-CLOSED trust boundary: the central per-sender
 * filter is default-open when its allowlist is empty, so the invite gate is
 * what stops a hostile party from pulling the bot into an arbitrary room.
 *
 * The decision is a total function of three config keys plus the inviter's
 * identity, defined by one unambiguous table:
 *
 *   | autoJoinOnInvite | allowMode   | Behavior                                    |
 *   | ---------------- | ----------- | ------------------------------------------- |
 *   | false            | (any)       | never join                                  |
 *   | true             | "allowlist" | join iff the inviter MXID is in allowFrom;  |
 *   |                  |             | an empty allowFrom joins nothing            |
 *   | true             | "open"      | join any invite                             |
 *
 * The whole trust decision keys on the inviter's full MXID (`@user:hs`), never
 * the attacker-settable display name — an exact-string match, so a bare
 * localpart, a display name, or the same localpart on a different homeserver
 * are all distinct identities that do not match. An empty allowlist admitting
 * no inviter falls straight out of the exact-match rule — it needs no special
 * case, which is why the default posture is closed.
 *
 * Pure: no I/O, no SDK import, deterministic. The caller wires this to the
 * membership event and performs the join / ignore side effect.
 *
 * @module
 */

/**
 * How the invite gate resolves trust: `"allowlist"` admits only inviters whose
 * MXID is listed; `"open"` admits any inviter.
 */
export type InviteAllowMode = "allowlist" | "open";

/** The inputs the invite decision is a pure function of. */
export interface InviteDecisionInput {
  /**
   * Master switch. When `false` the bot never auto-joins, regardless of
   * `allowMode` or `allowFrom`.
   */
  autoJoinOnInvite: boolean;
  /** Whether trust is restricted to `allowFrom` (`"allowlist"`) or open. */
  allowMode: InviteAllowMode;
  /**
   * The trusted inviter MXIDs — exact full MXIDs such as `"@user:hs"`. An empty
   * list admits no inviter (the default-closed posture).
   */
  allowFrom: string[];
  /**
   * The full MXID of the account that sent the invite. Always the MXID, never a
   * display name (which any user can set to impersonate another).
   */
  inviterMxid: string;
}

/** The gate's verdict: join the room, or ignore the invite (never join). */
export type InviteDecision = "join" | "ignore";

/**
 * Decide whether to auto-join a room the bot was invited to.
 *
 * @param input - The auto-join switch, trust mode, allowlist, and inviter MXID.
 * @returns `"join"` to accept the invite, `"ignore"` to leave it pending.
 */
export function decideInvite(input: InviteDecisionInput): InviteDecision {
  const { autoJoinOnInvite, allowMode, allowFrom, inviterMxid } = input;
  if (!autoJoinOnInvite) return "ignore";
  if (allowMode === "open") return "join";
  // "allowlist": exact full-MXID membership. An empty list matches nothing,
  // so the default posture is closed with no special-casing.
  return allowFrom.includes(inviterMxid) ? "join" : "ignore";
}
