// SPDX-License-Identifier: Apache-2.0
/**
 * Outcome-signal (Verified Learning WS1) write-back wiring.
 *
 * The composition-root glue between the deterministic tool/pipeline completion
 * bus events (`tool:executed`, `graph:completed`, `graph:driver_lifecycle`) and
 * the `OutcomeSignalPort` (the @comis/memory adapter). The daemon is the ONLY
 * place holding BOTH the bus AND the adapter — the agent↛memory build cut means
 * the agent emits ids+counts on the bus and the daemon does the observe/resolve.
 * Mirrors `wireMemoryUsefulness` (setup-memory-usefulness-wiring.ts). Counts + ids
 * + closed-enums ONLY ever cross the bus (AGENTS.md §2.7 / SEC-01) — never bodies.
 *
 * BYTE-IDENTITY GATE (P0): every handler's FIRST statement is the
 * `learningOutcomeEnabled(agentId)` short-circuit. With the default config
 * (`learningOutcome.enabled:false`, or the master `memory.costFeatures.enabled:false`
 * force-disable) the subscriber observes/resolves/emits NOTHING — the recall/score
 * hot path (`score.ts`/`scoring-overlay.ts`, untouched in P0) is byte-identical.
 *
 * Fire-and-forget / non-fatal: a failing or slow `observe`/`resolve` warns and
 * continues; it NEVER throws out of the bus handler and never blocks the turn
 * (the turn already completed). The `unknown` resolved outcome derives no
 * learning (fail-closed, OUTCOME-05) and is NOT counted as resolved coverage.
 *
 * @module
 */

import {
  tryGetContext,
  type TypedEventBus,
  type OutcomeSignalPort,
  type ClockPort,
  type ComisLogger,
  type AppConfig,
} from "@comis/core";

import { deriveTenantFromSessionKey } from "./setup-memory-usefulness-wiring.js";

/** Dependencies for {@link wireLearningOutcome}. */
export interface LearningOutcomeWiringDeps {
  /** The daemon's typed event bus (source of the tool/graph completion events). */
  eventBus: TypedEventBus;
  /** The sole @comis/memory adapter for the outcome port (the observe/resolve target). */
  outcomeStore: OutcomeSignalPort;
  /** Injected clock for `observedAt` — the deterministic time source (no ambient wall clock). */
  clock: ClockPort;
  /** Structured logger for the OBS-01 INFO completion line + the non-fatal failure WARN. */
  logger: ComisLogger;
  /**
   * Per-agent effective enable: true ONLY when the agent has
   * `learningOutcome.enabled` AND the master `memory.costFeatures.enabled` switch
   * is on. Default-OFF (no agent opts in) → the subscriber is a no-op.
   */
  learningOutcomeEnabled: (agentId: string) => boolean;
}

/** High-confidence default for a clean deterministic tool/pipeline signal. */
const DETERMINISTIC_CONFIDENCE = 0.9;
/** Slightly lower confidence for a content/detector-classified (non-transport) tool failure. */
const CLASSIFIED_FAILURE_CONFIDENCE = 0.8;

/** A resolved outcome scope keyed off the event/ALS context. */
interface OutcomeScope {
  tenantId: string;
  agentId: string;
  sessionId: string;
  trajectoryId: string;
}

/**
 * Resolve the (tenant, agent, session, trajectory) scope for an observation.
 *
 * The deterministic tool event carries `agentId`/`traceId`/`sessionKey` on its
 * payload; the graph completion events do NOT (only `graphId`), so their scope is
 * recovered from the ambient request context (AsyncLocalStorage). Payload fields
 * win when present; ALS is the fallback. Returns `undefined` when neither source
 * yields an agentId AND a trajectory identity (we cannot scope/attribute then) —
 * the caller skips. The tenant defaults to "default" only when absent; the agentId
 * is NEVER collapsed across agents (cross-agent isolation, T-198-16).
 */
function resolveScope(payload: {
  agentId?: string;
  traceId?: string;
  sessionKey?: string;
}): OutcomeScope | undefined {
  const ctx = tryGetContext();
  const agentId = payload.agentId ?? ctx?.agentId;
  const trajectoryId = payload.traceId ?? ctx?.traceId;
  if (agentId === undefined || agentId.length === 0) return undefined;
  if (trajectoryId === undefined || trajectoryId.length === 0) return undefined;
  const sessionKey = payload.sessionKey ?? ctx?.sessionKey;
  const tenantId = deriveTenantFromSessionKey(sessionKey) ?? ctx?.tenantId ?? "default";
  // sessionId is the conversation identity; the events carry sessionKey (not a
  // distinct sessionId). Use sessionKey when present, else fall back to the
  // trajectory identity (a stable, scope-consistent key).
  const sessionId = sessionKey ?? trajectoryId;
  return { tenantId, agentId, sessionId, trajectoryId };
}

