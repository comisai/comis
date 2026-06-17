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

import type { IncidentSignals } from "@comis/core";
// The content-free readers live in the sibling fields helper (one source of truth);
// imported here so the GBNF fold reuses them rather than re-deriving (no cycle —
// the fields helper does not import this module).
import { asStringArray } from "./obs-explain-signals-fields.js";

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

/** The mutable fold state accumulated across `learning.outcome_observed` records. */
export interface LearningFoldState {
  count: number;
  outcome?: LearningOutcome;
  sources: Set<LearningSource>;
}

/** A fresh, empty fold state (no learning records seen yet). */
export function emptyLearningFold(): LearningFoldState {
  return { count: 0, sources: new Set() };
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
  if (outcome !== undefined) state.outcome = outcome;
  const source = narrow(LEARNING_SOURCES, data.source);
  if (source !== undefined) state.sources.add(source);
}

/**
 * Build the `IncidentSignals["learning"]` block from the fold, or `undefined`
 * when no learning record was seen (absent ⇒ omitted from the report).
 * `outcomeResolved` is true ONLY when a terminal outcome exists and is NOT
 * `"unknown"` (the fail-closed coverage rule — an unresolved/unknown finish is
 * the `outcome_unresolved` verdict's trigger). Counts/ids/closed enums only.
 */
export function buildLearningSignal(state: LearningFoldState): IncidentLearningSignal | undefined {
  if (state.count === 0) return undefined;
  return {
    outcomeResolved: state.outcome !== undefined && state.outcome !== "unknown",
    ...(state.outcome !== undefined ? { outcome: state.outcome } : {}),
    sources: [...state.sources],
    skillsUsed: [],
    skillFailures: [],
    synthesisAbstained: false,
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
