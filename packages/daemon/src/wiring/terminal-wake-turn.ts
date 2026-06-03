// SPDX-License-Identifier: Apache-2.0
/**
 * The §4.4 woken-turn driver (124-09 Task 2; TR-07 / SEC-11 / SEC-12 / OPS-04) — the
 * function the wake-FSM (124-07) calls as `wakeOneTurn(sessionId, owner)`. It runs the
 * spec §4.4 turn for ONE woken frame:
 *
 *   session_status (124-06) → read the screen (124-06 registry.read) →
 *   decideAutoAnswer (124-04, safe-only) →
 *     • on `answer`  : run the loop-guard; if a repeat → escalate `loop_detected`,
 *                      else send the canned keystroke via the registry send path +
 *                      audit (`terminal:auto_answered` + a redacted §2.7 keystroke log +
 *                      the redaction-safe `terminal:keystroke` summary).
 *     • on `escalate`: send NOTHING; emit `terminal:escalated` + fire the NotifyFn chain
 *                      (subagent→parent→human, §4.7).
 *
 * Extracted from `setup-terminal-wake.ts` so that file stays well under the 800-line
 * architecture cap and the turn logic is unit-testable as a seam.
 *
 * Architecture: daemon-side. Value-imports `@comis/core` (`scrubSecretsFromText` for the
 * redaction-safe keystroke summary — NEVER the observability egress helper) + the skills
 * auto-answer/loop-guard policy modules (type + value) + the registry type. No raw clock
 * (injected `nowMs`); no module-global mutable state (the loop-guard owns its closure-local
 * ring; this driver holds no state).
 *
 * @module
 */

import { scrubSecretsFromText, type ComisLogger } from "@comis/core";
import { decideAutoAnswer, type LoopGuard, type TerminalSessionRegistry } from "@comis/skills/tools";

import type { PersistedWakeOwner } from "./terminal-wake-persistence.js";

/** The per-entry attention config the woken turn reads (operator-dialable; NEVER agent-dialable). */
export interface TerminalAttentionConfig {
  /** The operator `autoAnswer` mode (`none` | `safe-only` | `all`) — default `safe-only`. */
  autoAnswer: "none" | "safe-only" | "all";
  /** The operator safe-pattern allowlist (the only prompts auto-answered). */
  hintPatterns: readonly string[];
  /** Consecutive woken-turn cap before forced escalation (wake-FSM). */
  maxHops: number;
  /** Bound on simultaneous woken turns across sessions (schema worker.maxConcurrentAttentionTurns). */
  maxConcurrentAttentionTurns: number;
}

/** The closed `terminal:escalated` reason union (mirrors `events-terminal.ts`). */
export type WokenTurnEscalationReason =
  | "destructive"
  | "approval"
  | "auth_login"
  | "loop_detected"
  | "no_safe_match";

/**
 * The narrow event-bus surface the woken turn emits onto (a `Pick`-style contract, the
 * `terminal-send-guards.ts:79` precedent — structurally assignable from the daemon
 * `TypedEventBus`). Carries ONLY the redaction-safe audit events.
 */
export interface WokenTurnBus {
  emit(
    event: "terminal:auto_answered",
    payload: { sessionId: string; agentId: string; matchedPatternIndex: number; keystrokeCount: number; timestamp: number },
  ): unknown;
  emit(
    event: "terminal:escalated",
    payload: { sessionId: string; agentId: string; reason: WokenTurnEscalationReason; timestamp: number },
  ): unknown;
  emit(
    event: "terminal:keystroke",
    payload: { sessionId: string; agentId: string; kind: "text" | "key"; redactions: number; byteLength: number; outcome: "attempted"; timestamp: number },
  ): unknown;
}

/** A NotifyFn that routes an escalation to a human (§4.7). Optional; absent ⇒ bus-only audit. */
export type WokenTurnNotify = (opts: {
  agentId: string;
  message: string;
  priority: "normal";
  origin: "background_task";
}) => Promise<unknown>;

/** The injected dependencies for the woken-turn driver. */
export interface WokenTurnDriverDeps {
  /** Per-agent registry resolver (the P4 owner-scoped registry). */
  registries: ReadonlyMap<string, TerminalSessionRegistry>;
  /** Per-agent attention config (operator allow-entry derived). Absent ⇒ the turn escalates `no_safe_match`. */
  getTerminalAttentionConfig: (agentId: string) => TerminalAttentionConfig | undefined;
  /** The shared loop-guard (124-04) — closure-local ring keyed per session. */
  loopGuard: LoopGuard;
  /** The narrow audit bus. */
  eventBus: WokenTurnBus;
  /** The human-escalation NotifyFn (§4.7). Optional. */
  notify?: WokenTurnNotify;
  /** Injected clock (no raw global). */
  nowMs: () => number;
  logger: ComisLogger;
}

/**
 * Build the `wakeOneTurn(sessionId, owner)` driver the wake-FSM calls. The returned
 * function runs the §4.4 turn for one frame; it never throws (a failure is logged + the
 * frame stays unanswered, so a fresh `input_needed` re-wakes — the FSM's contract).
 */
