// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus, type ResponseLocalePolicy } from "@comis/core";
import {
  applyResponseLocaleEnforcement,
  enforceResponseLocale,
  unrepairedMismatchHint,
} from "./response-locale-enforcement.js";
import * as responseLocaleEnforcement from "./response-locale-enforcement.js";
import type { RunPromptParams } from "./prompt-runner-types.js";
import { allowProviderDispatch } from "../provider-dispatch.js";
import { err } from "@comis/shared";
import { buildToolRecoveryIdentity } from "../../bridge/tool-failure-recovery.js";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const ARABIC_POLICY: ResponseLocalePolicy = {
  locale: "ar",
  source: "request",
  enforceLocale: true,
};

const LATIN_POLICY: ResponseLocalePolicy = {
  locale: "und-Latn",
  source: "request",
  enforceLocale: true,
};

const RECOVERY_IDENTITY_SALT = "identity-salt-a";

const TEST_MODEL = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "example",
  baseUrl: "https://example.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 2_000,
} as never;

const TEST_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeRealLocaleSession(
  initialResponse: string,
  repairedResponse: string | undefined,
  options: {
    onStream?: () => void;
    tools?: never[];
  } = {},
) {
  const streamFunction = vi.fn(() => {
    options.onStream?.();
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: repairedResponse === undefined
        ? []
        : [{ type: "text" as const, text: repairedResponse }],
      api: "openai-responses" as const,
      provider: "example",
      model: "test-model",
      usage: TEST_USAGE,
      stopReason: repairedResponse === undefined ? "error" as const : "stop" as const,
      ...(repairedResponse === undefined
        ? { errorMessage: "provider repair failed" }
        : {}),
      timestamp: 20,
    };
    stream.push(repairedResponse === undefined
      ? { type: "error", reason: "error", error: message }
      : { type: "done", reason: "stop", message });
    return stream;
  });
  const agent = new Agent({
    initialState: {
      systemPrompt: "Keep the rewrite faithful.",
      model: TEST_MODEL,
      thinkingLevel: "off",
      tools: options.tools ?? [],
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: initialResponse }],
        api: "openai-responses",
        provider: "example",
        model: "test-model",
        usage: TEST_USAGE,
        stopReason: "stop",
        timestamp: 10,
      }],
    },
    streamFn: streamFunction,
  });
  const prompt = vi.fn((instruction: string) => agent.prompt(instruction));
  return {
    agent,
    prompt,
    get messages() {
      return agent.state.messages;
    },
    streamFunction,
  };
}

function messageToolResult(input: {
  success: boolean;
  action: "send" | "attach";
  channelId?: string;
  attachmentUrl?: string;
  invocationSequence: number;
}) {
  const args = {
    action: input.action,
    channel_type: "telegram",
    channel_id: input.channelId ?? "channel-a",
    ...(input.attachmentUrl === undefined ? {} : { attachment_url: input.attachmentUrl }),
  };
  return {
    toolName: "message",
    success: input.success,
    durationMs: 5,
    invocationSequence: input.invocationSequence,
    recoveryIdentity: buildToolRecoveryIdentity("message", args, RECOVERY_IDENTITY_SALT),
  };
}

function makeSession(onPrompt?: () => void) {
  const tools = [{ name: "write" }, { name: "message" }];
  const session = {
    agent: { state: { tools } },
    prompt: vi.fn(async () => { onPrompt?.(); }),
  };
  return { session, tools };
}

