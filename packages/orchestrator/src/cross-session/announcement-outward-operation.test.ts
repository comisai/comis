// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import type { OutwardSendLedgerPort, OutwardSendRecord } from "@comis/core";
import {
  createAnnouncementOperationDigests,
  createGovernedAnnouncementSender,
  createStableAnnouncementOperationId,
} from "./announcement-outward-operation.js";

function makeLedger(overrides: Partial<OutwardSendLedgerPort> = {}): OutwardSendLedgerPort {
  return {
    allocateStep: vi.fn(async () => ok(7)),
    lookup: vi.fn(async () => ok(undefined)),
    begin: vi.fn(async () => ok(undefined)),
    markUnknown: vi.fn(async () => ok(undefined)),
    commit: vi.fn(async () => ok(undefined)),
    markFailed: vi.fn(async () => ok(undefined)),
    parkUncertain: vi.fn(async () => ok(true)),
    hasUncertainty: vi.fn(async () => ok(false)),
    listUnreconciled: vi.fn(async () => ok([])),
    ...overrides,
  };
}

const request = {
  operationId: createStableAnnouncementOperationId(
    "agent-main",
    "default:user1:telegram:chat-1",
    "run-1",
  ),
  rootRunId: "root-1",
  agentId: "agent-main",
  channelType: "telegram",
  channelId: "chat-1",
  text: "completion announcement",
  options: { threadId: "topic-1" },
};

describe("governed announcement sender", () => {
  it("records the stable operation before one platform attempt and commits its receipt", async () => {
    const order: string[] = [];
    const ledger = makeLedger({
      allocateStep: vi.fn(async () => {
        order.push("allocate");
        return ok(7);
      }),
      begin: vi.fn(async () => {
        order.push("begin");
        return ok(undefined);
      }),
      markUnknown: vi.fn(async () => {
        order.push("mark-unknown");
        return ok(undefined);
      }),
      commit: vi.fn(async () => {
        order.push("commit");
        return ok(undefined);
      }),
    });
    const sendToPlatform = vi.fn(async () => {
      order.push("platform");
      return ok({ delivered: true, platformMessageId: "telegram-message-1" });
    });
    const sender = createGovernedAnnouncementSender({ ledger, sendToPlatform });

    const result = await sender.send(request);

    expect(result).toEqual(ok({
      delivered: true,
      identity: { agentId: "agent-main", rootRunId: "root-1", stepIndex: 7 },
    }));
    expect(order).toEqual(["allocate", "begin", "mark-unknown", "platform", "commit"]);
    expect(ledger.commit).toHaveBeenCalledWith("root-1", 7, "telegram-message-1");
    expect(sendToPlatform).toHaveBeenCalledOnce();
  });

  it("parks a resolved false result and never claims delivery", async () => {
    let row: OutwardSendRecord | undefined;
    const ledger = makeLedger({
      lookup: vi.fn(async () => ok(row)),
      begin: vi.fn(async (input) => {
        row = {
          id: "root-1:7",
          ...input,
          state: "send_attempt_started",
          attemptCount: 0,
          attemptedAtMs: 1,
        };
        return ok(undefined);
      }),
      markUnknown: vi.fn(async () => {
        row = row ? { ...row, state: "unknown_after_send", attemptCount: 1 } : row;
        return ok(undefined);
      }),
      parkUncertain: vi.fn(async () => {
        row = row ? { ...row, state: "unresolved", reconcileOutcome: "unresolved" } : row;
        return ok(true);
      }),
    });
    const sendToPlatform = vi.fn(async () => ok({ delivered: false }));
    const sender = createGovernedAnnouncementSender({ ledger, sendToPlatform });

    const first = await sender.send(request);
    const repeated = await sender.send(request);

    expect(first.ok && first.value.delivered).toBe(false);
    expect(repeated.ok && repeated.value.delivered).toBe(false);
    expect(sendToPlatform).toHaveBeenCalledOnce();
    expect(ledger.commit).not.toHaveBeenCalled();
    expect(ledger.parkUncertain).toHaveBeenCalledWith("root-1", 7);
  });

  it("derives a bounded stable allocation key from the authenticated origin", () => {
    const first = createStableAnnouncementOperationId("agent-a", "session-a", "run-a");
    const repeated = createStableAnnouncementOperationId("agent-a", "session-a", "run-a");
    const distinct = createStableAnnouncementOperationId("agent-a", "session-a", "run-b");

    expect(first).toBe(repeated);
    expect(first).not.toBe(distinct);
    expect(first.length).toBeLessThanOrEqual(256);
  });

  it("allocates distinct stable operations for separate completion files", () => {
    const first = createStableAnnouncementOperationId("agent-a", "session-a", "run-a", "attachment:0");
    const repeated = createStableAnnouncementOperationId("agent-a", "session-a", "run-a", "attachment:0");
    const second = createStableAnnouncementOperationId("agent-a", "session-a", "run-a", "attachment:1");

    expect(first).toBe(repeated);
    expect(first).not.toBe(second);
  });

  it("rejects unsupported options before allocating an outward operation", async () => {
    const ledger = makeLedger();
    const sendToPlatform = vi.fn(async () => ok({
      delivered: true,
      platformMessageId: "unexpected-receipt",
    }));
    const sender = createGovernedAnnouncementSender({ ledger, sendToPlatform });

    const result = await sender.send({
      ...request,
      options: { extra: { unsafe: 1n } },
    });

    expect(result).toEqual(ok({
      delivered: false,
      failure: "operation_validation_blocked",
    }));
    expect(ledger.allocateStep).not.toHaveBeenCalled();
    expect(ledger.lookup).not.toHaveBeenCalled();
    expect(ledger.begin).not.toHaveBeenCalled();
    expect(sendToPlatform).not.toHaveBeenCalled();
  });

  it("fails closed at every durable ledger transition without an extra platform attempt", async () => {
    const cases: Array<{
      expectedFailure: string;
      ledger: OutwardSendLedgerPort;
      platformReceipt?: string;
    }> = [
      {
        expectedFailure: "allocation_blocked",
        ledger: makeLedger({ allocateStep: vi.fn(async () => err(new Error("allocate failed"))) }),
      },
      {
        expectedFailure: "lookup_blocked",
        ledger: makeLedger({ lookup: vi.fn(async () => err(new Error("lookup failed"))) }),
      },
      {
        expectedFailure: "begin_blocked",
        ledger: makeLedger({ begin: vi.fn(async () => err(new Error("begin failed"))) }),
      },
      {
        expectedFailure: "uncertainty_transition_blocked",
        ledger: makeLedger({
          markUnknown: vi.fn(async () => err(new Error("mark unknown failed"))),
          parkUncertain: vi.fn(async () => err(new Error("park failed"))),
        }),
      },
      {
        expectedFailure: "commit_blocked",
        ledger: makeLedger({ commit: vi.fn(async () => err(new Error("commit failed"))) }),
        platformReceipt: "telegram-message-uncommitted",
      },
    ];

    for (const testCase of cases) {
      const sendToPlatform = vi.fn(async () => ok({
        delivered: true,
        platformMessageId: testCase.platformReceipt ?? "telegram-message-unexpected",
      }));
      const result = await createGovernedAnnouncementSender({
        ledger: testCase.ledger,
        sendToPlatform,
      }).send(request);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toMatchObject({ delivered: false, failure: testCase.expectedFailure });
      expect(sendToPlatform).toHaveBeenCalledTimes(testCase.platformReceipt === undefined ? 0 : 1);
    }
  });
});

