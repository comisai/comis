// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the §4.4 woken-turn driver (`buildWokenTurnDriver`,
 * terminal-wake-turn.ts) — the function the wake-FSM calls as
 * `wakeOneTurn(sessionId, owner)`.
 *
 * WR-05 (the audit-accuracy contract): the keystroke audit MUST reflect whether
 * the send was actually DELIVERED. A registry send that returns the degraded
 * not-delivered result (a wedged worker, a dropped tmux send-keys child — spec
 * §4.6) must be audited `outcome:"rejected"`, NEVER `outcome:"attempted"`, so a
 * keystroke that hit nothing is distinguishable from one that reached the pane in
 * the §2.7 logs+events trail.
 *
 * RED on pre-patch: `auditAnswer` hard-codes `outcome:"attempted"`, so a failed
 * send is audited as a successful attempt (both the `terminal:keystroke` event and
 * the keystroke_audit DEBUG log claim `attempted`).
 *
 * In-process fakes + an injected clock; deterministic.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { buildWokenTurnDriver, type WokenTurnDriverDeps, type TerminalAttentionConfig, type DriveJournalStore } from "./terminal-wake-turn.js";
import type { PersistedWakeOwner } from "./terminal-wake-persistence.js";
import { DRIVE_SCOPE_PREFIX } from "./terminal-drive-scope.js";
import type { DriveJournal } from "@comis/skills/tools";

const OWNER: PersistedWakeOwner = { agentId: "a", sessionKey: "" };
/** A PROMOTED wake owner — the FSM carries drive:<id> for a backgrounded drive (DRIVE-01). */
const DRIVE_OWNER: PersistedWakeOwner = { agentId: "a", sessionKey: `${DRIVE_SCOPE_PREFIX}s-1` };
const SAFE_SCREEN = "Press enter to continue";
const CFG: TerminalAttentionConfig = {
  autoAnswer: "safe-only",
  hintPatterns: ["press enter to continue"],
  maxHops: 5,
  maxConcurrentAttentionTurns: 2,
};

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
}

/**
 * A fake owner-scoped registry whose `sendText` returns a controllable result, so a
 * test can simulate a DELIVERED send vs the degraded not-delivered shape.
 *
 * 164-06: the registry is OWNER-GATED exactly like production (`sameOwner` /
 * `ownedHandle`): `status`/`read` resolve the LIVE view ONLY under the session's STAMPED
 * owner (`sessionKey:""`); a call carrying a drive-scoped (or any non-"") owner gets the
 * not-found minimal view (`alive:false`, empty screen). This is how the I5 read-parity test
 * proves the woken-turn driver strips the drive: scope (registryOwnerFor) — without the
 * strip, a promoted turn (wake owner drive:<id>) reads the empty not-found view.
 */
function makeRegistry(opts: { screen: string; sendResult: { screen: string; cursor: { x: number; y: number }; delivered?: boolean } }) {
  const sendText = vi.fn(async () => opts.sendResult);
  const stamped = (owner: { sessionKey?: string }): boolean => owner?.sessionKey === "";
  const liveView = { screen: opts.screen, cursor: { x: 0, y: 0 }, cols: 80, rows: 24, alt: false, alive: true };
  const notFoundView = { screen: "", cursor: { x: 0, y: 0 }, cols: 0, rows: 0, alt: false, alive: false };
  return {
    sendText,
    get: vi.fn(() => ({ sessionId: "s", owner: OWNER }) as never),
    status: vi.fn(async (_id: string, owner: { sessionKey?: string }) =>
      stamped(owner)
        ? { state: "awaiting-input" as const, lastActivity: 0, interactions: 1, cursorParked: true, screenDiffEmpty: true }
        : { state: "exited" as const, lastActivity: 0, interactions: 0, cursorParked: false, screenDiffEmpty: true },
    ),
    read: vi.fn(async (_id: string, owner: { sessionKey?: string }) => (stamped(owner) ? liveView : notFoundView)),
  };
}

interface Emitted {
  event: string;
  payload: Record<string, unknown>;
}

/** An in-memory DriveJournalStore fake mirroring the daemon's closure-local Map (164-06). */
function makeJournalStore(seed?: Map<string, DriveJournal>) {
  const map = seed ?? new Map<string, DriveJournal>();
  const setCalls: Array<{ sessionId: string; journal: DriveJournal }> = [];
  const store: DriveJournalStore = {
    get: vi.fn((sessionId: string) => map.get(sessionId)),
    set: vi.fn((sessionId: string, journal: DriveJournal) => {
      map.set(sessionId, journal);
      setCalls.push({ sessionId, journal });
    }),
  };
  return { store, map, setCalls };
}

