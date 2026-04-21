// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { DeliveryOriginSchema, createDeliveryOrigin } from "./delivery-origin.js";

describe("DeliveryOrigin", () => {
  const validInput = {
    channelType: "telegram",
    channelId: "chat-123",
    userId: "user-456",
    threadId: "thread-789",
    tenantId: "acme",
  };

  describe("createDeliveryOrigin", () => {
    it("creates a frozen DeliveryOrigin with all fields", () => {
      const origin = createDeliveryOrigin(validInput);

      expect(origin.channelType).toBe("telegram");
      expect(origin.channelId).toBe("chat-123");
      expect(origin.userId).toBe("user-456");
      expect(origin.threadId).toBe("thread-789");
      expect(origin.tenantId).toBe("acme");
      expect(Object.isFrozen(origin)).toBe(true);
    });

    it("defaults tenantId to 'default' when omitted", () => {
      const origin = createDeliveryOrigin({
        channelType: "discord",
        channelId: "ch-1",
        userId: "u-1",
      });

      expect(origin.tenantId).toBe("default");
    });

    it("allows threadId to be omitted (undefined)", () => {
      const origin = createDeliveryOrigin({
        channelType: "discord",
        channelId: "ch-1",
        userId: "u-1",
      });

      expect(origin.threadId).toBeUndefined();
    });

    it("rejects empty channelType", () => {
      expect(() =>
        createDeliveryOrigin({ ...validInput, channelType: "" }),
      ).toThrow();
    });

    it("rejects empty channelId", () => {
      expect(() =>
        createDeliveryOrigin({ ...validInput, channelId: "" }),
      ).toThrow();
    });

    it("rejects empty userId", () => {
      expect(() =>
        createDeliveryOrigin({ ...validInput, userId: "" }),
      ).toThrow();
    });

    it("produces a frozen object that rejects property assignment", () => {
      const origin = createDeliveryOrigin(validInput);

      expect(Object.isFrozen(origin)).toBe(true);

      // In strict mode, assignment to frozen properties throws
      expect(() => {
        (origin as Record<string, unknown>)["channelType"] = "hacked";
      }).toThrow(TypeError);
    });
  });

  describe("DeliveryOriginSchema (z.strictObject)", () => {
    it("rejects unknown extra fields", () => {
      const result = DeliveryOriginSchema.safeParse({
        ...validInput,
        extra: "not-allowed",
      });

      expect(result.success).toBe(false);
    });

    it("rejects missing required fields", () => {
      const result = DeliveryOriginSchema.safeParse({});

      expect(result.success).toBe(false);
    });
  });
});
