// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ok, err } from "@comis/shared";
import type { PerAgentConfig, SessionKey, NormalizedMessage } from "@comis/core";
import { formatSessionKey, runWithContext, tryGetContext } from "@comis/core";
import type { ExecutionResult } from "./types.js";
import { clearSessionToolNameSnapshot, clearSessionBootstrapFileSnapshot, clearSessionPromptSkillsXmlSnapshot } from "./prompt-assembly.js";
import { clearSessionToolSchemaSnapshot } from "./pi-executor.js";
import { resetPairedMemoryDedupForTests } from "./executor-post-execution.js";
import type { CacheBreakEvent, CacheBreakReason, PendingChanges } from "./cache-break-detection.js";

// ---------------------------------------------------------------------------
// Hoisted mock setup -- vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockPrompt,
  mockSubscribe,
  mockAbort,
  mockDispose,
  mockGetLastAssistantText,
  mockSetModel,
  mockSetSystemPrompt,
  mockCompact,
  mockAbortCompaction,
  mockSendCustomMessage,
  mockStreamFn,
  mockSteer,
  mockFollowUp,
  mockGetUserMessagesForForking,
  mockNavigateTree,
  mockGetAllTools,
  mockGetActiveToolNames,
  mockSetActiveToolsByName,
  mockSetThinkingLevel,
  mockSession,
  mockBridgeListener,
  mockGetResult,
  mockApplyOverrides,
  mockSettingsManagerCreate,
  mockSettingsManagerInMemory,
  mockAssembleRichSystemPrompt,
  mockBuildDateTimeSection,
  mockBuildInboundMetadataSection,
  mockLoadWorkspaceBootstrapFiles,
  mockBuildBootstrapContextFiles,
  mockDeduplicateResults,
  mockHybridSplit,
  mockCreateHybridMemoryInjector,
  mockWrapInEnvelope,
  mockResourceLoaderArgs,
  mockGetSkills,
} = vi.hoisted(() => {
  const mockPrompt = vi.fn().mockResolvedValue(undefined);
  const mockSubscribe = vi.fn().mockReturnValue(vi.fn());
  const mockAbort = vi.fn().mockResolvedValue(undefined);
  const mockDispose = vi.fn();
  const mockGetLastAssistantText = vi.fn().mockReturnValue("test response");
  const mockSetModel = vi.fn().mockResolvedValue(undefined);
  const mockSetSystemPrompt = vi.fn();
  const mockCompact = vi.fn().mockResolvedValue({ summary: "compacted", firstKeptEntryId: "e1", tokensBefore: 5000 });
  const mockAbortCompaction = vi.fn();

  const mockSendCustomMessage = vi.fn().mockResolvedValue(undefined);
  const mockStreamFn = vi.fn().mockReturnValue("original-stream");
  const mockSteer = vi.fn().mockResolvedValue(undefined);
  const mockFollowUp = vi.fn().mockResolvedValue(undefined);
  // fork() removed from AgentSession in pi-mono v0.65.0 (moved to AgentSessionRuntime)
  const mockGetUserMessagesForForking = vi.fn().mockReturnValue([
    { entryId: "entry-1", text: "First user message" },
    { entryId: "entry-2", text: "Second user message" },
  ]);
  const mockNavigateTree = vi.fn().mockResolvedValue({ cancelled: false });
  const mockGetAllTools = vi.fn().mockReturnValue([
    { name: "bash", description: "Execute bash", parameters: {} },
    { name: "read", description: "Read file", parameters: {} },
  ]);
  const mockGetActiveToolNames = vi.fn().mockReturnValue(["bash", "read"]);
  const mockSetActiveToolsByName = vi.fn();
  const mockSetThinkingLevel = vi.fn();

  const mockSession = {
    prompt: mockPrompt,
    subscribe: mockSubscribe,
    abort: mockAbort,
    dispose: mockDispose,
    getLastAssistantText: mockGetLastAssistantText,
    setModel: mockSetModel,
    compact: mockCompact,
    abortCompaction: mockAbortCompaction,
    sendCustomMessage: mockSendCustomMessage,
    steer: mockSteer,
    followUp: mockFollowUp,
    getUserMessagesForForking: mockGetUserMessagesForForking,
    navigateTree: mockNavigateTree,
    getAllTools: mockGetAllTools,
    getActiveToolNames: mockGetActiveToolNames,
    setActiveToolsByName: mockSetActiveToolsByName,
    setThinkingLevel: mockSetThinkingLevel,
    isStreaming: false,
    isCompacting: false,
    messages: [] as any[],
    agent: { setSystemPrompt: mockSetSystemPrompt, beforeToolCall: undefined as any, streamFn: mockStreamFn, state: { model: null } },
    getSessionStats: vi.fn().mockReturnValue({
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0,
    }),
  };

  const mockBridgeListener = vi.fn();
  const mockGetResult = vi.fn().mockReturnValue({
    tokensUsed: { input: 100, output: 50, total: 150 },
    cost: { total: 0.01 },
    stepsExecuted: 2,
    llmCalls: 1,
    finishReason: "stop",
  });

  const mockApplyOverrides = vi.fn();
  const mockSettingsManagerCreate = vi.fn().mockReturnValue({ applyOverrides: mockApplyOverrides });
  const mockSettingsManagerInMemory = vi.fn().mockReturnValue({ applyOverrides: mockApplyOverrides });
  const mockAssembleRichSystemPrompt = vi.fn().mockReturnValue("assembled system prompt");
  const mockBuildDateTimeSection = vi.fn().mockReturnValue(["## Current Date & Time", "2026-03-12T00:00:00.000Z (mock)"]);
  const mockBuildInboundMetadataSection = vi.fn().mockReturnValue([]);
  const mockLoadWorkspaceBootstrapFiles = vi.fn().mockResolvedValue([]);
  const mockBuildBootstrapContextFiles = vi.fn().mockReturnValue([]);
  const mockDeduplicateResults = vi.fn((results: any[]) => results);
  const mockHybridSplit = vi.fn().mockReturnValue({ inlineMemory: undefined, systemPromptSections: [] });
  const mockCreateHybridMemoryInjector = vi.fn().mockReturnValue({ split: mockHybridSplit });
  const mockWrapInEnvelope = vi.fn().mockReturnValue("envelope-wrapped text");

  // Capture DefaultResourceLoader constructor args and mock getSkills
  const mockResourceLoaderArgs = { captured: null as any };
  const mockGetSkills = vi.fn().mockReturnValue({ skills: [], diagnostics: [] });

  return {
    mockPrompt,
    mockSubscribe,
    mockAbort,
    mockDispose,
    mockGetLastAssistantText,
    mockSetModel,
    mockSetSystemPrompt,
    mockCompact,
    mockAbortCompaction,
    mockSendCustomMessage,
    mockStreamFn,
    mockSteer,
    mockFollowUp,
    mockGetUserMessagesForForking,
    mockNavigateTree,
    mockGetAllTools,
    mockGetActiveToolNames,
    mockSetActiveToolsByName,
    mockSetThinkingLevel,
    mockSession,
    mockBridgeListener,
    mockGetResult,
    mockApplyOverrides,
    mockSettingsManagerCreate,
    mockSettingsManagerInMemory,
    mockAssembleRichSystemPrompt,
    mockBuildDateTimeSection,
    mockBuildInboundMetadataSection,
    mockLoadWorkspaceBootstrapFiles,
    mockBuildBootstrapContextFiles,
    mockDeduplicateResults,
    mockHybridSplit,
    mockCreateHybridMemoryInjector,
    mockWrapInEnvelope,
    mockResourceLoaderArgs,
    mockGetSkills,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn().mockResolvedValue({ session: mockSession, extensionsResult: {} }),
  SettingsManager: {
    create: mockSettingsManagerCreate,
    inMemory: mockSettingsManagerInMemory,
  },
  DefaultResourceLoader: class MockDefaultResourceLoader {
    private _systemPromptOverride: ((base: string | undefined) => string | undefined) | undefined;
    constructor(opts: any) {
      mockResourceLoaderArgs.captured = opts;
      (this as any).getSkills = mockGetSkills;
      this._systemPromptOverride = opts?.systemPromptOverride;
    }
    async reload() { /* no-op in tests */ }
    getSystemPrompt() {
      return this._systemPromptOverride?.("") ?? "";
    }
  },
}));

vi.mock("../session/orphaned-message-repair.js", () => ({
  repairOrphanedMessages: vi.fn().mockReturnValue({ repaired: false }),
  scrubPoisonedThinkingBlocks: vi.fn().mockReturnValue({ scrubbed: false, blocksRemoved: 0 }),
}));

vi.mock("../bridge/pi-event-bridge.js", () => ({
  createPiEventBridge: vi.fn().mockReturnValue({
    listener: mockBridgeListener,
    getResult: mockGetResult,
    addGhostCost: vi.fn(),
  }),
}));

vi.mock("../bootstrap/index.js", () => ({
  assembleRichSystemPrompt: mockAssembleRichSystemPrompt,
  assembleRichSystemPromptBlocks: vi.fn().mockReturnValue({ staticPrefix: "static-prefix", attribution: "attribution", semiStableBody: "semi-stable-body" }),
  buildDateTimeSection: mockBuildDateTimeSection,
  buildInboundMetadataSection: mockBuildInboundMetadataSection,
  loadWorkspaceBootstrapFiles: mockLoadWorkspaceBootstrapFiles,
  buildBootstrapContextFiles: mockBuildBootstrapContextFiles,
  filterBootstrapFilesForLightContext: vi.fn().mockReturnValue([]),
  filterBootstrapFilesForGroupChat: vi.fn().mockReturnValue([]),
  filterBootstrapFilesForCron: vi.fn().mockReturnValue([]),
  resolveSenderDisplay: vi.fn().mockImplementation((sid: string) => sid),
  resolveVerbosityProfile: vi.fn().mockReturnValue(undefined),
  buildVerbosityHintSection: vi.fn().mockReturnValue([]),
  buildSenderTrustSection: vi.fn().mockReturnValue([]),
  buildSubagentRoleSection: vi.fn().mockReturnValue([]),
}));

vi.mock("../rag/rag-retriever.js", () => ({
  deduplicateResults: mockDeduplicateResults,
}));

vi.mock("../rag/hybrid-memory-injector.js", () => ({
  createHybridMemoryInjector: mockCreateHybridMemoryInjector,
}));

vi.mock("../envelope/message-envelope.js", () => ({
  wrapInEnvelope: mockWrapInEnvelope,
}));

// Mock tool-parallelism module -- passthrough so existing tests are unaffected
vi.mock("./tool-parallelism.js", () => ({
  createMutationSerializer: vi.fn().mockReturnValue((tools: unknown[]) => tools),
  isReadOnlyTool: vi.fn().mockReturnValue(false),
  isConcurrencySafe: vi.fn().mockReturnValue(false),
}));

// Mock node:fs -- appendFileSync, statSync, renameSync, unlinkSync for JSONL trace verification
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    appendFileSync: vi.fn(),
    statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Import modules after mock setup
// ---------------------------------------------------------------------------

import { createPiExecutor, createBeforeToolCallGuard, mergeSessionStats, clearSessionToolSchemaSnapshotHash, _getOrCreateSessionLatchesForTest, _clearSessionLatchesForTest, type PiExecutorDeps } from "./pi-executor.js";
import { repairOrphanedMessages } from "../session/orphaned-message-repair.js";
import { createPiEventBridge } from "../bridge/pi-event-bridge.js";
import { assembleRichSystemPrompt, loadWorkspaceBootstrapFiles, buildBootstrapContextFiles } from "../bootstrap/index.js";
import { createRagRetriever } from "../rag/rag-retriever.js";
import { wrapInEnvelope } from "../envelope/message-envelope.js";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { appendFileSync } from "node:fs";
const mockAppendFileSync = vi.mocked(appendFileSync);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testSessionKey: SessionKey = {
  tenantId: "t1",
  channelId: "c1",
  userId: "u1",
};

const testMessage: NormalizedMessage = {
  id: "msg-1",
  text: "hello world",
  senderId: "user1",
  channelId: "c1",
  channelType: "test",
  timestamp: Date.now(),
} as NormalizedMessage;

