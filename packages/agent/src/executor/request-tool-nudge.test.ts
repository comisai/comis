import { describe, expect, it, vi } from "vitest";
import { registerToolMetadata } from "@comis/core";
import { allowProviderDispatch } from "./provider-dispatch.js";
import {
  runRequestToolNudge,
  type RunRequestToolNudgeDeps,
} from "./request-tool-nudge.js";

function makeDeps(
  overrides: Partial<RunRequestToolNudgeDeps> = {},
): RunRequestToolNudgeDeps {
  let successfulMutationCount = 0;
  let visibleAssistantText = "same stale answer";
  const session = {
    prompt: vi.fn(async () => {
      successfulMutationCount = 1;
      visibleAssistantText = "Updated.";
    }),
  };

  return {
    session,
    requestText: "switch back to the model u had before",
    messages: [
      { role: "assistant", content: "same stale answer" },
      { role: "user", content: "switch back to the model u had before" },
      { role: "assistant", content: "same stale answer" },
    ],
    capabilityClass: "small",
    requestRelevantToolNames: ["test_mutating_tool"],
    currentSuccessfulMutationCount: () => successfulMutationCount,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      audit: vi.fn(),
      child: vi.fn(),
    },
    getVisibleAssistantText: () => visibleAssistantText,
    guardProviderDispatch: allowProviderDispatch,
    ...overrides,
  } as unknown as RunRequestToolNudgeDeps;
}

registerToolMetadata("test_mutating_tool", {
  isReadOnly: false,
  mutationRequestPrefixes: ["switch"],
});

registerToolMetadata("test_read_only_tool", {
  isReadOnly: true,
});

describe("runRequestToolNudge", () => {
  it("runs one continuation when nano repeats an earlier answer instead of calling a matched mutating tool", async () => {
    const deps = makeDeps();

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).toHaveBeenCalledTimes(1);
    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("test_mutating_tool"),
      { expandPromptTemplates: false, source: "extension" },
    );
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      response: "Updated.",
      matchedToolNames: ["test_mutating_tool"],
      outcome: "recovered",
    });
  });

  it("does not run for a request matched only to read-only tools", async () => {
    const deps = makeDeps({
      requestRelevantToolNames: ["test_read_only_tool"],
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      fired: false,
      recovered: false,
      outcome: "no_mutating_match",
    });
  });

  it("runs when a declared mutation request gets a fresh answer without a mutation", async () => {
    const deps = makeDeps({
      messages: [
        { role: "assistant", content: "an earlier answer" },
        { role: "user", content: "switch back to the model u had before" },
        { role: "assistant", content: "a new answer" },
      ],
      getVisibleAssistantText: () => "a new answer",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).toHaveBeenCalledTimes(1);
    expect(outcome.outcome).toBe("recovered");
  });

  it("does not run for an informational request with a fresh answer", async () => {
    const deps = makeDeps({
      requestText: "what model are you using now",
      messages: [
        { role: "assistant", content: "an earlier answer" },
        { role: "user", content: "what model are you using now" },
        { role: "assistant", content: "a new answer" },
      ],
      getVisibleAssistantText: () => "a new answer",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("not_action_request");
  });

  it("does not run outside the small model capability class", async () => {
    const deps = makeDeps({ capabilityClass: "mid" });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("not_small_class");
  });

  it("does not run after the current execution already completed a mutation", async () => {
    const deps = makeDeps({ currentSuccessfulMutationCount: () => 1 });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("mutation_already_succeeded");
  });

  it("reports a persistent stall when the continuation performs no successful mutation", async () => {
    const deps = makeDeps({
      session: { prompt: vi.fn(async () => undefined) },
      currentSuccessfulMutationCount: () => 0,
      getVisibleAssistantText: () => "same stale answer",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      fired: true,
      recovered: false,
      outcome: "still_no_mutation",
    });
  });

  it("logs an actionable warning when the continuation request is rejected", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      audit: vi.fn(),
      child: vi.fn(),
    };
    const deps = makeDeps({
      logger,
      session: {
        prompt: vi.fn(async () => {
          throw new Error("provider rejected continuation");
        }),
      },
    });

    const outcome = await runRequestToolNudge(deps);

    expect(outcome).toMatchObject({
      fired: true,
      recovered: false,
      outcome: "followup_error",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "internal",
        hint: expect.any(String),
      }),
      expect.any(String),
    );
  });
});
