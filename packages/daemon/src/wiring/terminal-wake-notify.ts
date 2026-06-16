// SPDX-License-Identifier: Apache-2.0
/**
 * The NOTIFY-01 / NOTIFY-02 user-facing outcome+heartbeat EMIT helpers (166-03) — the thin
 * side-effecting glue between the wake holder's content-free signals and the user's channel.
 *
 * Extracted from `setup-terminal-wake.ts` so that file stays well under the 800-line
 * architecture cap (it is at the TIGHT end of the band; `terminal-tools.ts` /
 * `terminal-session-registry.ts` are AT the cap). The PURE decisions live in 166-01's skills
 * siblings (`mapTerminalOutcome` / `shouldNotifyOutcome` / `heartbeatLine`); this module
 * performs the already-decided emit through INJECTED seams — mirroring the
 * `terminal-drive-promote.ts` `emitDrivePromoted` precedent (a STRUCTURAL deps interface, not
 * the full holder deps, so the helper is unit-testable + the holder stays thin).
 *
 * Two helpers:
 *   - {@link emitTerminalOutcome} — derive (via `mapTerminalOutcome`) and emit ONE user-facing
 *     terminal outcome (`done` / `failed`; `needs-you` is emitted by the existing escalate()
 *     path, NEVER routed here — I4), gated by `shouldNotifyOutcome(outcome, policy)`, with the
 *     §2.7 record (INFO for `done`, WARN + hint + errorKind for `failed`). The message is
 *     STRUCTURAL only (sessionId + outcome enum + durationMs + interactions + capName) —
 *     NEVER the screen (I3).
 *   - {@link runHeartbeatTick} — the NOTIFY-02 per-tick heartbeat loop body the holder's coarse
 *     timer calls: for each PROMOTED session due at the cadence, emit the content-free
 *     `heartbeatLine` digest + an INFO record, stamping `lastHeartbeatSentMs`. Kept here (not
 *     inlined in the holder) per the extraction directive.
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style, mirrors `emitDrivePromoted`):
 *   - The I/O rides EXCLUSIVELY through the injected `notify` / `info` / `warn` / `nowMs` seams
 *     — no value-imported bus/logger, no raw clock (the globals + infra-runtime-scope gates).
 *   - TOTAL / fire-and-forget: a `notify` rejection is swallowed to a WARN (a notify fault on a
 *     synchronous bus listener must never become an uncaughtException that crashes the daemon).
 *   - CONTENT-FREE (I3): every message is structural counts/durations + the already-redacted
 *     `lastScreenDigest` (formatted by `heartbeatLine`, never re-expanded) — never raw TUI bytes.
 *
 * @module
 */

import { mapTerminalOutcome, shouldNotifyOutcome, heartbeatLine, type NotifyPolicy, type EvictReason, type DriveJournal } from "@comis/skills/tools";

import type { WokenTurnNotify } from "./terminal-wake-turn.js";

/**
 * The narrow structural surface {@link emitTerminalOutcome} + {@link runHeartbeatTick} hand
 * their I/O to (a `Pick`-style contract, not the full `SetupTerminalWakeDeps`). The holder
 * binds these to its injected `notify` chain + the bound child logger + its clock + the
 * resolved `drive.notify` policy. `notify` is optional (a sync-API channel with no notify
 * callback → the outcome rides the turn result as today, I1).
 */
export interface TerminalNotifyDeps {
  /** The §4.7 channel notify chain (`bgNotifyFn` → NotificationService). Absent ⇒ bus-only (I1). */
  notify?: WokenTurnNotify;
  /** A pino-compatible INFO sink (the content-free §2.7 record for `done` / a heartbeat). */
  info(obj: Record<string, unknown>, msg: string): void;
  /** A pino-compatible WARN sink (the §2.7 record for `failed` — hint + errorKind). */
  warn(obj: Record<string, unknown>, msg: string): void;
  /** Injected clock (no raw wall-clock global). */
  nowMs(): number;
  /** The operator `drive.notify` policy — the gate `shouldNotifyOutcome` reads. */
  policy: NotifyPolicy;
}

