// SPDX-License-Identifier: Apache-2.0
/**
 * The `obs.fleet.health` wire shape (Phase 161 RPC response) — the cross-session
 * fleet-health digest. DISTINCT from the per-session `IncidentReport`
 * (`incident-report.ts`): this rolls up a WINDOW of sessions, not one session.
 *
 * Bounded/digest-only/deterministic (v2.15 R1): capped top-N findings + merged
 * `errorKinds`, counts + hints ONLY (no raw WARN bodies), a deterministic
 * `likelyRootCause`-style verdict, an honest `truncations[]` ledger, and a v2.14
 * `coverage` honesty block (which fleet sources were read). Same window → same
 * verdict: the report root carries NO wall-clock field (the `IncidentReport`
 * precedent has none either) — `windowHours` is the only time reference.
 *
 * Phase 159 ships the SCHEMA only. The bounding pass (mirror `obs-explain-bound.ts`)
 * and the heuristic registry (mirror `obs-explain-heuristics.ts`) that POPULATE
 * `likelyRootCause` + `truncations` land in the Phase-161 handler — the schema is
 * SHAPED (arrays-of-bounded-records + `truncations[]` + digestible scalars) so they
 * apply. This is a BARE z.object schema (it is deliberately NOT wired as an RPC
 * contract, and is NOT registered in `OBSERVABILITY_CONTRACTS`), so it does NOT
 * trip `contract-codegen-drift` / `contract-handler-parity`; the RPC/handler/CLI
 * are Phase 161. It IS barrel re-exported (via `observability.ts`)
 * so the Phase-161 handler can import it; the no-in-repo-consumer dead-export gate
 * is satisfied by a `public-api-policy.ts` entry (the `IncidentReportSchema`
 * precedent) until that handler lands.
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
  }),
  /** Merged across the window + capped top-N (counts only — no raw bodies). */
  topErrorKinds: z.array(z.object({ kind: z.string(), count: z.number() })),
  /**
   * QT2/QT3 — the fleet-level degradation detector: degraded session COUNTS
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
  cost: z.object({ costUsd: z.number(), totalTokens: z.number() }),
  activity: z.object({
    activeAgents: z.array(z.string()),
    activeChannels: z.array(z.string()),
    exitReasons: z.record(z.string(), z.number()),
    turnTotal: z.number(),
    tokenTotal: z.number(),
  }),
  /**
   * Capped top-N findings — counts + short codes + hints ONLY (no raw WARN
   * bodies). The Phase-161 bounding pass trims to top-N and records the drop in
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
   * Mirrors `IncidentReport.likelyRootCause` 1:1 (the Phase-161 heuristic
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
   * The honest size-drop ledger — what the (Phase-161) bounding pass shed to
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
   * (Phase-161) handler actually located + read. DISTINCT from `truncations[]`
   * (SIZE-drops): `coverage` records whether the INPUTS were read, so a
   * silently-empty fleet report ("0 rows / N days missing") is self-evident
   * instead of masquerading as a clean zero-activity window. Mirrors the v2.14
   * `IncidentReport.coverage` pattern (`obs-explain-assemble.ts`). Optional
   * (schemaVersion stays 1) — additive; pre-existing constructors omit it.
   *
   * The shape maps to the Phase-159 aggregates: `sessionSummary` (A1/A2 store
   * rows), `sessionIndex` (A3 multi-day reader's `daysRead`/`daysMissing`),
   * `billing` (present flag for the cost source).
   */
  coverage: z
    .object({
      sessionSummary: z.object({ found: z.boolean(), rows: z.number() }),
      sessionIndex: z.object({ daysRead: z.number(), daysMissing: z.number() }),
      billing: z.object({ present: z.boolean() }),
    })
    .optional(),
});

/** The `obs.fleet.health` response (the cross-session fleet digest). Inferred from the Zod schema. */
export type FleetHealthReport = z.infer<typeof FleetHealthReportSchema>;

/**
 * `obs.fleet.health` — the cross-session fleet-health triage RPC (v2.15 R2,
 * Phase 161). Admin-only; the daemon handler fans the Phase-159 A-track
 * aggregation + Phase-160 I-track diagnostics into the {@link FleetHealthReport}
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
