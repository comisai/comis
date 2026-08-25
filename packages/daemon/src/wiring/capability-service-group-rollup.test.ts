// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { CapabilityGroupGetHostRollupRequestSchema } from "@comis/capability-service-sdk";
import type { ComisLogger, ManagedRunGroupRecord } from "@comis/core";
import { err, ok } from "@comis/shared";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { routeManagedRunGroupRollupIngress } from "./capability-service-ingress-routes.js";
import type { CapabilityServiceIngressRouteDeps } from "./capability-service-ingress-routes.js";

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

const GROUP: ManagedRunGroupRecord = {
  schemaVersion: 1,
  managedRunGroupId: "managed-run-group_a",
  serviceInstanceId: "service-instance_a",
  tenantId: "tenant_a",
  agentId: "agent_a",
  principalId: "principal_a",
  conversationRef: `cv_${"a".repeat(43)}`,
  rootRunId: "root-run_a",
  memberManagedRunIds: ["managed-run_a", "managed-run_b"],
  stateCounts: { active: 1, waiting: 1 },
  attentionCount: 1,
  activeCustodyCount: 0,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_500,
};

function makeRequest(): z.infer<typeof CapabilityGroupGetHostRollupRequestSchema> {
  return {
    jsonrpc: "2.0",
    id: "operation_a",
    method: "managedRunGroups.getHostRollup",
    params: { operationId: "operation_a", managedRunGroupId: "managed-run-group_a" },
  };
}

function makeDeps(
  groupStore: CapabilityServiceIngressRouteDeps["groupStore"],
): CapabilityServiceIngressRouteDeps {
  return {
    reportBridge: {} as never,
    evidenceBridge: {} as never,
    attentionResponseBridge: {} as never,
    livenessBridge: {} as never,
    releaseCoordinator: {} as never,
    groupStore,
    requestDeadlineMs: 5_000,
    clock: createFakeClock(1_800_000_000_000),
    timers: createFakeTimers(0),
    logger: makeLogger(),
  };
}

describe("capability-service group roll-up ingress", () => {
  it("returns counts derived from member run facts", async () => {
    const result = await routeManagedRunGroupRollupIngress(
      "service-instance_a",
      makeRequest(),
      makeDeps({ getGroup: async () => ok(GROUP) }),
    );
    await result.settlement;
    expect(result.errorKind).toBeUndefined();
    expect(result.response).toEqual({
      managedRunGroupId: "managed-run-group_a",
      memberManagedRunIds: ["managed-run_a", "managed-run_b"],
      stateCounts: { active: 1, waiting: 1 },
      attentionCount: 1,
      activeCustodyCount: 0,
      updatedAtMs: 1_800_000_000_500,
    });
  });

  it("refuses a group the calling service instance does not own", async () => {
    // The store resolves scope, so a foreign caller sees "no such group" — the
    // same answer as one that never existed. A distinct error would confirm the
    // group's existence to a service with no authority over it.
    const result = await routeManagedRunGroupRollupIngress(
      "service-instance_b",
      makeRequest(),
      makeDeps({ getGroup: async () => ok(undefined) }),
    );
    await result.settlement;
    expect(result.response).toBeUndefined();
    expect(result.errorKind).toBe("precondition_failed");
  });

  it("reports a store failure as an internal error rather than an empty roll-up", async () => {
    const result = await routeManagedRunGroupRollupIngress(
      "service-instance_a",
      makeRequest(),
      makeDeps({ getGroup: async () => err(new Error("database is unavailable")) }),
    );
    await result.settlement;
    expect(result.response).toBeUndefined();
    expect(result.errorKind).toBe("internal_error");
  });

  it("carries no domain workflow vocabulary onto the wire", async () => {
    const result = await routeManagedRunGroupRollupIngress(
      "service-instance_a",
      makeRequest(),
      makeDeps({ getGroup: async () => ok(GROUP) }),
    );
    await result.settlement;
    const keys = Object.keys(result.response ?? {});
    for (const forbidden of ["dependsOn", "edges", "componentName", "integrationOrder", "milestone"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    // Nor the host's own scope fields: the caller already authenticated as the
    // owning service and learns nothing new from tenant or principal.
    for (const scopeField of ["tenantId", "agentId", "principalId", "conversationRef"]) {
      expect(keys, scopeField).not.toContain(scopeField);
    }
  });
});