/** The content-free outcome the holder derived from a state transition (DUR-02 / NOTIFY-01). */
export interface TerminalOutcomeArgs {
  readonly sessionId: string;
  readonly agentId: string;
  /**
   * The transition the holder observed — `exited` (clean PTY exit → done) or a genuine death:
   * `lost` (durable + unrecoverable → failed) / `evicted` (a NAMED cap → failed naming the cap).
   * `needs-you` is NEVER passed here (the existing escalate() path owns it — I4).
   */
  readonly transition: "exited" | "lost" | "evicted";
  /** Present ONLY for `evicted` — the named cap the reaper tripped (the dropped-reason fix). */
  readonly capName?: EvictReason | undefined;
  /** The captured cumulative drive duration (`nowMs - driveStartedAtMs`), captured before clear. */
  readonly durationMs?: number | undefined;
  /** The captured journal interaction count, captured before onSessionGone cleared the journal. */
  readonly interactions?: number | undefined;
}

/**
 * Derive + emit ONE user-facing terminal outcome (`done` / `failed`) for a PROMOTED drive —
 * NOTIFY-01. Lands the `failed` outcome deferred from Phase 165.
 *
 * The outcome is derived via the pure {@link mapTerminalOutcome} (the I9-safe map): `exited` →
 * `done`; `lost`/`evicted` set `failure` → `failed`. The notify is gated by
 * {@link shouldNotifyOutcome} (so `done`/`failed` are suppressed under `drive.notify:"none"`).
 * The §2.7 record fires REGARDLESS of the gate (an operator who silenced the channel still gets
 * the log) — INFO for `done`, WARN + hint + errorKind for `failed`. The channel message is
 * STRUCTURAL only (I3): sessionId + the outcome enum + durationMs + interactions + capName,
 * NEVER the screen.
 *
 * Fire-and-forget + total: a `notify` rejection is swallowed to a WARN; never throws.
 *
 * @param deps - The injected notify/log/clock/policy seams.
 * @param args - The content-free outcome the holder captured before onSessionGone.
 */
export function emitTerminalOutcome(deps: TerminalNotifyDeps, args: TerminalOutcomeArgs): void {
  // Build the I9-safe outcome inputs: a clean exit → done; a genuine death → failed.
  // capName present ⇒ a NAMED cap-eviction (errorKind resource); else a lost ⇒ unrecoverable
  // (errorKind dependency). `needs-you` never reaches here (the escalate() path owns it — I4).
  const failure =
    args.transition === "lost"
      ? ({ kind: "unrecoverable", reason: "session_lost" } as const)
      : args.transition === "evicted"
        ? ({ kind: "cap", cap: args.capName ?? "max_sessions" } as const)
        : undefined;
  const outcome = mapTerminalOutcome({ classifier: args.transition === "exited" ? "exited" : "stuck", ...(failure ? { failure } : {}) });
  // The map yields undefined only for the silent middle — which this caller never produces
  // (it is invoked solely on a terminal transition). Defensive: nothing to emit ⇒ return.
  if (outcome === undefined) return;
  // needs-you must never be routed through this gate (I4). This caller never passes it, but
  // guard defensively so a future caller cannot regress the escalate-always invariant here.
  if (outcome === "needs-you") return;

  const errorKind = failure?.kind === "cap" ? ("resource" as const) : ("dependency" as const);

  // The §2.7 record — fires regardless of the channel gate (the log is the operator's floor).
  if (outcome === "done") {
    deps.info(
      { sessionId: args.sessionId, agentId: args.agentId, outcome, durationMs: args.durationMs, interactions: args.interactions, step: "drive_outcome" },
      "terminal drive completed (done)",
    );
  } else {
    deps.warn(
      {
        sessionId: args.sessionId,
        agentId: args.agentId,
        outcome,
        errorKind,
        ...(args.capName !== undefined ? { capName: args.capName } : {}),
        durationMs: args.durationMs,
        interactions: args.interactions,
        hint:
          failure?.kind === "cap"
            ? `the terminal drive hit the ${args.capName} cap and was evicted; surface it to the user as a deliberate bound, not a crash`
            : "the terminal drive's session was lost and could not be recovered; the journal is preserved for a fresh drive to resume",
        step: "drive_outcome",
      },
      "terminal drive failed",
    );
  }

  // The user-facing channel notify — gated by drive.notify (done/failed suppressed under
  // "none"; needs-you would always pass but never reaches here). STRUCTURAL message only (I3).
  if (!deps.notify) return; // bus-only channel (no notify callback) → the log above is the record (I1).
  if (!shouldNotifyOutcome(outcome, deps.policy)) return;
  const message =
    outcome === "done"
      ? `Terminal drive for session ${args.sessionId} completed (done)${describeTail(args)}.`
      : `Terminal drive for session ${args.sessionId} failed${args.capName !== undefined ? ` (${args.capName})` : ""}${describeTail(args)}.`;
  void deps
    .notify({ agentId: args.agentId, message, priority: "normal", origin: "background_task" })
    .catch((err: unknown) => {
      deps.warn(
        { sessionId: args.sessionId, agentId: args.agentId, err, outcome, hint: "drive-outcome notification failed; the drive lifecycle is unaffected (bus-only)", errorKind: "resource" as const, step: "drive_outcome_notify_failed" },
        "terminal drive-outcome notification failed",
      );
    });
}

