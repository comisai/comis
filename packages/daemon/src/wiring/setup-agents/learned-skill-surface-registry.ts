// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent learned-skill SURFACE-cache registry.
 *
 * The surface cache is a local in `setupSingleAgent` (setup-agents-runtime.ts), but
 * the promote/demote loop that should re-refresh it on a state change lives in
 * `wireLearningOutcome` (setup-learning.ts) — and that wiring is stood up BEFORE the
 * agents (setup-memory.ts runs first). The two cannot reference each other directly.
 *
 * This registry is the shared seam: created once in daemon.ts and threaded into BOTH
 * subsystems. Each agent REGISTERS its surface cache + an async refresh closure at
 * boot; the resolve-seam loop calls `refresh(agentId)` after a promote/demote
 * actually moved a row, so the NEXT session's prompt-skills freeze captures the new
 * active set (next-SESSION pickup — the refresh updates `cache.current`,
 * the next freeze reads it; it NEVER mutates an already-frozen snapshot).
 *
 * Default-off byte-identity: an agent that has not opted into `learningSkills`
 * never registers, so `refresh()` for it is a no-op and NO `list()` / `rmSync` runs.
 *
 * @module
 */

import { suppressError } from "@comis/shared";
import type { MentalModel, MentalModelStorePort, LearningScope } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { createRefreshableLearnedSkillSurface } from "./learned-skill-surface.js";

/** One agent's registered surface cache + its refresh closure. */
interface RegisteredSurface {
  /** The async refresh (re-runs list→materialize→cache). Fired fire-and-forget. */
  refresh: () => Promise<void>;
}

/** The shared registry handle threaded into setup-memory (refresh) + setup-agents (register). */
export interface LearnedSkillSurfaceRegistry {
  /**
   * Register an agent's surface refresh closure at boot. Only agents that opted into
   * `learningSkills` register — a default-off agent never calls this, so its
   * `refresh()` is a no-op. A re-register (hot-add re-setup) replaces the prior entry.
   */
  register(agentId: string, surface: RegisteredSurface): void;
  /**
   * Re-refresh a given agent's surface cache, fire-and-forget / non-fatal. A no-op for
   * an unregistered agent (default-off / unknown) — never throws. The refresh updates
   * `cache.current` so the NEXT session's freeze sees the change.
   */
  refresh(agentId: string): void;
  /** Drop an agent's registration (hot-remove). No-op if absent. */
  unregister(agentId: string): void;
}

/**
 * Create the per-agent surface registry. In-process, daemon-lifetime; counts/ids only
 * (it holds closures, never procedure bodies). The `refresh` is fire-and-forget so the
 * resolve-seam loop never blocks on a materialize.
 */
export function createLearnedSkillSurfaceRegistry(): LearnedSkillSurfaceRegistry {
  const surfaces = new Map<string, RegisteredSurface>();
  return {
    register(agentId, surface) {
      surfaces.set(agentId, surface);
    },
    refresh(agentId) {
      const surface = surfaces.get(agentId);
      if (surface === undefined) return; // default-off / unknown agent → no-op
      suppressError(surface.refresh(), `learned-skill surface re-refresh (agent ${agentId})`);
    },
    unregister(agentId) {
      surfaces.delete(agentId);
    },
  };
}

/**
 * Per-agent surface wiring (called once from `setupSingleAgent`). Opt-in gate: the
 * cache + its boot `list()`/`rmSync` are built ONLY when the agent has opted into
 * `learningSkills` (× the master cost switch) — a default-off agent does ZERO surface
 * work (no store read, no `.learned-skills` wipe) and its listing stays byte-identical.
 * When enabled it builds the refreshable cache (which fires the boot refresh) and
 * REGISTERS its refresh closure so the resolve-seam loop can re-refresh it on a
 * promote/demote. Returns the cache for the synchronous `getPromptSkillsXml`
 * seam to read `.current` (an empty, never-refreshed cache when default-off).
 */
export function wireAgentLearnedSkillSurface(args: {
  enabled: boolean;
  agentId: string;
  learnedSkillStore: MentalModelStorePort | undefined;
  scope: LearningScope;
  workspaceDir: string;
  logger: ComisLogger;
  registry?: LearnedSkillSurfaceRegistry;
  /**
   * Per-agent procedure-doc surface budget (`learning.reflect.maxProcedureDocsSurfaced`),
   * threaded through to the refresh so the orchestrate-derived procedure-doc subset is
   * capped per agent. Omitted only by tests; production passes the resolved config value.
   */
  maxProcedureDocsSurfaced?: number | undefined;
}): { readonly current: readonly MentalModel[] } {
  // Default-off ⇒ no store threaded ⇒ refreshLearnedSkillSurface returns []
  // and runs NO list()/rmSync — the cache stays empty (platform-only, byte-identical).
  if (!args.enabled) return { current: [] };
  const { cache, refresh } = createRefreshableLearnedSkillSurface({
    learnedSkillStore: args.learnedSkillStore,
    scope: args.scope,
    workspaceDir: args.workspaceDir,
    logger: args.logger,
    maxProcedureDocsSurfaced: args.maxProcedureDocsSurfaced,
  });
  // Register so the promote/demote loop can re-refresh this agent's surface.
  args.registry?.register(args.agentId, { refresh });
  return cache;
}
