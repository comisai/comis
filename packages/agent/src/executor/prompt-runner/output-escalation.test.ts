// SPDX-License-Identifier: Apache-2.0
/**
 * Structural tests for the output-escalation module.
 *
 * Behavioral coverage of output escalation, success-path response
 * processing (empty-recovery, SEP extraction, post-batch continuation,
 * budget continuation), and failure-path overflow recovery lives in the
 * underlying module tests:
 *   - executor-response-filter.test.ts (recoverEmptyFinalResponse,
 *     extractExecutionPlan, scanWithOutputGuard)
 *   - post-batch-continuation.test.ts
 *   - overflow-recovery.test.ts
 *   - error-classifier.test.ts (classifyError, classifyPromptTimeout)
 *
 * This file pins the structural invariants of the output-escalation entry
 * point and the dependency direction (no import from prompt-runner.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { registerToolMetadata } from "@comis/core";
import { err } from "@comis/shared";

import { escalateOutput } from "./output-escalation.js";
import { processFailurePath } from "./failure-path.js";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "output-escalation.ts");
const source = readFileSync(sourcePath, "utf-8");
const interactiveRecoverySource = readFileSync(
  resolve(here, "interactive-silent-recovery.ts"),
  "utf-8",
);

registerToolMetadata("read", { isReadOnly: true });
registerToolMetadata("web_search", { isReadOnly: true });
registerToolMetadata("web_fetch", { isReadOnly: true });

describe("output-escalation.ts — module surface", () => {
  it("exports an async function `escalateOutput`", () => {
    expect(typeof escalateOutput).toBe("function");
  });
});

describe("output-escalation.ts — escalation gate (max_tokens truncation)", () => {
  it("only fires when bridge stopReason === 'maxTokens' AND escalation enabled AND config.maxTokens undefined", () => {
    // Structural lock on the three-condition gate.
    expect(source).toMatch(/bridgeStopReason !== "maxTokens"/);
    expect(source).toMatch(/!escalationEnabled/);
    expect(source).toMatch(/config\.maxTokens !== undefined/);
  });

  it("emits the execution:output_escalated event for observability", () => {
    expect(source).toMatch(/execution:output_escalated/);
    expect(source).toMatch(/originalMaxTokens/);
    expect(source).toMatch(/escalatedMaxTokens/);
  });

  it("restores session.agent.streamFunction in a finally block (one-shot wrapper)", () => {
    expect(source).toMatch(/} finally \{[\s\S]+?session\.agent\.streamFunction = originalStreamFn/);
  });

  it("restores the session and propagates terminal denial before retry dispatch", async () => {
    const originalStreamFn = vi.fn();
    const prompt = vi.fn();
    const emit = vi.fn();
    let admissionChecks = 0;
    const denial = new Error("execution terminalized");
    const params = {
      msg: { channelId: "channel-a" },
      session: {
        agent: {
          state: { model: { maxTokens: 8_192 } },
          streamFunction: originalStreamFn,
        },
        prompt,
      },
      sessionKey: { tenantId: "default", channelId: "channel-a", userId: "user_a" },
      agentId: "agent-a",
      bridge: { getResult: () => ({ lastStopReason: "maxTokens" }) },
      config: {
        provider: "test-provider",
        model: "test-model",
        contextEngine: { outputEscalation: { enabled: true } },
      },
      effectiveTimeout: {
        promptTimeoutMs: 1_000,
        retryPromptTimeoutMs: 1_000,
        stallCeilingMultiplier: 2,
        source: "agent_config",
      },
      executionOverrides: {
        onProviderStart: () => {
          admissionChecks += 1;
          return err(denial);
        },
      },
      executionStartMs: 0,
      executionId: "execution-a",
      resolvedModel: { id: "test-model" },
      mergedCustomTools: [],
      result: {
        response: "",
        finishReason: "stop",
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 0,
      },
      deps: {
        logger: { info: vi.fn(), warn: vi.fn() },
        eventBus: { emit },
        clock: { now: () => 10 },
      },
    } as never;

    const result = await escalateOutput(
      params,
      "hello",
      undefined,
      undefined,
      false,
      undefined,
      true,
      undefined,
      false,
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(admissionChecks).toBe(1);
    expect((params as { session: { agent: { streamFunction: unknown } } }).session.agent.streamFunction)
      .toBe(originalStreamFn);
    expect(result).toMatchObject({
      promptSucceeded: false,
      escalationAttempted: false,
      promptError: denial,
    });
    expect(emit).toHaveBeenCalledWith("execution:output_escalated", expect.anything());
  });

  it("restores overflow recovery state after one terminal admission denial", async () => {
    const originalStreamFn = vi.fn();
    const prompt = vi.fn();
    const denial = new Error("execution terminalized");
    const onProviderStart = vi.fn(() => err(denial));
    const params = {
      session: {
        agent: { streamFunction: originalStreamFn },
        prompt,
      },
      config: { maxContextChars: 10_000 },
      effectiveTimeout: { retryPromptTimeoutMs: 1_000 },
      executionOverrides: { onProviderStart },
      deps: {
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    } as never;

    const result = await processFailurePath(
      params,
      "hello",
      undefined,
      new Error("prompt is too long"),
    );

    expect(onProviderStart).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
    expect((params as { session: { agent: { streamFunction: unknown } } }).session.agent.streamFunction)
      .toBe(originalStreamFn);
    expect(result).toMatchObject({
      promptSucceeded: false,
      promptError: denial,
    });
  });

  it("does not acknowledge provider start when escalation instrumentation fails", async () => {
    const instrumentationError = new Error("listener failed");
    const onProviderStart = vi.fn(() => {
      throw new Error("provider start must not run");
    });
    const prompt = vi.fn();
    const params = {
      msg: { channelId: "channel-a" },
      session: {
        agent: {
          state: { model: { maxTokens: 8_192 } },
          streamFunction: vi.fn(),
        },
        prompt,
      },
      sessionKey: { tenantId: "default", channelId: "channel-a", userId: "user_a" },
      agentId: "agent-a",
      bridge: { getResult: () => ({ lastStopReason: "maxTokens" }) },
      config: {
        provider: "test-provider",
        model: "test-model",
        contextEngine: { outputEscalation: { enabled: true } },
      },
      effectiveTimeout: {
        promptTimeoutMs: 1_000,
        retryPromptTimeoutMs: 1_000,
        stallCeilingMultiplier: 2,
        source: "agent_config",
      },
      executionOverrides: { onProviderStart },
      result: {},
      deps: {
        logger: { info: vi.fn(), warn: vi.fn() },
        eventBus: { emit: vi.fn(() => { throw instrumentationError; }) },
        clock: { now: () => 10 },
      },
    } as never;

    const result = await escalateOutput(
      params,
      "hello",
      undefined,
      undefined,
      false,
      undefined,
      true,
      undefined,
      false,
    );

    expect(onProviderStart).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      promptSucceeded: false,
      escalationAttempted: false,
      promptError: instrumentationError,
    });
  });

  it("preserves a bridge abort response without starting response-recovery turns", async () => {
    const abortResponse =
      "[Stopped: per-root wall-clock budget exceeded] Please try again.";
    const prompt = vi.fn(async () => undefined);
    const params = {
      msg: {
        channelType: "telegram",
        channelId: "channel-a",
        text: "keep checking",
      },
      session: {
        agent: {
          state: { model: { maxTokens: 8_192 } },
          streamFunction: vi.fn(),
        },
        messages: [
          { role: "user", content: [{ type: "text", text: "keep checking" }] },
          {
            role: "assistant",
            content: [{ type: "toolCall", name: "exec", arguments: {} }],
          },
          { role: "toolResult", content: [{ type: "text", text: "pending" }] },
          { role: "assistant", stopReason: "aborted", content: [] },
        ],
        prompt,
      },
      sessionKey: {
        tenantId: "default",
        channelId: "channel-a",
        userId: "user_a",
      },
      agentId: "agent-a",
      bridge: {
        getResult: () => ({
          abortResponse,
          finishReason: "spend_exceeded",
          lastStopReason: "aborted",
          stepsExecuted: 1,
          textEmitted: false,
        }),
        hasOutboundDelivery: () => true,
      },
      config: {
        provider: "test-provider",
        model: "test-model",
        contextEngine: {
          outputEscalation: { enabled: true },
          postBatchContinuation: { enabled: true, maxRetries: 1 },
        },
      },
      effectiveTimeout: {
        promptTimeoutMs: 1_000,
        retryPromptTimeoutMs: 1_000,
        stallCeilingMultiplier: 2,
        source: "agent_config",
      },
      executionStartMs: 0,
      executionId: "execution-a",
      resolvedModel: { id: "test-model" },
      mergedCustomTools: [],
      result: {
        response: "",
        finishReason: "stop",
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 0,
      },
      deps: {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        eventBus: { emit: vi.fn() },
        clock: { now: () => 10 },
      },
    } as never;

    const result = await escalateOutput(
      params,
      "keep checking",
      undefined,
      undefined,
      false,
      undefined,
      true,
      undefined,
      false,
    );

    expect(prompt).not.toHaveBeenCalled();
    expect((params as { result: { response: string } }).result.response).toBe(abortResponse);
    expect(result).toMatchObject({
      promptSucceeded: true,
      escalationAttempted: false,
    });
  });

  it("preserves a grounded answer when a dynamically discovered MCP tool succeeded", async () => {
    const groundedAnswer = "The connected records show a concentrated idle-time cluster.";
    const terminalNarration = "General research supports reducing sustained idling.";
    const toolExecResults: Array<{
      toolName: string;
      success: boolean;
      durationMs: number;
      citationUrlDigest?: string;
      webSearchQueryDigest?: string;
    }> = [{
      toolName: "mcp__records--summary",
      success: true,
      durationMs: 10,
    }];
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Review the connected records." }],
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: groundedAnswer }],
      },
    ];
    const prompt = vi.fn(async (instruction: string) => {
      messages.push({
        role: "user",
        content: [{ type: "text", text: instruction }],
      } as (typeof messages)[number]);
      if (prompt.mock.calls.length === 1) {
        messages.push({
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", name: "read", arguments: {} }],
        });
        messages.push({
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "procedure loaded" }],
        } as (typeof messages)[number]);
        toolExecResults.push({
          toolName: "read",
          success: true,
          durationMs: 1,
        });
        toolExecResults.push({
          toolName: "web_search",
          success: true,
          durationMs: 1,
          webSearchQueryDigest: "query_a",
        });
        toolExecResults.push({
          toolName: "web_fetch",
          success: true,
          durationMs: 1,
          citationUrlDigest: "url_a",
        });
        return;
      }
      messages.push({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: terminalNarration }],
      });
    });
    const params = {
      msg: {
        channelType: "telegram",
        channelId: "channel-a",
        text: "Review the connected records.",
      },
      session: {
        agent: {
          state: { model: { maxTokens: 8_192 } },
          streamFunction: vi.fn(),
        },
        messages,
        prompt,
      },
      sessionKey: {
        tenantId: "default",
        channelId: "channel-a",
        userId: "user_a",
      },
      formattedKey: "default:agent:default:user_a:telegram:peer:user_a",
      agentId: "agent-a",
      bridge: {
        getResult: () => ({
          lastStopReason: "stop",
          finishReason: "stop",
          stepsExecuted: toolExecResults.length,
          toolExecResults,
        }),
        hasOutboundDelivery: () => false,
      },
      config: {
        provider: "test-provider",
        model: "test-model",
        contextEngine: {
          outputEscalation: { enabled: true },
          postBatchContinuation: { enabled: false, maxRetries: 0 },
        },
      },
      effectiveTimeout: {
        promptTimeoutMs: 1_000,
        retryPromptTimeoutMs: 1_000,
        stallCeilingMultiplier: 2,
        source: "agent_config",
      },
      executionStartMs: 0,
      executionId: "execution-a",
      resolvedModel: { id: "test-model" },
      mergedCustomTools: [],
      requestRelevantToolNames: ["read", "web_search", "web_fetch"],
      requestRelevantPromptSkillNames: ["research-skill"],
      requestRelevantPromptSkillLocations: ["/skills/research-skill/SKILL.md"],
      requestRelevantPromptSkillWorkflowToolNames: ["web_search", "web_fetch"],
      requestRelevantPromptSkillMinDistinctWebFetchUrls: 1,
      requestRelevantPromptSkillMinDistinctWebSearchQueries: 1,
      sepEnabled: false,
      executionPlanRef: { current: undefined },
      result: {
        response: "",
        finishReason: "stop",
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 0,
      },
      deps: {
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          audit: vi.fn(),
        },
        eventBus: {
          emit: vi.fn(),
          emitSafely: vi.fn(() => ({ failures: [] })),
        },
        clock: { now: () => 10 },
      },
    } as never;

    await escalateOutput(
      params,
      "Review the connected records.",
      undefined,
      undefined,
      false,
      undefined,
      true,
      undefined,
      false,
    );

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1]?.[0]).toContain(
      "narrate the completed prompt skill workflow",
    );
    expect((params as { result: { requestToolNudge?: unknown } }).result.requestToolNudge)
      .toEqual({
        fired: true,
        recovered: true,
        matchedToolNames: ["read", "web_search", "web_fetch"],
      });
    expect((params as { result: { response: string } }).result.response)
      .toContain(groundedAnswer);
    expect((params as { result: { response: string } }).result.response)
      .toContain(terminalNarration);
  });
});

describe("output-escalation.ts — dependency direction", () => {
  it("does NOT import from prompt-runner.ts (dependency direction invariant)", () => {
    expect(source).not.toMatch(/from\s+"\.\/prompt-runner\.js"/);
  });

  it("imports types only from prompt-runner-types.ts", () => {
    expect(source).toMatch(/from\s+"\.\/prompt-runner-types\.js"/);
  });

  it("delegates failure-path processing to ./failure-path.js", () => {
    expect(source).toMatch(/from\s+"\.\/failure-path\.js"/);
    expect(source).toMatch(/processFailurePath/);
  });
});

describe("output-escalation.ts — failure log privacy", () => {
  it("converts retry and continuation failures to safe message strings", () => {
    expect(source).toMatch(/toSafeErrorLogString\(escalationError\)/);
    expect(source).toMatch(/toSafeErrorLogString\(continuationResult\.error\)/);
    expect(source).toMatch(/toSafeErrorLogString\(continuationResult\.error\.cause\)/);
    expect(source).not.toMatch(/err:\s*(?:escalationError|followUpResult\.error|continuationResult\.error\.cause)/);
  });
});

describe("output-escalation.ts — interactive silent-response boundary", () => {
  it("checks exact-route delivery evidence before accepting a silent response", () => {
    expect(source).toMatch(/applyInteractiveSilentRecovery/);
    expect(interactiveRecoverySource).toMatch(/recoverInteractiveSilentResponse/);
    expect(interactiveRecoverySource).toMatch(/bridge\.hasOutboundDelivery/);
    expect(interactiveRecoverySource).toMatch(/execution:recovery_attempted/);
    expect(interactiveRecoverySource).toMatch(/interactive_silent_sentinel/);
  });
});

describe("output-escalation.ts — response-language boundary", () => {
  it("applies bounded locale enforcement before the output guard", () => {
    const qualityIndex = source.indexOf("applyResponseLocaleEnforcement(");
    const guardIndex = source.indexOf("scanWithOutputGuard({", qualityIndex);

    expect(source).toMatch(/from\s+"\.\/response-locale-enforcement\.js"/);
    expect(qualityIndex).toBeGreaterThan(0);
    expect(guardIndex).toBeGreaterThan(qualityIndex);
  });
});
