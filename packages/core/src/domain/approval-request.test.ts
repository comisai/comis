// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  ApprovalRequestSchema,
  SerializedApprovalRequestSchema,
  ApprovalResolutionSchema,
  SerializedApprovalCacheEntrySchema,
} from "./approval-request.js";

// ApprovalRequestSchema AND SerializedApprovalRequestSchema
// require a 12-char base62 `shortId` (the gate mints it). Malformed / wrong-length /
// non-base62 values must reject. ApprovalResolutionSchema carries no shortId.

const VALID_SHORT_ID = "Ab3Xy9Qz0Lmp"; // 12 chars, base62
const VALID_REQUEST_ID = "2a5cc745-9900-4165-864e-611542a1e753"; // valid RFC-4122 v4

function baseRequest(): Record<string, unknown> {
  return {
    requestId: VALID_REQUEST_ID,
    shortId: VALID_SHORT_ID,
    toolName: "agents_manage",
    action: "agents.delete",
    params: { agent_id: "bot-1" },
    agentId: "agent-1",
    sessionKey: "default:user1:discord",
    trustLevel: "user",
    callbackOwner: {
      tenantId: "default",
      userId: "user1",
      channelType: "discord",
      channelKey: "discord",
      threadId: "thread-1",
    },
    createdAt: 1_700_000_000_000,
    timeoutMs: 5000,
  };
}

// Build a fixture and remove a key (returns a fresh object without that key).
function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

describe("ApprovalRequestSchema shortId", () => {
  it("requires the full callback owner principal", () => {
    const result = ApprovalRequestSchema.safeParse(without(baseRequest(), "callbackOwner"));
    expect(result.success).toBe(false);
  });

  it("rejects a request that omits shortId (shortId is required)", () => {
    const result = ApprovalRequestSchema.safeParse(without(baseRequest(), "shortId"));
    expect(result.success).toBe(false);
  });

  it("accepts a request with a valid 12-char base62 shortId", () => {
    const result = ApprovalRequestSchema.safeParse(baseRequest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shortId).toBe(VALID_SHORT_ID);
    }
  });

  it("rejects an 11-char shortId (too short)", () => {
    const result = ApprovalRequestSchema.safeParse({ ...baseRequest(), shortId: "Ab3Xy9Qz0Lm" });
    expect(result.success).toBe(false);
  });

  it("rejects a 13-char shortId (too long)", () => {
    const result = ApprovalRequestSchema.safeParse({ ...baseRequest(), shortId: "Ab3Xy9Qz0Lmpq" });
    expect(result.success).toBe(false);
  });

  it("rejects a shortId containing a hyphen (not base62)", () => {
    const result = ApprovalRequestSchema.safeParse({ ...baseRequest(), shortId: "Ab3Xy-Qz0Lm" });
    expect(result.success).toBe(false);
  });

  it("rejects a shortId containing an underscore (not base62)", () => {
    const result = ApprovalRequestSchema.safeParse({ ...baseRequest(), shortId: "Ab3Xy_Qz0Lm" });
    expect(result.success).toBe(false);
  });

  it("rejects a shortId containing a plus sign (not base62)", () => {
    const result = ApprovalRequestSchema.safeParse({ ...baseRequest(), shortId: "Ab3Xy+Qz0Lm" });
    expect(result.success).toBe(false);
  });
});

describe("SerializedApprovalRequestSchema shortId", () => {
  it("requires the full callback owner principal after restart", () => {
    const result = SerializedApprovalRequestSchema.safeParse(without(baseRequest(), "callbackOwner"));
    expect(result.success).toBe(false);
  });

  it("rejects a serialized record that omits shortId (shortId is required)", () => {
    const result = SerializedApprovalRequestSchema.safeParse(without(baseRequest(), "shortId"));
    expect(result.success).toBe(false);
  });

  it("accepts a serialized record with a valid 12-char base62 shortId", () => {
    const result = SerializedApprovalRequestSchema.safeParse(baseRequest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shortId).toBe(VALID_SHORT_ID);
    }
  });

  it("rejects a serialized 11-char shortId (too short)", () => {
    const result = SerializedApprovalRequestSchema.safeParse({ ...baseRequest(), shortId: "Ab3Xy9Qz0Lm" });
    expect(result.success).toBe(false);
  });

  it("rejects a serialized 13-char shortId (too long)", () => {
    const result = SerializedApprovalRequestSchema.safeParse({ ...baseRequest(), shortId: "Ab3Xy9Qz0Lmpq" });
    expect(result.success).toBe(false);
  });

  it("rejects a serialized shortId containing a slash (not base62)", () => {
    const result = SerializedApprovalRequestSchema.safeParse({ ...baseRequest(), shortId: "Ab3Xy/Qz0Lm" });
    expect(result.success).toBe(false);
  });
});

describe("ApprovalResolutionSchema carries no shortId field", () => {
  it("still validates a resolution object that has no shortId field", () => {
    const result = ApprovalResolutionSchema.safeParse({
      requestId: VALID_REQUEST_ID,
      approved: true,
      approvedBy: "operator",
      resolvedAt: 1_700_000_000_000,
    });
    expect(result.success).toBe(true);
  });
});

describe("SerializedApprovalCacheEntrySchema", () => {
  it("rejects a denial record because a restored cache entry can only authorize approvals", () => {
    const result = SerializedApprovalCacheEntrySchema.safeParse({
      cacheKey: "h1:21:default:user1:discord:b135ece7b7e511c7657b3d770110a8b94a030ba8a3cdf3ac2d1e691d4b576b20",
      resolution: {
        requestId: VALID_REQUEST_ID,
        approved: false,
        approvedBy: "operator",
        resolvedAt: 1_700_000_000_000,
      },
      expiresAt: 1_700_000_015_000,
    });

    expect(result.success).toBe(false);
  });
});
