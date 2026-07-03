// SPDX-License-Identifier: Apache-2.0
/**
 * Content-free record folds for the `comis explain` normalizer (`toIncidentSignals`).
 *
 * Extracted from `obs-explain-signals.ts` (which sits at the 500-line
 * `obs-handlers/*` subdir cap) — the same record-handler extraction discipline
 * the image/vision/video/voice folds used (`obs-explain-voice-fold.ts`). Houses
 * the pure reductions that turn one trajectory record's `data` into an
 * `IncidentSignals` field:
 *   - `accumulateLearningRecord` / `buildLearningSignal` — the
 *     learning outcome-signal block from `learning.outcome_observed` records.
 *   - `accumulateToolSchemaRecord` — the tool-schema-rejection
 *     block from `execution.tool_schema_unsupported` records.
 *
 * Every fold is content-free by construction: it reads ONLY ids / closed enums /
 * counts / booleans, dropping any off-vocabulary value (defence-in-depth — a
 * smuggled enum/body never enters the verdict surface).
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
// The learning outcome-signal fold.
// ---------------------------------------------------------------------------

/** The reconstructed learning block (the non-optional shape of the signal). */
export type IncidentLearningSignal = NonNullable<IncidentSignals["learning"]>;

type LearningOutcome = NonNullable<IncidentLearningSignal["outcome"]>;
type LearningSource = IncidentLearningSignal["sources"][number];

const LEARNING_OUTCOMES: readonly LearningOutcome[] = ["success", "failure", "corrected", "unknown"];
const LEARNING_SOURCES: readonly LearningSource[] = ["tool", "pipeline", "correction", "judge", "reaction", "explicit"];

/**
 * The mutable fold state accumulated across the session's learning records:
 * the `learning.outcome_observed` outcome/source signal PLUS the
 * skill-invocation signal (`skill.prompt_invoked`) and the reflection funnel
 * (`reflect.admitted` / `reflect.funnel` — they contribute the
 * BENIGN abstain flag). `count` gates whether ANY learning-family record was seen
 * (an absent block ⇒ `undefined`), so it bumps for every fold — outcome AND
 * reflection — not just outcome records.
 */
export interface LearningFoldState {
  count: number;
  outcome?: LearningOutcome;
  /**
   * Whether ANY record in the session resolved to a non-`unknown` outcome. The
   * `outcome_unresolved` verdict means "NO signal tier resolved an outcome" — so it
   * must key on "ever resolved", NOT the LAST record (a trailing no-signal turn, e.g.
   * a tool-less recall reply, otherwise clobbers an earlier resolved success and the
   * session is wrongly flagged unresolved — a live-incident regression guard).
   */
  everResolved: boolean;
  sources: Set<LearningSource>;
  /** Distinct learned-skill ids invoked this session (`skill.prompt_invoked`). IDs only. */
  skillsUsed: Set<string>;
  /** A record carried the BENIGN synthesis-abstain signal (Defer ≠ Retry). */
  synthesisAbstained: boolean;
  /** Candidate→active promotions summed this session (`learning.skill_promoted`). Counts only. */
  skillsPromoted: number;
  /** Skill demotions summed this session (`learning.skill_demoted`). Counts only. */
  skillsDemoted: number;
  /** Memories that accrued a corroborated failure this session (`learning.memory_failure_attributed`). Counts only — eviction precursor. */
  failuresAttributed: number;
  /** Surfaced-but-uncredited reuse NEAR-MISSES (`memory.skill_surfaced`) — skill name → best
   *  coverage seen this session. Does NOT bump `count`/`everResolved` (telemetry-only; must not perturb
   *  the outcome_unresolved verdict), so it surfaces only when a real learning record already built the block. */
  skillsSurfacedButUncredited: Map<string, number>;
  /** The NAMES of skills demoted this session (`learning.skill_demoted.demotedSkillNames`) — so
   *  `explain` answers WHICH skill demoted, not just how many. Ids only. */
  skillsDemotedNames: Set<string>;
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
    skillsSurfacedButUncredited: new Map(),
    skillsDemotedNames: new Set(),
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
    // last record) is what `outcomeResolved` keys on.
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
 * the surface). Bumps `count` (a skill-only session still
 * yields a learning block).
 */
