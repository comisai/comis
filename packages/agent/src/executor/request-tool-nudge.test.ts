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
  let successfulToolCount = 0;
  let visibleAssistantText = "same stale answer";
  const session = {
    prompt: vi.fn(async () => {
      successfulMutationCount = 1;
      successfulToolCount = 1;
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
    currentSuccessfulToolCount: () => successfulToolCount,
    currentDeferredWorkCount: () => 0,
    currentTerminalDenialCount: () => 0,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      audit: vi.fn(),
      child: vi.fn(),
    },
    eventBus: {
      emit: vi.fn(),
      emitSafely: vi.fn(() => ({ failures: [] })),
      on: vi.fn(),
      off: vi.fn(),
    },
    sessionKey: "default:agent:default:user_a:telegram:peer:user_a",
    clock: { now: () => 123 },
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

registerToolMetadata("test_guided_mutating_tool", {
  isReadOnly: false,
  mutationRequestPrefixes: ["connect"],
  mutationRecoveryGuidance:
    "Map every trusted operator connection field into one complete tool call.",
} as never);

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
    const eventBus = (deps as unknown as {
      eventBus: { emitSafely: ReturnType<typeof vi.fn> };
    }).eventBus;
    expect(eventBus.emitSafely).toHaveBeenCalledWith("execution:recovery_attempted", {
      agentId: "default",
      sessionKey: "default:agent:default:user_a:telegram:peer:user_a",
      reason: "request_tool_nudge",
      succeeded: true,
      timestamp: 123,
    });
  });

  it("runs for an explicit use request matched only to read-only tools", async () => {
    const deps = makeDeps({
      requestText: "use both and tell me whats different",
      requestRelevantToolNames: ["test_read_only_tool"],
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      matchedToolNames: ["test_read_only_tool"],
      outcome: "recovered",
    });
  });

  it("runs for an explicit find request matched to a read-only tool", async () => {
    const deps = makeDeps({
      requestText: "find something that does",
      requestRelevantToolNames: ["test_read_only_tool"],
      requestRelevantPromptSkillNames: ["find-skills"],
      requestRelevantPromptSkillLocations: ["/skills/find-skills/SKILL.md"],
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).toHaveBeenCalledTimes(1);
    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("/skills/find-skills/SKILL.md"),
      expect.anything(),
    );
    expect(outcome.outcome).toBe("recovered");
  });

  it("restricts explicit-use recovery to the matched tools", async () => {
    let activeTools = ["exec", "web_search", "test_read_only_tool"];
    let successfulToolCount = 0;
    const setActiveToolsByName = vi.fn((names: string[]) => {
      activeTools = [...names];
    });
    const prompt = vi.fn(async () => {
      expect(activeTools).toEqual(["test_read_only_tool"]);
      successfulToolCount = 1;
    });
    const deps = makeDeps({
      requestText: "use the connected service",
      requestRelevantToolNames: ["test_read_only_tool"],
      session: {
        prompt,
        getActiveToolNames: () => [...activeTools],
        setActiveToolsByName,
      },
      currentSuccessfulToolCount: () => successfulToolCount,
      getVisibleAssistantText: () => "Current result.",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(outcome.outcome).toBe("recovered");
    expect(setActiveToolsByName).toHaveBeenNthCalledWith(1, ["test_read_only_tool"]);
    expect(setActiveToolsByName).toHaveBeenNthCalledWith(2, [
      "exec",
      "web_search",
      "test_read_only_tool",
    ]);
  });

  it("does not run for an informational mention of a read-only tool", async () => {
    const deps = makeDeps({
      requestText: "describe the account summary capability",
      requestRelevantToolNames: ["test_read_only_tool"],
      messages: [
        { role: "user", content: "describe the account summary capability" },
        { role: "assistant", content: "It returns a bounded summary." },
      ],
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("not_action_request");
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

  it("does not retry a request after its matching tool denies permission", async () => {
    const deps = makeDeps({
      currentTerminalDenialCount: () => 1,
      messages: [
        { role: "user", content: "switch back to the model u had before" },
        { role: "assistant", content: "This change requires admin trust." },
      ],
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("tool_denied_terminally");
  });

  it("runs when a follow-up reply claims an external action attempt without a receipt", async () => {
    const fabricatedAttempt =
      "I attempted to access your account using the provided credential, but could not connect.";
    const deps = makeDeps({
      requestText: "here is the credential",
      messages: [
        { role: "assistant", content: "Please provide the credential." },
        { role: "user", content: "here is the credential" },
        { role: "assistant", content: fabricatedAttempt },
      ],
      getVisibleAssistantText: () => fabricatedAttempt,
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).toHaveBeenCalledTimes(1);
    expect(outcome.outcome).toBe("recovered");
  });

  it("anchors mutation recovery to exact trusted identifiers instead of inferred secret targets", async () => {
    const deps = makeDeps({
      requestText: "heres the credential",
      messages: [
        { role: "assistant", content: "Please provide the credential." },
        { role: "user", content: "heres the credential" },
        { role: "assistant", content: "Please provide the credential." },
      ],
    });

    await runRequestToolNudge(deps);

    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringMatching(/exact identifiers.*trusted operator policy/iu),
      expect.anything(),
    );
    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringMatching(/never infer.*(?:secret|credential).*(?:name|target).*(?:contents|channel)/iu),
      expect.anything(),
    );
  });

  it("includes capability-owned recovery guidance in a mutation continuation", async () => {
    const deps = makeDeps({
      requestText: "connect another one",
      requestRelevantToolNames: ["test_guided_mutating_tool"],
      messages: [
        { role: "assistant", content: "I need more details." },
        { role: "user", content: "connect another one" },
        { role: "assistant", content: "I need more details." },
      ],
    });

    await runRequestToolNudge(deps);

    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining(
        "Map every trusted operator connection field into one complete tool call.",
      ),
      expect.anything(),
    );
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
    expect(outcome.outcome).toBe("tool_already_succeeded");
  });

  it("does not duplicate a mutation after its background handoff was accepted", async () => {
    const deps = makeDeps({ currentDeferredWorkCount: () => 1 });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("tool_work_deferred");
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
      outcome: "still_no_tool_call",
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
