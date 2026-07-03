// SPDX-License-Identifier: Apache-2.0
/**
 * The origin key that scopes a terminal session's visibility.
 *
 * A `SessionOwner` is the pair `(agentId, sessionKey)`. The `sessionId` stays the
 * opaque worker handle; OWNERSHIP — not the handle — is the authorization gate the
 * registry filters `list`/`read`/`get`/`kill`/`send*` by. Two SUBAGENT runs of the
 * same parent share an `agentId` but differ on `sessionKey` (a subagent's
 * `channelId` is `"sub-agent:<uuid>"`, so `formatSessionKey()` yields a distinct
 * string per run — `packages/core/src/domain/session-key.ts:78-79`), so they are
 * MUTUALLY INVISIBLE: a cross-owner read/get returns the not-found minimal view /
 * `undefined`, never the other owner's bytes.
 *
 * Net-new vs `ProcessRegistry` (which keys per-`agentId` only). Extracted to its OWN
 * module (zero imports) so the
 * registry stays under the 800-line architecture cap; the worker is owner-agnostic
 * (it only knows `sessionId`).
 *
 * @module
 */

/** The origin key scoping a session's visibility — `(agentId, sessionKey)`. */
export interface SessionOwner {
  /** The owning agent id (the tool derives it from `tryGetContext().userId`, fallback `deps.agentId`). */
  agentId: string;
  /**
   * The per-origin session key (the tool derives it from `tryGetContext().sessionKey`,
   * fallback `""`). Distinguishes subagent runs of the same `agentId` (each subagent
   * `channelId` is `"sub-agent:<uuid>"`), making sibling subagents mutually invisible.
   */
  sessionKey: string;
}

/**
 * True iff two owners are the SAME origin — both `agentId` AND `sessionKey` match.
 * The registry treats an owner mismatch EXACTLY as not-found (no information leak):
 * a cross-owner read returns the empty minimal view, a cross-owner get returns
 * `undefined`, and a cross-owner kill / send* is a no-op / degraded snapshot.
 */
export function sameOwner(a: SessionOwner, b: SessionOwner): boolean {
  return a.agentId === b.agentId && a.sessionKey === b.sessionKey;
}