export function accumulateSkillInvokedRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  if (typeof data.skillName === "string") state.skillsUsed.add(data.skillName);
  readAbstainSignal(state, data);
}

/**
 * Fold one `memory.skill_used` record's `data` into the state (mutating): the per-turn
 * attributed `usedSkillIds` join `skillsUsed` (deduped). IDS ONLY — non-string entries are
 * dropped (a body smuggled as an id never enters the surface).
 *
 * A reuse via INLINE skill-surfacing credits the
 * skill through `memory:skill_used` → `outcome_events.used_skill_ids` (the topic-match path), NOT
 * an explicit `skill.prompt_invoked` file-read — without this fold `skillsUsed` is `[]` while
 * `skillsPromoted>0` (an internally-inconsistent explain view; the credit is visible only via a DB
 * hand-join). With `memory:skill_used` trajectory-bridged, this surfaces the credited skill ids on
 * `explain`. Bumps `count` (a skill-only session still yields a learning block).
 */
export function accumulateSkillUsedRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  if (Array.isArray(data.usedSkillIds)) {
    for (const id of data.usedSkillIds) {
      if (typeof id === "string") state.skillsUsed.add(id);
    }
  }
  readAbstainSignal(state, data);
}

/**
 * Fold one `memory.skill_surfaced` record's `data` into the state
 * (mutating): record the UNCREDITED entries (the reuse near-misses — a skill that
 * overlapped the turn but missed the credit bar) by NAME → best `coverage` seen. So `explain` can
 * answer "why wasn't my skill reused?" (it surfaced at coverage 0.45) instead of a debugger.
 *
 * Deliberately does NOT bump `count` or touch `everResolved`/`outcome`: this census fires on most
 * turns, and forcing a learning block (with outcomeResolved=false) onto sessions that had none could
 * perturb the `outcome_unresolved` verdict. Near-misses therefore surface only when a real learning
 * record (skill_used/promote/outcome) already built the block — exactly the reuse-investigation case.
 * Names/numbers only; non-string names and non-number coverage are dropped.
 */
export function accumulateSkillSurfacedRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  if (!Array.isArray(data.scores)) return;
  for (const s of data.scores) {
    if (s === null || typeof s !== "object") continue;
    const score = s as { name?: unknown; coverage?: unknown; credited?: unknown };
    if (score.credited === true) continue; // credited skills are already in skillsUsed
    if (typeof score.name !== "string") continue;
    const coverage = typeof score.coverage === "number" && Number.isFinite(score.coverage) ? score.coverage : 0;
    const prior = state.skillsSurfacedButUncredited.get(score.name);
    if (prior === undefined || coverage > prior) state.skillsSurfacedButUncredited.set(score.name, coverage);
  }
}

/**
 * Fold one reflection-funnel record's `data` into the state (mutating —
 * handles BOTH `reflect.admitted`
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
 * (mutating; COUNTS ONLY). `data.count` is the number promoted/demoted this resolve;
 * bump the matching tally + `count`. With `skill.prompt_invoked`
 * (already folded into `skillsUsed`) this makes the reuse→promote chain readable on the per-session
 * learning block — `comis explain <session>` shows "used skill X → promoted N" in one call instead of
 * a trajectory + outcome_events + mental_models hand-join. A non-numeric `count` is read as 0.
 */
export function accumulateSkillTransitionRecord(
  state: LearningFoldState,
  data: Record<string, unknown>,
  direction: "promoted" | "demoted",
): void {
  state.count += 1;
  const n = typeof data.count === "number" && Number.isFinite(data.count) ? data.count : 0;
  if (direction === "promoted") state.skillsPromoted += n;
  else {
    state.skillsDemoted += n;
    // Collect WHICH skills demoted (names; ids only — non-string entries dropped).
    if (Array.isArray(data.demotedSkillNames)) {
      for (const name of data.demotedSkillNames) if (typeof name === "string") state.skillsDemotedNames.add(name);
    }
  }
  readAbstainSignal(state, data);
}

