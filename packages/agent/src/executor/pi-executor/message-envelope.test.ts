// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for applyPromptRunOutcome + handleEnvelopeException —
 * runPrompt outcome translation.
 *
 * Closure-extracted helper (state-first): tests cover stuck-session
 * detection, exception classification, and OutputGuard scan wiring
 * without standing up a real runPrompt.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { SessionKey } from "@comis/core";

import { applyPromptRunOutcome, handleEnvelopeException, type MessageEnvelopeDeps } from "./message-envelope.js";
import type { ExecutionResult } from "../types.js";
import type { PromptRunResult } from "../prompt-runner/prompt-runner-types.js";
import { PromptTimeoutError } from "../prompt-timeout.js";
import { ContextExhaustionError } from "../../context-engine/errors.js";

function makeResult(): ExecutionResult {
  return {
    response: "",
    sessionKey: { tenantId: "t", channelId: "c", userId: "u" } as SessionKey,
    tokensUsed: { input: 0, output: 0, total: 0 },
    cost: { total: 0 },
    stepsExecuted: 0,
    llmCalls: 0,
    finishReason: "stop",
  };
}

function makeNoopLogger() {
  const logger: { [k: string]: unknown } = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, trace: () => {},
  };
  logger.child = () => logger;
  return logger;
}

function makeDeps(overrides: Partial<MessageEnvelopeDeps> = {}): MessageEnvelopeDeps {
  return {
    eventBus: { emit: () => {}, on: () => {}, off: () => {} } as unknown as MessageEnvelopeDeps["eventBus"],
    logger: makeNoopLogger() as unknown as MessageEnvelopeDeps["logger"],
    clock: { now: () => 0, nowDate: () => new Date(0) },
    outputGuard: undefined,
    canaryToken: undefined,
    ...overrides,
  };
}

describe("applyPromptRunOutcome", () => {
  it("sets session_reset finishReason + canonical reset message when stuck detected", () => {
    const result = makeResult();
    const promptRunResult: PromptRunResult = {
      promptSucceeded: false,
      promptError: undefined,
      stuckSessionDetected: true,
    } as unknown as PromptRunResult;
    applyPromptRunOutcome({ result }, makeDeps(), { promptRunResult, agentId: "a1", formattedKey: "fk1" });
    expect(result.finishReason).toBe("session_reset");
    expect(result.response).toContain("Session was in an inconsistent state");
  });

  it("does not mutate result when stuck not detected", () => {
    const result = makeResult();
    const promptRunResult: PromptRunResult = {
      promptSucceeded: true,
      stuckSessionDetected: false,
    } as unknown as PromptRunResult;
    applyPromptRunOutcome({ result }, makeDeps(), { promptRunResult, agentId: "a1", formattedKey: "fk1" });
    expect(result.finishReason).toBe("stop");
    expect(result.response).toBe("");
  });
});

