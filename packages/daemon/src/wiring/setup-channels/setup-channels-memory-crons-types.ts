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

import type { AppContainer, ClockPort, MemoryConsolidationStore, MemoryLifecyclePort, MentalModelStorePort, OutcomeSignalPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { MemoryApi } from "@comis/memory";
import type { ReflectionSourceTrajectory } from "@comis/agent";

/**
 * The closed-graph REFLECTION injectables for the `__REFLECT__` sentinel (the
 * reflect-engine replacement for the
 * deleted `SkillSynthesisCronDeps`). Assembled DAEMON-SIDE (registerCronEventListeners,
 * setup-channels-credentials.ts — the SOLE composition root that may import
 * @comis/memory + @comis/agent together) and threaded here so the handler injects
 * the real store + source into `runReflection` (which consumes @comis/core PORT
 * TYPES only — the agent↛memory build cut). Absent ⇒ the sentinel cannot run
 * (off-by-default, so a default-config agent never reaches it).
 *
 * DROPPED vs the synthesis bundle: `buildValidationAdapter` (the sandbox adapter —
 * an advisory doc has no executable surface; the only validation is the JOB's
 * static `validateLearnedDocBody`) and `approvalGate` (no mutating-admission
 * gate — removing it removes an attack surface). The reflect ADAPTER is built
 * per-run in the handler (it needs the resolved model/key), like the synthesis one.
 */
export interface ReflectionCronDeps {
  /** The @comis/memory mental-model store. `get` reads the prior doc for delta-ops;
   *  `admit` is the candidate/learned write target; `supersede` is
   *  the bi-temporal history-append a profile/topic CORRECTION routes through (the prior
   *  body is preserved in `history`, never overwritten). Built on the shared db handle. */
  learnedSkillStore: Pick<MentalModelStorePort, "get" | "admit" | "supersede">;
  /** The @comis/memory outcome-signal store (the fail-closed success gate the job selects on). */
  outcomeSignal: Pick<OutcomeSignalPort, "resolve">;
  /**
   * Build the per-KIND source trajectories for the reflection SELECT step (the
   * daemon-side `kind` seam). SKILL sources are OUTCOME trajectories (the
   * LCD-merged review source, buildReviewSessionSource — NOT sessionStore.listDetailed),
   * each carrying a daemon-derived `trustedOrigin` (trust axis 1) + `sourceTrustExternal:false`
   * (axis 2 is N/A for an outcome trajectory). PROFILE/TOPIC sources are built from the
   * agent's high-trust SOURCE MEMORIES (memoryApi.inspect), each carrying `sourceTrustExternal =
   * (trustLevel === "external")` (the per-memory source-trust axis, axis 2). The job
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
   * of skipping for "no API key". Undefined ⇒ no OAuth resolution
   * wired (jobs fall back to static-key/keyless resolution only).
   */
  resolveAccessToken?: (agentId: string, provider: string) => Promise<string | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- container.config.agents PerAgentConfig map (erased at the dispatch boundary)
  agents: Record<string, any>;
  tenantId?: string;
  // All stores below are injected from setup-memory on the shared db; the agent
  // receives the port TYPE only (the agent↛memory cut). Each backs the named sentinel.
  /** Orphaned — the __MEMORY_CONSOLIDATION__ cron and its writer were removed; the store is retired. */
  consolidationStore?: MemoryConsolidationStore;
  // (The cron-context `tripleStore` field was DELETED — its sole reader was the
  //  deleted triple-extraction dispatch branch. The graphSpread recall lane consumes tripleStore
  //  via the SEPARATE setupAgents deps chain, NOT this cron context; the port + lane survive.)
  // (The cron-context `relationshipStore` field — the __SOCIAL_MODELING__ sentinel's directional-edge
  //  upsert — was DELETED with the rest of the social-modeling subsystem.)
  // (The cron-context `usefulnessStore` field was DELETED — its sole reader was
  //  the deleted usefulness-judge dispatch branch. The recordUsage reward write uses
  //  the setup-learning.ts deps, NOT this cron context; that store survives.)
  /** The DORMANT lifecycle sweep the KEYLESS __MEMORY_LIFECYCLE__
   *  sentinel drives (`runLifecycleSweep(scope)`, per (tenant, agent) + injected `now`).
   *  DORMANT — even when enabled the sweep evicts/demotes 0 rows (live policy deferred). */
  memoryLifecycleStore?: MemoryLifecyclePort;
  /** The `inspect` high-trust source read surface — the surviving __REFLECT__ sentinel scopes
   *  its per-(tenant, agent) profile/topic source reads over it (the folded profile/topic read path). (The
   *  __SOCIAL_MODELING__ reader was deleted; the __USEFULNESS_JUDGE__ +
   *  __MEMORY_TRIPLE_EXTRACTION__ readers too — all with their subsystems.) */
  memoryApi?: MemoryApi;
  /** The closed-graph reflection injectables (the `__REFLECT__` sentinel).
   *  Assembled daemon-side; the handler injects the mental-model store + the
   *  trusted-origin LCD source into runReflection. Absent ⇒ off-by-default (a default-config
   *  agent never reaches the sentinel). */
  reflection?: ReflectionCronDeps;
}
