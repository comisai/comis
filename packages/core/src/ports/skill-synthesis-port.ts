// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { LearningScope } from "./outcome-signal-port.js";

/**
 * SkillSynthesisPort: the SEGREGATED hexagonal boundary for the v2.26 Verified
 * Learning procedural-synthesis step (WS2) — it transforms a cluster of
 * successful-trajectory text into zero-or-more {@link CandidateSkill}s (a
 * reusable markdown procedure + optional embedded scripts), so that a verified
 * "how to do X" can be distilled from what actually worked (design §WS2 step 4).
 *
 * This is a NEW port — like {@link OutcomeSignalPort} it deliberately does NOT
 * widen the security-reviewed `MemoryPort`. The synthesis ADAPTER lives in
 * @comis/agent (the LLM-backed `llm-skill-synthesis-adapter`); the synthesis
 * JOB consumes this port TYPE only and is invoked DAEMON-SIDE (the daemon
 * injects the adapter). The agent CANNOT import @comis/memory / @comis/skills —
 * defining the contract HERE in @comis/core is what makes that closed-graph cut
 * possible (the structural SEC-01 boundary `architecture-graph.test.ts` pins:
 * `agent = Set(["shared","core","observability","scheduler"])`).
 *
 * This file is type-only (mirrors outcome-signal-port.ts): no zod, no
 * @comis/memory / @comis/skills import. There is no skill-specific error type —
 * `synthesize` returns `Result<T, Error>` from @comis/shared.
 *
 * @module
 */

/**
 * The input to one synthesis call: a cluster of successful trajectories that
 * agree on "how a task was accomplished", flattened to a single text block.
 *
 * SECURITY: `trajectoryText` is UNTRUSTED — it is model/user-authored content
 * the synthesis adapter MUST wrap (`wrapExternalContent`) before it reaches the
 * synthesis LLM (the injection-defense keystone, SKILL-02 / SEC-01). The scope
 * is the load-bearing (tenant, agent) isolation boundary every write rebinds
 * to; `clusterTrajIds` are the opaque source-trajectory ids recorded as
 * provenance on the admitted skill (ids only — never bodies).
 */
export interface SynthesisInput {
  /** The clustered success-trajectory text to distil. UNTRUSTED — wrap before the LLM. */
  trajectoryText: string;
  /** The (tenant, agent) isolation boundary the synthesized skill is written under. */
  scope: LearningScope;
  /** Opaque source-trajectory ids the cluster was built from — recorded as provenance (ids only). */
  clusterTrajIds: ReadonlyArray<string>;
}

/**
 * One synthesized procedure proposed by {@link SkillSynthesisPort.synthesize} —
 * a markdown `body` (the reusable "how to do X" instructions) plus optional
 * embedded `scripts` and the `requiredTools` the procedure exercises. This is a
 * CANDIDATE: it has not yet been validated (static + sandbox) or admitted to the
 * store — the validation port + admission gate decide whether it becomes a
 * persisted `learned_skills` row (Plans 05-07).
 *
 * Content-bearing by nature (the body/scripts ARE the procedure) — it therefore
 * never appears on the counts/ids-only `learning:*` bus events or any log line
 * (the privacy convention, SEC-01 §7). It flows only through the validation +
 * admission path that the daemon injects.
 */
export interface CandidateSkill {
  /** Stable skill name (UNIQUE per (tenant, agent) at the store; the lookup key). */
  name: string;
  /** Short human/agent-readable description of what the procedure does. */
  description: string;
  /** The reusable procedure itself — markdown instructions ("how to do X"). */
  body: string;
  /** Optional embedded scripts the procedure runs (validated in the sandbox before admission). */
  scripts: ReadonlyArray<{ path: string; lang: string; content: string }>;
  /** The tool names the procedure exercises (drives the mutating/read-only + tool-policy checks). */
  requiredTools: ReadonlyArray<string>;
  /** Optional serialized parameter schema (TypeBox/JSON-Schema string) compiled during validation. */
  paramsSchema?: string;
}

export interface SkillSynthesisPort {
  /**
   * Transform a cluster of successful-trajectory text into zero-or-more
   * {@link CandidateSkill}s. A capability-abstaining or budget-exceeded run
   * returns `ok([])` (a BENIGN skip — Defer ≠ Retry, no failure metric, no
   * breaker trip, SKILL-05). The adapter wraps the untrusted `trajectoryText`
   * before the LLM and NEVER throws — any failure is surfaced as `err(...)`.
   */
  synthesize(input: SynthesisInput): Promise<Result<CandidateSkill[], Error>>;
}
