// SPDX-License-Identifier: Apache-2.0
// @comis/observability — Observability substrate barrel.
//
// Plan 45-01 wires the six pure-function helpers + Type aliases that
// the trajectory / system-prompt-report / config-audit artifact writers
// (Plans 45-03/04/05) all compose through. Plan 45-02 adds the redactor
// surface (edge-keeping mask, pattern set, walker, Pino transport).
// Public surface:
//
//   - Queued single-promise-chain writer chassis
//   - Payload-bounding limiter + sentinel enum
//   - Diagnostic-payload sanitizer (credential drop, image sha256, cycles)
//   - Path-containment + filename-normalization + safe open() flags
//   - Stable canonical-JSON serializer (digest-stable)
//   - Circular-safe JSON serializer (wraps JSON.stringify)
//   - Edge-keeping mask + PEM-block mask + defaults constants
//   - sha256-prefix opaque-id helper
//   - Chunked bounded regex replace (ReDoS guard)
//   - Default credential pattern set (28 + 4 Comis additions)
//   - Text-level redactor + structured walker + sanitizeForPersistence
//   - Pino redact transport factory
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

export {
  sanitizeDiagnosticPayload,
  isCredentialFieldName,
} from "./shared/sanitize-diagnostic-payload.js";

export {
  resolveContainedPath,
  resolveContainedPathOrThrow,
  safeTrajectorySessionFileName,
  resolveSafeOpenFlags,
  PathEscapeError,
} from "./shared/path-guards.js";

export { stableStringify } from "./shared/stable-stringify.js";

export { safeJsonStringify } from "./shared/safe-json-stringify.js";

// ---------------------------------------------------------------------------
// Redactor surface (Plan 45-02).
// ---------------------------------------------------------------------------

export {
  maskToken,
  maskPemBlock,
  REDACT_DEFAULTS,
} from "./redact/edge-keeping.js";
export type { MaskTokenOptions } from "./redact/edge-keeping.js";

export { redactIdentifier } from "./redact/redact-identifier.js";

export { replacePatternBounded } from "./redact/regex-bounded.js";
export type { BoundedReplacer } from "./redact/regex-bounded.js";

export { getDefaultRedactPatterns } from "./redact/patterns.js";
export type { RedactPattern, RedactPatternKind } from "./redact/patterns.js";

export { redactSecretsInText } from "./redact/redact-text.js";

export {
  redactSecrets,
  sanitizeForPersistence,
} from "./redact/redact-secrets.js";

// Pino transport factory: named re-export (NOT default). The default
// export is reserved for the file used as a Pino `target` resolution
// path. Barrel consumers should import via the named symbol.
export { default as pinoRedactTransport } from "./redact/pino-redact-transport.js";
