// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { LearningScope } from "./outcome-signal-port.js";
import type { CandidateSkill } from "./skill-synthesis-port.js";

/**
 * SkillValidationPort: the SEGREGATED hexagonal boundary for the v2.26 Verified
 * Learning validation step (WS2 step 5) — it gates a {@link CandidateSkill}
 * through a STATIC safety scan (per-field injection/poison check + mutating /
 * tool-policy classification) and an OPTIONAL DYNAMIC sandbox replay (run the
 * embedded scripts in a fail-closed jail, confirm the effect reproduces), so
 * that ONLY a procedure that is both safe and actually-works can be admitted
 * (design §WS2 step 5 / SKILL-06 + SKILL-07).
 *
 * This is a NEW port. The sole ADAPTER lives in @comis/skills (it owns the
 * `applyToolPolicy` effective-tool-set check and the bwrap sandbox provider —
 * the reason the whole adapter lives there); the synthesis JOB in @comis/agent
 * and the daemon consume this port TYPE only. The agent CANNOT import
 * @comis/skills — the contract lives HERE in @comis/core (the closed-graph
 * SEC-01 cut).
 *
 * This file is type-only (mirrors outcome-signal-port.ts): no zod, no
 * @comis/memory / @comis/skills import. `validate` returns `Result<T, Error>`
 * from @comis/shared — there is no skill-specific error type.
 *
 * @module
 */

/**
 * One finding from a validation run: a single reason a field failed (or warned).
 * Counts/closed-enums + the offending patterns/tool only — never the offending
 * content itself (the privacy convention, SEC-01 §7). A `kind: "static"` finding
 * comes from the per-field safety scan; `"tool-policy"` from an out-of-policy
 * required tool; `"dynamic"` from the sandbox replay.
 */
export interface SkillValidationFinding {
  /** The candidate field the finding is about (`body`, `scripts[i].content`, `description`, …). */
  field: string;
  /** Which check produced it (closed union). */
  kind: "static" | "tool-policy" | "dynamic";
  /** The offending pattern names (NOT the matched text) — present on static findings. */
  patterns?: ReadonlyArray<string>;
  /** The offending tool name — present on tool-policy findings. */
  tool?: string;
}

/**
 * The captured inputs the dynamic sandbox replay needs to re-run the procedure's
 * scripts deterministically (design §WS2 step 5 dynamic). Optional throughout —
 * a read-only candidate with no embedded scripts needs no replay context, and a
 * run with no jail available degrades to `coverage: "static-only"` rather than
 * failing (the honest-degradation posture, SKILL-07).
 */
export interface ReplayContext {
  /** The trajectory's captured inputs the scripts read (ids/values the run replays against). */
  capturedInputs?: Record<string, unknown>;
  /** Optional workspace path the sandbox jails the run into. */
  workspacePath?: string;
}

/**
 * The verdict for one validation run (the verbatim design §WS2 shape).
 *
 * `staticOk` — the per-field safety scan found no CRITICAL pattern AND every
 *   required tool is in policy. `dynamicOk` — the sandbox replay exited cleanly.
 * `reproducedEffect` — the replay reproduced the trajectory's checkable effect.
 * `coverage` is the CLOSED union: `"full"` when the dynamic replay ran (a jail
 *   was available), `"static-only"` when no jail was available (Linux bwrap is
 *   the gate — on a box without it the run honestly degrades, NEVER opens to an
 *   unsandboxed exec, and `dynamicOk` is `false`). `sandboxProvider` records
 *   which jail (or `"none"`) actually ran.
 *
 * The admission gate (Plan 07) admits iff `staticOk && (dynamicOk ||
 * noEmbeddedScripts) && (reproducedEffect || readOnly)` — so a `static-only`
 * coverage admits ONLY a read-only, script-free candidate (fail-closed).
 */
export interface SkillValidationResult {
  /** The static safety scan + tool-policy check passed (no CRITICAL finding). */
  staticOk: boolean;
  /** The dynamic sandbox replay exited cleanly (false when no jail ran). */
  dynamicOk: boolean;
  /** The replay reproduced the trajectory's checkable effect. */
  reproducedEffect: boolean;
  /** Every finding from this run (counts/patterns/tool only — never content). */
  findings: SkillValidationFinding[];
  /** Which sandbox jail ran the dynamic replay (or `"none"` when none was available). */
  sandboxProvider: "bwrap" | "sandbox-exec" | "none";
  /** Closed union — `"full"` when the dynamic replay ran, `"static-only"` when it could not (honest degrade). */
  coverage: "full" | "static-only";
}

export interface SkillValidationPort {
  /**
   * Validate a {@link CandidateSkill} for the given (tenant, agent) `scope`: run
   * the static safety + tool-policy scan, then (when a fail-closed jail is
   * available and the candidate has scripts) the dynamic sandbox replay. Returns
   * `ok(SkillValidationResult)` even when the candidate is unsafe (the verdict's
   * booleans + findings carry the rejection); reserves `err(...)` for an actual
   * validator fault. NEVER throws; no jail → `coverage: "static-only"`,
   * `dynamicOk: false` (honest degradation, not a failure metric — SKILL-07).
   */
  validate(
    skill: CandidateSkill,
    replay: ReplayContext,
    scope: LearningScope,
  ): Promise<Result<SkillValidationResult, Error>>;
}
