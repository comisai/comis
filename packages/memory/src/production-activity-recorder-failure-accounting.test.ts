// SPDX-License-Identifier: Apache-2.0
import type {
  ActivityRecordingAttemptReceipt,
  ActivityRecordingReceipt,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";

import { createActivityRecorderFailureAccounting } from "./production-activity-recorder-failure-accounting.js";
import type {
  AppendRecordInput,
  InternalAppendFailure,
} from "./production-activity-recorder-support.js";

const attempt: ActivityRecordingAttemptReceipt = {
  recordId: "record:00000000000000000001",
  sequence: 1,
  recordHash: "a".repeat(64),
  attemptId: "550e8400-e29b-41d4-a716-446655440001",
  settlementCapability: "A".repeat(43),
  traceId: "550e8400-e29b-41d4-a716-446655440000",
  occurredAtMs: 100,
};

describe("production activity recorder failure accounting", () => {
  it("preserves settlement authority when a delivery outcome becomes a gap", () => {
    const appended: AppendRecordInput[] = [];
    const appendRecord = vi.fn((
      input: AppendRecordInput,
    ): Result<ActivityRecordingReceipt, InternalAppendFailure> => {
      appended.push(input);
      return appended.length === 1
        ? err({ reason: "database_busy", cause: new Error("first append was contended") })
        : ok({
            recordId: "record:00000000000000000002",
            sequence: 2,
            recordHash: "b".repeat(64),
          });
    });
    const accounting = createActivityRecorderFailureAccounting({
      appendRecord,
      currentGapCount: () => 1,
    });

    const result = accounting.appendOrAccount("delivery_platform_outcome", {
      kind: "delivery_platform_outcome",
      traceId: attempt.traceId,
      parentRecordId: attempt.recordId,
      attemptId: null,
      capabilityDigest: null,
      occurredAtMs: 110,
      payload: { outcomeClass: "success" },
      useGapReserve: false,
      settlement: attempt,
    });

    expect(result.ok).toBe(false);
    expect(appendRecord).toHaveBeenCalledTimes(2);
    expect(appended[1]).toEqual(expect.objectContaining({
      kind: "gap",
      traceId: attempt.traceId,
      parentRecordId: attempt.recordId,
      settlement: attempt,
    }));
  });
});
