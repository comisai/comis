// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  BUNDLE_DIGEST_FIXTURE_TOKEN,
  CAPABILITY_SERVICE_ERROR_KINDS,
  CAPABILITY_SERVICE_LIMITS,
  CAPABILITY_SERVICE_METHODS,
  CAPABILITY_SERVICE_PROTOCOL_ID,
} from "./constants.js";

export const ProtocolFixtureClassSchema = z.enum([
  "altered-replay",
  "boundary-size",
  "digest-mismatch",
  "invalid",
  "unknown-field",
  "valid",
  "version-mismatch",
]);

export const ProtocolFixtureTargetSchema = z.enum([
  "request",
  "abandon-response",
  "activate-response",
  "error-response",
  "handshake-response",
  "health-response",
  "report-response",
  "mcp-call-context",
  "mcp-managed-run-result",
]);

export const ProtocolFixtureStepSchema = z.strictObject({
  target: ProtocolFixtureTargetSchema,
  expectation: z.enum(["accept", "reject"]),
  expectedErrorKind: z.enum(CAPABILITY_SERVICE_ERROR_KINDS).optional(),
  payload: z.unknown(),
});

export const ProtocolFixtureScenarioSchema = z.strictObject({
  class: ProtocolFixtureClassSchema,
  name: z.string().min(1).max(128),
  steps: z.array(ProtocolFixtureStepSchema).min(1),
});

export type ProtocolFixtureScenario = z.infer<typeof ProtocolFixtureScenarioSchema>;
export type ProtocolFixtureStep = z.infer<typeof ProtocolFixtureStepSchema>;

const serviceInstanceRef = "service-instance_a";
const externalRunRef = "external-run_a";
const managedRunRef = "managed-run_a";
const registrationNonce = "registration-nonce_a";
const reportRef = "report_a";
const emptyDigest = "0".repeat(64);
const evidenceDigest = "e".repeat(64);

function request(
  id: string,
  method: (typeof CAPABILITY_SERVICE_METHODS)[number],
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, method, params };
}

const handshakeParams = {
  protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
  bundleDigest: BUNDLE_DIGEST_FIXTURE_TOKEN,
  operationId: "operation_handshake",
  serviceInstanceRef,
  supportedMethods: CAPABILITY_SERVICE_METHODS,
};

