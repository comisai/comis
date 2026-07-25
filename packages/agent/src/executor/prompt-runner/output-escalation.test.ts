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

  it("restores session.agent.streamFn in a finally block (one-shot wrapper)", () => {
    expect(source).toMatch(/} finally \{[\s\S]+?session\.agent\.streamFn = originalStreamFn/);
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
          streamFn: originalStreamFn,
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
    expect((params as { session: { agent: { streamFn: unknown } } }).session.agent.streamFn)
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
        agent: { streamFn: originalStreamFn },
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
    expect((params as { session: { agent: { streamFn: unknown } } }).session.agent.streamFn)
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
          streamFn: vi.fn(),
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
