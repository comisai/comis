// SPDX-License-Identifier: Apache-2.0
/**
 * RED (124-07 Task 2): the recurring wake-dispatch FSM
 * (`createTerminalWakeDispatcher`), modeled on `completion-dispatcher.ts`
 * but RECURRING/mid-session. It turns a `terminal:input_needed` event into
 * AT MOST ONE woken agent turn and proves the 5 OPS-08/OPS-09 behaviors:
 *
 *   1. DEDUPE          — 3 input_needed for one unanswered (sessionId,requestId) → 1 turn
 *   2. ACTIVE-CHECK    — a wake for a killed/evicted session is dropped + audited
 *   3. HOP-LIMIT       — at maxHops the next wake forces escalation (not a turn)
 *   4. BOUNDED RE-ENTRY— maxConcurrentAttentionTurns bounds simultaneous woken turns
 *   5. PERSIST+RECOVER — a transition persists; a fresh FSM re-hydrates it
 *
 * Plus correlation by (sessionId,requestId) and failure-isolation + shutdown
 * drain. In-process fakes + an injected clock; deterministic.
 *
 * @module
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalWakeDispatcher,
  type TerminalWakeDispatcher,
  type TerminalWakeDispatcherDeps,
  type TerminalInputNeededWake,
} from "./terminal-wake-dispatch.js";
import { persistWakeStateSync, recoverWakeStates } from "./terminal-wake-persistence.js";

// --- in-process capturing event bus (the narrow structural surface the FSM uses) ---

interface FakeBus {
  on(event: "terminal:input_needed", handler: (data: TerminalInputNeededWake) => void): void;
  off(event: "terminal:input_needed", handler: (data: TerminalInputNeededWake) => void): void;
  fire(data: TerminalInputNeededWake): void;
}

function makeBus(): FakeBus {
  const handlers = new Set<(data: TerminalInputNeededWake) => void>();
  return {
    on: (_event, handler) => void handlers.add(handler),
    off: (_event, handler) => void handlers.delete(handler),
    fire: (data) => {
      for (const h of handlers) h(data);
    },
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

const OWNER = { agentId: "agent-1", sessionKey: "" };

interface Harness {
  deps: TerminalWakeDispatcherDeps;
  bus: FakeBus;
  wakeOneTurn: ReturnType<typeof vi.fn>;
  escalate: ReturnType<typeof vi.fn>;
  isSessionActive: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof makeLogger>;
  /** Resolve a specific in-flight woken turn (for the bounded-re-entry test). */
  releases: Map<string, () => void>;
}

/** The releases map of the harness built this test, drained in afterEach. */
let currentReleases: Map<string, () => void> | undefined;

function makeHarness(dataDir: string, overrides: Partial<TerminalWakeDispatcherDeps> = {}): Harness {
  const bus = makeBus();
  const logger = makeLogger();
  const releases = new Map<string, () => void>();
  currentReleases = releases;
  const wakeOneTurn = vi.fn(
    (sessionId: string) =>
      new Promise<void>((resolve) => {
        releases.set(sessionId, resolve);
      }),
  );
  const escalate = vi.fn(async () => undefined);
  const isSessionActive = vi.fn(() => true);
  const deps: TerminalWakeDispatcherDeps = {
    eventBus: bus,
    isSessionActive,
    wakeOneTurn,
    escalate,
    dataDir,
    maxHops: 5,
    maxConcurrentAttentionTurns: 2,
    nowMs: () => 1_000,
    logger: logger as unknown as TerminalWakeDispatcherDeps["logger"],
    ...overrides,
  };
  return { deps, bus, wakeOneTurn, escalate, isSessionActive, logger, releases };
}

function wake(sessionId: string, requestId: string): TerminalInputNeededWake {
  return { sessionId, requestId, owner: OWNER, state: "awaiting-input", reason: "settled_cursor_parked" };
}

