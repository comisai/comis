// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `obs.fleet.health` RPC handler — the cross-session FleetHealthReport assembler
 * (Phase 161 R2 + H1). The SIBLING of `obs-explain.ts`: `obs.explain` post-mortems
 * ONE session; this rolls up a WINDOW of sessions into a bounded, deterministic,
 * digest-only fleet triage.
 *
 * The assembler is a READ FAN-IN over four EXISTING, bounded, soft-fail sources
 * (the `assembleIncidentReportFromSources` shape — that reads 4 sources too):
 *
 *   A1 + A2 — `ObservabilityStore.aggregateSessionsInWindow(sinceMs)` ->
 *             `reduceFleetWindow` (pure cross-session reduce; synthetic excluded).
 *   A3      — `readSessionIndexWindow(dataDir, sinceMs, nowMs)` (multi-day
 *             activity aggregate; `daysRead`/`daysMissing` feed the coverage
 *             honesty block). `nowMs` is the SAME injected instant as `sinceMs`,
 *             so the A3 day-key window tracks the injected clock (WR-01).
 *   I-track — `queryDiagnostics({ category })` over the Phase-160
 *             `health_signal` / `model_health` / `config_posture` rows (counts +
 *             labels only — the 160 rows already dropped raw bodies).
 *
 * Determinism (X3): the report root carries NO wall-clock field — there is ONE
 * clock read (the injected `ClockPort.now()`), captured once and threaded as
 * BOTH the window start (`sinceHours -> sinceMs`) AND the A3 reader's window
 * upper bound (`nowMs`). NEVER `Date.now()`/`new Date()` downstream (the globals
 * gate). Same injected clock + same data -> byte-identical report — true even
 * when the injected instant differs from real wall-clock (WR-01).
 *
 * Bounded (digest-only): `findings[]` is capped at {@link FLEET_FINDINGS_CAP}
 * (highest-count-first), recording the drop in `truncations[]` — the
 * `obs-explain-bound.ts` cap-then-record pattern, lighter because the 159 schema
 * + A2's top-3 cap already bound the rest.
 *
 * H1 dual-layer admin gate: the contract is `scopes:["admin"]` (gateway-router
 * primary) AND the handler re-checks `_trustLevel === "admin"` (defense-in-depth),
 * cloned verbatim from `obs-explain.ts`. `stripInternalFields` runs BEFORE the
 * contract parse so `_trustLevel` can never be smuggled into the parsed params or
 * the report.
 *
 * The heuristic registry + bounding pass are co-located here (KISS — start
 * co-located, split to `fleet-health-heuristics.ts` / `fleet-health-bound.ts`
 * only if the 800L file-size cap is approached; the obs-explain split is the
 * precedent).
 *
 * @module
 */

import * as os from "node:os";
import {
  ObsFleetHealthContract,
  stripInternalFields,
  safePath,
  type FleetHealthReport,
  type ClockPort,
  type DurableRunPort,
} from "@comis/core";
import { reduceFleetWindow, type ObservabilityStore } from "@comis/memory";
import { pipelineAuthoringGate } from "@comis/observability";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";
import { readSessionIndexWindow } from "./fleet-session-index.js";
import { buildFindings, pipelineAuthoringAggregateFromRows, type Finding } from "./fleet-findings.js";
import { computeAutonomySlice } from "./fleet-autonomy.js";

/** Default data directory (lazy). Mirrors obs-explain.ts / fleet-session-index.ts. */
function defaultDataDir(): string {
  return safePath(os.homedir(), ".comis");
}

const MS_PER_HOUR = 60 * 60 * 1000;

/** The window default applied IN the handler body (off the 12-shape allowlist). */
const DEFAULT_WINDOW_HOURS = 24;

/**
 * Max findings the report keeps — the bounding cap (highest-count-first). Mirrors
 * the obs-explain progressive-shed caps; the fleet report is small (the 159 schema
 * + A2's top-3 cap bound the rest) so the only array that can grow with WARN
 * volume is `findings[]`, derived from the I-track rows.
 */
const FLEET_FINDINGS_CAP = 8;

/**
 * The degraded-rate threshold above which the fleet-degradation heuristic fires.
 * A window where most sessions degraded is a fleet-level signal (distinct from a
 * single bad session — that is `obs.explain`'s job).
 */
