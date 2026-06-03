// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ApprovalCorrelationSchema,
  ApprovalChoiceSchema,
} from "./approval.js";

function validChoices() {
  return [
    { id: "approve", defaultLabel: "Approve", style: "primary" },
    { id: "deny", defaultLabel: "Deny", style: "danger" },
  ];
}

function validCorrelation(overrides: Record<string, unknown> = {}) {
  return {
    shortId: "aB3xY9zK2mNp",
    expiresAt: 1700000000000,
    choices: validChoices(),
    ...overrides,
  };
}

describe("ApprovalCorrelation", () => {
  describe("valid block", () => {
    it("accepts a 12-char base62 shortId with 2 choices and an expiry", () => {
      const result = ApprovalCorrelationSchema.safeParse(validCorrelation());
      expect(result.success).toBe(true);
    });
    it("accepts a 4-choice block (max boundary)", () => {
      const result = ApprovalCorrelationSchema.safeParse(
        validCorrelation({
          choices: [
            { id: "approve", defaultLabel: "Approve", style: "primary" },
            { id: "deny", defaultLabel: "Deny", style: "danger" },
            { id: "details", defaultLabel: "Details", style: "secondary" },
            { id: "approve", defaultLabel: "Approve again", style: "primary" },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe("shortId is 12-char base62", () => {
    it("rejects a shortId of length 11", () => {
      expect(ApprovalCorrelationSchema.safeParse(validCorrelation({ shortId: "aB3xY9zK2mN" })).success).toBe(false);
    });
    it("rejects a shortId of length 13", () => {
      expect(ApprovalCorrelationSchema.safeParse(validCorrelation({ shortId: "aB3xY9zK2mNpQ" })).success).toBe(false);
    });
    it("rejects a shortId containing a hyphen", () => {
      expect(ApprovalCorrelationSchema.safeParse(validCorrelation({ shortId: "aB3xY9zK2m-p" })).success).toBe(false);
    });
    it("rejects a shortId containing an underscore", () => {
      expect(ApprovalCorrelationSchema.safeParse(validCorrelation({ shortId: "aB3xY9zK2m_p" })).success).toBe(false);
    });
  });

  describe("choices count is 2..4", () => {
    it("rejects a correlation with only 1 choice", () => {
      const result = ApprovalCorrelationSchema.safeParse(
        validCorrelation({ choices: [{ id: "approve", defaultLabel: "Approve", style: "primary" }] }),
      );
      expect(result.success).toBe(false);
    });
    it("rejects a correlation with 5 choices", () => {
      const five = Array.from({ length: 5 }, () => ({ id: "approve", defaultLabel: "OK", style: "primary" }));
      expect(ApprovalCorrelationSchema.safeParse(validCorrelation({ choices: five })).success).toBe(false);
    });
  });

  describe("strict block — full requestId must NEVER appear", () => {
    it("rejects an unknown key such as requestId", () => {
      const result = ApprovalCorrelationSchema.safeParse(
        validCorrelation({ requestId: "550e8400-e29b-41d4-a716-446655440000" }),
      );
      expect(result.success).toBe(false);
    });
  });
});

describe("ApprovalChoice", () => {
  it("rejects an out-of-enum choice id", () => {
    expect(ApprovalChoiceSchema.safeParse({ id: "maybe", defaultLabel: "Maybe", style: "primary" }).success).toBe(false);
  });
  it("rejects an out-of-enum style", () => {
    expect(ApprovalChoiceSchema.safeParse({ id: "approve", defaultLabel: "Approve", style: "neon" }).success).toBe(false);
  });
  it("rejects a defaultLabel longer than 32 chars (too_big)", () => {
    const result = ApprovalChoiceSchema.safeParse({ id: "approve", defaultLabel: "x".repeat(33), style: "primary" });
    expect(result.success).toBe(false);
  });
});
