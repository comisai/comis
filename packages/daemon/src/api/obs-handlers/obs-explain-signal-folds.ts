// SPDX-License-Identifier: Apache-2.0
/**
 * Content-free record folds for the `comis explain` normalizer (`toIncidentSignals`).
 *
 * Extracted from `obs-explain-signals.ts` (which sits at the 500-line
 * `obs-handlers/*` subdir cap) — the same record-handler extraction discipline
 * the image/vision/video/voice folds used (`obs-explain-voice-fold.ts`). Houses
 * the pure reductions that turn one trajectory record's `data` into an
 * `IncidentSignals` field:
 *   - `accumulateLearningRecord` / `buildLearningSignal` — the OBS-02 (Phase 198)
 *     learning outcome-signal block from `learning.outcome_observed` records.
 *   - `accumulateToolSchemaRecord` — the GBNF-02 (Phase 175) tool-schema-rejection
 *     block from `execution.tool_schema_unsupported` records.
 *
 * Every fold is content-free by construction: it reads ONLY ids / closed enums /
 * counts / booleans, dropping any off-vocabulary value (defence-in-depth — a
 * smuggled enum/body never enters the verdict surface; SEC-01 / T-175-17).
 *
 * @module
 */

import { IncidentContextBudgetSchema, IncidentPromptTimeoutSchema } from "@comis/core";
import type { IncidentSignals, IncidentContextBudget, IncidentPromptTimeout } from "@comis/core";
// The content-free readers live in the sibling fields helper (one source of truth);
// imported here so the GBNF fold reuses them rather than re-deriving (no cycle —
// the fields helper does not import this module).
import { asStringArray, asString, asNumber } from "./obs-explain-signals-fields.js";

/** Return `v` typed as a `T` iff it is a member of the closed vocabulary, else undefined. */
function narrow<T extends string>(vocab: readonly T[], v: unknown): T | undefined {
  return typeof v === "string" && (vocab as readonly string[]).includes(v) ? (v as T) : undefined;
}

// ---------------------------------------------------------------------------
// OBS-02 (Phase 198): the learning outcome-signal fold.
// ---------------------------------------------------------------------------

/** The reconstructed learning block (the non-optional shape of the signal). */
export type IncidentLearningSignal = NonNullable<IncidentSignals["learning"]>;

type LearningOutcome = NonNullable<IncidentLearningSignal["outcome"]>;
type LearningSource = IncidentLearningSignal["sources"][number];

const LEARNING_OUTCOMES: readonly LearningOutcome[] = ["success", "failure", "corrected", "unknown"];
const LEARNING_SOURCES: readonly LearningSource[] = ["tool", "pipeline", "correction", "judge", "reaction", "explicit"];

/**
 * The mutable fold state accumulated across the session's learning records:
 * the `learning.outcome_observed` outcome/source signal (Phase 198) PLUS the
 * skill-invocation signal (`skill.prompt_invoked`) and the reflection funnel
 * (`reflect.admitted` / `reflect.funnel`, renamed Phase 226 — they contribute the
 * BENIGN abstain flag). `count` gates whether ANY learning-family record was seen
 * (an absent block ⇒ `undefined`), so it bumps for every fold — outcome AND
 * reflection — not just outcome records. The Phase-203 user-model-revision +
 * generalization fields were DELETED in Phase 226 with their 0-emit events.
 */
export interface LearningFoldState {
  count: number;
  outcome?: LearningOutcome;
  /**
   * Whether ANY record in the session resolved to a non-`unknown` outcome. The
   * `outcome_unresolved` verdict means "NO signal tier resolved an outcome" — so it
   * must key on "ever resolved", NOT the LAST record (a trailing no-signal turn, e.g.
   * a tool-less recall reply, otherwise clobbers an earlier resolved success and the
   * session is wrongly flagged unresolved). Live VPS finding 2026-06-18.
   */
  everResolved: boolean;
  sources: Set<LearningSource>;
  /** Distinct learned-skill ids invoked this session (`skill.prompt_invoked`). IDs only. */
  skillsUsed: Set<string>;
  /** A record carried the BENIGN synthesis-abstain signal (Defer ≠ Retry). */
  synthesisAbstained: boolean;
  /** OBS-4: candidate→active promotions summed this session (`learning.skill_promoted`). Counts only. */
  skillsPromoted: number;
  /** OBS-4: skill demotions summed this session (`learning.skill_demoted`). Counts only. */
  skillsDemoted: number;
  /** OBS-4b: memories that accrued a corroborated failure this session (`learning.memory_failure_attributed`). Counts only — eviction precursor. */
  failuresAttributed: number;
}

