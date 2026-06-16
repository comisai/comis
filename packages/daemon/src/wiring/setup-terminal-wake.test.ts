// SPDX-License-Identifier: Apache-2.0
/**
 * 124-09 Task 2 (THE KEYSTONE, TR-07 / SEC-11 / SEC-12 / OPS-08 / OPS-09) — the daemon
 * SUBSCRIBE wiring that makes the attention loop LIVE.
 *
 * `setupTerminalWake(deps)` constructs the recurring wake-FSM (124-07) against the daemon
 * `TypedEventBus`, binds `isSessionActive` to the P4 owner-scoped registry, binds
 * `escalate` to a `terminal:escalated` emit + a NotifyFn, and binds `wakeOneTurn` to the
 * §4.4 woken-turn driver: `session_status` → read the frame → `decideAutoAnswer` (safe-only)
 * → on a safe match send the canned keystroke (audited: `terminal:auto_answered`) + run the
 * loop-guard; on escalate send NOTHING + emit `terminal:escalated`. A repeated normalized
 * prompt across woken turns trips the loop-guard → escalate `loop_detected`.
 *
 * RED on pre-patch: setup-terminal-wake.ts does not exist (the import fails); no subscriber
 * binds `terminal:input_needed`, so a scripted prompt wakes no turn.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { setupTerminalWake, type SetupTerminalWakeDeps } from "./setup-terminal-wake.js";
import { WAKE_DIR_NAME } from "./terminal-wake-persistence.js";
import type { DriveJournal as DriveJournalShape } from "@comis/skills/tools";

// ---------------------------------------------------------------------------
// A capturing TypedEventBus-shaped fake: records emits + fires `on` handlers.
// ---------------------------------------------------------------------------
function makeBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    emitted,
    emit(event: string, payload: Record<string, unknown>) {
      emitted.push({ event, payload });
      const set = handlers.get(event);
      if (set) for (const h of set) h(payload);
      return true;
    },
    on(event: string, handler: (data: unknown) => void) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return this;
    },
    off(event: string, handler: (data: unknown) => void) {
      handlers.get(event)?.delete(handler);
      return this;
    },
    /** Simulate the Task-1 hook re-publishing an fd3 input_needed onto the bus. */
    fireInputNeeded(sessionId: string, agentId: string, reason = "settled_cursor_parked") {
      this.emit("terminal:input_needed", { sessionId, agentId, state: "awaiting-input", reason, timestamp: 1 });
    },
    /** DRIVE-02 (164-04): simulate the skills wait tool emitting a content-free promotion. */
    fireDrivePromoted(sessionId: string, agentId: string, reason: "producing" | "mode_detached" = "producing") {
      this.emit("terminal:drive_promoted", { sessionId, agentId, reason, timestamp: 1 });
    },
  };
}

/** A fake per-agent registry: owner-scoped get/status/read/sendText with a scriptable screen. */
function makeRegistry(opts: { screen: string; alive?: boolean }) {
  // delivered:true mirrors the production registry's ok-reply path (WR-05) — a send that
  // round-trips a live worker is delivered, so the woken turn audits it as a real answer.
  const sendText = vi.fn(async () => ({ screen: opts.screen, cursor: { x: 0, y: 0 }, delivered: true }));
  return {
    sendText,
    get: vi.fn(() => (opts.alive === false ? undefined : ({ sessionId: "s", owner: { agentId: "a", sessionKey: "" } } as never))),
    status: vi.fn(async () => ({
      state: "awaiting-input" as const,
      lastActivity: 0,
      interactions: 1,
      cursorParked: true,
      screenDiffEmpty: true,
    })),
    read: vi.fn(async () => ({
      screen: opts.screen,
      cursor: { x: 0, y: 0 },
      cols: 80,
      rows: 24,
      alt: false,
      alive: true,
    })),
  };
}

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

interface Built {
  bus: ReturnType<typeof makeBus>;
  registry: ReturnType<typeof makeRegistry>;
  logger: ReturnType<typeof makeLogger>;
  notify: ReturnType<typeof vi.fn>;
  handle: ReturnType<typeof setupTerminalWake>;
}

function build(dataDir: string, opts: { screen: string; alive?: boolean; autoAnswer?: "none" | "safe-only" | "all"; hintPatterns?: string[] }): Built {
  const bus = makeBus();
  const registry = makeRegistry({ screen: opts.screen, alive: opts.alive });
  const logger = makeLogger();
  const notify = vi.fn(async () => undefined);
  const registries = new Map<string, ReturnType<typeof makeRegistry>>([["a", registry]]);
  const deps: SetupTerminalWakeDeps = {
    eventBus: bus as unknown as SetupTerminalWakeDeps["eventBus"],
    registries: registries as unknown as SetupTerminalWakeDeps["registries"],
    getTerminalAttentionConfig: () => ({
      autoAnswer: opts.autoAnswer ?? "safe-only",
      hintPatterns: opts.hintPatterns ?? ["press enter to continue"],
      maxHops: 5,
      maxConcurrentAttentionTurns: 2,
    }),
    notify,
    dataDir,
    nowMs: () => 1_000,
    logger: logger as unknown as SetupTerminalWakeDeps["logger"],
  };
  const handle = setupTerminalWake(deps);
  return { bus, registry, logger, notify, handle };
}