describe("handleEnvelopeException", () => {
  // LAT-01-H-8 (Phase 177): the second classify chokepoint. A
  // PromptTimeoutError reaching the envelope handler now carries the named
  // terminal finishReason "prompt_timeout" (END_REASON_MAP → endReason
  // "timeout", LAT-04) and the WARN carries errorKind "timeout" + the
  // knob-named hint — pre-patch it flattened to finishReason "error" with
  // errorKind "internal" and a generic hint.
  it("LAT-01-H-8: PromptTimeoutError → finishReason 'prompt_timeout', WARN errorKind 'timeout' + knob-named hint; userMessage stays generic", () => {
    const result = makeResult();
    const warn = vi.fn();
    const logger = makeNoopLogger();
    logger.warn = warn;
    const err = new PromptTimeoutError(180_000, { limit: "stall", stallBudgetMs: 180_000 });
    handleEnvelopeException(
      { result },
      makeDeps({ logger: logger as unknown as MessageEnvelopeDeps["logger"] }),
      { error: err, sessionKey: result.sessionKey, agentId: "a1", executionStartMs: 0 },
    );
    expect(result.finishReason).toBe("prompt_timeout");
    expect(result.errorContext?.errorType).toBe("PromptTimeout");
    expect(result.errorContext?.retryable).toBe(true);
    const warnCall = warn.mock.calls.find((c) => c[1] === "Unexpected execution error");
    expect(warnCall).toBeDefined();
    expect(warnCall![0].errorKind).toBe("timeout");
    expect(warnCall![0].hint).toMatch(/agents\..*promptTimeout/);
    // User-safety (T-177-13): knob detail rides the hint only — never the reply.
    expect(result.response).toContain("too long");
    expect(result.response).not.toContain("agents.");
  });

  it("177-REVIEW IN-02: the envelope-seam timeout WARN carries durationMs and the hint carries the elapsed time (executionStartMs threaded through ctx)", () => {
    const result = makeResult();
    const warn = vi.fn();
    const logger = makeNoopLogger();
    logger.warn = warn;
    const err = new PromptTimeoutError(180_000, { limit: "stall", stallBudgetMs: 180_000 });
    handleEnvelopeException(
      { result },
      makeDeps({
        logger: logger as unknown as MessageEnvelopeDeps["logger"],
        clock: { now: () => 200_000, nowDate: () => new Date(200_000) },
      }),
      { error: err, sessionKey: result.sessionKey, agentId: "a1", executionStartMs: 5_000 },
    );
    const warnCall = warn.mock.calls.find((c) => c[1] === "Unexpected execution error");
    expect(warnCall).toBeDefined();
    // Pre-patch this second classify consumer passed only { agentId } and no
    // elapsedMs, and the WARN had no durationMs — the §2.7 matrix wants
    // elapsed on failure lines, and the failure-path consumer has both.
    expect(warnCall![0].durationMs).toBe(195_000);
    expect(warnCall![0].hint).toMatch(/after 195000ms/);
  });

  it("classifies generic Error and writes user-facing message", () => {
    const result = makeResult();
    const err = new Error("kaboom");
    handleEnvelopeException({ result }, makeDeps(), { error: err, sessionKey: result.sessionKey, agentId: "a1", executionStartMs: 0 });
    expect(result.finishReason).toBe("error");
    expect(result.errorContext?.errorType).toBe("UnexpectedError");
    expect(result.errorContext?.originalError).toBe("kaboom");
  });

  it("LAT-01-H-8 regression: a non-timeout error keeps finishReason 'error' + WARN errorKind 'internal' (unchanged path)", () => {
    const result = makeResult();
    const warn = vi.fn();
    const logger = makeNoopLogger();
    logger.warn = warn;
    handleEnvelopeException(
      { result },
      makeDeps({ logger: logger as unknown as MessageEnvelopeDeps["logger"] }),
      { error: new Error("kaboom"), sessionKey: result.sessionKey, agentId: "a1", executionStartMs: 0 },
    );
    expect(result.finishReason).toBe("error");
    const warnCall = warn.mock.calls.find((c) => c[1] === "Unexpected execution error");
    expect(warnCall).toBeDefined();
    expect(warnCall![0].errorKind).toBe("internal");
    expect(warnCall![0].hint).toBe("PiExecutor unexpected error");
  });

  it("invokes outputGuard scan when configured and response non-empty", () => {
    const result = makeResult();
    const scan = vi.fn().mockReturnValue({ matches: [], redacted: false });
    const outputGuard = { scan } as unknown as MessageEnvelopeDeps["outputGuard"];
    const err = new Error("test");
    handleEnvelopeException(
      { result },
      makeDeps({ outputGuard, canaryToken: "secret-token" }),
      { error: err, sessionKey: result.sessionKey, agentId: "a1", executionStartMs: 0 },
    );
    expect(scan).toHaveBeenCalled();
  });

  it("state.result reference is mutated in place (orchestrator reads back)", () => {
    const result = makeResult();
    const before = result;
    handleEnvelopeException({ result }, makeDeps(), { error: new Error("x"), sessionKey: result.sessionKey, agentId: undefined, executionStartMs: 0 });
    expect(result).toBe(before);
    expect(result.finishReason).toBe("error");
  });

  // CR-01 integration test: ContextExhaustionError → "context_exhausted" finishReason
  it("CR-01: ContextExhaustionError maps to finishReason 'context_exhausted' (not 'error')", () => {
    const result = makeResult();
    const err = new ContextExhaustionError(32_768, 31_500);
    handleEnvelopeException({ result }, makeDeps(), { error: err, sessionKey: result.sessionKey, agentId: "a1", executionStartMs: 0 });
    // Must map to context_exhausted so END_REASON_MAP fires the correct degradation cause
    expect(result.finishReason).toBe("context_exhausted");
    expect(result.response).toContain("conversation history");
    // errorContext must NOT be set (context_exhausted is a clean escalation, not an unclassified error)
    expect(result.errorContext).toBeUndefined();
  });

  it("CR-01: ContextExhaustionError user-facing message does not expose internal details", () => {
    const result = makeResult();
    const err = new ContextExhaustionError(32_768, 31_500);
    handleEnvelopeException({ result }, makeDeps(), { error: err, sessionKey: result.sessionKey, agentId: "a1", executionStartMs: 0 });
    // Internal token counts must not leak to user
    expect(result.response).not.toContain("31500");
    expect(result.response).not.toContain("32768");
    expect(result.response.length).toBeGreaterThan(0);
  });

  it("CR-01: non-ContextExhaustionError still maps to 'error' (regression guard)", () => {
    const result = makeResult();
    handleEnvelopeException({ result }, makeDeps(), { error: new Error("generic"), sessionKey: result.sessionKey, agentId: "a1", executionStartMs: 0 });
    expect(result.finishReason).toBe("error");
  });
});