describe("announcement operation fingerprinting", () => {
  it("binds generated-file content but not the private snapshot path", () => {
    const attachment = {
      path: "/private/snapshot-one.csv",
      fileName: "monthly.csv",
      mimeType: "text/csv",
      contentDigest: "a".repeat(64),
      sizeBytes: 128,
    };
    const first = createAnnouncementOperationDigests({
      channelType: "telegram",
      channelId: "chat-1",
      text: "report ready",
      attachment,
    });
    const relocated = createAnnouncementOperationDigests({
      channelType: "telegram",
      channelId: "chat-1",
      text: "report ready",
      attachment: { ...attachment, path: "/private/snapshot-two.csv" },
    });
    const changed = createAnnouncementOperationDigests({
      channelType: "telegram",
      channelId: "chat-1",
      text: "report ready",
      attachment: { ...attachment, contentDigest: "b".repeat(64) },
    });

    expect(first.ok && relocated.ok && first.value).toEqual(relocated.ok && relocated.value);
    expect(first.ok && changed.ok && first.value.operationFingerprint)
      .not.toBe(changed.ok && changed.value.operationFingerprint);
  });

  it("canonicalizes semantically equal nested option key orders", () => {
    const first = createAnnouncementOperationDigests({
      channelType: "telegram",
      channelId: "chat-1",
      text: "completion",
      options: {
        extra: {
          zeta: 3,
          nested: { beta: [true, null, "value"], alpha: 1 },
        },
      },
    });
    const reordered = createAnnouncementOperationDigests({
      channelType: "telegram",
      channelId: "chat-1",
      text: "completion",
      options: {
        extra: {
          nested: { alpha: 1, beta: [true, null, "value"] },
          zeta: 3,
        },
      },
    });

    expect(first.ok).toBe(true);
    expect(reordered.ok).toBe(true);
    if (!first.ok || !reordered.ok) return;
    expect(first.value).toEqual(reordered.value);
  });

  it("returns validation failures for cyclic and non-JSON option values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const unsupported: unknown[] = [
      cyclic,
      { value: 1n },
      { value: undefined },
      { value: () => "unsupported" },
      { value: Symbol("unsupported") },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: new Date(0) },
    ];

    for (const extra of unsupported) {
      const invocation = () => createAnnouncementOperationDigests({
        channelType: "telegram",
        channelId: "chat-1",
        text: "completion",
        options: { extra: extra as Record<string, unknown> },
      });
      expect(invocation).not.toThrow();
      expect(invocation()).toMatchObject({ ok: false });
    }
  });
});
