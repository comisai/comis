// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon SUBSCRIBE wiring that makes the attention loop LIVE.
 *
 * `setupTerminalWake(deps)` constructs the recurring wake-FSM against the daemon
 * `TypedEventBus`, binds `isSessionActive` to the owner-scoped registry, binds
 * `escalate` to a `terminal:escalated` emit + a NotifyFn, and binds `wakeOneTurn` to the
 * woken-turn driver: `session_status` → read the frame → `decideAutoAnswer` (safe-only)
 * → on a safe match send the canned keystroke (audited: `terminal:auto_answered`) + run the
 * loop-guard; on escalate send NOTHING + emit `terminal:escalated`. A repeated normalized
 * prompt across woken turns trips the loop-guard → escalate `loop_detected`.
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
    /** Simulate the re-publish hook putting an fd3 input_needed onto the bus. */
    fireInputNeeded(sessionId: string, agentId: string, reason = "settled_cursor_parked") {
      this.emit("terminal:input_needed", { sessionId, agentId, state: "awaiting-input", reason, timestamp: 1 });
    },
    /** Simulate the skills wait tool emitting a content-free promotion. */
    fireDrivePromoted(sessionId: string, agentId: string, reason: "producing" | "mode_detached" = "producing") {
      this.emit("terminal:drive_promoted", { sessionId, agentId, reason, timestamp: 1 });
    },
  };
}

/** A fake per-agent registry: owner-scoped get/status/read/sendText with a scriptable screen.
 *  `stampedOwner`: when set, the session is stamped under THAT owner (a channel/API
 *  drive is stamped under (userId, nonEmptyKey)) and `get` is OWNER-STRICT against it (so a
 *  cross-owner wake owner resolves not-found); `getOwner` recovers it. Omitted ⇒ owner-agnostic
 *  (the default behavior). */
