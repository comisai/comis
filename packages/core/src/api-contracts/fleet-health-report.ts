// SPDX-License-Identifier: Apache-2.0
/**
 * The `obs.fleet.health` wire shape — the cross-session
 * fleet-health digest. DISTINCT from the per-session `IncidentReport`
 * (`incident-report.ts`): this rolls up a WINDOW of sessions, not one session.
 *
 * Bounded/digest-only/deterministic: capped top-N findings + merged
 * `errorKinds`, counts + hints ONLY (no raw WARN bodies), a deterministic
 * `likelyRootCause`-style verdict, an honest `truncations[]` ledger, and a
 * `coverage` honesty block (which fleet sources were read). Same window → same
 * verdict: the report root carries NO wall-clock field (the `IncidentReport`
 * precedent has none either) — `windowHours` is the only time reference.
 *
 * This module declares the SCHEMA + the RPC contract. The bounding pass (mirror
 * `obs-explain-bound.ts`) and the heuristic registry (mirror
 * `obs-explain-heuristics.ts`) that POPULATE `likelyRootCause` + `truncations`
 * live in the daemon handler — the schema is SHAPED
 * (arrays-of-bounded-records + `truncations[]` + digestible scalars) so they
 * apply. Barrel re-exported via `observability.ts`, which also registers
 * {@link ObsFleetHealthContract} in `OBSERVABILITY_CONTRACTS`.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

/**
 * The `obs.fleet.health` response — a bounded cross-session fleet digest.
 *
 * `z.object` (NOT `z.strictObject`) so the optional `coverage` block stays
 * additive at `schemaVersion: 1` (the `IncidentReport` precedent). Unknown keys
 * are stripped on parse — a caller cannot smuggle a wall-clock field through.
 */
