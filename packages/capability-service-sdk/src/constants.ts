// SPDX-License-Identifier: Apache-2.0

/** Exact lockstep identifier carried by every protocol handshake. */
export const CAPABILITY_SERVICE_PROTOCOL_ID = "comis.capability-service/1" as const;
/** Exact digest of the generated protocol artifacts shipped with this SDK release. */
export const CAPABILITY_SERVICE_BUNDLE_DIGEST = "94ec7bd173cd20f0de2cb4e9ab719d392f240236ac80d56e3a7ea1abe4e20cb8" as const;
export const CAPABILITY_SERVICE_GENERATOR_VERSION = "1.0.60" as const;

/** Placeholder resolved from manifest.json before a generated fixture is sent. */
export const BUNDLE_DIGEST_FIXTURE_TOKEN = "__BUNDLE_DIGEST__" as const;

export const CAPABILITY_SERVICE_METHODS = [
  "capabilityServices.handshake",
  "capabilityServices.health",
  "managedRuns.abandon",
  "managedRuns.activate",
  "managedRuns.report",
  "managedRuns.terminalEvent",
] as const;

export type CapabilityServiceMethod = (typeof CAPABILITY_SERVICE_METHODS)[number];

export const MCP_CAPABILITY_CALL_CONTEXT_KEY = "comis.callContext" as const;
export const MCP_MANAGED_RUN_RESULT_KEY = "comis.managedRun" as const;

export const CAPABILITY_SERVICE_ERROR_KINDS = [
  "bundle_digest_mismatch",
  "deadline_exceeded",
  "internal_error",
  "invalid_params",
  "invalid_request",
  "method_not_found",
  "precondition_failed",
  "protocol_mismatch",
  "rate_limited",
  "replay_conflict",
  "size_limit_exceeded",
  "unauthorized_instance",
] as const;

export type CapabilityServiceErrorKind = (typeof CAPABILITY_SERVICE_ERROR_KINDS)[number];

export const CAPABILITY_SERVICE_LIMITS = Object.freeze({
  maxEvidenceBytes: 1_048_576,
  maxInFlightRequests: 32,
  maxLineBytes: 65_536,
  maxReportBytes: 16_384,
  maxRequestBytes: 65_536,
  maxResponseBytes: 65_536,
  reportRetentionDays: 30,
});

export const CAPABILITY_SERVICE_ERROR_DEFINITIONS = [
  { code: -32_012, kind: "bundle_digest_mismatch", retryable: false },
  { code: -32_017, kind: "deadline_exceeded", retryable: true },
  { code: -32_603, kind: "internal_error", retryable: true },
  { code: -32_602, kind: "invalid_params", retryable: false },
  { code: -32_600, kind: "invalid_request", retryable: false },
  { code: -32_601, kind: "method_not_found", retryable: false },
  { code: -32_018, kind: "precondition_failed", retryable: false },
  { code: -32_011, kind: "protocol_mismatch", retryable: false },
  { code: -32_016, kind: "rate_limited", retryable: true },
  { code: -32_014, kind: "replay_conflict", retryable: false },
  { code: -32_015, kind: "size_limit_exceeded", retryable: false },
  { code: -32_013, kind: "unauthorized_instance", retryable: false },
] as const satisfies ReadonlyArray<{
  readonly code: number;
  readonly kind: CapabilityServiceErrorKind;
  readonly retryable: boolean;
}>;