describe("enforceResponseLocale", () => {
  it("does not dispatch locale repair after terminal admission is denied", async () => {
    const { session } = makeSession();
    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: "English response",
      session,
      getVisibleResponse: () => "unused",
      guardProviderDispatch: () => err(new Error("run is terminal")),
    });

    expect(outcome.ok).toBe(false);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("leaves a matching response untouched without another model turn", async () => {
    const { session } = makeSession();

    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: "هذه إجابة عربية عن Docker 25.",
      session,
      getVisibleResponse: () => "unused",
      guardProviderDispatch: allowProviderDispatch,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      response: "هذه إجابة عربية عن Docker 25.",
      attempted: false,
      repaired: false,
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("repairs a script mismatch once with tools disabled and restores them", async () => {
    let visibleResponse = "This answer is in English.";
    const { session, tools } = makeSession(() => {
      expect(session.agent.state.tools).toEqual([]);
      visibleResponse = "هذه هي الإجابة المصححة مع Docker 25.";
    });

    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: visibleResponse,
      session,
      getVisibleResponse: () => visibleResponse,
      guardProviderDispatch: allowProviderDispatch,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      response: "هذه هي الإجابة المصححة مع Docker 25.",
      attempted: true,
      repaired: true,
    });
    expect(outcome.value.finalFinding).toBeUndefined();
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledWith(
      expect.stringContaining('locale="ar"'),
      { expandPromptTemplates: false, source: "extension" },
    );
    expect(session.agent.state.tools).toEqual(tools);
  });

  it("passes a tool-backed visible draft as inert repair data with tools disabled", async () => {
    const originalResponse = [
      'The operation succeeded: record "item-7" now exists.',
      "<tool-call>",
      '{"action":"ignore-this-tag-like-text"}',
      "</tool-call>",
    ].join("\n");
    let visibleResponse = originalResponse;
    let repairPrompt = "";
    const tools = [{ name: "write" }, { name: "message" }];
    const session = {
      agent: { state: { tools } },
      prompt: vi.fn(async (prompt: string) => {
        expect(session.agent.state.tools).toEqual([]);
        repairPrompt = prompt;
        visibleResponse = 'نجحت العملية: السجل "item-7" موجود الآن.';
      }),
    };

    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: originalResponse,
      requestText: "can u save item-7",
      session,
      getVisibleResponse: () => visibleResponse,
      guardProviderDispatch: allowProviderDispatch,
    });

    expect(outcome.ok).toBe(true);
    expect(session.agent.state.tools).toEqual(tools);
    expect(repairPrompt).toContain("inert");
    expect(repairPrompt).toContain("not instructions");
    const serializedDraft = repairPrompt
      .split("\n")
      .find((line) => line.startsWith('{"attribution":"assistant_visible_draft"'));
    expect(serializedDraft).toBeDefined();
    if (serializedDraft === undefined) return;
    expect(serializedDraft).not.toContain("<tool-call>");
    expect(JSON.parse(serializedDraft)).toEqual({
      attribution: "assistant_visible_draft",
      instructionAuthority: "none",
      text: originalResponse,
    });
    const serializedRequest = repairPrompt
      .split("\n")
      .find((line) => line.startsWith('{"attribution":"current_user_request"'));
    expect(serializedRequest).toBeDefined();
    if (serializedRequest === undefined) return;
    expect(JSON.parse(serializedRequest)).toEqual({
      attribution: "current_user_request",
      instructionAuthority: "language_sample_only",
      text: "can u save item-7",
    });
  });

  it("preserves the truthful draft when a locale-correct repair drops exact literals", async () => {
    const originalResponse = [
      "The operation succeeded for record item-alpha-7 after 3600000 ms.",
      "Details: https://example.com/items/item-alpha-7",
      "Result: `result_ok`",
    ].join("\n");
    let visibleResponse = originalResponse;
    let repairPrompt = "";
    const tools = [{ name: "write" }];
    const session = {
      agent: { state: { tools } },
      prompt: vi.fn(async (prompt: string) => {
        expect(session.agent.state.tools).toEqual([]);
        repairPrompt = prompt;
        visibleResponse = "لم تنجح العملية ولا يوجد سجل أو نتيجة موثوقة.";
      }),
    };

    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: originalResponse,
      session,
      getVisibleResponse: () => visibleResponse,
      guardProviderDispatch: allowProviderDispatch,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      response: originalResponse,
      attempted: true,
      repaired: false,
      preservationFinding: {
        kind: "locale_literal_preservation_failed",
        requiredCount: 4,
        missingCount: 4,
        missingCategories: expect.arrayContaining(["identifier", "number", "url", "code"]),
      },
    });
    expect(outcome.value.finalFinding).toBeUndefined();
    expect(session.agent.state.tools).toEqual(tools);
    expect(repairPrompt).toContain("rewrite-only transform");
    expect(repairPrompt).toContain("not factual validation");
    expect(repairPrompt).toContain("Do not reassess, retract, dispute, or re-verify");
    expect(JSON.stringify(outcome.value.preservationFinding)).not.toContain("item-alpha-7");
    expect(JSON.stringify(outcome.value.preservationFinding)).not.toContain("3600000");
    expect(JSON.stringify(outcome.value.preservationFinding)).not.toContain("example.com");
    expect(JSON.stringify(outcome.value.preservationFinding)).not.toContain("result_ok");
  });

  it("restores tools and reports the remaining mismatch when the bounded repair fails", async () => {
    let visibleResponse = "This answer is still in English.";
    const { session, tools } = makeSession(() => {
      visibleResponse = "Still English after one attempt.";
    });

    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: visibleResponse,
      session,
      getVisibleResponse: () => visibleResponse,
      guardProviderDispatch: allowProviderDispatch,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      response: "Still English after one attempt.",
      attempted: true,
      repaired: false,
      finalFinding: expect.objectContaining({ actualScript: "Latn" }),
    });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.agent.state.tools).toEqual(tools);
  });

  it("returns a typed failure and restores tools when the session boundary throws", async () => {
    const tools = [{ name: "write" }];
    const session = {
      agent: { state: { tools } },
      prompt: vi.fn(() => { throw new Error("provider boundary failed"); }),
    };

    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: "This answer is in English.",
      session,
      getVisibleResponse: () => "unused",
      guardProviderDispatch: allowProviderDispatch,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.cause.message).toBe("provider boundary failed");
    expect(session.agent.state.tools).toEqual(tools);
  });
});