const HIGH_DEGRADED_RATE = 0.5;

// Findings derivation (`buildFindings` + the `Finding` shape + the defensive
// details parsers) is extracted to ./fleet-findings.ts to keep this module under
// the obs-handlers file-size cap (the OBS-01 Phase-180 script findings pushed it
// over). Counts + short codes + hints ONLY — NEVER raw row.message/details bodies.

// ---------------------------------------------------------------------------
// Heuristic registry — the deterministic likelyRootCause verdict.
// PURE, ordered, first-non-null wins (mirror obs-explain-heuristics.ts). No I/O,
// no globals — same fleet signals always yield the same verdict (X3).
// ---------------------------------------------------------------------------

/** A deterministic fleet root-cause verdict. Shape-identical to the schema field. */
interface FleetRootCause {
  code: string;
  detail: string;
  suggestedNextSteps: string[];
}

/** Inputs the heuristic registry keys on (derived counts/rates only). */
interface FleetSignals {
  degradedRate: number;
  sessionCount: number;
  /** W9: count of degraded sessions in the window (acute events). */
  degradedCount: number;
  /** W9: the dominant named endReason cause among degraded sessions
   *  (highest count; ties broken lexicographically for determinism). */
  topDegradedCause?: string;
  healthSignalCount: number;
  configPostureCount: number;
  topErrorKind?: string;
  /** FLEET-04: count of DEGRADED autonomy runs (orphaned + revoked/killed) in the
   *  window — the acute autonomy event the worst-rootRunId verdict fires on. */
  autonomyDegradedCount: number;
  /** FLEET-04: the worst autonomy run's rootRunId (an id the operator pastes into
   *  `comis explain`). Undefined when no autonomy row carried one. */
  worstRootRunId?: string;
}

/**
 * The ordered fleet root-cause registry. First predicate to return a non-null
 * `FleetRootCause` wins. Order is the determinism contract — a fleet-wide
 * degradation outranks a single recurring WARN class.
 */
const FLEET_HEURISTICS: ReadonlyArray<(s: FleetSignals) => FleetRootCause | null> = [
  // 0) FLEET-04 acute AUTONOMY degradation — an unattended run was orphaned on
  //    restart or revoked/killed. This outranks the session-level rules: an
  //    autonomy run that did not survive is the highest-priority unattended-mode
  //    signal, and it carries the worst `rootRunId` so the operator pastes it
  //    straight into `comis explain` (the FLEET-05 root- arm). Clones the
  //    fleet_acute_degradation shape (a named-cause acute event). NO clock read —
  //    keys only on the assembled autonomy signals (determinism, T-220-12).
  (s) => {
    if (s.autonomyDegradedCount === 0) return null;
    const explainRef =
      s.worstRootRunId !== undefined ? `comis explain ${s.worstRootRunId}` : "comis explain <rootRunId>";
    return {
      code: "fleet_autonomy_degradation",
      detail:
        s.worstRootRunId !== undefined
          ? `${s.autonomyDegradedCount} autonomy run(s) degraded (orphaned/revoked/killed) over the window — worst: ${s.worstRootRunId}`
          : `${s.autonomyDegradedCount} autonomy run(s) degraded (orphaned/revoked/killed) over the window`,
      suggestedNextSteps: [
        `run \`${explainRef}\` on the worst autonomy run to see its spawn-tree + why it did not survive`,
        "check the durable checkpoint + lease heartbeat (autonomy.durability.heartbeatStaleMs) for orphaned runs; confirm intent for revoked/killed runs",
      ],
    };
  },
  // 1) High fleet degradation — most sessions in the window degraded.
  (s) => {
    if (s.sessionCount === 0 || s.degradedRate < HIGH_DEGRADED_RATE) return null;
    const pct = Math.round(s.degradedRate * 100);
    const kind = s.topErrorKind ?? "the top error kind";
    return {
      code: "fleet_high_degraded_rate",
      detail: `${pct}% of ${s.sessionCount} sessions degraded over the window (dominant errorKind: ${kind})`,
      suggestedNextSteps: [
        "run `comis explain` on the worst session to localize the failure",
        `inspect the upstream provider/transport for ${kind}`,
        "check provider rate-limit headroom and breaker thresholds",
      ],
    };
  },
  // 2) Acute named degradation (W9 obs-llm-troubleshooting) — ANY degraded
  //    session with a named cause outranks the chronic rules below. Posture is
  //    standing state; a degraded session is an event the operator must explain
  //    first. The live fleet verdict pointed at TLS-off (chronic, known) while
  //    1 of 3 sessions had aborted on context_exhausted (acute, actionable).
  (s) => {
    if (s.degradedCount === 0) return null;
    const cause = s.topDegradedCause ?? "a named cause";
    return {
      code: "fleet_acute_degradation",
      detail: `${s.degradedCount} of ${s.sessionCount} session(s) degraded over the window (top cause: ${cause})`,
      suggestedNextSteps: [
        "run `comis explain` on the worst degraded session for the per-session verdict",
        `address the dominant degradation cause (${cause}) before the chronic posture findings`,
      ],
    };
  },
  // 3) Recurring config-posture signal — an insecure/drifted config across the fleet.
  (s) => {
    if (s.configPostureCount === 0) return null;
    return {
      code: "fleet_config_posture",
      detail: `${s.configPostureCount} config-posture signal(s) flagged across the fleet`,
      suggestedNextSteps: [
        "review the gateway TLS / token posture",
        "reconcile the flagged config keys against the secure baseline",
      ],
    };
  },
  // 4) Recurring health signal — repeated health WARNs without a degradation spike.
  (s) => {
    if (s.healthSignalCount === 0) return null;
    return {
      code: "fleet_recurring_health_signal",
      detail: `${s.healthSignalCount} recurring health WARN signal(s) across the fleet`,
      suggestedNextSteps: [
        "inspect the recurring health WARNs (LCD divergence / breaker trips)",
        "run `comis explain` on an affected session for the per-session detail",
      ],
    };
  },
];

