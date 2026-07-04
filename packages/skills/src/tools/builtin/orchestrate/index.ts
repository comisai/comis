// SPDX-License-Identifier: Apache-2.0
/**
 * `orchestrate` — the Surface-2 autonomy runner barrel.
 *
 * Re-exports the runner ({@link createOrchestrateTool}), its ResultRef store
 * ({@link createResultRefStore}), and the cap-socket runtime shim that the
 * generated `comis_tools.js` imports. The actual TOOL ASSEMBLY (adding
 * `orchestrate` to an agent's tool set under the autonomy profile) + the
 * dormancy activation (starting the cap socket, threading `capSocketPath` and the
 * store into the runner deps) is the daemon's wiring; this barrel only makes
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
  CHECKPOINT_TTL_MS,
} from "./result-ref-store.js";
export type {
  ResultRefStore,
  ResultRefStoreDeps,
  MaterializeContext,
  GcRunContext,
  CleanupRunContext,
  MaterializeError,
} from "./result-ref-store.js";

// The resumable-durable-row lifecycle for the flat runner (register at start,
// mark resumable on a timeout + the skip-clean decision, load the pinned bytes on
// resume). The daemon threads its real durable-run store as the `durableRuns`
// seam; only the port TYPE is surfaced here (the runner imports the helpers
// directly).
export type { OrchestrateDurableRuns } from "./orchestrate-durable.js";

// The shipped daemon-side `tool.invoke` executor cores: the real
// read/grep/find/ls/jq file cores + the web_search core the executor
// routes to. Consumed by the daemon's dormancy-activation wiring.
export { createOrchestrateExecutorCores } from "./orchestrate-executor-cores.js";
export type {
  OrchestrateExecutorCores,
  OrchestrateExecutorCoresDeps,
  OrchestrateFileCores,
  OrchestrateFileCore,
  OrchestrateFileCoreContext,
  OrchestrateWebSearchCore,
} from "./orchestrate-executor-cores.js";

// The cap-socket CLIENT runtime the generated SDK imports by a relative path
// (`./orchestrate-sdk-runtime.js`) at jail-run time. Re-exported here for local
// cohesion; the in-jail import does NOT go through this barrel.
export { invoke, wrapResultRef } from "./orchestrate-sdk-runtime.js";
export type { WrappedResultRef } from "./orchestrate-sdk-runtime.js";

// The git-worktree lifecycle for `spawn --worktree`.
// The daemon (executeSubAgent + the boot orphan-sweep) consumes these over the
// injected GitExec seam — the @comis/skills package owns the lifecycle, the
// daemon binds the real execFile-backed GitExec at the composition root.
export {
  createWorktree,
  isWorktreeCleanIfUnchanged,
  cleanIfUnchanged,
  sweepOrphans,
} from "./worktree-lifecycle.js";
export type {
  GitExec,
  WorktreeEntry,
  CreateWorktreeOptions,
  CleanIfUnchangedResult,
  SweepSummary,
  SweepDeps,
} from "./worktree-lifecycle.js";
