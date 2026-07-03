// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/observability — activity substrate barrel.
 *
 * The observability-side of the activity pipeline: the
 * `ActivityStream` EventBus subscriber that maps real events to canonical,
 * redacted `ActivityEvent`s, the per-consumer `bounded-queue`, the typed-first
 * `label-resolver`, the `shell-label-parser`, and the SEP `plan-stream`.
 *
 * Boundary: this surface imports `@comis/core` only — never the channels
 * package (the hexagonal constraint, enforced by a durable guard test).
 * The orchestrator consumes the `ActivityStreamPort` shape from `@comis/core`,
 * not this package, so it gains no observability dependency.
 */

export { createActivityStream } from "./activity-stream.js";
export type {
  ActivityStream,
  CreateActivityStreamDeps,
  ActivityToolMetadata,
  ActivityCounters,
} from "./activity-stream.js";

export {
  createBoundedQueue,
  DEFAULT_QUEUE_CAPACITY,
  DEFAULT_FAILURE_OVERFLOW,
} from "./bounded-queue.js";
export type { BoundedQueue, BoundedQueueOptions } from "./bounded-queue.js";

export { resolveLabel, resolveLabelDetailed } from "./label-resolver.js";
export type {
  ResolveLabelOpts,
  ResolveLabelMetadata,
  ResolvedLabel,
} from "./label-resolver.js";

export { compressLabel } from "./label-compressor.js";

export { parseShellCommand } from "./shell-label-parser.js";

export { createPlanStream } from "./plan-stream.js";
export type {
  PlanStream,
  PlanUpdate,
  PlanEntry,
  CreatePlanStreamDeps,
} from "./plan-stream.js";
