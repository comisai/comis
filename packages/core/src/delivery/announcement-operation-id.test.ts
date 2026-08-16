// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  createStableAnnouncementChunkOperationId,
  createStableAnnouncementChunkPartId,
  createStableAnnouncementOperationId,
  isStableAnnouncementChunkPartId,
} from "./announcement-operation-id.js";

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

  it("derives the same child identity for every delivery boundary", () => {
    const partId = createStableAnnouncementChunkPartId("summary", 2);

    expect(partId).toBe("summary:chunk:2");
    expect(isStableAnnouncementChunkPartId(partId)).toBe(true);
    expect(createStableAnnouncementChunkOperationId(
      "agent-a",
      "session-a",
      "run-a",
      "summary",
      2,
    )).toBe(createStableAnnouncementOperationId(
      "agent-a",
      "session-a",
      "run-a",
      partId,
    ));
  });
});
