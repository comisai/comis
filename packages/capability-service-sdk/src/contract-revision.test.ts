// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_SERVICE_METHODS,
  CAPABILITY_SERVICE_PROTOCOL_ID,
  CapabilityActivateRequestSchema,
  CapabilityHandshakeRequestSchema,
  CapabilityServiceRequestSchema,
  McpManagedRunResultSchema,
} from "./index.js";

const digest = "a".repeat(64);

function activateParams(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    operationId: "operation_activate",
    managedRunId: "managed-run_a",
    externalRunRef: "external-run_a",
    registrationNonce: "registration-nonce_a",
    workspaceLeaseId: "workspace-lease_a",
    ...overrides,
  };
}

describe("capability-service execution-attachment contract", () => {
  it("publishes a service-scoped attention response receive method", () => {
    expect(CAPABILITY_SERVICE_METHODS).toContain("managedRuns.receiveAttentionResponse");
    expect(CapabilityHandshakeRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: "operation_handshake",
      method: "capabilityServices.handshake",
      params: {
        protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
        bundleDigest: digest,
        operationId: "operation_handshake",
        serviceInstanceId: "service-instance_a",
        requestedScopes: ["health", "attention_response"],
      },
    }).success).toBe(true);
  });

  it("accepts exact managed run release requests", () => {
    expect(CAPABILITY_SERVICE_METHODS).toContain("managedRuns.release");
    expect(CapabilityServiceRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: "operation_release",
      method: "managedRuns.release",
      params: {
        operationId: "operation_release",
        managedRunId: "managed-run_a",
        workspaceLeaseId: "workspace-lease_a",
        disposition: "reap_safe",
        releasedAtMs: 1_800_000_000_000,
      },
    }).success).toBe(true);
    expect(CapabilityServiceRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: "operation_release",
      method: "managedRuns.release",
      params: {
        operationId: "operation_release",
        managedRunId: "managed-run_a",
        workspaceLeaseId: "workspace-lease_a",
        disposition: "reap_safe",
      },
    }).success).toBe(false);
  });

  it("accepts both requested execution attachment source kinds", () => {
    for (const kind of ["unix_socket", "inherited_descriptor"] as const) {
      expect(McpManagedRunResultSchema.safeParse({
        state: "prepared",
        externalRunRef: "external-run_a",
        registrationNonce: "registration-nonce_a",
        expiresAt: "2030-01-01T00:00:00.000Z",
        requestedWorkspace: { rootHint: "/approved/workspaces/task-a" },
        requestedAttachment: {
          kind,
          sourcePath: "/approved/runtime/task-a/service.sock",
        },
      }).success).toBe(true);
    }
  });

  it("requires both activation attachment handles or neither", () => {
    const envelope = (params: Readonly<Record<string, unknown>>) => ({
      jsonrpc: "2.0",
      id: "operation_activate",
      method: "managedRuns.activate",
      params,
    });

    expect(CapabilityActivateRequestSchema.safeParse(envelope(activateParams({
      executionAttachmentId: "execution-attachment_a",
      attachmentTargetName: "attachment-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sock",
    }))).success).toBe(true);
    expect(CapabilityActivateRequestSchema.safeParse(envelope(activateParams())).success).toBe(true);
    expect(CapabilityActivateRequestSchema.safeParse(envelope(activateParams({
      executionAttachmentId: "execution-attachment_a",
    }))).success).toBe(false);
    expect(CapabilityActivateRequestSchema.safeParse(envelope(activateParams({
      attachmentTargetName: "attachment-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sock",
    }))).success).toBe(false);
  });

  it("accepts the complete closed handshake scope set", () => {
    expect(CapabilityHandshakeRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: "operation_handshake",
      method: "capabilityServices.handshake",
      params: {
        protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
        bundleDigest: digest,
        operationId: "operation_handshake",
        serviceInstanceId: "service-instance_a",
        requestedScopes: [
          "health",
          "attention_response",
          "evidence",
          "report",
          "workspace_lease",
          "terminal_events",
          "execution_attachment",
        ],
      },
    }).success).toBe(true);
  });
});