export const FleetHealthReportSchema = z.object({
  schemaVersion: z.literal(1),
  /** The aggregation window (the ONLY time reference — no wall-clock root field). */
  windowHours: z.number(),
  sessions: z.object({
    total: z.number(),
    degraded: z.number(),
    degradedRate: z.number(),
    /**
     * Of `degraded`, how many finished `completed_with_tool_errors` — the model
     * DELIVERED a final answer despite a (recovered/acknowledged) tool error. The
     * degradation FINDINGS fire on the HARD count (`degraded −
     * deliveredWithToolErrors`) so a fleet of self-healed tool hiccups does not
     * read as a false "N% degraded" alarm; this field makes the split explicit for
     * a JSON consumer / the CLI. Optional (additive; pre-existing readers ignore it).
     */
    deliveredWithToolErrors: z.number().optional(),
  }),
  /** Merged across the window + capped top-N (counts only — no raw bodies). */
  topErrorKinds: z.array(z.object({ kind: z.string(), count: z.number() })),
  /**
   * The fleet-level degradation detector: degraded session COUNTS
   * bucketed by the named `endReason` cause ("N degraded by context_exhausted, M
   * by output_starved"). ONLY degraded sessions contribute; a missing/blank cause
   * folds into `"unknown"`. Bounded (capped top-N, counts only — no raw bodies)
   * and deterministic, computed by `reduceFleetWindow` from the per-session row's
   * `endReason`. Required (the assembler always emits it, possibly `{}`).
   */
  degradedByCause: z.record(z.string(), z.number()),
  breakerTripTotal: z.number(),
  /** Bounded key set (per-tool ok/failed rollup) — mirrors `IncidentReport.toolStats`. */
  toolStats: z.record(z.string(), z.object({ ok: z.number(), failed: z.number() })),
  cost: z.object({
    costUsd: z.number(),
    totalTokens: z.number(),
    /**
     * Off-session (background-job) LLM spend in the window — reflection cron
     * runs et al. that key their token usage to a synthetic `__PREFIX__`
     * session with NO session_summary, so it is ABSENT from `costUsd` (the
     * session-summary rollup). The operator's full provider bill is
     * `costUsd + offSessionUsd`; the two never double-count. The assembler
     * always sets it (0 when no background spend); `optional` so a report from
     * an older producer without the field still parses. Consumers read `?? 0`.
     */
    offSessionUsd: z.number().optional(),
  }),
  activity: z.object({
    activeAgents: z.array(z.string()),
    activeChannels: z.array(z.string()),
    exitReasons: z.record(z.string(), z.number()),
    turnTotal: z.number(),
    tokenTotal: z.number(),
  }),
  /**
   * Capped top-N findings — counts + short codes + hints ONLY (no raw WARN
   * bodies). The bounding pass trims to top-N and records the drop in
   * `truncations[]`. Mirrors the `IncidentReport` digest-only discipline.
   */
  findings: z.array(
    z.object({
      code: z.string(),
      detail: z.string(),
      count: z.number(),
      hint: z.string(),
    }),
  ),
  /**
   * The deterministic report-level verdict — `null` when no heuristic matches.
   * Mirrors `IncidentReport.likelyRootCause` 1:1 (the heuristic
   * registry populates it; PURE, ordered first-match-wins).
   */
  likelyRootCause: z
    .object({
      code: z.string(),
      detail: z.string(),
      suggestedNextSteps: z.array(z.string()),
    })
    .nullable(),
  /** Report-level guidance (independent of the per-verdict steps above). */
  suggestedNextSteps: z.array(z.string()),
  /**
   * The honest size-drop ledger — what the bounding pass shed to
   * stay digest-only/bounded. Mirrors `IncidentReport.truncations[]`.
   */
  truncations: z.array(
    z.object({
      field: z.string(),
      reason: z.string(),
      pointer: z.string().optional(),
    }),
  ),
  /**
   * READ-coverage breadcrumb (meta-observability): which FLEET sources the
   * handler actually located + read. DISTINCT from `truncations[]`
   * (SIZE-drops): `coverage` records whether the INPUTS were read, so a
   * silently-empty fleet report ("0 rows / N days missing") is self-evident
   * instead of masquerading as a clean zero-activity window. Mirrors the
   * `IncidentReport.coverage` pattern (`obs-explain-assemble.ts`). Optional
   * (schemaVersion stays 1) — additive; pre-existing constructors omit it.
   *
   * The shape maps to the fleet aggregates: `sessionSummary` (session-summary
   * store rows), `sessionIndex` (the multi-day index reader's `daysRead`/`daysMissing`),
   * `billing` (present flag for the cost source).
   */
  coverage: z
    .object({
      sessionSummary: z.object({ found: z.boolean(), rows: z.number() }),
      sessionIndex: z.object({ daysRead: z.number(), daysMissing: z.number() }),
      billing: z.object({ present: z.boolean() }),
    })
    .optional(),
  /**
   * The pre-committed pipeline-authoring decision verdict.
   * Optional (schemaVersion stays 1) — additive; pre-existing constructors
   * omit it. Declared INLINE here because core depends only on shared (it cannot
   * import the observability package — that would invert the dep graph + trip the
   * cycle gate); the daemon assigns the observability `PipelineAuthoringVerdict`,
   * structurally `{buildAuthor, reason}`, into this field. Counts/boolean verdict
   * only — no body/secret. Without this field the non-strict z.object STRIPS the
   * verdict on parse, so it never reaches the operator (a tampering hazard — the
   * round-trip test proves it survives).
   */
  pipelineAuthoringGate: z
    .object({ buildAuthor: z.boolean(), reason: z.string() })
    .optional(),
  /**
   * The cross-run AUTONOMY-health slice. Counts + an
   * id ONLY (the worst rootRunId to drill into via `comis explain`) — NO
   * body/reason/secret (the smuggled-key test proves the non-strict z.object
   * strips any extra field). Optional (schemaVersion stays 1) —
   * additive; pre-existing constructors omit it.
   *
   * Sourced from `DurableRunPort.countByStatus` (autonomy runs ARE durable_runs
   * by construction — no synthetic notion, no session-rollup schema change) +
   * the synthetic-excluded `reduceFleetWindow` breaker/cost read-back. The block
   * is ABSENT when the durable store is unwired (e.g. the daemon-less offline
   * CLI) — honest degradation, not a divergence.
   *
   * `costUsd` is the window's autonomy-inclusive operator cost (the
   * synthetic-excluded `fleet.costUsd` read-back — NOT a separate re-derivation
   * over raw rows, which could diverge from the fleet read). A stricter
   * autonomy-only cost is a possible follow-up; an aggregate cost suffices here.
   */
  autonomy: z
    .object({
      runs: z.object({ total: z.number(), degraded: z.number(), degradedRate: z.number() }),
      orphaned: z.number(),
      resumed: z.number(),
      revoked: z.number(),
      killed: z.number(),
      /** The TOOL-FAILURE breaker subset of breakerTripTotal (the synthetic-excluded
       *  session-rollup `breakerTripCount` read-back). DISTINCT from `denialBreakerTrips`
       *  below — the tool-failure breaker and the capability-denial breaker are
       *  separate mechanisms and must not be conflated. */
      breakerTrips: z.number(),
      /**
       * The CAPABILITY-DENIAL breaker trip count — N
       * consecutive floor-blocks aborted + killed an unattended run tree.
       * EVENT-SOURCED from the content-free `autonomy_denial_breaker`
       * health_signal rows, NOT the session-rollup `breakerTripCount`: a
       * denial-breaker abort is NEVER a session endReason and NEVER a
       * breakerTripCount, so `breakerTrips` (the tool-failure read-back) can never
       * see it — and the aborted run lands in durable status 'completed', so it is
       * 0 in orphaned/revoked/killed too. This separable count is the ONLY fleet
       * surface for the denial breaker. Counts
       * only — never the engine's free-text deny reason. The assembler always
       * emits it within the (optional) autonomy block; a `denial_breaker`-aborted
       * run's id can also surface as `worstRootRunId` + an `autonomy_denial_breaker`
       * finding code.
       */
      denialBreakerTrips: z.number(),
      budgetBreaches: z.number(),
      costUsd: z.number(),
      /** The worst autonomy run to drill into via `comis explain`. */
      worstRootRunId: z.string().optional(),
    })
    .optional(),
  /**
   * The cross-session wake-gate EFFICIENCY slice — per-agent
   * skip-rate + turns-saved + tool-call cost, rolled up from the content-free
   * `cron_wake_gate` diagnostic rows. Counts + agent ids ONLY (never the gate's
   * gathered payload / script source / a secret — the smuggled-key test proves
   * the non-strict z.object strips any extra field). Optional (schemaVersion
   * stays 1) — additive; the block is ABSENT when no gated fire happened in the
   * window (honest omit).
   *
   * The two legibility properties this block carries:
   *   - SUPPRESSION: `perAgent[].skipRate == 1.0` is a gate that NEVER wakes the
   *     model — either working hard (savings) OR silently poisoned to suppress a
   *     monitor. Either way it is visible, never silent.
   *   - NET COST: `toolCalls` (the gate's cap-call cost) beside `turnsSaved`
   *     (the avoided model turns) makes a gate that costs more than it saves
   *     legible — the operator compares the two numbers directly.
   */
  cronWakeGate: z
    .object({
      /** Window totals: `total` gated fires, `skipped` (wake===false) fires,
       *  `skipRate = skipped/total`, `failedOpen` (fail-open wakes: crash/timeout/
       *  over-cap/no-verdict) and `failOpenRate = failedOpen/total` (0 when total
       *  is 0). `failOpenRate` is the signal symmetric to a 100% `skipRate`: a
       *  broken gate that fails open every fire saves nothing and costs its own
       *  cap-calls, yet otherwise looks like a healthy always-waking monitor. */
      fires: z.object({
        total: z.number(),
        skipped: z.number(),
        skipRate: z.number(),
        failedOpen: z.number(),
        failOpenRate: z.number(),
      }),
      /** Sum of the derived per-fire `estTurnsSaved` (the avoided model turns). */
      turnsSaved: z.number(),
      /** Sum of the gate's cap-call cost across the window (the net-cost numerator). */
      toolCalls: z.number(),
      /** Per-agent breakdown — the suppression (skipRate), the broken-gate signal
       *  (failOpenRate), and net-cost (toolCalls vs turnsSaved) legibility keyed
       *  by agent id. */
      perAgent: z.array(
        z.object({
          agentId: z.string(),
          fires: z.number(),
          skipped: z.number(),
          skipRate: z.number(),
          failedOpen: z.number(),
          failOpenRate: z.number(),
          turnsSaved: z.number(),
          toolCalls: z.number(),
        }),
      ),
    })
    .optional(),
});

