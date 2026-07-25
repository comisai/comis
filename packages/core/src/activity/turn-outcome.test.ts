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
  it("preserves the last platform message ID when delivery was tracked", () => {
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
    expectTypeOf<FinalDeliveryReceipt["lastChunkMessageId"]>()
      .toEqualTypeOf<string | undefined>();
  });

  it("permits successful delivery without a platform tracking ID", () => {
    const receipt: FinalDeliveryReceipt = {
      ok: true,
      deliveredChunks: 1,
      deliveredAtMs: 1700000000000,
    };

    expect(receipt).toEqual({
      ok: true,
      deliveredChunks: 1,
      deliveredAtMs: 1700000000000,
    });
  });
});

describe("DeliveryFailureReceipt", () => {
  it("requires total and outcome counts with a bounded error and failure timestamp", () => {
    const receipt: DeliveryFailureReceipt = {
      ok: false,
      totalChunks: 3,
      deliveredChunks: 1,
      failedChunks: 2,
      errorKind: "platform",
      lastError: "rate limited",
      failedAtMs: 1700000000001,
    };
    expect(receipt.ok).toBe(false);
    expect(receipt.totalChunks).toBe(3);
    expect(receipt.errorKind).toBe("platform");
    expectTypeOf<DeliveryFailureReceipt["ok"]>().toEqualTypeOf<false>();
    expectTypeOf<DeliveryFailureReceipt["totalChunks"]>().toEqualTypeOf<number>();
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

describe("TurnOutcome discriminated union", () => {
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

  it("types recoveredFailures as a non-empty tuple (rejects [] at the type level)", () => {
    type Recovered = Extract<
      TurnOutcome,
      { kind: "success_with_recovered_failures" }
    >["recoveredFailures"];
    // The tuple type requires at least one element — `readonly []` is NOT assignable.
    expectTypeOf<Recovered>().toEqualTypeOf<readonly [ActivityEvent, ...ActivityEvent[]]>();
    expectTypeOf<readonly []>().not.toMatchTypeOf<Recovered>();
  });

  it("covers failure with an errorKind and failedEvents", () => {
    const o: TurnOutcome = { kind: "failure", errorKind: "internal", failedEvents: [] };
    expect(o.kind).toBe("failure");
  });

  it("covers silent with reason NO_REPLY (type-checks)", () => {
    const o: TurnOutcome = { kind: "silent", reason: "NO_REPLY" };
    expect(o.kind).toBe("silent");
  });

  it("constrains silent.reason to the SILENT/HEARTBEAT_OK/NO_REPLY token set (rejects 'OTHER')", () => {
    type SilentReason = Extract<TurnOutcome, { kind: "silent" }>["reason"];
    expectTypeOf<SilentReason>().toEqualTypeOf<"SILENT" | "HEARTBEAT_OK" | "NO_REPLY">();
    expectTypeOf<"OTHER">().not.toMatchTypeOf<SilentReason>();
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
