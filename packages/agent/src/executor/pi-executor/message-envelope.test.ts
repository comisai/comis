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
  it("classifies PromptTimeoutError and writes user-facing message", () => {
    const result = makeResult();
    const err = new PromptTimeoutError(30_000);
    handleEnvelopeException({ result }, makeDeps(), { error: err, sessionKey: result.sessionKey, agentId: "a1" });
    expect(result.finishReason).toBe("error");
    expect(result.errorContext?.errorType).toBe("PromptTimeout");
    expect(result.errorContext?.retryable).toBe(true);
    expect(result.response.length).toBeGreaterThan(0);
  });

  it("classifies generic Error and writes user-facing message", () => {
    const result = makeResult();
    const err = new Error("kaboom");
    handleEnvelopeException({ result }, makeDeps(), { error: err, sessionKey: result.sessionKey, agentId: "a1" });
    expect(result.finishReason).toBe("error");
    expect(result.errorContext?.errorType).toBe("UnexpectedError");
    expect(result.errorContext?.originalError).toBe("kaboom");
  });

  it("invokes outputGuard scan when configured and response non-empty", () => {
    const result = makeResult();
    const scan = vi.fn().mockReturnValue({ matches: [], redacted: false });
    const outputGuard = { scan } as unknown as MessageEnvelopeDeps["outputGuard"];
    const err = new Error("test");
    handleEnvelopeException(
      { result },
      makeDeps({ outputGuard, canaryToken: "secret-token" }),
      { error: err, sessionKey: result.sessionKey, agentId: "a1" },
    );
    expect(scan).toHaveBeenCalled();
  });

  it("state.result reference is mutated in place (orchestrator reads back)", () => {
    const result = makeResult();
    const before = result;
    handleEnvelopeException({ result }, makeDeps(), { error: new Error("x"), sessionKey: result.sessionKey, agentId: undefined });
    expect(result).toBe(before);
    expect(result.finishReason).toBe("error");
  });

  // CR-01 integration test: ContextExhaustionError → "context_exhausted" finishReason
  it("CR-01: ContextExhaustionError maps to finishReason 'context_exhausted' (not 'error')", () => {
    const result = makeResult();
    const err = new ContextExhaustionError(32_768, 31_500);
    handleEnvelopeException({ result }, makeDeps(), { error: err, sessionKey: result.sessionKey, agentId: "a1" });
    // Must map to context_exhausted so END_REASON_MAP fires the correct degradation cause
    expect(result.finishReason).toBe("context_exhausted");
    expect(result.response).toContain("conversation history");
    // errorContext must NOT be set (context_exhausted is a clean escalation, not an unclassified error)
    expect(result.errorContext).toBeUndefined();
  });

  it("CR-01: ContextExhaustionError user-facing message does not expose internal details", () => {
    const result = makeResult();
    const err = new ContextExhaustionError(32_768, 31_500);
    handleEnvelopeException({ result }, makeDeps(), { error: err, sessionKey: result.sessionKey, agentId: "a1" });
    // Internal token counts must not leak to user
    expect(result.response).not.toContain("31500");
    expect(result.response).not.toContain("32768");
    expect(result.response.length).toBeGreaterThan(0);
  });

  it("CR-01: non-ContextExhaustionError still maps to 'error' (regression guard)", () => {
    const result = makeResult();
    handleEnvelopeException({ result }, makeDeps(), { error: new Error("generic"), sessionKey: result.sessionKey, agentId: "a1" });
    expect(result.finishReason).toBe("error");
  });
});
