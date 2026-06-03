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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupTerminalWake, type SetupTerminalWakeDeps } from "./setup-terminal-wake.js";

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
  };
}

/** A fake per-agent registry: owner-scoped get/status/read/sendText with a scriptable screen. */
function makeRegistry(opts: { screen: string; alive?: boolean }) {
  const sendText = vi.fn(async () => ({ screen: opts.screen, cursor: { x: 0, y: 0 } }));
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

  it("shutdown() unsubscribes + drains: after shutdown a fresh input_needed wakes no turn", async () => {
    built = build(dataDir, { screen: "Press enter to continue" });
    await built.handle.shutdown();
    built.registry.status.mockClear();
    built.bus.fireInputNeeded("s-1", "a");
    await flush();
    expect(built.registry.status).not.toHaveBeenCalled();
  });
});