/** A fresh, empty fold state (no learning records seen yet). */
export function emptyLearningFold(): LearningFoldState {
  return {
    count: 0,
    everResolved: false,
    sources: new Set(),
    skillsUsed: new Set(),
    synthesisAbstained: false,
    skillsPromoted: 0,
    skillsDemoted: 0,
    failuresAttributed: 0,
  };
}

/**
 * Read the BENIGN synthesis-abstain signal off ANY learning-family record's
 * `data` (the cron logs `errorKind:"precondition"` with an abstain hint; the
 * daemon emit may flag `abstained:true`). Defence-in-depth: an exact closed-enum
 * match only — never a substring/body read. Mutates `synthesisAbstained` (sticky
 * true; Defer ≠ Retry — abstain is benign, never a failure).
 */
function readAbstainSignal(state: LearningFoldState, data: Record<string, unknown>): void {
  if (data.abstained === true || data.errorKind === "synthesis_abstained") {
    state.synthesisAbstained = true;
  }
}

/**
 * Fold one `learning.outcome_observed` record's `data` into the state (mutating).
 * LAST record wins for `outcome`; sources accumulate (deduped); off-vocabulary
 * outcome/source values are dropped. Every seen record bumps `count` (so the
 * block is emitted even when the only record carried bad enums).
 */
export function accumulateLearningRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  const outcome = narrow(LEARNING_OUTCOMES, data.outcome);
  if (outcome !== undefined) {
    // Last NON-UNKNOWN wins: a resolved outcome (success/failure/corrected) is the
    // session's meaningful result and is never clobbered by a later `unknown` (a
    // trailing no-signal turn). Only fall back to `unknown` when nothing has resolved
    // yet, so an all-unknown session still reports `unknown`. `everResolved` (NOT the
    // last record) is what `outcomeResolved` keys on. Live VPS finding 2026-06-18.
    if (outcome !== "unknown") {
      state.outcome = outcome;
      state.everResolved = true;
    } else if (state.outcome === undefined) {
      state.outcome = "unknown";
    }
  }
  const source = narrow(LEARNING_SOURCES, data.source);
  if (source !== undefined) state.sources.add(source);
  readAbstainSignal(state, data);
}

/**
 * Fold one `skill.prompt_invoked` record's `data` into the state (mutating):
 * the invoked learned-skill `skillName` joins `skillsUsed` (deduped). IDs ONLY —
 * a non-string `skillName` is dropped (a body smuggled as a name never enters
 * the surface; SEC-01 / T-201-43). Bumps `count` (a skill-only session still
 * yields a learning block).
 */
export function accumulateSkillInvokedRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  if (typeof data.skillName === "string") state.skillsUsed.add(data.skillName);
  readAbstainSignal(state, data);
}

/**
 * Fold one reflection-funnel record's `data` into the state (mutating; REFLECT,
 * renamed Phase 226 from `learning.skill_synthesized` — handles BOTH `reflect.admitted`
 * and `reflect.funnel`): the only signal it contributes is the BENIGN abstain flag
 * (the payload is counts + a closed admissionOutcome enum only — no body crosses).
 * Bumps `count` (a reflection-only session still yields a learning block).
 */
export function accumulateReflectFunnelRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  readAbstainSignal(state, data);
}

/**
 * Fold one `learning.skill_promoted` / `learning.skill_demoted` record's `data` into the state
 * (mutating; SURFACE-06, COUNTS ONLY). `data.count` is the number promoted/demoted this resolve;
 * bump the matching tally + `count`. OBS-4 (hindsight-reflection-20260626): with `skill.prompt_invoked`
 * (already folded into `skillsUsed`) this makes the reuse→promote chain readable on the per-session
 * learning block — `comis explain <session>` shows "used skill X → promoted N" in one call instead of
 * a trajectory + outcome_events + mental_models hand-join. A non-numeric `count` is read as 0 (SEC-01).
 */
