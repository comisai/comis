// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { SenderTrustDisplayConfigSchema } from "./schema-sender-trust-display.js";

describe("SenderTrustDisplayConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = SenderTrustDisplayConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.displayMode).toBe("hash");
      expect(result.data.hashPrefix).toBe(8);
      expect(result.data.hashSecretRef).toBe("");
      expect(result.data.aliases).toEqual({});
    }
  });

  it("accepts fully specified config", () => {
    const result = SenderTrustDisplayConfigSchema.safeParse({
      enabled: true,
      displayMode: "alias",
      hashPrefix: 12,
      hashSecretRef: "secrets/hmac-key",
      aliases: {
        "user-123": "Alice",
        "user-456": "Bob",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.displayMode).toBe("alias");
      expect(result.data.hashPrefix).toBe(12);
      expect(result.data.hashSecretRef).toBe("secrets/hmac-key");
      expect(result.data.aliases["user-123"]).toBe("Alice");
    }
  });

  it("rejects unknown keys (strictObject)", () => {
    const result = SenderTrustDisplayConfigSchema.safeParse({
      enabled: true,
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid displayMode enum value", () => {
    const result = SenderTrustDisplayConfigSchema.safeParse({
      displayMode: "obfuscated",
    });
    expect(result.success).toBe(false);
  });

  it("rejects hashPrefix below minimum (4)", () => {
    const result = SenderTrustDisplayConfigSchema.safeParse({
      hashPrefix: 3,
    });
    expect(result.success).toBe(false);
  });

  it("rejects hashPrefix above maximum (16)", () => {
    const result = SenderTrustDisplayConfigSchema.safeParse({
      hashPrefix: 17,
    });
    expect(result.success).toBe(false);
  });
});
