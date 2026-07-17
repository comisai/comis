// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import type {
  DeliveryService,
  OutwardSendLedgerPort,
  TypedEventBus,
} from "@comis/core";
import { createAnnouncementDelivery } from "./governed-announcement-delivery.js";

const eventBus = {
  emitSafely: vi.fn(() => ({ failures: [], pendingFailures: Promise.resolve([]) })),
} as unknown as TypedEventBus;

function makeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(),
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  } as unknown as DeliveryService;
}

function makeLedger(): OutwardSendLedgerPort {
  return {
    allocateStep: vi.fn(async () => ok(0)),
    lookup: vi.fn(async () => ok(undefined)),
    begin: vi.fn(async () => ok(undefined)),
    markUnknown: vi.fn(async () => ok(undefined)),
    commit: vi.fn(async () => ok(undefined)),
    markFailed: vi.fn(async () => ok(undefined)),
    parkUncertain: vi.fn(async () => ok(true)),
    hasUncertainty: vi.fn(async () => ok(false)),
    listUnreconciled: vi.fn(async () => ok([])),
  };
}

describe("completion announcement delivery wiring", () => {
  it("returns false without calling the delivery service when no adapter exists", async () => {
    const deliveryService = makeDeliveryService();
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map(),
      deliveryService,
      eventBus,
    });

    await expect(delivery.sendToChannel("telegram", "chat-1", "text"))
      .resolves.toBe(false);
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it("blocks a governed attempt before allocation when the root resolver is absent", async () => {
    const ledger = makeLedger();
    const deliveryService = makeDeliveryService();
    const delivery = createAnnouncementDelivery({
      adaptersByType: new Map(),
      deliveryService,
      eventBus,
      outwardLedger: ledger,
    });

    const result = await delivery.sendGovernedAnnouncement?.({
      agentId: "agent-1",
      callerSessionKey: "default:user1:chan1",
      runId: "run-1",
      channelType: "telegram",
      channelId: "chat-1",
      text: "completion",
    });

    expect(result).toEqual(ok({ delivered: false, failure: "allocation_blocked" }));
    expect(ledger.allocateStep).not.toHaveBeenCalled();
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });
});
