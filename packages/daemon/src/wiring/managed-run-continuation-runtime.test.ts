// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  createConversationRef,
  type ManagedRunRecord,
  type ManagedRunStorePort,
} from "@comis/core";
import { err, ok } from "@comis/shared";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import type {
  ManagedRunContinuationCoordinator,
  ManagedRunContinuationProcessOutcome,
} from "./managed-run-continuation-coordinator.js";
import { createManagedRunContinuationRuntime } from "./managed-run-continuation-runtime.js";

function makeLogger() {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => child),
  } as unknown as import("@comis/core").ComisLogger;
}

function makeRecord(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "echo-main",
    conversationId: "conversation-a",
    conversationKind: "direct" as const,
  };
  const conversation = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: {
      kind: "endpoint-conversation-principal" as const,
      endpoint,
      principalId: "user-a",
    },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    schemaVersion: 1,
    managedRunId: "managed-run-a",
    serviceInstanceId: "service-a",
    externalRunRefDigest: "1".repeat(64),
    activationDescriptorDigest: "2".repeat(64),
    tenantId: "tenant-a",
    agentId: "agent-a",
    principalId: "user-a",
    conversationRef: conversationRef.value,
    turnScope: { conversation, principal: { principalId: "user-a" }, endpoint },
    deliveryOrigin: {
      tenantId: "tenant-a", channelType: "echo", channelId: "conversation-a", userId: "user-a",
    },
    traceId: "10000000-0000-4000-8000-000000000001",
    trustLevel: "user",
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    workspacePolicyHash: "a".repeat(64),
    rootRunId: "root-a",
    initiationSource: "user_request",
    capturedAgentCapabilities: ["orch:read"],
    capturedToolIds: ["managed_status"],
    capturedCapabilityViewHash: "b".repeat(64),
    executionAttachmentIds: [],
    terminalSessionIds: [],
    status: "active",
    statusReason: "report_activity",
    lastAcceptedReportSequence: 1,
    lastReducedReportSequence: 0,
    pendingContinuation: true,
    openAttentionCount: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
    lastHeartbeatAtMs: 2,
    ...overrides,
  };
}

