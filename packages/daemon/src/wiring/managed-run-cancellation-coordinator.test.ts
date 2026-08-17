// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import type { ManagedRunOwnerScope, ManagedRunRecord } from "@comis/core";
import { createManagedRunCancellationCoordinator } from "./managed-run-cancellation-coordinator.js";

const NOW_MS = 1_800_000_000_000;

function ownerScope(): ManagedRunOwnerScope {
  return {
    kind: "owner",
    tenantId: "tenant-a",
    agentId: "agent-a",
    principalId: "principal-a",
    conversationRef: "c".repeat(64),
  };
}

function record(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    managedRunId: "managed-run-a",
    serviceInstanceId: "service-instance-a",
    status: "active",
    statusReason: "report_activity",
    ...overrides,
  } as ManagedRunRecord;
}

function makeCoordinator(overrides: {
  claim?: ReturnType<typeof vi.fn>;
  cancel?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
} = {}) {
  const claimTransition = overrides.claim ?? vi.fn(async () => ok({
    kind: "claimed" as const,
    record: record({ status: "cancelled", statusReason: "owner_cancelled" }),
  }));
  const get = overrides.get ?? vi.fn(async () => ok(record()));
  const cancel = overrides.cancel ?? vi.fn(async () => ok({
    managedRunId: "managed-run-a",
    state: "cancelling" as const,
    acknowledgedAtMs: NOW_MS,
  }));
  const coordinator = createManagedRunCancellationCoordinator({
    store: { get, claimTransition } as never,
    control: { cancel } as never,
    nowMs: () => NOW_MS,
  });
  return { coordinator, claimTransition, cancel, get };
}

describe("managed-run cancellation", () => {
  it("records the host decision before asking the service to stop", async () => {
    const order: string[] = [];
    const claimTransition = vi.fn(async () => {
      order.push("claim");
      return ok({ kind: "claimed" as const, record: record({ status: "cancelled" }) });
    });
    const cancel = vi.fn(async () => {
      order.push("cancel");
      return ok({ managedRunId: "managed-run-a", state: "cancelling" as const, acknowledgedAtMs: NOW_MS });
    });
    const setup = makeCoordinator({ claim: claimTransition, cancel });

    const result = await setup.coordinator.cancel(ownerScope(), {
      operationId: "operation-cancel-a",
      managedRunId: "managed-run-a",
      reason: "owner_cancelled",
    });

    expect(result.ok && result.value.kind).toBe("cancelled");
    expect(order).toEqual(["claim", "cancel"]);
  });

  it("keeps the run cancelled when the service cannot be reached", async () => {
    // The host decided. A service that is down does not get to veto that, and
    // the operator must not be told the cancel failed when the authority record
    // already says cancelled — the service reconciles on its next handshake.
    const cancel = vi.fn(async () => err({ kind: "unavailable", reasonCode: "instance_not_connected" }));
    const setup = makeCoordinator({ cancel });

    const result = await setup.coordinator.cancel(ownerScope(), {
      operationId: "operation-cancel-a",
      managedRunId: "managed-run-a",
      reason: "owner_cancelled",
    });

    expect(result.ok && result.value).toMatchObject({
      kind: "cancelled",
      serviceAcknowledged: false,
      serviceReasonCode: "instance_not_connected",
    });
  });

  it("reports an already-terminal run without sending a second cancellation", async () => {
    const claimTransition = vi.fn(async () => ok({ kind: "status_mismatch" as const }));
    const get = vi.fn(async () => ok(record({ status: "succeeded", statusReason: "outcome_verified" })));
    const setup = makeCoordinator({ claim: claimTransition, get });

    const result = await setup.coordinator.cancel(ownerScope(), {
      operationId: "operation-cancel-a",
      managedRunId: "managed-run-a",
      reason: "owner_cancelled",
    });

    expect(result.ok && result.value).toMatchObject({ kind: "already_terminal", status: "succeeded" });
    expect(setup.cancel).not.toHaveBeenCalled();
  });

  it("refuses a run that is not visible in the caller's scope", async () => {
    const get = vi.fn(async () => ok(undefined));
    const setup = makeCoordinator({ get });

    const result = await setup.coordinator.cancel(ownerScope(), {
      operationId: "operation-cancel-a",
      managedRunId: "managed-run-a",
      reason: "owner_cancelled",
    });

    expect(result.ok && result.value).toEqual({ kind: "not_found" });
    expect(setup.cancel).not.toHaveBeenCalled();
  });
});