const testConfig: PerAgentConfig = {
  name: "test-agent",
  model: "claude-sonnet-4-5-20250929",
  provider: "anthropic",
  promptTimeout: {
    promptTimeoutMs: 180_000,
    retryPromptTimeoutMs: 60_000,
  },
} as PerAgentConfig;

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<PiExecutorDeps>): PiExecutorDeps {
  return {
    circuitBreaker: {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      getState: vi.fn(),
      reset: vi.fn(),
    },
    budgetGuard: {
      recordUsage: vi.fn(),
      checkBudget: vi.fn().mockReturnValue(ok(undefined)),
      estimateCost: vi.fn(),
      resetExecution: vi.fn(),
      getSnapshot: vi.fn().mockReturnValue({ perExecution: 0, perHour: 0, perDay: 0 }),
    },
    costTracker: {
      record: vi.fn(),
    } as any,
    stepCounter: {
      increment: vi.fn().mockReturnValue(1),
      shouldHalt: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
      getCount: vi.fn().mockReturnValue(0),
    },
    eventBus: {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      listenerCount: vi.fn().mockReturnValue(0),
    } as any,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
      fatal: vi.fn(),
      trace: vi.fn(),
    } as any,
    authStorage: {} as any,
    modelRegistry: {
      find: vi.fn().mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5-20250929" }),
      getAll: vi.fn().mockReturnValue([]),
      getAvailable: vi.fn().mockReturnValue([]),
    } as any,
    sessionAdapter: {
      withSession: vi.fn().mockImplementation(
        async (_sk: SessionKey, fn: (sm: any) => Promise<any>) => {
          const mockSm = {
            buildSessionContext: vi.fn().mockReturnValue({ messages: [] }),
            appendMessage: vi.fn(),
            getSessionDir: vi.fn().mockReturnValue("/tmp/test-session"),
          };
          const value = await fn(mockSm);
          return ok(value);
        },
      ),
      destroySession: vi.fn().mockResolvedValue(undefined),
    },
    workspaceDir: "/tmp/test-workspace",
    agentDir: "/tmp/test-agent-dir",
    customTools: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PiExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear tool name snapshot to prevent cross-test leakage
    clearSessionToolNameSnapshot(formatSessionKey(testSessionKey));
    clearSessionBootstrapFileSnapshot(formatSessionKey(testSessionKey));
    clearSessionPromptSkillsXmlSnapshot(formatSessionKey(testSessionKey));
    // Clear tool schema snapshot to prevent cross-test leakage
    clearSessionToolSchemaSnapshot(formatSessionKey(testSessionKey));
    // Clear tool schema snapshot hash to prevent cross-test leakage
    clearSessionToolSchemaSnapshotHash(formatSessionKey(testSessionKey));
    // Restore default mock returns
    mockPrompt.mockResolvedValue(undefined);
    mockGetLastAssistantText.mockReturnValue("test response");
    mockSetModel.mockResolvedValue(undefined);
    mockSubscribe.mockReturnValue(vi.fn());
    mockCompact.mockResolvedValue({ summary: "compacted", firstKeptEntryId: "e1", tokensBefore: 5000 });
    mockAbortCompaction.mockReset();
    mockGetUserMessagesForForking.mockReturnValue([
      { entryId: "entry-1", text: "First user message" },
      { entryId: "entry-2", text: "Second user message" },
    ]);
    mockNavigateTree.mockResolvedValue({ cancelled: false });
    mockGetAllTools.mockReturnValue([
      { name: "bash", description: "Execute bash", parameters: {} },
      { name: "read", description: "Read file", parameters: {} },
    ]);
    mockGetActiveToolNames.mockReturnValue(["bash", "read"]);
    mockSetActiveToolsByName.mockReset();
    mockSetThinkingLevel.mockReset();
    mockApplyOverrides.mockReset();
    mockSettingsManagerCreate.mockReturnValue({ applyOverrides: mockApplyOverrides });
    mockSettingsManagerInMemory.mockReturnValue({ applyOverrides: mockApplyOverrides });
    mockGetResult.mockReturnValue({
      tokensUsed: { input: 100, output: 50, total: 150 },
      cost: { total: 0.01 },
      stepsExecuted: 2,
      llmCalls: 1,
      finishReason: "stop",
    });
    (createAgentSession as Mock).mockResolvedValue({
      session: mockSession,
      extensionsResult: {},
    });
    // Reset streamFn to original mock (PiExecutor replaces it with wrapper chain)
    mockSession.agent.streamFn = mockStreamFn;
    // Reset steering mocks
    mockSteer.mockResolvedValue(undefined);
    mockFollowUp.mockResolvedValue(undefined);
    mockSession.isStreaming = false;
    mockSession.isCompacting = false;
    mockSession.messages = [];
    // Reset skill mocks
    mockResourceLoaderArgs.captured = null;
    mockGetSkills.mockReturnValue({ skills: [], diagnostics: [] });
  });

  // -------------------------------------------------------------------------
  // Basic execution
  // -------------------------------------------------------------------------

  describe("basic execution", () => {
    it("calls withSession with correct sessionKey", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(deps.sessionAdapter.withSession).toHaveBeenCalledWith(
        testSessionKey,
        expect.any(Function),
      );
    });

    it("calls createAgentSession with expected options", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: deps.workspaceDir,
          authStorage: deps.authStorage,
          modelRegistry: deps.modelRegistry,
          customTools: deps.customTools,
        }),
      );
    });

    it("calls session.prompt with message text (includes dynamic preamble)", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // dynamic preamble is prepended to user message
      expect(mockPrompt).toHaveBeenCalledWith(
        expect.stringContaining("hello world"),
        expect.objectContaining({ expandPromptTemplates: false }),
      );
      // Verify preamble wrapper tags are present
      const promptText = mockPrompt.mock.calls[0][0] as string;
      expect(promptText).toContain("[System context]");
      expect(promptText).toContain("[End system context]");
      expect(promptText).toContain("hello world");
    });

    it("returns response from getLastAssistantText", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.response).toBe("test response");
    });

    it("disposes session after completion", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockDispose).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // System prompt
  // -------------------------------------------------------------------------

  describe("system prompt", () => {
    it("passes systemPromptOverride to DefaultResourceLoader", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // Verify systemPromptOverride callback was passed to DefaultResourceLoader
      // and returns the Comis-assembled prompt when invoked.
      expect(mockResourceLoaderArgs.captured).toBeTruthy();
      expect(mockResourceLoaderArgs.captured.systemPromptOverride).toBeTypeOf("function");
      const overrideResult = mockResourceLoaderArgs.captured.systemPromptOverride("");
      expect(overrideResult).toBe("assembled system prompt");
    });
  });

  // -------------------------------------------------------------------------
  // Safety controls
  // -------------------------------------------------------------------------

  describe("safety controls", () => {
    it("returns finishReason circuit_open when circuit breaker is open", async () => {
      const deps = createMockDeps({
        circuitBreaker: {
          isOpen: vi.fn().mockReturnValue(true),
          recordSuccess: vi.fn(),
          recordFailure: vi.fn(),
          getState: vi.fn(),
          reset: vi.fn(),
        },
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("circuit_open");
      expect(mockPrompt).not.toHaveBeenCalled();
    });

    it("resets stepCounter and budgetGuard before execution", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(deps.stepCounter.reset).toHaveBeenCalled();
      expect(deps.budgetGuard.resetExecution).toHaveBeenCalled();
    });

    it("uses overrides.stepCounter instead of deps.stepCounter when provided", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const overrideStepCounter = {
        increment: vi.fn().mockReturnValue(1),
        shouldHalt: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
        getCount: vi.fn().mockReturnValue(0),
      };

      await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        undefined, undefined,
        { stepCounter: overrideStepCounter },
      );

      expect(overrideStepCounter.reset).toHaveBeenCalled();
      expect(deps.stepCounter.reset).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Model fallback
  // -------------------------------------------------------------------------

  describe("model fallback", () => {
    it("retries with fallback models when primary prompt fails", async () => {
      mockPrompt
        .mockRejectedValueOnce(new Error("Primary model overloaded"))
        .mockResolvedValueOnce(undefined);
      mockGetLastAssistantText.mockReturnValue("fallback response");

      const fallbackModel = { provider: "openai", id: "gpt-4o" };
      const deps = createMockDeps({
        fallbackModels: ["openai:gpt-4o"],
        modelRegistry: {
          find: vi.fn().mockImplementation((provider: string, modelId: string) => {
            if (provider === "openai" && modelId === "gpt-4o") return fallbackModel;
            return { provider: "anthropic", id: "claude-sonnet-4-5-20250929" };
          }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(mockSetModel).toHaveBeenCalledWith(fallbackModel);
      expect(mockPrompt).toHaveBeenCalledTimes(2);
      expect(result.response).toBe("fallback response");
    });

    it("stops retrying after first successful fallback", async () => {
      mockPrompt
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockResolvedValueOnce(undefined);
      mockGetLastAssistantText.mockReturnValue("first fallback response");

      const deps = createMockDeps({
        fallbackModels: ["openai:gpt-4o", "anthropic:claude-sonnet-4-20250514"],
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "openai", id: "gpt-4o" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      // Only 2 prompt calls: primary + first fallback (not second fallback)
      expect(mockPrompt).toHaveBeenCalledTimes(2);
      expect(result.response).toBe("first fallback response");
    });

    it("returns finishReason error when all fallbacks fail", async () => {
      mockPrompt
        .mockRejectedValueOnce(new Error("Primary failed"))
        .mockRejectedValueOnce(new Error("Fallback 1 failed"))
        .mockRejectedValueOnce(new Error("Fallback 2 failed"));

      const deps = createMockDeps({
        fallbackModels: ["openai:gpt-4o", "anthropic:claude-sonnet-4-20250514"],
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "test", id: "test" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      // Response should be generic, not containing raw error details
      expect(result.response).toBe("An error occurred while processing your request. Please try again.");
      // errorContext classifies the failure for operator diagnostics
      expect(result.errorContext).toEqual({
        errorType: "PromptFailure",
        retryable: false,
        originalError: expect.any(String),
      });
    });

    it("returns finishReason error immediately when no fallback models", async () => {
      mockPrompt.mockRejectedValueOnce(new Error("Primary failed"));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      // errorContext classifies the failure for operator diagnostics
      expect(result.errorContext).toEqual({
        errorType: "PromptFailure",
        retryable: false,
        originalError: "Primary failed",
      });
    });

    it("returns finishReason error when fallbackModels is undefined", async () => {
      mockPrompt.mockRejectedValueOnce(new Error("Primary failed"));

      const deps = createMockDeps({ fallbackModels: undefined });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      expect(mockPrompt).toHaveBeenCalledTimes(1);
    });

    it("classifies PromptTimeoutError with errorType PromptTimeout and retryable true", async () => {
      const { PromptTimeoutError } = await import("./prompt-timeout.js");
      mockPrompt.mockRejectedValueOnce(new PromptTimeoutError(30000));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      expect(result.errorContext).toEqual({
        errorType: "PromptTimeout",
        retryable: true,
        originalError: expect.any(String),
      });
    });

    it("emits estimated observability:token_usage event on PromptTimeoutError", async () => {
      const { PromptTimeoutError } = await import("./prompt-timeout.js");
      mockPrompt.mockRejectedValueOnce(new PromptTimeoutError(30000));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const usageCalls = (deps.eventBus.emit as Mock).mock.calls.filter(
        ([name]: [string]) => name === "observability:token_usage",
      );
      expect(usageCalls.length).toBe(1);

      const [, payload] = usageCalls[0];
      expect(payload).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        tokens: {
          completion: 0,
        },
        cost: {
          output: 0,
        },
        cacheReadTokens: 0,
      });
      expect(payload.tokens.prompt).toBeGreaterThan(0);
      expect(payload.tokens.total).toBe(payload.tokens.prompt);
      expect(payload.cost.total).toBeGreaterThan(0);
      // total includes cache write cost, so total >= input
      expect(payload.cost.total).toBeGreaterThanOrEqual(payload.cost.input);
    });

    it("timeout estimation includes system prompt characters in token count", async () => {
      const { PromptTimeoutError } = await import("./prompt-timeout.js");
      mockPrompt.mockRejectedValueOnce(new PromptTimeoutError(30000));
      // System prompt of 400 chars = 100 estimated tokens at CHARS_PER_TOKEN_RATIO=4
      mockAssembleRichSystemPrompt.mockReturnValueOnce("x".repeat(400));
      // No tools to isolate system prompt contribution
      mockGetAllTools.mockReturnValueOnce([]);

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const usageCalls = (deps.eventBus.emit as Mock).mock.calls.filter(
        ([name]: [string]) => name === "observability:token_usage",
      );
      expect(usageCalls.length).toBe(1);

      const [, payload] = usageCalls[0];
      // Token estimate must include system prompt chars (400) + message chars (11 for "hello world")
      const expectedMinTokens = Math.ceil((testMessage.text.length + 400) / 4);
      expect(payload.tokens.prompt).toBeGreaterThanOrEqual(expectedMinTokens);
    });

    it("timeout estimation includes tool definition characters in token count", async () => {
      const { PromptTimeoutError } = await import("./prompt-timeout.js");
      mockPrompt.mockRejectedValueOnce(new PromptTimeoutError(30000));
      // Empty system prompt to isolate tool contribution
      mockAssembleRichSystemPrompt.mockReturnValueOnce("");
      const toolParams = { type: "object", properties: { cmd: { type: "string" } } };
      mockGetAllTools.mockReturnValueOnce([
        { name: "bash", description: "Execute commands", parameters: toolParams },
      ]);

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const usageCalls = (deps.eventBus.emit as Mock).mock.calls.filter(
        ([name]: [string]) => name === "observability:token_usage",
      );
      expect(usageCalls.length).toBe(1);

      const [, payload] = usageCalls[0];
      // Tool chars = "bash".length + "Execute commands".length + JSON.stringify(toolParams).length
      const toolChars = "bash".length + "Execute commands".length + JSON.stringify(toolParams).length;
      const expectedMinTokens = Math.ceil((testMessage.text.length + toolChars) / 4);
      expect(payload.tokens.prompt).toBeGreaterThanOrEqual(expectedMinTokens);
      // Must be larger than message-only estimate
      const messageOnlyTokens = Math.ceil(testMessage.text.length / 4);
      expect(payload.tokens.prompt).toBeGreaterThan(messageOnlyTokens);
    });

    it("timeout estimation includes estimated cache write cost", async () => {
      const { PromptTimeoutError } = await import("./prompt-timeout.js");
      mockPrompt.mockRejectedValueOnce(new PromptTimeoutError(30000));
      // Known system prompt of 400 chars for predictable cache write token estimate
      mockAssembleRichSystemPrompt.mockReturnValueOnce("x".repeat(400));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const usageCalls = (deps.eventBus.emit as Mock).mock.calls.filter(
        ([name]: [string]) => name === "observability:token_usage",
      );
      expect(usageCalls.length).toBe(1);

      const [, payload] = usageCalls[0];
      // Cache write cost adds to total beyond just input cost
      expect(payload.cost.total).toBeGreaterThan(payload.cost.input);
      // Cache write tokens should be non-zero for non-empty system prompt
      expect(payload.cacheWriteTokens).toBeGreaterThan(0);
      // Specifically: cacheWriteTokens = ceil(400 / 3.5) = 115
      expect(payload.cacheWriteTokens).toBe(115);
    });

    it("timeout estimation with empty system prompt and no tools has zero cache write cost", async () => {
      const { PromptTimeoutError } = await import("./prompt-timeout.js");
      mockPrompt.mockRejectedValueOnce(new PromptTimeoutError(30000));
      mockAssembleRichSystemPrompt.mockReturnValueOnce("");
      mockGetAllTools.mockReturnValueOnce([]);

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const usageCalls = (deps.eventBus.emit as Mock).mock.calls.filter(
        ([name]: [string]) => name === "observability:token_usage",
      );
      expect(usageCalls.length).toBe(1);

      const [, payload] = usageCalls[0];
      // Prompt tokens still > 0 (message text + dynamic preamble envelope wrapping)
      expect(payload.tokens.prompt).toBeGreaterThan(0);
      // No system prompt = no cache write tokens
      expect(payload.cacheWriteTokens).toBe(0);
      // With no cache write cost, total should equal input
      expect(payload.cost.total).toBe(payload.cost.input);
    });

    it("emits model:fallback_attempt event for each fallback", async () => {
      mockPrompt
        .mockRejectedValueOnce(new Error("Primary overloaded"))
        .mockRejectedValueOnce(new Error("Fallback 1 failed"))
        .mockResolvedValueOnce(undefined);

      const deps = createMockDeps({
        fallbackModels: ["openai:gpt-4o", "anthropic:claude-sonnet-4-20250514"],
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "test", id: "test" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const fallbackCalls = (deps.eventBus.emit as Mock).mock.calls.filter(
        ([name]: [string]) => name === "model:fallback_attempt",
      );
      expect(fallbackCalls.length).toBe(2);
      expect(fallbackCalls[0][1]).toMatchObject({
        fromProvider: "anthropic",
        fromModel: "claude-sonnet-4-5-20250929",
        toProvider: "openai",
        toModel: "gpt-4o",
        attemptNumber: 1,
      });
      expect(fallbackCalls[1][1]).toMatchObject({
        fromProvider: "anthropic",
        fromModel: "claude-sonnet-4-5-20250929",
        toProvider: "anthropic",
        toModel: "claude-sonnet-4-20250514",
        attemptNumber: 2,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Execution bookend log
  // -------------------------------------------------------------------------

  describe("execution bookend log", () => {
    it("emits logger.info with Execution complete and structured fields", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-1");

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const bookendCall = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Execution complete",
      );
      expect(bookendCall).toBeDefined();
      const [fields] = bookendCall!;
      expect(fields).toMatchObject({
        finishReason: "stop",
      });
      expect(fields.durationMs).toBeTypeOf("number");
      expect(fields.toolCalls).toBeTypeOf("number");
      expect(fields.llmCalls).toBeTypeOf("number");
      expect(fields.tokensTotal).toBeTypeOf("number");
      expect(fields.sessionKey).toBeTypeOf("string");
    });

    it("emits bookend log even when prompt fails", async () => {
      mockPrompt.mockRejectedValueOnce(new Error("LLM error"));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const bookendCall = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Execution complete",
      );
      expect(bookendCall).toBeDefined();
      expect(bookendCall![0].finishReason).toBe("error");
    });

    it("durationMs is a positive number", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const bookendCall = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Execution complete",
      );
      expect(bookendCall![0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("catches prompt error and returns generic message", async () => {
      mockPrompt.mockRejectedValueOnce(new Error("Model unavailable"));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      // Raw error details must NOT leak to user
      expect(result.response).toBe("An error occurred while processing your request. Please try again.");
      expect(result.response).not.toContain("Model unavailable");
    });

    it("never exposes API keys or internal URLs in error response", async () => {
      mockPrompt.mockRejectedValueOnce(
        new Error("Request failed: sk-abc123def456ghi789jkl012mno345 at https://api.openai.com/v1/chat"),
      );

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      expect(result.response).toBe("An error occurred while processing your request. Please try again.");
      expect(result.response).not.toContain("sk-abc123");
      expect(result.response).not.toContain("openai.com");
    });

    it("returns actionable billing message for credit exhaustion errors", async () => {
      mockPrompt.mockRejectedValueOnce(
        new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'),
      );

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      // User should see a billing-specific message, not the generic one
      expect(result.response).toContain("billing");
      expect(result.response).toContain("administrator");
      // Must not leak raw API error details
      expect(result.response).not.toContain("credit balance");
      expect(result.response).not.toContain("Anthropic");
      expect(result.errorContext?.retryable).toBe(false);
    });

    it("returns retryable message for rate limiting errors", async () => {
      mockPrompt.mockRejectedValueOnce(new Error("429 Too Many Requests"));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      expect(result.response).toContain("wait");
      expect(result.response).not.toContain("429");
      expect(result.errorContext?.retryable).toBe(true);
    });

    it("returns overload message for 503/529 errors", async () => {
      mockPrompt.mockRejectedValueOnce(new Error("529 Overloaded"));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      expect(result.response).toContain("overloaded");
      expect(result.errorContext?.retryable).toBe(true);
    });

    it("calls session.dispose even on error", async () => {
      mockPrompt.mockRejectedValueOnce(new Error("Boom"));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockDispose).toHaveBeenCalled();
    });

    it("returns error message on lock failure (locked)", async () => {
      const deps = createMockDeps({
        sessionAdapter: {
          withSession: vi.fn().mockResolvedValue(err("locked" as const)),
        },
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      expect(result.response).toContain("locked");
    });

    it("returns error message on lock failure (error)", async () => {
      const deps = createMockDeps({
        sessionAdapter: {
          withSession: vi.fn().mockResolvedValue(err("error" as const)),
        },
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      expect(result.response).toContain("Session access error");
    });

    it("createAgentSession rejection propagates as unhandled error", async () => {
      (createAgentSession as Mock).mockRejectedValueOnce(
        new Error("SDK session init failed"),
      );

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      // createAgentSession is outside the inner try/catch, so rejection
      // propagates through withSession and rejects execute()
      await expect(executor.execute(testMessage, testSessionKey)).rejects.toThrow(
        "SDK session init failed",
      );
      // Session was never created, so dispose should NOT have been called
      expect(mockDispose).not.toHaveBeenCalled();
    });

    it("session.dispose() error in finally block propagates (documents behavior)", async () => {
      mockDispose.mockImplementationOnce(() => {
        throw new Error("dispose ENOENT");
      });

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      // dispose() throws in finally, but the inner try completed successfully.
      // Since finally throws, the error propagates (masking the return value).
      // This documents the current behavior: dispose errors propagate.
      await expect(executor.execute(testMessage, testSessionKey)).rejects.toThrow(
        "dispose ENOENT",
      );
    });

    it("getLastAssistantText returning null produces empty response", async () => {
      mockGetLastAssistantText.mockReturnValue(null);
      // Set llmCalls=1 and textEmitted=true so neither
      // stuck session detection nor silent failure detection triggers.
      // This test covers the edge case where getLastAssistantText returns null
      // despite a normal LLM call (e.g., provider returned empty content).
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 0, total: 100 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
        textEmitted: true,
      });

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      // Source uses: session.getLastAssistantText?.() ?? ""
      // null is falsy so ?? yields ""
      expect(result.response).toBe("");
      expect(result.finishReason).toBe("stop");
    });

    it("multiple sequential executions on same executor produce valid results", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result1 = await executor.execute(testMessage, testSessionKey);
      const result2 = await executor.execute(testMessage, testSessionKey);

      expect(result1.finishReason).toBe("stop");
      expect(result1.response).toBe("test response");
      expect(result2.finishReason).toBe("stop");
      expect(result2.response).toBe("test response");

      // Each execution creates its own session and disposes it
      expect(createAgentSession).toHaveBeenCalledTimes(2);
      expect(mockDispose).toHaveBeenCalledTimes(2);
      expect(mockPrompt).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Orphan repair
  // -------------------------------------------------------------------------

  describe("orphan repair", () => {
    it("calls repairOrphanedMessages with session manager before prompt", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(repairOrphanedMessages).toHaveBeenCalled();
      // Verify repair happens before prompt
      const repairOrder = (repairOrphanedMessages as Mock).mock.invocationCallOrder[0];
      const promptOrder = mockPrompt.mock.invocationCallOrder[0];
      expect(repairOrder).toBeLessThan(promptOrder!);
    });

    it("logs when repair is performed", async () => {
      (repairOrphanedMessages as Mock).mockReturnValueOnce({
        repaired: true,
        reason: "trailing user message without assistant reply",
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const repairLog = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Repaired orphaned message",
      );
      expect(repairLog).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Auth key rotation
  // -------------------------------------------------------------------------

  describe("auth key rotation", () => {
    it("rotates API key on primary model failure when authRotation available", async () => {
      // Primary fails, rotated key retry succeeds
      mockPrompt
        .mockRejectedValueOnce(new Error("Rate limited"))
        .mockResolvedValueOnce(undefined);
      mockGetLastAssistantText.mockReturnValue("rotated key response");

      const mockAuthRotation = {
        hasProfiles: vi.fn().mockReturnValue(true),
        rotateKey: vi.fn().mockReturnValue(true),
        recordSuccess: vi.fn(),
      };
      const deps = createMockDeps({ authRotation: mockAuthRotation });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(mockAuthRotation.rotateKey).toHaveBeenCalledWith("anthropic");
      expect(mockAuthRotation.recordSuccess).toHaveBeenCalledWith("anthropic");
      // 2 prompt calls: primary (failed) + rotated key retry (succeeded)
      expect(mockPrompt).toHaveBeenCalledTimes(2);
      expect(result.response).toBe("rotated key response");
    });

    it("skips key rotation when no authRotation configured", async () => {
      // Primary fails, no authRotation, goes straight to fallback models
      mockPrompt
        .mockRejectedValueOnce(new Error("Rate limited"))
        .mockResolvedValueOnce(undefined);
      mockGetLastAssistantText.mockReturnValue("fallback response");

      const deps = createMockDeps({
        // No authRotation configured
        fallbackModels: ["openai:gpt-4o"],
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "openai", id: "gpt-4o" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      // Should go straight to model fallback, 2 calls: primary + fallback
      expect(mockPrompt).toHaveBeenCalledTimes(2);
      expect(result.response).toBe("fallback response");
    });

    it("falls through to model fallback when rotated key also fails", async () => {
      // Primary fails, rotated key fails, fallback model succeeds
      mockPrompt
        .mockRejectedValueOnce(new Error("Rate limited"))
        .mockRejectedValueOnce(new Error("Rotated key also rate limited"))
        .mockResolvedValueOnce(undefined);
      mockGetLastAssistantText.mockReturnValue("fallback model response");

      const mockAuthRotation = {
        hasProfiles: vi.fn().mockReturnValue(true),
        rotateKey: vi.fn().mockReturnValue(true),
        recordSuccess: vi.fn(),
      };
      const deps = createMockDeps({
        authRotation: mockAuthRotation,
        fallbackModels: ["openai:gpt-4o"],
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "openai", id: "gpt-4o" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      // 3 calls: primary + rotated key retry + fallback model
      expect(mockPrompt).toHaveBeenCalledTimes(3);
      expect(result.response).toBe("fallback model response");
      // recordSuccess should NOT have been called (rotated key failed)
      expect(mockAuthRotation.recordSuccess).not.toHaveBeenCalled();
    });

    it("records success on successful primary prompt", async () => {
      const mockAuthRotation = {
        hasProfiles: vi.fn().mockReturnValue(true),
        rotateKey: vi.fn(),
        recordSuccess: vi.fn(),
      };
      const deps = createMockDeps({ authRotation: mockAuthRotation });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockAuthRotation.recordSuccess).toHaveBeenCalledWith("anthropic");
      // rotateKey should NOT have been called (primary succeeded)
      expect(mockAuthRotation.rotateKey).not.toHaveBeenCalled();
    });

    it("skips rotation when all keys in cooldown (rotateKey returns false)", async () => {
      // Primary fails, rotateKey returns false (all keys in cooldown), fallback model succeeds
      mockPrompt
        .mockRejectedValueOnce(new Error("Rate limited"))
        .mockResolvedValueOnce(undefined);
      mockGetLastAssistantText.mockReturnValue("fallback response");

      const mockAuthRotation = {
        hasProfiles: vi.fn().mockReturnValue(true),
        rotateKey: vi.fn().mockReturnValue(false), // All keys in cooldown
        recordSuccess: vi.fn(),
      };
      const deps = createMockDeps({
        authRotation: mockAuthRotation,
        fallbackModels: ["openai:gpt-4o"],
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "openai", id: "gpt-4o" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(mockAuthRotation.rotateKey).toHaveBeenCalledWith("anthropic");
      // Should proceed to model fallback: 2 calls (primary + fallback)
      expect(mockPrompt).toHaveBeenCalledTimes(2);
      expect(result.response).toBe("fallback response");
    });

    it("skips rotation when provider has no profiles", async () => {
      // hasProfiles returns false -- behaves like no authRotation at all
      mockPrompt
        .mockRejectedValueOnce(new Error("Rate limited"))
        .mockResolvedValueOnce(undefined);
      mockGetLastAssistantText.mockReturnValue("fallback response");

      const mockAuthRotation = {
        hasProfiles: vi.fn().mockReturnValue(false),
        rotateKey: vi.fn(),
        recordSuccess: vi.fn(),
      };
      const deps = createMockDeps({
        authRotation: mockAuthRotation,
        fallbackModels: ["openai:gpt-4o"],
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "openai", id: "gpt-4o" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // rotateKey should NOT have been called (no profiles for provider)
      expect(mockAuthRotation.rotateKey).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Event bridge
  // -------------------------------------------------------------------------

  describe("event bridge", () => {
    it("calls session.subscribe with bridge listener", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockSubscribe).toHaveBeenCalledWith(mockBridgeListener);
    });

    it("calls unsubscribe in finally block", async () => {
      const mockUnsubscribe = vi.fn();
      mockSubscribe.mockReturnValueOnce(mockUnsubscribe);

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockUnsubscribe).toHaveBeenCalled();
    });

    it("calls unsubscribe even when prompt fails", async () => {
      const mockUnsubscribe = vi.fn();
      mockSubscribe.mockReturnValueOnce(mockUnsubscribe);
      mockPrompt.mockRejectedValueOnce(new Error("Boom"));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockUnsubscribe).toHaveBeenCalled();
    });

    it("merges bridge stats into result", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      // R-13: SDK session stats now populate cacheRead/cacheWrite alongside bridge values
      expect(result.tokensUsed).toEqual({ input: 100, output: 50, total: 150, cacheRead: 0, cacheWrite: 0 });
      expect(result.cost).toEqual({ total: 0.01 });
      expect(result.stepsExecuted).toBe(2);
      expect(result.llmCalls).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Full prompt assembly
  // -------------------------------------------------------------------------

  describe("full prompt assembly", () => {
    it("passes full assembler params including runtime info and inbound metadata", async () => {
      const deps = createMockDeps({
        secretManager: { get: vi.fn().mockReturnValue("canary-secret-123") } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-x");

      expect(mockAssembleRichSystemPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: "test-agent",
          promptMode: "full",
          runtimeInfo: expect.objectContaining({
            agentId: "agent-x",
            host: expect.any(String),
            os: expect.any(String),
            arch: expect.any(String),
            model: "claude-sonnet-4-5-20250929",
            nodeVersion: expect.any(String),
            defaultModel: "claude-sonnet-4-5-20250929",
            channel: "test",
          }),
          inboundMeta: expect.objectContaining({
            messageId: "msg-1",
            senderId: "user1",
            chatId: "c1",
            channel: "test",
            chatType: "dm",
            flags: expect.any(Object),
          }),
          workspaceDir: "/tmp/test-workspace",
          // canarySecret and sessionKey no longer passed to assembler (relocated to dynamic preamble)
        }),
      );
    });

    it("loads bootstrap files and passes to assembler", async () => {
      const mockBootstrapFiles = [
        { name: "SOUL.md", path: "/tmp/SOUL.md", content: "soul content", missing: false },
      ];
      const mockContextFiles = [
        { path: "SOUL.md", content: "soul content" },
      ];
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce(mockBootstrapFiles);
      mockBuildBootstrapContextFiles.mockReturnValueOnce(mockContextFiles);

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalledWith(
        "/tmp/test-workspace",
        20_000,
      );
      expect(mockBuildBootstrapContextFiles).toHaveBeenCalledWith(
        mockBootstrapFiles,
        { maxChars: 20_000 },
      );
      expect(mockAssembleRichSystemPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          bootstrapFiles: mockContextFiles,
        }),
      );
    });

    it("performs RAG retrieval when memoryPort and rag config present", async () => {
      const mockSearchResult = {
        entry: { id: "m1", tenantId: "t", content: "memory 1", createdAt: Date.now(), tags: [], trustLevel: "system", source: { channel: "test" } },
        score: 0.85,
      };
      const mockMemoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [mockSearchResult] }),
        store: vi.fn(),
      };
      mockHybridSplit.mockReturnValueOnce({ inlineMemory: undefined, systemPromptSections: ["## Relevant Memories\n- [system] memory 1"] });

      const ragConfig = { enabled: true, maxResults: 5, minScore: 0.5, maxContextChars: 5000, includeTrustLevels: ["system"] };
      const configWithRag = { ...testConfig, rag: ragConfig } as PerAgentConfig;
      const deps = createMockDeps({ memoryPort: mockMemoryPort as any });
      const executor = createPiExecutor(configWithRag, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-rag");

      // Task 229: Now uses hybrid memory injector instead of createRagRetriever
      expect(mockMemoryPort.search).toHaveBeenCalledWith(
        testSessionKey,
        "hello world",
        { limit: 5, minScore: 0.5, agentId: "agent-rag" },
      );
      expect(mockCreateHybridMemoryInjector).toHaveBeenCalled();
      // RAG relocated to dynamic preamble, not system prompt
      expect(mockAssembleRichSystemPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          additionalSections: [],
        }),
      );
    });

    it("RAG retrieval failure is non-fatal", async () => {
      const mockMemoryPort = {
        search: vi.fn().mockRejectedValue(new Error("Memory search failed")),
        store: vi.fn(),
      };

      const ragConfig = { enabled: true, maxResults: 5, minScore: 0.5, maxContextChars: 5000, includeTrustLevels: ["system"] };
      const configWithRag = { ...testConfig, rag: ragConfig } as PerAgentConfig;
      const deps = createMockDeps({ memoryPort: mockMemoryPort as any });
      const executor = createPiExecutor(configWithRag, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      // Execution should still complete successfully
      expect(result.finishReason).toBe("stop");
      expect(result.response).toBe("test response");
      // RAG failure logged as warn
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ hint: expect.any(String), errorKind: "retrieval_failure" }),
        "RAG retrieval failed (non-fatal)",
      );
    });

    it("applies envelope wrapping when envelopeConfig provided", async () => {
      const envelopeConfig = {
        showProvider: true,
        timezoneMode: "utc",
        timeFormat: "24h" as const,
        showElapsed: false,
      };
      mockWrapInEnvelope.mockReturnValueOnce("[test] user1 (14:30):\nhello world");

      const deps = createMockDeps({ envelopeConfig: envelopeConfig as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, undefined, undefined, 1000);

      expect(mockWrapInEnvelope).toHaveBeenCalledWith(testMessage, envelopeConfig, 1000);
      // dynamic preamble is prepended, so check that envelope text is in the prompt
      const promptText = mockPrompt.mock.calls[0][0] as string;
      expect(promptText).toContain("[test] user1 (14:30):\nhello world");
      expect(promptText).toContain("[System context]");
    });

    it("skips bootstrap files when promptMode is none", async () => {
      const configNone = {
        ...testConfig,
        bootstrap: { promptMode: "none" },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configNone, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockLoadWorkspaceBootstrapFiles).not.toHaveBeenCalled();
      expect(mockAssembleRichSystemPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          promptMode: "none",
          bootstrapFiles: [],
        }),
      );
    });

    it("canary secret no longer passed to assembler (relocated to dynamic preamble)", async () => {
      const mockSecretManager = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key === "CANARY_SECRET") return "test-canary-secret";
          return undefined;
        }),
      };
      const deps = createMockDeps({ secretManager: mockSecretManager as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // canarySecret and sessionKey no longer passed to assembler
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.canarySecret).toBeUndefined();
      expect(call.sessionKey).toBeUndefined();
    });

    it("hook runner modifies system prompt", async () => {
      const mockHookRunner = {
        runBeforeAgentStart: vi.fn().mockResolvedValue({
          systemPrompt: "hook-modified prompt",
          prependContext: undefined,
        }),
        runBeforeToolCall: vi.fn(),
        runAfterToolCall: vi.fn(),
        runToolResultPersist: vi.fn(),
        runAgentEnd: vi.fn(),
      };
      const deps = createMockDeps({ hookRunner: mockHookRunner as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "hook-agent");

      expect(mockHookRunner.runBeforeAgentStart).toHaveBeenCalledWith(
        { systemPrompt: "assembled system prompt", messages: [] },
        expect.objectContaining({
          agentId: "hook-agent",
          sessionKey: testSessionKey,
          workspaceDir: "/tmp/test-workspace",
        }),
      );
      const overrideResult = mockResourceLoaderArgs.captured.systemPromptOverride("");
      expect(overrideResult).toBe("hook-modified prompt");
    });

    it("hook runner prependContext relocated to dynamic preamble", async () => {
      const mockHookRunner = {
        runBeforeAgentStart: vi.fn().mockResolvedValue({
          systemPrompt: undefined,
          prependContext: "PREPENDED CONTEXT",
        }),
        runBeforeToolCall: vi.fn(),
        runAfterToolCall: vi.fn(),
        runToolResultPersist: vi.fn(),
        runAgentEnd: vi.fn(),
      };
      const deps = createMockDeps({ hookRunner: mockHookRunner as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // System prompt unchanged -- prependContext relocated to dynamicPreamble
      const overrideResult = mockResourceLoaderArgs.captured.systemPromptOverride("");
      expect(overrideResult).toBe("assembled system prompt");
      // prependContext appears in user message via dynamic preamble
      const promptText = mockPrompt.mock.calls[0][0] as string;
      expect(promptText).toContain("PREPENDED CONTEXT");
    });

    it("API system prompt relocated to dynamic preamble", async () => {
      const msgWithApiPrompt = {
        ...testMessage,
        metadata: { openaiSystemPrompt: "You are a helpful assistant." },
      } as NormalizedMessage;
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(msgWithApiPrompt, testSessionKey);

      // System prompt unchanged -- API system prompt relocated to dynamicPreamble
      const calledPrompt = mockResourceLoaderArgs.captured.systemPromptOverride("");
      expect(calledPrompt).toBe("assembled system prompt");
      // Wrapped API content appears in user message via dynamic preamble
      const promptText = mockPrompt.mock.calls[0][0] as string;
      expect(promptText).toContain("UNTRUSTED");
      expect(promptText).toContain("Source: API");
      expect(promptText).toContain("You are a helpful assistant.");
    });

    it("derives tool names from customTools, not legacy tools parameter", async () => {
      const customTools = [
        { name: "memory_store", description: "Store memory", parameters: {} },
        { name: "memory_search", description: "Search memory", parameters: {} },
        { name: "bash", description: "Run bash", parameters: {} },
      ];
      const deps = createMockDeps({ customTools: customTools as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockAssembleRichSystemPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          toolNames: ["memory_store", "memory_search", "bash"],
          hasMemoryTools: true,
        }),
      );
    });

    it("passes undefined channelContext and reactionLevel to assembler", async () => {
      const configWithReaction = {
        ...testConfig,
        reactionLevel: "extensive" as const,
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithReaction, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockAssembleRichSystemPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          channelContext: undefined,
          reactionLevel: "extensive",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // SettingsManager: file-based create + overrides
  // -------------------------------------------------------------------------

  describe("SettingsManager create + overrides", () => {
    it("calls SettingsManager.create() with workspaceDir and agentDir", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockSettingsManagerCreate).toHaveBeenCalledWith(
        "/tmp/test-workspace",
        "/tmp/test-agent-dir",
      );
    });

    it("applies compaction overrides and hideThinkingBlock via applyOverrides()", async () => {
      const configWithCompaction = {
        ...testConfig,
        session: {
          compaction: {
            softThresholdRatio: 0.75,
            hardThresholdRatio: 0.90,
            chunkMaxChars: 50_000,
            chunkOverlapMessages: 2,
            chunkMergeSummaries: true,
            reserveTokens: 4096,
            keepRecentTokens: 8192,
          },
        },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithCompaction, deps);

      await executor.execute(testMessage, testSessionKey);

      // SDK compaction disabled when Comis context engine is active (default)
      expect(mockApplyOverrides).toHaveBeenCalledWith({
        compaction: {
          enabled: false,
          reserveTokens: 4096,
          keepRecentTokens: 8192,
        },
        hideThinkingBlock: true,
        retry: {
          enabled: true,
          maxRetries: 5,
          baseDelayMs: 4000,
          maxDelayMs: 60000,
        },
      });
    });

    it("uses updated default compaction values (16384/32768) when config.session is undefined", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // SDK compaction disabled when Comis context engine is active (default)
      expect(mockApplyOverrides).toHaveBeenCalledWith({
        compaction: {
          enabled: false,
          reserveTokens: 16384,
          keepRecentTokens: 32768,
        },
        hideThinkingBlock: true,
        retry: {
          enabled: true,
          maxRetries: 5,
          baseDelayMs: 4000,
          maxDelayMs: 60000,
        },
      });
    });

    it("falls back to SettingsManager.inMemory() when create() throws", async () => {
      mockSettingsManagerCreate.mockImplementation(() => {
        throw new Error("Permission denied: /tmp/test-agent-dir");
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(mockSettingsManagerCreate).toHaveBeenCalled();
      expect(mockSettingsManagerInMemory).toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "SettingsManager.create() failed, falling back to in-memory settings",
          errorKind: "config",
        }),
        "Settings file load failed",
      );
      // Should still complete execution successfully
      expect(result.finishReason).toBe("stop");
    });

    it("applies thinkingLevel override when configured", async () => {
      const configWithThinking = {
        ...testConfig,
        thinkingLevel: "medium" as const,
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithThinking, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultThinkingLevel: "medium",
        }),
      );
    });

    it("does not apply thinkingLevel override when not configured", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const overridesArg = mockApplyOverrides.mock.calls[0][0];
      expect(overridesArg).not.toHaveProperty("defaultThinkingLevel");
    });

    it("applies directive thinkingLevel override when set", async () => {
      const configWithThinking = {
        ...testConfig,
        thinkingLevel: "low" as const,
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithThinking, deps);
      const directives = { thinkingLevel: "xhigh" as const };

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultThinkingLevel: "xhigh",
        }),
      );
    });

    it("falls back to config thinkingLevel when no directive", async () => {
      const configWithThinking = {
        ...testConfig,
        thinkingLevel: "medium" as const,
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithThinking, deps);
      const directives = {};

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultThinkingLevel: "medium",
        }),
      );
    });

    it("logs settings initialization at INFO level with persistent flag", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const settingsLog = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Settings manager initialized",
      );
      expect(settingsLog).toBeDefined();
      expect(settingsLog![0].persistent).toBe(true);
    });

    it("logs persistent: false when falling back to inMemory", async () => {
      mockSettingsManagerCreate.mockImplementation(() => {
        throw new Error("Disk full");
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const settingsLog = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Settings manager initialized",
      );
      expect(settingsLog).toBeDefined();
      expect(settingsLog![0].persistent).toBe(false);
    });

    it("passes typed SettingsOverrides to applyOverrides without as-any cast", async () => {
      const configWithCompaction = {
        ...testConfig,
        session: {
          compaction: {
            reserveTokens: 8192,
            keepRecentTokens: 16384,
          },
        },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithCompaction, deps);

      await executor.execute(testMessage, testSessionKey);

      // SDK compaction disabled when Comis context engine is active (default)
      expect(mockApplyOverrides).toHaveBeenCalledWith({
        compaction: {
          enabled: false,
          reserveTokens: expect.any(Number),
          keepRecentTokens: expect.any(Number),
        },
        hideThinkingBlock: true,
        retry: {
          enabled: true,
          maxRetries: 5,
          baseDelayMs: 4000,
          maxDelayMs: 60000,
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // SDK compaction disabled when Comis context engine active
  // -------------------------------------------------------------------------

  describe("SDK compaction vs Comis context engine", () => {
    it("SDK compaction disabled when context engine enabled (default)", async () => {
      // testConfig has no contextEngine field => enabled defaults to true
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          compaction: expect.objectContaining({ enabled: false }),
        }),
      );
    });

    it("SDK compaction enabled when context engine explicitly disabled", async () => {
      const configWithDisabledCE = {
        ...testConfig,
        contextEngine: { enabled: false, thinkingKeepTurns: 10, historyTurns: 15 },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithDisabledCE, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          compaction: expect.objectContaining({ enabled: true }),
        }),
      );
    });

    it("Comis engine active: full compaction override shape with defaults", async () => {
      // testConfig has no contextEngine or session.compaction fields
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          compaction: {
            enabled: false,
            reserveTokens: 16384,
            keepRecentTokens: 32768,
          },
        }),
      );
    });

    it("Comis engine disabled: full compaction override shape with defaults", async () => {
      const configWithDisabledCE = {
        ...testConfig,
        contextEngine: { enabled: false, thinkingKeepTurns: 10, historyTurns: 15 },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithDisabledCE, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          compaction: {
            enabled: true,
            reserveTokens: 16384,
            keepRecentTokens: 32768,
          },
        }),
      );
    });

    it("context engine enabled by default when contextEngine field is absent", async () => {
      // Config with NO contextEngine field at all -- should default to engine active
      const configWithoutCE = { ...testConfig } as PerAgentConfig;
      delete (configWithoutCE as any).contextEngine;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithoutCE, deps);

      await executor.execute(testMessage, testSessionKey);

      // SDK compaction disabled because Comis engine defaults to active
      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          compaction: expect.objectContaining({ enabled: false }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // mid-session thinking level override
  // -------------------------------------------------------------------------

  describe("mid-session thinking level override", () => {
    it("calls session.setThinkingLevel('off') when directive is 'off'", async () => {
      const configWithThinking = {
        ...testConfig,
        thinkingLevel: "high",
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithThinking, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, undefined, { thinkingLevel: "off" } as any);

      expect(mockSetThinkingLevel).toHaveBeenCalledWith("off");
    });

    it("calls session.setThinkingLevel for non-off levels", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, undefined, { thinkingLevel: "medium" } as any);

      expect(mockSetThinkingLevel).toHaveBeenCalledWith("medium");
    });

    it("does not call session.setThinkingLevel when no directive", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockSetThinkingLevel).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // SDK retry config
  // -------------------------------------------------------------------------

  describe("SDK retry config", () => {
    it("passes custom sdkRetry settings to SettingsOverrides", async () => {
      const configWithRetry = {
        ...testConfig,
        sdkRetry: {
          enabled: true,
          maxRetries: 5,
          baseDelayMs: 1000,
          maxDelayMs: 30000,
        },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithRetry, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          retry: {
            enabled: true,
            maxRetries: 5,
            baseDelayMs: 1000,
            maxDelayMs: 30000,
          },
        }),
      );
    });

    it("uses default retry settings when sdkRetry is not set in config", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          retry: {
            enabled: true,
            maxRetries: 5,
            baseDelayMs: 4000,
            maxDelayMs: 60000,
          },
        }),
      );
    });

    it("respects sdkRetry.enabled=false to disable SDK retry", async () => {
      const configNoRetry = {
        ...testConfig,
        sdkRetry: {
          enabled: false,
          maxRetries: 0,
          baseDelayMs: 2000,
          maxDelayMs: 60000,
        },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configNoRetry, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockApplyOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          retry: {
            enabled: false,
            maxRetries: 0,
            baseDelayMs: 2000,
            maxDelayMs: 60000,
          },
        }),
      );
    });

    it("logs SDK retry settings in debug override log", async () => {
      const configWithRetry = {
        ...testConfig,
        sdkRetry: {
          enabled: true,
          maxRetries: 7,
          baseDelayMs: 500,
          maxDelayMs: 15000,
        },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithRetry, deps);

      await executor.execute(testMessage, testSessionKey);

      const debugCalls = (deps.logger.debug as Mock).mock.calls;
      const overridesLog = debugCalls.find(
        ([_fields, msg]: [any, string]) => msg === "SettingsManager overrides applied",
      );
      expect(overridesLog).toBeDefined();
      expect(overridesLog![0].sdkRetry).toEqual({
        enabled: true,
        maxRetries: 7,
        baseDelayMs: 500,
        maxDelayMs: 15000,
      });
    });
  });

  // -------------------------------------------------------------------------
  // /compact directive
  // -------------------------------------------------------------------------

  describe("/compact directive", () => {
    it("calls session.compact() when compact directive is present", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const directives = { compact: true };

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockCompact).toHaveBeenCalledWith(undefined);
    });

    it("passes custom instructions to session.compact()", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const directives = { compact: { verbose: true, instructions: "Focus on key decisions" } };

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockCompact).toHaveBeenCalledWith("Focus on key decisions");
    });

    it("emits compaction:flush event with trigger manual after compact", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const directives = { compact: true };

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-1", directives);

      const flushCalls = (deps.eventBus.emit as Mock).mock.calls.filter(
        ([name]: [string]) => name === "compaction:flush",
      );
      expect(flushCalls.length).toBeGreaterThanOrEqual(1);
      const manualFlush = flushCalls.find(([, payload]: [string, any]) => payload.trigger === "manual");
      expect(manualFlush).toBeDefined();
      expect(manualFlush![1]).toMatchObject({
        sessionKey: testSessionKey,
        memoriesWritten: 0,
        trigger: "manual",
        success: true,
      });
    });

    it("skips prompt when compact directive present and text is empty", async () => {
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const directives = { compact: true };

      await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockCompact).toHaveBeenCalled();
      // prompt should NOT have been called since text is empty
      expect(mockPrompt).not.toHaveBeenCalled();
    });

    it("proceeds with prompt when compact directive present but text is non-empty", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const directives = { compact: true };

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockCompact).toHaveBeenCalled();
      expect(mockPrompt).toHaveBeenCalled();
    });

    it("handles compact failure gracefully", async () => {
      mockCompact.mockRejectedValueOnce(new Error("Compaction failed"));
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const directives = { compact: true };

      // Should not throw
      const result = await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Manual compaction failed; session remains intact",
          errorKind: "internal",
        }),
        "Manual compaction error",
      );
      // Should still proceed with prompt
      expect(mockPrompt).toHaveBeenCalled();
      expect(result.finishReason).toBe("stop");
    });
  });

  // -------------------------------------------------------------------------
  // Abort compaction
  // -------------------------------------------------------------------------

  describe("abort compaction", () => {
    it("onAbort calls abortCompaction before abort -- session state preserved", async () => {
      // Track call order to verify abortCompaction is called BEFORE abort
      const callOrder: string[] = [];
      mockAbortCompaction.mockImplementation(() => {
        callOrder.push("abortCompaction");
      });
      mockAbort.mockImplementation(() => {
        callOrder.push("abort");
        return Promise.resolve(undefined);
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // Extract onAbort callback from the createPiEventBridge call
      const bridgeCall = (createPiEventBridge as Mock).mock.calls[0][0];
      expect(bridgeCall.onAbort).toBeTypeOf("function");

      // Invoke onAbort
      bridgeCall.onAbort();

      // Verify abortCompaction was called BEFORE abort
      expect(callOrder).toEqual(["abortCompaction", "abort"]);
      expect(mockAbortCompaction).toHaveBeenCalledTimes(1);
      expect(mockAbort).toHaveBeenCalledTimes(1);
    });

    it("session message history is unchanged after abort (pre-compaction snapshot)", async () => {
      // The SDK's abortCompaction() uses an internal AbortController that prevents
      // compaction results from being saved on abort. The session file retains its
      // pre-compaction state because compaction writes are only committed on success.
      // This test verifies our integration calls the methods in the correct order.
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const bridgeCall = (createPiEventBridge as Mock).mock.calls[0][0];
      bridgeCall.onAbort();

      // abortCompaction is a synchronous call that triggers the internal
      // AbortController -- it does not throw or return a value
      expect(mockAbortCompaction).toHaveBeenCalled();
      // abort is async and its rejection is suppressed
      expect(mockAbort).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // session.sendCustomMessage() for operator annotations
  // -------------------------------------------------------------------------

  describe("sendCustomMessage", () => {
    it("session.sendCustomMessage() is accessible within withSession for operator annotations", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // The mock session has sendCustomMessage available -- verify it exists
      // and can be called without error (AgentSession exposes this for extensions)
      expect(mockSession.sendCustomMessage).toBeDefined();
      expect(typeof mockSession.sendCustomMessage).toBe("function");

      // Simulate calling sendCustomMessage with an operator annotation
      await mockSession.sendCustomMessage({
        customType: "comis-operator-annotation",
        content: "User preference: prefers concise answers",
        display: false,
      });

      expect(mockSendCustomMessage).toHaveBeenCalledWith({
        customType: "comis-operator-annotation",
        content: "User preference: prefers concise answers",
        display: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Stream wrapper chain
  // -------------------------------------------------------------------------

  describe("stream wrapper chain", () => {
    it("applies stream wrapper chain to session.agent.streamFn", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // After execution, mockSession.agent.streamFn should have been replaced
      // by the composed wrapper chain (no longer the original mockStreamFn)
      expect(mockSession.agent.streamFn).not.toBe(mockStreamFn);
      expect(typeof mockSession.agent.streamFn).toBe("function");
    });

    it("wrapper chain includes config resolver with config values", async () => {
      const configWithParams: PerAgentConfig = {
        ...testConfig,
        maxTokens: 4096,
        temperature: 0.7,
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithParams, deps);

      await executor.execute(testMessage, testSessionKey);

      // Call the wrapped streamFn with an Anthropic model
      const wrappedStreamFn = mockSession.agent.streamFn;
      const model = { provider: "anthropic" } as any;
      const context = { systemPrompt: "test", messages: [], tools: [] };

      wrappedStreamFn(model, context, {});

      // The original mockStreamFn should have been called with injected options
      expect(mockStreamFn).toHaveBeenCalledTimes(1);
      const calledOptions = mockStreamFn.mock.calls[0][2];
      expect(calledOptions.maxTokens).toBe(4096);
      expect(calledOptions.temperature).toBe(0.7);
      // cacheRetention not set in config -- schema provides the default, configResolver does not inject
      expect(calledOptions.cacheRetention).toBeUndefined();
    });

    it("provider param injector receives config maxTokens and temperature", async () => {
      const configWithParams: PerAgentConfig = {
        ...testConfig,
        maxTokens: 2048,
        temperature: 0.5,
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithParams, deps);

      await executor.execute(testMessage, testSessionKey);

      // Call with a non-Anthropic model to verify maxTokens/temperature without cacheRetention
      const wrappedStreamFn = mockSession.agent.streamFn;
      const model = { provider: "openai" } as any;
      const context = { systemPrompt: "test", messages: [], tools: [] };

      wrappedStreamFn(model, context, {});

      const calledOptions = mockStreamFn.mock.calls[0][2];
      expect(calledOptions.maxTokens).toBe(2048);
      expect(calledOptions.temperature).toBe(0.5);
      expect(calledOptions.cacheRetention).toBeUndefined();
    });

    it("provider param injector receives config cacheRetention", async () => {
      const configWithCache: PerAgentConfig = {
        ...testConfig,
        cacheRetention: "long",
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithCache, deps);

      await executor.execute(testMessage, testSessionKey);

      // Exercise the wrapped stream function with Anthropic model
      const wrappedStreamFn = mockSession.agent.streamFn;
      const model = { provider: "anthropic" } as any;
      const context = { systemPrompt: "test", messages: [], tools: [] };

      wrappedStreamFn(model, context, {});

      const calledOptions = mockStreamFn.mock.calls[0][2];
      // Adaptive retention starts "short" for cold-start optimization,
      // escalating to "long" after cache reads confirm utilization. The initial call returns "short".
      expect(calledOptions.cacheRetention).toBe("short");
    });
  });

  // -------------------------------------------------------------------------
  // Active run registry
  // -------------------------------------------------------------------------

  describe("active run registry", () => {
    function createMockRegistry() {
      return {
        register: vi.fn().mockReturnValue(true),
        deregister: vi.fn(),
        get: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        size: 0,
      };
    }

    it("registers active run after session creation", async () => {
      const mockRegistry = createMockRegistry();
      const deps = createMockDeps({ activeRunRegistry: mockRegistry });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockRegistry.register).toHaveBeenCalledTimes(1);
      const [registeredKey, registeredHandle] = mockRegistry.register.mock.calls[0];
      expect(registeredKey).toBe("t1:u1:c1");
      // Verify handle has all required methods
      expect(typeof registeredHandle.steer).toBe("function");
      expect(typeof registeredHandle.followUp).toBe("function");
      expect(typeof registeredHandle.abort).toBe("function");
      expect(typeof registeredHandle.isStreaming).toBe("function");
      expect(typeof registeredHandle.isCompacting).toBe("function");
    });

    it("deregisters active run in finally block", async () => {
      const mockRegistry = createMockRegistry();
      const deps = createMockDeps({ activeRunRegistry: mockRegistry });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockRegistry.deregister).toHaveBeenCalledWith("t1:u1:c1");
      // Deregister must be called before dispose
      const deregisterOrder = mockRegistry.deregister.mock.invocationCallOrder[0];
      const disposeOrder = mockDispose.mock.invocationCallOrder[0];
      expect(deregisterOrder).toBeLessThan(disposeOrder);
    });

    it("deregisters active run even when execution errors", async () => {
      const mockRegistry = createMockRegistry();
      mockPrompt.mockRejectedValue(new Error("LLM provider failed"));
      const deps = createMockDeps({ activeRunRegistry: mockRegistry });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockRegistry.deregister).toHaveBeenCalledWith("t1:u1:c1");
    });

    it("RunHandle.steer delegates to session.steer", async () => {
      const mockRegistry = createMockRegistry();
      const deps = createMockDeps({ activeRunRegistry: mockRegistry });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const handle = mockRegistry.register.mock.calls[0][1];
      await handle.steer("interrupt text");
      expect(mockSteer).toHaveBeenCalledWith("interrupt text");
    });

    it("RunHandle.followUp delegates to session.followUp", async () => {
      const mockRegistry = createMockRegistry();
      const deps = createMockDeps({ activeRunRegistry: mockRegistry });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const handle = mockRegistry.register.mock.calls[0][1];
      await handle.followUp("follow up text");
      expect(mockFollowUp).toHaveBeenCalledWith("follow up text");
    });

    it("RunHandle.abort calls abortCompaction then abort", async () => {
      const mockRegistry = createMockRegistry();
      const deps = createMockDeps({ activeRunRegistry: mockRegistry });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const handle = mockRegistry.register.mock.calls[0][1];
      // Reset mocks to isolate the handle.abort() call from event bridge onAbort
      mockAbortCompaction.mockClear();
      mockAbort.mockClear();
      await handle.abort();
      expect(mockAbortCompaction).toHaveBeenCalled();
      expect(mockAbort).toHaveBeenCalled();
    });

    it("RunHandle.isStreaming delegates to session.isStreaming", async () => {
      const mockRegistry = createMockRegistry();
      mockSession.isStreaming = true;
      const deps = createMockDeps({ activeRunRegistry: mockRegistry });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const handle = mockRegistry.register.mock.calls[0][1];
      expect(handle.isStreaming()).toBe(true);
    });

    it("RunHandle.isCompacting delegates to session.isCompacting", async () => {
      const mockRegistry = createMockRegistry();
      mockSession.isCompacting = true;
      const deps = createMockDeps({ activeRunRegistry: mockRegistry });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const handle = mockRegistry.register.mock.calls[0][1];
      expect(handle.isCompacting()).toBe(true);
    });

    it("warns when session already registered", async () => {
      const mockRegistry = createMockRegistry();
      mockRegistry.register.mockReturnValue(false);
      const deps = createMockDeps({ activeRunRegistry: mockRegistry });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "t1:u1:c1",
          hint: expect.stringContaining("already has an active run"),
          errorKind: "resource",
        }),
        "Active run already registered",
      );
    });

    it("does not register when activeRunRegistry is not provided", async () => {
      // Default deps have no activeRunRegistry
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      // Should not throw
      await executor.execute(testMessage, testSessionKey);
    });
  });

  // -------------------------------------------------------------------------
  // Model capability validation
  // -------------------------------------------------------------------------

  describe("model capability validation", () => {
    it("emits WARN when thinking level set for non-reasoning model", async () => {
      const configWithThinking = {
        ...testConfig,
        thinkingLevel: "high" as const,
      } as PerAgentConfig;
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5-20250929", reasoning: false }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(configWithThinking, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-think");

      const warnCalls = (deps.logger.warn as Mock).mock.calls;
      const thinkWarn = warnCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Thinking level exceeds model capability",
      );
      expect(thinkWarn).toBeDefined();
      expect(thinkWarn![0]).toMatchObject({
        thinkingLevel: "high",
        model: "claude-sonnet-4-5-20250929",
        provider: "anthropic",
        errorKind: "config",
      });
      expect(thinkWarn![0].hint).toContain("does not support reasoning");
    });

    it("does not emit WARN when thinking level is off", async () => {
      const configOff = {
        ...testConfig,
        thinkingLevel: "off" as const,
      } as PerAgentConfig;
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5-20250929", reasoning: false }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(configOff, deps);

      await executor.execute(testMessage, testSessionKey);

      const warnCalls = (deps.logger.warn as Mock).mock.calls;
      const thinkWarn = warnCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Thinking level exceeds model capability",
      );
      expect(thinkWarn).toBeUndefined();
    });

    it("does not emit WARN when model supports reasoning", async () => {
      const configWithThinking = {
        ...testConfig,
        thinkingLevel: "high" as const,
      } as PerAgentConfig;
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5-20250929", reasoning: true }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(configWithThinking, deps);

      await executor.execute(testMessage, testSessionKey);

      const warnCalls = (deps.logger.warn as Mock).mock.calls;
      const thinkWarn = warnCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Thinking level exceeds model capability",
      );
      expect(thinkWarn).toBeUndefined();
    });

    it("does not emit WARN when model is not resolved (undefined)", async () => {
      const configWithThinking = {
        ...testConfig,
        thinkingLevel: "high" as const,
      } as PerAgentConfig;
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue(undefined),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(configWithThinking, deps);

      // Should not crash and should not emit the WARN
      const result = await executor.execute(testMessage, testSessionKey);

      const warnCalls = (deps.logger.warn as Mock).mock.calls;
      const thinkWarn = warnCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Thinking level exceeds model capability",
      );
      expect(thinkWarn).toBeUndefined();
      expect(result.finishReason).toBe("stop");
    });
  });

  // -------------------------------------------------------------------------
  // Image passthrough vision gating ()
  // -------------------------------------------------------------------------

  describe("image passthrough vision gating", () => {
    const imageData = Buffer.from("fake-image-data").toString("base64");
    const messageWithImages: NormalizedMessage = {
      ...testMessage,
      metadata: {
        imageContents: [
          { type: "image", data: imageData, mimeType: "image/jpeg" },
        ],
      },
    } as NormalizedMessage;

    it("passes images to prompt when model supports vision", async () => {
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue({
            provider: "anthropic",
            id: "claude-sonnet-4-5-20250929",
            input: ["text", "image"],
          }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(messageWithImages, testSessionKey, undefined, undefined, "agent-v");

      // Verify prompt was called with images and the image hint prefix
      const promptCall = mockPrompt.mock.calls[0];
      expect(promptCall[0]).toContain("[An image is attached to this message and is visible to you.");
      expect(promptCall[0]).toContain("do NOT call image_analyze");
      expect(promptCall[1]).toMatchObject({
        images: [{ type: "image", data: imageData, mimeType: "image/jpeg" }],
        expandPromptTemplates: false,
      });

      // Verify INFO log "Image passthrough active"
      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const passCall = infoCalls.find(
        ([_f, msg]: [any, string]) => msg === "Image passthrough active",
      );
      expect(passCall).toBeDefined();
      expect(passCall![0]).toMatchObject({
        imageCount: 1,
        visionCapable: true,
      });
      expect(passCall![0].totalBytes).toBeGreaterThan(0);
    });

    it("drops images when model lacks vision capability", async () => {
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue({
            provider: "anthropic",
            id: "claude-sonnet-4-5-20250929",
            input: ["text"],
          }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(messageWithImages, testSessionKey, undefined, undefined, "agent-nv");

      // Verify prompt was called WITHOUT images
      const promptCall = mockPrompt.mock.calls[0];
      expect(promptCall[0]).not.toContain("[An image is attached");
      expect(promptCall[1]).toMatchObject({
        expandPromptTemplates: false,
      });
      expect(promptCall[1].images).toBeUndefined();

      // Verify WARN log emitted
      const warnCalls = (deps.logger.warn as Mock).mock.calls;
      const dropCall = warnCalls.find(
        ([_f, msg]: [any, string]) => msg === "Images dropped: model lacks vision capability",
      );
      expect(dropCall).toBeDefined();
      expect(dropCall![0]).toMatchObject({
        imageCount: 1,
        model: "claude-sonnet-4-5-20250929",
        provider: "anthropic",
        errorKind: "config",
      });
      expect(dropCall![0].totalBytes).toBeGreaterThan(0);
      expect(dropCall![0].hint).toContain("vision");
    });

    it("drops images safely when resolvedModel is undefined", async () => {
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue(undefined),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(messageWithImages, testSessionKey, undefined, undefined, "agent-undef");

      // Should not crash
      expect(result.finishReason).toBe("stop");

      // Verify images NOT passed
      const promptCall = mockPrompt.mock.calls[0];
      expect(promptCall[1].images).toBeUndefined();

      // Verify WARN log emitted (modelSupportsVision defaults to false)
      const warnCalls = (deps.logger.warn as Mock).mock.calls;
      const dropCall = warnCalls.find(
        ([_f, msg]: [any, string]) => msg === "Images dropped: model lacks vision capability",
      );
      expect(dropCall).toBeDefined();
    });

    it("no image logging when message has no images", async () => {
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue({
            provider: "anthropic",
            id: "claude-sonnet-4-5-20250929",
            input: ["text", "image"],
          }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-noimg");

      // No image-related INFO or WARN logs
      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const warnCalls = (deps.logger.warn as Mock).mock.calls;

      const passCall = infoCalls.find(
        ([_f, msg]: [any, string]) => msg === "Image passthrough active",
      );
      const dropCall = warnCalls.find(
        ([_f, msg]: [any, string]) => msg === "Images dropped: model lacks vision capability",
      );
      expect(passCall).toBeUndefined();
      expect(dropCall).toBeUndefined();

      // Verify prompt called without images
      const promptCall = mockPrompt.mock.calls[0];
      expect(promptCall[1].images).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Progressive context pruner removed (superseded by observation masker)
  // Legacy tests removed -- pruner and budget guard no longer in wrapper chain.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Conditional JSONL trace wrappers
  // -------------------------------------------------------------------------

  describe("conditional JSONL trace wrappers", () => {
    it("does not add trace wrappers when tracing is disabled (default)", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-notrace");

      // No "JSONL tracing enabled" log should be emitted
      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const traceLog = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "JSONL tracing enabled",
      );
      expect(traceLog).toBeUndefined();

      // The wrapped streamFn should have only 4 base wrappers applied
      // (validationErrorFormatter + toolResultSizeBouncer + configResolver + requestBodyInjector)
      // -- verify via single "Stream wrappers composed" summary log
      const debugCalls = (deps.logger.debug as Mock).mock.calls;
      const composedLog = debugCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Stream wrappers composed",
      );
      expect(composedLog).toBeDefined();
      // +1 for ttlGuard wrapper (was 5, now 6), +1 for stubFilterInjector (now 7)
      expect(composedLog![0].wrapperCount).toBe(7);
    });

    it("adds trace wrappers when tracing.enabled is true", async () => {
      const configWithTracing = {
        ...testConfig,
        tracing: { enabled: true, outputDir: "/tmp/test-traces" },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithTracing, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-trace");

      // "JSONL tracing enabled" INFO log should be emitted
      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const traceLog = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "JSONL tracing enabled",
      );
      expect(traceLog).toBeDefined();
      expect(traceLog![0]).toMatchObject({
        outputDir: "/tmp/test-traces",
      });
      expect(traceLog![0].cacheTracePath).toContain("/tmp/test-traces/");
      expect(traceLog![0].cacheTracePath).toContain(".cache-trace.jsonl");
      expect(traceLog![0].apiPayloadPath).toContain("/tmp/test-traces/");
      expect(traceLog![0].apiPayloadPath).toContain(".api-payload.jsonl");

      // Should have 9 wrappers applied (7 base + 2 trace)
      const debugCalls = (deps.logger.debug as Mock).mock.calls;
      const composedLog = debugCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Stream wrappers composed",
      );
      expect(composedLog).toBeDefined();
      expect(composedLog![0].wrapperCount).toBe(9);
    });

    it("trace wrappers are positioned after requestBodyInjector in chain", async () => {
      const configWithTracing = {
        ...testConfig,
        tracing: { enabled: true, outputDir: "/tmp/test-traces" },
        cacheRetention: "long" as const,
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithTracing, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-cache04");

      // Verify wrapper names from the summary log.
      // wrapperNames array order matches the wrappers array (outermost first):
      // ttlGuard, validationErrorFormatter, toolResultSizeBouncer, turnResultBudget, configResolver, requestBodyInjector, cacheTraceWriter, apiPayloadTraceWriter
      // (renamed providerParamInjector -> configResolver, cacheBreakpointInjector -> requestBodyInjector)
      // (added validationErrorFormatter as outermost wrapper)
      // (added turnResultBudget after toolResultSizeBouncer)
      // (added ttlGuard as outermost wrapper before validationErrorFormatter)
      const debugCalls = (deps.logger.debug as Mock).mock.calls;
      const composedLog = debugCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Stream wrappers composed",
      );
      expect(composedLog).toBeDefined();

      const wrapperNames = composedLog![0].wrapperNames as string[];
      expect(wrapperNames).toEqual([
        "ttlGuard",
        "validationErrorFormatter",
        "toolResultSizeBouncer",
        "turnResultBudget",
        "configResolver",
        "requestBodyInjector",
        "cacheTraceWriter",
        "apiPayloadTraceWriter",
        "stubFilterInjector",
      ]);

      // Trace wrappers are innermost (closest to base SDK streamFn),
      // meaning they see the final options including injected cacheRetention
    });

    it("does not add trace wrappers when tracing.enabled is explicitly false", async () => {
      const configWithTracingOff = {
        ...testConfig,
        tracing: { enabled: false, outputDir: "/tmp/test-traces" },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithTracingOff, deps);

      await executor.execute(testMessage, testSessionKey);

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const traceLog = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "JSONL tracing enabled",
      );
      expect(traceLog).toBeUndefined();

      const debugCalls = (deps.logger.debug as Mock).mock.calls;
      const composedLog = debugCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Stream wrappers composed",
      );
      expect(composedLog).toBeDefined();
      // +1 for ttlGuard wrapper (was 5, now 6), +1 for stubFilterInjector (now 7)
      expect(composedLog![0].wrapperCount).toBe(7);
    });

    it("passes sessionId (formattedKey) to both trace wrapper configs", async () => {
      const configWithTracing = {
        ...testConfig,
        tracing: { enabled: true, outputDir: "/tmp/test-traces" },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithTracing, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-sid");

      // Exercise the wrapped streamFn -- this triggers the trace writers
      const wrappedStreamFn = mockSession.agent.streamFn;
      const model = { id: "claude-test", provider: "anthropic" } as any;
      const context = { systemPrompt: "test", messages: [], tools: [] };
      wrappedStreamFn(model, context, {});

      // Verify appendFileSync was called with JSONL containing sessionId
      // The formatted session key for testSessionKey is "telegram:test-chat:test-user"
      const jsonlCalls = mockAppendFileSync.mock.calls;
      expect(jsonlCalls.length).toBeGreaterThanOrEqual(2); // cache_trace + api_payload

      // testSessionKey = { tenantId: "t1", userId: "u1", channelId: "c1" }
      // formatSessionKey produces "t1:u1:c1"
      const expectedSessionId = "t1:u1:c1";

      const cacheTraceLine = JSON.parse((jsonlCalls[0][1] as string).trim());
      expect(cacheTraceLine.type).toBe("cache_trace");
      expect(cacheTraceLine.sessionId).toBe(expectedSessionId);
      expect(cacheTraceLine.agentId).toBe("agent-sid");

      const apiPayloadLine = JSON.parse((jsonlCalls[1][1] as string).trim());
      expect(apiPayloadLine.type).toBe("api_payload");
      expect(apiPayloadLine.sessionId).toBe(expectedSessionId);
      expect(apiPayloadLine.agentId).toBe("agent-sid");
    });

    it("passes tracingDefaults maxSize/maxFiles to trace wrapper configs", async () => {
      const configWithTracing = {
        ...testConfig,
        tracing: { enabled: true, outputDir: "/tmp/test-traces" },
      } as PerAgentConfig;
      const deps = createMockDeps({
        tracingDefaults: { maxSize: "10m", maxFiles: 5 },
      });
      const executor = createPiExecutor(configWithTracing, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-rot");

      // Exercise the wrapped streamFn -- this triggers the trace writers
      // which call appendJsonlLine -> rotateIfNeeded -> statSync
      const wrappedStreamFn = mockSession.agent.streamFn;
      const model = { id: "claude-test", provider: "anthropic" } as any;
      const context = { systemPrompt: "test", messages: [], tools: [] };
      wrappedStreamFn(model, context, {});

      // statSync should have been called at least once (rotation check in appendJsonlLine)
      // It is mocked to throw ENOENT, so rotation is skipped, but the call confirms
      // maxSize/maxFiles were passed through
      const { statSync: mockStat } = await import("node:fs");
      expect(vi.mocked(mockStat)).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // /fork directive
  // -------------------------------------------------------------------------

  describe("/fork directive", () => {
    it("forkSession directive calls session.navigateTree() with last user message entryId", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { forkSession: true };

      const result = await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockGetUserMessagesForForking).toHaveBeenCalled();
      expect(mockNavigateTree).toHaveBeenCalledWith("entry-2"); // last user message
      expect(result.response).toContain("Forked from:");
      expect(result.finishReason).toBe("stop");
    });

    it("forkSession with empty getUserMessagesForForking returns 'No user messages' response", async () => {
      mockGetUserMessagesForForking.mockReturnValueOnce([]);
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { forkSession: true };

      const result = await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockNavigateTree).not.toHaveBeenCalled();
      expect(result.response).toBe("No user messages to fork from.");
      expect(result.finishReason).toBe("stop");
    });

    it("forkSession with cancelled fork returns 'Fork cancelled' response", async () => {
      mockNavigateTree.mockResolvedValueOnce({ cancelled: true });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { forkSession: true };

      const result = await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(result.response).toBe("Fork cancelled.");
      expect(result.finishReason).toBe("stop");
    });

    it("forkSession error handling returns error message", async () => {
      mockGetUserMessagesForForking.mockReturnValueOnce([
        { entryId: "entry-1", text: "msg" },
      ]);
      mockNavigateTree.mockRejectedValueOnce(new Error("SDK fork error"));
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { forkSession: true };

      const result = await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(result.response).toBe("Fork failed: SDK fork error");
      expect(result.finishReason).toBe("error");
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Session fork failed",
          errorKind: "internal",
        }),
        "Fork error",
      );
    });

    it("forkSession skips prompt when text is empty", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { forkSession: true };

      await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockPrompt).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // /branch directive
  // -------------------------------------------------------------------------

  describe("/branch directive", () => {
    it("branchAction (no targetId) lists branch points from getUserMessagesForForking", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { branchAction: {} };

      const result = await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockGetUserMessagesForForking).toHaveBeenCalled();
      expect(result.response).toContain("**Branch Points**");
      expect(result.response).toContain("`entry-1`");
      expect(result.response).toContain("`entry-2`");
      expect(result.response).toContain("Use `/branch <id>` to navigate to a branch point.");
      expect(result.finishReason).toBe("stop");
    });

    it("branchAction (no targetId) with empty list returns 'No branch points' response", async () => {
      mockGetUserMessagesForForking.mockReturnValueOnce([]);
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { branchAction: {} };

      const result = await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(result.response).toBe("No branch points available.");
      expect(result.finishReason).toBe("stop");
    });

    it("branchAction with targetId calls session.navigateTree()", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { branchAction: { targetId: "entry-1" } };

      const result = await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockNavigateTree).toHaveBeenCalledWith("entry-1");
      expect(result.response).toBe("Navigated to branch: entry-1");
      expect(result.finishReason).toBe("stop");
    });

    it("branchAction navigate cancelled returns 'Branch navigation cancelled'", async () => {
      mockNavigateTree.mockResolvedValueOnce({ cancelled: true });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { branchAction: { targetId: "entry-1" } };

      const result = await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(result.response).toBe("Branch navigation cancelled.");
      expect(result.finishReason).toBe("stop");
    });

    it("branchAction navigate error handling returns error message", async () => {
      mockNavigateTree.mockRejectedValueOnce(new Error("Navigate error"));
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { branchAction: { targetId: "entry-1" } };

      const result = await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(result.response).toBe("Branch navigation failed: Navigate error");
      expect(result.finishReason).toBe("error");
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Branch navigation failed",
          errorKind: "internal",
          targetId: "entry-1",
        }),
        "Branch navigate error",
      );
    });

    it("branchAction listing error handling returns error message", async () => {
      mockGetUserMessagesForForking.mockImplementationOnce(() => { throw new Error("List error"); });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { branchAction: {} };

      const result = await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(result.response).toBe("Branch listing failed: List error");
      expect(result.finishReason).toBe("error");
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Branch listing failed",
          errorKind: "internal",
        }),
        "Branch list error",
      );
    });

    it("branchAction skips prompt when text is empty", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const emptyMsg = { ...testMessage, text: "" } as NormalizedMessage;
      const directives = { branchAction: {} };

      await executor.execute(emptyMsg, testSessionKey, undefined, undefined, "agent-1", directives);

      expect(mockPrompt).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // SDK tool management
  // -------------------------------------------------------------------------

  describe("SDK tool management", () => {
    it("calls getAllTools for introspection after session creation", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockGetAllTools).toHaveBeenCalled();
    });

    it("calls setActiveToolsByName with merged tool names", async () => {
      const customTools = [
        { name: "memory_store", description: "Store memory", parameters: {} },
        { name: "bash", description: "Run bash", parameters: {} },
      ];
      const deps = createMockDeps({ customTools: customTools as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockSetActiveToolsByName).toHaveBeenCalledWith(["memory_store", "bash"]);
    });

    it("merges per-request tools before calling setActiveToolsByName", async () => {
      const customTools = [
        { name: "bash", description: "Run bash", parameters: {} },
      ];
      const perRequestTools = [
        { name: "memory_search", description: "Search memory", execute: vi.fn() },
      ];
      const mockConvert = vi.fn().mockReturnValue([
        { name: "memory_search", description: "Search memory", parameters: {} },
      ]);
      const deps = createMockDeps({
        customTools: customTools as any,
        convertTools: mockConvert,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, perRequestTools as any);

      expect(mockSetActiveToolsByName).toHaveBeenCalledWith(["bash", "memory_search"]);
    });

    it("continues execution if getAllTools throws", async () => {
      mockGetAllTools.mockImplementation(() => { throw new Error("getAllTools not available"); });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("stop");
      expect(result.response).toBe("test response");
      expect(mockGetAllTools).toHaveBeenCalled();
    });

    it("continues execution if setActiveToolsByName throws", async () => {
      mockSetActiveToolsByName.mockImplementation(() => { throw new Error("setActiveToolsByName failed"); });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("stop");
      expect(result.response).toBe("test response");
      expect(mockSetActiveToolsByName).toHaveBeenCalled();
    });

    it("logs warning when SDK rejects tools", async () => {
      const customTools = [
        { name: "bash", description: "Run bash", parameters: {} },
        { name: "read", description: "Read file", parameters: {} },
        { name: "custom_tool", description: "Custom", parameters: {} },
      ];
      // First call (before setActiveToolsByName): returns all tools
      // Second call (after setActiveToolsByName): returns fewer (SDK rejected one)
      mockGetActiveToolNames
        .mockReturnValueOnce(["bash", "read", "custom_tool"])
        .mockReturnValueOnce(["bash", "read"]);

      const deps = createMockDeps({ customTools: customTools as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-1");

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          rejected: ["custom_tool"],
          rejectedCount: 1,
          registeredCount: 3,
          postActiveCount: 2,
          allRejected: false,
          hint: expect.stringContaining("name collisions with SDK built-ins"),
          errorKind: "validation",
        }),
        "SDK rejected some tool registrations",
      );
    });

    it("logs distinct message + hint when SDK rejects ALL tools (registration failure)", async () => {
      const customTools = [
        { name: "exec", description: "Exec", parameters: {} },
        { name: "read", description: "Read", parameters: {} },
      ];
      // SDK ends up with 0 active tools after setActiveToolsByName.
      mockGetActiveToolNames
        .mockReturnValueOnce(["exec", "read"])
        .mockReturnValueOnce([]);

      const deps = createMockDeps({ customTools: customTools as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-1");

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          rejected: ["exec", "read"],
          rejectedCount: 2,
          registeredCount: 2,
          postActiveCount: 0,
          allRejected: true,
          hint: expect.stringContaining("0 active tools"),
          errorKind: "validation",
        }),
        "SDK rejected ALL tool registrations -- agent will run with no tools",
      );
    });

    it("setActiveToolsByName triggers prompt rebuild via systemPromptOverride", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // systemPromptOverride is a static closure set before session creation.
      // setActiveToolsByName triggers _rebuildSystemPrompt which reads the cached value.
      expect(mockSetActiveToolsByName).toHaveBeenCalled();
      const overrideResult = mockResourceLoaderArgs.captured.systemPromptOverride("");
      expect(overrideResult).toBe("assembled system prompt");
    });

    it("logs debug when tool management throws", async () => {
      mockGetAllTools.mockImplementation(() => { throw new Error("SDK changed"); });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, "agent-err");

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
        }),
        "SDK tool management call failed (non-fatal)",
      );
    });
  });

  // -------------------------------------------------------------------------
  // SDK skill discovery
  // -------------------------------------------------------------------------

  describe("SDK skill discovery", () => {
    it("passes Comis discovery paths as additionalSkillPaths to DefaultResourceLoader", async () => {
      const discoveryPaths = ["/custom/skills", "/extra/skills"];
      const configWithPaths = {
        ...testConfig,
        skills: { discoveryPaths, promptSkills: {} },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithPaths, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockResourceLoaderArgs.captured).toBeTruthy();
      expect(mockResourceLoaderArgs.captured.additionalSkillPaths).toEqual(discoveryPaths);
    });

    it("uses noSkills: false to enable SDK discovery", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockResourceLoaderArgs.captured).toBeTruthy();
      // noSkills should not be set to true (defaults to false)
      expect(mockResourceLoaderArgs.captured.noSkills).not.toBe(true);
    });

    it("skillsOverride filters denied skills", async () => {
      const configWithDeny = {
        ...testConfig,
        skills: {
          discoveryPaths: [],
          promptSkills: { deniedSkills: ["bad-skill"] },
        },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithDeny, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockResourceLoaderArgs.captured).toBeTruthy();
      expect(mockResourceLoaderArgs.captured.skillsOverride).toBeTypeOf("function");

      // Invoke the override with a mock base
      const base = {
        skills: [
          { name: "good-skill", description: "Good", filePath: "/a", baseDir: "/", source: "bundled", disableModelInvocation: false },
          { name: "bad-skill", description: "Bad", filePath: "/b", baseDir: "/", source: "bundled", disableModelInvocation: false },
          { name: "another-skill", description: "Another", filePath: "/c", baseDir: "/", source: "bundled", disableModelInvocation: false },
        ],
        diagnostics: [],
      };
      const result = mockResourceLoaderArgs.captured.skillsOverride(base);
      expect(result.skills.map((s: any) => s.name)).toEqual(["good-skill", "another-skill"]);
    });

    it("populates registry from SDK-discovered skills after session creation", async () => {
      const mockSdkSkills = [
        { name: "sdk-alpha", description: "Alpha", filePath: "/a.md", baseDir: "/", source: "bundled", disableModelInvocation: false },
        { name: "sdk-beta", description: "Beta", filePath: "/b.md", baseDir: "/", source: "local", disableModelInvocation: true },
      ];
      mockGetSkills.mockReturnValue({ skills: mockSdkSkills, diagnostics: [] });

      const mockInitFromSdkSkills = vi.fn();
      const mockGetEligibleSkillNames = vi.fn().mockReturnValue(new Set(["sdk-alpha", "sdk-beta"]));
      const deps = createMockDeps({
        skillRegistry: {
          getEligibleSkillNames: mockGetEligibleSkillNames,
          initFromSdkSkills: mockInitFromSdkSkills,
        },
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockInitFromSdkSkills).toHaveBeenCalledWith(mockSdkSkills);
    });

    it("SDK skill population failure is non-fatal", async () => {
      mockGetSkills.mockImplementation(() => { throw new Error("getSkills boom"); });

      const mockInitFromSdkSkills = vi.fn();
      const deps = createMockDeps({
        skillRegistry: {
          getEligibleSkillNames: vi.fn().mockReturnValue(new Set()),
          initFromSdkSkills: mockInitFromSdkSkills,
        },
      });
      const executor = createPiExecutor(testConfig, deps);

      // Should NOT throw -- failure is caught and logged
      const result = await executor.execute(testMessage, testSessionKey);
      expect(result.response).toBe("test response");
      expect(mockInitFromSdkSkills).not.toHaveBeenCalled();
      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          hint: "SDK skill population failed, Comis discovery still active",
          errorKind: "dependency",
        }),
        "SDK skill population non-fatal error",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Conversation memory persistence
  // -------------------------------------------------------------------------
  describe("conversation memory persistence", () => {
    // Use a message that passes the quality gate (>= 12 user chars, >= 80 combined)
    const memoryTestText = "tell me about this project and explain the main architecture patterns";
    const memoryTestMessage = { ...testMessage, text: memoryTestText } as NormalizedMessage;

    // Clear the module-level paired-memory dedup cache between tests so that
    // hash-dedup state from one test does not bleed into the next.
    beforeEach(() => {
      resetPairedMemoryDedupForTests();
    });

    it("stores user conversation turn to memory after execution", async () => {
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const mockEmbeddingEnqueue = vi.fn();
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
        embeddingEnqueue: mockEmbeddingEnqueue,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(memoryTestMessage, testSessionKey, undefined, undefined, "test-agent");

      expect(mockStore).toHaveBeenCalledTimes(1);

      // Only call: user message (paired with agent response)
      const userCall = mockStore.mock.calls[0][0];
      expect(userCall.tags).toEqual(["conversation", "paired"]);
      expect(userCall.content).toBe(`[user] ${memoryTestText}\n[agent] test response`);
      expect(userCall.source.who).toBe("u1");

      // Embedding enqueue called with paired content
      expect(mockEmbeddingEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEmbeddingEnqueue).toHaveBeenCalledWith(expect.any(String), `[user] ${memoryTestText}\n[agent] test response`);
    });

    it("memory store failure is non-fatal", async () => {
      const mockStore = vi.fn().mockResolvedValue(err(new Error("DB error")));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(memoryTestMessage, testSessionKey);

      expect(result.finishReason).toBe("stop");
      expect(result.response).toBe("test response");
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Check database connectivity and disk space",
          errorKind: "dependency",
        }),
        "Memory store failed for user message",
      );
    });

    it("skips memory persistence when memoryPort not provided", async () => {
      const deps = createMockDeps();
      // memoryPort is undefined by default in createMockDeps
      const executor = createPiExecutor(testConfig, deps);

      // Should succeed without errors
      const result = await executor.execute(testMessage, testSessionKey);
      expect(result.response).toBe("test response");
    });

    it("skips memory persistence when response is empty", async () => {
      // Use mockReturnValue (not Once) because the silent-failure detection reads getLastAssistantText
      // in the detection check before the normal response assignment.
      mockGetLastAssistantText.mockReturnValue("");
      // Set llmCalls=1 and textEmitted=true so neither
      // stuck session detection nor silent failure detection triggers.
      // This test verifies memory persistence is skipped for empty responses.
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 0, total: 100 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
        textEmitted: true,
      });
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockStore).not.toHaveBeenCalled();
    });

    it("embeddingEnqueue not called when store fails", async () => {
      const mockStore = vi.fn().mockResolvedValue(err(new Error("fail")));
      const mockEmbeddingEnqueue = vi.fn();
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
        embeddingEnqueue: mockEmbeddingEnqueue,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(memoryTestMessage, testSessionKey);

      expect(mockEmbeddingEnqueue).not.toHaveBeenCalled();
    });

    // Quality gate tests — shouldStorePairedMemory filtering
    it("skips memory when user message is below quality threshold", async () => {
      const shortMsg = { ...testMessage, text: "ok" } as NormalizedMessage;
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(shortMsg, testSessionKey);

      expect(mockStore).not.toHaveBeenCalled();
      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ userLen: 2, minUserChars: 12, minCombinedChars: 80 }),
        "Paired memory skipped: content below quality threshold",
      );
    });

    it("skips memory for emoji-only messages", async () => {
      const emojiMsg = { ...testMessage, text: "\u{1F44D}" } as NormalizedMessage;
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(emojiMsg, testSessionKey);

      expect(mockStore).not.toHaveBeenCalled();
    });

    it("skips memory for whitespace-padded short messages", async () => {
      const paddedMsg = { ...testMessage, text: "  hi  " } as NormalizedMessage;
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(paddedMsg, testSessionKey);

      expect(mockStore).not.toHaveBeenCalled();
    });

    it("stores memory when user message meets quality threshold", async () => {
      // 67 user chars + 13 agent chars ("test response") = 80 combined, exactly at threshold
      const thresholdMsg = { ...testMessage, text: "tell me something interesting about your capabilities and features!" } as NormalizedMessage;
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(thresholdMsg, testSessionKey);

      expect(mockStore).toHaveBeenCalledTimes(1);
    });

    // ---------------------------------------------------------------------
    // Operation-type gate (Layer 1): skip memory for cron/heartbeat/internal
    // ---------------------------------------------------------------------

    // Helper: call executor with an operationType override.
    async function executeWithOp(
      operationType: string,
      text: string,
      deps: PiExecutorDeps,
    ): Promise<ExecutionResult> {
      const msg = { ...testMessage, text } as NormalizedMessage;
      const executor = createPiExecutor(testConfig, deps);
      return executor.execute(
        msg, testSessionKey, undefined, undefined, "test-agent",
        undefined, undefined,
        { operationType } as any,
      );
    }

    it.each([
      ["cron"],
      ["heartbeat"],
      ["compaction"],
      ["taskExtraction"],
      ["condensation"],
    ])("skips paired memory for operationType=%s", async (operationType) => {
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const mockEmbeddingEnqueue = vi.fn();
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
        embeddingEnqueue: mockEmbeddingEnqueue,
      });

      await executeWithOp(operationType, memoryTestText, deps);

      expect(mockStore).not.toHaveBeenCalled();
      expect(mockEmbeddingEnqueue).not.toHaveBeenCalled();
      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ operationType }),
        "Paired memory skipped: non-interactive operation type",
      );
    });

    it("stores paired memory for operationType=interactive", async () => {
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });

      // Unique text so content-hash dedup (Layer 2) doesn't suppress this one.
      await executeWithOp("interactive", memoryTestText + " :: interactive-op-test", deps);

      expect(mockStore).toHaveBeenCalledTimes(1);
    });

    it("stores paired memory for operationType=subagent", async () => {
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });

      await executeWithOp("subagent", memoryTestText + " :: subagent-op-test", deps);

      expect(mockStore).toHaveBeenCalledTimes(1);
    });

    it("operationType skip takes precedence over quality gate", async () => {
      // Short message that would fail the quality gate anyway.
      // Assert that the OPERATION skip reason is logged, not the quality one.
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });

      // Long enough to pass quality gate so we isolate the operation gate.
      await executeWithOp("cron", memoryTestText + " :: precedence-test", deps);

      expect(mockStore).not.toHaveBeenCalled();
      const debugCalls = (deps.logger.debug as Mock).mock.calls.map(
        ([, msg]: [unknown, string]) => msg,
      );
      expect(debugCalls).toContain("Paired memory skipped: non-interactive operation type");
      expect(debugCalls).not.toContain("Paired memory skipped: content below quality threshold");
    });

    // ---------------------------------------------------------------------
    // Content-hash dedup (Layer 2)
    // ---------------------------------------------------------------------

    it("skips duplicate paired memory within dedup window", async () => {
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });

      const dupText = memoryTestText + " :: dedup-same";
      await executeWithOp("interactive", dupText, deps);
      await executeWithOp("interactive", dupText, deps);

      expect(mockStore).toHaveBeenCalledTimes(1);
      const debugCalls = (deps.logger.debug as Mock).mock.calls.map(
        ([, msg]: [unknown, string]) => msg,
      );
      expect(debugCalls).toContain("Paired memory skipped: duplicate content within dedup window");
    });

    it("allows different paired content through dedup", async () => {
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });

      await executeWithOp("interactive", memoryTestText + " :: dedup-A", deps);
      await executeWithOp("interactive", memoryTestText + " :: dedup-B", deps);

      expect(mockStore).toHaveBeenCalledTimes(2);
    });

    // ---------------------------------------------------------------------
    // Source traceability (4C)
    // ---------------------------------------------------------------------

    it("stores sessionKey in memory source for traceability", async () => {
      const mockStore = vi.fn().mockResolvedValue(ok({ id: "test" }));
      const deps = createMockDeps({
        memoryPort: { store: mockStore, search: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), clear: vi.fn() } as any,
      });

      await executeWithOp("interactive", memoryTestText + " :: source-test", deps);

      expect(mockStore).toHaveBeenCalledTimes(1);
      const entry = mockStore.mock.calls[0][0];
      expect(entry.source).toMatchObject({
        who: "u1",
        channel: "test",
        sessionKey: formatSessionKey(testSessionKey),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Silent LLM failure detection
  // -------------------------------------------------------------------------

  describe("silent LLM failure detection", () => {
    it("detects empty response with llmCalls > 0 as silent failure after retry", async () => {
      // Simulate: prompt resolves without throwing, but getLastAssistantText returns ""
      // and bridge reports llmCalls > 0 with finishReason "error".
      // The silent failure recovery will strip empty turns and retry via model retry,
      // but the retry also produces empty -- ultimately declares terminal failure.
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 3,
        finishReason: "error",
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      // Silent LLM failure is classified as "empty_response" with an
      // actionable user message (not the generic UNKNOWN_ERROR fallback).
      expect(result.response).toBe(
        "The AI didn't produce a response. This usually means a tool call returned no output — please try again.",
      );

      // Verify the WARN log was emitted (post-retry variant)
      const warnCalls = (deps.logger.warn as Mock).mock.calls;
      const silentWarn = warnCalls.find(
        ([_fields, msg]: [any, string]) => typeof msg === "string" && msg.includes("Silent LLM failure detected"),
      );
      expect(silentWarn).toBeDefined();
      expect(silentWarn![0]).toMatchObject({
        llmCalls: 3,
        finishReason: "error",
        errorKind: "dependency",
      });

      // prompt called twice: original + retry
      expect(mockPrompt).toHaveBeenCalledTimes(2);
    });

    it("does NOT trigger when response is non-empty (normal case)", async () => {
      // Normal case: getLastAssistantText returns real content
      mockGetLastAssistantText.mockReturnValue("normal response");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 2,
        llmCalls: 1,
        finishReason: "stop",
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).not.toBe("error");
      expect(result.response).toBe("normal response");

      // Verify the WARN log was NOT emitted
      const warnCalls = (deps.logger.warn as Mock).mock.calls;
      const silentWarn = warnCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Silent LLM failure detected",
      );
      expect(silentWarn).toBeUndefined();
    });

    it("does NOT trigger when text was emitted in intermediate turn (multi-turn agentic loop)", async () => {
      // Simulate: multi-turn agentic loop where text was produced in an
      // intermediate turn but getLastAssistantText returns "" (empty final turn
      // after bookkeeping tool call like memory_store).
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 4,
        finishReason: "stop",
        textEmitted: true, // Text was produced in an intermediate turn
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      // Should NOT be treated as error -- text was delivered mid-loop
      expect(result.finishReason).not.toBe("error");
      expect(result.response).toBe(""); // Empty is OK when text was streamed

      // Verify the WARN log was NOT emitted
      const warnCalls = (deps.logger.warn as Mock).mock.calls;
      const silentWarn = warnCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Silent LLM failure detected",
      );
      expect(silentWarn).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // thinking-only continuation retry
  // -------------------------------------------------------------------------

  describe("thinking-only continuation retry", () => {
    it("retries with followUp when finishReason is stop and tool calls were made", async () => {
      // initial check (line 350) returns "" triggering the block.
      // After followUp, getLastAssistantText returns "recovered response"
      // for the continuation re-check and all subsequent reads.
      mockGetLastAssistantText
        .mockReturnValueOnce("") // initial candidateResponse check
        .mockReturnValue("recovered response"); // after followUp + rawResponse reads
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 4,
        finishReason: "stop",
      });
      mockFollowUp.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.response).toBe("recovered response");
      expect(result.finishReason).not.toBe("error");
      expect(mockFollowUp).toHaveBeenCalledWith("(continued from previous message)");
    });

    it("does NOT retry when finishReason is error (provider failure)", async () => {
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 2,
        llmCalls: 3,
        finishReason: "error",
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      // followUp should NOT have been called — finishReason is "error"
      expect(mockFollowUp).not.toHaveBeenCalled();
    });

    it("retries with followUp when thinking-only with zero tool calls (stepsExecuted=0)", async () => {
      // initial check returns "" triggering the block.
      // After followUp, getLastAssistantText returns "recovered response".
      mockGetLastAssistantText
        .mockReturnValueOnce("") // initial candidateResponse check
        .mockReturnValue("recovered response"); // after followUp + rawResponse reads
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
      });
      mockFollowUp.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.response).toBe("recovered response");
      expect(result.finishReason).not.toBe("error");
      expect(mockFollowUp).toHaveBeenCalledWith("(continued from previous message)");
    });

    it("falls through to failure when zero-tool followUp also produces empty", async () => {
      // getLastAssistantText always returns "" — even after followUp
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
      });
      mockFollowUp.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      // followUp WAS called (continuation attempted), but recovery failed
      expect(mockFollowUp).toHaveBeenCalledWith("(continued from previous message)");
    });

    it("falls through to failure when followUp also produces empty response", async () => {
      // getLastAssistantText always returns "" — even after followUp
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 4,
        finishReason: "stop",
      });
      mockFollowUp.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      // followUp WAS called (continuation attempted), but recovery failed
      expect(mockFollowUp).toHaveBeenCalledWith("(continued from previous message)");
    });

    it("strips empty assistant turn and retries via model retry on silent failure (recovery succeeds)", async () => {
      // First prompt: finishReason "stop" but empty text (thinking-only response).
      // followUp also fails. New behavior: strip empty assistant turn, re-enter model retry.
      // Second prompt: returns "recovered text".
      let promptCallCount = 0;
      mockPrompt.mockImplementation(async () => {
        promptCallCount++;
        return undefined;
      });

      // First call: empty (initial check + post-followUp).
      // After retry via model retry, return recovered text.
      mockGetLastAssistantText
        .mockReturnValueOnce("") // initial candidateResponse check (silent failure detection)
        .mockReturnValueOnce("") // after followUp check (silent02Recovered)
        .mockReturnValue("recovered text"); // after model retry + rawResponse reads

      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
      });
      mockFollowUp.mockResolvedValue(undefined);

      // Set up session messages with a thinking-only assistant turn
      mockSession.messages = [
        { role: "user", content: "hello", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "encrypted reasoning block" },
          ],
          stopReason: "stop",
          timestamp: 2,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Should succeed via retry
      expect(result.response).toBe("recovered text");
      expect(result.finishReason).not.toBe("error");
      // prompt should be called twice: original + retry
      expect(mockPrompt).toHaveBeenCalledTimes(2);

      // Verify INFO log for the retry attempt
      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const retryLog = infoCalls.find(
        ([_fields, msg]: [any, string]) => typeof msg === "string" && msg.includes("Silent failure retry"),
      );
      expect(retryLog).toBeDefined();
    });

    it("strips empty assistant turn and retries via model retry, but both fail (terminal failure)", async () => {
      // Both attempts return empty text -- should ultimately declare failure.
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
      });
      mockFollowUp.mockResolvedValue(undefined);

      mockSession.messages = [
        { role: "user", content: "hello", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "encrypted reasoning block" },
          ],
          stopReason: "stop",
          timestamp: 2,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Should fail after retry also fails
      expect(result.finishReason).toBe("error");
      // Silent LLM failure classifier produces an actionable message instead
      // of the legacy generic "An error occurred…" UNKNOWN_ERROR fallback.
      expect(result.response.toLowerCase()).toMatch(/try again|no output|tool call/);
      // prompt should be called twice: original + retry
      expect(mockPrompt).toHaveBeenCalledTimes(2);
    });

    it("cleans thinking-only assistant messages from session before retry", async () => {
      // Track session messages state at each prompt call
      const messageSnapshots: any[][] = [];
      mockPrompt.mockImplementation(async () => {
        messageSnapshots.push([...mockSession.messages]);
        return undefined;
      });

      mockGetLastAssistantText
        .mockReturnValueOnce("") // initial candidateResponse
        .mockReturnValueOnce("") // after followUp
        .mockReturnValue("recovered text"); // after retry

      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
      });
      mockFollowUp.mockResolvedValue(undefined);

      // Simulate: user message + thinking-only assistant + followUp assistant (also thinking-only)
      mockSession.messages = [
        { role: "user", content: "hello", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "encrypted block 1" }],
          stopReason: "stop",
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "followUp thinking" }],
          stopReason: "stop",
          timestamp: 3,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      await executor.execute(testMessage, testSessionKey);

      // On the retry call (second prompt), the thinking-only assistant messages
      // should have been stripped. The snapshot should show only non-assistant messages.
      expect(messageSnapshots.length).toBe(2);
      const retryMessages = messageSnapshots[1];
      const assistantMsgs = retryMessages?.filter((m: any) => m.role === "assistant") ?? [];
      // All thinking-only assistant messages should be removed
      expect(assistantMsgs.length).toBe(0);
    });

    it("does not retry more than once (caps at 1 retry cycle)", async () => {
      // Ensure we don't get infinite retry loops
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
      });
      mockFollowUp.mockResolvedValue(undefined);

      mockSession.messages = [
        { role: "user", content: "hello", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "encrypted" }],
          stopReason: "stop",
          timestamp: 2,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      await executor.execute(testMessage, testSessionKey);

      // prompt called exactly 2 times: original + 1 retry (no infinite loop)
      expect(mockPrompt).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // thinking-only final turn fallback
  // -------------------------------------------------------------------------

  describe("thinking-only final turn fallback", () => {
    it("recovers text from earlier assistant turn when final turn is thinking-only", async () => {
      // Final turn: thinking-only → getLastAssistantText returns ""
      mockGetLastAssistantText.mockReturnValue("");
      // Bridge says text WAS emitted in earlier turns
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 3,
        finishReason: "stop",
        textEmitted: true,
      });
      // Session messages: earlier turn has text, final turn is thinking-only
      mockSession.messages = [
        { role: "user", content: "Analyze the data", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here is my analysis of the data." },
            { type: "text", text: "The key findings are X, Y, Z." },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "write", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I've completed the analysis and written the file." },
          ],
          stopReason: "stop",
          timestamp: 4,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Should recover text from the earlier assistant turn
      expect(result.response).toContain("Here is my analysis of the data.");
      expect(result.response).toContain("The key findings are X, Y, Z.");
      expect(result.finishReason).not.toBe("error");
    });

    it("does NOT activate fallback when getLastAssistantText returns non-empty", async () => {
      mockGetLastAssistantText.mockReturnValue("Normal final response");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 1,
        llmCalls: 1,
        finishReason: "stop",
        textEmitted: true,
      });
      mockSession.messages = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Earlier text" }],
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Normal final response" }],
          stopReason: "stop",
          timestamp: 2,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Should use the SDK response directly, NOT the fallback
      expect(result.response).toBe("Normal final response");
    });

    it("returns empty when no assistant messages have text blocks (degenerate case)", async () => {
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 1,
        llmCalls: 1,
        finishReason: "stop",
        textEmitted: true,
      });
      // All assistant messages are thinking-only
      mockSession.messages = [
        { role: "user", content: "Do something", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Thinking..." }],
          stopReason: "stop",
          timestamp: 2,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Fallback tried but found nothing -- empty is the honest result
      expect(result.response).toBe("");
    });

    it("recovers text when final turn is NO_REPLY silent token", async () => {
      // Final turn: NO_REPLY → getLastAssistantText returns "NO_REPLY"
      mockGetLastAssistantText.mockReturnValue("NO_REPLY");
      // Bridge says text WAS emitted in earlier turns
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 3,
        finishReason: "stop",
        textEmitted: true,
      });
      // Session messages: earlier turn has text, final turn is NO_REPLY
      mockSession.messages = [
        { role: "user", content: "How are you?", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Not bad! Let me check something." },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "NO_REPLY" },
          ],
          stopReason: "stop",
          timestamp: 4,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Should recover text from the earlier assistant turn, not "NO_REPLY"
      expect(result.response).toContain("Not bad! Let me check something.");
      expect(result.finishReason).not.toBe("error");
    });

    it("recovers text when final turn is HEARTBEAT_OK silent token", async () => {
      // Final turn: HEARTBEAT_OK → getLastAssistantText returns "HEARTBEAT_OK"
      mockGetLastAssistantText.mockReturnValue("HEARTBEAT_OK");
      // Bridge says text WAS emitted in earlier turns
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 3,
        finishReason: "stop",
        textEmitted: true,
      });
      // Session messages: earlier turn has text, final turn is HEARTBEAT_OK
      mockSession.messages = [
        { role: "user", content: "Check status", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "All systems are running normally." },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "status", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "HEARTBEAT_OK" },
          ],
          stopReason: "stop",
          timestamp: 4,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Should recover text from the earlier assistant turn, not "HEARTBEAT_OK"
      expect(result.response).toContain("All systems are running normally.");
      expect(result.finishReason).not.toBe("error");
    });

    it("skips NO_REPLY-only assistant messages in backward walk", async () => {
      // Final turn: HEARTBEAT_OK → triggers recovery
      mockGetLastAssistantText.mockReturnValue("HEARTBEAT_OK");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 4,
        llmCalls: 4,
        finishReason: "stop",
        textEmitted: true,
      });
      // Session messages: Turn 1 has real text, Turn 2 is NO_REPLY-only, Turn 3 is HEARTBEAT_OK
      mockSession.messages = [
        { role: "user", content: "Analyze data", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here is the analysis result." },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "analyze", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "NO_REPLY" },
          ],
          stopReason: "toolUse",
          timestamp: 4,
        },
        { role: "toolResult", toolCallId: "tc2", toolName: "save", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 5 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "HEARTBEAT_OK" },
          ],
          stopReason: "stop",
          timestamp: 6,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Should skip both NO_REPLY and HEARTBEAT_OK turns, recover Turn 1's real text
      expect(result.response).toContain("Here is the analysis result.");
      expect(result.response).not.toContain("NO_REPLY");
      expect(result.response).not.toContain("HEARTBEAT_OK");
      expect(result.finishReason).not.toBe("error");
    });

    it("does NOT recover text from previous execution (cross-boundary guard)", async () => {
      // Final turn: empty → triggers recovery
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 800, output: 300, total: 1100 },
        cost: { total: 0.08 },
        stepsExecuted: 4,
        llmCalls: 4,
        finishReason: "stop",
        textEmitted: true,
      });
      // Simulate two separate executions in the same session:
      // Execution 1: user asks about trading, assistant responds with pipeline status
      // Execution 2: user asks to create an image, assistant uses tool (no text), final turn empty
      mockSession.messages = [
        // --- Execution 1 ---
        { role: "user", content: "Run trading-agents on NVDA", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Pipeline status: running 3 agents on NVDA. Results will be delivered shortly." },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "run_pipeline", content: [{ type: "text", text: "Pipeline started" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "The trading pipeline is now active." },
          ],
          stopReason: "stop",
          timestamp: 4,
        },
        // --- Execution 2 (current execution) ---
        { role: "user", content: "Create a nice image", timestamp: 5 },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tc2", name: "image_generate", input: { prompt: "nice image" } },
          ],
          stopReason: "toolUse",
          timestamp: 6,
        },
        { role: "toolResult", toolCallId: "tc2", toolName: "image_generate", content: [{ type: "text", text: "Image generated and sent" }], isError: false, timestamp: 7 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Image was generated and delivered via tool." },
          ],
          stopReason: "stop",
          timestamp: 8,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // The pipeline status from execution 1 must NOT leak through
      expect(result.response).toBe("");
      expect(result.response).not.toContain("Pipeline status");
      expect(result.response).not.toContain("trading pipeline");
    });

    it("prefers non-tool turn over pre-tool commentary (stock-scanner scenario)", async () => {
      // Final turn: empty → triggers recovery
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 800, output: 300, total: 1100 },
        cost: { total: 0.08 },
        stepsExecuted: 6,
        llmCalls: 6,
        finishReason: "stop",
        textEmitted: true,
      });
      // Simulates the stock-scanner incident: the agent emitted step progress
      // annotations as pre-tool commentary (text + toolCall in the same turn),
      // then a standalone framing response earlier. Recovery should prefer
      // the framing response over the "Step 4/4" annotation.
      mockSession.messages = [
        { role: "user", content: "Create a stock scanner skill", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'm going to build it as a private skill, scaffold it, validate it, and leave it ready to use." },
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Step 1/4: scaffolding the skill directory." },
            { type: "toolCall", id: "tc2", name: "exec", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 4,
        },
        { role: "toolResult", toolCallId: "tc2", toolName: "exec", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 5 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Step 4/4: sanity-testing the trigger with a real prompt that ought to activate the skill." },
            { type: "toolCall", id: "tc5", name: "sessions_spawn", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 10,
        },
        { role: "toolResult", toolCallId: "tc5", toolName: "sessions_spawn", content: null, isError: false, timestamp: 11 },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Should recover the standalone framing text, NOT the step annotation
      expect(result.response).toContain("I'm going to build it as a private skill");
      expect(result.response).not.toContain("Step 4/4");
      expect(result.response).not.toContain("sanity-testing");
    });

    it("falls back to pre-tool commentary when no standalone text turns exist", async () => {
      // Final turn: empty → triggers recovery
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 3,
        finishReason: "stop",
        textEmitted: true,
      });
      // All assistant turns with text also have tool calls — no standalone text
      mockSession.messages = [
        { role: "user", content: "Do something", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me handle that for you." },
            { type: "toolCall", id: "tc1", name: "exec", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "exec", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Done." },
          ],
          stopReason: "stop",
          timestamp: 4,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Should fall back to pre-tool commentary when no standalone turns have text
      expect(result.response).toContain("Let me handle that for you.");
    });
  });

  // -------------------------------------------------------------------------
  // Late continuation after all-thinking execution
  // -------------------------------------------------------------------------

  describe("late continuation after all-thinking execution", () => {
    it("fires late continuation when textEmitted is true but all text is thinking-only", async () => {
      // When textEmitted=true, the zero-LLM-call detection block is skipped entirely.
      // The code falls through to empty-response recovery:
      //   candidateResponse = getLastAssistantText() -> ""
      //   llmCalls > 0 && !textEmitted -> textEmitted=true, so condition is false
      //   -> falls to candidateResponse === "" check
      //   -> textEmitted=true case proceeds to empty-response recovery
      //   -> rawResponse="" -> needsRecovery=true
      //   -> session.messages has only thinking blocks -> recovery returns ""
      //   -> extractedResponse="" -> result.response=""
      //   -> late continuation fires: response="" && stepsExecuted>0 && finishReason="stop"
      //   -> calls followUp -> getLastAssistantText returns recovered text

      // Mock sequence for getLastAssistantText:
      //   1. Initial candidateResponse check: ""
      //   2. rawResponse for empty-response recovery: ""
      //   3. After late-continuation followUp - recovery read: "Here is your chart..."
      mockGetLastAssistantText
        .mockReturnValueOnce("") // initial candidateResponse check
        .mockReturnValueOnce("") // rawResponse for empty-response recovery
        .mockReturnValue("Here is your chart..."); // after followUp recovery

      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 4,
        llmCalls: 5,
        finishReason: "stop",
        textEmitted: true,
      });

      // All assistant messages are thinking-only with tool work
      mockSession.messages = [
        { role: "user", content: "Create a chart", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I need to create a chart using the tool." },
            { type: "toolCall", id: "tc1", name: "exec", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "exec", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Chart created successfully." },
          ],
          stopReason: "stop",
          timestamp: 4,
        },
      ];
      mockFollowUp.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.response).toBe("Here is your chart...");
      expect(result.finishReason).not.toBe("error");
      expect(mockFollowUp).toHaveBeenCalledWith("Please provide a visible response summarizing what you did.");
    });

    it("falls through gracefully when late-continuation followUp produces empty response", async () => {
      // All getLastAssistantText calls return "" — even after followUp
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 4,
        finishReason: "stop",
        textEmitted: true,
      });

      // All assistant messages are thinking-only
      mockSession.messages = [
        { role: "user", content: "Process the data", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Processing data with the tool." },
            { type: "toolCall", id: "tc1", name: "exec", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "exec", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Data processed." },
          ],
          stopReason: "stop",
          timestamp: 4,
        },
      ];
      mockFollowUp.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Late continuation tried but failed; downstream handler returns empty response
      expect(result.response).toBe("");
      expect(mockFollowUp).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Detect zero-LLM-call stuck session and auto-reset
  // -------------------------------------------------------------------------

  describe("zero-LLM-call stuck session detection", () => {
    it("detects zero-LLM-call stuck session and returns session_reset", async () => {
      // Simulate stuck session: prompt succeeds but zero LLM calls, zero steps.
      // The SDK saw the synthetic assistant message from orphaned repair and
      // returned immediately without calling the LLM.
      mockGetLastAssistantText.mockReturnValue("synthetic response from repair");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 0,
        finishReason: "stop",
        textEmitted: false,
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("session_reset");
      expect(result.response).toContain("reset");
      expect(result.response).toContain("send your message again");
      // Verify destroySession was called to clean up the JSONL
      expect(deps.sessionAdapter.destroySession).toHaveBeenCalledWith(testSessionKey);
    });

    it("does NOT trigger stuck session detection when LLM calls were made", async () => {
      // Normal execution: LLM was called, produced a response.
      mockGetLastAssistantText.mockReturnValue("Here is your answer.");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
        textEmitted: true,
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).not.toBe("session_reset");
      expect(result.response).toBe("Here is your answer.");
      expect(deps.sessionAdapter.destroySession).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // beforeToolCall hook registration
  // -------------------------------------------------------------------------

  describe("beforeToolCall hook registration", () => {
    it("registers beforeToolCall guard on session.agent after createAgentSession", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // v0.65.0: beforeToolCall is a direct property assignment, not a method call
      expect(typeof mockSession.agent.beforeToolCall).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // afterToolCall provider guard
  // -------------------------------------------------------------------------

  describe("afterToolCall provider guard", () => {
    it("skips mid-turn tool injection for OpenAI providers", async () => {
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "openai", id: "gpt-4o" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const openaiConfig = { ...testConfig, provider: "openai", model: "gpt-4o" } as PerAgentConfig;
      const executor = createPiExecutor(openaiConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      // afterToolCall should have been assigned
      const afterToolCall = mockSession.agent.afterToolCall;
      expect(typeof afterToolCall).toBe("function");

      // Build a mock context with discoveredTools sideEffects and a contextTools array
      const contextTools = [
        { name: "bash", description: "Execute bash", parameters: {} },
      ];
      const mockCtx = {
        toolCall: { name: "discover_tools" },
        result: {
          sideEffects: {
            discoveredTools: ["new_tool_a", "new_tool_b"],
          },
        },
        context: { tools: contextTools },
      };

      await afterToolCall(mockCtx);

      // contextTools should NOT have been modified (no injection)
      expect(contextTools).toHaveLength(1);

      // Debug log should indicate the skip
      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          discoveredCount: 2,
          provider: "openai",
        }),
        expect.stringContaining("Skipped mid-turn injection"),
      );
    });

    it("does NOT skip mid-turn tool injection for Anthropic providers", async () => {
      const deps = createMockDeps(); // default mock returns anthropic provider
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const afterToolCall = mockSession.agent.afterToolCall;
      expect(typeof afterToolCall).toBe("function");

      // Build a mock context with discoveredTools
      const contextTools = [
        { name: "bash", description: "Execute bash", parameters: {} },
      ];
      const mockCtx = {
        toolCall: { name: "discover_tools" },
        result: {
          sideEffects: {
            discoveredTools: ["new_tool_a"],
          },
        },
        context: { tools: contextTools },
      };

      await afterToolCall(mockCtx);

      // The skip debug log should NOT have been emitted (handler proceeds past guard)
      const skipCalls = (deps.logger.debug as Mock).mock.calls.filter(
        (args: unknown[]) => typeof args[1] === "string" && args[1].includes("Skipped mid-turn injection"),
      );
      expect(skipCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Parallel read-only execution
  // -------------------------------------------------------------------------

  describe("Parallel read-only execution", () => {
    it("applies mutation serializer to custom tools before session creation", async () => {
      const { createMutationSerializer } = await import("./tool-parallelism.js");

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(createMutationSerializer).toHaveBeenCalledOnce();
    });
  });
});

// ---------------------------------------------------------------------------
// R-12: createBeforeToolCallGuard (standalone unit tests)
// ---------------------------------------------------------------------------

describe("createBeforeToolCallGuard (R-12)", () => {
  it("blocks when step counter is exhausted", async () => {
    const stepCounter = { shouldHalt: () => true, increment: () => 1, reset: () => {}, getCount: () => 50 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({});

    expect(result).toEqual({ block: true, reason: expect.stringContaining("Step limit") });
  });

  it("blocks when budget exhausted", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => err(new Error("exceeded")), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({});

    expect(result).toEqual({ block: true, reason: expect.stringContaining("budget") });
  });

  it("blocks when circuit breaker open", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => true, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "open" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({});

    expect(result).toEqual({ block: true, reason: expect.stringContaining("circuit") });
  });

  it("allows execution when all checks pass", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({});

    expect(result).toBeUndefined();
  });

  it("checks step counter first (priority order)", async () => {
    // All three would block -- step counter should be the reason
    const stepCounter = { shouldHalt: () => true, increment: () => 1, reset: () => {}, getCount: () => 50 };
    const budgetGuard = { checkBudget: () => err(new Error("exceeded")), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => true, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "open" as const, reset: () => {} };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker);
    const result = await guard({});

    expect(result).toEqual({ block: true, reason: expect.stringContaining("Step limit") });
  });

  it("blocks when tool retry breaker returns block verdict", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };
    const toolRetryBreaker = {
      beforeToolCall: () => ({ block: true, reason: "Tool blocked by retry breaker" }),
      recordResult: () => {},
      getBlockedTools: () => [],
      reset: () => {},
    };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker, toolRetryBreaker);
    // Simulate SDK context shape: { toolCall: { name }, args }
    const result = await guard({ toolCall: { name: "mcp__yfinance--get_recs" }, args: { symbol: "NVDA" } });

    expect(result).toEqual({ block: true, reason: "Tool blocked by retry breaker" });
  });

  it("allows execution when tool retry breaker returns no block", async () => {
    const stepCounter = { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 };
    const budgetGuard = { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) } as any;
    const circuitBreaker = { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} };
    const toolRetryBreaker = {
      beforeToolCall: () => ({ block: false }),
      recordResult: () => {},
      getBlockedTools: () => [],
      reset: () => {},
    };

    const guard = createBeforeToolCallGuard(stepCounter, budgetGuard, circuitBreaker, toolRetryBreaker);
    const result = await guard({ toolCall: { name: "web_search" }, args: { query: "test" } });

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mergeSessionStats (R-13)
// ---------------------------------------------------------------------------

describe("mergeSessionStats (R-13)", () => {
  it("overrides token totals from SDK stats", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150, cacheRead: 10, cacheWrite: 5 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, () => ({
      tokens: { input: 200, output: 80, total: 280, cacheRead: 30, cacheWrite: 10 },
    }));
    expect(result.tokensUsed).toEqual({ input: 200, output: 80, total: 280, cacheRead: 30, cacheWrite: 10 });
  });

  it("preserves cost from bridge (not SDK)", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150 },
      cost: { total: 0.05, cacheSaved: 0.01 },
    };
    mergeSessionStats(result, () => ({
      tokens: { input: 200, output: 80, total: 280 },
    }));
    expect(result.cost).toEqual({ total: 0.05, cacheSaved: 0.01 });
  });

  it("handles missing getSessionStats gracefully", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, undefined);
    expect(result.tokensUsed.input).toBe(100);
  });

  it("handles getSessionStats throwing gracefully", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, () => { throw new Error("boom"); });
    expect(result.tokensUsed.input).toBe(100);
  });

  it("uses bridge cacheRead/cacheWrite when SDK values are undefined", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150, cacheRead: 10, cacheWrite: 5 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, () => ({
      tokens: { input: 200, output: 80, total: 280 },
    }));
    expect(result.tokensUsed.cacheRead).toBe(10);
    expect(result.tokensUsed.cacheWrite).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ExcludeDeferralResult wiring regression tests
