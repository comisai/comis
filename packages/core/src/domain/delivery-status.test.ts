// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  parseDeliveryFailureStage,
  parseDeliveryStatus,
} from "./delivery-status.js";

describe("delivery lifecycle status", () => {
  it.each(["success", "error", "timeout", "filtered", "aborted"] as const)(
    "accepts the closed lifecycle member %s",
    (status) => {
      const parsed = parseDeliveryStatus(status);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toBe(status);
    },
  );

  it("rejects statuses outside the lifecycle contract", () => {
    expect(parseDeliveryStatus("delivered").ok).toBe(false);
    expect(parseDeliveryStatus("failed").ok).toBe(false);
  });

  it("limits failure provenance to execution or delivery", () => {
    expect(parseDeliveryFailureStage("execution")).toMatchObject({
      ok: true,
      value: "execution",
    });
    expect(parseDeliveryFailureStage("delivery")).toMatchObject({
      ok: true,
      value: "delivery",
    });
    expect(parseDeliveryFailureStage("filter").ok).toBe(false);
  });
});
