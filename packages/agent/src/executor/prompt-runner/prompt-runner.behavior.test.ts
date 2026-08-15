// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerToolMetadata } from "@comis/core";
import type { RunPromptParams } from "./prompt-runner-types.js";

const stageMocks = vi.hoisted(() => ({
  wrapEnvelope: vi.fn(),
  precheckBudget: vi.fn(),
  runWithModelRetry: vi.fn(),
  applyResponseLocaleEnforcement: vi.fn(),
}));

vi.mock("./envelope-wrapper.js", () => ({
  wrapEnvelope: stageMocks.wrapEnvelope,
}));
vi.mock("./budget-precheck.js", () => ({
  precheckBudget: stageMocks.precheckBudget,
}));
vi.mock("../model-retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-retry.js")>();
  return { ...actual, runWithModelRetry: stageMocks.runWithModelRetry };
});
vi.mock("./response-locale-enforcement.js", () => ({
  applyResponseLocaleEnforcement: stageMocks.applyResponseLocaleEnforcement,
}));

import { runPrompt } from "./prompt-runner.js";

registerToolMetadata("read", { isReadOnly: true });
registerToolMetadata("exec", { isReadOnly: false });
registerToolMetadata("sessions_spawn", {
  isReadOnly: false,
  mutationRequestPrefixes: ["spawn a child"],
});

