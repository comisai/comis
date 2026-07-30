// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  buildAnnouncementMessage,
  buildAnnouncementRewriteInput,
  enforceAnnouncementTerminalOutcome,
  stripAnnouncementInstruction,
  type AnnouncementTerminalOutcome,
} from "./sub-agent-announcement-content.js";

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

  it("preserves an actionable config key across a localized failure rewrite", () => {
    const failureNotice = "⚠️ The background task failed.";
    const outcome = {
      status: "failed",
      failureNotice,
      requiredConfigKey: "tools.web.search",
    } as AnnouncementTerminalOutcome;

    const rewriteInput = buildAnnouncementRewriteInput(
      "The search provider exhausted its capacity.",
      outcome,
    );
    expect(rewriteInput).toContain("tools.web.search");
    expect(rewriteInput).toMatch(/splitting|narrowing/i);
    expect(rewriteInput).toMatch(/requested language/i);

    const disclosure = enforceAnnouncementTerminalOutcome(
      "The provider is out of capacity.",
      outcome,
    );
    expect(disclosure.corrected).toBe(true);
    expect(disclosure.text).toContain("tools.web.search");
    expect(disclosure.text).toContain(failureNotice);
  });
});