export const PROTOCOL_FIXTURE_SCENARIOS = [
  {
    class: "valid",
    name: "canonical request response and private metadata examples",
    steps: [
      {
        target: "mcp-call-context",
        expectation: "accept",
        payload: {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: BUNDLE_DIGEST_FIXTURE_TOKEN,
          operationId: "operation_prepare",
          serviceInstanceRef,
        },
      },
      {
        target: "mcp-managed-run-result",
        expectation: "accept",
        payload: {
          state: "prepared",
          serviceInstanceRef,
          externalRunRef,
          registrationNonce,
          expiresAtMs: 1_900_000_000_000,
        },
      },
      {
        target: "request",
        expectation: "accept",
        payload: request("operation_handshake", "capabilityServices.handshake", handshakeParams),
      },
      {
        target: "handshake-response",
        expectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_handshake",
          result: {
            protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
            bundleDigest: BUNDLE_DIGEST_FIXTURE_TOKEN,
            serviceInstanceRef,
            acceptedMethods: CAPABILITY_SERVICE_METHODS,
            limits: CAPABILITY_SERVICE_LIMITS,
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        payload: request("operation_activate", "managedRuns.activate", {
          operationId: "operation_activate",
          serviceInstanceRef,
          managedRunRef,
          externalRunRef,
          registrationNonce,
          registrationExpiresAtMs: 1_900_000_000_000,
        }),
      },
      {
        target: "activate-response",
        expectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_activate",
          result: {
            managedRunRef,
            externalRunRef,
            state: "active",
            activatedAtMs: 1_800_000_000_000,
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        payload: request("operation_report", "managedRuns.report", {
          operationId: "operation_report",
          serviceInstanceRef,
          managedRunRef,
          reportRef,
          sequence: 1,
          state: "active",
          summary: "Synthetic progress report",
          evidence: [
            {
              evidenceRef: "evidence_a",
              mediaType: "application/json",
              sizeBytes: 128,
              sha256: evidenceDigest,
            },
          ],
        }),
      },
      {
        target: "report-response",
        expectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_report",
          result: {
            managedRunRef,
            reportRef,
            acceptedSequence: 1,
            retainedUntilMs: 1_900_000_000_000,
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        payload: request("operation_health", "capabilityServices.health", {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: BUNDLE_DIGEST_FIXTURE_TOKEN,
          operationId: "operation_health",
          serviceInstanceRef,
        }),
      },
      {
        target: "health-response",
        expectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_health",
          result: {
            protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
            bundleDigest: BUNDLE_DIGEST_FIXTURE_TOKEN,
            serviceInstanceRef,
            status: "healthy",
            observedAtMs: 1_800_000_000_000,
            reasonCodes: [],
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        payload: request("operation_abandon", "managedRuns.abandon", {
          operationId: "operation_abandon",
          serviceInstanceRef,
          externalRunRef,
          registrationNonce,
          reason: "owner_cancelled",
        }),
      },
      {
        target: "abandon-response",
        expectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_abandon",
          result: { externalRunRef, state: "abandoned" },
        },
      },
      {
        target: "error-response",
        expectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_example_error",
          error: {
            code: -32_018,
            kind: "precondition_failed",
            retryable: false,
            message: "The requested transition is not available",
            hint: "Refresh the managed-run state before retrying",
          },
        },
      },
    ],
  },
  {
    class: "invalid",
    name: "invalid opaque reference",
    steps: [
      {
        target: "request",
        expectation: "reject",
        expectedErrorKind: "invalid_params",
        payload: request("operation_invalid", "managedRuns.activate", {
          operationId: "operation_invalid",
          serviceInstanceRef,
          managedRunRef,
          externalRunRef: "contains spaces",
          registrationNonce,
          registrationExpiresAtMs: 1_900_000_000_000,
        }),
      },
    ],
  },
  {
    class: "unknown-field",
    name: "unknown handshake parameter",
    steps: [
      {
        target: "request",
        expectation: "reject",
        expectedErrorKind: "invalid_params",
        payload: request("operation_unknown", "capabilityServices.handshake", {
          ...handshakeParams,
          operationId: "operation_unknown",
          unrecognized: true,
        }),
      },
    ],
  },
  {
    class: "boundary-size",
    name: "report summary byte boundary",
    steps: [
      {
        target: "request",
        expectation: "accept",
        payload: request("operation_boundary_ok", "managedRuns.report", {
          operationId: "operation_boundary_ok",
          serviceInstanceRef,
          managedRunRef,
          reportRef: "report_boundary_ok",
          sequence: 2,
          state: "active",
          summary: "x".repeat(CAPABILITY_SERVICE_LIMITS.maxReportBytes),
          evidence: [],
        }),
      },
      {
        target: "request",
        expectation: "reject",
        expectedErrorKind: "size_limit_exceeded",
        payload: request("operation_boundary_large", "managedRuns.report", {
          operationId: "operation_boundary_large",
          serviceInstanceRef,
          managedRunRef,
          reportRef: "report_boundary_large",
          sequence: 3,
          state: "active",
          summary: "x".repeat(CAPABILITY_SERVICE_LIMITS.maxReportBytes + 1),
          evidence: [],
        }),
      },
    ],
  },
  {
    class: "altered-replay",
    name: "operation identity rejects altered replay",
    steps: [
      {
        target: "request",
        expectation: "accept",
        payload: request("operation_replay", "managedRuns.report", {
          operationId: "operation_replay",
          serviceInstanceRef,
          managedRunRef,
          reportRef: "report_replay",
          sequence: 4,
          state: "active",
          summary: "First payload",
          evidence: [],
        }),
      },
      {
        target: "request",
        expectation: "reject",
        expectedErrorKind: "replay_conflict",
        payload: request("operation_replay", "managedRuns.report", {
          operationId: "operation_replay",
          serviceInstanceRef,
          managedRunRef,
          reportRef: "report_replay",
          sequence: 4,
          state: "active",
          summary: "Altered payload",
          evidence: [],
        }),
      },
    ],
  },
  {
    class: "version-mismatch",
    name: "handshake rejects a different protocol identifier",
    steps: [
      {
        target: "request",
        expectation: "reject",
        expectedErrorKind: "protocol_mismatch",
        payload: request("operation_version", "capabilityServices.handshake", {
          ...handshakeParams,
          protocolId: "comis.capability-service/2",
          operationId: "operation_version",
        }),
      },
    ],
  },
  {
    class: "digest-mismatch",
    name: "handshake rejects a different bundle digest",
    steps: [
      {
        target: "request",
        expectation: "reject",
        expectedErrorKind: "bundle_digest_mismatch",
        payload: request("operation_digest", "capabilityServices.handshake", {
          ...handshakeParams,
          bundleDigest: emptyDigest,
          operationId: "operation_digest",
        }),
      },
    ],
  },
] as const satisfies readonly ProtocolFixtureScenario[];

/** Resolve the self-referential digest token without changing fixture source bytes. */
export function materializeProtocolFixtureDigest(value: unknown, bundleDigest: string): unknown {
  if (value === BUNDLE_DIGEST_FIXTURE_TOKEN) return bundleDigest;
  if (Array.isArray(value)) {
    return value.map((entry) => materializeProtocolFixtureDigest(entry, bundleDigest));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        materializeProtocolFixtureDigest(entry, bundleDigest),
      ]),
    );
  }
  return value;
}
