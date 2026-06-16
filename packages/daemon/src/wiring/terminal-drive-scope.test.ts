// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure drive-scope helpers (`terminal-drive-scope.ts`, DRIVE-01 /
 * 164-06 Task 1) — the two-owner split that lets a PROMOTED drive's woken turns run
 * under a dedicated `drive:<sessionId>` attribution key while every REGISTRY call still
 * resolves the session's STAMPED owner (`sessionKey:""`).
 *
 * The three pure functions:
 *   - `driveScopeKeyFor(sessionId, promoted)` → `drive:<id>` when promoted, else `""`
 *     (the FSM/journal/conversation attribution key; NOT the registry-authorization owner).
 *   - `registryOwnerFor(owner)` → strips a `drive:`-scoped `sessionKey` back to the stamped
 *     registry owner (`sessionKey:""`), passing a NON-drive (real subagent) key through
 *     unchanged — the I5 read-parity anchor (a promoted turn resolves the live session, not
 *     the not-found view).
 *   - `DRIVE_SCOPE_PREFIX` — the reserved `"drive:"` prefix `formatSessionKey` NEVER produces
 *     (A4: a subagent key derives from `sub-agent:<uuid>`), so the drive-scope key cannot
 *     collide with a real owner.
 *
 * RED on pre-patch: `terminal-drive-scope.ts` does not exist (the import fails).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

import { formatSessionKey } from "@comis/core";

import { DRIVE_SCOPE_PREFIX, driveScopeKeyFor, registryOwnerFor, isDriveScoped } from "./terminal-drive-scope.js";
import type { PersistedWakeOwner } from "./terminal-wake-persistence.js";

describe("terminal-drive-scope — the pure two-owner split (DRIVE-01 / I5 / A4)", () => {
  it("driveScopeKeyFor returns drive:<id> when promoted, '' when not", () => {
    expect(driveScopeKeyFor("sess-42", true)).toBe(`${DRIVE_SCOPE_PREFIX}sess-42`);
    expect(driveScopeKeyFor("sess-42", false)).toBe("");
    // The prefix is the reserved string, not a random value.
    expect(driveScopeKeyFor("sess-42", true).startsWith("drive:")).toBe(true);
  });

  it("registryOwnerFor strips a drive: scope back to the stamped sessionKey:''", () => {
    const wakeOwner: PersistedWakeOwner = { agentId: "agent-1", sessionKey: `${DRIVE_SCOPE_PREFIX}sess-7` };
    const stamped = registryOwnerFor(wakeOwner);
    // The registry owner is the STAMPED owner — the drive scope is stripped, so a
    // promoted turn's registry call resolves the live session (I5), not the not-found view.
    expect(stamped).toEqual({ agentId: "agent-1", sessionKey: "" });
  });

  it("registryOwnerFor passes a non-drive (real subagent) sessionKey through unchanged", () => {
    // A real subagent owner must be preserved verbatim — the strip only collapses the
    // reserved drive: prefix, never a genuine cross-owner key.
    const subagentKey = formatSessionKey({ tenantId: "default", userId: "u", channelId: `sub-agent:${randomUUID()}` });
    const subagentOwner: PersistedWakeOwner = { agentId: "agent-1", sessionKey: subagentKey };
    expect(registryOwnerFor(subagentOwner)).toEqual({ agentId: "agent-1", sessionKey: subagentKey });
  });

  it("registryOwnerFor passes the today-path stamped owner (sessionKey:'') through unchanged", () => {
    const stamped: PersistedWakeOwner = { agentId: "agent-1", sessionKey: "" };
    expect(registryOwnerFor(stamped)).toEqual({ agentId: "agent-1", sessionKey: "" });
  });

  it("registryOwnerFor never throws on a degenerate owner (total)", () => {
    // A malformed owner must degrade safely, never throw (the woken-turn driver calls this
    // on every wake; a throw would strand the turn).
    expect(() => registryOwnerFor({ agentId: "a", sessionKey: undefined as unknown as string })).not.toThrow();
    expect(() => registryOwnerFor(undefined as unknown as PersistedWakeOwner)).not.toThrow();
  });

  it("IN-03: isDriveScoped is the SAME total accessor registryOwnerFor uses (a drive: owner is scoped; '' and a real subagent key are not)", () => {
    expect(isDriveScoped({ agentId: "a", sessionKey: `${DRIVE_SCOPE_PREFIX}sess-1` })).toBe(true);
    expect(isDriveScoped({ agentId: "a", sessionKey: "" })).toBe(false);
    const subagentKey = formatSessionKey({ tenantId: "default", userId: "u", channelId: `sub-agent:${randomUUID()}` });
    expect(isDriveScoped({ agentId: "a", sessionKey: subagentKey })).toBe(false);
  });

  it("IN-03: isDriveScoped never throws on a degenerate owner (total — the same defensive narrow as registryOwnerFor)", () => {
    // The woken-turn driver's `promoted` gate calls this on every wake; a raw
    // `owner.sessionKey.startsWith(...)` throws on a missing/non-string key — isDriveScoped
    // narrows defensively (false) just like registryOwnerFor.
    expect(() => isDriveScoped({ agentId: "a", sessionKey: undefined as unknown as string })).not.toThrow();
    expect(isDriveScoped({ agentId: "a", sessionKey: undefined as unknown as string })).toBe(false);
    expect(() => isDriveScoped(undefined as unknown as PersistedWakeOwner)).not.toThrow();
    expect(isDriveScoped(undefined as unknown as PersistedWakeOwner)).toBe(false);
    expect(isDriveScoped({ agentId: "a", sessionKey: 5 as unknown as string })).toBe(false);
  });

  it("A4: DRIVE_SCOPE_PREFIX is a value formatSessionKey never produces (no collision with a real subagent key)", () => {
    // A subagent's channelId is "sub-agent:<uuid>"; formatSessionKey derives the per-run key
    // as `{tenantId}:{userId}:{channelId}…`. Over many runs, NONE start with the reserved
    // drive: prefix — so the drive-scope attribution key can never equal a real owner (the
    // registry owner-gate stays the boundary).
    for (let i = 0; i < 200; i++) {
      const key = formatSessionKey({ tenantId: "default", userId: "u", channelId: `sub-agent:${randomUUID()}` });
      expect(key.startsWith(DRIVE_SCOPE_PREFIX)).toBe(false);
    }
    // And a plain channel key likewise never collides.
    expect(formatSessionKey({ tenantId: "default", userId: "u", channelId: "discord-chan" }).startsWith(DRIVE_SCOPE_PREFIX)).toBe(false);
  });
});
