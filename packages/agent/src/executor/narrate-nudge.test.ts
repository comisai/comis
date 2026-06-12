// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the narrate-without-emit continuation nudge (Issue 4,
 * small-model e2e 2026-06-12, UC-2 turn 2 + UC-5 vague run).
 *
 * RED-first: this module did not exist pre-patch — the live runs delivered
 * mid-task narration ("Found the image analyze tool. Let me use it now.") as
 * the final visible answer with the turn recorded as a clean success.
 */
import { describe, it, expect, vi } from "vitest";
import { isIntentPrelude, runNarrateNudge, type RunNarrateNudgeDeps } from "./narrate-nudge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
}

function assistantTextMsg(text: string): unknown {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function makeDeps(overrides: Partial<RunNarrateNudgeDeps> = {}): RunNarrateNudgeDeps {
  return {
    session: { followUp: vi.fn().mockResolvedValue(undefined) },
    messages: [assistantTextMsg("Now let me run the comparison script:")],
    capabilityClass: "small",
    logger: makeLogger() as unknown as RunNarrateNudgeDeps["logger"],
    agentId: "agent_a",
    getVisibleAssistantText: () => "The comparison shows NVDA outperformed by 12%.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Predicate — the near-zero-false-positive bar
// ---------------------------------------------------------------------------

describe("isIntentPrelude", () => {
  it("matches the live UC-2 shape — narration ending with a colon", () => {
    expect(isIntentPrelude("Now let me write the comparison script:")).toBe(true);
  });

  it("matches the live UC-5 shape — final sentence opening with 'Let me'", () => {
    expect(isIntentPrelude("Found the image analyze tool. Let me use it now.")).toBe(true);
  });

  it("matches trailing-ellipsis narration and \"I'll\" openers", () => {
    expect(isIntentPrelude("Searching for the file…")).toBe(true);
    expect(isIntentPrelude("I'll check the chart now.")).toBe(true);
    expect(isIntentPrelude("Okay, let's run the analysis.")).toBe(true);
  });

  it("does NOT match a real short answer", () => {
    expect(isIntentPrelude("The support level is $42.50 and resistance is $48.20.")).toBe(false);
    expect(isIntentPrelude("4")).toBe(false);
  });

  it("does NOT match the classic 'let me know' closing line of a real answer", () => {
    expect(isIntentPrelude("Done — the file is saved. Let me know if you need anything else.")).toBe(
      false,
    );
  });

  it("does NOT match a plain 'Ill …' sentence (the apostrophe is required)", () => {
    expect(isIntentPrelude("Ill effects were observed in the test group.")).toBe(false);
  });

  it("does NOT match a question to the user (a legitimate turn end)", () => {
    expect(isIntentPrelude("Should I proceed with the trade?")).toBe(false);
  });

  it("does NOT match long text even when it ends with a colon (answers can end on a list header)", () => {
    const long = "Here is the complete analysis. ".repeat(20) + "Key findings:";
    expect(isIntentPrelude(long)).toBe(false);
  });

  it("does NOT match empty/whitespace text (that is the post-batch handler's domain)", () => {
    expect(isIntentPrelude("")).toBe(false);
    expect(isIntentPrelude("   \n  ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runner — gates + the single bounded re-prompt
// ---------------------------------------------------------------------------

describe("runNarrateNudge", () => {
  it("fires exactly ONE followUp for a small-class narrate-without-emit turn and recovers the real answer", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      session: { followUp },
      getVisibleAssistantText: () => "Support is $42.50, resistance $48.20.",
    });
    const outcome = await runNarrateNudge(deps);
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(followUp.mock.calls[0]![0]).toContain("did not call a tool");
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      outcome: "recovered",
      response: "Support is $42.50, resistance $48.20.",
    });
  });

  it("nano class is gated IN", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const outcome = await runNarrateNudge(makeDeps({ capabilityClass: "nano", session: { followUp } }));
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(outcome.fired).toBe(true);
  });

  it("a FRONTIER model giving a short answer ending in ':' is NEVER nudged (the hard gate)", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const outcome = await runNarrateNudge(
      makeDeps({ capabilityClass: "frontier", session: { followUp } }),
    );
    expect(followUp).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ fired: false, recovered: false, outcome: "not_small_class" });
  });

  it("mid / undefined capability classes are not nudged either", async () => {
    for (const capabilityClass of ["mid", undefined]) {
      const followUp = vi.fn().mockResolvedValue(undefined);
      const outcome = await runNarrateNudge(makeDeps({ capabilityClass, session: { followUp } }));
      expect(followUp).not.toHaveBeenCalled();
      expect(outcome.outcome).toBe("not_small_class");
    }
  });

  it("a small-class turn WITH a tool call is not nudged (the model did emit)", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const outcome = await runNarrateNudge(
      makeDeps({
        session: { followUp },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Now let me check the chart:" },
              { type: "toolCall", id: "tu_1", name: "image_analyze", arguments: {} },
            ],
          },
        ],
      }),
    );
    expect(followUp).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("no_match");
  });

  it("a small-class turn ending on a real answer is not nudged (task satisfied)", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const outcome = await runNarrateNudge(
      makeDeps({
        session: { followUp },
        messages: [assistantTextMsg("The support level is $42.50 and resistance is $48.20.")],
      }),
    );
    expect(followUp).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("no_match");
  });

  it("still_narration: the re-prompt that produces another prelude is NOT retried (bounded to one)", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const outcome = await runNarrateNudge(
      makeDeps({
        session: { followUp },
        getVisibleAssistantText: () => "Okay, let me try the tool now:",
      }),
    );
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ fired: true, recovered: false, outcome: "still_narration" });
  });

  it("followUp rejection is contained: WARN with hint, outcome followup_error, never a throw", async () => {
    const logger = makeLogger();
    const outcome = await runNarrateNudge(
      makeDeps({
        session: { followUp: vi.fn().mockRejectedValue(new Error("ws closed")) },
        logger: logger as unknown as RunNarrateNudgeDeps["logger"],
      }),
    );
    expect(outcome).toMatchObject({ fired: true, recovered: false, outcome: "followup_error" });
    expect(logger.warn).toHaveBeenCalled();
    const warnPayload = logger.warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(warnPayload.hint).toBeDefined();
    expect(warnPayload.errorKind).toBe("internal");
  });
});
