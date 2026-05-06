// SPDX-License-Identifier: Apache-2.0
//
// VisibleDeliveryRecord type/shape regression test.
//
// RED until 15-02 creates packages/shared/src/visible-delivery.ts.
// The module is type-only at runtime, so we exercise it via a literal
// value matching the documented shape (design §5: kind, channelType,
// channelId, caption, deliveredAt). The test fails until the module exists.
import { describe, it, expect } from "vitest";

async function loadVisibleDelivery(): Promise<Record<string, unknown> | undefined> {
  try {
    return (await import("./visible-delivery.js")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

describe("VisibleDeliveryRecord shape (T0.34 supporting type)", () => {
  it("module exists and a literal value matches the documented shape", async () => {
    const mod = await loadVisibleDelivery();
    // Module must exist post-15-02. Until then this fails.
    expect(mod).toBeDefined();

    // Construct a value that matches the documented shape (interface in
    // @comis/shared, no zod). Type assertion is acceptable here because
    // the test file is exercising the runtime "is the module loadable"
    // contract; the type itself is interface-only.
    type VisibleDeliveryRecord = {
      kind: "attachment";
      channelType: string;
      channelId: string;
      caption: string;
      deliveredAt: number;
    };
    const record: VisibleDeliveryRecord = {
      kind: "attachment",
      channelType: "telegram",
      channelId: "C",
      caption: "x",
      deliveredAt: 0,
    };
    expect(record.kind).toBe("attachment");
    expect(record.channelType).toBe("telegram");
    expect(record.channelId).toBe("C");
    expect(record.caption).toBe("x");
    expect(record.deliveredAt).toBe(0);
  });
});
