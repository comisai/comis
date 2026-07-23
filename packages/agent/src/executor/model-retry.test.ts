// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { parseModelString, runWithModelRetry, isAuthError, type ModelRetryParams } from "./model-retry.js";
import { PromptTimeoutError } from "./prompt-timeout.js";
import { createLastKnownModelTracker } from "../model/last-known-model.js";
import { runWithContext } from "@comis/core";
import { err } from "@comis/shared";
import type { ClockPort, TimerPort, TimerHandle } from "@comis/core";

// ---------------------------------------------------------------------------
// Port stubs that delegate to globals so vi.useFakeTimers() intercepts.
// ---------------------------------------------------------------------------

function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  let unrefCalled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() { if (cancelled) return; cancelled = true; clearTimeout(t); },
    unref() { if (cancelled || unrefCalled) return; unrefCalled = true; t.unref(); },
  };
}

const testClock: ClockPort = { now: () => Date.now(), nowDate: () => new Date() };
const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides?: Record<string, unknown>) {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    getLastAssistantText: vi.fn().mockReturnValue("response"),
    subscribe: vi.fn().mockReturnValue(vi.fn()),
    abort: vi.fn(),
    dispose: vi.fn(),
    compact: vi.fn(),
    abortCompaction: vi.fn(),
    sendCustomMessage: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    fork: vi.fn(),
    getUserMessagesForForking: vi.fn(),
    navigateTree: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([]),
    getActiveToolNames: vi.fn().mockReturnValue([]),
    setActiveToolsByName: vi.fn(),
    isStreaming: false,
    isCompacting: false,
    agent: { setSystemPrompt: vi.fn(), streamFn: vi.fn() },
    ...overrides,
  } as any;
}

function makeModelRegistry() {
  return {
    find: vi.fn((_provider: string, _modelId: string) => ({
      name: "fallback-model",
      provider: "anthropic",
    })),
  } as any;
}

function makeEventBus() {
  return {
    emit: vi.fn(() => true),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  } as any;
}

function makeAuthRotation(overrides?: Record<string, unknown>) {
  return {
    hasProfiles: vi.fn(() => true),
    rotateKey: vi.fn(() => true),
    recordSuccess: vi.fn(),
    ...overrides,
  };
}

