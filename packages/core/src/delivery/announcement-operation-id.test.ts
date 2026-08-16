// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createStableAnnouncementOperationId } from "./announcement-operation-id.js";

describe("completion announcement operation identity", () => {
  it("is stable for one operation and distinct across parts", () => {
    const first = createStableAnnouncementOperationId(
      "agent-a",
      "session-a",
      "run-a",
      "attachment:0",
    );

    expect(createStableAnnouncementOperationId(
      "agent-a",
      "session-a",
      "run-a",
      "attachment:0",
    )).toBe(first);
    expect(createStableAnnouncementOperationId(
      "agent-a",
      "session-a",
      "run-a",
      "attachment:1",
    )).not.toBe(first);
  });
});