/** A content-free tail for the outcome message — durations/counts only, never the screen (I3). */
function describeTail(args: TerminalOutcomeArgs): string {
  const parts: string[] = [];
  if (typeof args.durationMs === "number" && Number.isFinite(args.durationMs) && args.durationMs > 0) {
    parts.push(`elapsed ${(args.durationMs / 3_600_000).toFixed(1)}h`);
  }
  if (typeof args.interactions === "number" && Number.isFinite(args.interactions) && args.interactions > 0) {
    parts.push(`${Math.floor(args.interactions)} interactions`);
  }
  return parts.length > 0 ? ` — ${parts.join(", ")}` : "";
}

/** The per-session read-only views + the dedupe-stamp Map the heartbeat tick reads/writes. */
export interface HeartbeatTickArgs {
  /** The promoted-session set (I1 — only promoted drives are heartbeated). */
  readonly promotedSessions: ReadonlySet<string>;
  /** The per-session content-free journal holder (the digest source). */
  readonly driveJournals: ReadonlyMap<string, DriveJournal>;
  /** The per-session owning agent (the notify target). */
  readonly sessionAgent: ReadonlyMap<string, string>;
  /** The per-session last-heartbeat-sent dedupe stamp (mutated here). */
  readonly lastHeartbeatSentMs: Map<string, number>;
  /** The injected notify chain (the holder only arms the timer when this is present). */
  readonly notify: WokenTurnNotify;
  /** A pino-compatible INFO sink (the content-free §2.7 heartbeat record). */
  info(obj: Record<string, unknown>, msg: string): void;
  /** A pino-compatible WARN sink (a notify-fault record). */
  warn(obj: Record<string, unknown>, msg: string): void;
  /** Injected clock (no raw wall-clock global). */
  nowMs(): number;
  /** The coarse user-facing heartbeat cadence (`drive.heartbeatNotifyMs`). */
  readonly heartbeatNotifyMs: number;
}

/**
 * The NOTIFY-02 per-tick heartbeat loop body — the holder's coarse timer calls this each tick.
 * For each PROMOTED session (I1 — only long drives) that is DUE at the cadence (`now -
 * lastHeartbeatSentMs >= heartbeatNotifyMs`), emit the content-free {@link heartbeatLine}
 * digest + an INFO §2.7 record, then stamp `lastHeartbeatSentMs`. A just-promoted drive with
 * no journal yet yields a safe "(no activity yet)" line (heartbeatLine is total). Fire-and-
 * forget per session (a notify fault degrades to a WARN this tick); never throws out of the loop.
 *
 * @param args - The read-only per-session views + the mutable dedupe-stamp Map + the seams.
 */
export function runHeartbeatTick(args: HeartbeatTickArgs): void {
  const now = args.nowMs();
  // Snapshot the promoted set (a notify-triggered flow could mutate it mid-tick).
  for (const sessionId of [...args.promotedSessions]) {
    const last = args.lastHeartbeatSentMs.get(sessionId) ?? 0;
    if (now - last < args.heartbeatNotifyMs) continue; // not due yet (coarse cadence + dedupe).
    const agentId = args.sessionAgent.get(sessionId) ?? "";
    const j = args.driveJournals.get(sessionId);
    // The content-free digest — heartbeatLine is total (a missing journal → a safe line, I3).
    const message = heartbeatLine(j ?? { elapsedMs: 0, lastScreenDigest: "", interactions: 0, costUsd: 0 });
    // Stamp BEFORE the async notify so a fault does not cause a re-fire storm next tick.
    args.lastHeartbeatSentMs.set(sessionId, now);
    args.info(
      { sessionId, agentId, elapsedMs: j?.elapsedMs, interactions: j?.interactions, step: "drive_heartbeat" },
      "terminal drive heartbeat",
    );
    void args
      .notify({ agentId, message, priority: "normal", origin: "background_task" })
      .catch((err: unknown) => {
        args.warn(
          { sessionId, agentId, err, hint: "drive heartbeat notification failed; the drive continues (bus-only)", errorKind: "resource" as const, step: "drive_heartbeat_notify_failed" },
          "terminal drive heartbeat notification failed",
        );
      });
  }
}
