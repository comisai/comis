// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import {
  MANAGED_APPROVAL_GRANT_TTL_MS,
  createManagedApprovalGrantRegistry,
} from "./managed-approval-grant.js";

const NOW_MS = 1_800_000_000_000;

function binding(overrides: Record<string, unknown> = {}) {
  return {
    approval: {
      requestId: "10000000-0000-4000-8000-000000000001",
      approved: true,
      approvedBy: "user_a",
      resolvedAt: NOW_MS,
    },
    toolName: "mcp__fixture--apply_change",
    action: "mcp.fixture.apply_change",
    fingerprintParams: {
      serverName: "fixture",
      toolName: "apply_change",
      arguments: { recordId: "record_a", expectedHead: "a".repeat(40) },
    },
    owner: {
      kind: "owner" as const,
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "user_a",
      conversationRef: "conversation-ref_a",
    },
    serviceInstanceId: "service-instance_a",
    managedRunId: "managed-run_a",
    mcpOperationId: "mcp-operation_a",
    ...overrides,
  };
}

function consume(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "consume-operation_a",
    approvalRequestId: "10000000-0000-4000-8000-000000000001",
    serviceInstanceId: "service-instance_a",
    managedRunId: "managed-run_a",
    mcpOperationId: "mcp-operation_a",
    ...overrides,
  };
}

describe("managed approval grant registry", () => {
  it("consumes one exact approved operation and permits only its identical replay", () => {
    const clock = createFakeClock(NOW_MS);
    const registry = createManagedApprovalGrantRegistry({ clock });

    expect(registry.bind(binding()).ok).toBe(true);
    const first = registry.consume(consume());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toMatchObject({
      state: "consumed",
      approvalRequestId: "10000000-0000-4000-8000-000000000001",
      managedRunId: "managed-run_a",
      mcpOperationId: "mcp-operation_a",
      resolvingPrincipalId: "user_a",
      approvedAtMs: NOW_MS,
      expiresAtMs: NOW_MS + MANAGED_APPROVAL_GRANT_TTL_MS,
      consumedAtMs: NOW_MS,
      operationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const replay = registry.consume(consume());
    expect(replay.ok && replay.value.state).toBe("identical_replay");
    expect(registry.consume(consume({ operationId: "consume-operation_b" })).ok).toBe(false);
  });

  it("rejects altered bindings, denied resolutions, and expired approvals", () => {
    const clock = createFakeClock(NOW_MS);
    const registry = createManagedApprovalGrantRegistry({ clock });

    expect(registry.bind(binding()).ok).toBe(true);
    expect(registry.bind(binding({
      approval: {
        requestId: "10000000-0000-4000-8000-000000000009",
        approved: true,
        approvedBy: "user_a",
        resolvedAt: NOW_MS,
      },
    })).ok).toBe(false);
    expect(registry.consume(consume({ managedRunId: "managed-run_b" })).ok).toBe(false);
    expect(registry.consume(consume({ approvalRequestId: "10000000-0000-4000-8000-000000000009" })).ok).toBe(false);

    const denied = createManagedApprovalGrantRegistry({ clock });
    expect(denied.bind(binding({
      approval: {
        requestId: "10000000-0000-4000-8000-000000000001",
        approved: false,
        approvedBy: "user_a",
        resolvedAt: NOW_MS,
      },
    })).ok).toBe(false);

    const expired = createManagedApprovalGrantRegistry({ clock });
    clock.advance(MANAGED_APPROVAL_GRANT_TTL_MS);
    expect(expired.bind(binding()).ok).toBe(false);
  });
});
