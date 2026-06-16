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
    // HI-01 (165-REVIEW): the stop path the spend breach drives (the reaper-backed evict that
    // emits terminal:session_evicted → the holder de-promotes + removes the journal/descriptor).
    evict: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
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
  /** A controllable clock — MR-01 elapsedMs-advances pins drive it forward across wakes. */
  nowMs?: () => number;
  /** The drive's start ms (MR-01) — `elapsedMs = nowMs() - driveStartMs`. */
  driveStartMs?: (sessionId: string) => number;
  /** ENDURE-01 (165-07): the per-drive spend ceiling (USD), or null/undefined for uncapped. */
  maxCostUsd?: number | null;
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
    nowMs: opts.nowMs ?? (() => 1_000),
    logger: logger as unknown as WokenTurnDriverDeps["logger"],
    ...(opts.journal ? { journal: opts.journal } : {}),
    ...(opts.driveStartMs ? { driveStartMs: opts.driveStartMs } : {}),
    ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
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

// ===========================================================================
// MR-01: the journal writer populates the LOCKED §7.1.6 fields the resume
// substrate needs — answeredPrompts[] (the DRIVE-01 "resume without re-answering"
// dedup substrate, content-free pattern ids), elapsedMs (drive start → now),
// and costUsd (0 + a documented note — no spend signal at the canned-keystroke
// auto-answer seam). RED on pre-patch: recordJournal only wrote stepsTried +
// lastClassification + lastScreenDigest + interactions, so answeredPrompts stayed
// [] and elapsedMs stayed 0 forever (the exported appendAnswered had no caller).
// ===========================================================================

