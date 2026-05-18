// SPDX-License-Identifier: Apache-2.0
// @comis/observability — Observability substrate barrel.
//
// Plan 45-01 wires the six pure-function helpers + Type aliases that
// the trajectory / system-prompt-report / config-audit artifact writers
// (Plans 45-03/04/05) all compose through. Public surface:
//
//   - Queued single-promise-chain writer chassis
//   - Payload-bounding limiter + sentinel enum
//   - Diagnostic-payload sanitizer (credential drop, image sha256, cycles)
//   - Path-containment + filename-normalization + safe open() flags
//   - Stable canonical-JSON serializer (digest-stable)
//   - Circular-safe JSON serializer (wraps JSON.stringify)
//
// Boundary enforced by test/architecture/observability-package-isolation.test.ts
// (Plan 45-01 Task 11): no imports from @comis/agent, @comis/daemon,
// @comis/cli, @comis/orchestrator.

export {
  getQueuedFileWriter,
} from "./shared/queued-file-writer.js";
export type {
  QueuedFileWriter,
  QueuedFileWriteResult,
  QueuedFileWriterOptions,
} from "./shared/queued-file-writer.js";

export {
  limitPayloadValue,
  PAYLOAD_BOUNDS,
  BOUNDED_PAYLOAD_REASONS,
} from "./shared/bounded-payload.js";
export type {
  BoundedPayloadReason,
  BoundedSentinel,
} from "./shared/bounded-payload.js";

export { sanitizeDiagnosticPayload } from "./shared/sanitize-diagnostic-payload.js";

export {
  resolveContainedPath,
  resolveContainedPathOrThrow,
  safeTrajectorySessionFileName,
  resolveSafeOpenFlags,
  PathEscapeError,
} from "./shared/path-guards.js";

export { stableStringify } from "./shared/stable-stringify.js";

export { safeJsonStringify } from "./shared/safe-json-stringify.js";
