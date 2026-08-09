// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ManagedRunAttentionRecordSchema } from "./managed-run-attention.js";

function makeRecord(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    attentionId: "attention-a",
    managedRunId: "managed-run-a",
    serviceInstanceId: "service-a",
    tenantId: "tenant-a",
    agentId: "agent-a",
    principalId: "user-a",
    conversationRef: `cv_${"a".repeat(43)}`,
    externalKey: "approval-a",
    reportSequence: 1,
    attentionRef: "report-a",
    status: "open",
    createdAtMs: 10,
    updatedAtMs: 10,
    ...overrides,
  };
}

describe("managed-run attention authority records", () => {
  it("accepts only closed lifecycle states with response-reference invariants", () => {
    expect(ManagedRunAttentionRecordSchema.safeParse(makeRecord()).success).toBe(true);
    expect(ManagedRunAttentionRecordSchema.safeParse(makeRecord({
      status: "response_pending",
      responseRef: "response-a",
    })).success).toBe(true);
    expect(ManagedRunAttentionRecordSchema.safeParse(makeRecord({
      status: "delivered",
      responseRef: "response-a",
    })).success).toBe(true);
    expect(ManagedRunAttentionRecordSchema.safeParse(makeRecord({ status: "pending" })).success).toBe(false);
    expect(ManagedRunAttentionRecordSchema.safeParse(makeRecord({
      status: "response_pending",
    })).success).toBe(false);
    expect(ManagedRunAttentionRecordSchema.safeParse(makeRecord({
      responseRef: "response-a",
    })).success).toBe(false);
  });

  it("rejects unknown fields and time reversal", () => {
    expect(ManagedRunAttentionRecordSchema.safeParse(makeRecord({ unexpected: true })).success).toBe(false);
    expect(ManagedRunAttentionRecordSchema.safeParse(makeRecord({ updatedAtMs: 9 })).success).toBe(false);
    expect(ManagedRunAttentionRecordSchema.safeParse(makeRecord({ expiresAtMs: 9 })).success).toBe(false);
  });
});
