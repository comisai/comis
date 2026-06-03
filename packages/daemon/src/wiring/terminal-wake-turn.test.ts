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

import { buildWokenTurnDriver, type WokenTurnDriverDeps, type TerminalAttentionConfig } from "./terminal-wake-turn.js";
import type { PersistedWakeOwner } from "./terminal-wake-persistence.js";

const OWNER: PersistedWakeOwner = { agentId: "a", sessionKey: "" };
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
 */
function makeRegistry(opts: { screen: string; sendResult: { screen: string; cursor: { x: number; y: number }; delivered?: boolean } }) {
  const sendText = vi.fn(async () => opts.sendResult);
  return {
    sendText,
    get: vi.fn(() => ({ sessionId: "s", owner: OWNER }) as never),
    status: vi.fn(async () => ({ state: "awaiting-input" as const, lastActivity: 0, interactions: 1, cursorParked: true, screenDiffEmpty: true })),
    read: vi.fn(async () => ({ screen: opts.screen, cursor: { x: 0, y: 0 }, cols: 80, rows: 24, alt: false, alive: true })),
  };
}

interface Emitted {
  event: string;
  payload: Record<string, unknown>;
}

function build(opts: { screen: string; sendResult: { screen: string; cursor: { x: number; y: number }; delivered?: boolean } }) {
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
  const deps: WokenTurnDriverDeps = {
    registries: registries as unknown as WokenTurnDriverDeps["registries"],
    getTerminalAttentionConfig: () => CFG,
    loopGuard: { observe: vi.fn(() => ({ repeat: false })), forget: vi.fn() },
    eventBus: eventBus as unknown as WokenTurnDriverDeps["eventBus"],
    nowMs: () => 1_000,
    logger: logger as unknown as WokenTurnDriverDeps["logger"],
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
