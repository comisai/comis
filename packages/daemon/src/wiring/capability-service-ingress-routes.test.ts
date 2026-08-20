// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type {
  CapabilityConsumeApprovalRequestSchema,
  CapabilityReportRequestSchema,
} from "@comis/capability-service-sdk";
import { createManagedApprovalGrantRegistry, type ComisLogger } from "@comis/core";
import { ok } from "@comis/shared";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import {
  routeManagedRunReportIngress,
  routeManagedApprovalGrantIngress,
  type CapabilityServiceIngressRouteDeps,
} from "./capability-service-ingress-routes.js";
import type { ManagedRunReportIngressOutcome } from "./managed-run-report-bridge.js";

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

function makeReportRequest(): z.infer<typeof CapabilityReportRequestSchema> {
  return {
    params: {
      managedRunId: "managed-run_a",
      serviceReportId: "service-report_a",
      kind: "progress",
      summary: "progress",
    },
  } as z.infer<typeof CapabilityReportRequestSchema>;
}

function makeDeps(outcome: ManagedRunReportIngressOutcome): CapabilityServiceIngressRouteDeps {
  const clock = createFakeClock(1_800_000_000_000);
  return {
    reportBridge: { ingestReport: async () => ok(outcome) },
    evidenceBridge: {} as never,
    attentionResponseBridge: {} as never,
    livenessBridge: {} as never,
    releaseCoordinator: {} as never,
    groupStore: {} as never,
    runStore: { get: async () => ok({} as never) },
    approvalGrants: createManagedApprovalGrantRegistry({ clock }),
    requestDeadlineMs: 5_000,
    clock,
    timers: createFakeTimers(0),
    logger: makeLogger(),
  };
}

describe("capability-service report ingress error mapping", () => {
  it("maps a rate-limited rejection to the retryable rate_limited wire error", async () => {
    const result = await routeManagedRunReportIngress(
      "service-instance_a",
      makeReportRequest(),
      makeDeps({ kind: "rejected", reasonCode: "rate_limited" }),
    );
    await result.settlement;
    expect(result.response).toBeUndefined();
    expect(result.errorKind).toBe("rate_limited");
  });

  it("maps an invalid report to invalid_params and a state mismatch to precondition_failed", async () => {
    const invalid = await routeManagedRunReportIngress(
      "service-instance_a",
      makeReportRequest(),
      makeDeps({ kind: "rejected", reasonCode: "invalid_report" }),
    );
    await invalid.settlement;
    expect(invalid.errorKind).toBe("invalid_params");

    const stateMismatch = await routeManagedRunReportIngress(
      "service-instance_a",
      makeReportRequest(),
      makeDeps({ kind: "rejected", reasonCode: "state_mismatch" }),
    );
    await stateMismatch.settlement;
    expect(stateMismatch.errorKind).toBe("precondition_failed");
  });
});

describe("capability-service approval receipt ingress", () => {
  it("consumes only an exact grant for a run owned by the authenticated service", async () => {
    const deps = makeDeps({ kind: "rejected", reasonCode: "state_mismatch" });
    const bound = deps.approvalGrants.bind({
      approval: {
        requestId: "10000000-0000-4000-8000-000000000001",
        approved: true,
        approvedBy: "user_a",
        resolvedAt: deps.clock.now(),
      },
      toolName: "mcp__fixture--apply_change",
      action: "mcp.fixture.apply_change",
      fingerprintParams: { arguments: { expectedHead: "a".repeat(40) } },
      owner: {
        kind: "owner",
        tenantId: "tenant_a",
        agentId: "agent_a",
        principalId: "user_a",
        conversationRef: "conversation-ref_a" as never,
      },
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      mcpOperationId: "mcp-operation_a",
    });
    expect(bound.ok).toBe(true);
    const request = {
      jsonrpc: "2.0",
      id: "consume-operation_a",
      method: "managedRuns.consumeApproval",
      params: {
        operationId: "consume-operation_a",
        managedRunId: "managed-run_a",
        approvalRequestId: "10000000-0000-4000-8000-000000000001",
        mcpOperationId: "mcp-operation_a",
      },
    } as z.infer<typeof CapabilityConsumeApprovalRequestSchema>;

    const consumed = await routeManagedApprovalGrantIngress(
      "service-instance_a",
      request,
      deps,
    );
    await consumed.settlement;
    expect(consumed.errorKind).toBeUndefined();
    expect(consumed.response).toMatchObject({
      state: "consumed",
      resolvingPrincipalId: "user_a",
    });

    const altered = await routeManagedApprovalGrantIngress(
      "service-instance_b",
      { ...request, params: { ...request.params, operationId: "consume-operation_b" } },
      deps,
    );
    await altered.settlement;
    expect(altered.errorKind).toBe("precondition_failed");
  });
});
