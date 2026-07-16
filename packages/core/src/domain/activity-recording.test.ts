// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_RECORDING_EXACTNESS_BLOCKERS,
  ActivityRecordingExactnessBlockerSchema,
  ActivityRecordingGapReasonSchema,
  ActivityRecordingOutcomeClassSchema,
  parseActivityRecordingExactnessBlocker,
} from "./activity-recording.js";

describe("prospective activity recording domain", () => {
  it("keeps exactness blockers closed and names every currently omitted ingress family", () => {
    expect(ACTIVITY_RECORDING_EXACTNESS_BLOCKERS).toContain(
      "delivery_queue_drain_and_direct_adapter_sends",
    );
    expect(ACTIVITY_RECORDING_EXACTNESS_BLOCKERS).toContain(
      "attachment_media_and_rich_delivery",
    );
    expect(ACTIVITY_RECORDING_EXACTNESS_BLOCKERS).toEqual(expect.arrayContaining([
      "trusted_external_head_anchor_missing",
      "gateway_http_ingress",
      "gateway_json_rpc_ingress",
      "gateway_websocket_ingress",
      "webhook_ingress",
      "openai_compatible_api_ingress",
      "cli_local_device_and_internal_api_ingress",
    ]));
    expect(ActivityRecordingExactnessBlockerSchema.safeParse("anything_else").success).toBe(false);
  });

  it("uses closed outcome and gap classes for content-free health surfaces", () => {
    expect(ActivityRecordingOutcomeClassSchema.safeParse("platform_error").success).toBe(true);
    expect(ActivityRecordingOutcomeClassSchema.safeParse("raw SDK error text").success).toBe(false);
    expect(ActivityRecordingGapReasonSchema.safeParse("storage_failed").success).toBe(true);
    expect(ActivityRecordingGapReasonSchema.safeParse("database said secret=value").success).toBe(false);
  });

  it("returns Result when parsing an exactness blocker", () => {
    const valid = parseActivityRecordingExactnessBlocker("scheduler_and_proactive_activity");
    const invalid = parseActivityRecordingExactnessBlocker("unknown-family");

    expect(valid.ok && valid.value).toBe("scheduler_and_proactive_activity");
    expect(invalid.ok).toBe(false);
  });
});
