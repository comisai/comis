// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { parseModelString, runWithModelRetry, type ModelRetryParams } from "./model-retry.js";
import { PromptTimeoutError } from "./prompt-timeout.js";

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

      expect(result).toEqual({ succeeded: true, error: undefined });
      expect(params.session.prompt).toHaveBeenCalledTimes(1);
    });

    it("records success on authRotation when hasProfiles returns true", async () => {
      const authRotation = makeAuthRotation();
      const params = makeParams({
        deps: {
          eventBus: makeEventBus(),
          logger: createMockLogger(),
          modelRegistry: makeModelRegistry(),
          authRotation: authRotation as any,
        },
      });

      await runWithModelRetry(params);

      expect(authRotation.hasProfiles).toHaveBeenCalledWith("anthropic");
      expect(authRotation.recordSuccess).toHaveBeenCalledWith("anthropic");
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
});
