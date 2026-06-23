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
 * P2 procedural-skill signals (`skill.prompt_invoked` / `learning.skill_validated`
 * / `learning.skill_synthesized`). `count` gates whether ANY learning-family
 * record was seen (an absent block ⇒ `undefined`), so it bumps for every fold —
 * outcome AND skill — not just outcome records.
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
  /** A `learning.skill_validated` record reported a static/dynamic FAILURE this run. */
  validationFailed: boolean;
  /** A record carried the BENIGN synthesis-abstain signal (Defer ≠ Retry). */
  synthesisAbstained: boolean;
  /**
   * REVISE- (Phase 203): the total user-model belief-slots touched this run
   * (superseded + corroborated + inserted), summed across the daemon's per-user
   * `learning.user_model_revised` records. Count only — no profile body.
   */
  userModelRevised: number;
  /**
   * GENERAL- (Phase 203): higher-order generalizations written this run, from the
   * daemon's `learning.memory_generalized` records. Count only — no memory body.
   */
  memoriesGeneralized: number;
}

/** A fresh, empty fold state (no learning records seen yet). */
export function emptyLearningFold(): LearningFoldState {
  return {
    count: 0,
    everResolved: false,
    sources: new Set(),
    skillsUsed: new Set(),
    validationFailed: false,
    synthesisAbstained: false,
    userModelRevised: 0,
    memoriesGeneralized: 0,
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
 * Fold one `learning.skill_validated` record's `data` into the state (mutating):
 * a static OR dynamic validation FAILURE (`staticOk === false || dynamicOk ===
 * false`) flags `validationFailed`, so the session's used skills surface as
 * `skillFailures` (the record itself carries NO id — verdict booleans + a
 * coverage enum only; SEC-01). Bumps `count`.
 */
export function accumulateSkillValidatedRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  if (data.staticOk === false || data.dynamicOk === false) state.validationFailed = true;
  readAbstainSignal(state, data);
}

/**
 * Fold one `learning.skill_synthesized` record's `data` into the state
 * (mutating): the only signal it contributes is the BENIGN abstain flag (the
 * payload is a count only). Bumps `count`.
 */
export function accumulateSkillSynthesizedRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  readAbstainSignal(state, data);
}

/**
 * Fold one `learning.user_model_revised` record's `data` into the state
 * (mutating; REVISE-/OBS-02, Phase 203): the per-slot revision counts
 * (`superseded` + `corroborated` + `inserted`) SUM into `userModelRevised` (the
 * total belief-slots the daemon touched this run; the daemon emits one record per
 * cron firing — additive across firings within a session). Numeric reads ONLY —
 * a smuggled `content`/`entryType`/`sourceId` is never read (SEC-01 / T-203-leak).
 * Bumps `count` (a revision-only session still yields a learning block).
 */
export function accumulateUserModelRevisedRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  const superseded = typeof data.superseded === "number" ? data.superseded : 0;
  const corroborated = typeof data.corroborated === "number" ? data.corroborated : 0;
  const inserted = typeof data.inserted === "number" ? data.inserted : 0;
  state.userModelRevised += superseded + corroborated + inserted;
}

/**
 * Fold one `learning.memory_generalized` record's `data` into the state
 * (mutating; GENERAL-/OBS-02, Phase 203): `generalized` (higher-order memories
 * written) accumulates into `memoriesGeneralized`. Numeric read ONLY — a smuggled
 * memory `body` is never read (SEC-01 / T-203-leak). Bumps `count`.
 */
export function accumulateMemoryGeneralizedRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  if (typeof data.generalized === "number") state.memoriesGeneralized += data.generalized;
}

/**
 * Build the `IncidentSignals["learning"]` block from the fold, or `undefined`
 * when no learning record was seen (absent ⇒ omitted from the report).
 * `outcomeResolved` is true ONLY when a terminal outcome exists and is NOT
 * `"unknown"` (the fail-closed coverage rule — an unresolved/unknown finish is
 * the `outcome_unresolved` verdict's trigger).
 *
 * `skillFailures` (P2): the session's used skills surface as failures when the
 * terminal outcome is `failure`/`corrected` OR a `skill_validated` record
 * reported a validation failure — "a learned procedure was used in a
 * failed/corrected trajectory" (the `learned_skill_failing` verdict's trigger).
 * Counts/ids/closed enums only — no body/script crosses the surface.
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
    skillFailures: outcomeFailed || state.validationFailed ? skillsUsed : [],
    synthesisAbstained: state.synthesisAbstained,
    // REVISE-/GENERAL- (Phase 203): the optional revision/generalization counts —
    // present only when the activity happened (zero ⇒ omitted, so the frozen
    // P0..P2 fixtures gain no field). Counts only (SEC-01).
    ...(state.userModelRevised > 0 ? { userModelRevised: state.userModelRevised } : {}),
    ...(state.memoriesGeneralized > 0 ? { memoriesGeneralized: state.memoriesGeneralized } : {}),
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
