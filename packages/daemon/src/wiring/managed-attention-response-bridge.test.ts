// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  type ComisLogger,
  type ManagedRunAttentionRecord,
  type ManagedRunContentPort,
  type ManagedRunRecord,
  type ManagedRunStorePort,
} from "@comis/core";
import { ok } from "@comis/shared";
import { managedRunAttentionId } from "./managed-run-attention-identity.js";
import { createManagedAttentionResponseBridge } from "./managed-attention-response-bridge.js";

const NOW_MS = 1_800_000_000_000;
const INPUT = {
  operationId: "operation_attention_response_a",
  serviceInstanceId: "service-instance_a",
  managedRunId: "managed-run_a",
  externalKey: "backend-id-format",
};
const ATTENTION_ID = managedRunAttentionId(INPUT);

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

function record(): ManagedRunRecord {
  return {
    managedRunId: INPUT.managedRunId,
    serviceInstanceId: INPUT.serviceInstanceId,
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "principal_a",
    conversationRef: "conversation_a",
  } as unknown as ManagedRunRecord;
}

function attention(
  status: "open" | "response_pending" | "delivered" = "response_pending",
): ManagedRunAttentionRecord {
  return {
    schemaVersion: 1,
    attentionId: ATTENTION_ID,
    managedRunId: INPUT.managedRunId,
    serviceInstanceId: INPUT.serviceInstanceId,
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "principal_a",
    conversationRef: "conversation_a",
    externalKey: INPUT.externalKey,
    reportSequence: 1,
    attentionRef: "service-report_attention",
    status,
    ...(status === "open" ? {} : { responseRef: "attention-response_a" }),
    createdAtMs: NOW_MS - 200,
    updatedAtMs: NOW_MS - 100,
  } as ManagedRunAttentionRecord;
}

function makeBridge(attentionRecord: ManagedRunAttentionRecord | undefined) {
  const store = {
    get: vi.fn(async () => ok(record())),
    getAttention: vi.fn(async () => ok(attentionRecord)),
    markAttentionDelivered: vi.fn(async (_scope, input) => ok({
      kind: "updated" as const,
      record: {
        ...attentionRecord!,
        status: "delivered" as const,
        updatedAtMs: input.deliveredAtMs,
      },
    })),
  } as unknown as ManagedRunStorePort;
  const contentStore = {
    getAttentionBody: vi.fn(async () => ok(
      new TextEncoder().encode("Use monotonic issue-N values."),
    )),
  } as unknown as ManagedRunContentPort;
  const logger = makeLogger();
  const eventBus = new TypedEventBus();
  return {
    bridge: createManagedAttentionResponseBridge({
      store,
      contentStore,
      nowMs: () => NOW_MS,
      eventBus,
      logger,
    }),
    store,
    contentStore,
    logger,
    eventBus,
  };
}

describe("managed attention response bridge", () => {
  it("keeps an unanswered exact attention request pending", async () => {
    const setup = makeBridge(attention("open"));

    expect(await setup.bridge.receiveAttentionResponse(INPUT)).toEqual(ok({
      kind: "pending",
      managedRunId: INPUT.managedRunId,
      externalKey: INPUT.externalKey,
    }));
    expect(setup.contentStore.getAttentionBody).not.toHaveBeenCalled();
    expect(setup.store.markAttentionDelivered).not.toHaveBeenCalled();
  });

  it("atomically delivers private response content without logging it", async () => {
    const setup = makeBridge(attention());
    const emitted = vi.fn();
    setup.eventBus.on("managed_run:attention_response_delivered", emitted);

    expect(await setup.bridge.receiveAttentionResponse(INPUT)).toEqual(ok({
      kind: "delivered",
      managedRunId: INPUT.managedRunId,
      externalKey: INPUT.externalKey,
      response: "Use monotonic issue-N values.",
    }));
    expect(setup.store.get).toHaveBeenCalledWith({
      kind: "service",
      serviceInstanceId: INPUT.serviceInstanceId,
    }, INPUT.managedRunId);
    expect(setup.store.markAttentionDelivered).toHaveBeenCalledWith(expect.objectContaining({
      kind: "owner",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
    }), {
      operationId: INPUT.operationId,
      attentionId: ATTENTION_ID,
      deliveredAtMs: NOW_MS,
    });
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({
      managedRunId: INPUT.managedRunId,
      attentionId: ATTENTION_ID,
      serviceInstanceId: INPUT.serviceInstanceId,
    }));
    expect(JSON.stringify({
      info: (setup.logger.info as ReturnType<typeof vi.fn>).mock.calls,
      debug: (setup.logger.debug as ReturnType<typeof vi.fn>).mock.calls,
    })).not.toContain("Use monotonic issue-N values.");
  });

  it("returns an already delivered private response without another transition", async () => {
    const setup = makeBridge(attention("delivered"));
    const emitted = vi.fn();
    setup.eventBus.on("managed_run:attention_response_delivered", emitted);

    expect(await setup.bridge.receiveAttentionResponse(INPUT)).toMatchObject({
      ok: true,
      value: { kind: "delivered", response: "Use monotonic issue-N values." },
    });
    expect(setup.store.markAttentionDelivered).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
  });

  it("fails closed when the authenticated service does not own the run", async () => {
    const setup = makeBridge(attention());
    (setup.store.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(undefined));
    const failed = vi.fn();
    setup.eventBus.on("managed_run:attention_response_delivery_failed", failed);

    expect(await setup.bridge.receiveAttentionResponse(INPUT)).toEqual(ok({
      kind: "rejected",
      reasonCode: "managed_run_not_found",
    }));
    expect(setup.store.getAttention).not.toHaveBeenCalled();
    expect(setup.contentStore.getAttentionBody).not.toHaveBeenCalled();
    expect(setup.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      errorKind: "precondition",
      hint: expect.any(String),
    }), "Managed attention response delivery rejected");
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "managed_run_not_found",
    }));
  });
});