/**
 * Fold one `learning.memory_failure_attributed` record's `data` into the state (mutating;
 * COUNTS ONLY). `data.count` is the number of memories that accrued a CORROBORATED failure this
 * resolve (the eviction-causation precursor — eviction needs failure_count >= floor); bump
 * `failuresAttributed` + `count`. A non-numeric `count` is read as 0.
 */
export function accumulateMemoryFailureRecord(state: LearningFoldState, data: Record<string, unknown>): void {
  state.count += 1;
  const n = typeof data.count === "number" && Number.isFinite(data.count) ? data.count : 0;
  state.failuresAttributed += n;
  readAbstainSignal(state, data);
}

/**
 * Build the `IncidentSignals["learning"]` block from the fold, or `undefined`
 * when no learning record was seen (absent ⇒ omitted from the report).
 * `outcomeResolved` is true ONLY when a terminal outcome exists and is NOT
 * `"unknown"` (the fail-closed coverage rule — an unresolved/unknown finish is
 * the `outcome_unresolved` verdict's trigger).
 *
 * `skillFailures`: the session's used skills surface as failures when the
 * terminal outcome is `failure`/`corrected` — "a learned procedure was used in a
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
    skillFailures: outcomeFailed ? skillsUsed : [],
    synthesisAbstained: state.synthesisAbstained,
    // Additive — present only when a promote/demote fired this session (keeps schemaVersion 1).
    ...(state.skillsPromoted > 0 ? { skillsPromoted: state.skillsPromoted } : {}),
    ...(state.skillsDemoted > 0 ? { skillsDemoted: state.skillsDemoted } : {}),
    // Additive — the demoted skill NAMES (which), present only when ≥1 named demote folded.
    ...(state.skillsDemotedNames.size > 0 ? { skillsDemotedNames: [...state.skillsDemotedNames] } : {}),
    // Additive — present only when a corroborated failure accrued this session.
    ...(state.failuresAttributed > 0 ? { failuresAttributed: state.failuresAttributed } : {}),
    // Additive — the reuse near-misses (uncredited surfaced skills), best coverage desc.
    // Present only when ≥1 near-miss was seen (and the block exists at all — count>0 from a real record).
    ...(state.skillsSurfacedButUncredited.size > 0
      ? {
          skillsSurfacedButUncredited: [...state.skillsSurfacedButUncredited.entries()]
            .map(([name, coverage]) => ({ name, coverage }))
            .sort((a, b) => b.coverage - a.coverage),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The tool-schema-rejection fold (`execution.tool_schema_unsupported`).
// ---------------------------------------------------------------------------

const TOOL_SCHEMA_REASONS = ["stripped", "nothing_to_strip", "gate_closed"] as const;

/**
 * Build the `IncidentSignals["toolSchemaUnsupported"]` block from one
 * `execution.tool_schema_unsupported` record's `data` (LAST record wins — the
 * caller assigns it each time, so the terminal repair state explains the end).
 * Content-free (tool + keyword NAMES only; string-array + exact-true reads
 * drop smuggled payload). The reason is narrowed to its closed
 * vocabulary (off-vocabulary → undefined so a reason-less record stays readable).
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
// The spend kill-switch breach fold.
// ---------------------------------------------------------------------------

/**
 * Fold one `spend.exceeded` trajectory record
 * (translateSpendPayload → `{scope, spentUsd, capUsd, estUsd}`, content-free) into
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
// The capability.audited spawn-tree fold.
// ---------------------------------------------------------------------------

/** The reconstructed spawn-tree node (the non-optional element shape). Re-derived
 *  from IncidentSignals (already imported) so this fold does NOT import the
 *  internal Acc / SpawnNode from obs-explain-signals-acc.ts — that file imports
 *  LearningFoldState from HERE, so the reverse import would be a cycle. */
type SpawnNodeFold = NonNullable<IncidentSignals["spawnTree"]>[number];