/** Run the ordered registry; first non-null verdict, or null (a clean fleet). */
function fleetRootCause(s: FleetSignals): FleetRootCause | null {
  for (const h of FLEET_HEURISTICS) {
    const r = h(s);
    if (r !== null) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bounding pass — cap findings highest-count-first, record the drop.
// Mirror obs-explain-bound.ts's cap-then-record (honest-lossiness).
// ---------------------------------------------------------------------------

interface TruncationEntry {
  field: string;
  reason: string;
  pointer?: string;
}

/**
 * Cap `findings[]` to {@link FLEET_FINDINGS_CAP} highest-count-first, pushing an
 * honest `truncations[]` entry naming the dropped tail when it fires. A no-op
 * (records nothing) when already within budget so a clean report has no spurious
 * entry. `findings` arrives already sorted highest-count-first.
 */
function boundFindings(findings: readonly Finding[], truncations: TruncationEntry[]): Finding[] {
  if (findings.length <= FLEET_FINDINGS_CAP) return [...findings];
  truncations.push({
    field: "findings",
    reason: `capped at ${FLEET_FINDINGS_CAP} highest-count findings (had ${findings.length})`,
    pointer: "obs.diagnostics",
  });
  return [...findings].slice(0, FLEET_FINDINGS_CAP);
}

// ---------------------------------------------------------------------------
// The assembler.
// ---------------------------------------------------------------------------

/**
 * Assemble the cross-session {@link FleetHealthReport} from the four bounded
 * sources. NEITHER an admin check NOR a contract parse — it takes an
 * ALREADY-AUTHORIZED window and runs the deterministic read fan-in, so it can be
 * reached under daemon authority by a caller with its own authorization boundary
 * (the admin RPC handler keeps its admin gate; the Phase-161-02 MCP closure relies
 * on the per-client allowlist + the digest-only report).
 *
 * @param deps.obsStore - the observability store (A1/A2 + I-track). Soft-fail:
 *   absent yields an empty (but self-evidently empty, via coverage) report.
 * @param deps.dataDir - the data dir for the A3 session-index reader.
 * @param deps.clock - the injected ClockPort. The ONE clock read (for `sinceMs`);
 *   NEVER `Date.now()` (the globals gate).
 * @param deps.durableRuns - FLEET-01/02/04 (Phase 220-03): the durable-run store
 *   for the autonomy block's run counts (`countByStatus(sinceMs)`). Soft-fail (the
 *   `obsStore?` precedent): absent ⇒ the autonomy block is honestly OMITTED (the
 *   daemon-less offline CLI / a non-durability boot). NO extra clock read — reuses
 *   the ONE `sinceMs` window.
 * @param sinceHours - the window size (the caller applies the 24h default). A
 *   non-finite or non-positive value is clamped to {@link DEFAULT_WINDOW_HOURS}
 *   here (IN-01 defense-in-depth) so a contract-bypassing caller cannot produce
 *   a `-Infinity`/`NaN` window bound.
 */
export async function assembleFleetHealthReport(
  deps: { obsStore?: ObservabilityStore; dataDir: string; clock: ClockPort; durableRuns?: DurableRunPort },
  sinceHours: number,
): Promise<FleetHealthReport> {
  // IN-01 guard (defense-in-depth): the contract rejects a non-finite/non-positive
  // sinceHours at the parse boundary, but the assembler is ALSO reachable directly
  // (the MCP closure) and a non-finite value here would yield sinceMs = -Infinity
  // / NaN — a `-Infinity` SQL lower bound and a `RangeError` in the A3 day-key
  // derivation. Clamp anything non-finite or non-positive to the default window
  // so the assembler is robust regardless of the caller's validation.
  const windowHours =
    Number.isFinite(sinceHours) && sinceHours > 0 ? sinceHours : DEFAULT_WINDOW_HOURS;

  // The ONE clock read — captured ONCE and threaded through EVERY windowed
  // source so the whole report is deterministic w.r.t. the injected clock.
  // `windowHours -> sinceMs` (window start) + `nowMs` (window upper bound, passed
  // to the A3 reader). NO Date.now()/new Date() anywhere downstream (WR-01).
  const nowMs = deps.clock.now();
  const sinceMs = nowMs - windowHours * MS_PER_HOUR;

  // A1 + A2 — per-session rollups -> cross-session fleet rollup. `rows` is
  // `SessionSummaryRollup[]` (inferred from the store method's return type; the
  // type is not re-exported from @comis/memory, and reduceFleetWindow accepts it
  // structurally — no explicit annotation needed).
  const rows = deps.obsStore?.aggregateSessionsInWindow(sinceMs) ?? [];
  // Synthetic/test sessions are always excluded from this operator-facing fleet
  // digest (WR-02): the prior `includeSynthetic` opt-in was unreachable from all
  // four surfaces, so it was removed rather than left as a dead admin capability.
  const fleet = reduceFleetWindow(rows, { excludeSynthetic: true });
  // WR-01: the absolute degraded count comes from the SAME synthetic-excluded
  // population the reducer used for `total` (sessionCount) + `degradedRate` —
  // `fleet.degradedCount`, NOT a re-derivation over the UNFILTERED `rows`. The
  // old `rows.filter(r => r.degraded).length` counted synthetic/test degraded
  // rows too, so `sessions.degraded` could exceed `total`, disagree with
  // `degradedRate`, and contradict `sum(degradedByCause)` (which the reducer
  // already caps to runtime-only). Reading it back keeps all three `sessions`
  // fields on one population. (`coverage.sessionSummary.rows` stays unfiltered
  // below — that is a read-coverage breadcrumb, correct pre-exclusion.)
  const degraded = fleet.degradedCount;

  // A3 — multi-day session-index activity aggregate (daysRead/daysMissing -> coverage).
  // Thread the SAME `nowMs` as the window upper bound so the A3 day-key range
  // tracks the injected clock (WR-01), not a hidden second wall-clock read. The
  // reader's own default excludes synthetic rows (WR-02 — no opt-in plumbed).
  const activity = readSessionIndexWindow(deps.dataDir, sinceMs, nowMs);

  // I-track (Phase 160) — windowed health_signal; latest model_health / config_posture.
  const healthSignals = deps.obsStore?.queryDiagnostics({ category: "health_signal", sinceMs }) ?? [];
  const modelHealth = deps.obsStore?.queryDiagnostics({ category: "model_health", sinceMs }) ?? [];
  const configPosture = deps.obsStore?.queryDiagnostics({ category: "config_posture", sinceMs }) ?? [];

  // TELEM-02 — the pre-committed pipeline-authoring decision verdict (gates Phase
  // 174). PURE + deterministic: the windowed pipeline_authoring rows -> the
  // aggregate -> the gate. No-data -> defer. Structurally `{buildAuthor, reason}`,
  // so it assigns into the core-schema-typed report field with no cast.
  const pipelineAuthoringVerdict = pipelineAuthoringGate(
    pipelineAuthoringAggregateFromRows(healthSignals),
  );

  // findings[] — counts + codes + hints ONLY (no raw bodies).
  const allFindings = buildFindings(healthSignals, modelHealth, configPosture);
  const truncations: TruncationEntry[] = [];
  const findings = boundFindings(allFindings, truncations);

  // topErrorKinds — Record -> [{kind,count}], already capped (top-3) + key-sorted by A2.
  const topErrorKinds = Object.entries(fleet.topErrorKinds).map(([kind, count]) => ({ kind, count }));

  // FLEET-01/02/04 (Phase 220-03) — the AUTONOMY slice. autonomy runs ARE
  // durable_runs by construction, so the run counts come from the crash-surviving
  // DurableRunPort.countByStatus (NOT the session-rollup schema). Soft-fail read
  // (the getRollingSpendUsd / obsStore? precedent) — NO new clock read, reuse the
  // ONE `sinceMs` window. The resumed/killed counts + the worst rootRunId are
  // event-sourced from the `healthSignals` rows already read above (kill is
  // separable from revoked ONLY because Plan 01 emits a distinct event). When the
  // store is unwired AND no autonomy rows exist, the block is OMITTED (honest
  // degradation — offline CLI). The whole slice reads only assembled signals +
  // the synthetic-excluded `fleet` read-back — NO Date.now()/new Date() (T-220-12),
  // NO re-derivation over raw `rows` (T-220-11 / WR-01).
  // Soft-fail read of the crash-surviving counts (the getRollingSpendUsd precedent):
  // the Result is narrowed on `.ok` — a read error degrades to `undefined` (the block
  // is then driven by the event-sourced rows / omitted), never throws.
  const durableCountsResult = await deps.durableRuns?.countByStatus(sinceMs);
  const durableCounts =
    durableCountsResult !== undefined && durableCountsResult.ok ? durableCountsResult.value : undefined;
  const autonomy = computeAutonomySlice({
    durableCounts,
    healthSignals,
    // FLEET-02: the breaker-trip subset reads back from the synthetic-excluded
    // reduce's denial_breaker cause — NEVER re-derived over raw rows (WR-01/Pitfall 5).
    breakerTrips: fleet.degradedByCause["denial_breaker"] ?? 0,
    // FLEET-01: the window's autonomy-inclusive operator cost (the synthetic-excluded
    // read-back — documented in the schema; a stricter autonomy-only cost is a follow-up).
    costUsd: fleet.costUsd,
  });

  // The deterministic verdict (PURE, ordered first-match-wins).
  // W9: dominant named degradation cause (highest count; lexicographic tiebreak).
  const topDegradedCause = Object.entries(fleet.degradedByCause).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];
  const likelyRootCause = fleetRootCause({
    degradedRate: fleet.degradedRate,
    sessionCount: fleet.sessionCount,
    degradedCount: degraded,
    ...(topDegradedCause !== undefined ? { topDegradedCause } : {}),
    healthSignalCount: healthSignals.length,
    configPostureCount: configPosture.length,
    topErrorKind: topErrorKinds[0]?.kind,
    // FLEET-04: the autonomy verdict keys on the DEGRADED autonomy run count +
    // the worst rootRunId (both from the slice above) — undefined-safe spread.
    autonomyDegradedCount: autonomy?.runs.degraded ?? 0,
    ...(autonomy?.worstRootRunId !== undefined ? { worstRootRunId: autonomy.worstRootRunId } : {}),
  });

  // Report-level guidance (independent of the per-verdict steps).
  const suggestedNextSteps =
    fleet.sessionCount === 0
      ? ["no sessions in the window — widen `--since` or confirm the daemon is recording session summaries"]
      : ["run `comis explain <sessionKey>` on the worst session for the per-session post-mortem"];

  return {
    schemaVersion: 1,
    windowHours,
    sessions: { total: fleet.sessionCount, degraded, degradedRate: fleet.degradedRate },
    topErrorKinds,
    // QT2/QT3 — the fleet-level degradation detector: degraded counts by named
    // endReason cause, computed by reduceFleetWindow from the per-session rows
    // (bounded + deterministic; synthetic excluded by the reducer above).
    degradedByCause: fleet.degradedByCause,
    breakerTripTotal: fleet.breakerTripTotal,
    toolStats: fleet.toolStats,
    // WR-03 — cost is CROSS-SOURCE and degrades asymmetrically: `costUsd` is
    // A1-sourced (the session-summary store) while `totalTokens` is A3-sourced
    // (`activity.tokenTotal`, the session-index files). So `totalTokens` may be
    // 0 even when `costUsd` is non-zero whenever A3 reads degrade
    // (`coverage.sessionIndex.daysMissing > 0`). `cost.totalTokens` is the SAME
    // figure as `activity.tokenTotal` (single A3 source of truth — no second
    // aggregate); consumers cross-reference `coverage` before trusting a 0. The
    // `comis fleet` table render drops the misleading "· 0 tok" in that case.
    cost: { costUsd: fleet.costUsd, totalTokens: activity.tokenTotal },
    activity: {
      activeAgents: activity.activeAgents,
      activeChannels: activity.activeChannels,
      exitReasons: activity.exitReasons,
      turnTotal: activity.turnTotal,
      tokenTotal: activity.tokenTotal,
    },
    findings,
    likelyRootCause,
    // TELEM-02 — the pipeline-authoring gate verdict (declared in
    // FleetHealthReportSchema so .parse() preserves it; rides the existing
    // admin-gated obs.fleet.health — no new RPC surface).
    pipelineAuthoringGate: pipelineAuthoringVerdict,
    // FLEET-01/02/04 — the autonomy block (counts + the worst rootRunId ONLY).
    // Conditionally spread so an offline/non-durability boot with no autonomy
    // signals OMITS the field entirely (honest degradation; the schema field is
    // optional, so an absent block round-trips). Present otherwise.
    ...(autonomy !== undefined ? { autonomy } : {}),
    suggestedNextSteps,
    truncations,
    coverage: {
      sessionSummary: { found: rows.length > 0, rows: rows.length },
      sessionIndex: { daysRead: activity.daysRead, daysMissing: activity.daysMissing },
      billing: { present: rows.length > 0 },
    },
  };
}

/**
 * Bind the `obs.fleet.health` handler — the H1 admin gate + strip-before-parse +
 * the read fan-in. COMPUTED-KEY form (`[ObsFleetHealthContract.method]`) is
 * MANDATORY — `api-contracts-bidirectional.test.ts` only recognizes the computed
 * key, not a `"obs.fleet.health":` string literal.
 *
 * @param deps - the shared obs-handler deps; `deps.clock` is populated by
 *   `buildRpcDispatchDeps` in daemon.ts (Phase 161-02). The handler asserts
 *   `deps.clock!` because 161-02 always populates it.
 */
export function bindFleetHealthHandlers(deps: ObsHandlerDeps): Record<string, RpcHandler> {
  const dataDir = deps.dataDir ?? defaultDataDir();

  return {
    [ObsFleetHealthContract.method]: async (rawParams) => {
      // H1: admin check (defense-in-depth; gateway-router is the primary gate).
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin access required");

      // stripInternalFields BEFORE contract parse — `_trustLevel` cannot be
      // smuggled into the parsed params or the report.
      const params = ObsFleetHealthContract.request.parse(stripInternalFields(rawParams));

      const report = await assembleFleetHealthReport(
        // FLEET-01/02/04: thread durableRuns for the autonomy block. Populated by
        // buildRpcDispatchDeps (daemon.ts:893, `durableRuns: c.durableRunStore`) on
        // the SAME ObservabilityApiDeps object as obsStore/clock; absent ⇒ honest
        // degradation (the block is omitted).
        { obsStore: deps.obsStore, dataDir, clock: deps.clock!, durableRuns: deps.durableRuns },
        params.sinceHours ?? DEFAULT_WINDOW_HOURS,
      );

      // Dev-mode response validation (catches field type regressions in dev only).
      if (IS_DEV) ObsFleetHealthContract.response.parse(report);
      return report;
    },
  };
}
