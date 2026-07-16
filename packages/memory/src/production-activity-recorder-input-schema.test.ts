// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  DeliveryAttemptInputSchema,
  DeliveryOutcomeInputSchema,
  EvidenceExportInputSchema,
} from "./production-activity-recorder-input-schema.js";

describe("production activity recorder input schemas", () => {
  it("rejects unbounded identities and malformed causal record identifiers", () => {
    expect(DeliveryAttemptInputSchema.safeParse({
      occurredAtMs: 1,
      channelType: "x".repeat(129),
      channelId: "channel-a",
      text: "hello",
      options: {},
      origin: "agent",
      chunkIndex: 0,
      totalChunks: 1,
    }).success).toBe(false);
    expect(DeliveryOutcomeInputSchema.safeParse({
      attemptRecordId: "record:1",
      occurredAtMs: 2,
      durationMs: 1,
      outcomeClass: "success",
    }).success).toBe(false);
  });

  it("bounds evidence export pagination before reading encrypted records", () => {
    expect(EvidenceExportInputSchema.safeParse({ limit: 1_001 }).success).toBe(false);
    expect(EvidenceExportInputSchema.safeParse({ afterSequence: 0, limit: 1 }).success).toBe(true);
  });
});