function makeRegistry(opts: { screen: string; alive?: boolean; stampedOwner?: { agentId: string; sessionKey: string } }) {
  // delivered:true mirrors the production registry's ok-reply path — a send that
  // round-trips a live worker is delivered, so the woken turn audits it as a real answer.
  const sendText = vi.fn(async () => ({ screen: opts.screen, cursor: { x: 0, y: 0 }, delivered: true }));
  const stamped = opts.stampedOwner ?? { agentId: "a", sessionKey: "" };
  const matches = (o: { agentId?: string; sessionKey?: string }): boolean =>
    !opts.stampedOwner || (o?.agentId === stamped.agentId && o?.sessionKey === stamped.sessionKey);
  return {
    sendText,
    getOwner: vi.fn(() => (opts.alive === false ? undefined : stamped)),
    get: vi.fn((_id: string, o: { agentId?: string; sessionKey?: string }) =>
      opts.alive === false || !matches(o) ? undefined : ({ sessionId: "s", owner: stamped } as never)),
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

function build(dataDir: string, opts: { screen: string; alive?: boolean; autoAnswer?: "none" | "safe-only" | "all"; hintPatterns?: string[]; stampedOwner?: { agentId: string; sessionKey: string } }): Built {
  const bus = makeBus();
  const registry = makeRegistry({ screen: opts.screen, alive: opts.alive, ...(opts.stampedOwner ? { stampedOwner: opts.stampedOwner } : {}) });
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

describe("setupTerminalWake — the subscribe + woken-turn driver", () => {
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
    // The woken turn ran: it queried the owner-scoped status (the turn start).
    expect(built.registry.status).toHaveBeenCalledTimes(1);
  });

  it("a wake for a session stamped under a channel/API owner (userId, nonEmptyKey) is NOT dropped cross-owner — the woken turn runs", async () => {
    // A chat-API/Telegram session is created in a request context, so it is STAMPED under
    // (userId, sessionKey) — not (realAgentId, ""). The wake adapter derives
    // (realAgentId="a", sessionKey="") from the owner-agnostic worker event, so a plain
    // registry.get(sessionId, ("a","")) would owner-strict mismatch and DROP the wake for an
    // ALIVE session. isSessionActive recovers the stamped owner via registry.getOwner so the
    // live session resolves and the woken turn runs.
    built = build(dataDir, {
      screen: "Press enter to continue",
      stampedOwner: { agentId: "openai-api", sessionKey: "default:openai-api:openai" },
    });
    built.bus.fireInputNeeded("s-1", "a"); // the wake agentId is the REAL agent "a"; the session is stamped under the userId
    await flush();
    expect(
      built.registry.status,
      "a channel/API-stamped session's wake must NOT be dropped cross-owner — the detached woken turn must run",
    ).toHaveBeenCalledTimes(1);
  });

  it("auto-answer: a safe-pattern screen → send the canned keystroke + emit terminal:auto_answered", async () => {
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

  it("escalate: a destructive/auth screen → NO keystroke, emit terminal:escalated + fire the NotifyFn", async () => {
    built = build(dataDir, { screen: "Permanently delete all files? (y/n)", autoAnswer: "safe-only", hintPatterns: ["(y/n)"] });
    built.bus.fireInputNeeded("s-1", "a");
    await flush();

    // Escalate-always WINS over the hintPattern: no keystroke is sent.
    expect(built.registry.sendText).not.toHaveBeenCalled();
    const escalated = built.bus.emitted.find((e) => e.event === "terminal:escalated");
    expect(escalated, "terminal:escalated must be emitted").toBeDefined();
    expect(escalated!.payload).toMatchObject({ sessionId: "s-1", agentId: "a", reason: "destructive" });
    // The escalation reaches a human via the NotifyFn chain.
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

  it("loop-guard: the SAME normalized prompt answered twice → the 2nd woken turn escalates loop_detected (no 2nd-frame answer)", async () => {
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

  it("a malformed terminal:input_needed (missing sessionId/agentId) is dropped at the adapter with a WARN, no turn", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    // A re-publish missing the structural fields the FSM keys on — a future emit site,
    // a test double, or a refactor. The adapter must VALIDATE before the blind cast and
    // drop it (defense-in-depth), never key FSM state on "undefined:undefined".
    built.bus.emit("terminal:input_needed", { state: "awaiting-input", reason: "x", timestamp: 1 });
    await flush();

    // No woken turn — the malformed frame never reached the woken-turn driver.
    expect(built.registry.status).not.toHaveBeenCalled();
    // The drop is audited at the adapter with a malformed-shape hint.
    const warn = built.logger.warn.mock.calls.find(
      (c) => typeof (c[0] as { hint?: string })?.hint === "string" && (c[0] as { hint: string }).hint.includes("malformed"),
    );
    expect(warn, "a malformed wake frame must WARN with a 'malformed' hint").toBeDefined();
    expect((warn![0] as { errorKind?: string }).errorKind).toBe("validation");
  });

  it("a well-formed terminal:input_needed still drives a turn (the guard does not reject valid frames)", async () => {
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

  it("terminal:session_evicted removes the session's durable wake-state file (no per-session disk leak)", async () => {
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

  it("terminal:session_state(exited|lost) removes the wake-state file too (PTY exit end-of-life)", async () => {
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

  it("a still-running session_state transition (created|running) does NOT remove the wake-state file", async () => {
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

  it("end-of-life cleanup is unsubscribed on shutdown (a post-shutdown eviction does not throw)", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    await built.handle.shutdown();
    // After shutdown the cleanup subscriptions are gone — a late eviction is a no-op.
    expect(() =>
      built!.bus.emit("terminal:session_evicted", { sessionId: "s-x", agentId: "a", reason: "idle", durationMs: 1, timestamp: 5 }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // The dispatcher consumes terminal:drive_promoted into a
  // closure-local promoted-Set (mirroring the loopGuard lifecycle) + fires EXACTLY
  // ONE content-free "drive started (backgrounded)" notify per session via the
  // WokenTurnNotify chain (origin:background_task — NOT the escalate() path). The
  // skills wait tool emits per-qualifying-wait; the daemon collapses to one
  // (promote-once). A sub-threshold inline drive emits nothing → no notify.
  // -------------------------------------------------------------------------

  /** The notify calls the dispatcher made (the WokenTurnNotify chain). */
  function notifyCalls(b: Built): Array<{ agentId: string; message: string; priority: string; origin: string }> {
    return b.notify.mock.calls.map((c) => c[0] as { agentId: string; message: string; priority: string; origin: string });
  }

  it("a terminal:drive_promoted records the session + fires exactly ONE drive-started notify (WokenTurnNotify chain, origin:background_task)", async () => {
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

  it("no terminal:drive_promoted emitted (the inline short-drive path) → NO notify", async () => {
    built = build(dataDir, { screen: "$ " });
    // A sub-threshold inline drive: the wait tool emitted nothing, so the dispatcher
    // never sees a promotion. The promoted-Set stays empty; no drive-started notify.
    built.bus.fireInputNeeded("s-inline", "a"); // a normal attention frame, NOT a promotion
    await flush();

    expect(notifyCalls(built).some((c) => c.origin === "background_task" && c.message.toLowerCase().includes("background")))
      .toBe(false);
  });

  it("a malformed terminal:drive_promoted (missing sessionId/agentId) is dropped with a WARN, no notify (spoofing guard)", async () => {
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

  // The drive-STARTED (promotion) notifies only — distinct from the done/failed outcome
  // notify a promoted exit/evict now ALSO fires. These reclaim tests assert the promote-once
  // dedupe survives end-of-life, so they count the drive-started line, not the total.
  function driveStartedCount(b: Built): number {
    return notifyCalls(b).filter((c) => /running in the background/i.test(c.message)).length;
  }

  it("onSessionGone forgets a promoted session: after eviction a fresh promotion for a recycled id notifies again", async () => {
    built = build(dataDir, { screen: "Building…" });
    built.bus.fireDrivePromoted("s-recycle", "a", "producing");
    await flush();
    expect(driveStartedCount(built)).toBe(1);

    // The session is evicted — its promoted-state must be reclaimed (no stale dedupe). (The
    // eviction now also fires a failed outcome notify; the reclaim assertion counts the
    // drive-started line only.)
    built.bus.emit("terminal:session_evicted", { sessionId: "s-recycle", agentId: "a", reason: "idle", durationMs: 1, timestamp: 2 });
    await flush();

    // A recycled sessionId promoting again is a NEW promotion → a fresh drive-started notify.
    built.bus.fireDrivePromoted("s-recycle", "a", "producing");
    await flush();
    expect(driveStartedCount(built)).toBe(2);
  });

  it("onSessionGone forgets a promoted session on a PTY exit (session_state exited|lost) too", async () => {
    built = build(dataDir, { screen: "Building…" });
    built.bus.fireDrivePromoted("s-exit", "a", "producing");
    await flush();
    expect(driveStartedCount(built)).toBe(1);

    // The exit now also fires a done outcome notify; the reclaim assertion counts the
    // drive-started line only.
    built.bus.emit("terminal:session_state", { sessionId: "s-exit", agentId: "a", state: "exited", durationMs: 0, timestamp: 3 });
    await flush();
    built.bus.fireDrivePromoted("s-exit", "a", "producing");
    await flush();
    expect(driveStartedCount(built)).toBe(2);
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

  it("the daemon stamps + reclaims a per-session drive-start and passes driveStartMs to the driver (source guard)", () => {
    const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
    // A closure-local per-session drive-start map (mirrors driveJournals) so the journal's
    // elapsedMs measures from the promotion instant, not a per-turn delta.
    expect(src, "must hold a closure-local drive-start map").toMatch(/driveStartedAtMs/);
    // Stamped at promotion (the "drive started" moment) — set in the promotion consumer.
    expect(src, "must stamp the drive-start on promotion").toMatch(/driveStartedAtMs\.set\(/);
    // Reclaimed on end-of-life (no per-session leak) — deleted in onSessionGone.
    expect(src, "must reclaim the drive-start on session end-of-life").toMatch(/driveStartedAtMs\.delete\(/);
    // The accessor is threaded into the woken-turn driver as driveStartMs.
    expect(src, "must pass driveStartMs to the woken-turn driver").toMatch(/driveStartMs/);
  });

  // -------------------------------------------------------------------------
  // The drive-scope routing. A PROMOTED session's
  // woken turn is attributed to a dedicated `drive:<sessionId>` sessionKey (the
  // FSM/journal/conversation scope), while the active-check resolves the SAME
  // session via its STAMPED registry owner (`sessionKey:""`, via registryOwnerFor)
  // so a promoted session's wakes are NOT dropped. An unpromoted session stays on
  // `sessionKey:""` (the inline path).
  // -------------------------------------------------------------------------

  /**
   * A registry whose session is ONLY resolvable under its STAMPED owner (`sessionKey:""`).
   * `get`/`status`/`read` consult the owner: a call carrying a drive-scoped (or any
   * non-"") sessionKey returns the not-found view (the production owner-gate, `sameOwner`).
   * This is how a test proves the active-check + the woken-turn read strip the drive scope
   * back to the stamped owner — without the strip, a promoted session reads not-found.
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

  it("a promoted session's woken turn is attributed to drive:<id>, an unpromoted one to ''", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });

    // (a) UNPROMOTED — the woken turn's owner sessionKey is "" (the inline path).
    built.bus.fireInputNeeded("s-plain", "a");
    await flush();
    const plainOwner = built.registry.status.mock.calls.at(-1)?.[1] as { sessionKey: string } | undefined;
    expect(plainOwner?.sessionKey, "an unpromoted woken turn resolves the stamped owner ''").toBe("");

    // (b) PROMOTED — promote the session, then a wake routes the drive scope. The driver
    //     STRIPS it for the registry call, so status still resolves the stamped
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
    // (registryOwnerFor) or registry.get returns undefined and the wake is silently dropped.
    // Pin: a promoted session's wake DRIVES a turn.
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

  it("makeWakeAdapterBus derives the drive sessionKey from promotedSessions (source guard)", () => {
    const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
    // The line-228 `sessionKey:""` literal is replaced by the derived drive-scope key.
    expect(src, "the woken-turn owner sessionKey must be derived via driveScopeKey(ev.sessionId)").toMatch(/sessionKey:\s*driveScopeKey\(ev\.sessionId\)/);
    // The active-check resolves via the stamped registry owner (registryOwnerFor).
    expect(src, "isSessionActive must resolve via registryOwnerFor(owner)").toMatch(/registryOwnerFor/);
  });

  // -------------------------------------------------------------------------
  // The wake-holder PERSISTS each journal update via the durable
  // store + RESUMES from it on a re-attach. A resumed drive does NOT re-answer
  // an already-answered prompt (the answeredPrompts dedup survives the restart).
  // The DURABLE file is preserved on a lost/crash; removed ONLY on a clean exit.
  // -------------------------------------------------------------------------

  /** A capturing fake of the daemon-bound durable journal store. */
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

  /** Build with a durable journal store injected (+ the safe-pattern config so a wake answers). */
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

  it("a PROMOTED drive's journal is persisted on every update (the journal.set wrapper calls store.persist)", async () => {
    built = buildDur(dataDir, { screen: "Press enter to continue" });
    const { js } = built as Built & { js: ReturnType<typeof makeJournalStore> };
    // Promote so the woken turn engages the journal (drive-scope gating), then a wake updates it.
    built.bus.fireDrivePromoted("s-dur", "a", "producing");
    await flush();
    built.bus.fireInputNeeded("s-dur", "a");
    await flush();

    // The journal.set wrapper persisted the updated journal for the promoted session.
    expect(js.store.persist, "every journal.set must persist (single persistence point)").toHaveBeenCalled();
    const persisted = js.persistCalls.find((c) => c.sessionId === "s-dur");
    expect(persisted, "the promoted session's journal must be persisted").toBeDefined();
    expect(persisted!.agentId).toBe("a");
    // The persisted journal reflects the woken turn (interactions bumped past the empty 0).
    expect(persisted!.journal.interactions).toBeGreaterThanOrEqual(1);
  });

  it("an UNPROMOTED drive persists NOTHING (the persist is gated on promoted + a present store)", async () => {
    built = buildDur(dataDir, { screen: "Press enter to continue" });
    const { js } = built as Built & { js: ReturnType<typeof makeJournalStore> };
    // No promotion → the woken turn never touches the journal → nothing is persisted.
    built.bus.fireInputNeeded("s-plain", "a");
    await flush();
    expect(js.store.persist, "an unpromoted drive must persist nothing").not.toHaveBeenCalled();
  });

  it("a terminal:drive_reattached seeds the journal cache from store.load (the registry signals the re-attach)", async () => {
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

  it("resume-no-re-answer: a resumed drive whose journal has answeredPrompts continues from it (the seeded answeredPrompts survives into the live journal)", async () => {
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
    expect(persisted!.journal.answeredPrompts, "the resumed journal must carry the prior life's answeredPrompts").toContain("pattern:0");
    expect(persisted!.journal.interactions, "the resumed journal continues from the recovered interactions (not reset to 1)").toBeGreaterThan(2);
  });

  it("preserve-on-crash: a lost/exited session reclaims the in-memory cache but does NOT remove the durable file", async () => {
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
    expect(js.store.remove, "a lost/crash must NOT remove the durable journal (preserve-on-failure)").not.toHaveBeenCalled();
  });

  it("the boot-race gap: a wake LAZY-SEEDS a recovered durable journal even when terminal:drive_reattached was DROPPED at boot — the resumed drive does NOT re-answer an already-answered prompt", async () => {
    // The boot race: the registry's recover-on-boot emits terminal:drive_reattached during the
    // boot sweep BEFORE setupTerminalWake subscribes, so the event is lost. The robust fix
    // is order-independent: the holder lazy-seeds the journal from store.load on the FIRST
    // woken turn of a recovered session (when its in-memory journal is empty). Here we seed the
    // on-disk journal as already-answered "pattern:0" and fire a wake WITHOUT ever firing
    // drive_reattached/drive_promoted (simulating the dropped boot event) — the woken turn must
    // resume from disk + SKIP re-answering pattern:0 (resume, don't re-answer).
    const seeded = new Map<string, DriveJournalShape>([
      ["a/s-boot", { objective: "build the app", lastClassification: "awaiting-input", lastScreenDigest: "", answeredPrompts: ["pattern:0"], stepsTried: ["ran:build"], elapsedMs: 5_000, interactions: 4, costUsd: 0, truncations: 0 }],
    ]);
    built = buildDur(dataDir, { screen: "Press enter to continue", seed: seeded });
    const { js } = built as Built & { js: ReturnType<typeof makeJournalStore> };
    // NO drive_reattached, NO drive_promoted — only the wake (the boot event was dropped).
    built.bus.fireInputNeeded("s-boot", "a");
    await flush();

    // The holder lazy-loaded the persisted journal (the resume read happened on the first wake).
    expect(js.store.load, "the first wake must lazy-load the recovered journal").toHaveBeenCalledWith("a", "s-boot");
    // RESUME-no-re-answer (I10): pattern:0 was already answered before the crash, so the woken
    // turn must NOT re-send the canned keystroke for it (the loop-guard ring is cold post-restart,
    // so without the lazy-seed the resume guard has nothing to consult and re-answers).
    expect(built.registry.sendText, "a resumed drive must NOT re-answer an already-answered prompt").not.toHaveBeenCalled();
    const reAnswered = built.bus.emitted.find((e) => e.event === "terminal:auto_answered");
    expect(reAnswered, "no auto_answered for an already-answered prompt on resume").toBeUndefined();
  });

  it("a wake for a recovered durable session with NO persisted journal is a no-op load (no throw; a plain session is unaffected)", async () => {
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

  it("the journal.set wrapper persists + the holder seeds on a re-attach (source guard)", () => {
    const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
    // The single durable persistence point: the journal.set wrapper calls the store's persist.
    expect(src, "the journal.set wrapper must persist via driveJournalStore").toMatch(/driveJournalStore\??\.persist\(/);
    // The holder seeds the resumed journal from the store on the re-attach signal.
    expect(src, "the holder must seed from driveJournalStore.load on a re-attach").toMatch(/driveJournalStore\??\.load\(/);
    // The re-attach signal is the registry's content-free terminal:drive_reattached.
    expect(src, "the holder must consume terminal:drive_reattached for resume").toMatch(/terminal:drive_reattached/);
  });

  // -------------------------------------------------------------------------
  // The coarse liveness BACKSTOP timer. It rides UNDER the
  // event-driven wake purely as a safety net: a deps.timers.setInterval(...).unref()
  // that, per tick, for each PROMOTED session, fires ONE liveness check ONLY in the
  // ABSENCE of a wake within the heartbeat window (no per-tick screen read), then
  //   - busyOrHung → "busy"  ⇒ NOT stuck (the check's status round-trip is the lastActivity stamp)
  //   - busyOrHung → "hung"  ⇒ synth state:"stuck" via the EXISTING terminal:input_needed seam
  // A normally-progressing drive (a transition inside heartbeatMs every tick) NEVER triggers it.
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
   * Build with the backstop wired: a fake TimerPort, a controllable clock, and an
   * injected checkLiveness probe (has-session + noProgressMs + stuckMs — NO screen).
   * `liveness` maps a sessionId → its BusySignal-shaped probe.
   */
  function buildBackstop(
    dataDir: string,
    opts: {
      screen: string;
      heartbeatMs?: number;
      liveness: Record<string, { alive: boolean; noProgressMs: number; stuckMs: number; awaitingInput?: boolean } | undefined>;
      /** An optional seeded journal store so a recovered drive can be lazy-seeded/promoted. */
      seed?: Map<string, DriveJournalShape>;
    },
  ): Built & {
    fake: ReturnType<typeof makeFakeTimers>;
    clock: { now: number };
    checkLiveness: ReturnType<typeof vi.fn>;
    js: ReturnType<typeof makeJournalStore>;
  } {
    const bus = makeBus();
    const registry = makeRegistry({ screen: opts.screen });
    const logger = makeLogger();
    const notify = vi.fn(async () => undefined);
    const fake = makeFakeTimers();
    const clock = { now: 100_000 };
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
      // NO refreshLastActivity dep — checkLiveness's status round-trip stamps
      // lastActivity; the backstop's busy verdict relies on that, not a separate hook.
      checkLiveness,
      driveJournalStore: js.store,
    } as unknown as SetupTerminalWakeDeps;
    const handle = setupTerminalWake(deps);
    return { bus, registry, logger, notify, handle, fake, clock, checkLiveness, js };
  }

  /** The synth-stuck wakes the backstop emits through the existing terminal:input_needed seam. */
  function synthStuckEmits(b: Built): Array<Record<string, unknown>> {
    return b.bus.emitted.filter((e) => e.event === "terminal:input_needed" && e.payload.state === "stuck").map((e) => e.payload);
  }

  it("the backstop arms a deps.timers.setInterval at heartbeatMs and .unref()'s the handle (mirrors the reaper)", () => {
    built = buildBackstop(dataDir, { screen: "Building…", heartbeatMs: 45_000, liveness: {} });
    const { fake } = built as ReturnType<typeof buildBackstop>;
    // The backstop interval is the one armed at heartbeatMs (the buildBackstop harness also
    // arms the user-facing heartbeat interval at the default cadence — assert the
    // backstop one specifically, distinct from that).
    const backstop = fake.intervals.find((i) => i.intervalMs === 45_000);
    expect(backstop, "the backstop must arm an interval at heartbeatMs").toBeDefined();
    expect(backstop!.handle.unrefCalls, "the backstop handle must be .unref()'d (never holds the loop open on SIGTERM)").toBeGreaterThanOrEqual(1);
  });

  it("a normally-progressing drive (a transition INSIDE heartbeatMs) triggers 0 synth-stuck + reads NO screen", async () => {
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

    // A wake intervened → no liveness check, no synth-stuck, NO screen read this tick.
    expect(synthStuckEmits(b), "a normally-progressing drive must NOT be declared stuck").toHaveLength(0);
    expect(b.checkLiveness, "a wake intervened → the backstop must skip the liveness check").not.toHaveBeenCalled();
    expect(b.registry.read, "the backstop must NEVER read the screen per tick").not.toHaveBeenCalled();
  });

  it("a promoted drive that reaches awaiting-input (finished + idle) notifies the user EXACTLY ONCE — not per tick, and never a stuck", async () => {
    // A backgrounded drive that finishes (the CLI goes idle at its prompt box) emits no fd3
    // attention once promoted, and the backstop otherwise acts only on 'hung' — so a finished
    // drive would dead-end with nothing delivered. The backstop therefore also delivers a
    // ONE-TIME completion notification on awaiting-input.
    const b = buildBackstop(dataDir, { screen: "❯ ", heartbeatMs: 90_000, liveness: { "s-done": { alive: true, noProgressMs: 0, stuckMs: 600_000, awaitingInput: true } } });
    built = b;
    b.bus.fireDrivePromoted("s-done", "a", "producing");
    await flush();
    b.notify.mockClear(); // drop the 'drive started' promotion notify; we assert the COMPLETION notify
    // Past the heartbeat window with no intervening wake → the backstop checks + sees awaiting-input.
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();
    expect(b.notify, "a finished (awaiting-input) backgrounded drive notifies the user exactly once").toHaveBeenCalledTimes(1);
    expect(synthStuckEmits(b), "a finished/idle drive is awaiting-input (busy), NEVER synthesized stuck").toHaveLength(0);
    // De-dup: a SECOND tick while STILL awaiting-input must NOT re-notify (no per-tick spam).
    b.notify.mockClear();
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();
    expect(b.notify, "completion is delivered once per idle period, not every backstop tick").not.toHaveBeenCalled();
  });

  it("a SILENT + HUNG drive (no transition past heartbeatMs, busyOrHung→hung) synthesizes EXACTLY ONE stuck through the existing terminal:input_needed seam (no 600s wait)", async () => {
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
    // the backstop's OWN liveness check is the injected has-session + noProgressMs probe and
    // reads NO screen. The downstream woken turn the synthesized stuck triggers DOES read
    // the screen — that is the whole point of escalating a stuck — but that is the FSM's read,
    // not the backstop tick's; the "no per-tick screen read" invariant is about the BACKSTOP.
    expect(b.checkLiveness, "the backstop performed the injected liveness check (has-session + noProgressMs)").toHaveBeenCalledWith("s-hung", "a");
    // A WARN with the hint+errorKind+step surfaces the synthesized stuck.
    const warn = b.logger.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "liveness_backstop");
    expect(warn, "a synthesized stuck must WARN with step:liveness_backstop").toBeDefined();
    expect((warn![0] as { errorKind?: string }).errorKind).toBe("timeout");
    expect(typeof (warn![0] as { hint?: string }).hint).toBe("string");
  });

  it("a SILENT + BUSY drive (a quiet compile) runs the liveness check + synthesizes 0 stuck (lastActivity is refreshed by the check's status round-trip)", async () => {
    const b = buildBackstop(dataDir, { screen: "Compiling…", heartbeatMs: 90_000, liveness: { "s-busy": { alive: true, noProgressMs: 1_000, stuckMs: 600_000 } } });
    built = b;
    b.bus.fireDrivePromoted("s-busy", "a", "producing");
    await flush();
    // Past the heartbeat window with no wake → the backstop fires its one check.
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();

    // busyOrHung → "busy": NOT stuck. The idle-reaper liveness stamp is the checkLiveness
    // round-trip's `registry.status` lastActivity stamp (no separate refresh hook); here
    // we pin that the busy verdict ran the liveness check + declared no stuck.
    expect(b.checkLiveness, "a busy verdict must run the liveness check (whose status round-trip stamps lastActivity)").toHaveBeenCalledWith("s-busy", "a");
    expect(synthStuckEmits(b), "a busy compile must NOT be declared stuck").toHaveLength(0);
  });

  it("a DEAD backend (alive:false) is hung → synth stuck (busyOrHung biases dead→hung regardless of timing)", async () => {
    const b = buildBackstop(dataDir, { screen: "$ ", heartbeatMs: 90_000, liveness: { "s-dead": { alive: false, noProgressMs: 0, stuckMs: 600_000 } } });
    built = b;
    b.bus.fireDrivePromoted("s-dead", "a", "producing");
    await flush();
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();
    expect(synthStuckEmits(b), "a dead backend is hung → synth stuck").toHaveLength(1);
  });

  it("an UNPROMOTED session is NOT checked by the backstop (the backstop only guards promoted drives)", async () => {
    const b = buildBackstop(dataDir, { screen: "$ ", heartbeatMs: 90_000, liveness: { "s-plain": { alive: false, noProgressMs: 999_999, stuckMs: 600_000 } } });
    built = b;
    // No promotion — a plain terminal_session. The backstop must not check or synth-stuck it.
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();
    expect(b.checkLiveness, "an unpromoted session must NOT be liveness-checked").not.toHaveBeenCalled();
    expect(synthStuckEmits(b), "an unpromoted session must NOT be synth-stuck").toHaveLength(0);
  });

  it("the synth-stuck fires AT MOST ONCE per silent stretch — a second tick still inside the same no-wake stretch does NOT re-synth", async () => {
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

  it("the backstop interval handle is cancelled on shutdown (no leaked timer)", async () => {
    const b = buildBackstop(dataDir, { screen: "$ ", liveness: {} });
    built = b;
    await b.handle.shutdown();
    built = undefined; // already shut down
    expect(b.fake.intervals[0]!.handle.cancelCalls, "shutdown must cancel the backstop interval").toBeGreaterThanOrEqual(1);
  });

  it("the backstop arms timers.setInterval(...).unref() + consumes busyOrHung + never reads the screen per tick (source guard)", () => {
    const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
    expect(src, "the backstop must arm an interval off the injected TimerPort").toMatch(/timers\??\.setInterval\(/);
    expect(src, "the backstop handle must be .unref()'d").toMatch(/\.unref\(\)/);
    expect(src, "the backstop must consume the busy-vs-hung predicate").toMatch(/busyOrHung/);
    expect(src, "the backstop must gate on the per-session last-transition").toMatch(/lastTransition/);
    expect(src, "the backstop must read heartbeatMs").toMatch(/heartbeatMs/);
  });

  // -------------------------------------------------------------------------
  // The backstop + spend ceiling only guard promotedSessions, which is EMPTY for a
  // boot-recovered durable drive — so a re-attached drive that later hangs would be
  // invisible to the backstop. The recover/resume path (onDriveReattached AND the
  // lazy-seed) therefore PROMOTES the recovered session so the backstop + spend
  // ceiling cover its remaining life.
  // -------------------------------------------------------------------------
  it("a drive recovered via terminal:drive_reattached IS promoted → a later hang is backstopped (synth stuck)", async () => {
    const seeded = new Map<string, DriveJournalShape>([
      ["a/s-recov", { objective: "build", lastClassification: "working", lastScreenDigest: "", answeredPrompts: [], stepsTried: [], elapsedMs: 10_000, interactions: 1, costUsd: 0, truncations: 0 }],
    ]);
    const b = buildBackstop(dataDir, { screen: "$ ", heartbeatMs: 90_000, seed: seeded, liveness: { "s-recov": { alive: true, noProgressMs: 999_999, stuckMs: 600_000 } } });
    built = b;
    // The registry re-attached the surviving session on boot → the resume event (delivered
    // here AFTER subscription) promotes it — no live drive_promoted ever fired.
    b.bus.emit("terminal:drive_reattached", { sessionId: "s-recov", agentId: "a", reason: "tmux_alive", timestamp: 1 });
    await flush();
    // The drive then hangs (no wake past the heartbeat window) → the backstop must guard it.
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();

    expect(b.checkLiveness, "a recovered drive must be liveness-checked by the backstop").toHaveBeenCalledWith("s-recov", "a");
    expect(synthStuckEmits(b), "a recovered drive that hangs must synthesize a stuck").toHaveLength(1);
    expect(synthStuckEmits(b)[0]).toMatchObject({ sessionId: "s-recov", agentId: "a", state: "stuck" });
  });

  it("a drive recovered via the lazy-seed (first wake; the boot event was dropped) IS promoted → a later hang is backstopped", async () => {
    const seeded = new Map<string, DriveJournalShape>([
      ["a/s-lazy", { objective: "build", lastClassification: "working", lastScreenDigest: "", answeredPrompts: [], stepsTried: [], elapsedMs: 10_000, interactions: 1, costUsd: 0, truncations: 0 }],
    ]);
    const b = buildBackstop(dataDir, { screen: "$ ", heartbeatMs: 90_000, seed: seeded, liveness: { "s-lazy": { alive: true, noProgressMs: 999_999, stuckMs: 600_000 } } });
    built = b;
    // NO drive_reattached (dropped at boot). The first wake lazy-seeds + promotes the recovered
    // drive — which ALSO makes it backstop-guarded via the lazy-seed path.
    b.bus.fireInputNeeded("s-lazy", "a");
    await flush();
    b.clock.now += 120_000;
    b.fake.tick();
    await flush();

    expect(synthStuckEmits(b), "a lazily-recovered drive that hangs must synthesize a stuck").toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The outcome + heartbeat wiring. The keystone holder
  // DERIVES the user-facing done/failed outcomes at onStateChange/onEvicted (gated
  // by drive.notify, capturing wasPromoted+journal BEFORE onSessionGone clears them,
  // naming the cap on onEvicted), keeps the escalation notify UNCONDITIONAL,
  // and arms a SECOND coarse user-facing heartbeat timer, distinct from
  // the internal backstop. The pure decision/digest fns are siblings;
  // these tests pin the WIRING (the outcome fires deps.notify; the heartbeat ticks;
  // the gate suppresses; the ordering captures-before-clear).
  // -------------------------------------------------------------------------
  describe("outcome + heartbeat wiring", () => {
    /** The heartbeat cadence used in these tests — DISTINCT from heartbeatMs so the timer is isolable. */
    const HEARTBEAT_NOTIFY_MS = 3_600_000;

    /**
     * Build with the outcome + heartbeat wiring exercised: a fake TimerPort + a controllable clock
     * (for the heartbeat tick), an optional seeded journal store (so a promoted drive carries a
     * heartbeat-able journal), and the operator deps `notifyPolicy` + `heartbeatNotifyMs`.
     * Mirrors `buildBackstop` (the fake-timer harness) — but for the user-facing outcome+heartbeat
     * path, NOT the liveness backstop (no `checkLiveness`, so the backstop never arms; only the
     * heartbeat timer is under test). The screen drives whether a wake escalates.
     */
    function buildNotify(
      dataDir: string,
      opts: {
        screen: string;
        notifyPolicy?: "terminal" | "all" | "none";
        heartbeatNotifyMs?: number;
        hintPatterns?: string[];
        seed?: Map<string, DriveJournalShape>;
      },
    ): Built & { fake: ReturnType<typeof makeFakeTimers>; clock: { now: number }; js: ReturnType<typeof makeJournalStore> } {
      const bus = makeBus();
      const registry = makeRegistry({ screen: opts.screen });
      const logger = makeLogger();
      const notify = vi.fn(async () => undefined);
      const fake = makeFakeTimers();
      const clock = { now: 100_000 };
      const js = makeJournalStore(opts.seed);
      const registries = new Map<string, ReturnType<typeof makeRegistry>>([["a", registry]]);
      const deps = {
        eventBus: bus as unknown as SetupTerminalWakeDeps["eventBus"],
        registries: registries as unknown as SetupTerminalWakeDeps["registries"],
        getTerminalAttentionConfig: () => ({ autoAnswer: "safe-only" as const, hintPatterns: opts.hintPatterns ?? ["press enter to continue"], maxHops: 5, maxConcurrentAttentionTurns: 2 }),
        notify,
        dataDir,
        nowMs: () => clock.now,
        logger: logger as unknown as SetupTerminalWakeDeps["logger"],
        timers: fake.timers,
        driveJournalStore: js.store,
        // The operator deps under test.
        notifyPolicy: opts.notifyPolicy ?? "terminal",
        heartbeatNotifyMs: opts.heartbeatNotifyMs ?? HEARTBEAT_NOTIFY_MS,
      } as unknown as SetupTerminalWakeDeps;
      const handle = setupTerminalWake(deps);
      return { bus, registry, logger, notify, handle, fake, clock, js };
    }

    /** The notify calls that are a terminal OUTCOME (done/failed) — NOT the drive-started promotion line. */
    function outcomeNotifies(b: Built): Array<{ agentId: string; message: string }> {
      return notifyCalls(b)
        .filter((c) => /\b(done|completed|failed)\b/i.test(c.message) && !/running in the background/i.test(c.message))
        .map((c) => ({ agentId: c.agentId, message: c.message }));
    }

    /** The heartbeat notifies — the "still working" digest line. */
    function heartbeatNotifies(b: Built): Array<{ agentId: string; message: string }> {
      return notifyCalls(b)
        .filter((c) => /still working/i.test(c.message))
        .map((c) => ({ agentId: c.agentId, message: c.message }));
    }

    /** Fire ONLY the heartbeat interval (the one armed at the heartbeat cadence) — not the backstop's. */
    function tickHeartbeat(b: Built & { fake: ReturnType<typeof makeFakeTimers> }, cadenceMs = HEARTBEAT_NOTIFY_MS): void {
      for (const i of b.fake.intervals) if (i.intervalMs === cadenceMs) i.cb();
    }

    // --- DONE -------------------------------------------------

    it("notifies exactly ONE content-free done when a PROMOTED session's PTY exits (high-confidence exited → done)", async () => {
      const b = buildNotify(dataDir, { screen: "Building…" });
      built = b;
      b.bus.fireDrivePromoted("s-done", "a", "producing");
      await flush();
      b.bus.emit("terminal:session_state", { sessionId: "s-done", agentId: "a", state: "exited", durationMs: 0, timestamp: 3 });
      await flush();

      const done = outcomeNotifies(b);
      expect(done, "a promoted clean exit notifies exactly one done").toHaveLength(1);
      expect(done[0]).toMatchObject({ agentId: "a" });
      expect(done[0]!.message).toContain("s-done");
      // Content-free: the done message carries the sessionId + the outcome enum, never screen text.
      expect(done[0]!.message, "the done message must NOT leak screen text").not.toMatch(/Building/);
    });

    it("does NOT notify an outcome when an UNPROMOTED (inline short) session exits (byte-identical)", async () => {
      const b = buildNotify(dataDir, { screen: "$ " });
      built = b;
      // No promotion — an inline drive. Its exit must stay byte-identical (no outcome notify).
      b.bus.emit("terminal:session_state", { sessionId: "s-inline", agentId: "a", state: "exited", durationMs: 0, timestamp: 3 });
      await flush();
      expect(outcomeNotifies(b), "an unpromoted exit must emit NO outcome notify").toHaveLength(0);
    });

    // --- FAILED -----------------------

    it("notifies exactly ONE failed with an errorKind when a PROMOTED durable session goes lost (GENUINE unrecoverable death)", async () => {
      const seeded = new Map<string, DriveJournalShape>([
        ["a/s-lost", { objective: "build", lastClassification: "working", lastScreenDigest: "compiling", answeredPrompts: [], stepsTried: [], elapsedMs: 7_200_000, interactions: 12, costUsd: 0, truncations: 0 }],
      ]);
      const b = buildNotify(dataDir, { screen: "Building…", seed: seeded });
      built = b;
      // Re-attach (which promotes + seeds the journal) → then the durable session goes GENUINELY
      // lost. ONLY a lost marked `unrecoverable:true` (the durable-wiring onUnrecoverable
      // emit) is a genuine death → failed. It threads the real content-free reason.
      b.bus.emit("terminal:drive_reattached", { sessionId: "s-lost", agentId: "a", reason: "tmux_alive", timestamp: 1 });
      await flush();
      b.bus.emit("terminal:session_state", { sessionId: "s-lost", agentId: "a", state: "lost", unrecoverable: true, reason: "tmux_session_gone", durationMs: 0, timestamp: 9 });
      await flush();

      const failed = outcomeNotifies(b);
      expect(failed, "a promoted GENUINE lost notifies exactly one failed").toHaveLength(1);
      expect(failed[0]!.message.toLowerCase(), "the failed message names the failed outcome").toContain("failed");
      // The structured record carries errorKind + hint (a failure branch, not just an INFO).
      const warn = b.logger.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome");
      expect(warn, "a failed outcome must WARN with step:drive_outcome").toBeDefined();
      expect((warn![0] as { errorKind?: string }).errorKind, "a lost failure is errorKind:dependency").toBe("dependency");
      expect(typeof (warn![0] as { hint?: string }).hint, "a failed WARN carries a hint").toBe("string");
      // The REAL unrecoverable reason rides the structured record + the hint (not a generic "session_lost").
      expect((warn![0] as { reason?: string }).reason, "the genuine-death reason rides the failed record").toBe("tmux_session_gone");
      expect((warn![0] as { hint: string }).hint, "the hint names the actual cause").toContain("tmux_session_gone");
      // The captured interactions (from the journal, BEFORE onSessionGone cleared it) ride the record.
      expect((warn![0] as { interactions?: number }).interactions, "the captured journal interactions ride the failed record (capture-before-clear)").toBe(12);
    });

    it("notifies exactly ONE failed NAMING the cap when a PROMOTED session is evicted by a named cap (wall_clock)", async () => {
      const b = buildNotify(dataDir, { screen: "Building…" });
      built = b;
      b.bus.fireDrivePromoted("s-cap", "a", "producing");
      await flush();
      b.bus.emit("terminal:session_evicted", { sessionId: "s-cap", agentId: "a", reason: "wall_clock", durationMs: 0, timestamp: 5 });
      await flush();

      const failed = outcomeNotifies(b);
      expect(failed, "a named cap-eviction notifies exactly one failed").toHaveLength(1);
      // The cap name rides the message AND the structured record (a deliberate bound, not a mystery).
      expect(failed[0]!.message, "the failed message NAMES the cap (wall_clock)").toContain("wall_clock");
      const warn = b.logger.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome");
      expect(warn, "a cap failure WARNs with step:drive_outcome").toBeDefined();
      expect((warn![0] as { errorKind?: string }).errorKind, "a cap failure is errorKind:resource").toBe("resource");
      expect((warn![0] as { capName?: string }).capName, "the structured record names the cap").toBe("wall_clock");
    });

    it("the reaper's DUAL emit (session_evicted + the companion plain lost, production order) yields EXACTLY ONE failed naming the cap — no double-notify, no dependency-kind", async () => {
      const b = buildNotify(dataDir, { screen: "Building…" });
      built = b;
      b.bus.fireDrivePromoted("s-dual", "a", "producing");
      await flush();
      // The PRODUCTION reaper emits BOTH events on every eviction (setup-terminal-tools.ts onEvict,
      // in this fixed order): the audited session_evicted (the cap) THEN the companion plain
      // session_state{lost} (the lifecycle transition, NOT marked unrecoverable). The plain lost is
      // not a genuine death, so it never maps to failed → the eviction path is the unambiguous SOLE
      // outcome owner, independent of emit order.
      b.bus.emit("terminal:session_evicted", { sessionId: "s-dual", agentId: "a", reason: "max_interactions", durationMs: 0, timestamp: 5 });
      b.bus.emit("terminal:session_state", { sessionId: "s-dual", agentId: "a", state: "lost", durationMs: 0, timestamp: 5 });
      await flush();

      const failed = outcomeNotifies(b).filter((o) => /failed/i.test(o.message));
      expect(failed, "the dual reaper emit must yield exactly ONE failed (no double-notify)").toHaveLength(1);
      expect(failed[0]!.message, "the single failed NAMES the cap (not a dependency-kind lost)").toContain("max_interactions");
      // Exactly ONE failed WARN — and it is the cap (resource) kind, never the lost (dependency) kind.
      const warns = b.logger.warn.mock.calls.filter((c) => (c[0] as { step?: string })?.step === "drive_outcome");
      expect(warns, "exactly one failed record (no double)").toHaveLength(1);
      expect((warns[0]![0] as { errorKind?: string }).errorKind, "the cap-eviction owns the outcome (resource, not dependency)").toBe("resource");
    });

    it("references the captured journal+promoted state even though onSessionGone clears them (capture-before-clear ordering)", async () => {
      // onSessionGone deletes promotedSessions + driveJournals; the outcome derivation MUST read
      // them FIRST. Pin: a promoted exit still notifies done — proving wasPromoted was captured
      // before onSessionGone ran (if the order were reversed, promotedSessions.has would be false
      // and the done would be suppressed).
      const b = buildNotify(dataDir, { screen: "Building…" });
      built = b;
      b.bus.fireDrivePromoted("s-order", "a", "producing");
      await flush();
      b.bus.emit("terminal:session_state", { sessionId: "s-order", agentId: "a", state: "exited", durationMs: 0, timestamp: 3 });
      await flush();
      expect(outcomeNotifies(b), "the outcome derivation captured wasPromoted BEFORE onSessionGone cleared it").toHaveLength(1);
    });

    // --- never fail a healthy long/quiet drive -----------------------

    it("emits NO failed for a healthy long/quiet promoted drive that never goes lost or evicted", async () => {
      const b = buildNotify(dataDir, { screen: "Compiling…" });
      built = b;
      b.bus.fireDrivePromoted("s-long", "a", "producing");
      await flush();
      // A 40h drive that emits only working/busy wakes — NEVER lost, NEVER evicted.
      for (let i = 0; i < 8; i++) {
        b.bus.fireInputNeeded("s-long", "a", `working_frame_${i}`);
        await flush();
      }
      // No lost, no evict → no genuine death → NO failed (the invariant is structural upstream).
      expect(outcomeNotifies(b).filter((o) => /failed/i.test(o.message)), "a healthy long/quiet drive must never be reported failed").toHaveLength(0);
    });

    it("does NOT report failed for a transient lost on an UNPROMOTED session (only a promoted durable lost is a failure)", async () => {
      const b = buildNotify(dataDir, { screen: "$ " });
      built = b;
      // An unpromoted session going lost is expected — no user-facing failed.
      b.bus.emit("terminal:session_state", { sessionId: "s-transient", agentId: "a", state: "lost", durationMs: 0, timestamp: 9 });
      await flush();
      expect(outcomeNotifies(b), "an unpromoted lost emits no failed").toHaveLength(0);
    });

    // --- A PROMOTED drive's TRANSIENT/recoverable lost is NOT a genuine death → ZERO failed.
    //     `terminal:session_state{lost}` is emitted on the transient worker-crash respawn path
    //     (terminal-worker-supervisor.ts → the fd3 re-publish) AND for a durable session that
    //     re-attaches — neither carries `unrecoverable:true`. Only the durable-wiring
    //     onUnrecoverable genuine death sets it, so only that maps to failed; a healthy/recoverable
    //     drive is never falsely reported dead.
    // ---------------------------------------------------------------------------

    it("a PROMOTED (non-durable) drive that goes lost via a TRANSIENT worker crash emits ZERO failed (the worker re-spawns)", async () => {
      const b = buildNotify(dataDir, { screen: "Compiling…" });
      built = b;
      // A promoted, NON-durable long drive (promotion does not require durability).
      b.bus.fireDrivePromoted("s-crash", "a", "producing");
      await flush();
      // The worker process transiently crashes → the supervisor re-publishes state:"lost" WITHOUT
      // an `unrecoverable` marker ("worker will re-spawn"). This must NOT be a user-facing failed.
      b.bus.emit("terminal:session_state", { sessionId: "s-crash", agentId: "a", state: "lost", durationMs: 0, timestamp: 9 });
      await flush();

      expect(outcomeNotifies(b).filter((o) => /failed/i.test(o.message)), "a promoted transient worker-crash lost must NOT be reported failed").toHaveLength(0);
      // And no failed WARN was emitted either (the drive is alive/recoverable).
      const warn = b.logger.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome");
      expect(warn, "a transient lost must NOT emit a failed record").toBeUndefined();
    });

    it("a PROMOTED DURABLE drive that emits lost while its tmux is alive (a re-attach) emits ZERO failed", async () => {
      const seeded = new Map<string, DriveJournalShape>([
        ["a/s-reattach", { objective: "build", lastClassification: "working", lastScreenDigest: "", answeredPrompts: [], stepsTried: [], elapsedMs: 5_000, interactions: 3, costUsd: 0, truncations: 0 }],
      ]);
      const b = buildNotify(dataDir, { screen: "Compiling…", seed: seeded });
      built = b;
      // A durable drive recovered + promoted on boot (re-attach).
      b.bus.emit("terminal:drive_reattached", { sessionId: "s-reattach", agentId: "a", reason: "tmux_alive", timestamp: 1 });
      await flush();
      // A transient lost arrives (e.g. the over-broad crash snapshot) but the durable session is
      // alive and re-attaching — the emit is NOT marked unrecoverable. ZERO failed.
      b.bus.emit("terminal:session_state", { sessionId: "s-reattach", agentId: "a", state: "lost", durationMs: 0, timestamp: 9 });
      await flush();

      expect(outcomeNotifies(b).filter((o) => /failed/i.test(o.message)), "a re-attaching durable drive must NEVER be reported failed").toHaveLength(0);
    });

    it("a GENUINE unrecoverable lost (unrecoverable:true) on a PROMOTED drive emits EXACTLY ONE failed naming the real reason", async () => {
      const b = buildNotify(dataDir, { screen: "Building…" });
      built = b;
      b.bus.fireDrivePromoted("s-dead", "a", "producing");
      await flush();
      // The genuine death: the durable-wiring onUnrecoverable emit marks the lost unrecoverable +
      // carries the real content-free reason. This is the ONE legitimate failed source.
      b.bus.emit("terminal:session_state", { sessionId: "s-dead", agentId: "a", state: "lost", unrecoverable: true, reason: "tmux_reattach_failed", durationMs: 0, timestamp: 9 });
      await flush();

      const failed = outcomeNotifies(b).filter((o) => /failed/i.test(o.message));
      expect(failed, "a genuine unrecoverable death notifies exactly one failed").toHaveLength(1);
      // The structured record names the actual cause, not a generic "session_lost".
      const warn = b.logger.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome");
      expect(warn, "a genuine death emits a failed record").toBeDefined();
      expect((warn![0] as { errorKind?: string }).errorKind, "a lost failure is errorKind:dependency").toBe("dependency");
      expect((warn![0] as { reason?: string }).reason, "the record names the real unrecoverable reason").toBe("tmux_reattach_failed");
      expect((warn![0] as { hint: string }).hint, "the hint names the actual cause").toContain("tmux_reattach_failed");
    });

    // --- escalation always fires; done/failed suppressed under none ---

    it("STILL fires the escalation notify under notifyPolicy:none (an escalation is never gated)", async () => {
      const b = buildNotify(dataDir, { screen: "Permanently delete all files? (y/n)", notifyPolicy: "none", hintPatterns: ["(y/n)"] });
      built = b;
      // A destructive prompt → escalate-always WINS, even under notify:"none".
      b.bus.fireInputNeeded("s-esc", "a");
      await flush();

      const escalated = b.bus.emitted.find((e) => e.event === "terminal:escalated");
      expect(escalated, "a destructive screen must still escalate under notify:none").toBeDefined();
      // The escalation reaches the user via deps.notify even under "none" (never suppressed).
      const notifs = notifyCalls(b);
      expect(notifs.some((c) => /needs a human|delete|escalat/i.test(c.message) || c.origin === "background_task"), "the escalation notify must fire under notify:none").toBe(true);
      expect(notifs.length, "the escalation under none produced at least one notify").toBeGreaterThanOrEqual(1);
    });

    it("SUPPRESSES the done outcome under notifyPolicy:none (a promoted exit emits no done) while leaving the escalation path intact", async () => {
      const b = buildNotify(dataDir, { screen: "Building…", notifyPolicy: "none" });
      built = b;
      b.bus.fireDrivePromoted("s-q", "a", "producing");
      await flush();
      // The drive-started promotion notify already fired (that is NOT gated — it is the 164 path).
      b.notify.mockClear();
      b.bus.emit("terminal:session_state", { sessionId: "s-q", agentId: "a", state: "exited", durationMs: 0, timestamp: 3 });
      await flush();
      expect(outcomeNotifies(b), "done is suppressed under notify:none").toHaveLength(0);
    });

    it("SUPPRESSES the failed outcome under notifyPolicy:none (a promoted named cap-eviction emits no failed notify)", async () => {
      const b = buildNotify(dataDir, { screen: "Building…", notifyPolicy: "none" });
      built = b;
      b.bus.fireDrivePromoted("s-qc", "a", "producing");
      await flush();
      b.notify.mockClear();
      b.bus.emit("terminal:session_evicted", { sessionId: "s-qc", agentId: "a", reason: "wall_clock", durationMs: 0, timestamp: 5 });
      await flush();
      expect(outcomeNotifies(b), "failed is suppressed under notify:none").toHaveLength(0);
    });

    // --- HEARTBEAT -------------------------------------------

    it("arms a SECOND user-facing heartbeat interval at heartbeatNotifyMs and .unref()'s the handle (distinct from the liveness backstop)", () => {
      const b = buildNotify(dataDir, { screen: "Building…", heartbeatNotifyMs: HEARTBEAT_NOTIFY_MS });
      built = b;
      const hb = b.fake.intervals.find((i) => i.intervalMs === HEARTBEAT_NOTIFY_MS);
      expect(hb, "a user-facing heartbeat interval must be armed at heartbeatNotifyMs").toBeDefined();
      expect(hb!.handle.unrefCalls, "the heartbeat handle must be .unref()'d (never holds the loop open on SIGTERM)").toBeGreaterThanOrEqual(1);
    });

    it("emits a content-free heartbeat for a PROMOTED drive at the cadence carrying the journal digest", async () => {
      const seeded = new Map<string, DriveJournalShape>([
        ["a/s-hb", { objective: "build", lastClassification: "working", lastScreenDigest: "12r 80c, 3 changed", answeredPrompts: [], stepsTried: [], elapsedMs: 7_200_000, interactions: 5, costUsd: 1.25, truncations: 0 }],
      ]);
      const b = buildNotify(dataDir, { screen: "Building…", seed: seeded });
      built = b;
      // Re-attach promotes + seeds the journal (the heartbeat reads driveJournals + sessionAgent).
      b.bus.emit("terminal:drive_reattached", { sessionId: "s-hb", agentId: "a", reason: "tmux_alive", timestamp: 1 });
      await flush();
      // Advance the clock past the cadence, then fire the heartbeat interval.
      b.clock.now += HEARTBEAT_NOTIFY_MS + 1;
      tickHeartbeat(b);
      await flush();

      const beats = heartbeatNotifies(b);
      expect(beats, "a promoted drive emits a heartbeat at the cadence").toHaveLength(1);
      expect(beats[0]).toMatchObject({ agentId: "a" });
      // The line is the content-free digest: the already-redacted lastScreenDigest, never raw bytes.
      expect(beats[0]!.message, "the heartbeat carries the journal digest").toContain("12r 80c, 3 changed");
      expect(beats[0]!.message.toLowerCase(), "the heartbeat is the 'still working' progress line").toContain("still working");
      // An INFO heartbeat record (content-free, not DEBUG-only).
      const info = b.logger.info.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_heartbeat");
      expect(info, "a heartbeat must emit an INFO step:drive_heartbeat record").toBeDefined();
    });

    it("a freshly-promoted drive emits NO heartbeat on the first tick WITHIN one cadence of promotion (the stamp is seeded at promotion)", async () => {
      const b = buildNotify(dataDir, { screen: "Compiling…" });
      built = b;
      // Advance the wall clock so it is already well past one cadence (the realistic case: a daemon
      // up for hours promotes a new drive). Without the promotion-time stamp an unstamped session
      // reads `last:0` ⇒ `now-0 >= cadence` ⇒ it would fire a bogus "elapsed 0.0h" heartbeat on the very first tick.
      b.clock.now += HEARTBEAT_NOTIFY_MS * 5;
      b.bus.fireDrivePromoted("s-fresh", "a", "producing");
      await flush();
      // The first heartbeat tick lands only a little after promotion (< one cadence later).
      b.clock.now += Math.floor(HEARTBEAT_NOTIFY_MS / 10);
      tickHeartbeat(b);
      await flush();
      // The promotion seeded lastHeartbeatSentMs = promotion-instant, so it is NOT yet due —
      // the first user heartbeat lands one FULL cadence after promotion, not seconds after.
      expect(heartbeatNotifies(b), "a freshly-promoted drive must NOT heartbeat within the first cadence").toHaveLength(0);
      // And after a full cadence past promotion, it DOES fire (the seed only delays, never silences).
      b.clock.now += HEARTBEAT_NOTIFY_MS;
      tickHeartbeat(b);
      await flush();
      expect(heartbeatNotifies(b), "after one full cadence the heartbeat fires (the seed delays, not silences)").toHaveLength(1);
    });

    it("emits NO heartbeat for a SHORT (unpromoted) drive — only promoted drives are heartbeated", async () => {
      const b = buildNotify(dataDir, { screen: "$ " });
      built = b;
      // A plain unpromoted session present, but never promoted → not in promotedSessions.
      b.bus.fireInputNeeded("s-short", "a");
      await flush();
      b.clock.now += HEARTBEAT_NOTIFY_MS + 1;
      tickHeartbeat(b);
      await flush();
      expect(heartbeatNotifies(b), "an unpromoted short drive emits no heartbeat").toHaveLength(0);
    });

    it("arms NO heartbeat timer when heartbeatNotifyMs is 0 — but a terminal outcome (exited → done) STILL fires", async () => {
      const b = buildNotify(dataDir, { screen: "Building…", heartbeatNotifyMs: 0 });
      built = b;
      // 0 ⇒ terminal-only: the heartbeat cadence interval must NEVER be armed.
      const armedAtZero = b.fake.intervals.find((i) => i.intervalMs === 0);
      expect(armedAtZero, "heartbeatNotifyMs:0 must arm NO heartbeat interval").toBeUndefined();
      // But terminal outcomes are independent of the heartbeat — a promoted exit still notifies done.
      b.bus.fireDrivePromoted("s-zero", "a", "producing");
      await flush();
      b.bus.emit("terminal:session_state", { sessionId: "s-zero", agentId: "a", state: "exited", durationMs: 0, timestamp: 3 });
      await flush();
      expect(outcomeNotifies(b), "a terminal outcome still fires under heartbeatNotifyMs:0").toHaveLength(1);
    });

    it("arms NO heartbeat timer under notifyPolicy:none (the heartbeat is a non-escalation notification, suppressed)", () => {
      const b = buildNotify(dataDir, { screen: "Building…", notifyPolicy: "none", heartbeatNotifyMs: HEARTBEAT_NOTIFY_MS });
      built = b;
      const hb = b.fake.intervals.find((i) => i.intervalMs === HEARTBEAT_NOTIFY_MS);
      expect(hb, "under notify:none the heartbeat timer must NOT be armed").toBeUndefined();
    });

    it("cancels the heartbeat interval on shutdown (no leaked timer)", async () => {
      const b = buildNotify(dataDir, { screen: "Building…", heartbeatNotifyMs: HEARTBEAT_NOTIFY_MS });
      const hb = b.fake.intervals.find((i) => i.intervalMs === HEARTBEAT_NOTIFY_MS);
      await b.handle.shutdown();
      built = undefined; // already shut down
      expect(hb!.handle.cancelCalls, "shutdown must cancel the heartbeat interval").toBeGreaterThanOrEqual(1);
    });

    // --- wiring source guards (the extraction + the cap-name fix + the deps) ---

    it("routes the outcome derivation through the sibling modules + the extracted terminal-wake-notify helper (source guard)", () => {
      const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
      const sibling = readFileSync(fileURLToPath(new URL("./terminal-wake-notify.ts", import.meta.url)), "utf8");
      // The holder calls the extracted emit helper; the helper consumes the pure outcome map.
      expect(src, "the holder must call the extracted emitTerminalOutcome helper").toMatch(/emitTerminalOutcome/);
      expect(sibling, "the extracted helper must derive the outcome via mapTerminalOutcome").toMatch(/mapTerminalOutcome/);
      // onEvicted reads e.reason to name the cap.
      expect(src, "onEvicted must read e.reason to name the cap (the dropped-reason fix)").toMatch(/e\.reason/);
      // The new operator dep is threaded.
      expect(src, "the holder must accept a notifyPolicy dep").toMatch(/notifyPolicy/);
    });

    it("extracts the notify-gating + heartbeat loop into a terminal-wake-notify.ts sibling so the holder stays under the 800-line cap", () => {
      const holder = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
      expect(holder.split("\n").length, "setup-terminal-wake.ts must stay <= 800 lines via the extraction").toBeLessThanOrEqual(800);
      // The extracted sibling exists and is imported.
      expect(holder, "the holder must import the extracted terminal-wake-notify sibling").toMatch(/terminal-wake-notify/);
    });
  });

  // -------------------------------------------------------------------------
  // The operator per-drive spend ceiling (`drive.maxCostUsd`)
  // must reach its sole consumer THROUGH setupTerminalWake. The durability bundle
  // resolves it (terminal-durable-wiring.ts → maxCostUsd: config.drive?.maxCostUsd ??
  // null) and the daemon SPREADS it into setupTerminalWake — but if the holder's deps
  // interface omits `maxCostUsd`, the spread silently drops it (TS lets excess props
  // through a spread) and buildWokenTurnDriver never receives it, so the consumer
  // checkSpendCeiling(costUsd, deps.maxCostUsd ?? null) always sees `null` (uncapped)
  // regardless of operator config — the configured ceiling is INERT. This is the
  // integration seam a per-module unit suite misses (the driver's own
  // spend tests inject maxCostUsd DIRECTLY into buildWokenTurnDriver, never through the
  // setupTerminalWake hop the daemon actually uses).
  //
  // No fabricated cost producer: costUsd stays honestly 0 at the canned-keystroke
  // seam — so this test seeds the run-total cost into the DURABLE journal store (the
  // honest persistence path), then recovers/promotes the drive so its FIRST woken turn
  // reads the seeded costUsd at the spend-ceiling check (terminal-wake-turn.ts) — never
  // fabricating a cost at the keystroke seam.
  // -------------------------------------------------------------------------
  describe("spend ceiling — the configured ceiling reaches the consumer THROUGH setupTerminalWake", () => {
    /**
     * A registry whose session is always resolvable AND carries the `evict` spy the
     * spend-ceiling breach path calls (terminal-wake-turn.ts — a breach evicts + escalates
     * + WARNs, never a silent overspend). The base makeRegistry has no `evict`, so this
     * adds it (the breach STOP is `registry.evict(sessionId, owner, "max_interactions")`).
     */
    function makeEvictableRegistry(opts: { screen: string }) {
      const base = makeRegistry({ screen: opts.screen });
      const evict = vi.fn(async () => undefined);
      return Object.assign(base, { evict });
    }

    /**
     * Build the keystone holder with a durable journal store seeded with a run-total
     * costUsd AND the `maxCostUsd` THREADED THROUGH setupTerminalWake (not into
     * buildWokenTurnDriver directly). `maxCostUsd: undefined` omits it entirely (the
     * uncapped default). Returns the evictable registry so a test can assert the breach
     * STOP fired.
     */
    function buildSpend(
      dataDir: string,
      opts: { screen: string; seed: Map<string, DriveJournalShape>; maxCostUsd?: number | null },
    ): Built & { js: ReturnType<typeof makeJournalStore>; registry: ReturnType<typeof makeEvictableRegistry> } {
      const bus = makeBus();
      const registry = makeEvictableRegistry({ screen: opts.screen });
      const logger = makeLogger();
      const notify = vi.fn(async () => undefined);
      const js = makeJournalStore(opts.seed);
      const registries = new Map<string, ReturnType<typeof makeEvictableRegistry>>([["a", registry]]);
      const deps = {
        eventBus: bus as unknown as SetupTerminalWakeDeps["eventBus"],
        registries: registries as unknown as SetupTerminalWakeDeps["registries"],
        getTerminalAttentionConfig: () => ({ autoAnswer: "safe-only" as const, hintPatterns: ["press enter to continue"], maxHops: 5, maxConcurrentAttentionTurns: 2 }),
        notify,
        dataDir,
        nowMs: () => 1_000,
        logger: logger as unknown as SetupTerminalWakeDeps["logger"],
        driveJournalStore: js.store,
        // The dep under test — threaded THROUGH setupTerminalWake (the daemon
        // spreads ...terminalDurability, which carries maxCostUsd; this exercises that hop).
        ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
      } as unknown as SetupTerminalWakeDeps;
      const handle = setupTerminalWake(deps);
      return { bus, registry, logger, notify, handle, js };
    }

    /** A journal seeded with a run-total cost (the honest persisted value, NOT fabricated at the seam). */
    function seedWithCost(agentId: string, sessionId: string, costUsd: number): Map<string, DriveJournalShape> {
      return new Map<string, DriveJournalShape>([
        [`${agentId}/${sessionId}`, { objective: "build", lastClassification: "working", lastScreenDigest: "", answeredPrompts: [], stepsTried: [], elapsedMs: 10_000, interactions: 3, costUsd, truncations: 0 }],
      ]);
    }

    /** The spend-ceiling WARN the breach path emits (step:spend_ceiling). */
    function spendBreachWarn(b: Built) {
      return b.logger.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "spend_ceiling");
    }

    it("a threaded maxCostUsd reaches the consumer: a recovered/promoted drive whose journal costUsd is OVER the configured ceiling has its FIRST woken turn breach the spend check (escalate + evict + STOP), never a silent overspend", async () => {
      // The drive's honest run-total cost (seeded into the durable store) exceeds the
      // operator ceiling threaded through setupTerminalWake.
      const seed = seedWithCost("a", "s-over", 10);
      const b = buildSpend(dataDir, { screen: "Press enter to continue", seed, maxCostUsd: 5 });
      built = b;
      // Re-attach promotes + seeds the journal cache from disk (costUsd=10) so the first
      // woken turn reads it at the spend-ceiling check.
      b.bus.emit("terminal:drive_reattached", { sessionId: "s-over", agentId: "a", reason: "tmux_alive", timestamp: 1 });
      await flush();
      // A wake → the first woken turn. The spend check runs FIRST (before status/read/answer).
      b.bus.fireInputNeeded("s-over", "a");
      await flush();

      // The breach fired BECAUSE the configured ceiling reached the consumer (if maxCostUsd is
      // dropped at the setupTerminalWake hop it is uncapped → no breach).
      const warn = spendBreachWarn(b);
      expect(warn, "the configured maxCostUsd must reach the spend check (a breach WARNs step:spend_ceiling)").toBeDefined();
      expect((warn![0] as { errorKind?: string }).errorKind, "a spend breach is errorKind:resource").toBe("resource");
      expect((warn![0] as { maxCostUsd?: number }).maxCostUsd, "the breach record names the configured ceiling (not null)").toBe(5);
      expect((warn![0] as { costUsd?: number }).costUsd, "the breach record names the over-cap run-total").toBe(10);
      // On breach the drive is STOPPED (evicted) — never a silent overspend.
      expect(b.registry.evict, "a breach must STOP the drive (evict), never let it run on uncapped").toHaveBeenCalledWith("s-over", expect.anything(), "max_interactions");
      // And escalated to a human (the breach rides the existing escalate() path).
      const escalated = b.bus.emitted.find((e) => e.event === "terminal:escalated");
      expect(escalated, "a spend breach escalates to a human").toBeDefined();
      // The breach pre-empts the turn: no canned keystroke was sent (the drive is stopping).
      expect(b.registry.sendText, "a breached turn sends NO keystroke (it STOPS)").not.toHaveBeenCalled();
    });

    it("the SAME over-cost drive with maxCostUsd OMITTED (uncapped default) does NOT breach — a healthy drive under no ceiling is never stopped", async () => {
      // Identical seeded over-cost journal, but NO maxCostUsd threaded → uncapped.
      const seed = seedWithCost("a", "s-uncapped", 10);
      const b = buildSpend(dataDir, { screen: "Press enter to continue", seed }); // maxCostUsd omitted
      built = b;
      b.bus.emit("terminal:drive_reattached", { sessionId: "s-uncapped", agentId: "a", reason: "tmux_alive", timestamp: 1 });
      await flush();
      b.bus.fireInputNeeded("s-uncapped", "a");
      await flush();

      // Uncapped → checkSpendCeiling returns undefined → NO breach (byte-identical to the no-ceiling path).
      expect(spendBreachWarn(b), "an uncapped drive must NOT breach").toBeUndefined();
      expect(b.registry.evict, "an uncapped drive must NOT be stopped").not.toHaveBeenCalled();
      // The turn proceeded normally: the safe-pattern screen was answered (not pre-empted).
      expect(b.registry.sendText, "an uncapped turn proceeds to answer the safe prompt (not stopped)").toHaveBeenCalled();
    });

    it("a drive UNDER the configured ceiling is never stopped (the ceiling reaches the consumer but does not spuriously fire)", async () => {
      // costUsd (3) < maxCostUsd (5) → the threaded ceiling reaches the consumer but the
      // strict `>` boundary means the budget is not yet over → no breach (proves the
      // forwarding does not over-fire, distinct from the omitted-cap path above).
      const seed = seedWithCost("a", "s-under", 3);
      const b = buildSpend(dataDir, { screen: "Press enter to continue", seed, maxCostUsd: 5 });
      built = b;
      b.bus.emit("terminal:drive_reattached", { sessionId: "s-under", agentId: "a", reason: "tmux_alive", timestamp: 1 });
      await flush();
      b.bus.fireInputNeeded("s-under", "a");
      await flush();

      expect(spendBreachWarn(b), "a drive under the ceiling must NOT breach").toBeUndefined();
      expect(b.registry.evict, "a drive under the ceiling must NOT be stopped").not.toHaveBeenCalled();
      expect(b.registry.sendText, "a healthy under-cap turn proceeds normally").toHaveBeenCalled();
    });

    it("forwarding wiring (source guard): SetupTerminalWakeDeps declares maxCostUsd AND the buildWokenTurnDriver({...}) call forwards deps.maxCostUsd", () => {
      const src = readFileSync(fileURLToPath(new URL("./setup-terminal-wake.ts", import.meta.url)), "utf8");
      // The holder's deps interface must DECLARE the spend ceiling (else the daemon spread drops it).
      expect(src, "SetupTerminalWakeDeps must declare maxCostUsd").toMatch(/maxCostUsd\??\s*:\s*number\s*\|\s*null/);
      // The holder must FORWARD it into the woken-turn driver (the consumer reads deps.maxCostUsd).
      expect(src, "buildWokenTurnDriver must be passed maxCostUsd: deps.maxCostUsd").toMatch(/maxCostUsd:\s*deps\.maxCostUsd/);
    });
  });
});