export function accumulateSkillTransitionRecord(
  state: LearningFoldState,
  data: Record<string, unknown>,
  direction: "promoted" | "demoted",
): void {
  state.count += 1;
  const n = typeof data.count === "number" && Number.isFinite(data.count) ? data.count : 0;
  if (direction === "promoted") state.skillsPromoted += n;
  else state.skillsDemoted += n;
  readAbstainSignal(state, data);
}

/**
 * Fold one `learning.memory_failure_attributed` record's `data` into the state (mutating; OBS-4b,
 * COUNTS ONLY). `data.count` is the number of memories that accrued a CORROBORATED failure this
 * resolve (the eviction-causation precursor — eviction needs failure_count >= floor); bump
 * `failuresAttributed` + `count`. A non-numeric `count` is read as 0 (SEC-01).
 */
export function accumulateMemoryFailureRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  const n = typeof data.count === "number" && Number.isFinite(data.count) ? data.count : 0;
  state.failuresAttributed += n;
  readAbstainSignal(state, data);
}

// Phase 226 SIMPLIFY-04: accumulateSkillValidatedRecord (the sandbox-validation fold —
// sandbox deleted in 223), accumulateUserModelRevisedRecord + accumulateMemoryGeneralizedRecord
// (the user-rep revision + generalization folds — folded into reflection in 225) were DELETED
// with their 0-emit events. `skillFailures` now keys on the terminal outcome only (a learned
// procedure used in a failed/corrected trajectory).

/**
 * Build the `IncidentSignals["learning"]` block from the fold, or `undefined`
 * when no learning record was seen (absent ⇒ omitted from the report).
 * `outcomeResolved` is true ONLY when a terminal outcome exists and is NOT
 * `"unknown"` (the fail-closed coverage rule — an unresolved/unknown finish is
 * the `outcome_unresolved` verdict's trigger).
 *
 * `skillFailures` (P2): the session's used skills surface as failures when the
 * terminal outcome is `failure`/`corrected` — "a learned procedure was used in a
 * failed/corrected trajectory" (the `learned_skill_failing` verdict's trigger).
 * (The Phase-201 sandbox-validation failure path was removed in Phase 226 with the
 * 0-emit event.) Counts/ids/closed enums only — no body/script crosses the surface.
 */
export function buildLearningSignal(state: LearningFoldState): IncidentLearningSignal | undefined {
  if (state.count === 0) return undefined;
  const outcomeFailed = state.outcome === "failure" || state.outcome === "corrected";
  const skillsUsed = [...state.skillsUsed];
  return {
    outcomeResolved: state.everResolved,
    ...(state.outcome !== undefined ? { outcome: state.outcome } : {}),
    sources: [...state.sources],
    skillsUsed,
    skillFailures: outcomeFailed ? skillsUsed : [],
    synthesisAbstained: state.synthesisAbstained,
    // OBS-4: additive — present only when a promote/demote fired this session (keeps schemaVersion 1).
    ...(state.skillsPromoted > 0 ? { skillsPromoted: state.skillsPromoted } : {}),
    ...(state.skillsDemoted > 0 ? { skillsDemoted: state.skillsDemoted } : {}),
    // OBS-4b: additive — present only when a corroborated failure accrued this session.
    ...(state.failuresAttributed > 0 ? { failuresAttributed: state.failuresAttributed } : {}),
  };
}

// ---------------------------------------------------------------------------
// GBNF-02 (Phase 175): the tool-schema-rejection fold (`execution.tool_schema_unsupported`).
// ---------------------------------------------------------------------------

const TOOL_SCHEMA_REASONS = ["stripped", "nothing_to_strip", "gate_closed"] as const;

/**
 * Build the `IncidentSignals["toolSchemaUnsupported"]` block from one
 * `execution.tool_schema_unsupported` record's `data` (LAST record wins — the
 * caller assigns it each time, so the terminal repair state explains the end).
 * Content-free (tool + keyword NAMES only — I7; string-array + exact-true reads
 * drop smuggled payload — T-175-17). The WR-05 reason is narrowed to its closed
 * vocabulary (off-vocabulary → undefined so pre-WR-05 records stay readable).
 */
