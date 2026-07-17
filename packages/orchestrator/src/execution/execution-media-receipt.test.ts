// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { err } from "@comis/shared";
import type { DeliveryFailureReceipt } from "@comis/core";
import { createMediaDeliveryFailureReceipt } from "./execution-media-receipt.js";

describe("media delivery failure receipt", () => {
  it("aggregates media and later text delivery counts without content", () => {
    const laterFailure: DeliveryFailureReceipt = {
      ok: false,
      totalChunks: 2,
      deliveredChunks: 1,
      failedChunks: 1,
      errorKind: "platform",
      lastError: "text delivery failed",
      failedAtMs: 2_000,
    };

    expect(createMediaDeliveryFailureReceipt(
      { delivered: 2, failed: 1, failedAtMs: 1_000 },
      err(laterFailure),
      1,
    )).toEqual({
      ok: false,
      totalChunks: 6,
      deliveredChunks: 4,
      failedChunks: 2,
      errorKind: "platform",
      lastError: "Outbound media delivery failed",
      failedAtMs: 1_000,
    });
  });
});
