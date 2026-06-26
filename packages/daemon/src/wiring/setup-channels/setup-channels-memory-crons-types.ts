// SPDX-License-Identifier: Apache-2.0
/**
 * Shared types for the memory-cron sentinel handlers.
 *
 * Extracted into a types-only leaf so both setup-channels-memory-crons.ts (the
 * LLM/keyless sentinels) and setup-channels-memory-crons-wire.ts (the KEYLESS
 * __MEMORY_LIFECYCLE__ sweep + the __REFLECT__ engine) can import the context shape
 * WITHOUT a runtime cycle between those two files (the main file delegates its
 * fall-through to the wire file).
 *
 * @module
 */

import type { AppContainer, ClockPort, MemoryConsolidationStore, TripleStorePort, RelationshipStore, MemoryLifecyclePort, MentalModelStorePort, OutcomeSignalPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { MemoryApi } from "@comis/memory";
import type { ReflectionSourceTrajectory } from "@comis/agent";

/**
 * The closed-graph REFLECTION injectables for the `__REFLECT__` sentinel (v2.31
 * Reflection, Phase 223, REFLECT-01/02 — the reflect-engine replacement for the
 * deleted `SkillSynthesisCronDeps`). Assembled DAEMON-SIDE (registerCronEventListeners,
 * setup-channels-credentials.ts — the SOLE composition root that may import
 * @comis/memory + @comis/agent together) and threaded here so the handler injects
 * the real store + source into `runReflection` (which consumes @comis/core PORT
 * TYPES only — the agent↛memory build cut). Absent ⇒ the sentinel cannot run
 * (off-by-default, so a default-config agent never reaches it).
 *
 * DROPPED vs the synthesis bundle: `buildValidationAdapter` (the sandbox adapter —
 * an advisory doc has no executable surface; the only validation is the JOB's
 * static `validateLearnedDocBody`, INV-3) and `approvalGate` (no mutating-admission
 * gate — removing it removes an attack surface). The reflect ADAPTER is built
 * per-run in the handler (it needs the resolved model/key), like the synthesis one.
 */
export interface ReflectionCronDeps {
  /** The @comis/memory mental-model store. `get` reads the prior doc for delta-ops;
   *  `admit` is the candidate/learned write target; `supersede` (Phase 225 FOLD-01) is
   *  the bi-temporal history-append a profile/topic CORRECTION routes through (the prior
   *  body is preserved in `history`, never overwritten). Built on the shared db handle. */
  learnedSkillStore: Pick<MentalModelStorePort, "get" | "admit" | "supersede">;
  /** The @comis/memory outcome-signal store (the fail-closed success gate the job selects on). */
  outcomeSignal: Pick<OutcomeSignalPort, "resolve">;
  /**
   * Build the per-KIND source trajectories for the reflection SELECT step (Phase 225
   * FOLD — the daemon-side `kind` seam). SKILL sources are OUTCOME trajectories (the
   * LCD-merged review source, buildReviewSessionSource — NOT sessionStore.listDetailed),
   * each carrying a daemon-derived `trustedOrigin` (INV-5/D-04 axis 1) + `sourceTrustExternal:false`
   * (axis 2 is N/A for an outcome trajectory). PROFILE/TOPIC sources are built from the
   * agent's high-trust SOURCE MEMORIES (memoryApi.inspect), each carrying `sourceTrustExternal =
   * (trustLevel === "external")` (FOLD-04 axis 2 — the old user-rep layer-1 firewall). The job
   * filters on BOTH axes.
   */
  buildSourceTrajectories: (
    kind: "skill" | "profile" | "topic",
    agentId: string,
    tenantId: string,
  ) => Promise<ReflectionSourceTrajectory[]>;
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
  /**
   * Resolve a per-agent OAuth access token for a provider (auto-refreshing),
   * threaded from the daemon's per-agent OAuthTokenManager map. Lets the
   * background jobs run on an OAuth main provider (e.g. openai-codex) instead
   * of skipping for "no API key" (LEARN-01). Undefined ⇒ no OAuth resolution
   * wired (jobs fall back to static-key/keyless resolution only).
   */
  resolveAccessToken?: (agentId: string, provider: string) => Promise<string | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- container.config.agents PerAgentConfig map (erased at the dispatch boundary)
  agents: Record<string, any>;
  tenantId?: string;
  // All stores below are injected from setup-memory on the shared db; the agent
  // receives the port TYPE only (the agent↛memory cut). Each backs the named sentinel.
  /** Orphaned in Phase 225-05 (the __MEMORY_CONSOLIDATION__ cron + its writer were deleted); retired in 226. */
  consolidationStore?: MemoryConsolidationStore;
  /** The deductive trust-first upsertTriple write (__MEMORY_TRIPLE_EXTRACTION__). */
  tripleStore?: TripleStorePort;
  /** The per-(tenant, agent, channel) directional-edge upsert (__SOCIAL_MODELING__). */
  relationshipStore?: RelationshipStore;
  // (The cron-context `usefulnessStore` field was DELETED in Phase 226-03 — its sole reader was
  //  the deleted usefulness-judge dispatch branch. The FORGET-02 recordUsage reward write uses
  //  the setup-learning.ts deps, NOT this cron context; that store survives.)
  /** The DORMANT lifecycle sweep the KEYLESS __MEMORY_LIFECYCLE__
   *  sentinel drives (`runLifecycleSweep(scope)`, per (tenant, agent) + injected `now`).
   *  DORMANT — even when enabled the sweep evicts/demotes 0 rows (live policy deferred). */
  memoryLifecycleStore?: MemoryLifecyclePort;
  /** The `inspect` read surface the __SOCIAL_MODELING__ sentinel (grouped by channelId)
   *  scopes its per-(tenant, agent, channel) high-trust source reads over. (The
   *  __USEFULNESS_JUDGE__ + __MEMORY_TRIPLE_EXTRACTION__ readers were deleted in Phase 226-03.) */
  memoryApi?: MemoryApi;
  /** The closed-graph reflection injectables (the `__REFLECT__` sentinel, v2.31 Reflection,
   *  REFLECT-01/02). Assembled daemon-side; the handler injects the mental-model store + the
   *  trusted-origin LCD source into runReflection. Absent ⇒ off-by-default (a default-config
   *  agent never reaches the sentinel). */
  reflection?: ReflectionCronDeps;
}