/**
 * Fold one `capability.audited` trajectory record (the per-cap audit
 * emitted at the gate chokepoint — the spawn-tree's per-node source) into the
 * lease-keyed `spawnNodesByLease` working map. Group by leaseId into ONE node per
 * lease; an in-process record (no real lease) keys on its synthetic rootRunId
 * (NEVER a fabricated lease-<id>). The node collects the attenuated caps it held
 * (deduped), the tool NAMES it invoked, and any CapabilityDeniedError cap (a
 * `deny` decision → denials[]). The record is content-free by
 * construction (the translator strips bodies/args); agentId rides the envelope
 * (`rec.agentId`, with the first-seen `accAgentId` fallback). budgetTokensUsed is
 * honestly omitted unless the record carries it (the live whoami is the
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
  // Group by leaseId, falling back to the synthetic rootRunId for the
  // lease-less in-process leg. A record carrying NEITHER is not a
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
  // Intentional forward-scaffolding — no producer emits budgetTokensUsed on
  // a capability.audited record today (the live `whoami` owns remaining budget;
  // this fold is post-mortem topology). The optional read stays so a future
  // per-node budget producer needs no fold change; it is `undefined` until then.
  const budgetTokensUsed = asNumber(data.budgetTokensUsed);
  if (budgetTokensUsed !== undefined) node.budgetTokensUsed = budgetTokensUsed;
  spawnNodesByLease.set(leaseId, node);
}

/**
 * Fold one `graph.node_spawned` trajectory record into the
 * spawn-tree working map. A graph DAG node spawns in-process (gatedSpawn →
 * subAgentRunner.spawn), so it never crosses the socket chokepoint that emits
 * `capability.audited` — and every node shares the graph's `rootRunId`, so the
 * capability fold's `leaseId ?? rootRunId` key would collapse them all into ONE
 * node. So graph nodes get their OWN key: the stable `graphId:nodeId` identity
 * (NOT a fabricated socket lease — never fabricate one; this is a graph-node id that
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
// Schema-validated LAST-wins folds (context.budget / prompt_timeout).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The orchestrate run-summary + per-run tool-call folds (EXPLAIN-03/04, SAVE-02).
// ---------------------------------------------------------------------------

/** The run skeleton the `orchestrate.run_summary` fold accumulates (one per
 *  runId). Derived from IncidentSignals (already imported) so this fold does NOT
 *  import the internal Acc from obs-explain-signals-acc.ts — that file imports
 *  from HERE, so the reverse would cycle. `toolCalls` is joined at materialization
 *  from the per-run leaseId tally, so the fold state OMITS it (ids + closed enums +
 *  counts + savings only). */
export type OrchestrateRunFold = Omit<NonNullable<IncidentSignals["orchestrate"]>[number], "toolCalls">;

/** One tallied per-run tool call (tool NAME + capability + the closed decision +
 *  a running count) — the inner-map value of `orchestrateToolCallsByLease`. */
export type OrchestrateToolCallFold = NonNullable<IncidentSignals["orchestrate"]>[number]["toolCalls"][number];

const ORCHESTRATE_FAILURE_CLASSES = ["timeout", "stdout_cap", "nonzero_exit", "spawn_fail", "lease_absent"] as const;

/**
 * Fold one `orchestrate.run_summary` trajectory record into the run-keyed
 * `orchestrateRunsByRunId` working map (one skeleton per `runId`, FIRST-SEEN kept —
 * a duplicate re-emit is idempotent). Builds the content-free run skeleton from the
 * record's `data` (the translator forwards ids + the closed `failureClass` enum +
 * counts + token estimates; agentId/sessionKey/stderr never cross). `outcome` is
 * derived from `exitCode` (0 → success, else failure) — a `lease_absent` run may
 * ride a clean exit-0 (still outcome:success). A record with NO `runId` is not a
 * reconstructable run — dropped (the accumulateCapabilityAuditedRecord malformed→drop
 * precedent). `savings` is carried only when BOTH `estSavedTokens` and `savedRatio`
 * are present (a sub-threshold run has neither). `toolCalls` are NOT set here — they
 * are joined at materialization from the per-run leaseId tally (accumulateOrchestrateToolCall).
 *
 * Mutates the passed map (the learning-fold delegation mold); typed structurally to
 * avoid importing the internal Acc (no cycle).
 */