function makeParams(input: {
  bridgeResult: ReturnType<RunPromptParams["bridge"]["getResult"]>;
  messages: unknown[];
  requestRelevantPromptSkillNames?: readonly string[];
}): { params: RunPromptParams; emit: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  const prompt = vi.fn(async () => undefined);
  const params = {
    msg: {
      text: "do the requested work",
      channelType: "telegram",
      channelId: "chat-a",
      metadata: {},
    },
    session: {
      messages: input.messages,
      prompt,
      agent: { state: { messages: [], model: undefined } },
    },
    config: { name: "agent-a", provider: "openai", model: "model-a" },
    sessionKey: {
      tenantId: "default",
      agentId: "agent-a",
      channelType: "telegram",
      channelId: "chat-a",
      userId: "user_a",
    },
    formattedKey: "default:agent-a:telegram:chat-a:user_a",
    agentId: "agent-a",
    result: { response: "" },
    executionOverrides: undefined,
    executionId: "trace-a",
    executionStartMs: 0,
    sepEnabled: false,
    executionPlanRef: { current: undefined },
    bridge: {
      getResult: vi.fn(() => input.bridgeResult),
      hasOutboundDelivery: vi.fn(() => false),
    },
    requestRelevantPromptSkillNames: input.requestRelevantPromptSkillNames,
    unavailablePromptSkills: [],
    systemPrompt: "system prompt",
    resolvedModel: { provider: "openai", id: "model-a" },
    effectiveTimeout: {
      promptTimeoutMs: 1_000,
      retryPromptTimeoutMs: 1_000,
      stallCeilingMultiplier: 1,
      source: "config",
      operationType: "interactive",
    },
    onResetTimer: vi.fn(),
    deps: {
      eventBus: { emit },
      logger: {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      modelRegistry: { find: vi.fn() },
      clock: { now: () => 1 },
      timers: {},
    },
  } as unknown as RunPromptParams;
  return { params, emit, prompt };
}

beforeEach(() => {
  stageMocks.wrapEnvelope.mockReset();
  stageMocks.wrapEnvelope.mockReturnValue({
    messageText: "assembled prompt",
    promptImages: undefined,
    budgetTracker: undefined,
    budgetCapped: false,
    requestedBudget: undefined,
    skipPrompt: false,
  });
  stageMocks.precheckBudget.mockReset();
  stageMocks.precheckBudget.mockReturnValue({ kind: "ok" });
  stageMocks.runWithModelRetry.mockReset();
  stageMocks.runWithModelRetry.mockResolvedValue({ succeeded: true });
  stageMocks.applyResponseLocaleEnforcement.mockReset();
  stageMocks.applyResponseLocaleEnforcement.mockImplementation(async (params) => {
    if (params.responseLocalePolicy?.enforceLocale === true) {
      params.result.response = "תוקן";
    }
  });
});

describe("runPrompt observable boundaries", () => {
  it("emits bounded selected prompt skills before provider execution", async () => {
    const skillNames = Array.from({ length: 18 }, (_, index) => `skill-${String(index)}`);
    const { params, emit } = makeParams({
      bridgeResult: {
        llmCalls: 1,
        stepsExecuted: 1,
        textEmitted: true,
        finishReason: "stop",
        toolExecResults: [{
          toolName: "sessions_spawn",
          success: true,
          durationMs: 5,
        }],
      },
      messages: [
        { role: "user", content: [{ type: "text", text: "do the work" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      requestRelevantPromptSkillNames: [
        "deep-research",
        "deep-research",
        ...skillNames,
      ],
    });

    await runPrompt(params);

    const submitted = emit.mock.calls.find((call) => call[0] === "prompt:submitted");
    expect(submitted?.[1]).toMatchObject({
      requestRelevantPromptSkillNames: [
        "deep-research",
        ...skillNames.slice(0, 15),
      ],
    });
    expect(stageMocks.runWithModelRetry).toHaveBeenCalledOnce();
    expect(params.result.response).toBe("done");
  });

  it("does not reenter the provider after accepting a delegation", async () => {
    const { params, prompt } = makeParams({
      bridgeResult: {
        llmCalls: 1,
        stepsExecuted: 1,
        textEmitted: false,
        finishReason: "stop",
        toolExecResults: [{
          toolName: "sessions_spawn",
          success: true,
          durationMs: 5,
        }],
      },
      messages: [
        { role: "user", content: [{ type: "text", text: "start the helper" }] },
        {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "spawn-1",
            name: "sessions_spawn",
            arguments: { task: "bounded task", async: true },
          }],
        },
        {
          role: "toolResult",
          toolCallId: "spawn-1",
          toolName: "sessions_spawn",
          content: [{ type: "text", text: "accepted" }],
          isError: false,
        },
        { role: "assistant", content: [] },
      ],
    });

    const outcome = await runPrompt(params);

    expect(outcome).toEqual({
      promptSucceeded: true,
      promptError: undefined,
      escalationAttempted: false,
    });
    expect(stageMocks.runWithModelRetry).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("continues a separate parent skill after accepting delegated work", async () => {
    const { params, prompt } = makeParams({
      bridgeResult: {
        llmCalls: 1,
        stepsExecuted: 1,
        textEmitted: true,
        finishReason: "stop",
        toolExecResults: [{
          toolName: "sessions_spawn",
          success: true,
          durationMs: 5,
        }],
      },
      messages: [
        { role: "user", content: [{ type: "text", text: "do both tasks" }] },
        { role: "assistant", content: [{ type: "text", text: "The child was launched." }] },
      ],
      requestRelevantPromptSkillNames: ["claude-code"],
    });
    params.msg.text = [
      "Spawn a child to inspect package.json.",
      "Then use Claude Code to produce the final parent result.",
    ].join(" ");
    params.requestRelevantToolNames = ["sessions_spawn", "read", "exec"];
    params.requestRelevantPromptSkillLocations = ["/skills/claude-code/SKILL.md"];
    params.requestRelevantPromptSkillWorkflowToolNames = ["exec"];

    await runPrompt(params);

    expect(prompt).toHaveBeenCalled();
    expect(params.result.requestToolNudge).toMatchObject({
      fired: true,
      matchedToolNames: ["read"],
    });
  });

  it("enforces response locale after accepting delegated work", async () => {
    const { params, prompt } = makeParams({
      bridgeResult: {
        llmCalls: 1,
        stepsExecuted: 1,
        textEmitted: true,
        finishReason: "stop",
        toolExecResults: [{
          toolName: "sessions_spawn",
          success: true,
          durationMs: 5,
        }],
      },
      messages: [
        { role: "user", content: [{ type: "text", text: "הפעל עוזר" }] },
        { role: "assistant", content: [{ type: "text", text: "The child was launched." }] },
      ],
    });
    params.responseLocalePolicy = {
      locale: "he",
      source: "request",
      enforceLocale: true,
    };

    await runPrompt(params);

    expect(prompt).not.toHaveBeenCalled();
    expect(stageMocks.applyResponseLocaleEnforcement).toHaveBeenCalledOnce();
    expect(params.result.response).toBe("תוקן");
  });
});
