// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { shouldSkipHeartbeatOnlyDelivery } from "./cron-delivery-policy.js";
import type { HeartbeatResponseOutcome } from "./response-processor.js";

describe("shouldSkipHeartbeatOnlyDelivery", () => {
  it("returns true when policy enabled, trigger is cron, and outcome is heartbeat_ok", () => {
    const outcome: HeartbeatResponseOutcome = { kind: "heartbeat_ok", reason: "token", cleanedText: "" };
    expect(shouldSkipHeartbeatOnlyDelivery(outcome, "cron", true)).toBe(true);
  });

  it("returns false when policy is disabled", () => {
    const outcome: HeartbeatResponseOutcome = { kind: "heartbeat_ok", reason: "token", cleanedText: "" };
    expect(shouldSkipHeartbeatOnlyDelivery(outcome, "cron", false)).toBe(false);
  });

  it("returns false when trigger is not cron (interval)", () => {
    const outcome: HeartbeatResponseOutcome = { kind: "heartbeat_ok", reason: "token", cleanedText: "" };
    expect(shouldSkipHeartbeatOnlyDelivery(outcome, "interval", true)).toBe(false);
  });

  it("returns false when trigger is not cron (exec-event)", () => {
    const outcome: HeartbeatResponseOutcome = { kind: "heartbeat_ok", reason: "token", cleanedText: "" };
    expect(shouldSkipHeartbeatOnlyDelivery(outcome, "exec-event", true)).toBe(false);
  });

  it("returns false when outcome is deliver (even with cron trigger and policy enabled)", () => {
    const outcome: HeartbeatResponseOutcome = { kind: "deliver", text: "hello", hasMedia: false };
    expect(shouldSkipHeartbeatOnlyDelivery(outcome, "cron", true)).toBe(false);
  });

  it("returns true for heartbeat_ok with ack_under_threshold reason", () => {
    const outcome: HeartbeatResponseOutcome = { kind: "heartbeat_ok", reason: "ack_under_threshold", cleanedText: "ok" };
    expect(shouldSkipHeartbeatOnlyDelivery(outcome, "cron", true)).toBe(true);
  });

  it("returns true for heartbeat_ok with empty_reply reason", () => {
    const outcome: HeartbeatResponseOutcome = { kind: "heartbeat_ok", reason: "empty_reply", cleanedText: "" };
    expect(shouldSkipHeartbeatOnlyDelivery(outcome, "cron", true)).toBe(true);
  });
});