function makeParams(overrides?: Partial<ModelRetryParams>): ModelRetryParams {
  return {
    session: makeSession(),
    messageText: "Hello agent",
    config: { provider: "anthropic", model: "claude-3-opus" },
    timeoutConfig: { promptTimeoutMs: 180_000, retryPromptTimeoutMs: 60_000 },
    deps: {
      eventBus: makeEventBus(),
      logger: createMockLogger(),
      modelRegistry: makeModelRegistry(),
      agentId: "test-agent",
      sessionKey: "test-session",
      clock: testClock,
      timers: testTimers,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseModelString", () => {
  it("parses valid 'anthropic:claude-3-opus' format", () => {
    const result = parseModelString("anthropic:claude-3-opus");
    expect(result).toEqual({ provider: "anthropic", modelId: "claude-3-opus" });
  });

  it("parses valid 'openai:gpt-4' format", () => {
    const result = parseModelString("openai:gpt-4");
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4" });
  });

  it("returns undefined for string with no colon", () => {
    expect(parseModelString("anthropic-claude-3-opus")).toBeUndefined();
  });

  it("returns undefined for string starting with colon", () => {
    expect(parseModelString(":model-id")).toBeUndefined();
  });

  it("returns undefined for string ending with colon", () => {
    expect(parseModelString("provider:")).toBeUndefined();
  });
});

describe("runWithModelRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------
  // Primary success
  // -------------------------------------------------------------------
  describe("primary success", () => {
    it("returns succeeded:true when prompt succeeds on first try", async () => {
      const params = makeParams();
      const result = await runWithModelRetry(params);

      expect(result).toEqual({
        succeeded: true,
        error: undefined,
        effectiveModel: { provider: "anthropic", model: "claude-3-opus" },
      });
      expect(params.session.prompt).toHaveBeenCalledTimes(1);
    });

    it("records success on authRotation when hasProfiles returns true", async () => {
      const authRotation = makeAuthRotation();
      const params = makeParams({
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          authRotation: authRotation as any,
        },
      });

      await runWithModelRetry(params);

      expect(authRotation.hasProfiles).toHaveBeenCalledWith("anthropic");
      expect(authRotation.recordSuccess).toHaveBeenCalledWith("anthropic");
    });

    it("never enters any provider path when provider admission is denied", async () => {
      const denied = new Error("provider dispatch denied");
      const session = makeSession();
      const authRotation = makeAuthRotation();
      const params = makeParams({
        session,
        onProviderStart: () => err(denied),
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          authRotation: authRotation as never,
          fallbackModels: ["openai:gpt-4"],
          lastKnownModel: {
            getLastKnown: vi.fn(() => ({ provider: "google", model: "gemini-pro" })),
            getAnyKnown: vi.fn(() => ({ provider: "google", model: "gemini-pro" })),
          } as never,
        },
      });

      await expect(runWithModelRetry(params)).rejects.toBe(denied);
      expect(session.prompt).not.toHaveBeenCalled();
      expect(session.setModel).not.toHaveBeenCalled();
      expect(authRotation.rotateKey).not.toHaveBeenCalled();

      params.onProviderStart = () => {
        throw denied;
      };
      await expect(runWithModelRetry(params)).rejects.toBe(denied);
      expect(session.prompt).not.toHaveBeenCalled();
      expect(session.setModel).not.toHaveBeenCalled();
      expect(authRotation.rotateKey).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Auth key rotation
  // -------------------------------------------------------------------
  describe("auth key rotation", () => {
    it("rotates key and retries when primary fails and rotation succeeds", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("API key exhausted"))
        .mockResolvedValueOnce(undefined);

      const authRotation = makeAuthRotation();
      const params = makeParams({
        session,
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          authRotation: authRotation as any,
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      expect(authRotation.rotateKey).toHaveBeenCalledWith("anthropic");
      expect(authRotation.recordSuccess).toHaveBeenCalledWith("anthropic");
      expect(session.prompt).toHaveBeenCalledTimes(2);
    });

    it("logs 'Rotated API key for provider' on rotation", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("API key exhausted"))
        .mockResolvedValueOnce(undefined);

      const logger = createMockLogger();
      const authRotation = makeAuthRotation();
      const params = makeParams({
        session,
        deps: {
          eventBus: makeEventBus(),
          logger,
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          authRotation: authRotation as any,
        },
      });

      await runWithModelRetry(params);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "anthropic" }),
        "Rotated API key for provider",
      );
    });

    it("falls through to model fallback when rotated key also fails", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("primary fail"))
        .mockRejectedValueOnce(new Error("rotated fail"))
        .mockResolvedValueOnce(undefined); // fallback succeeds

      const authRotation = makeAuthRotation();
      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          authRotation: authRotation as any,
          fallbackModels: ["openai:gpt-4"],
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      expect(session.prompt).toHaveBeenCalledTimes(3);
      // Fallback attempt event emitted
      expect(eventBus.emit).toHaveBeenCalledWith(
        "model:fallback_attempt",
        expect.objectContaining({
          toProvider: "openai",
          toModel: "gpt-4",
        }),
      );
    });
  });

  // -------------------------------------------------------------------
  // Model fallback
  // -------------------------------------------------------------------
  describe("model fallback", () => {
    it("falls back to first model when primary fails (no auth rotation)", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("primary fail"))
        .mockResolvedValueOnce(undefined);

      const eventBus = makeEventBus();
      const modelRegistry = makeModelRegistry();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry,
          fallbackModels: ["openai:gpt-4"],
          clock: testClock,
          timers: testTimers,
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith(
        "model:fallback_attempt",
        expect.objectContaining({
          fromProvider: "anthropic",
          fromModel: "claude-3-opus",
          toProvider: "openai",
          toModel: "gpt-4",
          attemptNumber: 1,
        }),
      );
    });

    it("tries multiple fallbacks before succeeding", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("primary fail"))
        .mockRejectedValueOnce(new Error("first fallback fail"))
        .mockResolvedValueOnce(undefined);

      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4", "google:gemini-pro"],
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      // Two fallback attempts emitted
      const fallbackCalls = vi.mocked(eventBus.emit).mock.calls.filter(
        (c) => c[0] === "model:fallback_attempt",
      );
      expect(fallbackCalls).toHaveLength(2);
      expect(fallbackCalls[0][1]).toEqual(expect.objectContaining({ attemptNumber: 1 }));
      expect(fallbackCalls[1][1]).toEqual(expect.objectContaining({ attemptNumber: 2 }));
    });

    it("calls session.setModel with the resolved model from modelRegistry.find", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("primary fail"))
        .mockResolvedValueOnce(undefined);

      const modelRegistry = makeModelRegistry();
      const params = makeParams({
        session,
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry,
          fallbackModels: ["openai:gpt-4"],
          clock: testClock,
          timers: testTimers,
        },
      });

      await runWithModelRetry(params);

      expect(modelRegistry.find).toHaveBeenCalledWith("openai", "gpt-4");
      expect(session.setModel).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Exhausted retries
  // -------------------------------------------------------------------
  describe("exhausted retries", () => {
    it("returns succeeded:false and emits fallback_exhausted when all fail", async () => {
      const session = makeSession();
      const lastError = new Error("all fail");
      session.prompt
        .mockRejectedValueOnce(new Error("primary fail"))
        .mockRejectedValueOnce(new Error("fallback-1 fail"))
        .mockRejectedValue(lastError);

      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4", "google:gemini-pro"],
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(false);
      expect(result.error).toBeDefined();
      expect(eventBus.emit).toHaveBeenCalledWith(
        "model:fallback_exhausted",
        expect.objectContaining({
          provider: "anthropic",
          model: "claude-3-opus",
          totalAttempts: 3, // primary + 2 fallbacks
        }),
      );
    });
  });

  // -------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------
  describe("edge cases", () => {
    it("returns succeeded:false without emitting fallback_exhausted when no fallbacks configured", async () => {
      const session = makeSession();
      session.prompt.mockRejectedValueOnce(new Error("primary fail"));

      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          // no fallbackModels
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(false);
      // Should NOT emit fallback_exhausted (no fallbacks to exhaust)
      const exhaustedCalls = vi.mocked(eventBus.emit).mock.calls.filter(
        (c) => c[0] === "model:fallback_exhausted",
      );
      expect(exhaustedCalls).toHaveLength(0);
    });

    it("handles unparseable fallback model string gracefully", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("primary fail"))
        .mockResolvedValueOnce(undefined);

      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["invalid-format-no-colon"],
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      // fallback_attempt emitted with provider "unknown"
      expect(eventBus.emit).toHaveBeenCalledWith(
        "model:fallback_attempt",
        expect.objectContaining({
          toProvider: "unknown",
          toModel: "invalid-format-no-colon",
        }),
      );
      // setModel should NOT have been called (can't parse model string)
      expect(session.setModel).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Prompt timeout
  // -------------------------------------------------------------------
  describe("prompt timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("wraps primary prompt with promptTimeoutMs timeout", async () => {
      const session = makeSession();
      // Mock prompt to never resolve (hangs forever)
      session.prompt.mockReturnValue(new Promise(() => {}));

      const params = makeParams({
        session,
        timeoutConfig: { promptTimeoutMs: 50, retryPromptTimeoutMs: 60_000 },
      });

      const resultPromise = runWithModelRetry(params);
      const caught = resultPromise.catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(50);

      // The function returns { succeeded: false } rather than throwing
      const result = await resultPromise;
      expect(result.succeeded).toBe(false);
      expect(result.error).toBeInstanceOf(PromptTimeoutError);
      expect(session.abort).toHaveBeenCalled();
    });

    it("wraps fallback model prompt with retryPromptTimeoutMs timeout", async () => {
      const session = makeSession();
      // Primary fails immediately, fallback hangs forever
      session.prompt
        .mockRejectedValueOnce(new Error("primary fail"))
        .mockReturnValue(new Promise(() => {}));

      const params = makeParams({
        session,
        timeoutConfig: { promptTimeoutMs: 180_000, retryPromptTimeoutMs: 50 },
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4"],
        },
      });

      const resultPromise = runWithModelRetry(params);

      await vi.advanceTimersByTimeAsync(50);

      const result = await resultPromise;
      expect(result.succeeded).toBe(false);
      expect(result.error).toBeInstanceOf(PromptTimeoutError);
    });

    it("emits execution:prompt_timeout event on primary timeout", async () => {
      const session = makeSession();
      session.prompt.mockReturnValue(new Promise(() => {}));

      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        timeoutConfig: { promptTimeoutMs: 50, retryPromptTimeoutMs: 60_000 },
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          agentId: "agent-1",
          sessionKey: "session-1",
        },
      });

      const resultPromise = runWithModelRetry(params);

      await vi.advanceTimersByTimeAsync(50);
      await resultPromise;

      expect(eventBus.emit).toHaveBeenCalledWith(
        "execution:prompt_timeout",
        expect.objectContaining({
          agentId: "agent-1",
          sessionKey: "session-1",
          timeoutMs: 50,
        }),
      );
    });

    it("succeeds normally when prompt completes within timeout", async () => {
      const session = makeSession();
      // Prompt resolves immediately (default mock behavior)
      const params = makeParams({ session });

      const resultPromise = runWithModelRetry(params);

      // Advance timers to let any async microtasks resolve
      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;
      expect(result.succeeded).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // Cache-aware short retry
  // -------------------------------------------------------------------
  describe("cache-aware short retry", () => {
    it("retries with same model on 429 with short retry-after", async () => {
      const session = makeSession();
      const rateLimitError = Object.assign(
        new Error("Rate limited"),
        { status: 429, headers: { "retry-after": "2" } },
      );
      session.prompt
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(undefined);

      const params = makeParams({ session });
      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      // Should NOT have called setModel (same model preserved)
      expect(session.setModel).not.toHaveBeenCalled();
      // Should have called prompt twice (primary + short retry)
      expect(session.prompt).toHaveBeenCalledTimes(2);
    });

    it("skips short retry on 429 with long retry-after (>20s)", async () => {
      const session = makeSession();
      const rateLimitError = Object.assign(
        new Error("Rate limited"),
        { status: 429, headers: { "retry-after": "30" } },
      );
      session.prompt
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(undefined); // fallback succeeds

      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4"],
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      // Should have gone to fallback (setModel called)
      expect(session.setModel).toHaveBeenCalled();
    });

    it("skips short retry on 429 without retry-after header", async () => {
      const session = makeSession();
      const rateLimitError = Object.assign(
        new Error("Rate limited"),
        { status: 429 },
      );
      session.prompt
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(undefined); // fallback succeeds

      const params = makeParams({
        session,
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4"],
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      // Should have gone to fallback (setModel called)
      expect(session.setModel).toHaveBeenCalled();
    });

    it("skips short retry on non-429/529 error", async () => {
      const session = makeSession();
      const serverError = Object.assign(
        new Error("Server error"),
        { status: 500 },
      );
      session.prompt
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(undefined); // fallback succeeds

      const params = makeParams({
        session,
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4"],
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      // Should have gone to fallback (setModel called)
      expect(session.setModel).toHaveBeenCalled();
    });

    it("falls through to rotation when short retry also fails", async () => {
      const session = makeSession();
      const rateLimitError = Object.assign(
        new Error("Rate limited"),
        { status: 429, headers: { "retry-after": "2" } },
      );
      const shortRetryError = new Error("Short retry also failed");
      session.prompt
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(shortRetryError)
        .mockResolvedValueOnce(undefined); // fallback succeeds

      const authRotation = makeAuthRotation();
      const params = makeParams({
        session,
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          authRotation: authRotation as any,
          fallbackModels: ["openai:gpt-4"],
        },
      });

      const result = await runWithModelRetry(params);

      // Should eventually succeed via rotation or fallback
      expect(result.succeeded).toBe(true);
      // Auth rotation should have been attempted
      expect(authRotation.rotateKey).toHaveBeenCalled();
    });

    it("retries with same model on 529 with short retry-after", async () => {
      const session = makeSession();
      const overloadError = Object.assign(
        new Error("Overloaded"),
        { status: 529, headers: { "retry-after": "3" } },
      );
      session.prompt
        .mockRejectedValueOnce(overloadError)
        .mockResolvedValueOnce(undefined);

      const params = makeParams({ session });
      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      expect(session.setModel).not.toHaveBeenCalled();
      expect(session.prompt).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------
  // resolvedModel in diagnostic logs
  // -------------------------------------------------------------------
  describe("resolvedModel diagnostic logging", () => {
    it("logs resolvedModel instead of config.model when provided", async () => {
      const session = makeSession();
      // Force primary prompt to fail so the WARN log fires
      session.prompt.mockRejectedValueOnce(new Error("overloaded"));

      const logger = createMockLogger();
      const params = makeParams({
        session,
        resolvedModel: "anthropic:claude-sonnet-4-5-20250929",
        deps: {
          eventBus: makeEventBus(),
          logger,
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          agentId: "test-agent",
          sessionKey: "test-session",
        },
      });

      await runWithModelRetry(params);

      // The WARN log at primary failure should contain the resolved model, not config.model
      const warnCalls = vi.mocked(logger.warn).mock.calls;
      const primaryFailureLog = warnCalls.find(
        (call: unknown[]) => call[1] === "Primary model prompt error",
      );
      expect(primaryFailureLog).toBeDefined();
      expect(primaryFailureLog![0]).toEqual(
        expect.objectContaining({ model: "anthropic:claude-sonnet-4-5-20250929" }),
      );
    });

    it("falls back to config model in log when resolvedModel is not provided", async () => {
      const session = makeSession();
      session.prompt.mockRejectedValueOnce(new Error("overloaded"));

      const logger = createMockLogger();
      const params = makeParams({
        session,
        deps: {
          eventBus: makeEventBus(),
          logger,
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          agentId: "test-agent",
          sessionKey: "test-session",
        },
      });

      await runWithModelRetry(params);

      const warnCalls = vi.mocked(logger.warn).mock.calls;
      const primaryFailureLog = warnCalls.find(
        (call: unknown[]) => call[1] === "Primary model prompt error",
      );
      expect(primaryFailureLog).toBeDefined();
      expect(primaryFailureLog![0]).toEqual(
        expect.objectContaining({ model: "anthropic:claude-3-opus" }),
      );
    });
  });

  // -------------------------------------------------------------------
  // isAuthError
  // -------------------------------------------------------------------
  describe("isAuthError", () => {
    it("returns true for 401 status errors", () => {
      const err = Object.assign(new Error("Unauthorized"), { status: 401 });
      expect(isAuthError(err)).toBe(true);
    });

    it("returns true for 403 status errors", () => {
      const err = Object.assign(new Error("Forbidden"), { status: 403 });
      expect(isAuthError(err)).toBe(true);
    });

    it("returns true for auth message patterns", () => {
      expect(isAuthError(new Error("invalid api key"))).toBe(true);
      expect(isAuthError(new Error("Authentication failed"))).toBe(true);
      expect(isAuthError(new Error("Unauthorized access"))).toBe(true);
      expect(isAuthError(new Error("permission denied"))).toBe(true);
    });

    it("returns false for non-auth errors", () => {
      expect(isAuthError(new Error("rate limit exceeded"))).toBe(false);
      expect(isAuthError(new Error("server error"))).toBe(false);
      const rateLimitErr = Object.assign(new Error("Too many requests"), { status: 429 });
      expect(isAuthError(rateLimitErr)).toBe(false);
    });

    it("returns false for non-Error values", () => {
      expect(isAuthError("string error")).toBe(false);
      expect(isAuthError(null)).toBe(false);
      expect(isAuthError(undefined)).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // effectiveModel tracking
  // -------------------------------------------------------------------
  describe("effectiveModel tracking", () => {
    it("effectiveModel reflects primary model on primary success", async () => {
      const params = makeParams();
      const result = await runWithModelRetry(params);

      expect(result.effectiveModel).toEqual({
        provider: "anthropic",
        model: "claude-3-opus",
      });
    });

    it("effectiveModel reflects fallback model on fallback success", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("primary fail"))
        .mockResolvedValueOnce(undefined);

      const params = makeParams({
        session,
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4"],
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.effectiveModel).toEqual({
        provider: "openai",
        model: "gpt-4",
      });
    });
  });

  // -------------------------------------------------------------------
  // Last-known-working model fallback
  // -------------------------------------------------------------------
  describe("LKW fallback", () => {
    it("tries LKW model after all configured fallbacks fail with auth error", async () => {
      const session = makeSession();
      const authErr = Object.assign(new Error("Unauthorized"), { status: 401 });
      session.prompt
        .mockRejectedValueOnce(authErr)  // primary
        .mockRejectedValueOnce(authErr)  // fallback
        .mockResolvedValueOnce(undefined); // LKW succeeds

      const lkwTracker = createLastKnownModelTracker();
      lkwTracker.recordSuccess("other-agent", "google", "gemini-pro");

      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4"],
          lastKnownModel: lkwTracker,
          agentId: "test-agent",
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      expect(result.effectiveModel).toEqual({
        provider: "google",
        model: "gemini-pro",
      });
      expect(eventBus.emit).toHaveBeenCalledWith(
        "model:lkw_fallback_attempt",
        expect.objectContaining({
          toProvider: "google",
          toModel: "gemini-pro",
        }),
      );
    });

    it("does NOT try LKW for non-auth errors (e.g. rate limit)", async () => {
      const session = makeSession();
      const rateLimitErr = Object.assign(new Error("Rate limited"), { status: 429 });
      session.prompt.mockRejectedValue(rateLimitErr);

      const lkwTracker = createLastKnownModelTracker();
      lkwTracker.recordSuccess("other-agent", "google", "gemini-pro");

      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          lastKnownModel: lkwTracker,
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(false);
      // LKW attempt event should NOT be emitted
      const lkwCalls = vi.mocked(eventBus.emit).mock.calls.filter(
        (c) => c[0] === "model:lkw_fallback_attempt",
      );
      expect(lkwCalls).toHaveLength(0);
    });

    it("skips LKW if same provider/model as primary", async () => {
      const session = makeSession();
      const authErr = Object.assign(new Error("Unauthorized"), { status: 401 });
      session.prompt.mockRejectedValue(authErr);

      const lkwTracker = createLastKnownModelTracker();
      // LKW is same as primary -- should be skipped
      lkwTracker.recordSuccess("test-agent", "anthropic", "claude-3-opus");

      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          lastKnownModel: lkwTracker,
          agentId: "test-agent",
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(false);
      const lkwCalls = vi.mocked(eventBus.emit).mock.calls.filter(
        (c) => c[0] === "model:lkw_fallback_attempt",
      );
      expect(lkwCalls).toHaveLength(0);
    });

    it("LKW fallback success sets effectiveModel", async () => {
      const session = makeSession();
      const authErr = Object.assign(new Error("Unauthorized"), { status: 401 });
      session.prompt
        .mockRejectedValueOnce(authErr) // primary
        .mockResolvedValueOnce(undefined); // LKW succeeds

      const lkwTracker = createLastKnownModelTracker();
      lkwTracker.recordSuccess("other-agent", "openai", "gpt-4");

      const params = makeParams({
        session,
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          lastKnownModel: lkwTracker,
          agentId: "test-agent",
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      expect(result.effectiveModel).toEqual({
        provider: "openai",
        model: "gpt-4",
      });
    });
  });

  // -------------------------------------------------------------------
  // model:* turn-scoping ids on the emit sites
  // -------------------------------------------------------------------
  describe("model:* turn-scoping ids", () => {
    function emitOf(eventBus: ReturnType<typeof makeEventBus>, name: string) {
      return vi.mocked(eventBus.emit).mock.calls.find((c: unknown[]) => c[0] === name)?.[1] as
        | Record<string, unknown>
        | undefined;
    }

    it("model:fallback_attempt carries agentId, sessionKey, and traceId (from turn context)", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("primary fail"))
        .mockResolvedValueOnce(undefined);

      const eventBus = makeEventBus();
      const traceId = randomUUID();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4"],
          agentId: "agent-x",
          sessionKey: "t1:u1:c1",
        },
      });

      await runWithContext(
        { tenantId: "t1", userId: "u1", sessionKey: "t1:u1:c1", traceId, startedAt: Date.now() },
        () => runWithModelRetry(params),
      );

      const payload = emitOf(eventBus, "model:fallback_attempt");
      expect(payload).toBeDefined();
      expect(payload!.agentId).toBe("agent-x");
      expect(payload!.sessionKey).toBe("t1:u1:c1");
      expect(payload!.traceId).toBe(traceId);
      // Existing fields preserved.
      expect(payload!.toProvider).toBe("openai");
      expect(payload!.toModel).toBe("gpt-4");
    });

    it("model:fallback_exhausted carries agentId, sessionKey, and traceId", async () => {
      const session = makeSession();
      session.prompt.mockRejectedValue(new Error("all fail"));

      const eventBus = makeEventBus();
      const traceId = randomUUID();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4"],
          agentId: "agent-y",
          sessionKey: "t2:u2:c2",
        },
      });

      await runWithContext(
        { tenantId: "t2", userId: "u2", sessionKey: "t2:u2:c2", traceId, startedAt: Date.now() },
        () => runWithModelRetry(params),
      );

      const payload = emitOf(eventBus, "model:fallback_exhausted");
      expect(payload).toBeDefined();
      expect(payload!.agentId).toBe("agent-y");
      expect(payload!.sessionKey).toBe("t2:u2:c2");
      expect(payload!.traceId).toBe(traceId);
    });

    it("model:lkw_fallback_attempt carries agentId, sessionKey, and traceId", async () => {
      const session = makeSession();
      const authErr = Object.assign(new Error("Unauthorized"), { status: 401 });
      session.prompt
        .mockRejectedValueOnce(authErr) // primary
        .mockRejectedValueOnce(authErr) // fallback
        .mockResolvedValueOnce(undefined); // LKW succeeds

      const lkwTracker = createLastKnownModelTracker();
      lkwTracker.recordSuccess("other-agent", "google", "gemini-pro");

      const eventBus = makeEventBus();
      const traceId = randomUUID();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4"],
          lastKnownModel: lkwTracker,
          agentId: "agent-z",
          sessionKey: "t3:u3:c3",
        },
      });

      await runWithContext(
        { tenantId: "t3", userId: "u3", sessionKey: "t3:u3:c3", traceId, startedAt: Date.now() },
        () => runWithModelRetry(params),
      );

      const payload = emitOf(eventBus, "model:lkw_fallback_attempt");
      expect(payload).toBeDefined();
      expect(payload!.agentId).toBe("agent-z");
      expect(payload!.sessionKey).toBe("t3:u3:c3");
      expect(payload!.traceId).toBe(traceId);
    });
  });

  // -------------------------------------------------------------------
  // tool_schema_unsupported ladder short-circuit
  // -------------------------------------------------------------------
  //
  // A grammar-compile/schema 400 is deterministic — rotating auth keys or
  // burning fallback models cannot fix a tool schema the provider can't
  // compile. The ladder must return { succeeded: false } immediately and
  // leave the single repair attempt to the executor's withSession-scoped
  // strip-retry (silent-failure-handlers.ts).
  describe("tool_schema_unsupported ladder short-circuit", () => {
    // Verbatim llama-server grammar-400 body (llama.cpp #19716). The wrapper
    // embeds `invalid_request_error`; the classifier maps it to
    // tool_schema_unsupported (ordered before client_request).
    const llamaServerBody =
      '{"error":{"code":400,"message":"JSON schema conversion failed:\\nUnrecognized schema: {\\"description\\":\\"Value for add/replace/test operations\\"}","type":"invalid_request_error"}}';

    it("returns succeeded:false immediately for a grammar-400 without burning rotation, fallback models, or setModel", async () => {
      const session = makeSession();
      const grammarError = new Error(llamaServerBody);
      session.prompt.mockRejectedValue(grammarError);

      const authRotation = makeAuthRotation();
      const logger = createMockLogger();
      const params = makeParams({
        session,
        deps: {
          eventBus: makeEventBus(),
          logger,
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          authRotation: authRotation as any,
          fallbackModels: ["openai:gpt-4"],
        },
      });

      const result = await runWithModelRetry(params);

      // Deterministic schema problem: the ladder must not run at all.
      expect(result.succeeded).toBe(false);
      expect(result.error).toBe(grammarError);
      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(session.setModel).not.toHaveBeenCalled();
      expect(authRotation.rotateKey).not.toHaveBeenCalled();

      // Guard WARN carries the AGENTS.md §2.7 fields: hint naming the durable knob
      // (comisCompat.toolSchemaProfile) + errorKind "validation".
      const warnCalls = vi.mocked(logger.warn).mock.calls;
      const guardLog = warnCalls.find(
        (call: unknown[]) => call[1] === "Schema-unsupported error: fallback ladder skipped",
      );
      expect(guardLog).toBeDefined();
      expect(guardLog![0]).toEqual(
        expect.objectContaining({
          errorKind: "validation",
          hint: expect.stringContaining("toolSchemaProfile"),
        }),
      );
    });

    it("falls through to the fallback ladder unchanged for a generic provider error (guard scoped to the one category)", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValueOnce(undefined); // fallback succeeds

      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        deps: {
          eventBus,
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          clock: testClock,
          timers: testTimers,
          fallbackModels: ["openai:gpt-4"],
        },
      });

      const result = await runWithModelRetry(params);

      expect(result.succeeded).toBe(true);
      expect(session.setModel).toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith(
        "model:fallback_attempt",
        expect.objectContaining({ toProvider: "openai", toModel: "gpt-4" }),
      );
    });
  });

  // -------------------------------------------------------------------
  // Stall/makespan timeout wiring matrix
  // -------------------------------------------------------------------
  //
  // The prompt-timeout primitive tests prove the stall/makespan semantics on
  // withResettablePromptTimeout in isolation. This block is the wiring half:
  // model-retry must thread makespanMs = promptTimeoutMs × stallCeilingMultiplier
  // into the primary race (non-optional wherever stall semantics apply,
  // for every provider), split providerHealth
  // recording by limit (makespan-kill suppressed, stall-kill kept — pinned in
  // both directions), enrich the execution:prompt_timeout payload with the
  // attribution fields, and flip the timeout WARN errorKind to "timeout".
  // Retry/fallback prompts stay whole-turn (pinned below).
  describe("stall/makespan timeout wiring matrix", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Drain chained .then/.finally hops left queued after a timer advance. */
    async function flushMicrotasks(hops = 12): Promise<void> {
      for (let i = 0; i < hops; i++) await Promise.resolve();
    }

    /** 180s stall budget × multiplier 10 → 1_800_000 makespan; agent_config binding. */
    const LAT_TIMEOUT_CONFIG = {
      promptTimeoutMs: 180_000,
      retryPromptTimeoutMs: 60_000,
      stallCeilingMultiplier: 10,
      source: "agent_config",
    } as ModelRetryParams["timeoutConfig"];

    function makeLatDeps(extra?: Record<string, unknown>): ModelRetryParams["deps"] {
      return {
        eventBus: makeEventBus(),
        logger: createMockLogger(),
        modelRegistry: makeModelRegistry(),
        agentId: "test-agent",
        sessionKey: "test-session",
        clock: testClock,
        timers: testTimers,
        ...extra,
      } as ModelRetryParams["deps"];
    }

    function makeHungSession() {
      const session = makeSession();
      session.prompt.mockReturnValue(new Promise(() => {}));
      return session;
    }

    /**
     * Runaway-generation shape: resets every 170s (inside the 180s stall budget) ×10
     * → t=1_700_000 with the run still alive. A pure stall budget never
     * kills this; only the non-resetting makespan ceiling can.
     */
    async function surviveToCeiling(getReset: () => (() => void) | undefined): Promise<void> {
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(170_000);
        getReset()?.();
      }
    }

    it("delta-driven resets survive the stall budget but the makespan ceiling kills at EXACTLY promptTimeoutMs × multiplier (limit makespan)", async () => {
      const session = makeHungSession();
      let captured: (() => void) | undefined;
      const params = makeParams({
        session,
        timeoutConfig: LAT_TIMEOUT_CONFIG,
        deps: makeLatDeps({ onResetTimer: (fn: () => void) => { captured = fn; } }),
      });

      let settled = false;
      const tracked = runWithModelRetry(params).then((r) => { settled = true; return r; });

      await surviveToCeiling(() => captured);
      await flushMicrotasks();
      // t=1_700_000: alive — resets extended the run far past the 180_000
      // stall budget (the pre-existing reset semantics, unchanged).
      expect(settled).toBe(false);

      // 1ms before the ceiling: still alive.
      await vi.advanceTimersByTimeAsync(99_999);
      await flushMicrotasks();
      expect(settled).toBe(false);

      // t=1_800_000 = 180_000 × 10: the NON-resetting makespan ceiling fires.
      // RED (pre-patch): makespanMs is not threaded into the race — the run
      // never dies and `settled` stays false here.
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(settled).toBe(true);

      const result = await tracked;
      expect(result.succeeded).toBe(false);
      expect(result.error).toBeInstanceOf(PromptTimeoutError);
      expect((result.error as PromptTimeoutError).limit).toBe("makespan");
      expect((result.error as PromptTimeoutError).timeoutMs).toBe(1_800_000);
      expect(session.abort).toHaveBeenCalledTimes(1);
    });

    it("a makespan-kill is SUPPRESSED from providerHealth (model runaway ≠ provider unhealth) and logs a content-free DEBUG", async () => {
      const session = makeHungSession();
      const providerHealth = { recordFailure: vi.fn() };
      const logger = createMockLogger();
      let captured: (() => void) | undefined;
      const params = makeParams({
        session,
        timeoutConfig: LAT_TIMEOUT_CONFIG,
        deps: makeLatDeps({
          logger,
          providerHealth,
          onResetTimer: (fn: () => void) => { captured = fn; },
        }),
      });

      let settled = false;
      const tracked = runWithModelRetry(params).then((r) => { settled = true; return r; });

      await surviveToCeiling(() => captured);
      await vi.advanceTimersByTimeAsync(100_000);
      await flushMicrotasks();
      // RED guard (pre-patch): the makespan never fires — the run never dies.
      expect(settled).toBe(true);

      const result = await tracked;
      expect((result.error as PromptTimeoutError).limit).toBe("makespan");
      // The suppress direction: a runaway model that keeps streaming is NOT a
      // provider failure — booking it would let 3 slow-prefill turns trip the
      // safety gate into provider_degraded skips.
      expect(providerHealth.recordFailure).not.toHaveBeenCalled();

      // Content-free suppression DEBUG (knob/step/errorKind only).
      const suppression = vi.mocked(logger.debug).mock.calls.find(
        (c: unknown[]) => c[1] === "Provider-health recording suppressed for makespan kill",
      );
      expect(suppression).toBeDefined();
      expect(suppression![0]).toEqual(
        expect.objectContaining({
          errorKind: "timeout",
          hint: expect.stringContaining("makespan"),
        }),
      );
    });

    it("a stall-kill KEEPS providerHealth.recordFailure (a true hang IS what the registry exists to catch) and the error carries the configured makespan", async () => {
      const session = makeHungSession();
      const providerHealth = { recordFailure: vi.fn() };
      const params = makeParams({
        session,
        timeoutConfig: LAT_TIMEOUT_CONFIG,
        deps: makeLatDeps({ providerHealth }),
      });

      const resultPromise = runWithModelRetry(params);
      // No resets: a genuinely silent provider dies at the 180s stall budget —
      // hang-detection latency stays 3 minutes, not 30.
      await vi.advanceTimersByTimeAsync(180_000);
      const result = await resultPromise;

      expect(result.succeeded).toBe(false);
      const err = result.error as PromptTimeoutError;
      expect(err).toBeInstanceOf(PromptTimeoutError);
      expect(err.limit).toBe("stall");
      expect(err.stallBudgetMs).toBe(180_000);
      // RED (pre-patch): the race gets no opts — the stall error carries no
      // makespanMs (the wiring evidence; the primitive pins the rest).
      expect(err.makespanMs).toBe(1_800_000);

      // The keep direction: stall-kills still record.
      expect(providerHealth.recordFailure).toHaveBeenCalledTimes(1);
      expect(providerHealth.recordFailure).toHaveBeenCalledWith("anthropic", "test-agent");
    });

    it("the stall-kill execution:prompt_timeout payload carries full attribution (durationMs, limit, source, bindingKnob, budgets)", async () => {
      const session = makeHungSession();
      const eventBus = makeEventBus();
      const params = makeParams({
        session,
        timeoutConfig: LAT_TIMEOUT_CONFIG,
        deps: makeLatDeps({ eventBus }),
      });

      const resultPromise = runWithModelRetry(params);
      await vi.advanceTimersByTimeAsync(180_000);
      await resultPromise;

      const emit = vi.mocked(eventBus.emit).mock.calls.find(
        (c: unknown[]) => c[0] === "execution:prompt_timeout",
      );
      expect(emit).toBeDefined();
      const payload = emit![1] as Record<string, unknown>;
      expect(payload).toEqual(
        expect.objectContaining({
          agentId: "test-agent",
          sessionKey: "test-session",
          timeoutMs: 180_000,
          limit: "stall",
          source: "agent_config",
          bindingKnob: "agents.test-agent.promptTimeout.promptTimeoutMs",
          stallBudgetMs: 180_000,
          makespanMs: 1_800_000,
        }),
      );
      expect(payload.durationMs).toBeGreaterThanOrEqual(180_000);
    });

    it("a makespan-kill execution:prompt_timeout emit carries limit makespan", async () => {
      const session = makeHungSession();
      const eventBus = makeEventBus();
      let captured: (() => void) | undefined;
      const params = makeParams({
        session,
        timeoutConfig: LAT_TIMEOUT_CONFIG,
        deps: makeLatDeps({ eventBus, onResetTimer: (fn: () => void) => { captured = fn; } }),
      });

      const resultPromise = runWithModelRetry(params);
      await surviveToCeiling(() => captured);
      await vi.advanceTimersByTimeAsync(100_000);
      await resultPromise;

      const emit = vi.mocked(eventBus.emit).mock.calls.find(
        (c: unknown[]) => c[0] === "execution:prompt_timeout",
      );
      expect(emit).toBeDefined();
      const payload = emit![1] as Record<string, unknown>;
      expect(payload).toEqual(
        expect.objectContaining({
          timeoutMs: 1_800_000,
          limit: "makespan",
          makespanMs: 1_800_000,
          stallBudgetMs: 180_000,
        }),
      );
    });

    it("the primary-failure WARN logs errorKind timeout for PromptTimeoutError and keeps dependency for non-timeout errors", async () => {
      // Timeout case: the WARN must say errorKind "timeout" — pre-patch it
      // logs "dependency", misclassifying every prompt timeout in system/explain
      // errorKind rollups.
      const session = makeHungSession();
      const logger = createMockLogger();
      const params = makeParams({
        session,
        timeoutConfig: {
          promptTimeoutMs: 50,
          retryPromptTimeoutMs: 60_000,
          stallCeilingMultiplier: 10,
          source: "agent_config",
        } as ModelRetryParams["timeoutConfig"],
        deps: makeLatDeps({ logger }),
      });
      const resultPromise = runWithModelRetry(params);
      await vi.advanceTimersByTimeAsync(50);
      await resultPromise;

      const timeoutWarn = vi.mocked(logger.warn).mock.calls.find(
        (c: unknown[]) => c[1] === "Primary model prompt error",
      );
      expect(timeoutWarn).toBeDefined();
      expect(timeoutWarn![0]).toEqual(expect.objectContaining({ errorKind: "timeout" }));

      // Regression pin: a non-timeout dependency failure still says "dependency".
      const session2 = makeSession();
      session2.prompt.mockRejectedValueOnce(new Error("connection reset"));
      const logger2 = createMockLogger();
      const params2 = makeParams({ session: session2, deps: makeLatDeps({ logger: logger2 }) });
      const resultPromise2 = runWithModelRetry(params2);
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise2;

      const dependencyWarn = vi.mocked(logger2.warn).mock.calls.find(
        (c: unknown[]) => c[1] === "Primary model prompt error",
      );
      expect(dependencyWarn).toBeDefined();
      expect(dependencyWarn![0]).toEqual(expect.objectContaining({ errorKind: "dependency" }));
    });

    it("retry/fallback prompts stay whole-turn under retryPromptTimeoutMs — a reset during the fallback does NOT extend it and the retry-site emit is attribution-enriched with limit ABSENT", async () => {
      const session = makeSession();
      session.prompt
        .mockReturnValueOnce(new Promise(() => {})) // primary hangs → stall-kill at 180s
        .mockReturnValue(new Promise(() => {}));    // fallback hangs → whole-turn 60s window
      const eventBus = makeEventBus();
      let captured: (() => void) | undefined;
      const params = makeParams({
        session,
        timeoutConfig: LAT_TIMEOUT_CONFIG,
        deps: makeLatDeps({
          eventBus,
          fallbackModels: ["openai:gpt-4"],
          onResetTimer: (fn: () => void) => { captured = fn; },
        }),
      });

      let settled = false;
      const tracked = runWithModelRetry(params).then((r) => { settled = true; return r; });

      // Primary stall-kill at 180_000 (no resets); the fallback attempt arms
      // its NON-resettable 60_000 whole-turn window in the same drain.
      await vi.advanceTimersByTimeAsync(180_000);
      await flushMicrotasks();
      expect(settled).toBe(false); // fallback in flight

      // 30s into the fallback, attempt to extend via the captured (primary)
      // resetTimer — settled latch makes it a no-op; the retry window is
      // deliberately non-resettable (pinned by this test).
      await vi.advanceTimersByTimeAsync(30_000);
      captured?.();
      await vi.advanceTimersByTimeAsync(29_999);
      await flushMicrotasks();
      expect(settled).toBe(false); // alive 1ms before the whole-turn deadline

      await vi.advanceTimersByTimeAsync(1); // t = 180_000 + 60_000
      await flushMicrotasks();
      expect(settled).toBe(true); // the reset did NOT extend the retry window

      const result = await tracked;
      expect(result.succeeded).toBe(false);
      const err = result.error as PromptTimeoutError;
      expect(err).toBeInstanceOf(PromptTimeoutError);
      expect(err.timeoutMs).toBe(60_000);
      expect(err.limit).toBeUndefined(); // whole-turn semantics (non-resettable path)

      // Retry-site emit: attribution-enriched, limit ABSENT (absent ⇒ whole-turn).
      // RED (pre-patch): the emit carries only the 4 original fields.
      const emits = vi.mocked(eventBus.emit).mock.calls.filter(
        (c: unknown[]) => c[0] === "execution:prompt_timeout",
      );
      expect(emits).toHaveLength(2);
      const fallbackPayload = emits[1]![1] as Record<string, unknown>;
      expect(fallbackPayload.timeoutMs).toBe(60_000);
      expect(fallbackPayload.limit).toBeUndefined();
      expect(typeof fallbackPayload.durationMs).toBe("number");
      // The kill that fired was the retryPromptTimeoutMs
      // whole-turn race — the payload must name the RETRY knob, not the
      // promptTimeoutMs binding that timeoutConfig.source describes.
      expect(fallbackPayload.bindingKnob).toBe("agents.test-agent.promptTimeout.retryPromptTimeoutMs");
    });

    it("the rotated-key whole-turn kill emits the retryPromptTimeoutMs bindingKnob (limit absent ⇒ retry semantics, never the stall knob)", async () => {
      const session = makeSession();
      session.prompt
        .mockRejectedValueOnce(new Error("upstream 500")) // primary fails fast (non-timeout)
        .mockReturnValue(new Promise(() => {}));          // rotated retry hangs → whole-turn 60s kill
      const eventBus = makeEventBus();
      const authRotation = makeAuthRotation();
      const params = makeParams({
        session,
        timeoutConfig: LAT_TIMEOUT_CONFIG,
        deps: makeLatDeps({ eventBus, authRotation }),
      });

      const resultPromise = runWithModelRetry(params);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      expect(result.succeeded).toBe(false);
      // The primary error was not a timeout — only the rotated-key kill emits.
      const emits = vi.mocked(eventBus.emit).mock.calls.filter(
        (c: unknown[]) => c[0] === "execution:prompt_timeout",
      );
      expect(emits).toHaveLength(1);
      const payload = emits[0]![1] as Record<string, unknown>;
      expect(payload.timeoutMs).toBe(60_000);
      expect(payload.limit).toBeUndefined();
      // RED (pre-patch): bindingKnob said agents.test-agent.promptTimeout
      // .promptTimeoutMs — the stall knob for a kill the stall budget never saw.
      expect(payload.bindingKnob).toBe("agents.test-agent.promptTimeout.retryPromptTimeoutMs");
    });

    it("a terminal LKW-fallback timeout emits the enriched execution:prompt_timeout — the LAST record must describe the LKW attempt, not the prior kill", async () => {
      const session = makeSession();
      const authError = Object.assign(new Error("401 unauthorized"), { status: 401 });
      session.prompt
        .mockRejectedValueOnce(authError)        // primary fails with an auth error
        .mockReturnValue(new Promise(() => {})); // LKW attempt hangs → whole-turn 60s kill
      const eventBus = makeEventBus();
      const lkwTracker = createLastKnownModelTracker();
      lkwTracker.recordSuccess("other-agent", "google", "gemini-pro");
      const params = makeParams({
        session,
        timeoutConfig: LAT_TIMEOUT_CONFIG,
        deps: makeLatDeps({ eventBus, lastKnownModel: lkwTracker }),
      });

      const resultPromise = runWithModelRetry(params);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      expect(result.succeeded).toBe(false);
      // RED (pre-patch): the LKW catch emitted nothing — a terminal LKW
      // timeout left the PRIOR rotation/fallback kill as the 'terminal'
      // execution.prompt_timeout record, so the explain verdict's numbers
      // (model, durationMs) described the wrong attempt.
      const emits = vi.mocked(eventBus.emit).mock.calls.filter(
        (c: unknown[]) => c[0] === "execution:prompt_timeout",
      );
      expect(emits).toHaveLength(1); // the primary auth error never emits — only the LKW kill
      const payload = emits[0]![1] as Record<string, unknown>;
      expect(payload.timeoutMs).toBe(60_000);
      expect(payload.limit).toBeUndefined(); // whole-turn retry semantics
      expect(typeof payload.durationMs).toBe("number");
      expect(payload.bindingKnob).toBe("agents.test-agent.promptTimeout.retryPromptTimeoutMs");
    });

    it("a makespan product past Node's 2^31-1 timer cap is clamped at the derivation site — the ceiling does NOT collapse to an instant 1ms kill", async () => {
      const session = makeHungSession();
      const params = makeParams({
        session,
        timeoutConfig: {
          promptTimeoutMs: 600_000,
          retryPromptTimeoutMs: 60_000,
          // Hand-built carrier bypassing the zod bounds (the schema now caps
          // at 100): the product 2_400_000_000 exceeds 2^31-1. Node's
          // setTimeout clamps an overflowing delay to 1ms — pre-clamp, the
          // makespan timer fired INSTANTLY, every prompt was killed at once,
          // classified makespan, and suppressed from providerHealth.
          stallCeilingMultiplier: 4_000,
          source: "agent_config",
        } as ModelRetryParams["timeoutConfig"],
        deps: makeLatDeps(),
      });

      let settled = false;
      const tracked = runWithModelRetry(params).then((r) => { settled = true; return r; });

      // RED (pre-patch): the raw 2_400_000_000ms delay overflows the 32-bit
      // timer, clamps to 1ms, and the run dies right here.
      await vi.advanceTimersByTimeAsync(2);
      await flushMicrotasks();
      expect(settled).toBe(false);

      // The stall budget still owns the kill; the CLAMPED ceiling rides the
      // error for hint rendering.
      await vi.advanceTimersByTimeAsync(600_000);
      await flushMicrotasks();
      expect(settled).toBe(true);
      const result = await tracked;
      const err = result.error as PromptTimeoutError;
      expect(err).toBeInstanceOf(PromptTimeoutError);
      expect(err.limit).toBe("stall");
      expect(err.makespanMs).toBe(2_147_483_647);
    });
  });
});