describe("terminal-wake-turn — MR-01: the journal populates answeredPrompts / elapsedMs (DRIVE-01 resume substrate)", () => {
  it("a promoted drive that auto-answers a safe prompt records a content-free answeredPrompts entry (pattern id, not raw text)", async () => {
    const { store, map } = makeJournalStore();
    const { wakeOneTurn } = build({
      screen: SAFE_SCREEN, // matches hintPatterns[0] → matchedPatternIndex 0
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);

    const j = map.get("s-1")!;
    // answeredPrompts is no longer always-empty: a delivered safe answer appends a tag.
    expect(j.answeredPrompts.length, "a delivered safe answer must append an answeredPrompts tag").toBe(1);
    // The tag is the content-free matched-pattern identity (an id), never the prompt text (I3).
    expect(j.answeredPrompts[0]).toBe("pattern:0");
    expect(j.answeredPrompts[0]).not.toContain("Press enter"); // never the raw prompt
  });

  it("answeredPrompts accumulates ONE entry per delivered safe answer across N wakes (the dedup substrate, capped)", async () => {
    const { store, map } = makeJournalStore();
    const { wakeOneTurn } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
    });
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await wakeOneTurn("s-1", DRIVE_OWNER);
    }
    const j = map.get("s-1")!;
    // 5 delivered answers → 5 answeredPrompts entries (all pattern:0 here), bounded by the cap.
    expect(j.answeredPrompts.length).toBe(5);
    expect(j.answeredPrompts.every((t) => t === "pattern:0")).toBe(true);
  });

  it("an ESCALATED turn does NOT append to answeredPrompts (only a delivered safe answer does)", async () => {
    const { store, map } = makeJournalStore();
    const { wakeOneTurn } = build({
      // A destructive prompt → escalate (no answer), but the journal still records the step.
      screen: "Permanently delete all files? (y/n)",
      sendResult: { screen: "ok", cursor: { x: 0, y: 0 }, delivered: true },
      journal: store,
      hintPatterns: ["(y/n)"],
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);

    const j = map.get("s-1")!;
    expect(j.answeredPrompts, "an escalated turn answered no prompt").toEqual([]);
    // The step IS recorded (the escalation is cross-wake memory) — just not as an answer.
    expect(j.stepsTried.length).toBeGreaterThanOrEqual(1);
  });

  it("a NOT-delivered safe answer does NOT append to answeredPrompts (nothing was actually answered, WR-05 parity)", async () => {
    const { store, map } = makeJournalStore();
    const { wakeOneTurn } = build({
      screen: SAFE_SCREEN,
      // Degraded send: delivered falsy → the keystroke hit nothing → it did not answer.
      sendResult: { screen: "", cursor: { x: 0, y: 0 } },
      journal: store,
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);

    const j = map.get("s-1")!;
    expect(j.answeredPrompts, "a not-delivered send answered nothing → no answeredPrompts entry").toEqual([]);
  });

  it("elapsedMs advances across wakes (drive start → now, via the injected clock)", async () => {
    const { store, map } = makeJournalStore();
    let clock = 10_000;
    const driveStart = 10_000;
    const { wakeOneTurn } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
      nowMs: () => clock,
      driveStartMs: () => driveStart,
    });

    await wakeOneTurn("s-1", DRIVE_OWNER);
    const firstElapsed = map.get("s-1")!.elapsedMs;
    // First wake at the start → elapsed ~0 (not the always-0 of the pre-patch journal, which
    // never set the field — here it is explicitly derived from the clock).
    expect(firstElapsed).toBe(0);

    clock = 35_000; // 25s later
    await wakeOneTurn("s-1", DRIVE_OWNER);
    const secondElapsed = map.get("s-1")!.elapsedMs;
    expect(secondElapsed, "elapsedMs must advance with the clock").toBe(25_000);
    expect(secondElapsed).toBeGreaterThan(firstElapsed);
  });

  it("elapsedMs is content-free (a number) and never negative even if the clock is degenerate", async () => {
    const { store, map } = makeJournalStore();
    const { wakeOneTurn } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
      nowMs: () => 5_000,
      driveStartMs: () => 9_999, // start AFTER now (a degenerate/late-stamped start)
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);
    const j = map.get("s-1")!;
    expect(typeof j.elapsedMs).toBe("number");
    expect(j.elapsedMs, "a degenerate clock must never yield a negative elapsedMs").toBeGreaterThanOrEqual(0);
  });

  it("without a driveStartMs accessor the driver falls back to this turn's start (elapsedMs ≥ 0, never throws)", async () => {
    const { store, map } = makeJournalStore();
    const { wakeOneTurn } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
      nowMs: () => 1_000,
      // no driveStartMs — the daemon may not always supply one; the driver must still write
      // a sane (≥0) elapsedMs and never throw.
    });
    await expect(wakeOneTurn("s-1", DRIVE_OWNER)).resolves.toBeUndefined();
    expect(map.get("s-1")!.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// 165-07 Task 3 (ENDURE-01): the spend-ceiling escalate path. On each PROMOTED turn the
// driver reads the journal's honest run-total costUsd (I6 — NEVER fabricated) and runs the
// pure checkSpendCeiling over deps.maxCostUsd; a breach escalates with the figure + a §2.7
// WARN and STOPS the turn (no answer) — never a silent overspend. A null/absent ceiling is
// a no-op (I1, byte-identical to today). RED on pre-patch: the driver never consults
// checkSpendCeiling, so a journal whose costUsd exceeds the ceiling still auto-answers.
// ===========================================================================

describe("terminal-wake-turn — ENDURE-01: the spend-ceiling escalate path", () => {
  it("a journal costUsd OVER drive.maxCostUsd escalates (terminal:escalated) + STOPS the turn (no answer)", async () => {
    // Seed a resumed/accumulated journal whose run-total already exceeds the ceiling.
    const seed = new Map<string, DriveJournal>([
      ["s-1", { objective: "build", lastClassification: "awaiting-input", lastScreenDigest: "", answeredPrompts: [], stepsTried: [], elapsedMs: 0, interactions: 3, costUsd: 7.5, truncations: 0 }],
    ]);
    const { store } = makeJournalStore(seed);
    const { wakeOneTurn, registry, emitted, logger } = build({
      screen: SAFE_SCREEN, // a safe-answerable prompt — but the spend breach must pre-empt the answer
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
      maxCostUsd: 5,
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);

    // The drive STOPPED on the breach — no keystroke sent (never a silent overspend).
    expect(registry.sendText, "a spend breach must STOP the turn — no auto-answer").not.toHaveBeenCalled();
    // It escalated to a human via terminal:escalated.
    const escalated = emitted.find((e) => e.event === "terminal:escalated");
    expect(escalated, "a spend breach must emit terminal:escalated").toBeDefined();
    expect(escalated!.payload).toMatchObject({ sessionId: "s-1", agentId: "a" });
    // A §2.7 WARN names the breach with hint+errorKind + the figure (the spend ceiling).
    const warn = logger.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "spend_ceiling");
    expect(warn, "a spend breach must WARN with step:spend_ceiling").toBeDefined();
    expect(typeof (warn![0] as { hint?: string }).hint).toBe("string");
    expect((warn![0] as { errorKind?: string }).errorKind).toBeDefined();
  });

  it("a journal costUsd AT the ceiling does NOT breach (strict >, the budget is not yet over)", async () => {
    const seed = new Map<string, DriveJournal>([
      ["s-1", { objective: "build", lastClassification: "awaiting-input", lastScreenDigest: "", answeredPrompts: [], stepsTried: [], elapsedMs: 0, interactions: 1, costUsd: 5, truncations: 0 }],
    ]);
    const { store } = makeJournalStore(seed);
    const { wakeOneTurn, registry, emitted } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
      maxCostUsd: 5,
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);
    // At the cap the budget is not yet over → the turn answers normally (no escalate).
    expect(registry.sendText, "AT the ceiling the turn proceeds (strict >)").toHaveBeenCalledTimes(1);
    expect(emitted.find((e) => e.event === "terminal:escalated"), "no escalate at the exact cap").toBeUndefined();
  });

  it("I1: a null maxCostUsd is a no-op — the turn behaves byte-identically to today (answers)", async () => {
    const seed = new Map<string, DriveJournal>([
      ["s-1", { objective: "build", lastClassification: "awaiting-input", lastScreenDigest: "", answeredPrompts: [], stepsTried: [], elapsedMs: 0, interactions: 1, costUsd: 9_999, truncations: 0 }],
    ]);
    const { store } = makeJournalStore(seed);
    const { wakeOneTurn, registry, emitted } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
      maxCostUsd: null, // uncapped — even a huge costUsd never breaches (I1)
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);
    expect(registry.sendText, "a null ceiling never breaches (I1)").toHaveBeenCalledTimes(1);
    expect(emitted.find((e) => e.event === "terminal:escalated")).toBeUndefined();
  });

  it("I1: an UNPROMOTED turn never consults the spend ceiling (the spend check is drive-only)", async () => {
    // No journal store engaged for an unpromoted owner; even a configured ceiling is inert.
    const { wakeOneTurn, registry, emitted } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      maxCostUsd: 0.0001, // a tiny ceiling — but an unpromoted turn has no drive journal to check
    });
    await wakeOneTurn("s-1", OWNER);
    expect(registry.sendText, "an unpromoted turn ignores the spend ceiling (I1)").toHaveBeenCalledTimes(1);
    expect(emitted.find((e) => e.event === "terminal:escalated")).toBeUndefined();
  });

  it("I6: the spend check reads the journal's honest costUsd and does NOT fabricate a cost (the canned-keystroke seam stays 0)", async () => {
    const { store, map } = makeJournalStore();
    const { wakeOneTurn } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
      maxCostUsd: 5,
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);
    // The canned-keystroke auto-answer has no LLM spend → costUsd stays the honest 0 (I6).
    expect(map.get("s-1")!.costUsd, "the woken-turn seam must not fabricate a cost (I6)").toBe(0);
  });

  // HI-01 (165-REVIEW): a spend breach must STOP the drive, not just the turn. Pre-patch the
  // turn escalated + returned but left the session alive + promoted, so the NEXT wake re-checked
  // the ceiling, re-breached, re-escalated — indefinitely (a re-escalation storm). The fix:
  // dedupe with a breachedSessions Set (one escalate) + actually stop the drive via the
  // registry evict path (descriptor+journal lifecycle + de-promote run) so it is not re-woken.
  it("HI-01: a spend breach STOPS the drive (registry.evict) — two wakes yield EXACTLY ONE escalate + ONE stop (no re-escalation storm)", async () => {
    const seed = new Map<string, DriveJournal>([
      ["s-1", { objective: "build", lastClassification: "awaiting-input", lastScreenDigest: "", answeredPrompts: [], stepsTried: [], elapsedMs: 0, interactions: 3, costUsd: 7.5, truncations: 0 }],
    ]);
    const { store } = makeJournalStore(seed);
    const { wakeOneTurn, registry, emitted } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
      maxCostUsd: 5,
    });

    // Two wakes for the same over-budget drive (what the fd3 loop / backstop would do).
    await wakeOneTurn("s-1", DRIVE_OWNER);
    await wakeOneTurn("s-1", DRIVE_OWNER);

    // EXACTLY ONE escalate (the dedupe broke the storm) + the drive was actually STOPPED once.
    const escalations = emitted.filter((e) => e.event === "terminal:escalated");
    expect(escalations, "a single breach = a single escalate (no re-escalation storm)").toHaveLength(1);
    expect(registry.evict, "the breach must STOP the drive via the registry evict path (descriptor+journal lifecycle + de-promote)").toHaveBeenCalledTimes(1);
    expect(registry.evict).toHaveBeenCalledWith("s-1", expect.objectContaining({ sessionKey: "" }), expect.any(String));
    // The drive never auto-answered (never a silent overspend), on either wake.
    expect(registry.sendText).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 165-07 Task 3 (DUR-02 / I10): the resume-no-re-answer guard. On the FIRST turn of a