function build(opts: {
  screen: string;
  sendResult: { screen: string; cursor: { x: number; y: number }; delivered?: boolean };
  journal?: DriveJournalStore;
  loopRepeat?: boolean;
  autoAnswer?: "none" | "safe-only" | "all";
  hintPatterns?: string[];
}) {
  const registry = makeRegistry(opts);
  const registries = new Map([["a", registry]]);
  const emitted: Emitted[] = [];
  const logger = makeLogger();
  const eventBus = {
    emit: (event: string, payload: Record<string, unknown>) => {
      emitted.push({ event, payload });
      return true;
    },
  };
  const cfg: TerminalAttentionConfig = {
    autoAnswer: opts.autoAnswer ?? CFG.autoAnswer,
    hintPatterns: opts.hintPatterns ?? CFG.hintPatterns,
    maxHops: CFG.maxHops,
    maxConcurrentAttentionTurns: CFG.maxConcurrentAttentionTurns,
  };
  const deps: WokenTurnDriverDeps = {
    registries: registries as unknown as WokenTurnDriverDeps["registries"],
    getTerminalAttentionConfig: () => cfg,
    loopGuard: { observe: vi.fn(() => ({ repeat: opts.loopRepeat ?? false })), forget: vi.fn() },
    eventBus: eventBus as unknown as WokenTurnDriverDeps["eventBus"],
    nowMs: () => 1_000,
    logger: logger as unknown as WokenTurnDriverDeps["logger"],
    ...(opts.journal ? { journal: opts.journal } : {}),
  };
  const wakeOneTurn = buildWokenTurnDriver(deps);
  return { wakeOneTurn, registry, emitted, logger };
}

describe("terminal-wake-turn — woken-turn driver auto-answer audit (WR-05)", () => {
  it("audits outcome:attempted when the registry send is DELIVERED (a real send reached the pane)", async () => {
    const { wakeOneTurn, registry, emitted } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
    });
    await wakeOneTurn("s-1", OWNER);

    expect(registry.sendText).toHaveBeenCalledTimes(1);
    const keystroke = emitted.find((e) => e.event === "terminal:keystroke");
    expect(keystroke, "terminal:keystroke must be emitted").toBeDefined();
    expect(keystroke!.payload.outcome).toBe("attempted");
    // A delivered send DID answer the prompt → terminal:auto_answered is emitted.
    expect(emitted.find((e) => e.event === "terminal:auto_answered")).toBeDefined();
  });

  it("audits outcome:rejected — NOT attempted — when the registry send returns the degraded not-delivered result (WR-05)", async () => {
    // The degraded send shape the registry returns for a wedged worker / dropped
    // tmux send-keys (spec §4.6): empty screen, origin cursor, delivered falsy.
    const { wakeOneTurn, registry, emitted, logger } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "", cursor: { x: 0, y: 0 } },
    });
    await wakeOneTurn("s-1", OWNER);

    expect(registry.sendText).toHaveBeenCalledTimes(1);

    // The keystroke audit event must NOT claim the send was a successful attempt.
    const keystroke = emitted.find((e) => e.event === "terminal:keystroke");
    expect(keystroke, "terminal:keystroke must be emitted even on a failed send").toBeDefined();
    expect(keystroke!.payload.outcome).toBe("rejected");

    // The §2.7 keystroke_audit DEBUG log must mirror the same outcome (logs+events
    // reconstruct the failure: a keystroke that hit nothing is not "attempted").
    const auditLog = logger.debug.mock.calls.find((c) => (c[0] as { step?: string })?.step === "keystroke_audit");
    expect(auditLog, "keystroke_audit DEBUG log must be emitted").toBeDefined();
    expect((auditLog![0] as { outcome?: string }).outcome).toBe("rejected");

    // A not-delivered send did NOT answer the prompt → terminal:auto_answered is NOT
    // emitted (it would falsely claim a safe answer reached the pane).
    expect(emitted.find((e) => e.event === "terminal:auto_answered")).toBeUndefined();
    // A WARN with hint+errorKind surfaces the dropped delivery (§2.7 failure branch).
    const warn = logger.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "wake_turn_send_failed");
    expect(warn, "a not-delivered send must WARN with a hint").toBeDefined();
    expect((warn![0] as { errorKind?: string }).errorKind).toBe("dependency");
  });
});