/**
 * Persist one raw observation, fire-and-forget / non-fatal. NEVER throws out of
 * the bus handler. Counts/ids/closed-enums only ever reach the store.
 */
function observeNonFatal(
  deps: LearningOutcomeWiringDeps,
  scope: OutcomeScope,
  outcome: "success" | "failure",
  source: "tool" | "pipeline",
  confidence: number,
): Promise<void> {
  return deps.outcomeStore
    .observe({
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      trajectoryId: scope.trajectoryId,
      outcome,
      source,
      confidence,
      observedAt: deps.clock.now(),
    })
    .then((r) => {
      if (!r.ok) {
        deps.logger.warn(
          {
            agentId: scope.agentId,
            source,
            errorKind: "internal" as const,
            hint: "outcome observe failed; the outcome signal was not persisted for this trajectory",
          },
          "outcome observe failed (non-fatal)",
        );
      }
    })
    .catch((e: unknown) => {
      deps.logger.warn(
        {
          agentId: scope.agentId,
          source,
          err: e instanceof Error ? e : new Error(String(e)),
          errorKind: "internal" as const,
          hint: "outcome observe threw; the outcome signal was not persisted for this trajectory",
        },
        "outcome observe threw (non-fatal)",
      );
    });
}

/**
 * Stand up the deterministic tool/pipeline → observe/resolve subscriber on the
 * daemon's bus. Fire-and-forget / non-fatal; default-OFF via `learningOutcomeEnabled`.
 *
 * Wiring:
 *  - `tool:executed`            → observe a `tool` outcome (`success===false` → failure).
 *  - `graph:driver_lifecycle`   → observe a `pipeline` outcome on a terminal driver phase.
 *  - `graph:completed`          → observe a `pipeline` outcome (status `completed` → success,
 *                                 else failure) AND, as the trajectory-completion signal,
 *                                 resolve the fused verdict, emit `learning:outcome_observed`
 *                                 (counts/ids only), and update coverage telemetry.
 *
 * Coverage telemetry: a daemon-lifetime gauge of % finished trajectories with a
 * RESOLVABLE outcome. `total` increments per completion; `resolved` increments
 * ONLY when the fused outcome is NOT `unknown` (fail-closed, T-198-18) — a
 * no-signal trajectory is visibly unresolved.
 */