export function accumulateToolSchemaRecord(
  data: Record<string, unknown>,
): NonNullable<IncidentSignals["toolSchemaUnsupported"]> {
  const reason = narrow(TOOL_SCHEMA_REASONS, data.reason);
  return {
    toolNames: asStringArray(data.toolNames),
    strippedKeywords: asStringArray(data.strippedKeywords),
    retried: data.retried === true,
    succeeded: data.succeeded === true,
    ...(reason !== undefined ? { reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// SPEND (WEBUI-04, 179-04): the spend kill-switch breach fold.
// ---------------------------------------------------------------------------

/**
 * Fold one `spend.exceeded` trajectory record (177-obs-loop WR-4
 * translateSpendPayload → `{scope, spentUsd, capUsd, estUsd}`, content-free) into
 * the `acc.spend` field. The LAST record wins (the terminal breach explains the
 * kill); the section's `totalUsd` maps from the record's `spentUsd` (the breaching
 * scope's spent total). A breach with no `scope` is defensively ignored (acc.spend
 * stays as-is). Mutates `acc` (the learning-fold delegation mold); `acc` is typed
 * structurally to avoid importing the internal Acc (no cycle).
 */
export function accumulateSpendExceeded(
  acc: { spend?: { scope: string; totalUsd: number; capUsd: number } },
  data: Record<string, unknown>,
): void {
  const scope = asString(data.scope);
  if (scope === undefined) return;
  acc.spend = {
    scope,
    totalUsd: asNumber(data.spentUsd) ?? 0,
    capUsd: asNumber(data.capUsd) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// TREE-01/02 (Phase 215): the capability.audited spawn-tree fold.
// ---------------------------------------------------------------------------

/** The reconstructed spawn-tree node (the non-optional element shape). Re-derived
 *  from IncidentSignals (already imported) so this fold does NOT import the
 *  internal Acc / SpawnNode from obs-explain-signals-acc.ts — that file imports
 *  LearningFoldState from HERE, so the reverse import would be a cycle. */
type SpawnNodeFold = NonNullable<IncidentSignals["spawnTree"]>[number];

/**
 * Fold one `capability.audited` trajectory record (the per-cap audit Plan 01
 * emits at the gate chokepoint — the spawn-tree's per-node source) into the
 * lease-keyed `spawnNodesByLease` working map. Group by leaseId into ONE node per
 * lease; an in-process record (no real lease, G1) keys on its synthetic rootRunId
 * (NEVER a fabricated lease-<id>). The node collects the attenuated caps it held
 * (deduped), the tool NAMES it invoked, and any CapabilityDeniedError cap (a
 * `deny` decision → denials[], TREE-02). The record is content-free by
 * construction (the translator strips bodies/args); agentId rides the envelope
 * (`rec.agentId`, with the first-seen `accAgentId` fallback). budgetTokensUsed is
 * honestly omitted unless the record carries it (G3 — the live whoami is the
 * authoritative remaining-budget surface; this is the post-mortem topology).
 *
 * Mutates the passed map (the learning-fold delegation mold); typed structurally
 * (a `Map<string, SpawnNodeFold>` + the `accAgentId` fallback) to avoid importing
 * the internal Acc (no cycle).
 */
export function accumulateCapabilityAuditedRecord(
  spawnNodesByLease: Map<string, SpawnNodeFold>,
  data: Record<string, unknown>,
  recAgentId: unknown,
  accAgentId: string | undefined,
): void {
  // WR-01: group by leaseId, falling back to the synthetic rootRunId for the
  // lease-less in-process leg (G1). A record carrying NEITHER is not a
  // reconstructable node — drop it rather than folding every such record into one
  // junk leaseId:"" node (the subagent.budget_exceeded `nodeId === undefined`
  // guard precedent). In normal operation rootRunId is always present; this
  // guards a partial/corrupted on-disk trajectory row.
  const leaseId = asString(data.leaseId) ?? asString(data.rootRunId);
  if (leaseId === undefined) return;
  const node =
    spawnNodesByLease.get(leaseId) ??
    ({
      leaseId,
      ...(asString(data.parentLeaseId) !== undefined
        ? { parentLeaseId: asString(data.parentLeaseId) }
        : {}),
      rootRunId: asString(data.rootRunId) ?? "",
      agentId: asString(recAgentId) ?? accAgentId ?? "",
      caps: [],
      toolsInvoked: [],
      denials: [],
    } satisfies SpawnNodeFold);
  const cap = asString(data.capability);
  const tool = asString(data.tool);
  if (cap !== undefined && !node.caps.includes(cap)) node.caps.push(cap);
  if (tool !== undefined && !node.toolsInvoked.includes(tool)) node.toolsInvoked.push(tool);
  if (data.decision === "deny" && cap !== undefined && !node.denials.includes(cap)) {
    node.denials.push(cap);
  }
  // IN-02: intentional forward-scaffolding — no producer emits budgetTokensUsed on
  // a capability.audited record today (the live `whoami` owns remaining budget, G3;
  // this fold is post-mortem topology). The optional read stays so a future
  // per-node budget producer needs no fold change; it is `undefined` until then.
  const budgetTokensUsed = asNumber(data.budgetTokensUsed);
  if (budgetTokensUsed !== undefined) node.budgetTokensUsed = budgetTokensUsed;
  spawnNodesByLease.set(leaseId, node);
}

/**
 * Fold one `graph.node_spawned` trajectory record (finding D, TREE-01) into the
 * spawn-tree working map. A graph DAG node spawns in-process (gatedSpawn →
 * subAgentRunner.spawn), so it never crosses the socket chokepoint that emits
 * `capability.audited` — and every node shares the graph's `rootRunId`, so the
 * capability fold's `leaseId ?? rootRunId` key would collapse them all into ONE
 * node. So graph nodes get their OWN key: the stable `graphId:nodeId` identity
 * (NOT a fabricated socket lease — G1 forbids that; this is a graph-node id that
 * just happens to live in the `leaseId` field, the same way the in-process leg's
 * synthetic rootRunId does). The node nests under the graph root via
 * `parentLeaseId = rootRunId`. One leaf per node (spawn fires once; the
 * `has` guard makes a duplicate record idempotent). The record is content-free
 * (the translator forwards ids + the child agentId only — no task/output).
 */
export function accumulateGraphNodeSpawnedRecord(
  spawnNodesByLease: Map<string, SpawnNodeFold>,
  data: Record<string, unknown>,
): void {
  const graphId = asString(data.graphId);
  const nodeId = asString(data.nodeId);
  // A record missing its node identity is not a reconstructable leaf — drop it
  // (the capability-fold's neither-leaseId-nor-rootRunId precedent).
  if (graphId === undefined || nodeId === undefined) return;
  const leaseId = `${graphId}:${nodeId}`;
  if (spawnNodesByLease.has(leaseId)) return; // one leaf per node (idempotent re-emit)
  const rootRunId = asString(data.rootRunId) ?? "";
  spawnNodesByLease.set(leaseId, {
    leaseId,
    // Nest under the graph's tree root so the node renders as the root's child,
    // not a detached top-level leaf. Omit when the root is unknown.
    ...(rootRunId !== "" ? { parentLeaseId: rootRunId } : {}),
    rootRunId,
    // The node's CHILD agent rides `data.nodeAgentId` (the translator's non-
    // correlation field) — the envelope agentId is the emitting coordinator, not
    // the child, so we must read the child identity from data.
    agentId: asString(data.nodeAgentId) ?? "",
    caps: ["orch:graph"],
    toolsInvoked: [],
    denials: [],
  } satisfies SpawnNodeFold);
}

// ---------------------------------------------------------------------------
// Schema-validated LAST-wins folds (W3 context.budget / LAT-04 prompt_timeout).
// ---------------------------------------------------------------------------

/**
 * Validate one `context.budget` record (W3 — the per-call budget equation from
 * the LCD pre-flight) wholesale; return the parsed value or `undefined` (a
 * malformed/partial record is ignored — forward-compatible). The caller keeps
 * the LAST successful parse (the terminal fit check explains the end state).
 */
export function parseContextBudgetRecord(
  data: Record<string, unknown>,
): IncidentContextBudget | undefined {
  const parsed = IncidentContextBudgetSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Validate one `execution.prompt_timeout` record (LAT-04 — the terminal
 * prompt-timeout attribution) wholesale; return the parsed value or `undefined`
 * (the context.budget discipline, T-177-17 — pre-extension timeoutMs-only rows
 * still parse, every other field optional). The caller keeps the LAST parse.
 */
export function parsePromptTimeoutRecord(
  data: Record<string, unknown>,
): IncidentPromptTimeout | undefined {
  const parsed = IncidentPromptTimeoutSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}
