// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon agents-subsystem wiring (Phase 43 wave 8 split per FILE-SPLIT-08).
 *
 * Barrel re-export of the canonical public API of the former setup-agents.ts
 * monolith. No aliases — every export keeps its canonical name. The
 * pre-split parity snapshots (captured in 43-08a) reproduce verbatim against
 * this barrel.
 *
 * Decomposition:
 *   - setup-agents-tooling.ts     ≤200L — resolveAgentModel + pure helpers
 *   - setup-agents-runtime.ts     ≤550L — setupSingleAgent + SingleAgent* types
 *   - setup-agents-registry.ts    ≤450L — setupAgents + AgentsResult
 *
 * @module
 */

export type { SingleAgentDeps, SingleAgentResult } from "./setup-agents-types.js";
export { setupSingleAgent } from "./setup-agents-runtime.js";
export type { AgentsResult } from "./setup-agents-registry.js";
export { setupAgents } from "./setup-agents-registry.js";
export { resolveAgentModel } from "./setup-agents-tooling.js";