// ===========================================================================
// 164-06 Task 2: the registry-owner strip (I5) + the bounded content-free
// journal as the promoted drive's cross-wake memory (DRIVE-01).
// ===========================================================================

describe("terminal-wake-turn — registry-owner strip (DRIVE-01 / I5) + the cross-wake journal", () => {
  it("DRIVE-01/I5: a promoted woken turn (wake owner sessionKey=drive:<id>) resolves registry.read via registryOwnerFor → the LIVE non-empty view (alive:true), NOT the not-found view", async () => {
    // The owner-gated registry returns the LIVE view ONLY under the stamped owner
    // (sessionKey:""). The wake owner here is drive:s-1 (a promoted drive). The driver MUST
    // strip it (registryOwnerFor) so registry.read resolves the live session. A regression to
    // the raw drive-scoped owner makes registry.read return the empty alive:false view → RED.
    const { wakeOneTurn, registry } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);

    // read was called with the STAMPED owner (the drive: scope stripped), so it resolved alive.
    expect(registry.read).toHaveBeenCalledTimes(1);
    const readOwner = registry.read.mock.calls[0]![1] as { sessionKey: string };
    expect(readOwner.sessionKey, "the driver must strip drive:<id> → '' for the registry call (I5)").toBe("");
    // status likewise resolved the live session under the stamped owner.
    const statusOwner = registry.status.mock.calls[0]![1] as { sessionKey: string };
    expect(statusOwner.sessionKey).toBe("");
    // The live view drove the turn: the safe pattern matched + a keystroke was sent (proving
    // the screen was the LIVE non-empty screen, not the empty not-found view).
    expect(registry.sendText, "a promoted turn must drive the LIVE session, not the not-found view").toHaveBeenCalledTimes(1);
  });

  it("the raw drive-scoped owner is GONE — the registry call uses registryOwnerFor (source guard)", async () => {
    // Belt-and-braces alongside the behavioral pin: the at-:136 ownerObj is built via the
    // strip, never the raw owner.sessionKey.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./terminal-wake-turn.ts", import.meta.url)), "utf8");
    expect(src, "ownerObj must be built via registryOwnerFor(owner)").toMatch(/registryOwnerFor\(owner\)/);
    expect(src, "the raw `sessionKey: owner.sessionKey` ownerObj must be gone").not.toMatch(/sessionKey:\s*owner\.sessionKey/);
  });

  it("DRIVE-01: a promoted woken turn reads+updates the per-session journal (step appended, lastClassification + redacted lastScreenDigest set)", async () => {
    const { store, map, setCalls } = makeJournalStore();
    const { wakeOneTurn } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);

    // The journal was read (init-on-first-wake) and written back, keyed by the BARE sessionId.
    expect(store.get).toHaveBeenCalledWith("s-1");
    expect(setCalls.length, "the journal must be written back after the turn").toBeGreaterThanOrEqual(1);
    const j = map.get("s-1")!;
    expect(j, "the journal entry must exist after a promoted turn").toBeDefined();
    // A content-free step tag was appended (the action taken — never a keystroke).
    expect(j.stepsTried.length).toBeGreaterThanOrEqual(1);
    // lastClassification reflects the status state (a SHIPPED classifier state).
    expect(["working", "awaiting-input", "exited", "stuck"]).toContain(j.lastClassification);
    // lastScreenDigest is the content-free one-liner (counts/coords), set this wake.
    expect(j.lastScreenDigest, "lastScreenDigest must be set from screenDigestLine").toContain("changed");
    expect(j.lastScreenDigest).toMatch(/cursor@\(/);
    // interactions bumped.
    expect(j.interactions).toBeGreaterThanOrEqual(1);
  });

  it("I3: a secret-shaped screen → the journal lastScreenDigest contains no raw secret", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const { store, map } = makeJournalStore();
    const { wakeOneTurn } = build({
      // The first non-empty line (which screenDigestLine excerpts) carries the secret.
      screen: `your key is ${secret}`,
      sendResult: { screen: "ok", cursor: { x: 0, y: 0 }, delivered: true },
      journal: store,
      // No hint match → escalate path; the digest is still recorded on the journal.
      hintPatterns: ["press enter to continue"],
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);

    const j = map.get("s-1")!;
    expect(j.lastScreenDigest, "the redacted digest must NOT carry the raw secret (I3)").not.toContain(secret);
    expect(j.lastScreenDigest, "the secret must be redacted in the journal digest").toContain("[REDACTED]");
  });

  it("the journal stays within cap across N woken turns (bounded — no unbounded growth)", async () => {
    const { store, map } = makeJournalStore();
    const { wakeOneTurn } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
    });
    // Drive the same promoted session many times — each wake appends a step.
    for (let i = 0; i < 500; i++) {
      // eslint-disable-next-line no-await-in-loop
      await wakeOneTurn("s-1", DRIVE_OWNER);
    }
    const j = map.get("s-1")!;
    // CAP_STEPS is 64 (terminal-drive-journal.ts) — the array is bounded regardless of N.
    expect(j.stepsTried.length, "stepsTried must stay within its cap across N wakes").toBeLessThanOrEqual(64);
    // The drop count is recorded (the I7 breadcrumb), never a silent unbounded append.
    expect(j.truncations, "over-cap appends must record the truncations breadcrumb").toBeGreaterThan(0);
  });

  it("I1: an unpromoted woken turn creates NO journal entry (byte-identical to today)", async () => {
    const { store, map, setCalls } = makeJournalStore();
    const { wakeOneTurn, registry } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
    });
    // OWNER (sessionKey:"") is the unpromoted, today's-path owner.
    await wakeOneTurn("s-1", OWNER);

    // The turn still ran (the unpromoted path is unchanged) …
    expect(registry.status).toHaveBeenCalledTimes(1);
    expect(registry.sendText).toHaveBeenCalledTimes(1);
    // … but the journal was NOT touched (no entry, no set) — I1.
    expect(store.set, "an unpromoted turn must not write a journal").not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
    expect(map.size).toBe(0);
  });

  it("a journal-update failure does NOT throw — the turn still completes", async () => {
    // A store whose set() throws (a corrupted holder) must be swallowed: the woken turn is
    // near-stateless + never-throws (the FSM re-wake contract). The send still happens.
    const throwingStore: DriveJournalStore = {
      get: vi.fn(() => undefined),
      set: vi.fn(() => {
        throw new Error("journal holder corrupted");
      }),
    };
    const { wakeOneTurn, registry, logger } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: throwingStore,
    });

    await expect(wakeOneTurn("s-1", DRIVE_OWNER)).resolves.toBeUndefined();
    // The turn completed its real work despite the journal fault.
    expect(registry.sendText).toHaveBeenCalledTimes(1);
    // The fault is surfaced (a WARN with hint+errorKind, §2.7), not silently dropped.
    const warn = logger.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "journal_update");
    expect(warn, "a journal-update failure must WARN with step:journal_update").toBeDefined();
    expect((warn![0] as { errorKind?: string }).errorKind).toBeDefined();
  });

  it("IN-03: a degenerate owner (non-string sessionKey) does NOT throw the turn — promoted resolves defensively like registryOwnerFor", async () => {
    // registryOwnerFor narrows a non-string sessionKey to "" (the woken-turn driver + the
    // active-check call it on EVERY wake, so a throw would strand the turn). The `promoted`
    // gate must use the SAME total accessor — a raw `owner.sessionKey.startsWith(...)` throws
    // on a degenerate owner (TypeError: startsWith of undefined). RED on pre-patch: the raw
    // `.startsWith` rejects the promise.
    const { store, map } = makeJournalStore();
    const { wakeOneTurn, registry } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
    });
    // A degenerate owner a future producer might hand: agentId present, sessionKey missing.
    const degenerate = { agentId: "a" } as unknown as PersistedWakeOwner;
    await expect(wakeOneTurn("s-1", degenerate)).resolves.toBeUndefined();
    // The turn still ran its real work (the registry resolved via the stamped owner).
    expect(registry.status).toHaveBeenCalledTimes(1);
    // A degenerate (non-drive) owner is treated as unpromoted → no journal write (I1).
    expect(store.set).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it("IN-03: the promoted gate uses the same total accessor as the registry owner (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./terminal-wake-turn.ts", import.meta.url)), "utf8");
    // The raw, throw-prone `promoted = owner.sessionKey.startsWith(...)` assignment must be
    // gone — replaced by the total `isDriveScoped(owner)` predicate (the same defensive narrow
    // registryOwnerFor uses). (The regex targets the assignment, not prose mentioning it.)
    expect(src, "the raw owner.sessionKey.startsWith promoted gate must be gone").not.toMatch(
      /promoted\s*=\s*owner\.sessionKey\.startsWith/,
    );
    expect(src, "promoted must derive from the total isDriveScoped accessor").toMatch(
      /promoted\s*=\s*isDriveScoped\(owner\)/,
    );
  });
});
