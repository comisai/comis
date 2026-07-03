// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon agents-subsystem wiring.
 *
 * Barrel re-export of the canonical public API of the agents wiring.
 * No aliases — every export keeps its canonical name.
 *
 * Decomposition:
 *   - setup-agents-tooling.ts      — resolveAgentModel + pure helpers
 *   - setup-agents-descriptions.ts — lean tool-description pre-resolution
 *   - setup-agents-oauth.ts        — per-agent OAuth wiring + encrypted-mode notice
 *   - setup-agents-runtime.ts      — setupSingleAgent + SingleAgent* types
 *   - setup-agents-registry.ts     — setupAgents + AgentsResult
 *
 * @module
 */

export type { SingleAgentDeps, SingleAgentResult } from "./setup-agents-types.js";
export { setupSingleAgent } from "./setup-agents-runtime.js";
export type { AgentsResult } from "./setup-agents-registry.js";
export { setupAgents } from "./setup-agents-registry.js";
export { resolveAgentModel } from "./setup-agents-tooling.js";
// The shared per-agent learned-skill SURFACE registry (created in daemon.ts,
// threaded into BOTH setupMemory's outcome wiring and setupAgents).
export { createLearnedSkillSurfaceRegistry, type LearnedSkillSurfaceRegistry } from "./learned-skill-surface-registry.js";