/** The `obs.fleet.health` response (the cross-session fleet digest). Inferred from the Zod schema. */
export type FleetHealthReport = z.infer<typeof FleetHealthReportSchema>;

/**
 * `obs.fleet.health` — the cross-session fleet-health triage RPC.
 * Admin-only; the daemon handler fans the cross-session
 * aggregation + log-derived diagnostics into the {@link FleetHealthReport}
 * digest above. The SIBLING of {@link ObsExplainContract} (`incident-report.ts`):
 * `obs.explain` post-mortems ONE session; this rolls up a WINDOW.
 *
 * Request: `{ sinceHours? }` — ONE optional positive window. NO `.refine()` (no
 * cross-field constraint — `obs.explain` needs one for its neither-id guard, this
 * does not) and NO `.default()` (off the 12-shape allowlist). The 24h window
 * DEFAULT is applied in the handler body — the `ObsSystemPromptReportListContract`
 * `limit` precedent (`observability.ts:573-586`).
 */
export const ObsFleetHealthContract = defineContract({
  method: "obs.fleet.health",
  request: z.object({
    /** Window in hours. Optional; the 24h default is applied in the handler body. */
    sinceHours: z.number().positive().optional(),
  }),
  response: FleetHealthReportSchema,
  scopes: ["admin"] as const,
});
