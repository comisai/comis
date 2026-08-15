// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  hasAcceptedDelegation,
  requestsPushDeliveredBackgroundCompletion,
} from "./accepted-delegation.js";

describe("hasAcceptedDelegation", () => {
  it("recognizes only successful session spawn receipts", () => {
    expect(hasAcceptedDelegation(undefined)).toBe(false);
    expect(hasAcceptedDelegation([
      { toolName: "sessions_spawn", success: false },
      { toolName: "web_search", success: true },
    ])).toBe(false);
    expect(hasAcceptedDelegation([
      { toolName: "sessions_spawn", success: true },
    ])).toBe(true);
  });
});

describe("requestsPushDeliveredBackgroundCompletion", () => {
  it("recognizes one durable child whose result should arrive without polling", () => {
    expect(requestsPushDeliveredBackgroundCompletion([
      "Start one durable background research task.",
      "Acknowledge once now, then deliver the completed report here without me polling.",
    ].join(" "))).toBe(true);
    expect(requestsPushDeliveredBackgroundCompletion(
      "Run a fleet review in the background. Acknowledge now and send it when complete.",
    )).toBe(true);
  });

  it("does not suppress parent synthesis for concurrent delegated branches", () => {
    expect(requestsPushDeliveredBackgroundCompletion(
      "Start three background subagents concurrently, then send one merged summary after all settle.",
    )).toBe(false);
    expect(requestsPushDeliveredBackgroundCompletion(
      "Spawn a child, then use the loaded skill to produce the final parent result.",
    )).toBe(false);
  });
});
