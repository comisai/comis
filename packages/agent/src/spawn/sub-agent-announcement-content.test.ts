// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { buildAnnouncementMessage, stripAnnouncementInstruction } from "./sub-agent-announcement-content.js";

describe("sub-agent announcement content", () => {
  it("builds a completion summary whose internal rewrite instruction can be removed", () => {
    const message = buildAnnouncementMessage({
      task: "create a report",
      status: "completed",
      response: "ready",
      runtimeMs: 1_000,
      tokensUsed: 10,
      cost: 0,
      sessionKey: "session-1",
      validation: [{ path: "/workspace/report.csv", exists: true, size: 10 }],
    });

    expect(message).toContain("Outputs: 1/1 verified");
    expect(stripAnnouncementInstruction(message)).not.toContain("Inform the user");
  });
});
