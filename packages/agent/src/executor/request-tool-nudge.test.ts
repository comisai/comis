import { describe, expect, it, vi } from "vitest";
import { registerToolMetadata } from "@comis/core";
import { allowProviderDispatch } from "./provider-dispatch.js";
import {
  countDistinctSuccessfulWebFetchUrls,
  runRequestToolNudge,
  type RunRequestToolNudgeDeps,
} from "./request-tool-nudge.js";
import * as requestToolNudgeModule from "./request-tool-nudge.js";

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
    currentSuccessfulNonWorkflowToolCount: () => 0,
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

registerToolMetadata("read", {
  isReadOnly: true,
});

registerToolMetadata("obs_query", {
  isReadOnly: true,
});

registerToolMetadata("discover_tools", {
  isReadOnly: true,
});

registerToolMetadata("web_search", {
  isReadOnly: true,
});

registerToolMetadata("web_fetch", {
  isReadOnly: true,
});

registerToolMetadata("test_guided_mutating_tool", {
  isReadOnly: false,
  mutationRequestPrefixes: ["connect"],
  mutationRecoveryGuidance:
    "Map every trusted operator connection field into one complete tool call.",
} as never);

function makePromptSkillNarrationScenario(options: {
  groundedAnswer: string;
  terminalNarration: string;
  nonWorkflowReceiptCount?: number;
}): {
  deps: RunRequestToolNudgeDeps;
  prompt: ReturnType<typeof vi.fn>;
} {
  let successfulWorkflowToolCount = 0;
  let distinctWebFetchUrlCount = 0;
  const nonWorkflowReceiptCount = options.nonWorkflowReceiptCount ?? 1;
  const prompt = vi.fn(async (_instruction?: string) => {
    if (prompt.mock.calls.length === 1) {
      successfulWorkflowToolCount = 1;
      distinctWebFetchUrlCount = 1;
    }
  });
  return {
    prompt,
    deps: makeDeps({
      capabilityClass: "frontier",
      requestText:
        "review the connected operational dataset and report useful findings",
      requestRelevantToolNames: ["test_read_only_tool", "read", "web_fetch"],
      requestRelevantPromptSkillNames: ["research-skill"],
      requestRelevantPromptSkillLocations: ["/skills/research-skill/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_fetch"],
      requestRelevantPromptSkillMinDistinctWebFetchUrls: 1,
      messages: [
        {
          role: "user",
          content:
            "review the connected operational dataset and report useful findings",
        },
        ...(nonWorkflowReceiptCount > 0
          ? [{
              role: "toolResult",
              toolName: "test_read_only_tool",
              isError: false,
              content: [{ type: "text", text: "current bounded dataset receipt" }],
            }]
          : []),
        { role: "assistant", content: options.groundedAnswer },
      ],
      session: { prompt },
      currentSuccessfulToolCount: () => successfulWorkflowToolCount,
      currentSuccessfulNonWorkflowToolCount: (toolNames) =>
        toolNames === undefined || toolNames.includes("test_read_only_tool")
          ? nonWorkflowReceiptCount
          : 0,
      currentDistinctSuccessfulWebFetchUrlCount: () => distinctWebFetchUrlCount,
      getVisibleAssistantText: () =>
        prompt.mock.calls.length === 0
          ? options.groundedAnswer
          : options.terminalNarration,
    }),
  };
}

