// SPDX-License-Identifier: Apache-2.0
/**
 * Pure RE-PROVE assert module (Phase 156 — GA CLOSE: RE-PROVE with obs.explain).
 *
 * The deterministic, KEYLESS substrate that makes the Plan 156-02 RE-PROVE
 * numbers trustworthy. Everything here is PURE — no daemon, no network, no env
 * reads, no key, no `~/.comis` path — so it runs in the Stage-A/B tier
 * (`pnpm validate`) and never imports a product package beyond the `@comis/core`
 * `IncidentReport` TYPE. It is RED→GREEN unit-tested in diagnosis-reprove.test.ts
 * over synthetic transcripts + the two frozen fixtures (via the `@comis/daemon`
 * barrel-exported assembler) BEFORE any live token is spent.
 *
 * Mirrors diagnosis-harness.ts (Phase 149): the metric counter follows
 * `recordMetrics`' non-empty-name guard, and the asserts throw FIELD-NAME-ONLY
 * (never `JSON.stringify(report)`) — the residency rule (diagnosis-harness.ts:139).
 *
 * Exports the three helpers the self-test + the scenario both consume:
 *   - countObsExplainCalls(transcript) — how many times obs.explain was invoked
 *     (1 is the G1 proof). NOT a distinct-set size: the metric is the invocation
 *     COUNT, so a repeated call would (correctly) read > 1.
 *   - assert678Report(report)          — field-level X3 asserts for the 678 fixture
 *     (content_heuristic_misclassification + degraded + breakerTimeline + costUsd).
 *     NOT compareToAnswerKey: the 678 report resolves token=status, never the
 *     literal "403" the answer-key requires, so `compareToAnswerKey(...).reached`
 *     is FALSE — a false RED that never goes GREEN.
 *   - assert503Report(report)          — field-level asserts for the 503 fixture
 *     (breaker_opened_repeated_failure + web_fetch + degraded).
 *
 * @module
 */

import type { AgentTurn } from "./diagnosis-harness.js";
import type { IncidentReport } from "@comis/core";

// ---------------------------------------------------------------------------
// countObsExplainCalls — the 1-call gate (G1 proof).
// ---------------------------------------------------------------------------

/**
 * The wire-safe live tool name (CR-01): the product's MCP tool name `obs_explain`
 * (see glass-box-ga-readiness.test.ts:78). The single source of truth for BOTH the
 * live manifest's function name and this metric's target string — a dotted
 * `obs.explain` is forbidden by the OpenAI function-name schema and HTTP-400s a real
 * endpoint, so the live manifest, the synthetic transcripts, and this counter all
 * standardize on the one wire-safe string.
 */
export const OBS_EXPLAIN_TOOL_NAME = "obs_explain";

/**
 * Count how many times `obs_explain` was invoked across an agent transcript.
 *
 * Iterates every turn's `toolCalls`, counting entries whose `name` is exactly
 * {@link OBS_EXPLAIN_TOOL_NAME}. Mirrors recordMetrics' WR-02 non-empty-name guard:
 * a nameless tool call (small models sometimes emit no `function.name`) is skipped,
 * never counted. Returns the raw INVOCATION count (not a distinct-set size) — the G1
 * proof is `=== 1`, and a second call must read as 2, never collapse to 1.
 */
export function countObsExplainCalls(transcript: AgentTurn[]): number {
  let count = 0;
  for (const turn of transcript) {
    for (const call of turn.toolCalls ?? []) {
      // WR-02 parity: a nameless call is not a tool invocation.
      if (!call.name) continue;
      if (call.name === OBS_EXPLAIN_TOOL_NAME) count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Field-level IncidentReport asserts — the X3 root-cause proof, reached through
// the FROZEN assembler (obs-explain.test.ts:98-126). FIELD-LEVEL, NOT
// compareToAnswerKey (the 678 token gap; Critical Nuance 1).
// ---------------------------------------------------------------------------

/** The frozen 678 sessionCostUsd reference (obs-explain.test.ts:110). */
const COST_678_USD = 1.320669;

/**
 * The cost-match tolerance (WR-03). Aligned with the frozen reference assertion
 * `expect(r.cost.costUsd).toBeCloseTo(1.320669, 4)` in obs-explain.test.ts:110:
 * vitest's `toBeCloseTo(x, 4)` passes iff `|actual - x| < 0.5 * 10^-4 = 5e-5`. The
 * prior `>= 1e-4` window was 2x looser and would admit a ~9e-5 cost drift the
 * centerpiece test rejects — for a proof artifact the field-level assert must be at
 * least as strict as the reference it mirrors.
 */
const COST_678_TOLERANCE = 5e-5;

/**
 * Assert the 678 IncidentReport reaches the X3 root cause at FIELD level:
 *   - likelyRootCause.code === "content_heuristic_misclassification"
 *   - likelyRootCause.detail matches /web_fetch/
 *   - outcome.degraded === true
 *   - breakerTimeline.length > 0
 *   - cost.costUsd ≈ 1.320669 (within 5e-5 — matches obs-explain.test.ts:110's
 *     toBeCloseTo(...,4) reference; WR-03)
 *
 * Throws FIELD-NAME-ONLY on any failure (`diagnosis-reprove: 678 report missing
 * <field>`) — never echoes the report body (the residency rule,
 * diagnosis-harness.ts:139). This is the field-level proof, NOT compareToAnswerKey:
 * the 678 report resolves token=status, so the answer-key's literal "403" is
 * absent and `compareToAnswerKey(...).reached` is permanently false.
 */
export function assert678Report(r: IncidentReport): void {
  if (r.likelyRootCause?.code !== "content_heuristic_misclassification") {
    throw new Error("diagnosis-reprove: 678 report missing likelyRootCause.code");
  }
  if (!/web_fetch/.test(r.likelyRootCause?.detail ?? "")) {
    throw new Error("diagnosis-reprove: 678 report missing likelyRootCause.detail");
  }
  if (r.outcome.degraded !== true) {
    throw new Error("diagnosis-reprove: 678 report missing outcome.degraded");
  }
  if (r.breakerTimeline.length <= 0) {
    throw new Error("diagnosis-reprove: 678 report missing breakerTimeline");
  }
  if (Math.abs(r.cost.costUsd - COST_678_USD) >= COST_678_TOLERANCE) {
    throw new Error("diagnosis-reprove: 678 report missing cost.costUsd");
  }
}

/**
 * Assert the 503 IncidentReport reaches the X3 root cause at FIELD level:
 *   - likelyRootCause.code === "breaker_opened_repeated_failure"
 *   - likelyRootCause.detail matches /web_fetch/
 *   - outcome.degraded === true
 *
 * Throws FIELD-NAME-ONLY on any failure. The 503 report ALSO satisfies
 * compareToAnswerKey structurally (all of 503/breaker/web_fetch/repeated
 * present) — that may be asserted as a bonus in the scenario, but this
 * field-level check is the primary.
 */
export function assert503Report(r: IncidentReport): void {
  if (r.likelyRootCause?.code !== "breaker_opened_repeated_failure") {
    throw new Error("diagnosis-reprove: 503 report missing likelyRootCause.code");
  }
  if (!/web_fetch/.test(r.likelyRootCause?.detail ?? "")) {
    throw new Error("diagnosis-reprove: 503 report missing likelyRootCause.detail");
  }
  if (r.outcome.degraded !== true) {
    throw new Error("diagnosis-reprove: 503 report missing outcome.degraded");
  }
}