// RESUMED drive this daemon life (its journal came back from disk with prior answeredPrompts
// — the in-memory loop-guard ring is cold post-restart), a matched pattern already in
// answeredPrompts is SKIPPED (the send is NOT re-issued) + a content-free waited step is
// recorded. A LIVE drive (journal accumulated this life) is governed by the loop-guard, NOT
// this guard, so it still answers (no behavior change for the live path). RED on pre-patch:
// the driver re-sends a matched pattern even when the resumed journal already answered it.
// ===========================================================================

describe("terminal-wake-turn — DUR-02/I10: the resume-no-re-answer guard", () => {
  it("a RESUMED drive whose journal already answered pattern 0 SKIPS the re-send on its first turn this life (sendText: 0 calls)", async () => {
    // The seeded journal is the RESUMED one (prior life answered pattern:0); the loop-guard
    // ring is empty (post-restart), so without the resume guard the driver would re-answer.
    const seed = new Map<string, DriveJournal>([
      ["s-1", { objective: "build", lastClassification: "awaiting-input", lastScreenDigest: "", answeredPrompts: ["pattern:0"], stepsTried: ["answered"], elapsedMs: 1_000, interactions: 2, costUsd: 0, truncations: 0 }],
    ]);
    const { store, map } = makeJournalStore(seed);
    const { wakeOneTurn, registry } = build({
      screen: SAFE_SCREEN, // matches hintPatterns[0] → matchedPatternIndex 0 (already answered)
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);

    // The already-answered pattern is NOT re-sent (I10 — resume, don't re-answer).
    expect(registry.sendText, "a resumed drive must NOT re-answer an already-answered prompt").not.toHaveBeenCalled();
    // A content-free waited step is recorded (the turn did something — it waited, didn't answer).
    const j = map.get("s-1")!;
    expect(j.stepsTried.at(-1), "the resumed skip records a content-free waited step").toBe("waited");
    // No NEW answeredPrompts entry (it was already answered; the skip does not double-record).
    expect(j.answeredPrompts.filter((t) => t === "pattern:0").length, "the skip must not double-append the pattern").toBe(1);
  });

  it("a LIVE drive (journal accumulated THIS life, not resumed) still answers a repeated pattern — the loop-guard governs repeats, not this guard (the MR-01 accumulation is unchanged)", async () => {
    const { store, map } = makeJournalStore();
    const { wakeOneTurn, registry } = build({
      screen: SAFE_SCREEN,
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
    });
    // Turn 1: a fresh (empty) journal this life → answers, appends pattern:0.
    await wakeOneTurn("s-1", DRIVE_OWNER);
    // Turn 2: the journal now has pattern:0 but it was accumulated LIVE (not resumed) → the
    // live path answers again (the loop-guard, faked off here, is the live-repeat handler).
    await wakeOneTurn("s-1", DRIVE_OWNER);
    expect(registry.sendText, "a live drive answers each turn (the resume guard only skips a RESUMED first turn)").toHaveBeenCalledTimes(2);
    expect(map.get("s-1")!.answeredPrompts.length, "the live MR-01 accumulation is unchanged").toBe(2);
  });

  it("a RESUMED drive whose journal answered a DIFFERENT pattern still answers the current one (the skip is pattern-specific)", async () => {
    // Resumed journal answered pattern:3; the current screen matches pattern:0 → NOT skipped.
    const seed = new Map<string, DriveJournal>([
      ["s-1", { objective: "build", lastClassification: "awaiting-input", lastScreenDigest: "", answeredPrompts: ["pattern:3"], stepsTried: ["answered"], elapsedMs: 1_000, interactions: 2, costUsd: 0, truncations: 0 }],
    ]);
    const { store } = makeJournalStore(seed);
    const { wakeOneTurn, registry } = build({
      screen: SAFE_SCREEN, // matchedPatternIndex 0 — a DIFFERENT pattern from the answered 3
      sendResult: { screen: "ok", cursor: { x: 1, y: 1 }, delivered: true },
      journal: store,
    });
    await wakeOneTurn("s-1", DRIVE_OWNER);
    expect(registry.sendText, "a resumed drive answers a pattern it has NOT yet answered").toHaveBeenCalledTimes(1);
  });

  it("the spend check + resume guard are wired in terminal-wake-turn.ts (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./terminal-wake-turn.ts", import.meta.url)), "utf8");
    expect(src, "the turn must consult checkSpendCeiling over the journal costUsd").toMatch(/checkSpendCeiling\(/);
    expect(src, "the turn must guard a resumed already-answered prompt via answeredPrompts.includes").toMatch(/answeredPrompts\.includes\(/);
  });
});

