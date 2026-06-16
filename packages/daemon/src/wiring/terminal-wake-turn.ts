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
import {
  decideAutoAnswer,
  emptyJournal,
  appendStep,
  appendAnswered,
  updateJournal,
  screenDigestLine,
  checkSpendCeiling,
  type LoopGuard,
  type TerminalSessionRegistry,
  type DriveJournal,
} from "@comis/skills/tools";

import type { PersistedWakeOwner } from "./terminal-wake-persistence.js";
import { registryOwnerFor, isDriveScoped } from "./terminal-drive-scope.js";

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
 * The user-facing escalation message (§4.7) — short, ACTIONABLE, and REDACTION-SAFE: built from
 * ONLY the sessionId + the structural `reason`, NEVER the screen (which is attacker-influenceable).
 * The live Telegram drive (2026-06-16) escalated with the bare `Terminal session X needs a human:
 * <reason>.` — the user could not tell what was wanted or how to unblock the drive. This states the
 * reason in plain words AND tells the user they can REPLY to drive the session (the agent relays
 * their reply to it) or "stop" to end it, and that they can ask to see the screen on demand (the
 * read tool wraps + redacts it — the screen is never pushed proactively).
 */
export function buildEscalationMessage(sessionId: string, reason: WokenTurnEscalationReason): string {
  const why: Record<WokenTurnEscalationReason, string> = {
    auth_login: "needs you to handle a sign-in / credential prompt",
    destructive: "is asking to confirm a possibly-destructive action",
    approval: "needs your approval to proceed",
    loop_detected: "looks stuck — it is repeating the same step",
    no_safe_match: "is waiting for input",
  };
  return (
    `Terminal session ${sessionId} ${why[reason]}. ` +
    `Reply here with what I should send to it — e.g. "continue", "yes", or a command — or "stop" to end the drive. ` +
    `(Ask me to "show the terminal" to see its current screen.)`
  );
}

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
    payload: { sessionId: string; agentId: string; kind: "text" | "key"; redactions: number; byteLength: number; outcome: "attempted" | "rejected"; timestamp: number },
  ): unknown;
}

/** A NotifyFn that routes an escalation to a human (§4.7). Optional; absent ⇒ bus-only audit. */
export type WokenTurnNotify = (opts: {
  agentId: string;
  message: string;
  priority: "normal";
  origin: "background_task";
}) => Promise<unknown>;

/**
 * The minimal per-session journal store the woken-turn driver reads+updates for a PROMOTED
 * drive (DRIVE-01 / 164-06). A thin wrapper over the daemon-side closure-local
 * `Map<sessionId, DriveJournal>` holder (setupTerminalWake), keyed by the BARE sessionId.
 * Injected so the driver stays unit-testable with a fake; the daemon owns the holder
 * (the in-memory state + its onSessionGone reclaim).
 */