export function wireLearningOutcome(deps: LearningOutcomeWiringDeps): void {
  // Daemon-lifetime coverage gauge (resets on restart). Counts only.
  let total = 0;
  let resolved = 0;

  // ---- Deterministic tool signal (the only source that ships ACTIVE, OUTCOME-03) ----
  deps.eventBus.on("tool:executed", (p) => {
    // Byte-identity short-circuit (default OFF) — observe NOTHING.
    const agentId = p.agentId ?? tryGetContext()?.agentId;
    if (agentId === undefined || !deps.learningOutcomeEnabled(agentId)) return;

    const scope = resolveScope(p);
    if (scope === undefined) return;

    // The failure signal is the real `success` boolean field. A transport-level
    // / sdk_iserror failure is the highest-confidence deterministic signal; a
    // content/detector/mcp-classified failure is still a failure at a slightly
    // lower confidence (the fusion still ranks tool above judge regardless).
    const outcome: "success" | "failure" = p.success === false ? "failure" : "success";
    const confidence =
      outcome === "failure" && p.transportOk !== false && p.classifiedFailureBy !== "sdk_iserror"
        ? CLASSIFIED_FAILURE_CONFIDENCE
        : DETERMINISTIC_CONFIDENCE;

    void observeNonFatal(deps, scope, outcome, "tool", confidence);
  });

  // ---- Deterministic pipeline signal: a node driver reached a terminal phase ----
  deps.eventBus.on("graph:driver_lifecycle", (p) => {
    // Only the terminal phases carry an outcome; progress/initialized are no-ops.
    if (p.phase !== "completed" && p.phase !== "failed" && p.phase !== "aborted") return;

    const ctx = tryGetContext();
    const agentId = ctx?.agentId;
    if (agentId === undefined || !deps.learningOutcomeEnabled(agentId)) return;

    // The driver lifecycle payload carries no scope — recover it from ALS.
    const scope = resolveScope({});
    if (scope === undefined) return;

    const outcome: "success" | "failure" = p.phase === "completed" ? "success" : "failure";
    void observeNonFatal(deps, scope, outcome, "pipeline", DETERMINISTIC_CONFIDENCE);
  });

  // ---- Deterministic pipeline signal + trajectory-completion resolve/emit ----
  deps.eventBus.on("graph:completed", (p) => {
    const ctx = tryGetContext();
    const agentId = ctx?.agentId;
    if (agentId === undefined || !deps.learningOutcomeEnabled(agentId)) return;

    // graph:completed carries only graphId — recover the scope from ALS.
    const scope = resolveScope({});
    if (scope === undefined) return;

    // Success ONLY on a CLEAN completion; failed/cancelled/running → failure
    // (the real GraphStatus field is the signal — gated on an exact "completed").
    const outcome: "success" | "failure" = p.status === "completed" ? "success" : "failure";
    const resolveStart = deps.clock.now();

    // Observe the pipeline outcome FIRST, then resolve the fused verdict (so the
    // just-written row is visible) and emit. The whole chain is fire-and-forget /
    // non-fatal — it never throws out of the handler.
    void observeNonFatal(deps, scope, outcome, "pipeline", DETERMINISTIC_CONFIDENCE)
      .then(() => deps.outcomeStore.resolve(scope.trajectoryId, { tenantId: scope.tenantId, agentId: scope.agentId }))
      .then((r) => {
        total += 1;
        if (!r.ok) {
          deps.logger.warn(
            {
              agentId: scope.agentId,
              errorKind: "internal" as const,
              hint: "outcome resolve failed; no learning:outcome_observed emitted for this trajectory",
            },
            "outcome resolve failed (non-fatal)",
          );
          return;
        }
        const verdict = r.value;
        // Fail-closed coverage: an `unknown` verdict is NOT counted as resolved.
        if (verdict.outcome !== "unknown") resolved += 1;

        // Emit the resolved outcome (counts/ids/closed-enums ONLY — plain emit so it
        // lands on the trajectory and is type-checked; bridged for comis explain).
        deps.eventBus.emit("learning:outcome_observed", {
          agentId: scope.agentId,
          traceId: scope.trajectoryId,
          trajectoryId: scope.trajectoryId,
          outcome: verdict.outcome,
          source: verdict.sources[0] ?? "pipeline",
          confidence: verdict.confidence,
          timestamp: deps.clock.now(),
        });

        // OBS-01: one INFO completion line per resolve with durationMs + the running
        // coverage gauge; a step-tagged DEBUG for the pipeline stage.
        deps.logger.info(
          {
            agentId: scope.agentId,
            outcome: verdict.outcome,
            resolvedCount: resolved,
            totalCount: total,
            durationMs: deps.clock.now() - resolveStart,
          },
          "Outcome resolved for trajectory",
        );
        deps.logger.debug(
          { agentId: scope.agentId, step: "outcome-resolve", sources: verdict.sources },
          "outcome resolve detail",
        );
      })
      .catch((e: unknown) => {
        deps.logger.warn(
          {
            agentId: scope.agentId,
            err: e instanceof Error ? e : new Error(String(e)),
            errorKind: "internal" as const,
            hint: "outcome resolve/emit threw; no learning:outcome_observed emitted for this trajectory",
          },
          "outcome resolve threw (non-fatal)",
        );
      });
  });
}

/** Dependencies for {@link setupLearningOutcomeWiring}. */
export interface SetupLearningOutcomeDeps {
  eventBus: TypedEventBus;
  outcomeStore: OutcomeSignalPort;
  clock: ClockPort;
  logger: ComisLogger;
  /** The parsed app config — the source of the master cost switch + per-agent flag. */
  config: AppConfig;
}

/**
 * Composition helper: compute the per-agent BYTE-IDENTITY enable gate from the
 * parsed config and stand up {@link wireLearningOutcome}.
 *
 * The gate force-disables on the master cost switch
 * (`memory.costFeatures.enabled !== false` — exactly like the six cost crons,
 * OUTCOME-09) AND requires the agent's own `learningOutcome.enabled` (default OFF).
 * With the default config the gate is `false` for every agent → the subscriber
 * observes/resolves/emits NOTHING → ranking/recall/replies are byte-identical.
 */
export function setupLearningOutcomeWiring(deps: SetupLearningOutcomeDeps): void {
  // Master cost kill-switch: read defensively (`!== false`) so an absent block
  // fails OPEN to the per-agent flag rather than silently force-disabling.
  const costFeaturesEnabled = deps.config.memory?.costFeatures?.enabled !== false;
  // Hoist the typed agents map once (mirrors setup-schedulers.ts:107) so the per-agent
  // lookup is a bracket access on a known Record (not a dynamic optional-chain sink).
  const agents = deps.config.agents ?? {};
  wireLearningOutcome({
    eventBus: deps.eventBus,
    outcomeStore: deps.outcomeStore,
    clock: deps.clock,
    logger: deps.logger,
    learningOutcomeEnabled: (agentId: string): boolean =>
      costFeaturesEnabled && agents[agentId]?.learningOutcome?.enabled === true,
  });
}