// ===========================================================================
// ISSUE-3 (live VPS 2026-06-16): a DETACHED drive whose session was created in a
// request context (chat-API / Telegram) is STAMPED under owner (userId, nonEmptyKey)
// — terminal-tools.ts resolveOwner. The worker→daemon re-publish drops that identity
// (setup-terminal-tools.ts emits agentId only), so the daemon wake path builds
// (realAgentId, ""), and registryOwnerFor cannot recover the userId/sessionKey. The
// woken-turn driver must recover the STAMPED owner the registry holds (registry.getOwner)
// and thread IT into status/read/sendText — else every detached channel/API drive strands.
// ===========================================================================
describe("terminal-wake-turn — ISSUE-3: a channel/API-stamped session drives via the recovered STAMPED owner (getOwner)", () => {
  it("drives the LIVE session stamped under (userId, nonEmptyKey) — RED pre-fix (registryOwnerFor → not-found view → no drive)", async () => {
    const STAMPED = { agentId: "openai-api", sessionKey: "default:openai-api:openai" };
    const liveView = { screen: SAFE_SCREEN, cursor: { x: 0, y: 0 }, cols: 80, rows: 24, alt: false, alive: true };
    const notFoundView = { screen: "", cursor: { x: 0, y: 0 }, cols: 0, rows: 0, alt: false, alive: false };
    const owned = (o: { agentId?: string; sessionKey?: string }): boolean =>
      o?.agentId === STAMPED.agentId && o?.sessionKey === STAMPED.sessionKey;
    const sendText = vi.fn(async () => ({ screen: "ok", cursor: { x: 1, y: 1 }, delivered: true }));
    const registry = {
      // The registry HOLDS the session's stamped owner — the daemon's trusted recovery seam.
      getOwner: vi.fn((_id: string) => STAMPED),
      sendText,
      get: vi.fn((_id: string, o: { agentId?: string; sessionKey?: string }) => (owned(o) ? { sessionId: "s", owner: STAMPED } : undefined)),
      status: vi.fn(async (_id: string, o: { agentId?: string; sessionKey?: string }) =>
        owned(o)
          ? { state: "awaiting-input" as const, lastActivity: 0, interactions: 1, cursorParked: true, screenDiffEmpty: true }
          : { state: "exited" as const, lastActivity: 0, interactions: 0, cursorParked: false, screenDiffEmpty: true },
      ),
      read: vi.fn(async (_id: string, o: { agentId?: string; sessionKey?: string }) => (owned(o) ? liveView : notFoundView)),
      evict: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    };
    // registries is keyed by the REAL agentId; the wake owner the daemon derives is (realAgentId, "").
    const registries = new Map([["default", registry]]);
    const deps: WokenTurnDriverDeps = {
      registries: registries as unknown as WokenTurnDriverDeps["registries"],
      getTerminalAttentionConfig: () => CFG,
      loopGuard: { observe: vi.fn(() => ({ repeat: false })), forget: vi.fn() },
      eventBus: { emit: vi.fn(() => true) } as unknown as WokenTurnDriverDeps["eventBus"],
      nowMs: () => 1_000,
      logger: makeLogger() as unknown as WokenTurnDriverDeps["logger"],
    };
    const wakeOneTurn = buildWokenTurnDriver(deps);

    // The wake owner the daemon builds for a non-promoted channel session: real agentId, empty key.
    await wakeOneTurn("s-1", { agentId: "default", sessionKey: "" });

    // Pre-fix the driver used registryOwnerFor → (default,"") → not-found → no drive. Post-fix it
    // recovers STAMPED via getOwner → live view → it answers the safe prompt.
    expect(registry.sendText, "the woken turn must DRIVE the live channel/API session, not the not-found view").toHaveBeenCalledTimes(1);
    const readOwner = registry.read.mock.calls[0]?.[1];
    expect(readOwner, "read must use the recovered STAMPED owner, not (realAgentId,'')").toMatchObject(STAMPED);
  });
});
