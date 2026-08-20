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
  "put-evidence-response",
  "receive-attention-response",
  "release-response",
  "report-response",
  "terminal-event-response",
  "mcp-call-context",
  "mcp-managed-run-group-result",
  "mcp-managed-run-result",
]);

export const ProtocolFixtureStepSchema = z.strictObject({
  target: ProtocolFixtureTargetSchema,
  expectation: z.enum(["accept", "reject"]),
  schemaExpectation: z.enum(["accept", "reject"]),
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

const serviceInstanceId = "service-instance_a";
const externalRunRef = "external-run_a";
const managedRunId = "managed-run_a";
const registrationNonce = "registration-nonce_a";
const serviceReportId = "service-report_a";
const terminalSessionId = "terminal-session_a";
const emptyDigest = "0".repeat(64);
const workspacePolicyHash = "c".repeat(64);

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
  serviceInstanceId,
  requestedScopes: [
    "health",
    "attention_response",
    "evidence",
    "report",
    "workspace_lease",
    "terminal_events",
    "execution_attachment",
  ],
};

export const PROTOCOL_FIXTURE_SCENARIOS = [
  {
    class: "valid",
    name: "canonical request response and private metadata examples",
    steps: [
      {
        target: "mcp-call-context",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          operationId: "operation_prepare",
          serviceInstanceId,
          agentId: "agent_a",
          conversationRef: "conversation_a",
          workspacePolicyHash,
          rootRunId: "root-run_a",
          traceId: "40000000-0000-4000-8000-000000000004",
        },
      },
      {
        target: "mcp-managed-run-result",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          state: "prepared",
          externalRunRef,
          registrationNonce,
          expiresAt: "2030-01-01T00:00:00.000Z",
          requestedWorkspace: { rootHint: "/approved/workspaces/task-a" },
          requestedAttachment: {
            kind: "unix_socket",
            sourcePath: "/approved/runtime/task-a/service.sock",
          },
        },
      },
      {
        target: "mcp-managed-run-group-result",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          state: "prepared",
          registrationNonce: "group-registration-nonce_a",
          expiresAt: "2030-01-01T00:00:00.000Z",
          members: [
            {
              state: "prepared",
              externalRunRef: "external-run_group-member-a",
              registrationNonce: "registration-nonce_group-member-a",
              expiresAt: "2030-01-01T00:00:00.000Z",
              requestedWorkspace: { rootHint: "/approved/workspaces/group-task-a" },
              requestedAttachment: {
                kind: "unix_socket",
                sourcePath: "/approved/runtime/group-task-a/service.sock",
              },
            },
          ],
        },
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_handshake", "capabilityServices.handshake", handshakeParams),
      },
      {
        target: "handshake-response",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_handshake",
          result: {
            protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
            bundleDigest: BUNDLE_DIGEST_FIXTURE_TOKEN,
            serviceInstanceId,
            activeScopes: [
              "health",
              "attention_response",
              "evidence",
              "report",
              "workspace_lease",
              "terminal_events",
              "execution_attachment",
            ],
            limits: CAPABILITY_SERVICE_LIMITS,
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_attention_response", "managedRuns.receiveAttentionResponse", {
          operationId: "operation_attention_response",
          managedRunId,
          externalKey: "backend-id-format",
        }),
      },
      {
        target: "receive-attention-response",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_attention_response",
          result: {
            managedRunId,
            externalKey: "backend-id-format",
            state: "delivered",
            response: "Use monotonic issue-N values.",
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_evidence", "managedRuns.putEvidence", {
          operationId: "operation_evidence",
          managedRunId,
          evidenceRef: "evidence_a",
          kind: "delivery_reference",
          subjectDigest: emptyDigest,
          observedAtMs: 1_800_000_000_000,
          expiresAtMs: 1_900_000_000_000,
          contentHash: "ce58b0fb87ca71053fac0559671447e5e506386bcb705e535b33a92b2d928c0d",
          verificationLevel: "adapter_verified",
          bodyBase64: "aHR0cHM6Ly9leGFtcGxlLmNvbS9wdWxsLzE3",
          delivery: { kind: "reference" },
        }),
      },
      {
        target: "put-evidence-response",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_evidence",
          result: {
            managedRunId,
            evidenceRef: "evidence_a",
            contentHash: "ce58b0fb87ca71053fac0559671447e5e506386bcb705e535b33a92b2d928c0d",
            verificationLevel: "adapter_verified",
            retainedUntilMs: 1_900_000_000_000,
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_activate", "managedRuns.activate", {
          operationId: "operation_activate",
          managedRunId,
          externalRunRef,
          registrationNonce,
          workspaceLeaseId: "workspace-lease_a",
          executionAttachmentId: "execution-attachment_a",
          attachmentTargetName: "attachment-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sock",
        }),
      },
      {
        target: "mcp-managed-run-result",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          state: "prepared",
          externalRunRef: "external-run_without_workspace",
          registrationNonce: "registration-nonce_without_workspace",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_activate_without_workspace", "managedRuns.activate", {
          operationId: "operation_activate_without_workspace",
          managedRunId: "managed-run_without_workspace",
          externalRunRef: "external-run_without_workspace",
          registrationNonce: "registration-nonce_without_workspace",
        }),
      },
      {
        target: "activate-response",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_activate",
          result: {
            managedRunId,
            externalRunRef,
            state: "active",
            activatedAtMs: 1_800_000_000_000,
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_release", "managedRuns.release", {
          operationId: "operation_release",
          managedRunId,
          workspaceLeaseId: "workspace-lease_a",
          disposition: "reap_safe",
          releasedAtMs: 1_800_000_000_000,
        }),
      },
      {
        target: "release-response",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_release",
          result: {
            managedRunId,
            workspaceLeaseId: "workspace-lease_a",
            state: "released",
            disposition: "reap_safe",
            releasedAtMs: 1_800_000_000_000,
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_report", "managedRuns.report", {
          operationId: "operation_report",
          managedRunId,
          serviceReportId,
          kind: "progress",
          summary: "Synthetic progress report",
          artifactRefs: ["evidence_a"],
          observedAtMs: 1_800_000_000_000,
        }),
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_terminal_created", "managedRuns.terminalEvent", {
          operationId: "operation_terminal_created",
          managedRunId,
          workspaceLeaseId: "workspace-lease_a",
          terminalSessionId,
          transition: "created",
        }),
      },
      {
        target: "terminal-event-response",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_terminal_created",
          result: {
            managedRunId,
            terminalSessionId,
            transition: "created",
          },
        },
      },
      {
        target: "report-response",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_report",
          result: {
            managedRunId,
            serviceReportId,
            acceptedSequence: 1,
            retainedUntilMs: 1_900_000_000_000,
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_health", "capabilityServices.health", {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: BUNDLE_DIGEST_FIXTURE_TOKEN,
          operationId: "operation_health",
          serviceInstanceId,
        }),
      },
      {
        target: "health-response",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_health",
          result: {
            protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
            bundleDigest: BUNDLE_DIGEST_FIXTURE_TOKEN,
            serviceInstanceId,
            status: "healthy",
            observedAtMs: 1_800_000_000_000,
            reasonCodes: [],
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_abandon", "managedRuns.abandon", {
          operationId: "operation_abandon",
          externalRunRef,
          registrationNonce,
          reason: "owner_cancelled",
          disposition: "preserve",
        }),
      },
      {
        target: "abandon-response",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          jsonrpc: "2.0",
          id: "operation_abandon",
          result: {
            externalRunRef,
            state: "abandoned",
            disposition: "preserve",
            terminalTransition: "unbound_preparation_abandoned",
          },
        },
      },
      {
        target: "error-response",
        expectation: "accept",
        schemaExpectation: "accept",
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
    name: "invalid opaque reference and activation authority correlation",
    steps: [
      {
        target: "mcp-managed-run-result",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          state: "prepared",
          externalRunRef: "external-run_attachment_missing_handles",
          registrationNonce: "registration-nonce_attachment_missing_handles",
          expiresAt: "2030-01-01T00:00:00.000Z",
          requestedWorkspace: { rootHint: "/approved/workspaces/task-attachment" },
          requestedAttachment: {
            kind: "unix_socket",
            sourcePath: "/approved/runtime/task-attachment/service.sock",
          },
        },
      },
      {
        target: "request",
        expectation: "reject",
        schemaExpectation: "accept",
        expectedErrorKind: "invalid_params",
        payload: request("operation_attachment_missing_handles", "managedRuns.activate", {
          operationId: "operation_attachment_missing_handles",
          managedRunId: "managed-run_attachment_missing_handles",
          externalRunRef: "external-run_attachment_missing_handles",
          registrationNonce: "registration-nonce_attachment_missing_handles",
          workspaceLeaseId: "workspace-lease_attachment_missing_handles",
        }),
      },
      {
        target: "request",
        expectation: "reject",
        schemaExpectation: "reject",
        expectedErrorKind: "invalid_params",
        payload: request("operation_invalid", "managedRuns.activate", {
          operationId: "operation_invalid",
          managedRunId,
          externalRunRef: "contains spaces",
          registrationNonce,
        }),
      },
      {
        target: "mcp-managed-run-result",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          state: "prepared",
          externalRunRef: "external-run_workspace_missing_lease",
          registrationNonce: "registration-nonce_workspace_missing_lease",
          expiresAt: "2030-01-01T00:00:00.000Z",
          requestedWorkspace: { rootHint: "/approved/workspaces/task-missing-lease" },
        },
      },
      {
        target: "request",
        expectation: "reject",
        schemaExpectation: "accept",
        expectedErrorKind: "invalid_params",
        payload: request("operation_workspace_missing_lease", "managedRuns.activate", {
          operationId: "operation_workspace_missing_lease",
          managedRunId: "managed-run_workspace_missing_lease",
          externalRunRef: "external-run_workspace_missing_lease",
          registrationNonce: "registration-nonce_workspace_missing_lease",
        }),
      },
      {
        target: "mcp-managed-run-result",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          state: "prepared",
          externalRunRef: "external-run_workspace_unexpected_lease",
          registrationNonce: "registration-nonce_workspace_unexpected_lease",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      },
      {
        target: "request",
        expectation: "reject",
        schemaExpectation: "accept",
        expectedErrorKind: "invalid_params",
        payload: request("operation_workspace_unexpected_lease", "managedRuns.activate", {
          operationId: "operation_workspace_unexpected_lease",
          managedRunId: "managed-run_workspace_unexpected_lease",
          externalRunRef: "external-run_workspace_unexpected_lease",
          registrationNonce: "registration-nonce_workspace_unexpected_lease",
          workspaceLeaseId: "workspace-lease_unexpected",
        }),
      },
      {
        target: "request",
        expectation: "reject",
        schemaExpectation: "reject",
        expectedErrorKind: "invalid_params",
        payload: request("operation_terminal_content", "managedRuns.terminalEvent", {
          operationId: "operation_terminal_content",
          managedRunId,
          workspaceLeaseId: "workspace-lease_a",
          terminalSessionId,
          transition: "stuck",
          reason: "screen content must never cross the control bridge",
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
        schemaExpectation: "reject",
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
    name: "report content byte boundary",
    steps: [
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_boundary_ok", "managedRuns.report", {
          operationId: "operation_boundary_ok",
          managedRunId,
          serviceReportId: "report_boundary_ok",
          kind: "progress",
          summary: "x".repeat(CAPABILITY_SERVICE_LIMITS.maxReportBytes),
        }),
      },
      {
        target: "request",
        expectation: "reject",
        schemaExpectation: "reject",
        expectedErrorKind: "size_limit_exceeded",
        payload: request("operation_boundary_large", "managedRuns.report", {
          operationId: "operation_boundary_large",
          managedRunId,
          serviceReportId: "report_boundary_large",
          kind: "progress",
          summary: "x".repeat(CAPABILITY_SERVICE_LIMITS.maxReportBytes + 1),
        }),
      },
      {
        target: "request",
        expectation: "reject",
        schemaExpectation: "accept",
        expectedErrorKind: "size_limit_exceeded",
        payload: request("operation_boundary_combined", "managedRuns.report", {
          operationId: "operation_boundary_combined",
          managedRunId,
          serviceReportId: "report_boundary_combined",
          kind: "progress",
          summary: "x".repeat(CAPABILITY_SERVICE_LIMITS.maxReportBytes / 2),
          details: "y".repeat(CAPABILITY_SERVICE_LIMITS.maxReportBytes / 2 + 1),
        }),
      },
    ],
  },
  {
    class: "altered-replay",
    name: "attachment activation identity rejects altered replay",
    steps: [
      {
        target: "mcp-managed-run-result",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: {
          state: "prepared",
          externalRunRef,
          registrationNonce,
          expiresAt: "2030-01-01T00:00:00.000Z",
          requestedWorkspace: { rootHint: "/approved/workspaces/task-a" },
          requestedAttachment: {
            kind: "unix_socket",
            sourcePath: "/approved/runtime/task-a/service.sock",
          },
        },
      },
      {
        target: "request",
        expectation: "accept",
        schemaExpectation: "accept",
        payload: request("operation_replay", "managedRuns.activate", {
          operationId: "operation_replay",
          managedRunId,
          externalRunRef,
          registrationNonce,
          workspaceLeaseId: "workspace-lease_a",
          executionAttachmentId: "execution-attachment_a",
          attachmentTargetName: "attachment-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sock",
        }),
      },
      {
        target: "request",
        expectation: "reject",
        schemaExpectation: "accept",
        expectedErrorKind: "replay_conflict",
        payload: request("operation_replay", "managedRuns.activate", {
          operationId: "operation_replay",
          managedRunId,
          externalRunRef,
          registrationNonce,
          workspaceLeaseId: "workspace-lease_a",
          executionAttachmentId: "execution-attachment_a",
          attachmentTargetName: "attachment-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.sock",
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
        schemaExpectation: "reject",
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
        schemaExpectation: "accept",
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
