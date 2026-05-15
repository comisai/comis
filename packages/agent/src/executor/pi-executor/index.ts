// SPDX-License-Identifier: Apache-2.0
/**
 * PiExecutor factory + co-equal helpers (Phase 42 split per EXEC-SPLIT-05).
 *
 * Named re-exports only — no `as` aliases. The canonical public names
 * (createPiExecutor + PiExecutorDeps + createBeforeToolCallGuard +
 * mergeSessionStats) are preserved byte-identical from the pre-split
 * `pi-executor.ts` so the EXEC-SPLIT-11 parity snapshot reproduces
 * verbatim post-split.
 *
 * @module
 */
export { createPiExecutor } from "./pi-executor.js";
export type { PiExecutorDeps } from "./pi-executor.js";
export { createBeforeToolCallGuard } from "./before-tool-call-guard.js";
export { mergeSessionStats } from "./session-stats.js";