describe("terminal-wake-dispatch (recurring wake-FSM)", () => {
  let dataDir: string;
  let fsm: TerminalWakeDispatcher | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "comis-wake-fsm-"));
  });

  afterEach(async () => {
    // Release any turns still in flight so shutdown()'s drain (`await inflight`)
    // can settle — the fixture's wakeOneTurn only resolves on an explicit
    // release(), so a test that leaves turns pending would otherwise deadlock
    // the drain. A real woken turn always settles; this just mirrors that.
    for (const release of currentReleases?.values() ?? []) release();
    currentReleases = undefined;
    await fsm?.shutdown();
    fsm = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("coalesces 3 input_needed for one unanswered (sessionId,requestId) into exactly ONE woken turn", async () => {
    const h = makeHarness(dataDir);
    fsm = createTerminalWakeDispatcher(h.deps);

    h.bus.fire(wake("sess-a", "req-1"));
    h.bus.fire(wake("sess-a", "req-1"));
    h.bus.fire(wake("sess-a", "req-1"));
    await Promise.resolve();

    expect(h.wakeOneTurn).toHaveBeenCalledTimes(1);
    expect(h.wakeOneTurn).toHaveBeenCalledWith("sess-a", OWNER);
  });

  it("drops a wake for a killed/evicted session (isSessionActive=false) with no turn, audited", async () => {
    const h = makeHarness(dataDir);
    h.isSessionActive.mockReturnValue(false);
    fsm = createTerminalWakeDispatcher(h.deps);

    h.bus.fire(wake("sess-dead", "req-1"));
    await Promise.resolve();

    expect(h.wakeOneTurn).not.toHaveBeenCalled();
    expect(h.isSessionActive).toHaveBeenCalledWith("sess-dead", OWNER);
    // A drop is audited (WARN with hint/errorKind) — observability on the drop branch.
    expect(h.logger.warn).toHaveBeenCalled();
  });

  it("a SUCCESSFUL turn resets the consecutive run so a later failure run starts from zero — not a lifetime cap (WR-01)", async () => {
    // The discriminating WR-01 contract: a settled turn moves the goalpost. Drive a
    // FAILING wake (hop→1), then a SUCCEEDING wake (resets hop→0), then a fresh
    // consecutive FAILURE run must take the FULL maxHops again before escalating.
    //
    // On the pre-fix CUMULATIVE code hopCount never resets, so after fail+success it
    // sits at 2 (== maxHops) and the very NEXT failing wake escalates — fewer turns
    // run. On the fixed code the success reset it to 0, so two more failing wakes run
    // (hop 1, then 2) before the third escalates. The wakeOneTurn call count is the
    // observable that separates the two.
    let mode: "fail" | "succeed" = "fail";
    const mixedWake = vi.fn(() =>
      mode === "fail" ? Promise.reject(new Error("no progress")) : Promise.resolve(),
    );
    const h = makeHarness(dataDir, { maxHops: 2, maxConcurrentAttentionTurns: 5, wakeOneTurn: mixedWake });
    fsm = createTerminalWakeDispatcher(h.deps);

    // req-1 FAILS → hop 0→1 (no reset on failure).
    mode = "fail";
    h.bus.fire(wake("sess-a", "req-1"));
    await Promise.resolve();
    await Promise.resolve();

    // req-2 SUCCEEDS → hop resets to 0 (the fix). On pre-fix code hop becomes 2.
    mode = "succeed";
    h.bus.fire(wake("sess-a", "req-2"));
    await Promise.resolve();
    await Promise.resolve();

    // A fresh consecutive FAILURE run. On the fixed code this takes the full maxHops
    // again: req-3 (hop→1) + req-4 (hop→2) both RUN, only req-5 escalates → 4 turns.
    // On pre-fix code hop was already 2, so req-3 escalates immediately → 2 turns.
    mode = "fail";
    h.bus.fire(wake("sess-a", "req-3"));
    await Promise.resolve();
    await Promise.resolve();
    h.bus.fire(wake("sess-a", "req-4"));
    await Promise.resolve();
    await Promise.resolve();

    expect(mixedWake).toHaveBeenCalledTimes(4); // pre-fix cumulative code stops at 2

    // The 5th consecutive failing frame finally hits the (reset-based) cap.
    h.escalate.mockClear();
    h.bus.fire(wake("sess-a", "req-5"));
    await Promise.resolve();
    expect(mixedWake).toHaveBeenCalledTimes(4); // still no 5th turn — escalated instead
    expect(h.escalate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-a", reason: "hop_limit" }),
    );
  });

  it("RESETS the consecutive hop count after a turn SETTLES — a long run of answered prompts never over-escalates (WR-01)", async () => {
    // The availability defect WR-01 fixes: a long-lived session that keeps SETTLING
    // its woken turns must NOT escalate after maxHops total answers. Each settled
    // turn ends the consecutive run, so hopCount returns to 0 and the cap is never hit.
    const h = makeHarness(dataDir, { maxHops: 2, maxConcurrentAttentionTurns: 5 });
    fsm = createTerminalWakeDispatcher(h.deps);

    // Drive FOUR fully-settled frames (twice the cap). Settling between each resets
    // the consecutive counter, so none of them escalates.
    for (const reqId of ["req-1", "req-2", "req-3", "req-4"]) {
      h.bus.fire(wake("sess-a", reqId));
      await Promise.resolve();
      h.releases.get("sess-a")?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    // All four were answered (woken), none escalated — the lifetime budget is
    // maxInteractions (the P4 cap), NOT maxHops.
    expect(h.wakeOneTurn).toHaveBeenCalledTimes(4);
    expect(h.escalate).not.toHaveBeenCalled();
  });

  it("bounds simultaneous woken turns to maxConcurrentAttentionTurns; over-bound wakes stay pending", async () => {
    const h = makeHarness(dataDir, { maxConcurrentAttentionTurns: 2, maxHops: 99 });
    fsm = createTerminalWakeDispatcher(h.deps);

    // 10 distinct sessions all need attention at once.
    for (let i = 0; i < 10; i++) h.bus.fire(wake(`sess-${i}`, "req-1"));
    await Promise.resolve();

    // At most 2 turns in flight.
    expect(h.wakeOneTurn).toHaveBeenCalledTimes(2);

    // Free one slot → exactly one of the pending wakes is re-evaluated and runs.
    const first = h.wakeOneTurn.mock.calls[0][0] as string;
    h.releases.get(first)?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.wakeOneTurn).toHaveBeenCalledTimes(3);
  });

  it("re-hydrates persisted dispatch state on construction so a mid-wake session is not re-woken spuriously", async () => {
    // A session was mid-wake (woken, pendingFrame=req-1) when the daemon died.
    persistWakeStateSync(dataDir, {
      sessionId: "sess-mid",
      owner: OWNER,
      dispatchState: "woken",
      hopCount: 1,
      pendingFrame: "req-1",
    });

    const h = makeHarness(dataDir);
    fsm = createTerminalWakeDispatcher(h.deps);

    // The SAME unanswered frame arrives again after restart → dedupe (no re-wake).
    h.bus.fire(wake("sess-mid", "req-1"));
    await Promise.resolve();
    expect(h.wakeOneTurn).not.toHaveBeenCalled();

    // A transition also persists: a fresh frame on a fresh session writes state.
    h.bus.fire(wake("sess-new", "req-9"));
    await Promise.resolve();
    const persisted = recoverWakeStates(dataDir).find((s) => s.sessionId === "sess-new");
    expect(persisted?.pendingFrame).toBe("req-9");
    expect(persisted?.dispatchState).toBe("woken");
  });

  it("forgetSession drops the FSM in-memory state so a re-used id starts fresh (IN-03/WR-02)", async () => {
    // A session mid-wake (woken, pendingFrame=req-1) when the daemon died — the
    // dedupe gate keys on it, so the same requestId would normally coalesce.
    persistWakeStateSync(dataDir, {
      sessionId: "sess-gone",
      owner: OWNER,
      dispatchState: "woken",
      hopCount: 1,
      pendingFrame: "req-1",
    });
    const h = makeHarness(dataDir);
    fsm = createTerminalWakeDispatcher(h.deps);

    // forgetSession reclaims the in-memory state (the end-of-life hook calls this).
    fsm.forgetSession("sess-gone");

    // With the state forgotten, the SAME requestId is no longer deduped — it wakes a
    // fresh turn (proving the WakeState entry was actually dropped, not just orphaned).
    h.bus.fire(wake("sess-gone", "req-1"));
    await Promise.resolve();
    expect(h.wakeOneTurn).toHaveBeenCalledTimes(1);
  });

  it("treats a NEW requestId on the same session (after the prior answered) as a fresh wake", async () => {
    const h = makeHarness(dataDir);
    fsm = createTerminalWakeDispatcher(h.deps);

    h.bus.fire(wake("sess-a", "req-1"));
    await Promise.resolve();
    expect(h.wakeOneTurn).toHaveBeenCalledTimes(1);

    // Answer + clear the pending frame.
    h.releases.get("sess-a")?.();
    await Promise.resolve();
    await Promise.resolve();

    // A NEW requestId is a fresh wake (the dedupe key is (sessionId,requestId)).
    h.bus.fire(wake("sess-a", "req-2"));
    await Promise.resolve();
    expect(h.wakeOneTurn).toHaveBeenCalledTimes(2);
  });

  it("suppresses a throwing wake handler and drains in-flight turns on shutdown", async () => {
    const h = makeHarness(dataDir);
    const throwingWake = vi.fn(() => Promise.reject(new Error("boom")));
    const local = createTerminalWakeDispatcher({ ...h.deps, wakeOneTurn: throwingWake });

    // A throwing wake must not crash the dispatcher (suppressError isolation).
    expect(() => h.bus.fire(wake("sess-a", "req-1"))).not.toThrow();
    await Promise.resolve();
    expect(throwingWake).toHaveBeenCalledTimes(1);

    // shutdown drains + unsubscribes; a post-shutdown event is a no-op.
    await local.shutdown();
    h.bus.fire(wake("sess-b", "req-1"));
    await Promise.resolve();
    expect(throwingWake).toHaveBeenCalledTimes(1);
  });
});