export function accumulateOrchestrateRunSummaryRecord(
  orchestrateRunsByRunId: Map<string, OrchestrateRunFold>,
  data: Record<string, unknown>,
): void {
  const runId = asString(data.runId);
  if (runId === undefined) return; // malformed → drop (never a junk run)
  if (orchestrateRunsByRunId.has(runId)) return; // first-seen kept (idempotent re-emit)
  const exitCode = asNumber(data.exitCode) ?? 0;
  const failureClass = narrow(ORCHESTRATE_FAILURE_CLASSES, data.failureClass);
  const leaseId = asString(data.leaseId);
  const estSavedTokens = asNumber(data.estSavedTokens);
  const savedRatio = asNumber(data.savedRatio);
  orchestrateRunsByRunId.set(runId, {
    runId,
    ...(leaseId !== undefined ? { leaseId } : {}),
    outcome: exitCode === 0 ? "success" : "failure",
    durationMs: asNumber(data.durationMs) ?? 0,
    exitCode,
    ...(failureClass !== undefined ? { failureClass } : {}),
    resultRefs: {
      count: asNumber(data.resultRefCount) ?? 0,
      bytes: asNumber(data.resultRefBytes) ?? 0,
    },
    ...(estSavedTokens !== undefined && savedRatio !== undefined
      ? { savings: { estSavedTokens, savedRatio } }
      : {}),
  } satisfies OrchestrateRunFold);
}

/**
 * Fold one `capability.audited` trajectory record into the per-run tool-call
 * tally `orchestrateToolCallsByLease` — keyed by the record's `leaseId` (the
 * daemon-minted PER-RUN child lease), then by the `${tool}\0${capability}\0${decision}`
 * tuple → a `{tool,capability,decision,count}` running count. This is EXPLAIN-04:
 * because the leaseId is per-run, a `decision:"deny"` groups under THE RUN that made
 * the call, not the assembly. Reads the SAME records the spawn-tree fold sees (called
 * alongside it — no duplicate event). Content-free (tool NAME + capability + the
 * closed allow|deny decision + count only). A record with no `leaseId` (no run
 * correlation), a missing tool/capability, or an off-vocabulary decision is dropped.
 *
 * Mutates the passed map (typed structurally — no Acc import, no cycle).
 */
export function accumulateOrchestrateToolCall(
  orchestrateToolCallsByLease: Map<string, Map<string, OrchestrateToolCallFold>>,
  data: Record<string, unknown>,
): void {
  const leaseId = asString(data.leaseId);
  if (leaseId === undefined) return; // no run correlation → drop
  const tool = asString(data.tool);
  const capability = asString(data.capability);
  const decision = data.decision === "allow" ? "allow" : data.decision === "deny" ? "deny" : undefined;
  if (tool === undefined || capability === undefined || decision === undefined) return;
  const inner = orchestrateToolCallsByLease.get(leaseId) ?? new Map<string, OrchestrateToolCallFold>();
  const key = `${tool} ${capability} ${decision}`;
  const prev = inner.get(key);
  if (prev !== undefined) prev.count += 1;
  else inner.set(key, { tool, capability, decision, count: 1 });
  orchestrateToolCallsByLease.set(leaseId, inner);
}

/**
 * Validate one `context.budget` record (the per-call budget equation from
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
 * Validate one `execution.prompt_timeout` record (the terminal
 * prompt-timeout attribution) wholesale; return the parsed value or `undefined`
 * (the context.budget discipline — timeoutMs-only rows
 * still parse, every other field optional). The caller keeps the LAST parse.
 */
export function parsePromptTimeoutRecord(
  data: Record<string, unknown>,
): IncidentPromptTimeout | undefined {
  const parsed = IncidentPromptTimeoutSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}
