// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, expectTypeOf } from "vitest";
import {
  isNonEmptyEvents,
  type FinalDeliveryReceipt,
  type DeliveryFailureReceipt,
  type DeliveryStageResult,
  type TurnOutcome,
} from "./turn-outcome.js";
import type { ActivityEvent } from "./activity-event.js";
import type { Result } from "@comis/shared";

const sampleEvent = {} as ActivityEvent;

describe("FinalDeliveryReceipt", () => {
  it("requires ok:true + deliveredChunks + lastChunkMessageId + deliveredAtMs", () => {
    const receipt: FinalDeliveryReceipt = {
      ok: true,
      deliveredChunks: 3,
      lastChunkMessageId: "msg-99",
      deliveredAtMs: 1700000000000,
    };
    expect(receipt.ok).toBe(true);
    expect(receipt.deliveredAtMs).toBe(1700000000000);
    expectTypeOf<FinalDeliveryReceipt["ok"]>().toEqualTypeOf<true>();
    expectTypeOf<FinalDeliveryReceipt["deliveredAtMs"]>().toEqualTypeOf<number>();
    expectTypeOf<FinalDeliveryReceipt["lastChunkMessageId"]>().toEqualTypeOf<string>();
  });
});

describe("DeliveryFailureReceipt", () => {
  it("requires ok:false + errorKind + truncated lastError + failedChunks + failedAtMs", () => {
    const receipt: DeliveryFailureReceipt = {
      ok: false,
      deliveredChunks: 1,
      failedChunks: 2,
      errorKind: "platform",
      lastError: "rate limited",
      failedAtMs: 1700000000001,
    };
    expect(receipt.ok).toBe(false);
    expect(receipt.errorKind).toBe("platform");
    expectTypeOf<DeliveryFailureReceipt["ok"]>().toEqualTypeOf<false>();
    expectTypeOf<DeliveryFailureReceipt["lastError"]>().toEqualTypeOf<string>();
  });
});

describe("DeliveryStageResult", () => {
  it("is Result<FinalDeliveryReceipt, DeliveryFailureReceipt>", () => {
    expectTypeOf<DeliveryStageResult>().toEqualTypeOf<
      Result<FinalDeliveryReceipt, DeliveryFailureReceipt>
    >();
  });
});

describe("TurnOutcome discriminated union (ACT-05)", () => {
  const goodReceipt: FinalDeliveryReceipt = {
    ok: true,
    deliveredChunks: 1,
    lastChunkMessageId: "m1",
    deliveredAtMs: 1,
  };

  it("covers a success outcome with a final receipt", () => {
    const o: TurnOutcome = { kind: "success", trivial: true, delivery: goodReceipt };
    expect(o.kind).toBe("success");
  });

  it("covers success_with_recovered_failures with a non-empty tuple", () => {
    const o: TurnOutcome = {
      kind: "success_with_recovered_failures",
      trivial: false,
      delivery: goodReceipt,
      recoveredFailures: [sampleEvent],
    };
    expect(o.kind).toBe("success_with_recovered_failures");
  });

  it("rejects an EMPTY recoveredFailures tuple at the type level", () => {
    // @ts-expect-error recoveredFailures must be a non-empty tuple
    const bad: TurnOutcome = {
      kind: "success_with_recovered_failures",
      trivial: false,
      delivery: goodReceipt,
      recoveredFailures: [],
    };
    void bad;
  });

  it("covers failure with an errorKind and failedEvents", () => {
    const o: TurnOutcome = { kind: "failure", errorKind: "internal", failedEvents: [] };
    expect(o.kind).toBe("failure");
  });

  it("covers silent with reason NO_REPLY (type-checks)", () => {
    const o: TurnOutcome = { kind: "silent", reason: "NO_REPLY" };
    expect(o.kind).toBe("silent");
  });

  it("rejects silent.reason 'OTHER' at the type level", () => {
    // @ts-expect-error 'OTHER' is not a valid silent reason
    const bad: TurnOutcome = { kind: "silent", reason: "OTHER" };
    void bad;
  });

  it("silent.reason uses the SILENT/HEARTBEAT_OK/NO_REPLY token set", () => {
    const reasons: Array<Extract<TurnOutcome, { kind: "silent" }>["reason"]> = [
      "SILENT",
      "HEARTBEAT_OK",
      "NO_REPLY",
    ];
    expect(reasons).toHaveLength(3);
  });

  it("covers aborted with reason user_cancel/timeout/fatal", () => {
    const o: TurnOutcome = { kind: "aborted", reason: "timeout" };
    expect(o.kind).toBe("aborted");
  });
});

describe("isNonEmptyEvents guard", () => {
  it("returns false for an empty array (runtime guard for the tuple invariant)", () => {
    expect(isNonEmptyEvents([])).toBe(false);
  });
  it("returns true for a non-empty array", () => {
    expect(isNonEmptyEvents([sampleEvent])).toBe(true);
  });
});