describe("runRequestToolNudge", () => {
  it("counts only distinct successful web fetch URL receipts", () => {
    expect(countDistinctSuccessfulWebFetchUrls([
      { toolName: "web_fetch", success: true, citationUrlDigest: "url_a" },
      { toolName: "web_fetch", success: true, citationUrlDigest: "url_a" },
      { toolName: "web_fetch", success: true, citationUrlDigest: "url_b" },
      { toolName: "web_fetch", success: false, citationUrlDigest: "url_c" },
      { toolName: "web_search", success: true, citationUrlDigest: "url_d" },
    ])).toBe(2);
  });

  it("counts only distinct successful web search query receipts", () => {
    const candidate = (requestToolNudgeModule as Record<string, unknown>)
      .countDistinctSuccessfulWebSearchQueries;
    expect(candidate).toBeTypeOf("function");
    const countQueries = candidate as (records: readonly unknown[]) => number;

    expect(countQueries([
      { toolName: "web_search", success: true, webSearchQueryDigest: "query_a" },
      { toolName: "web_search", success: true, webSearchQueryDigest: "query_a" },
      { toolName: "web_search", success: true, webSearchQueryDigest: "query_b" },
      { toolName: "web_search", success: false, webSearchQueryDigest: "query_c" },
      { toolName: "web_fetch", success: true, webSearchQueryDigest: "query_d" },
    ])).toBe(2);
  });

  it("recovers a frontier-model runtime self-report that omitted obs_query", async () => {
    let successfulToolCount = 0;
    const prompt = vi.fn(async () => {
      successfulToolCount = 1;
    });
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText: "what did you even do this week",
      requestRelevantToolNames: ["obs_query"],
      session: { prompt },
      currentSuccessfulToolCount: () => successfulToolCount,
      getVisibleAssistantText: () =>
        "The current observability report shows 45 sessions.",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(
      expect.stringMatching(/runtime self-report.*obs_query/isu),
      expect.anything(),
    );
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      matchedToolNames: ["obs_query"],
      outcome: "recovered",
    });
  });

  it("recovers a durable-job restart report that omitted obs_query", async () => {
    let successfulToolCount = 0;
    const prompt = vi.fn(async () => {
      successfulToolCount = 1;
    });
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText: "resume the durable synthetic job after the restart",
      requestRelevantToolNames: ["obs_query"],
      session: { prompt },
      currentSuccessfulToolCount: () => successfulToolCount,
      getVisibleAssistantText: () =>
        "The current observability report shows that the durable run resumed.",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(
      expect.stringMatching(/runtime self-report.*obs_query/isu),
      expect.anything(),
    );
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      matchedToolNames: ["obs_query"],
      outcome: "recovered",
    });
  });

  it("recovers a claimed message receipt during an outage that omitted obs_query", async () => {
    let successfulToolCount = 0;
    const prompt = vi.fn(async () => {
      successfulToolCount = 1;
    });
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText: "did you receive the message injected while you were down?",
      requestRelevantToolNames: ["obs_query"],
      session: { prompt },
      currentSuccessfulToolCount: () => successfulToolCount,
      getVisibleAssistantText: () =>
        "The current observability result does not prove when the message was accepted.",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      matchedToolNames: ["obs_query"],
      outcome: "recovered",
    });
  });

  it("loads a matched prompt skill when a frontier answer skipped its procedure", async () => {
    let successfulToolCount = 0;
    const prompt = vi.fn(async () => {
      successfulToolCount = 1;
    });
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText:
        "i need to understand heat pumps properly, not just a paragraph",
      requestRelevantToolNames: ["read"],
      requestRelevantPromptSkillNames: ["deep-research"],
      requestRelevantPromptSkillLocations: [
        "/skills/deep-research/SKILL.md",
      ],
      messages: [
        {
          role: "user",
          content:
            "i need to understand heat pumps properly, not just a paragraph",
        },
        { role: "assistant", content: "Here is an unsupported overview." },
      ],
      session: { prompt },
      currentSuccessfulToolCount: () => successfulToolCount,
      getVisibleAssistantText: () => "Research completed from current receipts.",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(
      expect.stringMatching(/request-relevant prompt skill.*deep-research/isu),
      expect.anything(),
    );
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      matchedToolNames: ["read"],
      outcome: "recovered",
    });
  });

  it("continues a loaded prompt skill until distinct web fetch evidence is complete", async () => {
    let distinctWebFetchUrlCount = 2;
    let successfulToolCount = 3;
    const prompt = vi.fn(async () => {
      if (prompt.mock.calls.length === 1) {
        distinctWebFetchUrlCount = 3;
        successfulToolCount = 4;
      }
    });
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText: "understand this topic properly from multiple sources",
      requestRelevantToolNames: ["read", "web_search", "web_fetch"],
      requestRelevantPromptSkillNames: ["research-skill"],
      requestRelevantPromptSkillLocations: ["/skills/research-skill/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_search", "web_fetch"],
      requestRelevantPromptSkillMinDistinctWebFetchUrls: 3,
      session: { prompt },
      currentSuccessfulToolCount: () => successfulToolCount,
      currentDistinctSuccessfulWebFetchUrlCount: () => distinctWebFetchUrlCount,
      getVisibleAssistantText: () => "Research completed from three distinct sources.",
    } as Partial<RunRequestToolNudgeDeps>);

    const outcome = await runRequestToolNudge(deps);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]?.[0]).toMatch(
      /2 of 3 distinct successful web_fetch URLs/iu,
    );
    expect(prompt.mock.calls[1]?.[0]).toMatch(/narrate the completed/iu);
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      outcome: "recovered",
    });
  });

  it("continues a prompt skill until distinct web search evidence is complete", async () => {
    let distinctWebSearchQueryCount = 2;
    let successfulToolCount = 5;
    const prompt = vi.fn(async () => {
      if (prompt.mock.calls.length === 1) {
        distinctWebSearchQueryCount = 3;
        successfulToolCount = 6;
      }
    });
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText: "understand this topic properly from multiple angles",
      requestRelevantToolNames: ["read", "web_search", "web_fetch"],
      requestRelevantPromptSkillNames: ["research-skill"],
      requestRelevantPromptSkillLocations: ["/skills/research-skill/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_search", "web_fetch"],
      requestRelevantPromptSkillMinDistinctWebFetchUrls: 3,
      requestRelevantPromptSkillMinDistinctWebSearchQueries: 3,
      session: { prompt },
      currentSuccessfulToolCount: () => successfulToolCount,
      currentDistinctSuccessfulWebFetchUrlCount: () => 3,
      currentDistinctSuccessfulWebSearchQueryCount: () => distinctWebSearchQueryCount,
      getVisibleAssistantText: () => "Research completed from several angles.",
    } as Partial<RunRequestToolNudgeDeps>);

    const outcome = await runRequestToolNudge(deps);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]?.[0]).toMatch(
      /2 of 3 distinct successful web_search queries/iu,
    );
    expect(prompt.mock.calls[1]?.[0]).toMatch(/narrate the completed/iu);
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      outcome: "recovered",
    });
  });

  it("keeps continuing a progressing workflow until search evidence is complete", async () => {
    let distinctWebSearchQueryCount = 0;
    let successfulToolCount = 3;
    const prompt = vi.fn(async () => {
      if (distinctWebSearchQueryCount < 3) {
        distinctWebSearchQueryCount++;
        successfulToolCount++;
      }
    });
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText: "understand this topic properly from several angles",
      requestRelevantToolNames: ["read", "web_search", "web_fetch"],
      requestRelevantPromptSkillNames: ["research-skill"],
      requestRelevantPromptSkillLocations: ["/skills/research-skill/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_search", "web_fetch"],
      requestRelevantPromptSkillMinDistinctWebFetchUrls: 3,
      requestRelevantPromptSkillMinDistinctWebSearchQueries: 3,
      session: { prompt },
      currentSuccessfulToolCount: () => successfulToolCount,
      currentDistinctSuccessfulWebFetchUrlCount: () => 3,
      currentDistinctSuccessfulWebSearchQueryCount: () => distinctWebSearchQueryCount,
      getVisibleAssistantText: () => "Research completed from several angles.",
    } as Partial<RunRequestToolNudgeDeps>);

    const outcome = await runRequestToolNudge(deps);

    expect(prompt).toHaveBeenCalledTimes(4);
    expect(prompt.mock.calls[1]?.[0]).toMatch(/reuse web_search with new query arguments/iu);
    expect(prompt.mock.calls[2]?.[0]).toMatch(
      /2 of 3 distinct successful web_search queries/iu,
    );
    expect(prompt.mock.calls[3]?.[0]).toMatch(/narrate the completed/iu);
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      outcome: "recovered",
    });
  });

  it("loads the selected prompt skill when workflow receipts already exist", async () => {
    let successfulReadCount = 0;
    const successfulWorkflowCount = 3;
    const prompt = vi.fn(async () => {
      if (prompt.mock.calls.length === 1) successfulReadCount = 1;
    });
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText:
        "one source is down — where is each claim from, then give me the three essentials",
      requestRelevantToolNames: ["read", "web_search", "web_fetch"],
      requestRelevantPromptSkillNames: ["deep-research"],
      requestRelevantPromptSkillLocations: ["/skills/deep-research/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_search", "web_fetch"],
      requestRelevantPromptSkillMinDistinctWebFetchUrls: 3,
      session: { prompt },
      currentSuccessfulToolCount: (toolNames) => {
        const names = new Set(toolNames ?? []);
        return (names.has("read") ? successfulReadCount : 0)
          + (names.has("web_fetch") ? successfulWorkflowCount : 0);
      },
      currentDistinctSuccessfulWebFetchUrlCount: () => 3,
      getVisibleAssistantText: () =>
        "Each claim is traced to a current fetched source.",
    } as Partial<RunRequestToolNudgeDeps>);

    const outcome = await runRequestToolNudge(deps);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]?.[0]).toMatch(
      /request-relevant prompt skill.*deep-research/isu,
    );
    expect(prompt.mock.calls[1]?.[0]).toMatch(/narrate the completed/iu);
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      outcome: "recovered",
    });
  });

  it("narrates complete evidence when a retained skill is not read again", async () => {
    const prompt = vi.fn(async () => undefined);
    const externalNotice = `SECURITY NOTICE: external tool content\n${"x".repeat(900)}\n`;
    const fetchResult = (url: string, status: number, text: string) =>
      externalNotice + JSON.stringify({ url, status, text });
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText:
        "one source is down — where is each claim from, then give me the three essentials",
      requestRelevantToolNames: ["read", "web_search", "web_fetch"],
      requestRelevantPromptSkillNames: ["deep-research"],
      requestRelevantPromptSkillLocations: ["/skills/deep-research/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_search", "web_fetch"],
      requestRelevantPromptSkillMinDistinctWebFetchUrls: 3,
      messages: [
        { role: "user", content: "an older request" },
        {
          role: "toolResult",
          toolName: "web_fetch",
          content: [{ type: "text", text: "https://example.com/older-source" }],
        },
        {
          role: "user",
          content:
            "name the unavailable source, then give me the three essentials",
        },
        {
          role: "toolResult",
          toolName: "web_fetch",
          content: [{
            type: "text",
            text: fetchResult(
              "https://example.com/comis-unreachable-source-404",
              404,
              "not found",
            ),
          }],
        },
        {
          role: "toolResult",
          toolName: "web_fetch",
          content: [{
            type: "text",
            text: fetchResult("https://example.com/source-a", 200, "evidence a"),
          }],
        },
        {
          role: "toolResult",
          toolName: "web_fetch",
          content: [{
            type: "text",
            text: fetchResult("https://example.com/source-b", 200, "evidence b"),
          }],
        },
        {
          role: "toolResult",
          toolName: "web_fetch",
          content: [{
            type: "text",
            text: fetchResult("https://example.com/source-c", 200, "evidence c"),
          }],
        },
      ],
      session: { prompt },
      currentSuccessfulToolCount: (toolNames) =>
        toolNames?.includes("web_fetch") === true ? 3 : 0,
      currentDistinctSuccessfulWebFetchUrlCount: () => 3,
      getVisibleAssistantText: () =>
        "Each claim is traced to a current fetched source.",
    } as Partial<RunRequestToolNudgeDeps>);

    const outcome = await runRequestToolNudge(deps);

    expect(prompt).toHaveBeenCalledTimes(3);
    expect(prompt.mock.calls[2]?.[0]).toMatch(/narrate the completed/iu);
    expect(prompt.mock.calls[2]?.[0]).toMatch(
      /current-turn workflow receipts[\s\S]*earlier failure or unavailable/iu,
    );
    expect(prompt.mock.calls[2]?.[0]).toMatch(
      /copy every citation URL verbatim from[\s\S]*URL:[\s\S]*do not substitute/iu,
    );
    expect(prompt.mock.calls[2]?.[0]).toMatch(/Receipt 1: failed web_fetch/iu);
    expect(prompt.mock.calls[2]?.[0]).toContain(
      "https://example.com/comis-unreachable-source-404",
    );
    expect(prompt.mock.calls[2]?.[0]).toContain("https://example.com/source-a");
    expect(prompt.mock.calls[2]?.[0]).toContain("https://example.com/source-b");
    expect(prompt.mock.calls[2]?.[0]).toContain("https://example.com/source-c");
    expect(prompt.mock.calls[2]?.[0]).not.toContain(
      "https://example.com/older-source",
    );
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      outcome: "recovered",
    });
  });

  it("reconciles a receipt-grounded draft into one terminal narration", async () => {
    const groundedAnswer = [
      "The connected operational dataset covers every active unit.",
      "The strongest current finding is a concentrated idle-time cluster.",
    ].join("\n");
    const terminalCaveat =
      "Historical maintenance evidence remains unavailable.";
    const { deps, prompt } = makePromptSkillNarrationScenario({
      groundedAnswer,
      terminalNarration: terminalCaveat,
    });

    const outcome = await runRequestToolNudge(deps);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      fired: true,
      recovered: true,
      outcome: "recovered",
    });
    expect(outcome.response).toBe(terminalCaveat);
    expect(prompt.mock.calls[1]?.[0]).toContain(groundedAnswer);
    expect(prompt.mock.calls[1]?.[0]).toMatch(/reconcile.*replace conflicting claims/iu);
    const eventBus = deps.eventBus as unknown as {
      emitSafely: ReturnType<typeof vi.fn>;
    };
    expect(eventBus.emitSafely).toHaveBeenCalledWith(
      "execution:recovery_attempted",
      expect.objectContaining({ groundedResponsePreserved: false }),
    );
  });

  it("reports whether request-tool recovery preserved grounded evidence outside its route", async () => {
    const groundedAnswer = "The connected records support a current finding.";
    const { deps } = makePromptSkillNarrationScenario({
      groundedAnswer,
      terminalNarration: `${groundedAnswer}\nGeneral research supplies additional context.`,
    });
    deps.currentSuccessfulNonWorkflowToolCount = (toolNames) =>
      toolNames?.includes("test_read_only_tool") ? 1 : 0;

    await runRequestToolNudge(deps);

    const eventBus = deps.eventBus as unknown as {
      emitSafely: ReturnType<typeof vi.fn>;
    };
    expect(eventBus.emitSafely).toHaveBeenCalledWith(
      "execution:recovery_attempted",
      expect.objectContaining({
        reason: "request_tool_nudge",
        succeeded: true,
        groundedResponseBeforeRecovery: true,
        groundedResponsePreserved: true,
        successfulReceiptsOutsideRoute: 1,
      }),
    );
  });

  it("keeps terminal narration alone without a successful non-workflow receipt", async () => {
    const terminalNarration = "The current workflow evidence is bounded.";
    const { deps } = makePromptSkillNarrationScenario({
      groundedAnswer: "An ungrounded draft should not escape.",
      terminalNarration,
      nonWorkflowReceiptCount: 0,
    });

    const outcome = await runRequestToolNudge(deps);

    expect(outcome.response).toBe(terminalNarration);
  });

  it("does not ground an earlier draft on a discovery control receipt", async () => {
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText: "review the connected records with the required research procedure",
      requestRelevantToolNames: ["discover_tools", "read", "web_fetch"],
      requestRelevantPromptSkillNames: ["research-skill"],
      requestRelevantPromptSkillLocations: ["/skills/research-skill/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_fetch"],
      messages: [
        { role: "user", content: "review the connected records" },
        { role: "assistant", content: "An unsupported market claim." },
      ],
      currentSuccessfulNonWorkflowToolCount: (toolNames) =>
        toolNames?.includes("discover_tools") === true ? 1 : 0,
    });

    await runRequestToolNudge(deps);

    const eventBus = deps.eventBus as unknown as {
      emitSafely: ReturnType<typeof vi.fn>;
    };
    expect(eventBus.emitSafely).toHaveBeenCalledWith(
      "execution:recovery_attempted",
      expect.objectContaining({
        groundedResponseBeforeRecovery: false,
        successfulReceiptsOutsideRoute: 0,
      }),
    );
  });

  it("does not let a specialized receipt bypass a prompt-skill workflow", async () => {
    const deps = makeDeps({
      capabilityClass: "frontier",
      requestText:
        "review the current connected records and produce a deeply attributed report",
      requestRelevantToolNames: [
        "mcp__records--summary",
        "read",
        "web_search",
        "web_fetch",
      ],
      requestRelevantPromptSkillNames: ["deep-research"],
      requestRelevantPromptSkillLocations: ["/skills/deep-research/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_search", "web_fetch"],
      requestRelevantPromptSkillMinDistinctWebFetchUrls: 3,
      requestRelevantPromptSkillMinDistinctWebSearchQueries: 3,
      currentSuccessfulToolCount: () => 0,
      currentSuccessfulNonWorkflowToolCount: () => 1,
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).toHaveBeenCalled();
    expect(outcome.outcome).not.toBe("tool_already_succeeded");
  });

  it("keeps terminal narration alone when the receipt-grounded answer is empty", async () => {
    const terminalNarration = "The current workflow evidence is bounded.";
    const { deps } = makePromptSkillNarrationScenario({
      groundedAnswer: "",
      terminalNarration,
    });

    const outcome = await runRequestToolNudge(deps);

    expect(outcome.response).toBe(terminalNarration);
  });

  it("returns terminal narration without deterministic draft concatenation", async () => {
    const groundedAnswer = "The current receipt proves the bounded result.";
    const terminalNarration = `${groundedAnswer}\n\nOne evidence source remains unavailable.`;
    const { deps } = makePromptSkillNarrationScenario({
      groundedAnswer,
      terminalNarration,
    });

    const outcome = await runRequestToolNudge(deps);

    expect(outcome.response).toBe(terminalNarration);
    expect(outcome.response?.split(groundedAnswer)).toHaveLength(2);
  });

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
      groundedResponseBeforeRecovery: false,
      groundedResponsePreserved: false,
      successfulReceiptsOutsideRoute: 0,
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
      requestRelevantPromptSkillWorkflowToolNames: ["exec"],
      requestRelevantPromptSkillWorkflowContext:
        "u dont really know how to make flash cards properly",
      messages: [
        {
          role: "toolResult",
          toolName: "exec",
          content: [{ type: "text", text: "example/skills@flashcard-maker" }],
        },
      ],
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).toHaveBeenCalledTimes(2);
    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("/skills/find-skills/SKILL.md"),
      expect.anything(),
    );
    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringMatching(/required workflow tools.*exec/iu),
      expect.anything(),
    );
    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("u dont really know how to make flash cards properly"),
      expect.anything(),
    );
    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining(
        'Concrete workflow argument hint: "make flash cards properly"',
      ),
      expect.anything(),
    );
    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringMatching(/preserve canonical identifiers/iu),
      expect.anything(),
    );
    expect(deps.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("example/skills@flashcard-maker"),
      expect.anything(),
    );
    expect(outcome.outcome).toBe("still_no_tool_call");
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

  it("keeps the policy-filtered workflow surface available after loading a prompt skill", async () => {
    const activeTools = ["read", "exec", "test_read_only_tool"];
    const setActiveToolsByName = vi.fn();
    let successfulToolCount = 0;
    const prompt = vi.fn(async () => {
      expect(activeTools).toEqual(["read", "exec", "test_read_only_tool"]);
      successfulToolCount = 1;
    });
    const deps = makeDeps({
      requestText: "find something that does",
      requestRelevantToolNames: ["test_read_only_tool"],
      requestRelevantPromptSkillNames: ["find-skills"],
      requestRelevantPromptSkillLocations: ["/skills/find-skills/SKILL.md"],
      session: {
        prompt,
        getActiveToolNames: () => [...activeTools],
        setActiveToolsByName,
      },
      currentSuccessfulToolCount: () => successfulToolCount,
      getVisibleAssistantText: () => "Catalog result.",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(outcome.outcome).toBe("recovered");
    expect(setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("runs one bounded workflow continuation when skill loading alone is incomplete", async () => {
    let activeTools = ["read", "exec"];
    let successfulWorkflowCount = 0;
    const setActiveToolsByName = vi.fn((names: string[]) => {
      activeTools = [...names];
    });
    const prompt = vi.fn(async () => {
      if (prompt.mock.calls.length === 1) {
        expect(activeTools).toEqual(["read", "exec"]);
        return;
      }
      if (prompt.mock.calls.length === 2) {
        expect(activeTools).toEqual(["read", "exec"]);
        successfulWorkflowCount = 1;
        return;
      }
      expect(activeTools).toEqual([]);
    });
    const deps = makeDeps({
      requestText: "find something that does",
      requestRelevantToolNames: ["read"],
      requestRelevantPromptSkillNames: ["find-skills"],
      requestRelevantPromptSkillLocations: ["/skills/find-skills/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["exec"],
      requestRelevantPromptSkillWorkflowContext:
        "u dont really know how to make flash cards properly",
      session: {
        prompt,
        getActiveToolNames: () => [...activeTools],
        setActiveToolsByName,
      },
      currentSuccessfulToolCount: () => successfulWorkflowCount,
      getVisibleAssistantText: () => "Catalog result.",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(outcome.outcome).toBe("still_no_tool_call");
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(prompt.mock.calls[1]?.[0]).toContain(
      "u dont really know how to make flash cards properly",
    );
    expect(prompt.mock.calls[1]?.[0]).toMatch(/do not use exec to reread/iu);
    expect(prompt.mock.calls[1]?.[0]).not.toContain(
      "Complete the requested action with: read.",
    );
    expect(setActiveToolsByName).toHaveBeenNthCalledWith(1, [
      "read",
      "exec",
    ]);
    expect(setActiveToolsByName).toHaveBeenNthCalledWith(2, [
      "read",
      "exec",
    ]);
    expect(setActiveToolsByName).toHaveBeenNthCalledWith(3, []);
    expect(setActiveToolsByName).toHaveBeenNthCalledWith(4, ["read", "exec"]);
  });

  it("keeps the requested mutation tool in prompt skill workflow recovery", async () => {
    let activeTools = ["read", "exec", "test_mutating_tool"];
    let successfulReadCount = 0;
    let successfulMutationCount = 0;
    const setActiveToolsByName = vi.fn((names: string[]) => {
      activeTools = [...names];
    });
    const prompt = vi.fn(async () => {
      if (prompt.mock.calls.length === 1) {
        successfulReadCount = 1;
        return;
      }
      if (prompt.mock.calls.length === 2) {
        expect(activeTools).toEqual(["read", "exec", "test_mutating_tool"]);
        successfulMutationCount = 1;
        return;
      }
      expect(activeTools).toEqual([]);
    });
    const deps = makeDeps({
      requestText: "switch it",
      requestRelevantToolNames: ["test_mutating_tool", "exec"],
      requestRelevantPromptSkillNames: ["setup-helper"],
      requestRelevantPromptSkillLocations: ["/skills/setup-helper/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["exec"],
      session: {
        prompt,
        getActiveToolNames: () => [...activeTools],
        setActiveToolsByName,
      },
      currentSuccessfulMutationCount: () => successfulMutationCount,
      currentSuccessfulToolCount: (toolNames) =>
        toolNames?.includes("read") === true ? successfulReadCount : 0,
      getVisibleAssistantText: () => "Configured.",
    });

    const outcome = await runRequestToolNudge(deps);

    expect(outcome.outcome).toBe("recovered");
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(prompt.mock.calls[1]?.[0]).toContain("/skills/setup-helper/SKILL.md");
    expect(setActiveToolsByName).toHaveBeenNthCalledWith(1, [
      "read",
      "exec",
      "test_mutating_tool",
    ]);
    expect(setActiveToolsByName).toHaveBeenNthCalledWith(3, []);
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

  // A mutation request whose wording incidentally overlaps a routed prompt
  // skill inherits that skill's web-evidence floors. Those floors describe a
  // research answer, so a completed mutation could never satisfy them: the
  // nudge fired anyway, spent its continuations pushing web research, and the
  // unsatisfiable gate ended the turn with the answer discarded.
  it("does not run a routed prompt skill's web floors against a completed mutation", async () => {
    const deps = makeDeps({
      currentSuccessfulMutationCount: () => 1,
      requestRelevantToolNames: ["test_mutating_tool", "read", "web_search", "web_fetch"],
      requestRelevantPromptSkillNames: ["deep-research"],
      requestRelevantPromptSkillLocations: ["~/.comis/skills/deep-research/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_search", "web_fetch"],
      requestRelevantPromptSkillMinDistinctWebFetchUrls: 3,
      requestRelevantPromptSkillMinDistinctWebSearchQueries: 3,
      currentDistinctSuccessfulWebFetchUrlCount: () => 0,
      currentDistinctSuccessfulWebSearchQueryCount: () => 0,
      currentSuccessfulToolCount: () => 0,
    });

    const outcome = await runRequestToolNudge(deps);

    expect(deps.session.prompt).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe("tool_already_succeeded");
  });

  it("still recovers a mutation request that overlaps a routed prompt skill", async () => {
    const deps = makeDeps({
      requestRelevantToolNames: ["test_mutating_tool", "read", "web_search", "web_fetch"],
      requestRelevantPromptSkillNames: ["deep-research"],
      requestRelevantPromptSkillLocations: ["~/.comis/skills/deep-research/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_search", "web_fetch"],
      requestRelevantPromptSkillMinDistinctWebFetchUrls: 3,
      requestRelevantPromptSkillMinDistinctWebSearchQueries: 3,
      currentDistinctSuccessfulWebFetchUrlCount: () => 0,
      currentDistinctSuccessfulWebSearchQueryCount: () => 0,
    });

    const outcome = await runRequestToolNudge(deps);

    expect(outcome).toMatchObject({ fired: true, recovered: true });
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