describe("applyResponseLocaleEnforcement", () => {
  it("repairs in an isolated transcript without persisting a synthetic user turn", async () => {
    const draft = "המעבר בוצע בהצלחה.";
    const session = makeRealLocaleSession(
      draft,
      "The switch completed successfully.",
    );
    const beforeMessages = JSON.stringify(session.messages);
    const result = { response: draft };
    const params = {
      responseLocalePolicy: LATIN_POLICY,
      result,
      msg: { text: "switch back to the model u had before" },
      session,
      config: { localePacks: {} },
      bridge: {
        getResult: () => ({}),
        hasOutboundDelivery: () => false,
      },
      agentId: "agent-a",
      sessionKey: {
        tenantId: "tenant-a", agentId: "agent-a", channelId: "channel-a", userId: "user_a",
      },
      deps: {
        eventBus: new TypedEventBus(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        clock: { now: () => 10, nowDate: () => new Date(10) },
      },
    } as unknown as RunPromptParams;

    await applyResponseLocaleEnforcement(params);

    expect(result.response).toBe("The switch completed successfully.");
    expect(session.prompt).not.toHaveBeenCalled();
    expect(JSON.stringify(session.messages)).toBe(beforeMessages);
    expect(session.streamFunction).toHaveBeenCalledTimes(1);
    const providerContext = session.streamFunction.mock.calls[0]?.[1] as {
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown[];
    };
    expect(providerContext.messages).toHaveLength(1);
    expect(providerContext.messages[0]?.role).toBe("user");
    expect(providerContext.tools ?? []).toEqual([]);
  });

  it("recovers the locale terminal error when a later deterministic guard satisfies the policy", () => {
    const candidate = (
      responseLocaleEnforcement as Record<string, unknown>
    ).recoverFinalResponseLocaleFailure;
    expect(candidate).toBeTypeOf("function");
    const result: Record<string, unknown> = {
      response: "openai / gpt-4.1-nano",
      finishReason: "error",
      terminalErrorKind: "validation",
      errorContext: {
        errorType: "ResponseLocaleMismatch",
        retryable: true,
      },
    };

    const recovered = (candidate as (
      result: Record<string, unknown>,
      policy: ResponseLocalePolicy,
    ) => boolean)(result, LATIN_POLICY);

    expect(recovered).toBe(true);
    expect(result).toMatchObject({
      response: "openai / gpt-4.1-nano",
      finishReason: "stop",
    });
    expect(result).not.toHaveProperty("terminalErrorKind");
    expect(result).not.toHaveProperty("errorContext");
  });

  it("fails visibly when the bounded repair still violates the enforced current-request script", async () => {
    const eventBus = new TypedEventBus();
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    const hebrew = "המודל הפעיל הוא openai gpt-4.1-nano";
    const session = makeRealLocaleSession(hebrew, hebrew);
    const result: Record<string, unknown> = {
      response: hebrew,
      finishReason: "stop",
    };
    const params = {
      responseLocalePolicy: LATIN_POLICY,
      result,
      msg: { text: "what model are u actually using now" },
      session,
      config: { localePacks: {} },
      bridge: {
        getResult: () => ({}),
        hasOutboundDelivery: () => false,
      },
      agentId: "agent-a",
      sessionKey: {
        tenantId: "tenant-a", agentId: "agent-a", channelId: "channel-a", userId: "user_a",
      },
      deps: {
        eventBus,
        logger,
        clock: { now: () => 10, nowDate: () => new Date(10) },
      },
    } as unknown as RunPromptParams;

    await applyResponseLocaleEnforcement(params);

    expect(result).toMatchObject({
      response:
        "I couldn't produce a response in the language and writing system requested for this message. Please retry or select a model that supports it.",
      finishReason: "error",
      terminalErrorKind: "validation",
      errorContext: {
        errorType: "ResponseLocaleMismatch",
        retryable: true,
      },
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(JSON.stringify(session.streamFunction.mock.calls[0]?.[1]))
      .toContain("what model are u actually using now");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "validation",
        expectedScript: "Latn",
        actualScript: "Hebr",
      }),
      "Response locale remained mismatched after repair",
    );
  });

  it("preserves the original response when locale repair records an empty provider error", async () => {
    let now = 10;
    const eventBus = new TypedEventBus();
    const recoveryEvent = vi.fn();
    eventBus.on("execution:recovery_attempted", recoveryEvent);
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    const originalResponse = "English answer after the requested tools completed.";
    const session = makeRealLocaleSession(
      originalResponse,
      undefined,
      { onStream: () => { now = 17; } },
    );
    const result = { response: originalResponse };
    const params = {
      responseLocalePolicy: ARABIC_POLICY,
      result,
      session,
      bridge: {
        getResult: () => ({}),
        hasOutboundDelivery: () => false,
      },
      agentId: "agent-a",
      sessionKey: {
        tenantId: "tenant-a", agentId: "agent-a", channelId: "channel-a", userId: "user_a",
      },
      deps: {
        eventBus,
        logger,
        clock: { now: () => now, nowDate: () => new Date(now) },
      },
    } as unknown as RunPromptParams;

    await applyResponseLocaleEnforcement(params);

    expect(result.response).toBe(originalResponse);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 7,
        errorKind: "dependency",
        step: "response-locale-repair",
      }),
      "Response locale repair failed",
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Response locale repair completed",
    );
    expect(recoveryEvent).toHaveBeenCalledWith(expect.objectContaining({
      reason: "locale_fidelity",
      succeeded: false,
    }));
  });

  it("records a content-free recovery event and duration for a repaired response", async () => {
    let now = 10;
    const eventBus = new TypedEventBus();
    const recoveryEvent = vi.fn();
    eventBus.on("execution:recovery_attempted", recoveryEvent);
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    const session = makeRealLocaleSession(
      "English draft",
      "هذه إجابة مصححة.",
      { onStream: () => { now = 17; } },
    );
    const result = { response: "English draft" };
    const params = {
      responseLocalePolicy: ARABIC_POLICY,
      result,
      session,
      bridge: {
        getResult: () => ({}),
        hasOutboundDelivery: () => false,
      },
      agentId: "agent-a",
      sessionKey: {
        tenantId: "tenant-a", agentId: "agent-a", channelId: "channel-a", userId: "user_a",
      },
      deps: {
        eventBus,
        logger,
        clock: { now: () => now, nowDate: () => new Date(now) },
      },
    } as unknown as RunPromptParams;

    await applyResponseLocaleEnforcement(params);

    expect(result.response).toBe("هذه إجابة مصححة.");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 7, locale: "ar" }),
      "Response locale repair completed",
    );
    expect(recoveryEvent).toHaveBeenCalledWith(expect.objectContaining({
      reason: "locale_fidelity",
      succeeded: true,
    }));
    expect(JSON.stringify(recoveryEvent.mock.calls)).not.toContain("English draft");
    expect(JSON.stringify(recoveryEvent.mock.calls)).not.toContain("إجابة مصححة");
  });

  it("does not let an unrelated send hide a failed attachment during locale repair", async () => {
    const eventBus = new TypedEventBus();
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    const originalResponse = "The file was not sent because the delivery tool failed.";
    const session = {
      agent: { state: { tools: [{ name: "message" }] } },
      messages: [{ role: "assistant", content: [{ type: "text", text: originalResponse }] }],
      prompt: vi.fn(async () => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "تم إرسال الملف بنجاح." }],
        });
      }),
    };
    const result = { response: originalResponse };
    const params = {
      responseLocalePolicy: ARABIC_POLICY,
      result,
      session,
      bridge: {
        getResult: () => ({
          failedToolCalls: 1,
          failedTools: ["message"],
          toolExecResults: [
            messageToolResult({
              success: false,
              action: "attach",
              attachmentUrl: "/workspace/report.pdf",
              invocationSequence: 0,
            }),
            messageToolResult({ success: true, action: "send", invocationSequence: 1 }),
          ],
        }),
        hasOutboundDelivery: () => false,
      },
      agentId: "agent-a",
      sessionKey: {
        tenantId: "tenant-a", agentId: "agent-a", channelId: "channel-a", userId: "user_a",
      },
      deps: {
        eventBus,
        logger,
        clock: { now: () => 10, nowDate: () => new Date(10) },
      },
    } as unknown as RunPromptParams;

    await applyResponseLocaleEnforcement(params);

    expect(result.response).toBe(originalResponse);
    expect(result).toMatchObject({
      localeQualityFinding: {
        kind: "locale_script_mismatch",
        locale: "ar",
        expectedScript: "Arab",
        actualScript: "Latn",
      },
      responseLocaleRepairSkipped: {
        reason: "unrecovered_tool_failure",
        expectedScript: "Arab",
        actualScript: "Latn",
        unrecoveredToolFailureCount: 1,
      },
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      {
        step: "response-locale-repair-skipped",
        locale: "ar",
        expectedScript: "Arab",
        actualScript: "Latn",
        unrecoveredToolCount: 1,
        unrecoveredToolFailureCount: 1,
        unrecoveredTools: ["message"],
      },
      "Response locale repair skipped after an unrecovered tool failure",
    );
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(originalResponse);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("تم إرسال الملف بنجاح");
  });

  it("allows locale repair after a failed tool succeeds on retry", async () => {
    const eventBus = new TypedEventBus();
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    const originalResponse = "The file was sent after the delivery tool recovered.";
    const session = makeRealLocaleSession(
      originalResponse,
      "تم إرسال الملف بعد استعادة أداة التسليم.",
    );
    const result = { response: originalResponse };
    const params = {
      responseLocalePolicy: ARABIC_POLICY,
      result,
      session,
      bridge: {
        getResult: () => ({
          failedToolCalls: 1,
          failedTools: ["message"],
          toolExecResults: [
            messageToolResult({
              success: false,
              action: "attach",
              attachmentUrl: "/workspace/report.pdf",
              invocationSequence: 0,
            }),
            messageToolResult({
              success: true,
              action: "attach",
              attachmentUrl: "/workspace/report.pdf",
              invocationSequence: 1,
            }),
          ],
        }),
        hasOutboundDelivery: () => true,
      },
      agentId: "agent-a",
      sessionKey: {
        tenantId: "tenant-a", agentId: "agent-a", channelId: "channel-a", userId: "user_a",
      },
      deps: {
        eventBus,
        logger,
        clock: { now: () => 10, nowDate: () => new Date(10) },
      },
    } as unknown as RunPromptParams;

    await applyResponseLocaleEnforcement(params);

    expect(result.response).toBe("تم إرسال الملف بعد استعادة أداة التسليم.");
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("returns silently when a failed-tool turn has no locale mismatch", async () => {
    const eventBus = new TypedEventBus();
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    const response = "هذه إجابة عربية.";
    const session = {
      agent: { state: { tools: [{ name: "message" }] } },
      messages: [{ role: "assistant", content: [{ type: "text", text: response }] }],
      prompt: vi.fn(),
    };
    const result = { response };
    const getResult = vi.fn(() => ({
      failedTools: ["message"],
      toolExecResults: [messageToolResult({
        success: false,
        action: "send",
        invocationSequence: 0,
      })],
    }));
    const params = {
      responseLocalePolicy: ARABIC_POLICY,
      result,
      session,
      bridge: {
        getResult,
        hasOutboundDelivery: () => false,
      },
      agentId: "agent-a",
      sessionKey: {
        tenantId: "tenant-a", agentId: "agent-a", channelId: "channel-a", userId: "user_a",
      },
      deps: {
        eventBus,
        logger,
        clock: { now: () => 10, nowDate: () => new Date(10) },
      },
    } as unknown as RunPromptParams;

    await applyResponseLocaleEnforcement(params);

    expect(result.response).toBe(response);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(getResult).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("localeQualityFinding");
  });

  it("returns silently when locale enforcement is disabled", async () => {
    const eventBus = new TypedEventBus();
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    const response = "English response with a failed delivery.";
    const session = {
      agent: { state: { tools: [{ name: "message" }] } },
      messages: [{ role: "assistant", content: [{ type: "text", text: response }] }],
      prompt: vi.fn(),
    };
    const result = { response };
    const getResult = vi.fn(() => ({ failedTools: ["message"] }));
    const params = {
      responseLocalePolicy: { ...ARABIC_POLICY, enforceLocale: false },
      result,
      session,
      bridge: { getResult, hasOutboundDelivery: () => false },
      agentId: "agent-a",
      sessionKey: {
        tenantId: "tenant-a", agentId: "agent-a", channelId: "channel-a", userId: "user_a",
      },
      deps: {
        eventBus,
        logger,
        clock: { now: () => 10, nowDate: () => new Date(10) },
      },
    } as unknown as RunPromptParams;

    await applyResponseLocaleEnforcement(params);

    expect(result.response).toBe(response);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(getResult).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("localeQualityFinding");
  });

  it("warns without content and reports failed recovery when repair drops literals", async () => {
    let now = 10;
    const eventBus = new TypedEventBus();
    const recoveryEvent = vi.fn();
    eventBus.on("execution:recovery_attempted", recoveryEvent);
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    const originalResponse = "The operation succeeded for item-alpha-7 after 3600000 ms.";
    const tools = [{ name: "write" }] as never[];
    const session = makeRealLocaleSession(
      originalResponse,
      "لم تنجح العملية ولا يوجد سجل.",
      { onStream: () => { now = 17; }, tools },
    );
    const result = { response: originalResponse };
    const params = {
      responseLocalePolicy: ARABIC_POLICY,
      result,
      session,
      bridge: {
        getResult: () => ({}),
        hasOutboundDelivery: () => false,
      },
      agentId: "agent-a",
      sessionKey: {
        tenantId: "tenant-a", agentId: "agent-a", channelId: "channel-a", userId: "user_a",
      },
      deps: {
        eventBus,
        logger,
        clock: { now: () => now, nowDate: () => new Date(now) },
      },
    } as unknown as RunPromptParams;

    await applyResponseLocaleEnforcement(params);

    expect(result.response).toBe(originalResponse);
    expect(session.agent.state.tools).toEqual(tools);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "response-locale-literal-preservation",
        durationMs: 7,
        errorKind: "validation",
        requiredLiteralCount: 2,
        missingLiteralCount: 2,
        missingLiteralCategories: expect.arrayContaining(["identifier", "number"]),
        hint: expect.stringContaining("original response was preserved"),
      }),
      "Response locale repair dropped required literals",
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(recoveryEvent).toHaveBeenCalledWith(expect.objectContaining({
      reason: "locale_fidelity",
      succeeded: false,
    }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("item-alpha-7");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("3600000");
  });
});

describe("the unrepaired-mismatch WARN names the resolver tier, not the model", () => {
  // Observed live: a single English instruction inside an otherwise-Hebrew
  // conversation set `locale=en source=request enforce=true`. All THREE repair
  // passes correctly came back Hebrew (the model was honouring the conversation's
  // established language), yet every WARN said "Inspect the selected model's
  // locale fidelity" — pointing the operator at the wrong knob. Each pass also
  // cost a full extra model call and broke the prompt cache.
  it("an INFERRED (request-tier) target says so and does not blame the model", () => {
    const hint = unrepairedMismatchHint("request");
    expect(hint).toMatch(/inferred/i);
    expect(hint).toContain("localeSource=request");
    expect(hint).not.toMatch(/model's locale fidelity/i);
    // …and it states the cost, so a recurring mismatch is not read as harmless.
    expect(hint).toMatch(/extra model call|prompt cache/i);
  });

  it("an OPERATOR PIN (explicit tier) still points at the model, because the pin is authoritative", () => {
    const hint = unrepairedMismatchHint("explicit");
    expect(hint).toMatch(/operator pin/i);
    expect(hint).toMatch(/locale fidelity/i);
  });
});