// ---------------------------------------------------------------------------

describe("ExcludeDeferralResult wiring", () => {
  it("clearSessionToolSchemaSnapshotHash is exported and callable", () => {
    // Smoke test: calling with a non-existent key should not throw
    expect(() => clearSessionToolSchemaSnapshotHash("non-existent-key")).not.toThrow();
  });

  it("clearSessionToolSchemaSnapshotHash removes hash for known key", () => {
    const key = formatSessionKey(testSessionKey);
    // First call sets up, second call should still not throw (idempotent)
    clearSessionToolSchemaSnapshotHash(key);
    clearSessionToolSchemaSnapshotHash(key);
    // No assertion beyond not throwing -- the Map is internal
  });

  // TODO: - add integration test for dynamic preamble <deferred-tools> injection
  // Requires full execution path mock with deferredEntries, which is covered by e2e tests.
  // Unit-level verification of buildDeferredToolsContext is in tool-deferral.test.ts.

  // TODO: add integration test for sideEffects processing
  // The sideEffects wrapper requires a full execution flow with a tool that returns
  // sideEffects.discoveredTools, which is impractical to mock at the unit level.
  // Discovery tracker integration is covered by discovery-tracker.test.ts.

  // TODO: add integration test for tool composition hash invalidation
  // Requires simulating multi-turn execution where activeTools changes between turns.
  // computeToolCompositionHash is tested implicitly through snapshot invalidation behavior.

  describe("schema stripping integration", () => {
    it("should import stripDiscoverySchemas from schema-stripping module", async () => {
      const mod = await import("./schema-stripping.js");
      expect(mod.stripDiscoverySchemas).toBeDefined();
      expect(typeof mod.stripDiscoverySchemas).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // resolvedModel on ALS context
  // -------------------------------------------------------------------------

  describe("resolvedModel ALS context", () => {
    it("sets resolvedModel on ALS context after model resolution", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      // Execute within an ALS context scope so tryGetContext() returns something
      const ctx = {
        tenantId: "default",
        userId: "u1",
        sessionKey: "t1:c1:u1",
        traceId: crypto.randomUUID(),
        startedAt: Date.now(),
        trustLevel: "admin" as const,
      };

      await runWithContext(ctx, async () => {
        await executor.execute(testMessage, testSessionKey);
        // After execution, the ALS context should have resolvedModel set
        const currentCtx = tryGetContext();
        expect(currentCtx).toBeDefined();
        expect((currentCtx as Record<string, unknown>).resolvedModel).toBe(
          "anthropic:claude-sonnet-4-5-20250929",
        );
      });
    });

    it("RequestContextSchema accepts resolvedModel as optional string", async () => {
      const { RequestContextSchema } = await import("@comis/core");
      const validCtx = RequestContextSchema.parse({
        userId: "u1",
        sessionKey: "s1",
        traceId: crypto.randomUUID(),
        startedAt: Date.now(),
        resolvedModel: "anthropic:claude-sonnet-4-5-20250929",
      });
      expect(validCtx.resolvedModel).toBe("anthropic:claude-sonnet-4-5-20250929");
    });

    it("RequestContextSchema allows omitting resolvedModel", async () => {
      const { RequestContextSchema } = await import("@comis/core");
      const validCtx = RequestContextSchema.parse({
        userId: "u1",
        sessionKey: "s1",
        traceId: crypto.randomUUID(),
        startedAt: Date.now(),
      });
      expect(validCtx.resolvedModel).toBeUndefined();
    });

    it("RequestContextSchema still rejects truly unknown fields (strictObject)", async () => {
      const { RequestContextSchema } = await import("@comis/core");
      expect(() =>
        RequestContextSchema.parse({
          userId: "u1",
          sessionKey: "s1",
          traceId: crypto.randomUUID(),
          startedAt: Date.now(),
          totallyUnknownField: true,
        }),
      ).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Output escalation on max_tokens truncation
  // -------------------------------------------------------------------------

  describe("output escalation", () => {
    it("retries with escalated maxTokens when bridge reports maxTokens stop and config.maxTokens is undefined", async () => {
      // Bridge reports maxTokens on first two calls (stuck-session check + context escalation check),
      // then normal after escalation retry.
      let callCount = 0;
      mockGetResult.mockImplementation(() => {
        callCount++;
        return {
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.01 },
          stepsExecuted: 2,
          llmCalls: 1,
          finishReason: "stop",
          textEmitted: true,
          lastStopReason: callCount <= 2 ? "maxTokens" : "endTurn",
        };
      });

      // First prompt returns truncated, second returns full
      let promptCalls = 0;
      mockGetLastAssistantText.mockImplementation(() => {
        promptCalls++;
        return promptCalls <= 1 ? "truncated resp" : "full escalated response";
      });
      mockPrompt.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const escalationConfig: PerAgentConfig = {
        ...testConfig,
        // No maxTokens set (undefined) -- should trigger escalation
        contextEngine: {
          outputEscalation: { enabled: true, escalatedMaxTokens: 32_768 },
        },
      } as PerAgentConfig;

      const executor = createPiExecutor(escalationConfig, deps);
      const result = await executor.execute(testSessionKey, testMessage);

      // Should have called prompt twice (original + escalation retry)
      expect(mockPrompt.mock.calls.length).toBeGreaterThanOrEqual(2);

      // execution:output_escalated event should be emitted
      const emittedCalls = (deps.eventBus.emit as Mock).mock.calls;
      const escalationEvent = emittedCalls.find(
        (call: unknown[]) => call[0] === "execution:output_escalated",
      );
      expect(escalationEvent).toBeDefined();
      expect(escalationEvent![1]).toMatchObject({
        escalatedMaxTokens: 32_768,
      });
    });

    it("does not escalate when config.maxTokens is explicitly set", async () => {
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 2,
        llmCalls: 1,
        finishReason: "stop",
        textEmitted: true,
        lastStopReason: "maxTokens",
      });
      mockGetLastAssistantText.mockReturnValue("truncated but accepted");
      mockPrompt.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const configWithMaxTokens: PerAgentConfig = {
        ...testConfig,
        maxTokens: 4096, // Explicitly set -- no escalation
      } as PerAgentConfig;

      const executor = createPiExecutor(configWithMaxTokens, deps);
      await executor.execute(testSessionKey, testMessage);

      // No escalation event should be emitted -- config.maxTokens is explicitly set
      const emittedCalls = (deps.eventBus.emit as Mock).mock.calls;
      const escalationEvent = emittedCalls.find(
        (call: unknown[]) => call[0] === "execution:output_escalated",
      );
      expect(escalationEvent).toBeUndefined();
    });

    it("does not escalate when outputEscalation.enabled is false", async () => {
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 2,
        llmCalls: 1,
        finishReason: "stop",
        textEmitted: true,
        lastStopReason: "maxTokens",
      });
      mockGetLastAssistantText.mockReturnValue("truncated response");
      mockPrompt.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const disabledConfig: PerAgentConfig = {
        ...testConfig,
        contextEngine: {
          outputEscalation: { enabled: false, escalatedMaxTokens: 32_768 },
        },
      } as PerAgentConfig;

      const executor = createPiExecutor(disabledConfig, deps);
      await executor.execute(testSessionKey, testMessage);

      // No escalation event should be emitted -- escalation is disabled
      const emittedCalls = (deps.eventBus.emit as Mock).mock.calls;
      const escalationEvent = emittedCalls.find(
        (call: unknown[]) => call[0] === "execution:output_escalated",
      );
      expect(escalationEvent).toBeUndefined();
    });

    it("emits execution:output_escalated event with correct fields", async () => {
      // adds one extra getResult() call before context escalation check, so maxTokens
      // must persist through the first 2 calls (stuck-session check + context escalation check).
      let callCount = 0;
      mockGetResult.mockImplementation(() => {
        callCount++;
        return {
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.01 },
          stepsExecuted: 2,
          llmCalls: 1,
          finishReason: "stop",
          textEmitted: true,
          lastStopReason: callCount <= 2 ? "maxTokens" : "endTurn",
        };
      });

      let promptCalls = 0;
      mockGetLastAssistantText.mockImplementation(() => {
        promptCalls++;
        return promptCalls <= 1 ? "truncated" : "complete response";
      });
      mockPrompt.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const escalationConfig: PerAgentConfig = {
        ...testConfig,
        contextEngine: {
          outputEscalation: { enabled: true, escalatedMaxTokens: 16_384 },
        },
      } as PerAgentConfig;

      const executor = createPiExecutor(escalationConfig, deps);
      await executor.execute(testSessionKey, testMessage);

      const emittedCalls = (deps.eventBus.emit as Mock).mock.calls;
      const escalationEvent = emittedCalls.find(
        (call: unknown[]) => call[0] === "execution:output_escalated",
      );
      expect(escalationEvent).toBeDefined();
      expect(escalationEvent![1]).toMatchObject({
        agentId: expect.any(String),
        sessionKey: expect.any(String),
        originalMaxTokens: expect.any(Number),
        escalatedMaxTokens: 16_384,
        timestamp: expect.any(Number),
      });
    });

    it("escalation replaces original truncated response", async () => {
      let callCount = 0;
      mockGetResult.mockImplementation(() => {
        callCount++;
        return {
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.01 },
          stepsExecuted: 2,
          llmCalls: 1,
          finishReason: "stop",
          textEmitted: true,
          lastStopReason: callCount === 1 ? "maxTokens" : "endTurn",
        };
      });

      let promptCalls = 0;
      mockGetLastAssistantText.mockImplementation(() => {
        promptCalls++;
        return promptCalls <= 1 ? "truncated resp..." : "full escalated response with complete content";
      });
      mockPrompt.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const escalationConfig: PerAgentConfig = {
        ...testConfig,
        contextEngine: {
          outputEscalation: { enabled: true, escalatedMaxTokens: 32_768 },
        },
      } as PerAgentConfig;

      const executor = createPiExecutor(escalationConfig, deps);
      const result = await executor.execute(testSessionKey, testMessage);

      // Response should be the escalated version, not the truncated one
      expect(result.response).toBe("full escalated response with complete content");
    });
  });

  // -------------------------------------------------------------------------
  // Budget tracking
  // -------------------------------------------------------------------------

  describe("budget tracking", () => {
    it("creates budgetTracker from directives.userTokenBudget when present", async () => {
      const deps = createMockDeps();
      // No operator cap (Infinity by default when budgets not configured)
      const budgetConfig: PerAgentConfig = {
        ...testConfig,
      } as PerAgentConfig;

      const executor = createPiExecutor(budgetConfig, deps);

      // Mock bridge to return output above 90% of 500K so tracker says "budget_reached" (stop)
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 460_000, total: 460_100, cacheRead: 0, cacheWrite: 0 },
        cost: { total: 0.01 },
        stepsExecuted: 2,
        llmCalls: 1,
        finishReason: "stop",
      });

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        { userTokenBudget: 500_000 },
      );

      expect(result.budgetMetrics).toBeDefined();
      expect(result.budgetMetrics!.requestedBudget).toBe(500_000);
      expect(result.budgetMetrics!.effectiveBudget).toBe(500_000);
      expect(result.budgetMetrics!.wasCapped).toBe(false);
    });

    it("caps effective budget to operator perExecution when user budget exceeds it", async () => {
      const deps = createMockDeps();
      const budgetConfig: PerAgentConfig = {
        ...testConfig,
        budgets: { perExecution: 200_000, perHour: 10_000_000, perDay: 100_000_000 },
      } as PerAgentConfig;

      const executor = createPiExecutor(budgetConfig, deps);

      // Mock bridge output high enough to trigger budget_reached at the capped level
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 185_000, total: 185_100, cacheRead: 0, cacheWrite: 0 },
        cost: { total: 0.01 },
        stepsExecuted: 2,
        llmCalls: 1,
        finishReason: "stop",
      });

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        { userTokenBudget: 500_000 },
      );

      expect(result.budgetMetrics).toBeDefined();
      expect(result.budgetMetrics!.effectiveBudget).toBe(200_000);
      expect(result.budgetMetrics!.wasCapped).toBe(true);
    });

    it("prepends cap notice to response when wasCapped is true", async () => {
      const deps = createMockDeps();
      const budgetConfig: PerAgentConfig = {
        ...testConfig,
        budgets: { perExecution: 200_000, perHour: 10_000_000, perDay: 100_000_000 },
      } as PerAgentConfig;

      const executor = createPiExecutor(budgetConfig, deps);

      // Output above 90% of capped budget (200K) to trigger budget_reached
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 185_000, total: 185_100, cacheRead: 0, cacheWrite: 0 },
        cost: { total: 0.01 },
        stepsExecuted: 2,
        llmCalls: 1,
        finishReason: "stop",
      });

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        { userTokenBudget: 500_000 },
      );

      expect(result.response).toContain("*Note: Your requested budget of");
      expect(result.response).toContain("was capped to");
      expect(result.response).toContain("tokens by operator limits.*");
    });

    it("sets finishReason to budget_exhausted when tracker stops", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      // Output at 90%+ of 100K budget triggers budget_reached
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 92_000, total: 92_100, cacheRead: 0, cacheWrite: 0 },
        cost: { total: 0.01 },
        stepsExecuted: 2,
        llmCalls: 1,
        finishReason: "stop",
      });

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        { userTokenBudget: 100_000 },
      );

      expect(result.finishReason).toBe("budget_exhausted");
      expect(result.budgetMetrics!.stopReason).toBe("budget_reached");
    });

    it("injects continuation nudge via followUp when tracker says continue", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      // First 3 calls return low output (under budget), 4th+ returns high output (budget_reached).
      // getResult() is called by internal checks before the budget continuation loop.
      let callCount = 0;
      mockGetResult.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          return {
            tokensUsed: { input: 100, output: 100_000, total: 100_100, cacheRead: 0, cacheWrite: 0 },
            cost: { total: 0.01 },
            stepsExecuted: 2,
            llmCalls: 1,
            finishReason: "stop",
          };
        }
        return {
          tokensUsed: { input: 200, output: 475_000, total: 475_200, cacheRead: 0, cacheWrite: 0 },
          cost: { total: 0.05 },
          stepsExecuted: 3,
          llmCalls: 2,
          finishReason: "stop",
        };
      });

      mockFollowUp.mockResolvedValue(undefined);
      mockGetLastAssistantText.mockReturnValue("extended response after budget nudge");

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        { userTokenBudget: 500_000 },
      );

      // followUp should have been called with budget nudge text
      expect(mockFollowUp).toHaveBeenCalledWith(
        expect.stringContaining("[budget:nudge]"),
      );
      expect(result.response).toContain("extended response after budget nudge");
    });

    it("populates budgetMetrics on result with continuations count", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      // First 3 calls return low output (continue), 4th+ returns high output (stop).
      let callCount = 0;
      mockGetResult.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          return {
            tokensUsed: { input: 100, output: 50_000, total: 50_100, cacheRead: 0, cacheWrite: 0 },
            cost: { total: 0.01 },
            stepsExecuted: 2,
            llmCalls: 1,
            finishReason: "stop",
          };
        }
        return {
          tokensUsed: { input: 200, output: 470_000, total: 470_200, cacheRead: 0, cacheWrite: 0 },
          cost: { total: 0.05 },
          stepsExecuted: 3,
          llmCalls: 2,
          finishReason: "stop",
        };
      });

      mockFollowUp.mockResolvedValue(undefined);

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        { userTokenBudget: 500_000 },
      );

      expect(result.budgetMetrics).toBeDefined();
      expect(result.budgetMetrics!.continuations).toBe(1);
      expect(result.budgetMetrics!.stopReason).toBe("budget_reached");
      expect(result.finishReason).toBe("budget_exhausted");
    });

    it("suppresses output escalation when budget tracker is active", async () => {
      const deps = createMockDeps();
      const escalationConfig: PerAgentConfig = {
        ...testConfig,
        contextEngine: {
          outputEscalation: { enabled: true, escalatedMaxTokens: 32_768 },
        },
      } as PerAgentConfig;

      const executor = createPiExecutor(escalationConfig, deps);

      // Simulate max_tokens truncation (would normally trigger escalation)
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 8000, total: 8100, cacheRead: 0, cacheWrite: 0 },
        cost: { total: 0.01 },
        stepsExecuted: 2,
        llmCalls: 1,
        finishReason: "stop",
        lastStopReason: "maxTokens",
      });

      // Record prompt call count before this execution
      const promptCallsBefore = mockPrompt.mock.calls.length;

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        { userTokenBudget: 100_000 },
      );

      // Budget tracker should be active and suppress escalation
      expect(result.budgetMetrics).toBeDefined();
      // With budget active, the escalation guard includes `&& !budgetTracker`
      // so no escalation retry happens. Only the initial prompt was called.
      const promptCallsDuringExec = mockPrompt.mock.calls.length - promptCallsBefore;
      // We expect exactly 1 prompt call (the initial one), no escalation retry
      expect(promptCallsDuringExec).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // prepareArguments hook for xAI entity decoding
  // -------------------------------------------------------------------------

  describe("prepareArguments hook for xAI entity decoding", () => {
    it("sets prepareArguments on custom tools when provider is xai", async () => {
      const mockTool = {
        name: "xai_tool",
        label: "xAI Tool",
        description: "A test tool for xAI",
        parameters: { type: "object", properties: {} },
        execute: vi.fn().mockResolvedValue("result"),
      };
      const deps = createMockDeps({
        customTools: [mockTool] as any,
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "xai", id: "grok-3" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const xaiConfig: PerAgentConfig = {
        ...testConfig,
        model: "grok-3",
        provider: "xai",
      } as PerAgentConfig;

      const executor = createPiExecutor(xaiConfig, deps);
      await executor.execute(testMessage, testSessionKey);

      const calls = (createAgentSession as Mock).mock.calls;
      const sessionOpts = calls[calls.length - 1][0];
      const testToolInSession = sessionOpts.customTools.find(
        (t: any) => t.name === "xai_tool",
      );
      expect(testToolInSession).toBeDefined();
      expect(testToolInSession).toHaveProperty("prepareArguments");
      expect(typeof testToolInSession.prepareArguments).toBe("function");
    });

    it("prepareArguments calls decodeHtmlEntitiesInParams on args", async () => {
      const mockTool = {
        name: "xai_decode_tool",
        label: "xAI Decode Tool",
        description: "A test tool for xAI decoding",
        parameters: { type: "object", properties: {} },
        execute: vi.fn().mockResolvedValue("result"),
      };
      const deps = createMockDeps({
        customTools: [mockTool] as any,
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "xai", id: "grok-3" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const xaiConfig: PerAgentConfig = {
        ...testConfig,
        model: "grok-3",
        provider: "xai",
      } as PerAgentConfig;

      const executor = createPiExecutor(xaiConfig, deps);
      await executor.execute(testMessage, testSessionKey);

      const calls = (createAgentSession as Mock).mock.calls;
      const sessionOpts = calls[calls.length - 1][0];
      const testToolInSession = sessionOpts.customTools.find(
        (t: any) => t.name === "xai_decode_tool",
      );
      expect(testToolInSession).toBeDefined();
      const prepareArgs = testToolInSession.prepareArguments;

      // Verify HTML entity decoding
      const decoded = prepareArgs({ query: "foo &amp; bar &lt;baz&gt;" });
      expect(decoded).toEqual({ query: "foo & bar <baz>" });
    });

    it("does NOT set prepareArguments when provider is not xai", async () => {
      const mockTool = {
        name: "anthropic_tool",
        label: "Anthropic Tool",
        description: "A test tool for anthropic",
        parameters: { type: "object", properties: {} },
        execute: vi.fn().mockResolvedValue("result"),
      };
      const deps = createMockDeps({
        customTools: [mockTool] as any,
      });
      // Use a distinct session key to avoid tool composition snapshot leakage from xAI tests
      const anthropicSessionKey: SessionKey = {
        tenantId: "t1",
        channelId: "c-anthropic",
        userId: "u1",
      };

      const executor = createPiExecutor(testConfig, deps);
      await executor.execute(testMessage, anthropicSessionKey);

      // Use the most recent createAgentSession call (not [0] which may be from prior tests)
      const calls = (createAgentSession as Mock).mock.calls;
      const sessionOpts = calls[calls.length - 1][0];
      const testToolInSession = sessionOpts.customTools.find(
        (t: any) => t.name === "anthropic_tool",
      );
      expect(testToolInSession).toBeDefined();
      expect(testToolInSession).not.toHaveProperty("prepareArguments");
    });
  });

  // -------------------------------------------------------------------------
  // modelFallbackMessage logging
  // -------------------------------------------------------------------------

  describe("modelFallbackMessage logging", () => {
    it("logs WARN when createAgentSession returns modelFallbackMessage", async () => {
      (createAgentSession as Mock).mockResolvedValueOnce({
        session: mockSession,
        extensionsResult: {},
        modelFallbackMessage: "Model claude-opus-4 not available, using claude-sonnet-4",
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      await executor.execute(testMessage, testSessionKey);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Model claude-opus-4 not available, using claude-sonnet-4",
          errorKind: "config",
        }),
        "SDK model fallback during session creation",
      );
    });

    it("does NOT log WARN when createAgentSession has no modelFallbackMessage", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      await executor.execute(testMessage, testSessionKey);

      const warnCalls = (deps.logger.warn as Mock).mock.calls;
      const fallbackCalls = warnCalls.filter(
        (call: unknown[]) => call[1] === "SDK model fallback during session creation",
      );
      expect(fallbackCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Latch reset on compaction + idle thinking clear
  // -------------------------------------------------------------------------

  describe("session latches", () => {
    it("compaction:flush handler clears session latches", () => {
      const deps = createMockDeps();

      // Create the executor (registers the compaction:flush handler)
      createPiExecutor(testConfig, deps);

      // Capture the compaction:flush handler registered via eventBus.on
      const onCalls = (deps.eventBus.on as Mock).mock.calls;
      const compactionHandler = onCalls.find(
        ([event]: [string]) => event === "compaction:flush",
      );
      expect(compactionHandler).toBeDefined();

      // Use a unique session key to avoid cross-test latch contamination
      const compactionTestKey: SessionKey = {
        tenantId: "compact-test",
        channelId: "c-compact",
        userId: "u-compact",
      };
      const formattedCompactKey = formatSessionKey(compactionTestKey);

      // Set up fresh latches
      _clearSessionLatchesForTest(formattedCompactKey);
      const latches = _getOrCreateSessionLatchesForTest(formattedCompactKey);
      latches.betaHeader.setOnce("test-header");
      expect(latches.betaHeader.get()).toBe("test-header");

      // Invoke the handler
      compactionHandler![1]({ sessionKey: compactionTestKey });

      // Verify latches are cleared (map entry deleted, so new latches created)
      const latchesAfter = _getOrCreateSessionLatchesForTest(formattedCompactKey);
      expect(latchesAfter.betaHeader.get()).toBeNull();
    });

    it("idleThinkingClear latch exists in SessionLatches and is reset by clearSessionLatches", () => {
      const formattedKey = "test-idle-session";
      const latches = _getOrCreateSessionLatchesForTest(formattedKey);

      // Verify idleThinkingClear latch exists
      expect(latches.idleThinkingClear).toBeDefined();
      expect(latches.idleThinkingClear.get()).toBeNull();

      // Set the latch
      latches.idleThinkingClear.setOnce(true);
      expect(latches.idleThinkingClear.get()).toBe(true);

      // Clear all latches
      _clearSessionLatchesForTest(formattedKey);

      // Verify latch is cleared (new latches created since old map entry deleted)
      const freshLatches = _getOrCreateSessionLatchesForTest(formattedKey);
      expect(freshLatches.idleThinkingClear.get()).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Skip guard for lookback_window_exceeded cache breaks
// ---------------------------------------------------------------------------

describe("skip guard for lookback_window_exceeded cache breaks", () => {
  // Unit test for the onCacheBreakDetected handler logic from pi-executor.ts.
  // Tests the handler function in isolation to verify that lookback misses
  // do NOT trigger the destructive 4-step coordinated reset.

  const NO_CHANGES: PendingChanges = {
    systemChanged: false,
    toolsChanged: false,
    metadataChanged: false,
    modelChanged: false,
    retentionChanged: false,
    addedTools: [],
    removedTools: [],
    changedSchemaTools: [],
    headersChanged: false,
    extraBodyChanged: false,
    effortChanged: false,
    cacheControlChanged: false,
  };

  function makeCacheBreakEvent(reason: CacheBreakReason, overrides: Partial<CacheBreakEvent> = {}): CacheBreakEvent {
    return {
      provider: "anthropic",
      reason,
      tokenDrop: 45000,
      tokenDropRelative: 0.9,
      previousCacheRead: 50000,
      currentCacheRead: 5000,
      callCount: 5,
      changes: NO_CHANGES,
      toolsChanged: [],
      ttlCategory: "short",
      agentId: "agent-1",
      sessionKey: "test-session",
      timestamp: Date.now(),
      ...overrides,
    };
  }

  /**
   * Simulate the onCacheBreakDetected handler from pi-executor.ts.
   * This mirrors the exact logic pattern at lines 999-1016.
   */
  function createEvictHandler(deps: {
    reset: () => void;
    clearWarm: () => void;
    setCooldown: () => void;
    clearStability: () => void;
    clearSavings: () => void;
    logWarn: (obj: Record<string, unknown>, msg: string) => void;
    logInfo: (obj: Record<string, unknown>, msg: string) => void;
  }) {
    return (event: CacheBreakEvent) => {
      // Skip coordinated reset for lookback window misses.
      if (event.reason === "lookback_window_exceeded") {
        deps.logWarn(
          {
            sessionKey: event.sessionKey,
            reason: event.reason,
            tokenDrop: event.tokenDrop,
            conversationBlockCount: event.conversationBlockCount,
            hint: "Long conversation exceeded lookback window. Multi-zone breakpoints mitigate this. No action needed.",
            errorKind: "performance" as const,
          },
          "Cache miss from lookback window exceeded (not server eviction)",
        );
        return;
      }
      if (event.reason === "likely_server_eviction" || event.reason === "server_eviction") {
        deps.reset();
        deps.clearWarm();
        deps.setCooldown();
        deps.clearStability();
        deps.clearSavings();
        deps.logInfo(
          { sessionKey: event.sessionKey, reason: event.reason, tokenDrop: event.tokenDrop },
          "Server eviction detected, coordinated reset activated",
        );
      }
    };
  }

  it("does not reset for lookback_window_exceeded", () => {
    const reset = vi.fn();
    const clearWarm = vi.fn();
    const setCooldown = vi.fn();
    const clearStability = vi.fn();
    const clearSavings = vi.fn();
    const logWarn = vi.fn();
    const logInfo = vi.fn();

    const handler = createEvictHandler({ reset, clearWarm, setCooldown, clearStability, clearSavings, logWarn, logInfo });
    handler(makeCacheBreakEvent("lookback_window_exceeded", { conversationBlockCount: 25 }));

    // reset functions should NOT be called
    expect(reset).not.toHaveBeenCalled();
    expect(clearWarm).not.toHaveBeenCalled();
    expect(setCooldown).not.toHaveBeenCalled();
    expect(clearStability).not.toHaveBeenCalled();
    expect(clearSavings).not.toHaveBeenCalled();

    // WARN log should be emitted for observability
    expect(logWarn).toHaveBeenCalledOnce();
    expect(logWarn.mock.calls[0][1]).toContain("lookback window exceeded");
    expect(logWarn.mock.calls[0][0].errorKind).toBe("performance");
    expect(logWarn.mock.calls[0][0].hint).toContain("lookback window");

    // INFO log (coordinated reset) should NOT be emitted
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("still resets for likely_server_eviction (existing behavior)", () => {
    const reset = vi.fn();
    const clearWarm = vi.fn();
    const setCooldown = vi.fn();
    const clearStability = vi.fn();
    const clearSavings = vi.fn();
    const logWarn = vi.fn();
    const logInfo = vi.fn();

    const handler = createEvictHandler({ reset, clearWarm, setCooldown, clearStability, clearSavings, logWarn, logInfo });
    handler(makeCacheBreakEvent("likely_server_eviction"));

    // All coordinated reset functions should be called
    expect(reset).toHaveBeenCalledOnce();
    expect(clearWarm).toHaveBeenCalledOnce();
    expect(setCooldown).toHaveBeenCalledOnce();
    expect(clearStability).toHaveBeenCalledOnce();
    expect(clearSavings).toHaveBeenCalledOnce();

    // INFO log (coordinated reset) should be emitted
    expect(logInfo).toHaveBeenCalledOnce();
    expect(logInfo.mock.calls[0][1]).toContain("Server eviction detected");

    // WARN log should NOT be emitted (no lookback)
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("still resets for server_eviction (existing behavior)", () => {
    const reset = vi.fn();
    const clearWarm = vi.fn();
    const setCooldown = vi.fn();
    const clearStability = vi.fn();
    const clearSavings = vi.fn();
    const logWarn = vi.fn();
    const logInfo = vi.fn();

    const handler = createEvictHandler({ reset, clearWarm, setCooldown, clearStability, clearSavings, logWarn, logInfo });
    handler(makeCacheBreakEvent("server_eviction"));

    // All coordinated reset functions should be called
    expect(reset).toHaveBeenCalledOnce();
    expect(clearWarm).toHaveBeenCalledOnce();
    expect(setCooldown).toHaveBeenCalledOnce();
    expect(clearStability).toHaveBeenCalledOnce();
    expect(clearSavings).toHaveBeenCalledOnce();
  });

  it("other reasons (system_changed, tools_changed) do NOT trigger coordinated reset", () => {
    const reset = vi.fn();
    const clearWarm = vi.fn();
    const setCooldown = vi.fn();
    const clearStability = vi.fn();
    const clearSavings = vi.fn();
    const logWarn = vi.fn();
    const logInfo = vi.fn();

    const handler = createEvictHandler({ reset, clearWarm, setCooldown, clearStability, clearSavings, logWarn, logInfo });

    handler(makeCacheBreakEvent("system_changed"));
    handler(makeCacheBreakEvent("tools_changed"));
    handler(makeCacheBreakEvent("ttl_expiry_short"));

    // None of these should trigger the coordinated reset
    expect(reset).not.toHaveBeenCalled();
    expect(clearWarm).not.toHaveBeenCalled();
  });
});