describe("managed-run continuation event runtime", () => {
  it("subscribes accepted reports to exact-owner processing and folds a report burst", async () => {
    const eventBus = new TypedEventBus();
    const record = makeRecord();
    const store = {
      get: vi.fn(async () => ok(record)),
      listRecoverable: vi.fn(async () => ok({ records: [], invalid: [] })),
    } as unknown as ManagedRunStorePort;
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const process = vi.fn()
      .mockImplementationOnce(async () => {
        await first;
        return ok<ManagedRunContinuationProcessOutcome>({ kind: "idle" });
      })
      .mockResolvedValue(ok<ManagedRunContinuationProcessOutcome>({ kind: "idle" }));
    const coordinator = { process } as ManagedRunContinuationCoordinator;
    const timers = createFakeTimers();
    const runtime = createManagedRunContinuationRuntime({
      eventBus,
      store,
      coordinator,
      nowMs: () => 100,
      timers,
      recoveryBatchSize: 10,
      logger: makeLogger(),
    });

    eventBus.emit("managed_run:report_accepted", {
      managedRunId: "managed-run-a",
      serviceInstanceId: "service-a",
      sequence: 1,
      kind: "progress",
      durationMs: 1,
      timestamp: 10,
    });
    eventBus.emit("managed_run:report_accepted", {
      managedRunId: "managed-run-a",
      serviceInstanceId: "service-a",
      sequence: 2,
      kind: "candidate_complete",
      durationMs: 1,
      timestamp: 11,
    });
    timers.advance(50);
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    releaseFirst();
    await runtime.waitUntilIdle();

    expect(store.get).toHaveBeenCalledWith({ kind: "service", serviceInstanceId: "service-a" }, "managed-run-a");
    expect(process).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledWith({
      kind: "owner",
      tenantId: "tenant-a",
      agentId: "agent-a",
      principalId: "user-a",
      conversationRef: record.conversationRef,
    }, "managed-run-a");
    await runtime.shutdown();
    expect(eventBus.listenerCount("managed_run:report_accepted")).toBe(0);
  });

  it("recovers only durable records whose continuation is pending", async () => {
    const eventBus = new TypedEventBus();
    const pending = makeRecord();
    const settled = { ...makeRecord(), managedRunId: "managed-run-b", pendingContinuation: false };
    const store = {
      get: vi.fn(),
      listRecoverable: vi.fn(async () => ok({ records: [pending, settled], invalid: [] })),
    } as unknown as ManagedRunStorePort;
    const process = vi.fn(async () => ok<ManagedRunContinuationProcessOutcome>({ kind: "idle" }));
    const runtime = createManagedRunContinuationRuntime({
      eventBus,
      store,
      coordinator: { process } as ManagedRunContinuationCoordinator,
      nowMs: () => 100,
      timers: createFakeTimers(),
      recoveryBatchSize: 10,
      logger: makeLogger(),
    });

    expect(await runtime.recover()).toEqual(ok({ scheduledCount: 1, invalidCount: 0 }));
    await runtime.waitUntilIdle();
    expect(store.listRecoverable).toHaveBeenCalledWith({
      kind: "recovery",
      statuses: ["active", "waiting", "paused", "candidate_complete", "unknown"],
      updatedBeforeMs: 100,
      limit: 10,
    });
    expect(process).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it("recovers pending continuations across every stable recovery page", async () => {
    const eventBus = new TypedEventBus();
    const first = makeRecord({ managedRunId: "managed-run-a" });
    const second = makeRecord({ managedRunId: "managed-run-b" });
    const listRecoverable = vi.fn()
      .mockResolvedValueOnce(ok({
        records: [first],
        invalid: [],
        nextAfterManagedRunId: first.managedRunId,
      }))
      .mockResolvedValueOnce(ok({ records: [second], invalid: [] }));
    const process = vi.fn(async () => ok<ManagedRunContinuationProcessOutcome>({ kind: "idle" }));
    const runtime = createManagedRunContinuationRuntime({
      eventBus,
      store: { listRecoverable } as unknown as ManagedRunStorePort,
      coordinator: { process } as ManagedRunContinuationCoordinator,
      nowMs: () => 100,
      timers: createFakeTimers(),
      recoveryBatchSize: 1,
      logger: makeLogger(),
    });

    expect(await runtime.recover()).toEqual(ok({ scheduledCount: 2, invalidCount: 0 }));
    await runtime.waitUntilIdle();
    expect(listRecoverable).toHaveBeenNthCalledWith(2, {
      kind: "recovery",
      statuses: ["active", "waiting", "paused", "candidate_complete", "unknown"],
      updatedBeforeMs: 100,
      limit: 1,
      afterManagedRunId: "managed-run-a",
    });
    expect(process).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });

  it("repeats processing when the durable outcome retains pending work", async () => {
    const eventBus = new TypedEventBus();
    const record = makeRecord();
    const store = {
      get: vi.fn(async () => ok(record)),
      listRecoverable: vi.fn(async () => ok({ records: [], invalid: [] })),
    } as unknown as ManagedRunStorePort;
    const process = vi.fn()
      .mockResolvedValueOnce(ok<ManagedRunContinuationProcessOutcome>({
        kind: "processed",
        throughReportSequence: 1,
        pendingAfterCurrent: true,
      }))
      .mockResolvedValueOnce(ok<ManagedRunContinuationProcessOutcome>({ kind: "idle" }));
    const timers = createFakeTimers();
    const runtime = createManagedRunContinuationRuntime({
      eventBus,
      store,
      coordinator: { process } as ManagedRunContinuationCoordinator,
      nowMs: () => 100,
      timers,
      recoveryBatchSize: 10,
      logger: makeLogger(),
    });

    eventBus.emit("managed_run:report_accepted", {
      managedRunId: "managed-run-a",
      serviceInstanceId: "service-a",
      sequence: 1,
      kind: "progress",
      durationMs: 1,
      timestamp: 10,
    });
    timers.advance(50);
    await runtime.waitUntilIdle();

    expect(process).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });

  it("logs a bounded safe cause when continuation processing fails", async () => {
    const eventBus = new TypedEventBus();
    const record = makeRecord();
    const store = {
      get: vi.fn(async () => ok(record)),
      listRecoverable: vi.fn(async () => ok({ records: [], invalid: [] })),
    } as unknown as ManagedRunStorePort;
    const error = vi.fn();
    const child = { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn() };
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => child),
    } as unknown as import("@comis/core").ComisLogger;
    const timers = createFakeTimers();
    const runtime = createManagedRunContinuationRuntime({
      eventBus,
      store,
      coordinator: {
        process: vi.fn(async () => err(new Error("candidate claim failed with token=fixture-secret-value"))),
      },
      nowMs: () => 100,
      timers,
      recoveryBatchSize: 10,
      logger,
    });

    eventBus.emit("managed_run:report_accepted", {
      managedRunId: "managed-run-a",
      serviceInstanceId: "service-a",
      sequence: 1,
      kind: "candidate_complete",
      durationMs: 1,
      timestamp: 10,
    });
    timers.advance(50);
    await runtime.waitUntilIdle();

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining("candidate claim failed") }),
      "Managed-run continuation processing failed",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("fixture-secret-value");
    await runtime.shutdown();
  });
});