export function buildWokenTurnDriver(
  deps: WokenTurnDriverDeps,
): (sessionId: string, owner: PersistedWakeOwner) => Promise<void> {
  const log = deps.logger.child({ submodule: "terminal-wake-turn" });

  /** Emit the escalation audit + route the NotifyFn chain (§4.7). Never the prompt text. */
  async function escalate(sessionId: string, owner: PersistedWakeOwner, reason: WokenTurnEscalationReason): Promise<void> {
    deps.eventBus.emit("terminal:escalated", { sessionId, agentId: owner.agentId, reason, timestamp: deps.nowMs() });
    log.warn(
      { sessionId, agentId: owner.agentId, reason, hint: "terminal woken turn escalated to a human (no auto-answer)", errorKind: "precondition" as const, step: "wake_escalate" },
      "terminal woken turn escalated",
    );
    if (deps.notify) {
      // §4.7: a short, redaction-safe human message — the structural reason ONLY, never the screen.
      await deps.notify({
        agentId: owner.agentId,
        message: `Terminal session ${sessionId} needs a human: ${reason}.`,
        priority: "normal",
        origin: "background_task",
      });
    }
  }

  return async function wakeOneTurn(sessionId: string, owner: PersistedWakeOwner): Promise<void> {
    const startMs = deps.nowMs();
    const registry = deps.registries.get(owner.agentId);
    if (!registry) {
      log.warn(
        { sessionId, agentId: owner.agentId, hint: "no terminal registry for the owning agent; woken turn is a no-op", errorKind: "precondition" as const },
        "terminal woken turn: no registry for agent",
      );
      return;
    }
    const ownerObj = { agentId: owner.agentId, sessionKey: owner.sessionKey };

    // (1) session_status — the §4.4 turn start (owner-scoped; the classifier perception).
    const status = await registry.status(sessionId, ownerObj);

    // (2) read the screen (owner-scoped; redacted + wrapped as untrusted at the tool layer —
    //     here the screen feeds the SAFE-ONLY allowlist policy, never trusted as instruction).
    const view = await registry.read(sessionId, ownerObj, { format: "text" });
    const screen = view.screen ?? "";

    // (3) decide — safe-only allowlist (escalate-always gate WINS over any hintPattern).
    const cfg = deps.getTerminalAttentionConfig(owner.agentId);
    if (!cfg) {
      // No operator attention config for this agent ⇒ never auto-answer (the SAFE default).
      await escalate(sessionId, owner, "no_safe_match");
      return;
    }
    const decision = decideAutoAnswer(cfg.autoAnswer, screen, cfg.hintPatterns);

    if (decision.action === "escalate") {
      // A destructive/approval/auth-login prompt OR a non-match — send NOTHING, escalate.
      // (the auto-answer reason is a subset of the bus union; pass it through verbatim).
      await escalate(sessionId, owner, decision.reason);
      log.debug(
        { sessionId, agentId: owner.agentId, state: status.state, durationMs: deps.nowMs() - startMs, step: "wake_turn_escalated" },
        "terminal woken turn ended (escalated)",
      );
      return;
    }

    // (4) loop-guard (SEC-11) — a re-rendered (normalized) prompt seen again → escalate
    //     loop_detected BEFORE answering, so a tight auto-answer loop can never run.
    const loop = deps.loopGuard.observe(sessionId, screen);
    if (loop.repeat) {
      await escalate(sessionId, owner, "loop_detected");
      log.debug(
        { sessionId, agentId: owner.agentId, durationMs: deps.nowMs() - startMs, step: "wake_turn_loop" },
        "terminal woken turn ended (loop detected)",
      );
      return;
    }

    // (5) answer — send the canned keystroke via the registry send path + AUDIT every send.
    const text = decision.keys.join("");
    await registry.sendText(sessionId, ownerObj, { text });
    auditAnswer(deps, sessionId, owner.agentId, text, decision.matchedPatternIndex, decision.keys.length);
    log.info(
      { sessionId, agentId: owner.agentId, matchedPatternIndex: decision.matchedPatternIndex, keystrokeCount: decision.keys.length, durationMs: deps.nowMs() - startMs, step: "wake_turn_answered" },
      "terminal woken turn auto-answered a safe prompt",
    );
  };
}

/**
 * Audit one auto-answer (SEC-12 / T-124-27): emit `terminal:auto_answered` (the matched
 * pattern INDEX + keystroke COUNT — never the keystroke), a redacted §2.7 keystroke DEBUG
 * log (`scrubSecretsFromText`), AND the redaction-safe `terminal:keystroke` summary (the
 * same shape `enforceSendCapsThenAudit` produces — `redactions` + `byteLength`, never the
 * payload). The raw keystroke NEVER reaches a log or the bus.
 */
function auditAnswer(
  deps: WokenTurnDriverDeps,
  sessionId: string,
  agentId: string,
  payload: string,
  matchedPatternIndex: number,
  keystrokeCount: number,
): void {
  const { text: redactedText, redactions } = scrubSecretsFromText(payload);
  const timestamp = deps.nowMs();
  deps.logger.debug(
    { sessionId, agentId, redactedText, redactions, outcome: "attempted", step: "keystroke_audit" },
    "terminal auto-answer keystroke",
  );
  deps.eventBus.emit("terminal:keystroke", {
    sessionId,
    agentId,
    kind: "text",
    redactions,
    byteLength: Buffer.byteLength(redactedText),
    outcome: "attempted",
    timestamp,
  });
  deps.eventBus.emit("terminal:auto_answered", { sessionId, agentId, matchedPatternIndex, keystrokeCount, timestamp });
}
