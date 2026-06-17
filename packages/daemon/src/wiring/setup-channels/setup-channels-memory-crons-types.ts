// SPDX-License-Identifier: Apache-2.0
/**
 * Shared types for the memory-cron sentinel handlers.
 *
 * Extracted into a types-only leaf so both setup-channels-memory-crons.ts (the
 * LLM/keyless sentinels) and setup-channels-memory-crons-wire.ts (the WS7-wired
 * __USEFULNESS_JUDGE__ / __MEMORY_TRIPLE_EXTRACTION__ sentinels) can import the
 * context shape WITHOUT a runtime cycle between those two files (the main file
 * delegates its fall-through to the wire file).
 *
 * @module
 */

import type { AppContainer, ClockPort, MemoryConsolidationStore, TripleStorePort, UserRepresentationStore, RelationshipStore, TunedAlphaStore, MemoryUsefulnessStore, MemoryLifecyclePort, LearnedSkillStorePort, SkillValidationPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { MemoryApi } from "@comis/memory";
import type { SynthesisSourceTrajectory, SkillApprovalGate } from "@comis/agent";

/**
 * The closed-graph skill-synthesis injectables for the __SKILL_SYNTHESIS__ sentinel
 * (SKILL-08/09). Assembled DAEMON-SIDE (registerCronEventListeners, setup-channels-
 * credentials.ts — the SOLE composition root that may import @comis/memory +
 * @comis/skills + @comis/agent together) and threaded here so the handler injects
 * the real adapters into `runSkillSynthesis` (which consumes @comis/core PORT TYPES
 * only — the agent↛memory/skills build cut). Absent ⇒ the sentinel cannot run
 * (off-by-default, so a default-config agent never reaches it).
 */
export interface SkillSynthesisCronDeps {
  /** The @comis/memory learned-skill store (the admit target), built on the shared db handle. */
  learnedSkillStore: Pick<LearnedSkillStorePort, "admit">;
  /** Build the @comis/skills sandbox validation adapter for an agent (injects its tool list + policy). */
  buildValidationAdapter: (agentId: string) => Promise<Pick<SkillValidationPort, "validate">>;
  /** Build the LCD-merged source trajectories (buildReviewSessionSource — NOT sessionStore.listDetailed). */
  buildSourceTrajectories: (agentId: string, tenantId: string) => Promise<SynthesisSourceTrajectory[]>;
  /** The mutating-admission approval gate (the daemon's shared ApprovalGate). */
  approvalGate: SkillApprovalGate;
}

/** The minimal `scheduler:job_result` payload shape the sentinel handlers read. */
export interface MemoryCronPayload {
  result?: string;
  agentId?: string;
  onComplete?: (result: { status: "ok" | "error"; error?: string }) => void;
}

/** Closure-captured context the sentinel handlers need (a subset of the deps). */
export interface MemoryCronContext {
  container: AppContainer;
  logger: ComisLogger;
  clock: ClockPort;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- container.config.agents PerAgentConfig map (erased at the dispatch boundary)
  agents: Record<string, any>;
  tenantId?: string;
  // All stores below are injected from setup-memory on the shared db; the agent
  // receives the port TYPE only (the agent↛memory cut). Each backs the named sentinel.
  /** The inductive applyConsolidation write (__MEMORY_CONSOLIDATION__). */
  consolidationStore?: MemoryConsolidationStore;
  /** The deductive trust-first upsertTriple write (__MEMORY_REASONING__ + __MEMORY_TRIPLE_EXTRACTION__). */
  tripleStore?: TripleStorePort;
  /** The per-user profile upsert write (__USER_REPRESENTATION__). */
  userRepresentationStore?: UserRepresentationStore;
  /** The per-(tenant, agent, channel) directional-edge upsert (__SOCIAL_MODELING__). */
  relationshipStore?: RelationshipStore;
  /** The tuned-alpha upsert write the KEYLESS bandit drives (__ONLINE_TUNING__). */
  tunedAlphaStore?: TunedAlphaStore;
  /** The per-memory usefulness store: the READ surface (`readUsefulness`) the
   *  __ONLINE_TUNING__ sentinel scopes the bandit's FEED signal over, AND the WRITE
   *  surface (`recordUsage`) the __USEFULNESS_JUDGE__ sentinel records its verdict through. */
  usefulnessStore?: MemoryUsefulnessStore;
  /** The DORMANT lifecycle sweep the KEYLESS __MEMORY_LIFECYCLE__
   *  sentinel drives (`runLifecycleSweep(scope)`, per (tenant, agent) + injected `now`).
   *  DORMANT — even when enabled the sweep evicts/demotes 0 rows (live policy deferred). */
  memoryLifecycleStore?: MemoryLifecyclePort;
  /** The `inspect` read surface the __USER_REPRESENTATION__ / __SOCIAL_MODELING__
   *  (grouped by channelId) / __ONLINE_TUNING__ (the bounded candidate-id set) /
   *  __USEFULNESS_JUDGE__ + __MEMORY_TRIPLE_EXTRACTION__ sentinels
   *  scope their per-(tenant, agent[, user/channel]) high-trust source reads over. */
  memoryApi?: MemoryApi;
  /** The closed-graph skill-synthesis injectables (the __SKILL_SYNTHESIS__ sentinel, SKILL-08/09).
   *  Assembled daemon-side; the handler injects the store + validation adapter + LCD source into
   *  runSkillSynthesis. Absent ⇒ off-by-default (a default-config agent never reaches the sentinel). */
  skillSynthesis?: SkillSynthesisCronDeps;
}
