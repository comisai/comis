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

  it("does not duplicate a multipart failure disclosure whose required anchors survived rewriting", () => {
    const genericNotice =
      "⚠️ This background task failed, so its result may be incomplete.";
    const governorNotice =
      "I stopped at the governor limit of 6 consecutive no-progress tool results. "
      + "This includes successful calls when the tool and its result stay unchanged, "
      + "as well as failed or blocked calls. Try a different approach or change the "
      + "condition before retrying.";
    const candidate =
      `The fixture stayed unchanged.\n\n${genericNotice}\n\n`
      + "I stopped at the governor limit of 6 consecutive no-progress tool results. "
      + "Change the condition or approach before retrying.";

    const disclosure = enforceAnnouncementTerminalOutcome(candidate, {
      status: "failed",
      failureNotice: `${genericNotice}\n\n${governorNotice}`,
    });

    expect(disclosure.corrected).toBe(true);
    expect(disclosure.text).toContain(governorNotice);
    expect(disclosure.text?.match(/background task failed/gu)).toHaveLength(1);
    expect(disclosure.text?.match(/governor limit of 6/gu)).toHaveLength(1);
  });
});

describe("buildAnnouncementMessage — a real response is never rendered as an error", () => {
  // Second half of the same live incident. Even once classification is right,
  // the failed branch put the child's own response into the `error` slot, so
  // the reader saw `Result: Error: <the actual answer>`. A deliverable
  // relabelled as an error invites the user to discard good work.
  it("shows the response as the result when a degraded run still produced one", () => {
    const message = buildAnnouncementMessage({
      task: "find listings",
      status: "failed",
      response: "Found 3 active listings; yad2 was behind a bot challenge.",
      runtimeMs: 1000,
      tokensUsed: 10,
      cost: 0.1,
      finishReason: "max_steps",
      sessionKey: "s1",
    });

    expect(message).toContain("Found 3 active listings");
    expect(message).not.toContain("Error: Found 3 active listings");
    expect(message).not.toContain("Result: Error:");
  });

  it("still reports an error when the run produced no response at all", () => {
    const message = buildAnnouncementMessage({
      task: "find listings",
      status: "failed",
      error: "provider refused the request",
      runtimeMs: 1000,
      tokensUsed: 10,
      cost: 0.1,
      finishReason: "error",
      sessionKey: "s1",
    });

    expect(message).toContain("Error: provider refused the request");
  });
});