/** Let the FSM's async woken turn settle (it awaits status/read/send). */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("setupTerminalWake — the keystone subscribe + woken-turn driver (124-09)", () => {
  let dataDir: string;
  let built: Built | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "comis-wake-setup-"));
  });
  afterEach(async () => {
    await built?.handle.shutdown();
    built = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("subscribes the wake-FSM: a re-published terminal:input_needed drives exactly ONE woken turn (status round-trip)", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    built.bus.fireInputNeeded("s-1", "a");
    await flush();
    // The woken turn ran: it queried the owner-scoped status (the §4.4 turn start).
    expect(built.registry.status).toHaveBeenCalledTimes(1);
  });

  it("auto-answer (SEC-12): a safe-pattern screen → send the canned keystroke + emit terminal:auto_answered", async () => {
    built = build(dataDir, { screen: "Press enter to continue", autoAnswer: "safe-only", hintPatterns: ["press enter to continue"] });
    built.bus.fireInputNeeded("s-1", "a");
    await flush();

    // The canned keystroke was sent through the registry send path (audited downstream).
    expect(built.registry.sendText).toHaveBeenCalledTimes(1);
    const answered = built.bus.emitted.find((e) => e.event === "terminal:auto_answered");
    expect(answered, "terminal:auto_answered must be emitted").toBeDefined();
    expect(answered!.payload).toMatchObject({ sessionId: "s-1", agentId: "a", matchedPatternIndex: 0 });
    // No escalation on a safe answer.
    expect(built.bus.emitted.find((e) => e.event === "terminal:escalated")).toBeUndefined();
  });

  it("escalate (SEC-12): a destructive/auth screen → NO keystroke, emit terminal:escalated + fire the NotifyFn", async () => {
    built = build(dataDir, { screen: "Permanently delete all files? (y/n)", autoAnswer: "safe-only", hintPatterns: ["(y/n)"] });
    built.bus.fireInputNeeded("s-1", "a");
    await flush();

    // Escalate-always WINS over the hintPattern: no keystroke is sent.
    expect(built.registry.sendText).not.toHaveBeenCalled();
    const escalated = built.bus.emitted.find((e) => e.event === "terminal:escalated");
    expect(escalated, "terminal:escalated must be emitted").toBeDefined();
    expect(escalated!.payload).toMatchObject({ sessionId: "s-1", agentId: "a", reason: "destructive" });
    // The escalation reaches a human via the NotifyFn chain (§4.7).
    expect(built.notify).toHaveBeenCalled();
  });

  it("no-safe-match → escalate (no_safe_match), no keystroke", async () => {
    built = build(dataDir, { screen: "Some unrecognized prompt >", autoAnswer: "safe-only", hintPatterns: ["press enter"] });
    built.bus.fireInputNeeded("s-1", "a");
    await flush();

    expect(built.registry.sendText).not.toHaveBeenCalled();
    const escalated = built.bus.emitted.find((e) => e.event === "terminal:escalated");
    expect(escalated!.payload).toMatchObject({ reason: "no_safe_match" });
  });

  it("loop-guard (SEC-11): the SAME normalized prompt answered twice → the 2nd woken turn escalates loop_detected (no 2nd-frame answer)", async () => {
    built = build(dataDir, { screen: "Press enter to continue (3s)", autoAnswer: "safe-only", hintPatterns: ["press enter to continue"] });
    // First frame: answered.
    built.bus.fireInputNeeded("s-1", "a", "settled_cursor_parked");
    await flush();
    expect(built.registry.sendText).toHaveBeenCalledTimes(1);

    // Second frame for the SAME session: the screen re-renders with only a volatile
    // counter change ("(3s)"→"(9s)") — normalized it is the SAME prompt → loop_detected.
    built.registry.sendText.mockClear();
    (built.registry as { read: ReturnType<typeof vi.fn> }).read = vi.fn(async () => ({
      screen: "Press enter to continue (9s)",
      cursor: { x: 0, y: 0 },
      cols: 80,
      rows: 24,
      alt: true,
      alive: true,
    }));
    built.bus.fireInputNeeded("s-1", "a", "settled_cursor_parked_again");
    await flush();

    // The loop-guard caught the re-render: escalate, do NOT answer again.
    expect(built.registry.sendText).not.toHaveBeenCalled();
    const loop = built.bus.emitted.find((e) => e.event === "terminal:escalated" && e.payload.reason === "loop_detected");
    expect(loop, "terminal:escalated{reason:loop_detected} must be emitted on the re-render").toBeDefined();
  });

  it("active-check: a wake for a killed/cross-owner session (registry.get → undefined) drives NO turn", async () => {
    built = build(dataDir, { screen: "Press enter to continue", alive: false });
    built.bus.fireInputNeeded("s-dead", "a");
    await flush();
    // The FSM's owner-scoped active-check dropped the wake before any turn.
    expect(built.registry.status).not.toHaveBeenCalled();
  });

  it("WR-03: a malformed terminal:input_needed (missing sessionId/agentId) is dropped at the adapter with a WARN, no turn", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    // A re-publish missing the structural fields the FSM keys on — a future emit site,
    // a test double, or a refactor. The adapter must VALIDATE before the blind cast and
    // drop it (defense-in-depth), never key FSM state on "undefined:undefined".
    built.bus.emit("terminal:input_needed", { state: "awaiting-input", reason: "x", timestamp: 1 });
    await flush();

    // No woken turn — the malformed frame never reached the §4.4 driver.
    expect(built.registry.status).not.toHaveBeenCalled();
    // The drop is audited at the adapter with a malformed-shape hint (§2.7).
    const warn = built.logger.warn.mock.calls.find(
      (c) => typeof (c[0] as { hint?: string })?.hint === "string" && (c[0] as { hint: string }).hint.includes("malformed"),
    );
    expect(warn, "a malformed wake frame must WARN with a 'malformed' hint").toBeDefined();
    expect((warn![0] as { errorKind?: string }).errorKind).toBe("validation");
  });

  it("WR-03: a well-formed terminal:input_needed still drives a turn (the guard does not reject valid frames)", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    built.bus.emit("terminal:input_needed", { sessionId: "s-ok", agentId: "a", state: "awaiting-input", reason: "settled_cursor_parked", timestamp: 1 });
    await flush();
    expect(built.registry.status).toHaveBeenCalledTimes(1);
  });

  it("shutdown() unsubscribes + drains: after shutdown a fresh input_needed wakes no turn", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    await built.handle.shutdown();
    built.registry.status.mockClear();
    built.bus.fireInputNeeded("s-1", "a");
    await flush();
    expect(built.registry.status).not.toHaveBeenCalled();
  });

  // The path the FSM persists per-session durable wake-state to.
  const wakeFile = (id: string): string => join(dataDir, WAKE_DIR_NAME, `${id}.json`);

  it("WR-02: terminal:session_evicted removes the session's durable wake-state file (no per-session disk leak)", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    // A wake persists the FSM's durable state for the session.
    built.bus.fireInputNeeded("s-leak", "a");
    await flush();
    expect(existsSync(wakeFile("s-leak")), "the FSM must persist a wake-state file on a wake").toBe(true);

    // The reaper evicts the session → its durable wake-state must be reclaimed.
    built.bus.emit("terminal:session_evicted", {
      sessionId: "s-leak",
      agentId: "a",
      reason: "idle",
      durationMs: 1,
      timestamp: 2,
    });
    await flush();
    expect(existsSync(wakeFile("s-leak")), "session_evicted must remove the wake-state file").toBe(false);
  });

  it("WR-02: terminal:session_state(exited|lost) removes the wake-state file too (PTY exit end-of-life)", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    built.bus.fireInputNeeded("s-exit", "a");
    await flush();
    expect(existsSync(wakeFile("s-exit"))).toBe(true);

    built.bus.emit("terminal:session_state", {
      sessionId: "s-exit",
      agentId: "a",
      state: "exited",
      durationMs: 0,
      timestamp: 3,
    });
    await flush();
    expect(existsSync(wakeFile("s-exit")), "a PTY exit must remove the wake-state file").toBe(false);
  });

  it("WR-02: a still-running session_state transition (created|running) does NOT remove the wake-state file", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    built.bus.fireInputNeeded("s-live", "a");
    await flush();
    expect(existsSync(wakeFile("s-live"))).toBe(true);

    // A non-terminal lifecycle transition must not reclaim a live session's state.
    built.bus.emit("terminal:session_state", {
      sessionId: "s-live",
      agentId: "a",
      state: "running",
      durationMs: 0,
      timestamp: 4,
    });
    await flush();
    expect(existsSync(wakeFile("s-live")), "a running transition must NOT remove the file").toBe(true);
  });

  it("WR-02: end-of-life cleanup is unsubscribed on shutdown (a post-shutdown eviction does not throw)", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    await built.handle.shutdown();
    // After shutdown the cleanup subscriptions are gone — a late eviction is a no-op.
    expect(() =>
      built!.bus.emit("terminal:session_evicted", { sessionId: "s-x", agentId: "a", reason: "idle", durationMs: 1, timestamp: 5 }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // DRIVE-02 (164-04): the dispatcher consumes terminal:drive_promoted into a
  // closure-local promoted-Set (mirroring the loopGuard lifecycle) + fires EXACTLY
  // ONE content-free "drive started (backgrounded)" notify per session via the
  // WokenTurnNotify chain (origin:background_task — NOT the escalate() path). The
  // skills wait tool emits per-qualifying-wait; the daemon collapses to one
  // (promote-once). A sub-threshold inline drive emits nothing → no notify (I1).
  // RED on pre-patch: no terminal:drive_promoted subscriber exists, so a promotion
  // emit drives no notify (the notify stays at 0 calls).
  // -------------------------------------------------------------------------

  /** The notify calls the dispatcher made (the WokenTurnNotify chain). */
  function notifyCalls(b: Built): Array<{ agentId: string; message: string; priority: string; origin: string }> {
    return b.notify.mock.calls.map((c) => c[0] as { agentId: string; message: string; priority: string; origin: string });
  }

  it("DRIVE-02: a terminal:drive_promoted records the session + fires exactly ONE drive-started notify (WokenTurnNotify chain, origin:background_task)", async () => {
    built = build(dataDir, { screen: "Building…" });
    built.bus.fireDrivePromoted("s-drv", "a", "producing");
    await flush();

    const calls = notifyCalls(built);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agentId: "a", priority: "normal", origin: "background_task" });
    // The drive-started message is STRUCTURAL only — the session id + "background", no screen.
    expect(calls[0]!.message).toContain("s-drv");
    expect(calls[0]!.message.toLowerCase()).toContain("background");
    // It is NOT an escalation — no terminal:escalated rides this path.
    expect(built.bus.emitted.find((e) => e.event === "terminal:escalated")).toBeUndefined();
  });

  it("promote-once: a SECOND terminal:drive_promoted for the SAME session fires NO second notify (the daemon dedupe)", async () => {
    built = build(dataDir, { screen: "Building…" });
    built.bus.fireDrivePromoted("s-drv", "a", "producing");
    built.bus.fireDrivePromoted("s-drv", "a", "producing"); // the skills tool emits per-qualifying-wait
    await flush();

    // The daemon promoted-Set collapses repeated emits for one session to ONE notify.
    expect(built.notify).toHaveBeenCalledTimes(1);
  });

  it("promote-once is PER-SESSION: a different session still gets its own ONE notify", async () => {
    built = build(dataDir, { screen: "Building…" });
    built.bus.fireDrivePromoted("s-a", "a", "producing");
    built.bus.fireDrivePromoted("s-b", "a", "mode_detached");
    built.bus.fireDrivePromoted("s-a", "a", "producing"); // dup for s-a → no extra
    await flush();

    expect(built.notify).toHaveBeenCalledTimes(2);
    const sessions = notifyCalls(built).map((c) => c.message);
    expect(sessions.some((m) => m.includes("s-a"))).toBe(true);
    expect(sessions.some((m) => m.includes("s-b"))).toBe(true);
  });

  it("I1: no terminal:drive_promoted emitted (the inline short-drive path) → NO notify", async () => {
    built = build(dataDir, { screen: "$ " });
    // A sub-threshold inline drive: the wait tool emitted nothing, so the dispatcher
    // never sees a promotion. The promoted-Set stays empty; no drive-started notify.
    built.bus.fireInputNeeded("s-inline", "a"); // a normal attention frame, NOT a promotion
    await flush();

    expect(notifyCalls(built).some((c) => c.origin === "background_task" && c.message.toLowerCase().includes("background")))
      .toBe(false);
  });

  it("a malformed terminal:drive_promoted (missing sessionId/agentId) is dropped with a WARN, no notify (T-164-12 spoofing guard)", async () => {
    built = build(dataDir, { screen: "Building…" });
    built.bus.emit("terminal:drive_promoted", { reason: "producing", timestamp: 1 });
    await flush();

    expect(built.notify).not.toHaveBeenCalled();
    const warn = built.logger.warn.mock.calls.find(
      (c) => typeof (c[0] as { hint?: string })?.hint === "string" && (c[0] as { hint: string }).hint.includes("malformed"),
    );
    expect(warn, "a malformed drive_promoted must WARN with a 'malformed' hint").toBeDefined();
    expect((warn![0] as { errorKind?: string }).errorKind).toBe("validation");
  });

  it("when deps.notify is absent the promotion is still recorded (bus-only) and does NOT throw", async () => {
    const bus = makeBus();
    const registry = makeRegistry({ screen: "Building…" });
    const logger = makeLogger();
    const registries = new Map<string, ReturnType<typeof makeRegistry>>([["a", registry]]);
    // No `notify` in the deps — the promotion path must be a no-throw bus-only record.
    const deps = {
      eventBus: bus as unknown as SetupTerminalWakeDeps["eventBus"],
      registries: registries as unknown as SetupTerminalWakeDeps["registries"],
      getTerminalAttentionConfig: () => undefined,
      dataDir,
      nowMs: () => 1_000,
      logger: logger as unknown as SetupTerminalWakeDeps["logger"],
    } as SetupTerminalWakeDeps;
    const handle = setupTerminalWake(deps);
    expect(() => bus.fireDrivePromoted("s-drv", "a")).not.toThrow();
    await flush();
    await handle.shutdown();
  });

  it("onSessionGone forgets a promoted session: after eviction a fresh promotion for a recycled id notifies again", async () => {
    built = build(dataDir, { screen: "Building…" });
    built.bus.fireDrivePromoted("s-recycle", "a", "producing");
    await flush();
    expect(built.notify).toHaveBeenCalledTimes(1);

    // The session is evicted — its promoted-state must be reclaimed (no stale dedupe).
    built.bus.emit("terminal:session_evicted", { sessionId: "s-recycle", agentId: "a", reason: "idle", durationMs: 1, timestamp: 2 });
    await flush();

    // A recycled sessionId promoting again is a NEW promotion → a fresh notify.
    built.bus.fireDrivePromoted("s-recycle", "a", "producing");
    await flush();
    expect(built.notify).toHaveBeenCalledTimes(2);
  });

  it("onSessionGone forgets a promoted session on a PTY exit (session_state exited|lost) too", async () => {
    built = build(dataDir, { screen: "Building…" });
    built.bus.fireDrivePromoted("s-exit", "a", "producing");
    await flush();
    expect(built.notify).toHaveBeenCalledTimes(1);

    built.bus.emit("terminal:session_state", { sessionId: "s-exit", agentId: "a", state: "exited", durationMs: 0, timestamp: 3 });
    await flush();
    built.bus.fireDrivePromoted("s-exit", "a", "producing");
    await flush();
    expect(built.notify).toHaveBeenCalledTimes(2);
  });

  it("shutdown() unsubscribes terminal:drive_promoted (a post-shutdown promotion drives no notify)", async () => {
    built = build(dataDir, { screen: "Building…" });
    await built.handle.shutdown();
    built.notify.mockClear();
    built.bus.fireDrivePromoted("s-late", "a", "producing");
    await flush();
    expect(built.notify).not.toHaveBeenCalled();
  });

  it("the subscribe + shutdown unsubscribe are wired in setup-terminal-wake.ts (source guard)", () => {
    const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
    expect(src, "must subscribe terminal:drive_promoted").toMatch(/\.on\(\s*"terminal:drive_promoted"/);
    expect(src, "must unsubscribe terminal:drive_promoted on shutdown").toMatch(/\.off\(\s*"terminal:drive_promoted"/);
    expect(src, "must hold a closure-local promoted-Set").toMatch(/promotedSessions/);
  });

  it("MR-01: the daemon stamps + reclaims a per-session drive-start and passes driveStartMs to the driver (source guard)", () => {
    const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
    // A closure-local per-session drive-start map (mirrors driveJournals) so the journal's
    // elapsedMs measures from the promotion instant, not a per-turn delta.
    expect(src, "must hold a closure-local drive-start map").toMatch(/driveStartedAtMs/);
    // Stamped at promotion (the "drive started" moment) — set in the promotion consumer.
    expect(src, "must stamp the drive-start on promotion").toMatch(/driveStartedAtMs\.set\(/);
    // Reclaimed on end-of-life (no per-session leak — MR-02 surface) — deleted in onSessionGone.
    expect(src, "must reclaim the drive-start on session end-of-life").toMatch(/driveStartedAtMs\.delete\(/);
    // The accessor is threaded into the woken-turn driver as driveStartMs.
    expect(src, "must pass driveStartMs to the woken-turn driver").toMatch(/driveStartMs/);
  });

  // -------------------------------------------------------------------------
  // DRIVE-01 (164-06 Task 1): the drive-scope routing. A PROMOTED session's
  // woken turn is attributed to a dedicated `drive:<sessionId>` sessionKey (the
  // FSM/journal/conversation scope), while the active-check resolves the SAME
  // session via its STAMPED registry owner (`sessionKey:""`, via registryOwnerFor)
  // so a promoted session's wakes are NOT dropped. An unpromoted session stays on
  // `sessionKey:""` (today's path, I1).
  // RED on pre-patch: makeWakeAdapterBus hard-codes `sessionKey:""` (no drive scope)
  // AND isSessionActive passes the raw owner — so the routing + the strip don't exist.
  // -------------------------------------------------------------------------

  /**
   * A registry whose session is ONLY resolvable under its STAMPED owner (`sessionKey:""`).
   * `get`/`status`/`read` consult the owner: a call carrying a drive-scoped (or any
   * non-"") sessionKey returns the not-found view (the production owner-gate, `sameOwner`).
   * This is how a test proves the active-check + the woken-turn read strip the drive scope
   * back to the stamped owner (I5) — without the strip, a promoted session reads not-found.
   */
  function makeStampedOnlyRegistry(opts: { screen: string }) {
    const liveStatus = {
      state: "awaiting-input" as const,
      lastActivity: 0,
      interactions: 1,
      cursorParked: true,
      screenDiffEmpty: true,
    };
    const liveView = { screen: opts.screen, cursor: { x: 0, y: 0 }, cols: 80, rows: 24, alt: false, alive: true };
    const notFoundView = { screen: "", cursor: { x: 0, y: 0 }, cols: 0, rows: 0, alt: false, alive: false };
    const stamped = (owner: { sessionKey?: string }): boolean => owner?.sessionKey === "";
    return {
      sendText: vi.fn(async () => ({ screen: opts.screen, cursor: { x: 0, y: 0 }, delivered: true })),
      // Owner-gated: alive ONLY under the stamped owner; a drive-scoped get is not-found.
      get: vi.fn((_id: string, owner: { sessionKey?: string }) =>
        stamped(owner) ? ({ sessionId: "s", owner: { agentId: "a", sessionKey: "" } } as never) : undefined,
      ),
      status: vi.fn(async (_id: string, owner: { sessionKey?: string }) => (stamped(owner) ? liveStatus : { ...liveStatus, state: "exited" as const })),
      read: vi.fn(async (_id: string, owner: { sessionKey?: string }) => (stamped(owner) ? liveView : notFoundView)),
    };
  }

  function buildStampedOnly(dataDir: string, opts: { screen: string; hintPatterns?: string[] }): Built {
    const bus = makeBus();
    const registry = makeStampedOnlyRegistry({ screen: opts.screen });
    const logger = makeLogger();
    const notify = vi.fn(async () => undefined);
    const registries = new Map<string, ReturnType<typeof makeStampedOnlyRegistry>>([["a", registry]]);
    const deps: SetupTerminalWakeDeps = {
      eventBus: bus as unknown as SetupTerminalWakeDeps["eventBus"],
      registries: registries as unknown as SetupTerminalWakeDeps["registries"],
      getTerminalAttentionConfig: () => ({
        autoAnswer: "safe-only",
        hintPatterns: opts.hintPatterns ?? ["press enter to continue"],
        maxHops: 5,
        maxConcurrentAttentionTurns: 2,
      }),
      notify,
      dataDir,
      nowMs: () => 1_000,
      logger: logger as unknown as SetupTerminalWakeDeps["logger"],
    };
    const handle = setupTerminalWake(deps);
    return { bus, registry: registry as unknown as Built["registry"], logger, notify, handle };
  }

  it("DRIVE-01: a promoted session's woken turn is attributed to drive:<id>, an unpromoted one to '' (I1)", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });

    // (a) UNPROMOTED — the woken turn's owner sessionKey is "" (today's path, I1).
    built.bus.fireInputNeeded("s-plain", "a");
    await flush();
    const plainOwner = built.registry.status.mock.calls.at(-1)?.[1] as { sessionKey: string } | undefined;
    expect(plainOwner?.sessionKey, "an unpromoted woken turn resolves the stamped owner ''").toBe("");

    // (b) PROMOTED — promote the session, then a wake routes the drive scope. The driver
    //     STRIPS it for the registry call (Task 2), so status still resolves the stamped
    //     owner; the drive:<id> attribution is asserted via the routing source + the
    //     dedicated drive-scope helper test. Here we assert the promoted session is NOT
    //     dropped (the active-check still sees it alive) — the load-bearing routing effect.
    built.registry.status.mockClear();
    built.bus.fireDrivePromoted("s-drv", "a", "producing");
    await flush();
    built.bus.fireInputNeeded("s-drv", "a");
    await flush();
    expect(built.registry.status, "a promoted session's wake still drives a turn (not dropped)").toHaveBeenCalled();
  });

  it("active-check: a promoted session's wake is NOT dropped — isSessionActive resolves via registryOwnerFor(owner)", async () => {
    // The registry resolves the session ONLY under the stamped owner (sessionKey:"").
    // After promotion the wake owner carries drive:<id>; the active-check MUST strip it
    // (registryOwnerFor) or registry.get returns undefined and the wake is silently dropped
    // (the I9-class strand). Pin: a promoted session's wake DRIVES a turn.
    built = buildStampedOnly(dataDir, { screen: "Press enter to continue" });
    built.bus.fireDrivePromoted("s-drv", "a", "producing");
    await flush();
    built.bus.fireInputNeeded("s-drv", "a");
    await flush();

    // The active-check resolved the promoted session (via the stripped stamped owner) →
    // the turn ran (status round-tripped). If the active-check passed the raw drive owner,
    // get → undefined → the wake is dropped and status is never called.
    expect(built.registry.status, "the promoted session's wake must NOT be dropped by the active-check").toHaveBeenCalled();
    // And the get the active-check made used the STAMPED owner (the strip), not drive:<id>.
    const getOwners = (built.registry.get as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { sessionKey: string }).sessionKey);
    expect(getOwners, "the active-check resolves via the stamped owner ''").toContain("");
    expect(getOwners.some((k) => k.startsWith("drive:")), "the active-check must NOT pass a raw drive: owner to registry.get").toBe(false);
  });

  it("DRIVE-01 routing site: makeWakeAdapterBus derives the drive sessionKey from promotedSessions (source guard)", () => {
    const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
    // The line-228 `sessionKey:""` literal is replaced by the derived drive-scope key.
    expect(src, "the woken-turn owner sessionKey must be derived via driveScopeKey(ev.sessionId)").toMatch(/sessionKey:\s*driveScopeKey\(ev\.sessionId\)/);
    // The active-check resolves via the stamped registry owner (registryOwnerFor).
    expect(src, "isSessionActive must resolve via registryOwnerFor(owner)").toMatch(/registryOwnerFor/);
  });

  // -------------------------------------------------------------------------
  // DUR-02 (165-07 Task 1): the wake-holder PERSISTS each journal update via the
  // 165-04 store + RESUMES from it on a re-attach. A resumed drive does NOT re-answer
  // an already-answered prompt (the answeredPrompts dedup survives the restart, I10).
  // The DURABLE file is preserved on a lost/crash; removed ONLY on a clean exit.
  // RED on pre-patch: the journal.set wrapper does not persist + the holder does not
  // seed from recover, so the store sees 0 persists + a re-attach resumes nothing.
  // -------------------------------------------------------------------------

  /** A capturing fake of the daemon-bound DUR-02 journal store (the 165-04 module wrapper). */
  function makeJournalStore(seed?: Map<string, DriveJournalShape>) {
    const disk = new Map<string, DriveJournalShape>(seed ?? []);
    const persistCalls: Array<{ agentId: string; sessionId: string; journal: DriveJournalShape }> = [];
    const removeCalls: Array<{ agentId: string; sessionId: string }> = [];
    return {
      persistCalls,
      removeCalls,
      disk,
      store: {
        persist: vi.fn((agentId: string, sessionId: string, journal: DriveJournalShape) => {
          disk.set(`${agentId}/${sessionId}`, journal);
          persistCalls.push({ agentId, sessionId, journal });
        }),
        recover: vi.fn((agentId: string) => {
          const out = new Map<string, DriveJournalShape>();
          for (const [k, v] of disk) {
            const [a, s] = k.split("/");
            if (a === agentId) out.set(s!, v);
          }
          return out;
        }),
        load: vi.fn((agentId: string, sessionId: string) => disk.get(`${agentId}/${sessionId}`)),
        remove: vi.fn((agentId: string, sessionId: string) => {
          disk.delete(`${agentId}/${sessionId}`);
          removeCalls.push({ agentId, sessionId });
        }),
      },
    };
  }

  /** Build with a DUR-02 journal store injected (+ the safe-pattern config so a wake answers). */
  function buildDur(
    dataDir: string,
    opts: { screen: string; seed?: Map<string, DriveJournalShape>; hintPatterns?: string[] },
  ): Built & { js: ReturnType<typeof makeJournalStore> } {
    const bus = makeBus();
    const registry = makeRegistry({ screen: opts.screen });
    const logger = makeLogger();
    const notify = vi.fn(async () => undefined);
    const js = makeJournalStore(opts.seed);
    const registries = new Map<string, ReturnType<typeof makeRegistry>>([["a", registry]]);
    const deps = {
      eventBus: bus as unknown as SetupTerminalWakeDeps["eventBus"],
      registries: registries as unknown as SetupTerminalWakeDeps["registries"],
      getTerminalAttentionConfig: () => ({
        autoAnswer: "safe-only" as const,
        hintPatterns: opts.hintPatterns ?? ["press enter to continue"],
        maxHops: 5,
        maxConcurrentAttentionTurns: 2,
      }),
      notify,
      dataDir,
      nowMs: () => 1_000,
      logger: logger as unknown as SetupTerminalWakeDeps["logger"],
      driveJournalStore: js.store,
    } as unknown as SetupTerminalWakeDeps;
    const handle = setupTerminalWake(deps);
    return { bus, registry, logger, notify, handle, js };
  }

  it("DUR-02: a PROMOTED drive's journal is persisted on every update (the journal.set wrapper calls store.persist)", async () => {
    built = buildDur(dataDir, { screen: "Press enter to continue" });
    const { js } = built as Built & { js: ReturnType<typeof makeJournalStore> };
    // Promote so the woken turn engages the journal (DRIVE-01 gating), then a wake updates it.
    built.bus.fireDrivePromoted("s-dur", "a", "producing");
    await flush();
    built.bus.fireInputNeeded("s-dur", "a");
    await flush();

    // The journal.set wrapper persisted the updated journal for the promoted session.
    expect(js.store.persist, "every journal.set must persist (DUR-02 single persistence point)").toHaveBeenCalled();
    const persisted = js.persistCalls.find((c) => c.sessionId === "s-dur");
    expect(persisted, "the promoted session's journal must be persisted").toBeDefined();
    expect(persisted!.agentId).toBe("a");
    // The persisted journal reflects the woken turn (interactions bumped past the empty 0).
    expect(persisted!.journal.interactions).toBeGreaterThanOrEqual(1);
  });

  it("I1: an UNPROMOTED drive persists NOTHING (the persist is gated on promoted + a present store)", async () => {
    built = buildDur(dataDir, { screen: "Press enter to continue" });
    const { js } = built as Built & { js: ReturnType<typeof makeJournalStore> };
    // No promotion → the woken turn never touches the journal → nothing is persisted (I1).
    built.bus.fireInputNeeded("s-plain", "a");
    await flush();
    expect(js.store.persist, "an unpromoted drive must persist nothing").not.toHaveBeenCalled();
  });

  it("DUR-02 resume: a terminal:drive_reattached seeds the journal cache from store.load (the registry signals the re-attach)", async () => {
    // A persisted journal from a prior daemon life (the restart).
    const seeded = new Map<string, DriveJournalShape>([
      ["a/s-resume", { objective: "build the app", lastClassification: "awaiting-input", lastScreenDigest: "", answeredPrompts: ["pattern:2"], stepsTried: ["ran:build"], elapsedMs: 1_000, interactions: 3, costUsd: 0, truncations: 0 }],
    ]);
    built = buildDur(dataDir, { screen: "Press enter to continue", seed: seeded });
    const { js } = built as Built & { js: ReturnType<typeof makeJournalStore> };
    // The registry's recover-on-boot re-attached the surviving tmux session → it emits the
    // content-free terminal:drive_reattached, which the holder consumes to seed the resume.
    built.bus.emit("terminal:drive_reattached", { sessionId: "s-resume", agentId: "a", reason: "tmux_alive", timestamp: 1 });
    await flush();
    expect(js.store.load, "the holder must load the persisted journal on a re-attach (resume)").toHaveBeenCalledWith("a", "s-resume");
  });

  it("DUR-02/I10 resume-no-re-answer: a resumed drive whose journal has answeredPrompts continues from it (the seeded answeredPrompts survives into the live journal)", async () => {
    const seeded = new Map<string, DriveJournalShape>([
      ["a/s-resume", { objective: "build the app", lastClassification: "awaiting-input", lastScreenDigest: "", answeredPrompts: ["pattern:0"], stepsTried: [], elapsedMs: 1_000, interactions: 2, costUsd: 0, truncations: 0 }],
    ]);
    built = buildDur(dataDir, { screen: "Press enter to continue", seed: seeded });
    const { js } = built as Built & { js: ReturnType<typeof makeJournalStore> };
    // The registry re-attached the surviving session → seed the resumed journal into the
    // live cache (the resume), AND re-promote on this boot (promote-once is per-life).
    built.bus.emit("terminal:drive_reattached", { sessionId: "s-resume", agentId: "a", reason: "tmux_alive", timestamp: 1 });
    built.bus.fireDrivePromoted("s-resume", "a", "producing");
    await flush();
    built.bus.fireInputNeeded("s-resume", "a");
    await flush();

    // The journal persisted after the wake still carries the prior life's answered tag —
    // the resume seeded the live cache from the recovered journal (not a fresh empty one).
    const persisted = js.persistCalls.find((c) => c.sessionId === "s-resume");
    expect(persisted, "the resumed session must persist its updated journal").toBeDefined();
    expect(persisted!.journal.answeredPrompts, "the resumed journal must carry the prior life's answeredPrompts (I10)").toContain("pattern:0");
    expect(persisted!.journal.interactions, "the resumed journal continues from the recovered interactions (not reset to 1)").toBeGreaterThan(2);
  });

  it("I10 preserve-on-crash: a lost/exited session reclaims the in-memory cache but does NOT remove the durable file", async () => {
    built = buildDur(dataDir, { screen: "Press enter to continue" });
    const { js } = built as Built & { js: ReturnType<typeof makeJournalStore> };
    built.bus.fireDrivePromoted("s-crash", "a", "producing");
    await flush();
    built.bus.fireInputNeeded("s-crash", "a");
    await flush();
    expect(js.store.persist).toHaveBeenCalled();

    // A crash/lost transition: the durable file MUST be preserved (a fresh drive resumes it).
    built.bus.emit("terminal:session_state", { sessionId: "s-crash", agentId: "a", state: "lost", durationMs: 0, timestamp: 9 });
    await flush();
    expect(js.store.remove, "a lost/crash must NOT remove the durable journal (I10 preserve-on-failure)").not.toHaveBeenCalled();
  });

  it("BL-02 (the boot-race gap): a wake LAZY-SEEDS a recovered durable journal even when terminal:drive_reattached was DROPPED at boot — the resumed drive does NOT re-answer an already-answered prompt", async () => {
    // The boot race: the registry's recover-on-boot emits terminal:drive_reattached during the
    // FLOOR-01 sweep BEFORE setupTerminalWake subscribes, so the event is lost. The robust fix
    // is order-independent: the holder lazy-seeds the journal from store.load on the FIRST
    // woken turn of a recovered session (when its in-memory journal is empty). Here we seed the
    // on-disk journal as already-answered "pattern:0" and fire a wake WITHOUT ever firing
    // drive_reattached/drive_promoted (simulating the dropped boot event) — the woken turn must
    // resume from disk + SKIP re-answering pattern:0 (resume, don't re-answer — I10/DUR-02).
    const seeded = new Map<string, DriveJournalShape>([
      ["a/s-boot", { objective: "build the app", lastClassification: "awaiting-input", lastScreenDigest: "", answeredPrompts: ["pattern:0"], stepsTried: ["ran:build"], elapsedMs: 5_000, interactions: 4, costUsd: 0, truncations: 0 }],
    ]);
    built = buildDur(dataDir, { screen: "Press enter to continue", seed: seeded });
    const { js } = built as Built & { js: ReturnType<typeof makeJournalStore> };
    // NO drive_reattached, NO drive_promoted — only the wake (the boot event was dropped).
    built.bus.fireInputNeeded("s-boot", "a");
    await flush();

    // The holder lazy-loaded the persisted journal (the resume read happened on the first wake).
    expect(js.store.load, "the first wake must lazy-load the recovered journal (BL-02)").toHaveBeenCalledWith("a", "s-boot");
    // RESUME-no-re-answer (I10): pattern:0 was already answered before the crash, so the woken
    // turn must NOT re-send the canned keystroke for it (the loop-guard ring is cold post-restart,
    // so without the lazy-seed the resume guard has nothing to consult and re-answers).
    expect(built.registry.sendText, "a resumed drive must NOT re-answer an already-answered prompt (BL-02/I10)").not.toHaveBeenCalled();
    const reAnswered = built.bus.emitted.find((e) => e.event === "terminal:auto_answered");
    expect(reAnswered, "no auto_answered for an already-answered prompt on resume").toBeUndefined();
  });

  it("BL-02: a wake for a recovered durable session with NO persisted journal is a no-op load (no throw; a plain session is unaffected)", async () => {
    built = buildDur(dataDir, { screen: "Press enter to continue" }); // empty store
    const { js } = built as Built & { js: ReturnType<typeof makeJournalStore> };
    built.bus.fireInputNeeded("s-none", "a");
    await flush();
    // The lazy-seed attempted a load once (bounded), found nothing → the turn proceeds normally.
    expect(js.store.load).toHaveBeenCalledWith("a", "s-none");
    // A second wake does NOT re-load (bounded to one attempt per session per life).
    js.store.load.mockClear();
    built.bus.fireInputNeeded("s-none", "a");
    await flush();
    expect(js.store.load, "the lazy-seed load is attempted at most once per session per life").not.toHaveBeenCalled();
  });

  it("DUR-02 wiring (source guard): the journal.set wrapper persists + the holder seeds on a re-attach", () => {
    const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
    // The single DUR-02 persistence point: the journal.set wrapper calls the store's persist.
    expect(src, "the journal.set wrapper must persist via driveJournalStore").toMatch(/driveJournalStore\??\.persist\(/);
    // The holder seeds the resumed journal from the store on the re-attach signal.
    expect(src, "the holder must seed from driveJournalStore.load on a re-attach").toMatch(/driveJournalStore\??\.load\(/);
    // The re-attach signal is the registry's content-free terminal:drive_reattached.
    expect(src, "the holder must consume terminal:drive_reattached for resume").toMatch(/terminal:drive_reattached/);
  });

  // -------------------------------------------------------------------------
  // LIVE-01 (165-07 Task 2): the coarse liveness BACKSTOP timer. It rides UNDER the
  // event-driven wake purely as a safety net: a deps.timers.setInterval(...).unref()
  // that, per tick, for each PROMOTED session, fires ONE liveness check ONLY in the
  // ABSENCE of a wake within the heartbeat window (I2 — no per-tick screen read), then
  //   - busyOrHung → "busy"  ⇒ refreshLastActivity (the ENDURE-01 reaper unify, I9) + continue
  //   - busyOrHung → "hung"  ⇒ synth state:"stuck" via the EXISTING terminal:input_needed seam
  // A normally-progressing drive (a transition inside heartbeatMs every tick) NEVER triggers it.
  // RED on pre-patch: no backstop exists — deps.timers is never armed, so a silent+hung
  // drive synthesizes NO stuck (the silent-worker hole stays open) and a silent+busy drive
  // never refreshes lastActivity.
  // -------------------------------------------------------------------------

  /** A fake TimerPort that CAPTURES the interval callback so a test can tick it manually. */
  function makeFakeTimers() {
    const intervals: Array<{ cb: () => void; intervalMs: number; handle: { cancelled: boolean; cancel(): void; unref(): void; unrefCalls: number; cancelCalls: number } }> = [];
    const timers = {
      setInterval(cb: () => void, intervalMs: number) {
        const handle = {
          cancelled: false,
          unrefCalls: 0,
          cancelCalls: 0,
          cancel() {
            this.cancelled = true;
            this.cancelCalls += 1;
          },
          unref() {
            this.unrefCalls += 1;
          },
        };
        intervals.push({ cb, intervalMs, handle });
        return handle;
      },
      setTimeout: (cb: () => void, _ms: number) => ({ cancelled: false, cancel() {}, unref() {} }),
    };
    return {
      timers,
      intervals,
      /** Fire every armed interval's callback once (the heartbeat tick). */
      tick() {
        for (const i of intervals) i.cb();
      },
    };
  }

  /**
   * Build with the LIVE-01 backstop wired: a fake TimerPort, a controllable clock, an
   * injected checkLiveness probe (has-session + noProgressMs + stuckMs — NO screen), and a
   * refreshLastActivity spy. `liveness` maps a sessionId → its BusySignal-shaped probe.
   */
  function buildBackstop(
    dataDir: string,
    opts: {
      screen: string;
      heartbeatMs?: number;
      liveness: Record<string, { alive: boolean; noProgressMs: number; stuckMs: number } | undefined>;
      /** ME-02 (165-REVIEW): an optional seeded journal store so a recovered drive can be lazy-seeded/promoted. */
      seed?: Map<string, DriveJournalShape>;
    },
  ): Built & {
    fake: ReturnType<typeof makeFakeTimers>;
    clock: { now: number };
    refreshCalls: string[];
    checkLiveness: ReturnType<typeof vi.fn>;
    js: ReturnType<typeof makeJournalStore>;
  } {
    const bus = makeBus();
    const registry = makeRegistry({ screen: opts.screen });
    const logger = makeLogger();
    const notify = vi.fn(async () => undefined);
    const fake = makeFakeTimers();
    const clock = { now: 100_000 };
    const refreshCalls: string[] = [];
    const checkLiveness = vi.fn((sessionId: string) => opts.liveness[sessionId]);
    const js = makeJournalStore(opts.seed);
    const registries = new Map<string, ReturnType<typeof makeRegistry>>([["a", registry]]);
    const deps = {
      eventBus: bus as unknown as SetupTerminalWakeDeps["eventBus"],
      registries: registries as unknown as SetupTerminalWakeDeps["registries"],
      getTerminalAttentionConfig: () => ({ autoAnswer: "safe-only" as const, hintPatterns: ["press enter to continue"], maxHops: 5, maxConcurrentAttentionTurns: 2 }),
      notify,
      dataDir,
      nowMs: () => clock.now,
      logger: logger as unknown as SetupTerminalWakeDeps["logger"],
      timers: fake.timers,
      heartbeatMs: opts.heartbeatMs ?? 90_000,
      checkLiveness,
      refreshLastActivity: (sessionId: string) => refreshCalls.push(sessionId),
      driveJournalStore: js.store,
    } as unknown as SetupTerminalWakeDeps;
    const handle = setupTerminalWake(deps);
    return { bus, registry, logger, notify, handle, fake, clock, refreshCalls, checkLiveness, js };
  }

  /** The synth-stuck wakes the backstop emits through the existing terminal:input_needed seam. */
  function synthStuckEmits(b: Built): Array<Record<string, unknown>> {
    return b.bus.emitted.filter((e) => e.event === "terminal:input_needed" && e.payload.state === "stuck").map((e) => e.payload);
  }

  it("LIVE-01: the backstop arms a deps.timers.setInterval at heartbeatMs and .unref()'s the handle (mirrors the reaper)", () => {
    built = buildBackstop(dataDir, { screen: "Building…", heartbeatMs: 45_000, liveness: {} });
    const { fake } = built as ReturnType<typeof buildBackstop>;
    expect(fake.intervals, "the backstop must arm exactly one interval").toHaveLength(1);
    expect(fake.intervals[0]!.intervalMs, "the interval cadence is heartbeatMs").toBe(45_000);
    expect(fake.intervals[0]!.handle.unrefCalls, "the backstop handle must be .unref()'d (never holds the loop open on SIGTERM)").toBeGreaterThanOrEqual(1);
  });

  it("LIVE-01 / I2: a normally-progressing drive (a transition INSIDE heartbeatMs) triggers 0 synth-stuck + reads NO screen (Pitfall 7)", async () => {
    const b = buildBackstop(dataDir, { screen: "Building…", heartbeatMs: 90_000, liveness: { "s-live": { alive: true, noProgressMs: 999_999, stuckMs: 600_000 } } });
    built = b;
    // Promote, then a wake lands (the transition stamps lastTransitionMs = now).
    b.bus.fireDrivePromoted("s-live", "a", "producing");
    await flush();
    b.registry.read.mockClear();
    b.checkLiveness.mockClear();
    // The tick fires WITHIN the heartbeat window of the last wake → the backstop SKIPS it.
    b.clock.now += 10_000; // < heartbeatMs since the wake
    b.fake.tick();
    await flush();

    // I2: a wake intervened → no liveness check, no synth-stuck, NO screen read this tick.
    expect(synthStuckEmits(b), "a normally-progressing drive must NOT be declared stuck").toHaveLength(0);
    expect(b.checkLiveness, "a wake intervened → the backstop must skip the liveness check").not.toHaveBeenCalled();
    expect(b.registry.read, "the backstop must NEVER read the screen per tick (I2)").not.toHaveBeenCalled();
  });

  it("LIVE-01: a SILENT + HUNG drive (no transition past heartbeatMs, busyOrHung→hung) synthesizes EXACTLY ONE stuck through the existing terminal:input_needed seam (no 600s wait)", async () => {
    const b = buildBackstop(dataDir, { screen: "$ ", heartbeatMs: 90_000, liveness: { "s-hung": { alive: true, noProgressMs: 999_999, stuckMs: 600_000 } } });
    built = b;
    b.bus.fireDrivePromoted("s-hung", "a", "producing");
    await flush();
    b.registry.read.mockClear();
    // The clock advances PAST the heartbeat window with no intervening wake → the backstop fires.
    b.clock.now += 120_000; // > heartbeatMs since the promotion
    b.fake.tick();
    await flush();

    const stuck = synthStuckEmits(b);
    expect(stuck, "a silent+hung drive must synthesize exactly ONE stuck").toHaveLength(1);
    expect(stuck[0]).toMatchObject({ sessionId: "s-hung", agentId: "a", state: "stuck" });
    // The synth went through the EXISTING terminal:input_needed/stuck seam (NOT a new event):
    // the backstop's OWN liveness check is the injected has-session + noProgressMs probe (I2 —
    // it reads NO screen). The downstream woken turn the synthesized stuck triggers DOES read
    // the screen — that is the whole point of escalating a stuck — but that is the FSM's read,
    // not the backstop tick's; the I2 "no per-tick screen read" invariant is about the BACKSTOP.
    expect(b.checkLiveness, "the backstop performed the injected liveness check (has-session + noProgressMs)").toHaveBeenCalledWith("s-hung", "a");
    // A WARN with the §2.7 hint+errorKind+step surfaces the synthesized stuck.
    const warn = b.logger.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "liveness_backstop");
    expect(warn, "a synthesized stuck must WARN with step:liveness_backstop").toBeDefined();
    expect((warn![0] as { errorKind?: string }).errorKind).toBe("timeout");
    expect(typeof (warn![0] as { hint?: string }).hint).toBe("string");
  });

  it("LIVE-01 / ENDURE-01 unify (I9): a SILENT + BUSY drive (a quiet compile) synthesizes 0 stuck + REFRESHES lastActivity", async () => {
    const b = buildBackstop(dataDir, { screen: "Compiling…", heartbeatMs: 90_000, liveness: { "s-busy": { alive: true, noProgressMs: 1_000, stuckMs: 600_000 } } });
    built = b;
    b.bus.fireDrivePromoted("s-busy", "a", "producing");
    await flush();
    // Past the heartbeat window with no wake → the backstop fires its one check.
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();

    // busyOrHung → "busy": NOT stuck, and the busy verdict REFRESHES lastActivity so the
    // ENDURE-01 idle reaper never evicts a quiet-but-busy compile (the documented pitfall).
    expect(synthStuckEmits(b), "a busy compile must NOT be declared stuck").toHaveLength(0);
    expect(b.refreshCalls, "a busy verdict must refresh lastActivity (the ENDURE-01 unify, I9)").toContain("s-busy");
  });

  it("LIVE-01: a DEAD backend (alive:false) is hung → synth stuck (busyOrHung biases dead→hung regardless of timing)", async () => {
    const b = buildBackstop(dataDir, { screen: "$ ", heartbeatMs: 90_000, liveness: { "s-dead": { alive: false, noProgressMs: 0, stuckMs: 600_000 } } });
    built = b;
    b.bus.fireDrivePromoted("s-dead", "a", "producing");
    await flush();
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();
    expect(synthStuckEmits(b), "a dead backend is hung → synth stuck").toHaveLength(1);
  });

  it("LIVE-01 / I1: an UNPROMOTED session is NOT checked by the backstop (the backstop only guards promoted drives)", async () => {
    const b = buildBackstop(dataDir, { screen: "$ ", heartbeatMs: 90_000, liveness: { "s-plain": { alive: false, noProgressMs: 999_999, stuckMs: 600_000 } } });
    built = b;
    // No promotion — a plain terminal_session. The backstop must not check or synth-stuck it.
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();
    expect(b.checkLiveness, "an unpromoted session must NOT be liveness-checked (I1)").not.toHaveBeenCalled();
    expect(synthStuckEmits(b), "an unpromoted session must NOT be synth-stuck (I1)").toHaveLength(0);
  });

  it("LIVE-01: the synth-stuck fires AT MOST ONCE per silent stretch — a second tick still inside the same no-wake stretch does NOT re-synth", async () => {
    const b = buildBackstop(dataDir, { screen: "$ ", heartbeatMs: 90_000, liveness: { "s-hung": { alive: true, noProgressMs: 999_999, stuckMs: 600_000 } } });
    built = b;
    b.bus.fireDrivePromoted("s-hung", "a", "producing");
    await flush();
    b.clock.now += 120_000;
    b.fake.tick(); // fires ONE synth-stuck
    await flush();
    b.clock.now += 30_000; // a second tick still in the same silent stretch (no new wake)
    b.fake.tick();
    await flush();
    // The backstop is a one-check-per-silent-stretch backstop, not a per-tick re-synth — the
    // synthesized stuck itself counts as the "transition" so it does not re-fire every tick.
    expect(synthStuckEmits(b), "the backstop synthesizes stuck at most once per silent stretch").toHaveLength(1);
  });

  it("LIVE-01: the backstop interval handle is cancelled on shutdown (no leaked timer)", async () => {
    const b = buildBackstop(dataDir, { screen: "$ ", liveness: {} });
    built = b;
    await b.handle.shutdown();
    built = undefined; // already shut down
    expect(b.fake.intervals[0]!.handle.cancelCalls, "shutdown must cancel the backstop interval").toBeGreaterThanOrEqual(1);
  });

  it("LIVE-01 wiring (source guard): the backstop arms timers.setInterval(...).unref() + consumes busyOrHung + never reads the screen per tick", () => {
    const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
    expect(src, "the backstop must arm an interval off the injected TimerPort").toMatch(/timers\??\.setInterval\(/);
    expect(src, "the backstop handle must be .unref()'d").toMatch(/\.unref\(\)/);
    expect(src, "the backstop must consume the busy-vs-hung predicate").toMatch(/busyOrHung/);
    expect(src, "the backstop must gate on the per-session last-transition (I2)").toMatch(/lastTransition/);
    expect(src, "the backstop must read heartbeatMs").toMatch(/heartbeatMs/);
  });

  // -------------------------------------------------------------------------
  // ME-02 (165-REVIEW): the LIVE-01 backstop + spend ceiling only guard
  // promotedSessions, which is EMPTY for a boot-recovered durable drive. A
  // re-attached drive that later hangs was invisible to the backstop. The fix:
  // the recover/resume path (onDriveReattached AND the BL-02 lazy-seed) PROMOTES
  // the recovered session so the backstop + spend ceiling cover its remaining life.
  // RED on pre-patch: a recovered drive (never live-promoted) is not in
  // promotedSessions, so the backstop skips it and synthesizes NO stuck on a hang.
  // -------------------------------------------------------------------------
  it("ME-02: a drive recovered via terminal:drive_reattached IS promoted → a later hang is backstopped (synth stuck)", async () => {
    const seeded = new Map<string, DriveJournalShape>([
      ["a/s-recov", { objective: "build", lastClassification: "working", lastScreenDigest: "", answeredPrompts: [], stepsTried: [], elapsedMs: 10_000, interactions: 1, costUsd: 0, truncations: 0 }],
    ]);
    const b = buildBackstop(dataDir, { screen: "$ ", heartbeatMs: 90_000, seed: seeded, liveness: { "s-recov": { alive: true, noProgressMs: 999_999, stuckMs: 600_000 } } });
    built = b;
    // The registry re-attached the surviving session on boot → the resume event (delivered
    // here AFTER subscription) promotes it (ME-02) — no live drive_promoted ever fired.
    b.bus.emit("terminal:drive_reattached", { sessionId: "s-recov", agentId: "a", reason: "tmux_alive", timestamp: 1 });
    await flush();
    // The drive then hangs (no wake past the heartbeat window) → the backstop must guard it.
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();

    expect(b.checkLiveness, "a recovered drive must be liveness-checked by the backstop (ME-02)").toHaveBeenCalledWith("s-recov", "a");
    expect(synthStuckEmits(b), "a recovered drive that hangs must synthesize a stuck (ME-02)").toHaveLength(1);
    expect(synthStuckEmits(b)[0]).toMatchObject({ sessionId: "s-recov", agentId: "a", state: "stuck" });
  });

  it("ME-02: a drive recovered via the BL-02 lazy-seed (first wake; the boot event was dropped) IS promoted → a later hang is backstopped", async () => {
    const seeded = new Map<string, DriveJournalShape>([
      ["a/s-lazy", { objective: "build", lastClassification: "working", lastScreenDigest: "", answeredPrompts: [], stepsTried: [], elapsedMs: 10_000, interactions: 1, costUsd: 0, truncations: 0 }],
    ]);
    const b = buildBackstop(dataDir, { screen: "$ ", heartbeatMs: 90_000, seed: seeded, liveness: { "s-lazy": { alive: true, noProgressMs: 999_999, stuckMs: 600_000 } } });
    built = b;
    // NO drive_reattached (dropped at boot). The first wake lazy-seeds + promotes the recovered
    // drive (BL-02) — which ALSO makes it backstop-guarded (ME-02 via the lazy-seed path).
    b.bus.fireInputNeeded("s-lazy", "a");
    await flush();
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();

    expect(synthStuckEmits(b), "a lazily-recovered drive that hangs must synthesize a stuck (ME-02)").toHaveLength(1);
  });
});