export interface DriveJournalStore {
  /** The current journal for a session, or `undefined` on the first wake (init-on-read). */
  get(sessionId: string): DriveJournal | undefined;
  /** Write the updated journal back for a session. */
  set(sessionId: string, journal: DriveJournal): void;
}

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
  /**
   * DRIVE-01 (164-06): the bounded content-free journal store — the PROMOTED drive's
   * cross-wake memory. Optional; absent ⇒ no journal (the today's-path/unpromoted behavior is
   * byte-identical, I1). The driver engages it ONLY when the wake owner is drive-scoped.
   */
  journal?: DriveJournalStore;
  /**
   * MR-01 (DRIVE-01 / §7.1.6): resolve the wall-clock ms a session's drive STARTED (the
   * first promoted wake), so the journal's `elapsedMs = nowMs() - driveStartMs(sessionId)`
   * is the cumulative drive duration the resume substrate + a `comis explain` need — NOT a
   * per-turn delta. Optional + defensive: absent (or returning a non-finite/future value) ⇒
   * the driver falls back to this turn's start, yielding a sane non-negative `elapsedMs`
   * (never a throw, never a negative). The daemon owns the per-session start map
   * (setupTerminalWake), mirroring the journal-holder lifecycle. Returns `undefined` for an
   * as-yet-unstamped session (the driver then falls back to the turn's own start).
   */
  driveStartMs?: (sessionId: string) => number | undefined;
  /**
   * ENDURE-01 (165-07): the operator per-drive spend ceiling (`drive.maxCostUsd`), or `null`
   * for uncapped (the default — preserves today's behavior, I1). On each PROMOTED turn the
   * driver runs the pure `checkSpendCeiling(journal.costUsd, maxCostUsd)` over the journal's
   * HONEST run-total cost (I6 — never a fabricated cost) and, on a breach, escalates with the
   * figure + STOPS the turn (never a silent overspend). The daemon (165-07 Task 4) threads
   * `config.drive?.maxCostUsd ?? null`; absent/`null` ⇒ no spend check (I1). An unpromoted
   * turn has no drive journal so the ceiling is inert there regardless.
   */
  maxCostUsd?: number | null;
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

  // DUR-02 / I10 (165-07): the closure-local "first turn this daemon LIFE" marker — the
  // discriminator for the resume-no-re-answer guard. The driver is built once per daemon life
  // (setupTerminalWake); this Set resets on restart (a new daemon = a new closure). A session
  // NOT yet in this Set is on its FIRST turn this life: if its journal came back from disk
  // with prior answeredPrompts (a RESUMED drive — the in-memory loop-guard ring is cold
  // post-restart), an already-answered matched pattern is SKIPPED rather than re-sent (resume,
  // don't re-answer). After the first turn the session is "seen" and the LIVE path governs
  // repeats via the loop-guard (SEC-11) — so the live MR-01 accumulation is unchanged (I1).
  const resumedFirstTurnSeen = new Set<string>();

  // HI-01 (165-REVIEW): the closure-local "spend ceiling already breached" marker — the
  // dedupe that breaks the re-escalation STORM. Pre-fix a breach escalated + returned but left
  // the drive alive + promoted, so the next fd3 wake / backstop tick re-breached + re-escalated
  // forever. A breached session is recorded here so a SINGLE breach yields a SINGLE escalate +
  // a SINGLE stop (the registry evict below) — never one escalate per wake. Mirrors
  // resumedFirstTurnSeen's lifecycle (closure-local, reset on restart).
  const breachedSessions = new Set<string>();

  /** Emit the escalation audit + route the NotifyFn chain (§4.7). Never the prompt text. */
  async function escalate(sessionId: string, owner: PersistedWakeOwner, reason: WokenTurnEscalationReason): Promise<void> {
    deps.eventBus.emit("terminal:escalated", { sessionId, agentId: owner.agentId, reason, timestamp: deps.nowMs() });
    log.warn(
      { sessionId, agentId: owner.agentId, reason, hint: "terminal woken turn escalated to a human (no auto-answer)", errorKind: "precondition" as const, step: "wake_escalate" },
      "terminal woken turn escalated",
    );
    if (deps.notify) {
      // §4.7: a short, redaction-safe, ACTIONABLE human message — the structural reason + how to
      // respond, NEVER the screen (built by buildEscalationMessage from sessionId + reason only).
      await deps.notify({
        agentId: owner.agentId,
        message: buildEscalationMessage(sessionId, reason),
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
    // DRIVE-01 (164-06) — the registry-owner STRIP (the load-bearing fix). The registry
    // resolves a session by its STAMPED owner (`sessionKey:""` for the forcing case); a
    // promoted drive's wake owner carries `drive:<id>` (the FSM/journal/conversation
    // attribution key, from setup-terminal-wake.ts). registryOwnerFor strips that scope back
    // so `status`/`read`/`sendText` resolve the LIVE session (the same allowId/scope/jail —
    // I5: WHERE not WHAT), never the not-found `alive:false` view (the I9-class strand,
    // T-164-19/T-164-23). The drive: scope is used ONLY for the journal keying + the
    // promoted-gate below — never as the registry-authorization owner.
    // ISSUE-3 (live VPS 2026-06-16): recover the session's STAMPED owner — the worker→event
    // re-publish drops the (userId, sessionKey) identity (setup-terminal-tools.ts emits agentId
    // only), so `owner` is (realAgentId, "") and a channel/API drive (stamped under
    // (userId, nonEmptyKey)) would degrade to the not-found view on every status/read/sendText.
    // registry.getOwner is the daemon's trusted recovery seam; registryOwnerFor(owner) is the
    // fallback for the forcing use case (sessionKey:"") and a registry double without getOwner.
    const ownerObj = registry.getOwner?.(sessionId) ?? registryOwnerFor(owner);
    // IN-03: derive `promoted` from the SAME total accessor the registry-owner strip uses
    // (isDriveScoped), not a raw `owner.sessionKey.startsWith(...)` — uniform defensiveness
    // (a degenerate owner narrows to unpromoted, never a TypeError that strands the turn).
    const promoted = isDriveScoped(owner);

    // ENDURE-01 (165-07) / HI-01 (165-REVIEW): the SPEND CEILING — checked FIRST on a promoted
    // turn so a breach pre-empts any further work (no status/read/answer). Reads the journal's
    // HONEST run-total costUsd (I6 — never a fabricated cost; it is 0 at the canned-keystroke
    // seam today) and runs the pure checkSpendCeiling over the operator ceiling.
    if (promoted && deps.journal) {
      // HI-01: a session already breached this life is STOPPED — return immediately (no
      // re-escalate, no re-work). This is the dedupe that breaks the re-escalation storm (the
      // stop below should already have evicted it, but a concurrent in-flight wake is caught here).
      if (breachedSessions.has(sessionId)) return;
      const costUsd = deps.journal.get(sessionId)?.costUsd ?? 0;
      if (checkSpendCeiling(costUsd, deps.maxCostUsd ?? null)) {
        breachedSessions.add(sessionId); // record FIRST so a re-entrant wake cannot double-escalate.
        // Escalate ONCE. The structural escalation reuses the existing escalate() path;
        // `no_safe_match` is the closest reason in the SHIPPED terminal:escalated enum (widening
        // it pairs with the future spend producer — 165-REVIEW LO-02); the SPEND specifics ride
        // the dedicated §2.7 WARN below (the authoritative breach record from logs+events).
        await escalate(sessionId, owner, "no_safe_match");
        // HI-01: actually STOP the drive, not just the turn — evict via the registry so the
        // descriptor + journal lifecycle + the holder's de-promote run (terminal:session_evicted
        // → onSessionGone). Without this the next wake re-breaches forever. `max_interactions` is
        // the closest EvictReason (a deliberate cap-stop); the spend figure rides the WARN.
        await registry.evict(sessionId, ownerObj, "max_interactions");
        log.warn(
          { sessionId, agentId: owner.agentId, costUsd, maxCostUsd: deps.maxCostUsd, hint: `terminal drive spend ceiling reached ($${costUsd} > $${deps.maxCostUsd}); the drive is STOPPED (evicted) + escalated to a human (never a silent overspend, never a re-escalation storm)`, errorKind: "resource" as const, step: "spend_ceiling" },
          "terminal drive spend ceiling breached; stopping the drive",
        );
        return; // STOP — do not status/read/answer (never a silent overspend).
      }
    }

    // (1) session_status — the §4.4 turn start (owner-scoped; the classifier perception).
    const status = await registry.status(sessionId, ownerObj);

    // (2) read the screen (owner-scoped; redacted + wrapped as untrusted at the tool layer —
    //     here the screen feeds the SAFE-ONLY allowlist policy, never trusted as instruction).
    const view = await registry.read(sessionId, ownerObj, { format: "text" });
    const screen = view.screen ?? "";

    // MR-01 (DRIVE-01 / §7.1.6): the cumulative drive duration the journal records as
    // `elapsedMs` — `now - the drive's first-promoted-wake start`. Defensive: a missing
    // accessor, or a non-finite / future start (a degenerate / late-stamped value), falls
    // back to THIS turn's start so elapsedMs is always a sane non-negative number, never a
    // throw and never negative (the journal field is content-free — a duration, not content).
    const computeElapsedMs = (): number => {
      const startedAt = deps.driveStartMs?.(sessionId);
      const base = typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt <= startMs ? startedAt : startMs;
      return Math.max(0, deps.nowMs() - base);
    };

    // DRIVE-01 (164-06) + MR-01: the bounded content-free journal — the PROMOTED drive's
    // cross-wake memory. recordJournal reads-or-inits the per-session journal, sets the redacted
    // lastScreenDigest (I3) + lastClassification + the cumulative elapsedMs (MR-01), bumps
    // interactions, appends a content-free step tag for the action taken (never a keystroke),
    // and — on a delivered safe answer (`answeredPatternIndex` present) — appends the
    // content-free matched-pattern identity to answeredPrompts (MR-01: the "resume without
    // re-answering" dedup substrate; a `pattern:<index>` id, NEVER the prompt text — I3). Gated
    // on `promoted` (an unpromoted turn touches no journal — I1) + a present store. Wrapped
    // never-throw: a journal fault logs (step:journal_update) + the turn still completes (the
    // FSM contract).
    //
    // costUsd is deliberately left at 0 here: the woken-turn auto-answer is a CANNED keystroke
    // (no LLM completion), so there is no spend signal at this seam. The field stays reserved
    // for a seam that has one (a future LLM-in-the-loop drive turn / Phase 165 spend ceiling);
    // until then 0 is the honest value (I6 — never a fabricated cost).
    const recordJournal = (
      stepTag: "answered" | "escalated" | "waited" | "loop",
      answeredPatternIndex?: number,
    ): void => {
      if (!promoted || !deps.journal) return;
      try {
        const current = deps.journal.get(sessionId) ?? emptyJournal(sessionId);
        // The digest line is content-free by construction (counts/coords + a SHORT excerpt);
        // run the excerpt through the canonical redactor before it lands on the journal (I3).
        const { text: redactedDigest } = scrubSecretsFromText(
          screenDigestLine({ screen, cols: view.cols, rows: view.rows, cursor: view.cursor, diff: view.diff }),
        );
        const updated = updateJournal(current, {
          lastClassification: status.state,
          lastScreenDigest: redactedDigest,
          interactions: current.interactions + 1,
          elapsedMs: computeElapsedMs(),
        });
        const withStep = appendStep(updated, stepTag);
        // MR-01: a delivered safe answer records WHICH pattern it answered (content-free id),
        // so a resumed drive can skip an already-answered prompt. The skills journal clamps +
        // caps this opaquely (I3/I7).
        const next =
          typeof answeredPatternIndex === "number"
            ? appendAnswered(withStep, `pattern:${answeredPatternIndex}`)
            : withStep;
        deps.journal.set(sessionId, next);
      } catch (err) {
        log.warn(
          { sessionId, agentId: owner.agentId, err, hint: "drive journal update failed; the woken turn still completed (the journal is best-effort cross-wake memory)", errorKind: "resource" as const, step: "journal_update" },
          "terminal woken turn: journal update failed",
        );
      }
    };

    // (3) decide — safe-only allowlist (escalate-always gate WINS over any hintPattern).
    const cfg = deps.getTerminalAttentionConfig(owner.agentId);
    if (!cfg) {
      // No operator attention config for this agent ⇒ never auto-answer (the SAFE default).
      recordJournal("escalated");
      await escalate(sessionId, owner, "no_safe_match");
      return;
    }
    const decision = decideAutoAnswer(cfg.autoAnswer, screen, cfg.hintPatterns);

    if (decision.action === "escalate") {
      // A destructive/approval/auth-login prompt OR a non-match — send NOTHING, escalate.
      // (the auto-answer reason is a subset of the bus union; pass it through verbatim).
      recordJournal("escalated");
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
      recordJournal("loop");
      await escalate(sessionId, owner, "loop_detected");
      log.debug(
        { sessionId, agentId: owner.agentId, durationMs: deps.nowMs() - startMs, step: "wake_turn_loop" },
        "terminal woken turn ended (loop detected)",
      );
      return;
    }

    // (4.5) DUR-02 / I10 (165-07): the RESUME-no-re-answer guard. On the FIRST turn this
    // daemon life for a promoted session, if its journal came back from disk having ALREADY
    // answered this matched pattern (the loop-guard ring is cold post-restart, so step 4 cannot
    // catch it), SKIP the re-send — a resumed drive must not re-answer a prompt it answered
    // before the crash (resume, don't re-answer). Pattern-specific (a different answered pattern
    // does not block the current one) + content-free (a `pattern:<idx>` id, never the text, I3).
    // A LIVE drive (journal accumulated THIS life) is governed by the loop-guard above, NOT this
    // guard — so its repeat-answer accumulation is unchanged (I1). The "seen" mark flips AFTER
    // this check so the guard fires at most once per session per life (the resume moment only).
    const firstTurnThisLife = promoted && !resumedFirstTurnSeen.has(sessionId);
    if (promoted) resumedFirstTurnSeen.add(sessionId);
    if (firstTurnThisLife && deps.journal) {
      const resumedJournal = deps.journal.get(sessionId);
      if (resumedJournal?.answeredPrompts.includes(`pattern:${decision.matchedPatternIndex}`)) {
        // Already answered in a prior life → record a content-free waited step + do NOT re-send.
        recordJournal("waited");
        log.info(
          { sessionId, agentId: owner.agentId, matchedPatternIndex: decision.matchedPatternIndex, durationMs: deps.nowMs() - startMs, step: "wake_turn_resume_skip" },
          "terminal woken turn skipped re-answering an already-answered prompt (resume, I10)",
        );
        return;
      }
    }

    // (5) answer — send the canned keystroke via the registry send path + AUDIT every send.
    const text = decision.keys.join("");
    const sent = await registry.sendText(sessionId, ownerObj, { text });
    // WR-05: the audit MUST reflect actual delivery. A degraded send (wedged worker /
    // dropped tmux send-keys — `delivered` falsy) is audited `outcome:"rejected"` and
    // does NOT emit `terminal:auto_answered` (nothing was answered); a delivered send is
    // `attempted` + `auto_answered`. So a keystroke that hit nothing is never logged as
    // a successful answer (§2.7: the failure is reconstructable from logs+events alone).
    const delivered = sent.delivered === true;
    auditAnswer(deps, sessionId, owner.agentId, text, decision.matchedPatternIndex, decision.keys.length, delivered);
    // DRIVE-01 (164-06) + MR-01: record the cross-wake-memory step — `answered` on a delivered
    // safe auto-answer (also appending the content-free matched-pattern id to answeredPrompts,
    // the resume dedup substrate), `waited` when the send did not land (the FSM will re-wake on
    // a fresh frame, and nothing was actually answered → no answeredPrompts entry, WR-05 parity).
    recordJournal(delivered ? "answered" : "waited", delivered ? decision.matchedPatternIndex : undefined);
    if (delivered) {
      log.info(
        { sessionId, agentId: owner.agentId, matchedPatternIndex: decision.matchedPatternIndex, keystrokeCount: decision.keys.length, durationMs: deps.nowMs() - startMs, step: "wake_turn_answered" },
        "terminal woken turn auto-answered a safe prompt",
      );
    } else {
      log.warn(
        { sessionId, agentId: owner.agentId, matchedPatternIndex: decision.matchedPatternIndex, durationMs: deps.nowMs() - startMs, hint: "the safe-pattern keystroke was not delivered (wedged worker / dropped send); a fresh input_needed will re-wake", errorKind: "dependency" as const, step: "wake_turn_send_failed" },
        "terminal woken turn: auto-answer send not delivered",
      );
    }
  };
}

/**
 * Audit one auto-answer (SEC-12 / T-124-27 / WR-05): emit a redacted §2.7 keystroke DEBUG
 * log (`scrubSecretsFromText`) + the redaction-safe `terminal:keystroke` summary (the same
 * shape `enforceSendCapsThenAudit` produces — `redactions` + `byteLength`, never the
 * payload), both tagged with the actual delivery `outcome` (`attempted` when the registry
 * forwarded the keystroke to a live worker, `rejected` when the send degraded — a wedged
 * worker / dropped tmux send-keys). `terminal:auto_answered` (the matched pattern INDEX +
 * keystroke COUNT, never the keystroke) is emitted ONLY on a delivered send — a keystroke
 * that reached nothing did not answer the prompt. The raw keystroke NEVER reaches a log or
 * the bus.
 */
function auditAnswer(
  deps: WokenTurnDriverDeps,
  sessionId: string,
  agentId: string,
  payload: string,
  matchedPatternIndex: number,
  keystrokeCount: number,
  delivered: boolean,
): void {
  const { text: redactedText, redactions } = scrubSecretsFromText(payload);
  const timestamp = deps.nowMs();
  const outcome: "attempted" | "rejected" = delivered ? "attempted" : "rejected";
  deps.logger.debug(
    { sessionId, agentId, redactedText, redactions, outcome, step: "keystroke_audit" },
    "terminal auto-answer keystroke",
  );
  deps.eventBus.emit("terminal:keystroke", {
    sessionId,
    agentId,
    kind: "text",
    redactions,
    byteLength: Buffer.byteLength(redactedText),
    outcome,
    timestamp,
  });
  // A not-delivered send did not answer the prompt — do not claim an auto-answer (WR-05).
  if (delivered) {
    deps.eventBus.emit("terminal:auto_answered", { sessionId, agentId, matchedPatternIndex, keystrokeCount, timestamp });
  }
}
