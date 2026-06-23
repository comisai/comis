// SPDX-License-Identifier: Apache-2.0
/**
 * `orchestrate` — the Surface-2 autonomy runner barrel (Phase 212).
 *
 * Re-exports the runner ({@link createOrchestrateTool}), its ResultRef store
 * ({@link createResultRefStore}), and the cap-socket runtime shim that the
 * generated `comis_tools.js` imports. The actual TOOL ASSEMBLY (adding
 * `orchestrate` to an agent's tool set under the autonomy profile) + the
 * dormancy activation (starting the cap socket, threading `capSocketPath` and the
 * store into the runner deps) is Plan 05's daemon wiring; this barrel only makes
 * the pieces importable.
 *
 * @module
 */
export {
  createOrchestrateTool,
  scrubSecretEnv,
} from "./orchestrate-tool.js";
export type {
  OrchestrateToolDeps,
  OrchestrateResultStore,
  OrchestrateSpawnFn,
  OrchestrateSpawnedChild,
} from "./orchestrate-tool.js";

export {
  createResultRefStore,
  buildPreview,
  inferKind,
} from "./result-ref-store.js";
export type {
  ResultRefStore,
  ResultRefStoreDeps,
  MaterializeContext,
  GcRunContext,
  CleanupRunContext,
  MaterializeError,
} from "./result-ref-store.js";

// The cap-socket CLIENT runtime the generated SDK imports by a relative path
// (`./orchestrate-sdk-runtime.js`) at jail-run time. Re-exported here for local
// cohesion; the in-jail import does NOT go through this barrel.
export { invoke, wrapResultRef } from "./orchestrate-sdk-runtime.js";
export type { WrappedResultRef } from "./orchestrate-sdk-runtime.js";
