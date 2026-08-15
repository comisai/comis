// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { pruneCapabilityServiceReplayEntries } from "./capability-service-replay.js";

describe("capability-service replay capacity", () => {
  it("evicts retryable entries while preserving pending mutations", () => {
    const replay = new Map([
      ["operation-pending", { canonical: "pending" }],
      ["operation-retryable-a", { canonical: "a", retryable: true }],
      ["operation-retryable-b", { canonical: "b", retryable: true }],
    ]);

    pruneCapabilityServiceReplayEntries(replay, 2);

    expect([...replay.keys()]).toEqual(["operation-pending", "operation-retryable-b"]);
  });
});
