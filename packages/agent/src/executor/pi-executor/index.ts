// SPDX-License-Identifier: Apache-2.0
/**
 * PiExecutor factory + co-equal helpers.
 *
 * Named re-exports only — no `as` aliases. The canonical public names
 * (createPiExecutor + PiExecutorDeps + createBeforeToolCallGuard +
 * mergeSessionStats) keep their exact spellings: they are the package's
 * public surface (re-exported by @comis/agent's index), so aliasing or
 * renaming here is a breaking API change.
 *
 * @module
 */
export { createPiExecutor } from "./pi-executor.js";
export type { PiExecutorDeps } from "./pi-executor.js";
export { createBeforeToolCallGuard } from "./before-tool-call-guard.js";
export { mergeSessionStats } from "./session-stats.js";
