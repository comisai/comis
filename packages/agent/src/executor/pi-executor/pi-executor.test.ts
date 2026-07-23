// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
// node:fs is partially mocked below (appendFileSync/statSync/renameSync/unlinkSync);
// readFileSync passes through to the real implementation via the ...actual spread,
// so the source-text wiring guard at the bottom of this file can use it.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, err } from "@comis/shared";
import { resolveModelProfile } from "../model-profile.js";
import type { ContextStorePort, PerAgentConfig, SessionKey, NormalizedMessage } from "@comis/core";
import {
  createDeliveryOrigin,
  createConversationRef,
  computeWorkspacePolicyCombinedHash,
  formatSessionKey,
  hashWorkspacePolicyContent,
  INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  registerToolMetadata,
  runWithContext,
  tryGetContext,
  TypedEventBus,
} from "@comis/core";
import type { ExecutionOverrides, ExecutionResult } from "../types.js";
import { clearSessionToolNameSnapshot, clearSessionBootstrapFileSnapshot, clearSessionPromptSkillsXmlSnapshot } from "../prompt-assembly.js";
import { clearSessionToolSchemaSnapshot } from "../executor-session-state.js";
import { resetPairedMemoryDedupForTests } from "../executor-post-execution.js";
import type { CacheBreakEvent, CacheBreakReason, PendingChanges } from "../cache-detection/index.js";
import { buildPromptingSnapshot } from "./pi-executor-prompting.js";
import { planInboundMessageProvenance } from "../../session/inbound-message-provenance.js";

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
  mockAppendCustomEntry,
  mockAppendInboundMessageLedger,
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
  mockHasOutboundDelivery,
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
  setMockAssistantText,
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
  const mockAppendCustomEntry = vi.fn().mockReturnValue("provenance-entry");
  const mockAppendInboundMessageLedger = vi.fn().mockReturnValue({
    ok: true,
    value: undefined,
  });

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
  const mockHasOutboundDelivery = vi.fn().mockReturnValue(false);
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

  // getVisibleAssistantText now reads from mockSession.messages
  // directly (no SDK delegation on the no-commentary path). This helper keeps
  // the SDK mock in sync with messages so tests can stay terse — sets BOTH
  // mockGetLastAssistantText.mockReturnValue(text) AND ensures the trailing
  // assistant message in mockSession.messages produces `text` from
  // getVisibleAssistantText. If the last message is already an assistant,
  // its content is replaced; otherwise a new assistant is appended.
  const setMockAssistantText = (text: string) => {
    mockGetLastAssistantText.mockReturnValue(text);
    const msgs = mockSession.messages;
    const last = msgs[msgs.length - 1];
    const newAssistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
    };
    if (last && last.role === "assistant") {
      msgs[msgs.length - 1] = newAssistant;
    } else {
      msgs.push(newAssistant);
    }
  };

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
    mockAppendCustomEntry,
    mockAppendInboundMessageLedger,
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
    mockHasOutboundDelivery,
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
    setMockAssistantText,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@earendil-works/pi-coding-agent", () => ({
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

vi.mock("../../session/orphaned-message-repair.js", () => ({
  repairOrphanedMessages: vi.fn().mockReturnValue({ repaired: false }),
  scrubPoisonedThinkingBlocks: vi.fn().mockReturnValue({ scrubbed: false, blocksRemoved: 0 }),
}));

vi.mock("../../session/scrub-redacted-tool-calls.js", () => ({
  scrubRedactedToolCalls: vi.fn().mockReturnValue({ scrubbed: false, blocksRewritten: 0, resultsRewritten: 0 }),
}));

vi.mock("../../bridge/pi-event-bridge.js", () => ({
  createPiEventBridge: vi.fn().mockReturnValue({
    listener: mockBridgeListener,
    getResult: mockGetResult,
    addGhostCost: vi.fn(),
    // Bridge owns the drain inflight gate so postExecution can fire an
    // end-of-turn backstop drainAt sharing the same composite-key Map.
    // The mock returns a fresh Map per construction.
    getDrainState: () => ({ drainInflightByKey: new Map<string, Promise<void>>() }),
    // postExecution reads the per-turn skill-use carrier back. Default
    // empty (no skill attributed) → memory:skill_used not emitted.
    getUsedSkillIds: () => new Set<string>(),
    hasOutboundDelivery: mockHasOutboundDelivery,
  }),
}));

vi.mock("../../bootstrap/index.js", () => ({
  assembleRichSystemPrompt: mockAssembleRichSystemPrompt,
  assembleRichSystemPromptBlocks: vi.fn().mockReturnValue({ staticPrefix: "static-prefix", attribution: "attribution", semiStableBody: "semi-stable-body" }),
  compileRichSystemPrompt: vi.fn().mockReturnValue({
    report: {
      mode: "full",
      combinedHash: "c".repeat(64),
      totalChars: 42,
      sections: [],
    },
  }),
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

vi.mock("../../rag/rag-retriever.js", () => ({
  deduplicateResults: mockDeduplicateResults,
}));

vi.mock("../../rag/hybrid-memory-injector.js", () => ({
  createHybridMemoryInjector: mockCreateHybridMemoryInjector,
}));

vi.mock("../../envelope/message-envelope.js", () => ({
  wrapInEnvelope: mockWrapInEnvelope,
}));

// Mock tool-parallelism module -- passthrough so existing tests are unaffected
vi.mock("../tool-parallelism.js", () => ({
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

import { createPiExecutor, type PiExecutorDeps } from "./pi-executor.js";
import {
  clearSessionToolSchemaSnapshotHash,
  clearWindowReconcileLogged,
  getOrCreateSessionLatches as _getOrCreateSessionLatchesForTest,
  clearSessionLatches as _clearSessionLatchesForTest,
} from "../executor-session-state.js";
// PiExecutorDeps requires toolCapabilityPort. Tests use the test-only stub
// from @comis/core's __test-helpers/ directory (NOT the production no-op
// factory re-exported from @comis/core — the architecture-grep boundary
// forbids production-stub crossover both ways).
import { createCapabilityPortStub } from "../../../../core/src/ports/__test-helpers/tool-capability-stub.js";
import { repairOrphanedMessages, scrubPoisonedThinkingBlocks } from "../../session/orphaned-message-repair.js";
import { scrubRedactedToolCalls } from "../../session/scrub-redacted-tool-calls.js";
import { createPiEventBridge } from "../../bridge/pi-event-bridge.js";
import { INTERACTIVE_SILENT_FAILURE_RESPONSE } from "../prompt-runner/interactive-silent-recovery.js";
import { assembleRichSystemPrompt, loadWorkspaceBootstrapFiles, buildBootstrapContextFiles } from "../../bootstrap/index.js";
import { wrapInEnvelope } from "../../envelope/message-envelope.js";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
const mockAppendFileSync = vi.mocked(appendFileSync);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testSessionKey: SessionKey = {
  tenantId: "t1",
  agentId: "agent-1",
  channelId: "c1",
  userId: "u1",
};

const testMessage: NormalizedMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  text: "hello world",
  senderId: "user1",
  channelId: "c1",
  channelType: "test",
  timestamp: Date.now(),
} as NormalizedMessage;

function makeInboundProvenanceOverrides(
  message: NormalizedMessage,
  recordedAt = Date.parse("2026-03-12T00:00:00.000Z"),
) {
  const planned = planInboundMessageProvenance(message, recordedAt);
  if (!planned.ok) throw planned.error.error;
  return {
    operationType: "interactive" as const,
    inboundProvenancePlans: [planned.value],
  };
}

function withTestTurnScope<T>(agentId: string, fn: () => T): T {
  const endpoint = {
    channelType: "test",
    channelInstanceId: "test-instance",
    conversationId: testSessionKey.channelId,
    conversationKind: "direct" as const,
  };
  return runWithContext({
    tenantId: testSessionKey.tenantId,
    userId: testSessionKey.userId,
    sessionKey: formatSessionKey(testSessionKey),
    agentId,
    turnScope: {
      conversation: {
        tenantId: testSessionKey.tenantId,
        agentId,
        partition: { kind: "agent" as const },
      },
      principal: { principalId: testSessionKey.userId },
      endpoint,
    },
    traceId: "00000000-0000-4000-8000-000000000001",
    startedAt: 1,
    trustLevel: "admin",
  }, fn);
}

function makeContextStore(): ContextStorePort {
  return {
    append: vi.fn(),
    getMessages: vi.fn(() => []),
    appendLeafSummary: vi.fn(() => "leaf"),
    appendCondensedSummary: vi.fn(() => "condensed"),
    getContextItems: vi.fn(() => []),
    getSummaries: vi.fn(() => []),
    getMessagesByIds: vi.fn(() => []),
    getSummariesByIds: vi.fn(() => []),
    countMessages: vi.fn(() => 0),
    getSummaryChildren: vi.fn(() => []),
    getSummaryMessages: vi.fn(() => []),
    searchLcd: vi.fn(() => ({ hits: [], lane: "word", matchErrored: false, cjkZeroHit: false, scanCapped: false })),
    runOnConversation: vi.fn(async (_conversationRef, fn) => fn()),
    getIngestCursor: vi.fn(() => null),
    upsertIngestCursor: vi.fn(),
    deleteConversationLcd: vi.fn(() => 0),
  };
}

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
  const emit = vi.fn();
  const boundAgentId = overrides?.agentId ?? "agent-1";
  return {
    agentId: boundAgentId,
    tenantId: "tenant-1",
    contextStore: makeContextStore(),
    circuitBreaker: {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      getState: vi.fn(),
      reset: vi.fn(),
    },
    budgetGuard: (() => {
      // resetExecution returns an execution-local window. The mock
      // window carries the same checkBudget/recordUsage/estimateCost/getSnapshot
      // surface; resetExecution returns it so the executor threads a real handle.
      const win = {
        recordUsage: vi.fn(),
        checkBudget: vi.fn().mockReturnValue(ok(undefined)),
        estimateCost: vi.fn(),
        getSnapshot: vi.fn().mockReturnValue({ perExecution: 0, perHour: 0, perDay: 0 }),
      };
      return {
        ...win,
        resetExecution: vi.fn().mockReturnValue(win),
      };
    })(),
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
      emit,
      emitSafely: vi.fn((event: string, payload: unknown) => {
        emit(event, payload);
        return { hadListeners: false, failures: [], pendingFailures: Promise.resolve([]) };
      }),
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
    // Minimal stub now needs getApiKey + setRuntimeApiKey to
    // satisfy the resolveProviderApiKey pre-execute hook in pi-executor.
    // No oauthManager wired into the test deps, so the hook falls through
    // to authStorage.getApiKey for both OAuth-eligible (anthropic) and
    // non-OAuth providers — both branches need a callable getApiKey stub.
    authStorage: {
      getApiKey: vi.fn().mockResolvedValue(undefined),
      setRuntimeApiKey: vi.fn(),
    } as any,
    modelRegistry: {
      find: vi.fn().mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5-20250929" }),
      getAll: vi.fn().mockReturnValue([]),
      getAvailable: vi.fn().mockReturnValue([]),
    } as any,
    modelRuntime: {
      getAuth: vi.fn().mockResolvedValue(undefined),
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
    } as any,
    sessionAdapter: {
      withSession: vi.fn().mockImplementation(
        async (_sk: SessionKey, fn: (sm: any) => Promise<any>) => {
          const mockSm = {
            buildSessionContext: vi.fn().mockReturnValue({ messages: [] }),
            getBranch: vi.fn().mockReturnValue([]),
            appendMessage: vi.fn(),
            appendCustomEntry: mockAppendCustomEntry,
            getSessionDir: vi.fn().mockReturnValue("/tmp/test-session"),
          };
          const value = tryGetContext()?.turnScope
            ? await fn(mockSm)
            : await withTestTurnScope(boundAgentId, () => fn(mockSm));
          return ok(value);
        },
      ),
      appendInboundMessageLedger: mockAppendInboundMessageLedger,
      persistInboundMessage: vi.fn().mockResolvedValue(ok({
        payloads: [],
        ledgerContent: "",
      })),
      destroySession: vi.fn().mockResolvedValue(undefined),
    },
    workspaceDir: "/tmp/test-workspace",
    agentDir: "/tmp/test-agent-dir",
    workspacePolicySnapshot: {
      agentId: boundAgentId,
      sections: [],
      combinedHash: "a".repeat(64),
    },
    customTools: [],
    // REQUIRED on PiExecutorDeps. Stub returns gate-enabled + empty defaults —
    // assembleTools() will invoke buildCapabilityIndexContext, which sees zero
    // clusters/skills/servers and returns the EMPTY sentinel. The runner's
    // array-concat then drops the empty text via .filter(Boolean).
    // Inert-but-not-broken; matches the production no-op port behavior the
    // daemon injects.
    toolCapabilityPort: createCapabilityPortStub(),
    // Required deps for clock, env, and timers.
    clock: { now: () => Date.now(), nowDate: () => new Date() },
    env: { get: (k: string) => undefined },
    timers: {
      setTimeout: (cb: () => void, ms: number) => {
        const t = setTimeout(cb, ms);
        let cancelled = false;
        let unrefCalled = false;
        return {
          get cancelled() { return cancelled; },
          cancel() { if (cancelled) return; cancelled = true; clearTimeout(t); },
          unref() { if (cancelled || unrefCalled) return; unrefCalled = true; t.unref(); },
        };
      },
      setInterval: (cb: () => void, ms: number) => {
        const t = setInterval(cb, ms);
        let cancelled = false;
        let unrefCalled = false;
        return {
          get cancelled() { return cancelled; },
          cancel() { if (cancelled) return; cancelled = true; clearInterval(t); },
          unref() { if (cancelled || unrefCalled) return; unrefCalled = true; t.unref(); },
        };
      },
    },
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
    mockAppendCustomEntry.mockReset().mockReturnValue("provenance-entry");
    mockAppendInboundMessageLedger.mockReset().mockReturnValue({
      ok: true,
      value: undefined,
    });
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
    mockHasOutboundDelivery.mockReset().mockReturnValue(false);
    mockSession.isStreaming = false;
    mockSession.isCompacting = false;
    // getVisibleAssistantText now reads from mockSession.messages
    // directly on the no-commentary path (no SDK delegation). The default
    // mockGetLastAssistantText return is "test response" — mirror that into a
    // default assistant message so tests that don't override either get the
    // same default. Tests that need a different response should use
    // setMockAssistantText() (which updates both the SDK mock and messages).
    mockSession.messages = [
      { role: "assistant", content: [{ type: "text", text: "test response" }] },
    ];
    // Reset skill mocks
    mockResourceLoaderArgs.captured = null;
    mockGetSkills.mockReturnValue({ skills: [], diagnostics: [] });
  });

  // -------------------------------------------------------------------------
  // Basic execution
  // -------------------------------------------------------------------------

  describe("basic execution", () => {
    it("loads one workspace policy snapshot and records its hash on the turn result", async () => {
      const snapshot = {
        agentId: "agent-1",
        sections: [],
        combinedHash: "a".repeat(64),
      };
      const load = vi.fn().mockResolvedValue(ok(snapshot));
      const deps = createMockDeps({
        workspacePolicySnapshot: undefined,
        workspacePolicyPort: { load, get: vi.fn() },
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(load).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledWith("agent-1");
      expect(result.workspacePolicyHash).toBe(snapshot.combinedHash);
    });

    it("uses a hash-verified per-execution policy snapshot without rereading mutable workspace files", async () => {
      const content = "# Scope\n\nUse the captured task scope.";
      const section = {
        id: "workspace:scope",
        sourceKind: "operator" as const,
        trust: "trusted" as const,
        stability: "stable" as const,
        content,
        contentHash: hashWorkspacePolicyContent(content),
        maxChars: 20_000,
      };
      const captured = {
        agentId: "agent-1",
        sections: [section],
        combinedHash: computeWorkspacePolicyCombinedHash([section]),
      };
      const load = vi.fn().mockResolvedValue(ok({
        agentId: "agent-1",
        sections: [],
        combinedHash: computeWorkspacePolicyCombinedHash([]),
      }));
      const deps = createMockDeps({
        workspacePolicySnapshot: undefined,
        workspacePolicyPort: { load, get: vi.fn() },
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(
        testMessage,
        testSessionKey,
        [],
        undefined,
        "agent-1",
        undefined,
        undefined,
        { operationType: "taskExtraction", workspacePolicySnapshot: captured } as ExecutionOverrides,
      );

      expect(load).not.toHaveBeenCalled();
      expect(result.workspacePolicyHash).toBe(captured.combinedHash);
    });

    it("rejects a corrupted per-execution policy snapshot before model dispatch or mutable policy fallback", async () => {
      const content = "# Scope\n\nUse the captured task scope.";
      const corrupted = {
        agentId: "agent-1",
        sections: [{
          id: "workspace:scope",
          sourceKind: "operator" as const,
          trust: "trusted" as const,
          stability: "stable" as const,
          content,
          contentHash: "f".repeat(64),
          maxChars: 20_000,
        }],
        combinedHash: "f".repeat(64),
      };
      const load = vi.fn().mockResolvedValue(ok({
        agentId: "agent-1",
        sections: [],
        combinedHash: computeWorkspacePolicyCombinedHash([]),
      }));
      const deps = createMockDeps({
        workspacePolicySnapshot: undefined,
        workspacePolicyPort: { load, get: vi.fn() },
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(
        testMessage,
        testSessionKey,
        [],
        undefined,
        "agent-1",
        undefined,
        undefined,
        { operationType: "taskExtraction", workspacePolicySnapshot: corrupted } as ExecutionOverrides,
      );

      expect(result.finishReason).toBe("error");
      expect(result.errorContext?.errorType).toBe("WorkspacePolicyError");
      expect(load).not.toHaveBeenCalled();
      expect(createAgentSession).not.toHaveBeenCalled();
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "workspace-policy-verify",
          failureKind: "content_hash_mismatch",
          hint: expect.any(String),
          errorKind: "validation",
        }),
        "Per-execution workspace policy snapshot verification failed",
      );
    });

    it("uses and reports the exact captured response locale policy for delayed work", async () => {
      const responseLocalePolicy = {
        locale: "en",
        source: "explicit" as const,
        enforceLocale: true,
      };
      const executor = createPiExecutor(testConfig, createMockDeps());

      const result = await executor.execute(
        testMessage,
        testSessionKey,
        [],
        undefined,
        "agent-1",
        undefined,
        undefined,
        { operationType: "heartbeat", responseLocalePolicy },
      );

      expect(result.responseLocalePolicy).toEqual(responseLocalePolicy);
    });

    it("rejects an invalid captured response locale policy before model dispatch", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(
        testMessage,
        testSessionKey,
        [],
        undefined,
        "agent-1",
        undefined,
        undefined,
        {
          operationType: "heartbeat",
          responseLocalePolicy: { locale: "not a locale", source: "explicit", enforceLocale: true },
        } as ExecutionOverrides,
      );

      expect(result.finishReason).toBe("error");
      expect(result.errorContext?.errorType).toBe("ResponseLocalePolicyError");
      expect(createAgentSession).not.toHaveBeenCalled();
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "response-locale-policy-verify",
          hint: expect.any(String),
          errorKind: "validation",
        }),
        "Per-execution response locale policy verification failed",
      );
    });

    it("stops before model dispatch when workspace policy loading fails", async () => {
      const load = vi.fn().mockResolvedValue(err({
        kind: "agent_not_found" as const,
        agentId: "agent-1",
      }));
      const deps = createMockDeps({
        workspacePolicySnapshot: undefined,
        workspacePolicyPort: { load, get: vi.fn() },
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      expect(result.errorContext?.errorType).toBe("WorkspacePolicyError");
      expect(createAgentSession).not.toHaveBeenCalled();
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "workspace-policy-load",
          hint: expect.any(String),
          errorKind: "precondition",
        }),
        "Workspace policy snapshot load failed",
      );
    });

    it("stops before model dispatch when no workspace policy source is configured", async () => {
      const deps = createMockDeps({
        workspacePolicySnapshot: undefined,
        workspacePolicyPort: undefined,
      });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.finishReason).toBe("error");
      expect(result.errorContext?.errorType).toBe("WorkspacePolicyError");
      expect(createAgentSession).not.toHaveBeenCalled();
    });

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
          modelRuntime: deps.modelRuntime,
          customTools: deps.customTools,
        }),
      );
    });

    // A `spawn --worktree` child runs IN an isolated git worktree, so the
    // SDK session cwd (the file-tool jail for exec/read/write/edit) MUST be the
    // worktree dir, NOT the agent's shared workspace. ExecutionOverrides.workspaceDir
    // carries the per-run override; absent ⇒ deps.workspaceDir (byte-identical).
    it("uses overrides.workspaceDir as the SDK session cwd when provided", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const worktreeDir = `${deps.workspaceDir}/.worktrees/wt-run-xyz`;

      await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        undefined, undefined,
        { workspaceDir: worktreeDir } as never,
      );

      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: worktreeDir }),
      );
    });

    // Regression test: the SDK's `tools` field is an allowlist of tool *names*.
    // Empty array disables ALL tools (including customTools), which left the
    // agent tool-less from every entry point — fixed by passing customTool
    // names so the SDK whitelists exactly Comis's customTools and filters out
    // built-ins like `bash` that conflict with our policy controls.
    // See pi-executor.ts above the createAgentSession call for the full chain.
    it("passes customTool names as the SDK's tools allowlist (regression)", async () => {
      const customTools = [
        { name: "exec", description: "Run shell commands", parameters: {} },
        { name: "read", description: "Read a file", parameters: {} },
        { name: "memory_store", description: "Store memory", parameters: {} },
      ];
      const deps = createMockDeps({ customTools: customTools as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const call = (createAgentSession as Mock).mock.calls[0]![0]!;
      // Allowlist must be the exact set of customTool names (order-independent).
      expect(call.tools).toEqual(expect.arrayContaining(["exec", "read", "memory_store"]));
      expect(call.tools).toHaveLength(customTools.length);
    });

    it("does NOT pass an empty tools allowlist when customTools is non-empty (regression)", async () => {
      const customTools = [
        { name: "exec", description: "Run shell commands", parameters: {} },
      ];
      const deps = createMockDeps({ customTools: customTools as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const call = (createAgentSession as Mock).mock.calls[0]![0]!;
      // Empty array would mean "allow zero tools" to the SDK — the bug we fixed.
      expect(call.tools).not.toEqual([]);
      expect(call.tools.length).toBeGreaterThan(0);
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

    it("mirrors the exact preprocessed inbound provenance plan before model dispatch", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const rawMessage = { ...testMessage, text: "raw initial body" } as NormalizedMessage;
      const processedMessage = { ...testMessage, text: "processed model body" } as NormalizedMessage;
      const recordedAt = Date.parse("2026-03-12T00:00:00.000Z");
      const overrides = makeInboundProvenanceOverrides(rawMessage, recordedAt);

      await executor.execute(
        processedMessage,
        testSessionKey,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        overrides,
      );

      const expectedBatch = {
        schemaVersion: 1,
        batchId: rawMessage.id,
        chunkIndex: 0,
        chunkCount: 1,
        recordedAt,
        messages: [{
          id: rawMessage.id,
          channelId: rawMessage.channelId,
          channelType: rawMessage.channelType,
          senderId: rawMessage.senderId,
          text: rawMessage.text,
          timestamp: rawMessage.timestamp,
        }],
      };
      expect(mockAppendInboundMessageLedger).not.toHaveBeenCalled();
      expect(mockAppendCustomEntry).toHaveBeenCalledTimes(2);
      expect(mockAppendCustomEntry).toHaveBeenNthCalledWith(
        1,
        INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
        expectedBatch,
      );
      expect(mockAppendCustomEntry).toHaveBeenNthCalledWith(
        2,
        INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
        expectedBatch,
      );
      expect(mockAppendCustomEntry.mock.invocationCallOrder[0]).toBeLessThan(
        mockPrompt.mock.invocationCallOrder[0]!,
      );
      expect(mockAppendCustomEntry.mock.invocationCallOrder[1]).toBeLessThan(
        mockPrompt.mock.invocationCallOrder[0]!,
      );
    });

    it("stops model dispatch when inbound provenance cannot be persisted", async () => {
      mockAppendCustomEntry.mockImplementationOnce(() => {
        throw new Error("session disk unavailable");
      });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        undefined, undefined, makeInboundProvenanceOverrides(testMessage),
      );

      expect(mockPrompt).not.toHaveBeenCalled();
      expect(result.finishReason).toBe("error");
      expect(result.response).toBe("The message could not be saved safely. Please try again.");
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "session-provenance",
          errorKind: "resource",
          hint: expect.stringContaining("session-storage limits"),
        }),
        "Inbound message provenance persistence failed",
      );
    });

    it("contains a provenance failure whose Error message accessor is hostile", async () => {
      const hostile = new Error("placeholder");
      Object.defineProperty(hostile, "message", {
        get() { throw new Error("message accessor escaped"); },
      });
      mockAppendCustomEntry.mockImplementationOnce(() => {
        throw hostile;
      });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        undefined, undefined, makeInboundProvenanceOverrides(testMessage),
      );

      expect(result.finishReason).toBe("error");
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "session-provenance",
          err: "[unreadable error message]",
        }),
        "Inbound message provenance persistence failed",
      );
    });

    it("contains a provenance failure whose Error message accessor is not a string", async () => {
      const hostile = new Error("placeholder");
      Object.defineProperty(hostile, "message", {
        get() { return { untrusted: "not a string" }; },
      });
      mockAppendCustomEntry.mockImplementationOnce(() => {
        throw hostile;
      });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        undefined, undefined, makeInboundProvenanceOverrides(testMessage),
      );

      expect(result.finishReason).toBe("error");
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "session-provenance",
          err: "[unreadable error message]",
        }),
        "Inbound message provenance persistence failed",
      );
    });

    it("redacts credentials and URLs from provenance failure logs", async () => {
      const credential = `xoxb-${"s".repeat(32)}`;
      mockAppendCustomEntry.mockImplementationOnce(() => {
        throw new Error(`write failed at https://private.example/session with ${credential}`);
      });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        undefined, undefined, makeInboundProvenanceOverrides(testMessage),
      );

      expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain(credential);
      expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain("private.example");
    });

    it("stops model dispatch when the adjacent provenance marker cannot be persisted", async () => {
      mockAppendCustomEntry
        .mockReturnValueOnce("early-provenance-entry")
        .mockImplementationOnce(() => {
          throw new Error("session disk became unavailable");
        });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        undefined, undefined, makeInboundProvenanceOverrides(testMessage),
      );

      expect(mockAppendCustomEntry).toHaveBeenCalledTimes(2);
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(result.finishReason).toBe("error");
      expect(result.response).toBe("The message could not be saved safely. Please try again.");
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "session-provenance",
          errorKind: "resource",
          hint: expect.stringContaining("session-storage limits"),
        }),
        "Inbound message provenance persistence failed",
      );
    });

    it("never appends the durable physical-message ledger from model execution", async () => {
      mockAppendInboundMessageLedger.mockReturnValueOnce({
        ok: false,
        error: new Error("ledger disk unavailable"),
      });
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      expect(mockAppendInboundMessageLedger).not.toHaveBeenCalled();
      expect(mockAppendCustomEntry).not.toHaveBeenCalled();
      expect(mockPrompt).toHaveBeenCalledOnce();
      expect(result.finishReason).toBe("stop");
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

    it.each([
      ["enabled", testConfig],
      ["disabled", {
        ...testConfig,
        contextEngine: { enabled: false, thinkingKeepTurns: 10, historyTurns: 15 },
      } as PerAgentConfig],
    ])("projects pending delivered history when the context engine is %s", async (_mode, config) => {
      const conversation = {
        tenantId: testSessionKey.tenantId,
        agentId: "agent-1",
        partition: { kind: "agent" as const },
      };
      const conversationRef = createConversationRef(conversation);
      if (!conversationRef.ok) throw conversationRef.error;
      const branch = [{
        type: "custom",
        customType: "delivered_assistant_history",
        data: {
          tenantId: testSessionKey.tenantId,
          agentId: "agent-1",
          conversationRef: conversationRef.value,
          sourceExecutionId: "execution_a",
          attemptId: "attempt_a",
          deliveredAtMs: 1_700_000_000_000,
          text: "pending-delivered-output",
          contentTrust: "derived",
        },
      }];
      const deps = createMockDeps({
        sessionAdapter: {
          withSession: vi.fn().mockImplementation(
            async (_sk: SessionKey, fn: (sm: any) => Promise<any>) => withTestTurnScope(
              "agent-1",
              async () => ok(await fn({
                buildSessionContext: vi.fn().mockReturnValue({ messages: [] }),
                getBranch: vi.fn().mockReturnValue(branch),
                appendMessage: vi.fn(),
                appendCustomEntry: mockAppendCustomEntry,
                getSessionDir: vi.fn().mockReturnValue("/tmp/test-session"),
              })),
            ),
          ),
          appendInboundMessageLedger: mockAppendInboundMessageLedger,
          persistInboundMessage: vi.fn().mockResolvedValue(ok({ payloads: [], ledgerContent: "" })),
          destroySession: vi.fn().mockResolvedValue(undefined),
        } as PiExecutorDeps["sessionAdapter"],
      });
      const executor = createPiExecutor(config, deps);

      await executor.execute(testMessage, testSessionKey);

      const overrideResult = mockResourceLoaderArgs.captured.systemPromptOverride("");
      expect(overrideResult).toContain("assembled system prompt");
      expect(overrideResult).toContain("pending-delivered-output");
      expect(overrideResult).toContain("not a new user request");
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

    // The per-execution token cap rides ExecutionOverrides.tokenBudget
    // into resetExecution(cap) — the child's BudgetGuard per-execution ceiling.
    it("passes overrides.tokenBudget to budgetGuard.resetExecution as the per-execution cap", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        undefined, undefined,
        { tokenBudget: 5_000 } as never,
      );

      expect(deps.budgetGuard.resetExecution).toHaveBeenCalledWith(5_000);
    });

    it("calls budgetGuard.resetExecution with no cap when overrides.tokenBudget is absent (byte-identical no-budget path)", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(deps.budgetGuard.resetExecution).toHaveBeenCalledWith(undefined);
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
      setMockAssistantText("fallback response");

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
      setMockAssistantText("first fallback response");

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
      const { PromptTimeoutError } = await import("../prompt-timeout.js");
      mockPrompt.mockRejectedValueOnce(new PromptTimeoutError(30000));

      const deps = createMockDeps({ fallbackModels: [] });
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(testMessage, testSessionKey);

      // The PromptTimeoutError terminal carries its OWN
      // named finishReason (END_REASON_MAP → endReason "timeout") instead of
      // flattening into the generic "error" bucket.
      expect(result.finishReason).toBe("prompt_timeout");
      expect(result.errorContext).toEqual({
        errorType: "PromptTimeout",
        retryable: true,
        originalError: expect.any(String),
      });
    });

    it("emits estimated observability:token_usage event on PromptTimeoutError", async () => {
      const { PromptTimeoutError } = await import("../prompt-timeout.js");
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
      const { PromptTimeoutError } = await import("../prompt-timeout.js");
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
      const { PromptTimeoutError } = await import("../prompt-timeout.js");
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
      const { PromptTimeoutError } = await import("../prompt-timeout.js");
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
      const { PromptTimeoutError } = await import("../prompt-timeout.js");
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
      // Rolled-up diagnostic counters replace per-event INFO emissions.
      expect(fields.hashAssertionsRan).toBeTypeOf("number");
      expect(fields.hashAssertionsRan).toBeGreaterThanOrEqual(0);
      expect(fields.hashAssertionMismatches).toBeTypeOf("number");
      expect(fields.hashAssertionMismatches).toBeGreaterThanOrEqual(0);
      expect(fields.signatureScrubs).toBeTypeOf("number");
      expect(fields.signatureScrubs).toBeGreaterThanOrEqual(0);
      expect(fields.signatureScrubsToolCallsAffected).toBeTypeOf("number");
      expect(fields.signatureScrubsToolCallsAffected).toBeGreaterThanOrEqual(0);
      // Provider attribution tag — unblocks operator queries
      // segmenting cache-hit-rate / cost by provider. Default mock returns
      // resolvedModel.provider === "anthropic", which maps to providerFamily
      // "anthropic" via PROVIDER_OVERRIDES in capabilities.ts.
      expect(fields.provider).toBe("anthropic");
      expect(fields.providerFamily).toBe("anthropic");
      expect(fields.provider).toBeTypeOf("string");
      expect(fields.providerFamily).toBeTypeOf("string");
    });

    // Silent-fallback path — operator INTENT semantics.
    // When modelRegistry.find returns undefined (e.g., misconfig:
    // provider:anthropic + model:gpt-5.5 doesn't resolve), pi-coding-agent
    // silently falls back to whatever built-in provider has env-var
    // credentials. That fallback target is opaque to us at this layer, so
    // we record the configured provider (operator INTENT) — the more
    // useful signal for cache-hit-rate segmentation than the opaque
    // resolved fallback target.
    it("falls back to config.provider when resolvedModel is undefined (silent-fallback misconfig path)", async () => {
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue(undefined),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await withTestTurnScope(deps.agentId, () =>
        executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId));

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const bookendCall = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Execution complete",
      );
      expect(bookendCall).toBeDefined();
      const [fields] = bookendCall!;
      // testConfig.provider === "anthropic" — the configured intent.
      expect(fields.provider).toBe("anthropic");
      // resolveProviderCapabilities("anthropic").providerFamily === "anthropic".
      expect(fields.providerFamily).toBe("anthropic");
    });

    // Post-resolution provider — codex example. When the
    // registry resolves to openai-codex, both fields reflect the
    // POST-resolution / POST-override provider, and providerFamily is
    // mapped via PROVIDER_OVERRIDES (openai-codex → "openai").
    it("providerFamily reflects post-resolution provider (codex example)", async () => {
      const deps = createMockDeps({
        modelRegistry: {
          find: vi.fn().mockReturnValue({ provider: "openai-codex", id: "gpt-5-codex" }),
          getAll: vi.fn().mockReturnValue([]),
          getAvailable: vi.fn().mockReturnValue([]),
        } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await withTestTurnScope(deps.agentId, () =>
        executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId));

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const bookendCall = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Execution complete",
      );
      expect(bookendCall).toBeDefined();
      const [fields] = bookendCall!;
      expect(fields.provider).toBe("openai-codex");
      expect(fields.providerFamily).toBe("openai");
    });

    // Zero-default test — ensures the four counter fields are
    // ALWAYS present in the payload (default 0) so downstream log consumers
    // can rely on them without `?? 0` shims.
    it("emits the four counters with zero defaults when nothing fired", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const bookendCall = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Execution complete",
      );
      expect(bookendCall).toBeDefined();
      const [fields] = bookendCall!;
      // No turn_start fired through the bridge in the default mock setup
      // (mockGetResult returns a hand-built result without counter fields), and
      // no scrubber emission triggered ceSetup. All four counters default to 0.
      expect(fields.hashAssertionsRan).toBe(0);
      expect(fields.hashAssertionMismatches).toBe(0);
      expect(fields.signatureScrubs).toBe(0);
      expect(fields.signatureScrubsToolCallsAffected).toBe(0);
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

    // -----------------------------------------------------------------------
    // L4 post-batch continuation integration
    // -----------------------------------------------------------------------

    it("emits postBatchContinuation log fields when handler fires after empty-final-after-tool-batch", async () => {
      // Conversation ending with an empty assistant turn after agents_manage
      // succeeded. pi-coding-agent session shape: tool results live in
      // role: "toolResult" entries (NOT role: "user" with tool_result blocks).
      mockSession.messages = [
        { role: "user", content: [{ type: "text", text: "create 1 agent" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll create it." },
            { type: "toolCall", id: "t1", name: "agents_manage", arguments: { action: "create", agent_id: "x" } },
          ],
        },
        { role: "toolResult", toolCallId: "t1", toolName: "agents_manage", content: [{ type: "text", text: "ok" }], isError: false },
        { role: "assistant", content: [] }, // EMPTY final turn — triggers L4
      ];

      // Bridge result tuned so the upstream silent-failure handlers
      // (the strip-and-retry recovery in prompt-runner/silent-failure-handlers.ts
      // and the all-thinking continuation in prompt-runner/output-escalation.ts)
      // BOTH skip — letting L4 be the one that fires:
      //   - textEmitted: true   → silent-failure recovery skips (treats empty
      //                            final after text in earlier turns as expected).
      //   - stepsExecuted: 0    → all-thinking continuation skips.
      //   - llmCalls: 1, finishReason: "stop" → not stuck-session.
      // L4's detection reads session.messages directly (not the bridge
      // step counter), so the toolCall in our pre-populated messages still
      // triggers detection.
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
        textEmitted: true,
      });

      // First read returns "" (triggers L4); after the continuation pushes the
      // recovered turn, getVisibleAssistantText reads it directly from
      // session.messages (since the latest assistant has a visible text
      // block, phase-filter's getVisibleAssistantText returns it).
      mockGetLastAssistantText.mockReturnValue("");
      mockPrompt.mockImplementation(async (text: string) => {
        if (text.includes("post-batch continuation")) {
          mockSession.messages.push({
            role: "assistant",
            content: [{ type: "text", text: "done!" }],
          });
          mockGetLastAssistantText.mockReturnValue("done!");
        }
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const bookendCall = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Execution complete",
      );
      expect(bookendCall).toBeDefined();
      const fields = bookendCall![0];

      expect(fields).toMatchObject({
        postBatchContinuationFired: true,
        postBatchContinuationAttempts: 1,
        postBatchContinuationOutcome: "recovered",
      });
      expect(mockPrompt).toHaveBeenCalledWith(
        expect.stringContaining("post-batch continuation"),
        { expandPromptTemplates: false, source: "extension" },
      );
    });

    it("emits sepStepsPlanned/sepStepsCompleted; does NOT emit sepNudgeTriggered (SEP observability after L4 downgrade)", async () => {
      // Inject a synthetic SEP plan into executionPlanRef.current via the
      // bridge mock. executor-post-execution.ts:339 reads the ref to
      // populate result.plannerMetrics, which feeds the bookend log.
      (createPiEventBridge as Mock).mockImplementationOnce((opts: any) => {
        if (opts.executionPlan) {
          opts.executionPlan.current = {
            active: true,
            request: "do work",
            steps: [
              { index: 1, description: "Step A", status: "done" },
              { index: 2, description: "Step B", status: "done" },
              { index: 3, description: "Step C", status: "pending" },
            ],
            completedCount: 2,
            createdAtMs: Date.now(),
          };
        }
        return {
          listener: mockBridgeListener,
          getResult: mockGetResult,
          addGhostCost: vi.fn(),
          // Same drain-state stub as the top-level mock so the per-test
          // override in this it() block matches the PostExecutionBridge interface.
          getDrainState: () => ({ drainInflightByKey: new Map<string, Promise<void>>() }),
          // Per-turn skill-use carrier read-back (empty in the mock).
          getUsedSkillIds: () => new Set<string>(),
          hasOutboundDelivery: vi.fn().mockReturnValue(false),
        };
      });

      // Normal flow: assistant emits visible text, no L4 trigger.
      mockSession.messages = [
        { role: "user", content: [{ type: "text", text: "do work" }] },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ];
      mockGetLastAssistantText.mockReturnValue("Done.");

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const bookendCall = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Execution complete",
      );
      expect(bookendCall).toBeDefined();
      const fields = bookendCall![0];

      // POSITIVE pin (observability preserved — uses actual tool-call count,
      // not prose-extracted step count, to avoid over-counting):
      expect(fields).toMatchObject({
        sepStepsPlanned: 2,
        sepStepsCompleted: 2,
      });

      // ABSENCE pin (enforcement-mode field gone):
      expect("sepNudgeTriggered" in fields).toBe(false);
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

      const result = await withTestTurnScope(deps.agentId, () =>
        executor.execute(testMessage, testSessionKey));

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

      const result = await withTestTurnScope(deps.agentId, () =>
        executor.execute(testMessage, testSessionKey));

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

    it("returns a visible failure when an interactive completion stays empty", async () => {
      // getVisibleAssistantText reads mockSession.messages directly
      // (no SDK delegation). An empty-content assistant — e.g. provider
      // returned no text blocks — must yield "".
      setMockAssistantText("");
      // Set llmCalls=1 and textEmitted=true so neither
      // stuck session detection nor silent failure detection triggers.
      // This test covers the edge case where the assistant has empty content
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

      expect(result.response).toBe(INTERACTIVE_SILENT_FAILURE_RESPONSE);
      expect(result.finishReason).toBe("error");
      expect(mockPrompt).toHaveBeenCalledWith(
        expect.stringContaining("no response was delivered"),
        { expandPromptTemplates: false, source: "extension" },
      );
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

    it("runs repairOrphanedMessages AFTER the scrubs so it validates the post-scrub tree", async () => {
      // The scrubs (scrubPoisonedThinkingBlocks / scrubRedactedToolCalls) mutate
      // the session tree; if repair runs BEFORE them, a scrub-induced anomaly is
      // left unrepaired while the detector (which runs on the post-scrub
      // buildSessionContext) flags it forever (live incident 2026-07-08: the
      // idx-47 anomaly was detected every turn but never repaired). Repair must
      // see the same post-scrub state the detector validates.
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      await executor.execute(testMessage, testSessionKey);

      const repairOrder = (repairOrphanedMessages as Mock).mock.invocationCallOrder[0]!;
      const scrubPoisonOrder = (scrubPoisonedThinkingBlocks as Mock).mock.invocationCallOrder[0]!;
      const scrubRedactOrder = (scrubRedactedToolCalls as Mock).mock.invocationCallOrder[0]!;
      expect(scrubPoisonOrder).toBeLessThan(repairOrder);
      expect(scrubRedactOrder).toBeLessThan(repairOrder);
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
      setMockAssistantText("rotated key response");

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
      setMockAssistantText("fallback response");

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
      setMockAssistantText("fallback model response");

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
      setMockAssistantText("fallback response");

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
      setMockAssistantText("fallback response");

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

      // tokensUsed is the PER-EXECUTION bridge total (scope-consistent with
      // cost); the SDK's CUMULATIVE session stats ride sessionTokensUsed.
      expect(result.tokensUsed).toEqual({ input: 100, output: 50, total: 150 });
      expect(result.sessionTokensUsed).toEqual({ input: 100, output: 50, total: 150, cacheRead: 0, cacheWrite: 0 });
      expect(result.cost).toEqual({ total: 0.01 });
      expect(result.stepsExecuted).toBe(2);
      expect(result.llmCalls).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Full prompt assembly
  // -------------------------------------------------------------------------

  describe("full prompt assembly", () => {
    it("passes policy inputs to the compiler and inbound state to the dynamic section builder", async () => {
      const deps = createMockDeps({
        secretManager: { get: vi.fn().mockReturnValue("canary-secret-123") } as any,
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

      expect(mockAssembleRichSystemPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          promptMode: "full",
        }),
      );
      const compilerInput = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(compilerInput).not.toHaveProperty("runtimeInfo");
      expect(compilerInput).not.toHaveProperty("inboundMeta");
      expect(mockBuildInboundMetadataSection).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: testMessage.id,
          senderId: "user1",
          chatId: "c1",
          channel: "test",
          chatType: "dm",
          flags: expect.any(Object),
        }),
        false,
      );
    });

    it("compiles bootstrap files from the captured workspace snapshot without rereading the workspace", async () => {
      const mockContextFiles = [
        { path: "SOUL.md", content: "soul content" },
      ];
      mockBuildBootstrapContextFiles.mockReturnValueOnce(mockContextFiles);

      const deps = createMockDeps({
        workspacePolicySnapshot: {
          agentId: "agent-1",
          combinedHash: "b".repeat(64),
          sections: [{
            id: "workspace:soul",
            sourceKind: "operator",
            trust: "trusted",
            stability: "stable",
            content: "soul content",
            contentHash: "c".repeat(64),
            maxChars: 100,
          }],
        },
      });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockLoadWorkspaceBootstrapFiles).not.toHaveBeenCalled();
      expect(mockBuildBootstrapContextFiles).toHaveBeenCalledWith(
        [expect.objectContaining({ name: "SOUL.md", content: "soul content" })],
        expect.objectContaining({ maxChars: 20_000 }),
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

      // rerank/scoring are read by createMemoryRecall; rerank OFF keeps the default
      // pool size (limit = maxResults) and fusion order.
      const ragConfig = {
        enabled: true, maxResults: 5, minScore: 0.5, maxContextChars: 5000, includeTrustLevels: ["system"],
        rerank: { mode: "off", maxCandidates: 40, minResults: 1, timeoutMs: 800 },
        scoring: { recencyAlpha: 0.2, temporalAlpha: 0.2, proofAlpha: 0.1, trustAlpha: 0.1 },
      };
      const configWithRag = { ...testConfig, rag: ragConfig } as PerAgentConfig;
      const deps = createMockDeps({ memoryPort: mockMemoryPort as any });
      const executor = createPiExecutor(configWithRag, deps);

      await withTestTurnScope(deps.agentId, () =>
        executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId));

      // Recall resolves results via MemoryPort.search + the hybrid injector.
      // With rerank OFF the search limit is maxResults (default pool size unchanged).
      expect(mockMemoryPort.search).toHaveBeenCalledWith(
        {
          tenantId: testSessionKey.tenantId,
          agentId: deps.agentId,
          principalId: testSessionKey.userId,
          conversationRef: expect.stringMatching(/^cv_/),
          includeAgentShared: true,
        },
        "hello world",
        { limit: 5, minScore: 0.5 },
      );
      expect(mockCreateHybridMemoryInjector).toHaveBeenCalled();
      const compilerInput = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(compilerInput).not.toHaveProperty("additionalSections");
    });

    it("RAG retrieval failure is non-fatal", async () => {
      const mockMemoryPort = {
        search: vi.fn().mockRejectedValue(new Error("Memory search failed")),
        store: vi.fn(),
      };

      const ragConfig = {
        enabled: true, maxResults: 5, minScore: 0.5, maxContextChars: 5000, includeTrustLevels: ["system"],
        rerank: { mode: "off", maxCandidates: 40, minResults: 1, timeoutMs: 800 },
        scoring: { recencyAlpha: 0.2, temporalAlpha: 0.2, proofAlpha: 0.1, trustAlpha: 0.1 },
      };
      const configWithRag = { ...testConfig, rag: ragConfig } as PerAgentConfig;
      const deps = createMockDeps({ memoryPort: mockMemoryPort as any });
      const executor = createPiExecutor(configWithRag, deps);

      const result = await withTestTurnScope(deps.agentId, () =>
        executor.execute(testMessage, testSessionKey));

      // Execution should still complete successfully
      expect(result.finishReason).toBe("stop");
      expect(result.response).toBe("test response");
      // Recall failure logged as warn (non-fatal). A rejected memoryPort.search
      // surfaces as an err Result inside recall -> the caller's catch logs it.
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ hint: expect.any(String), errorKind: "dependency" }),
        "RAG recall failed (non-fatal)",
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

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

      expect(mockHookRunner.runBeforeAgentStart).toHaveBeenCalledWith(
        { systemPrompt: "assembled system prompt", messages: [] },
        expect.objectContaining({
          agentId: deps.agentId,
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

    it("uses custom tools structurally without turning their names into prompt prose", async () => {
      const customTools = [
        { name: "memory_store", description: "Store memory", parameters: {} },
        { name: "memory_search", description: "Search memory", parameters: {} },
        { name: "bash", description: "Run bash", parameters: {} },
      ];
      const deps = createMockDeps({ customTools: customTools as any });
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(mockSetActiveToolsByName).toHaveBeenCalledWith([
        "memory_store", "memory_search", "bash",
      ]);
      const compilerInput = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(compilerInput).not.toHaveProperty("toolNames");
      expect(compilerInput).not.toHaveProperty("hasMemoryTools");
    });

    it("keeps channel and reaction presentation state out of compiler configuration", async () => {
      const configWithReaction = {
        ...testConfig,
        reactionLevel: "extensive" as const,
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithReaction, deps);

      await executor.execute(testMessage, testSessionKey);

      const compilerInput = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(compilerInput).not.toHaveProperty("channelContext");
      expect(compilerInput).not.toHaveProperty("reactionLevel");
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
          provider: { maxRetryDelayMs: 60000 },
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
          provider: { maxRetryDelayMs: 60000 },
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
          provider: { maxRetryDelayMs: 60000 },
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
            provider: { maxRetryDelayMs: 30000 },
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
            provider: { maxRetryDelayMs: 60000 },
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
            provider: { maxRetryDelayMs: 60000 },
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
      expect(registeredKey).toMatch(/^cv_/);
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

      expect(mockRegistry.deregister).toHaveBeenCalledWith(expect.stringMatching(/^cv_/));
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

      expect(mockRegistry.deregister).toHaveBeenCalledWith(expect.stringMatching(/^cv_/));
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

    it("pre-aborted execution signal prevents model dispatch and emits the authoritative abort", async () => {
      const controller = new AbortController();
      controller.abort();
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const result = await executor.execute(
        testMessage,
        testSessionKey,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { operationType: "cron", signal: controller.signal },
      );

      expect(mockPrompt).not.toHaveBeenCalled();
      expect(result.finishReason).toBe("prompt_timeout");
      expect(deps.eventBus.emit).toHaveBeenCalledWith("execution:aborted", {
        sessionKey: testSessionKey,
        reason: "pipeline_timeout",
        agentId: "agent-1",
        timestamp: expect.any(Number),
      });
    });

    it("execution signal aborts the live SDK session and unregisters its listener", async () => {
      const controller = new AbortController();
      let releasePrompt!: () => void;
      mockPrompt.mockImplementationOnce(() => new Promise<void>((resolve) => {
        releasePrompt = resolve;
      }));
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      const executing = executor.execute(
        testMessage,
        testSessionKey,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { operationType: "cron", signal: controller.signal },
      );
      await vi.waitFor(() => expect(mockPrompt).toHaveBeenCalledTimes(1));

      controller.abort();
      await vi.waitFor(() => expect(mockAbort).toHaveBeenCalledTimes(1));
      expect(mockAbortCompaction).toHaveBeenCalledTimes(1);
      releasePrompt();
      await executing;

      mockAbort.mockClear();
      controller.abort();
      await Promise.resolve();
      expect(mockAbort).not.toHaveBeenCalled();
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
          conversationRef: expect.stringMatching(/^cv_/),
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

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

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
  // Image passthrough vision gating
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

      await executor.execute(messageWithImages, testSessionKey, undefined, undefined, deps.agentId);

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

      await executor.execute(messageWithImages, testSessionKey, undefined, undefined, deps.agentId);

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

      const result = await executor.execute(messageWithImages, testSessionKey, undefined, undefined, deps.agentId);

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

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

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
  // No pruner/budget-guard wrapper tests: the wrapper chain contains no
  // progressive context pruner or budget-guard wrapper -- observation masking
  // covers context reduction.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Conditional JSONL trace wrappers
  // -------------------------------------------------------------------------

  describe("conditional JSONL trace wrappers", () => {
    it("does not add trace wrappers when tracing is disabled (default)", async () => {
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

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
      // +1 for ttlGuard, +1 for toolCallRepairWrapper, +1 for stubFilterInjector (now 8)
      expect(composedLog![0].wrapperCount).toBe(8);
    });

    it("adds the api-payload trace wrapper when tracing.enabled is true", async () => {
      const configWithTracing = {
        ...testConfig,
        tracing: { enabled: true, outputDir: "/tmp/test-traces" },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithTracing, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

      // "JSONL api-payload tracing enabled" INFO log should be emitted.
      // Tracing is split across two artifacts: api-payload remains under
      // `agents.<name>.tracing.enabled`; the cache-trace lives under
      // `diagnostics.cacheTrace.enabled`.
      const infoCalls = (deps.logger.info as Mock).mock.calls;
      const traceLog = infoCalls.find(
        ([_fields, msg]: [any, string]) => msg === "JSONL api-payload tracing enabled",
      );
      expect(traceLog).toBeDefined();
      expect(traceLog![0]).toMatchObject({
        outputDir: "/tmp/test-traces",
      });
      // cacheTracePath is no longer logged here — it lives under
      // diagnostics.cacheTrace.enabled now.
      expect(traceLog![0].cacheTracePath).toBeUndefined();
      expect(traceLog![0].apiPayloadPath).toContain("/tmp/test-traces/");
      expect(traceLog![0].apiPayloadPath).toContain(".api-payload.jsonl");

      // Should have 9 wrappers applied (8 base incl. toolCallRepairWrapper + 1 api-payload trace)
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

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

      // Verify wrapper names from the summary log.
      // wrapperNames array order matches the wrappers array (outermost first):
      // ttlGuard, toolCallRepairWrapper, validationErrorFormatter,
      //   toolResultSizeBouncer, turnResultBudget, configResolver, requestBodyInjector,
      //   cacheTraceWriter, apiPayloadTraceWriter
      // (toolCallRepairWrapper sits between ttlGuard and validationErrorFormatter)
      const debugCalls = (deps.logger.debug as Mock).mock.calls;
      const composedLog = debugCalls.find(
        ([_fields, msg]: [any, string]) => msg === "Stream wrappers composed",
      );
      expect(composedLog).toBeDefined();

      const wrapperNames = composedLog![0].wrapperNames as string[];
      // cacheTraceWriter is not in this chain — the cache-trace
      // artifact is independently gated by
      // `diagnostics.cacheTrace.enabled` (not set in this test).
      expect(wrapperNames).toEqual([
        "ttlGuard",
        "toolCallRepairWrapper",
        "validationErrorFormatter",
        "toolResultSizeBouncer",
        "turnResultBudget",
        "configResolver",
        "requestBodyInjector",
        "apiPayloadTraceWriter",
        "stubFilterInjector",
      ]);

      // api-payload-trace wrapper is innermost (closest to base SDK streamFn),
      // meaning it sees the final options including injected cacheRetention.
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
      // +1 for ttlGuard, +1 for toolCallRepairWrapper, +1 for stubFilterInjector (now 8)
      expect(composedLog![0].wrapperCount).toBe(8);
    });

    it("passes sessionId (formattedKey) to the api-payload trace wrapper", async () => {
      const configWithTracing = {
        ...testConfig,
        tracing: { enabled: true, outputDir: "/tmp/test-traces" },
      } as PerAgentConfig;
      const deps = createMockDeps();
      const executor = createPiExecutor(configWithTracing, deps);

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

      // Exercise the wrapped streamFn -- triggers the api-payload trace writer.
      const wrappedStreamFn = mockSession.agent.streamFn;
      const model = { id: "claude-test", provider: "anthropic" } as any;
      const context = { systemPrompt: "test", messages: [], tools: [] };
      wrappedStreamFn(model, context, {});

      // Only the api-payload trace fires under the legacy
      // `tracing.enabled` flag — cache-trace is independently gated.
      const jsonlCalls = mockAppendFileSync.mock.calls;
      expect(jsonlCalls.length).toBeGreaterThanOrEqual(1);

      const expectedSessionId = "t1:agent:agent-1:u1:c1";

      const apiPayloadLine = JSON.parse((jsonlCalls[0][1] as string).trim());
      expect(apiPayloadLine.type).toBe("api_payload");
      expect(apiPayloadLine.sessionId).toBe(expectedSessionId);
      expect(apiPayloadLine.agentId).toBe(deps.agentId);
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

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

      // Exercise the wrapped streamFn -- this triggers the api-payload
      // trace writer, which calls appendJsonlLine -> rotation check ->
      // statSync (legacy rotation lives in api-payload-trace-writer).
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

    it("removes configured tools and prompt capabilities for an isolated model execution", async () => {
      const getPromptSkillsXml = vi.fn(() => "<skills>must-not-appear</skills>");
      const getPromptSkillLocations = vi.fn(() => new Map([["/skill", "must-not-appear"]]));
      const getMcpServerInstructions = vi.fn(() => [{
        serverName: "example",
        instructions: "must not appear",
      }]);
      const configWithDiscovery = {
        ...testConfig,
        skills: { discoveryPaths: ["/configured/skills"], promptSkills: {} },
      } as PerAgentConfig;
      const deps = createMockDeps({
        customTools: [{ name: "exec", description: "Execute", parameters: {} }] as any,
        getPromptSkillsXml,
        getPromptSkillLocations,
        getMcpServerInstructions,
      });
      const executor = createPiExecutor(configWithDiscovery, deps);

      await executor.execute(
        testMessage,
        testSessionKey,
        [],
        undefined,
        "agent-1",
        undefined,
        undefined,
        { operationType: "taskExtraction", capabilityAccess: "none" } as ExecutionOverrides,
      );

      expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ customTools: [] }));
      expect(mockSetActiveToolsByName).toHaveBeenCalledWith([]);
      expect(getPromptSkillsXml).not.toHaveBeenCalled();
      expect(getPromptSkillLocations).not.toHaveBeenCalled();
      expect(getMcpServerInstructions).not.toHaveBeenCalled();
      expect(mockResourceLoaderArgs.captured).toMatchObject({
        additionalSkillPaths: [],
        noSkills: true,
      });
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

      await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

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

      await withTestTurnScope(deps.agentId, () =>
        executor.execute(memoryTestMessage, testSessionKey, undefined, undefined, deps.agentId));

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

      const result = await withTestTurnScope(deps.agentId, () =>
        executor.execute(memoryTestMessage, testSessionKey));

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

      await withTestTurnScope(deps.agentId, () => executor.execute(thresholdMsg, testSessionKey));

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
      return withTestTurnScope(deps.agentId, () => executor.execute(
        msg, testSessionKey, undefined, undefined, deps.agentId,
        undefined, undefined,
        { operationType } as any,
      ));
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
    // Source traceability
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
      // Simulate: prompt resolves without throwing, but getVisibleAssistantText returns ""
      // (empty assistant content) and bridge reports llmCalls > 0 with finishReason "error".
      // The silent failure recovery will strip empty turns and retry via model retry,
      // but the retry also produces empty -- ultimately declares terminal failure.
      setMockAssistantText("");
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
      // Normal case: assistant has real content
      setMockAssistantText("normal response");
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

    it("does not treat intermediate model text as delivery proof when the final response is empty", async () => {
      // Simulate: multi-turn agentic loop where text was produced in an
      // intermediate turn but the final assistant has no visible text
      // (empty final turn after bookkeeping tool call like memory_store).
      setMockAssistantText("");
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

      expect(result.finishReason).toBe("error");
      expect(result.response).toBe(INTERACTIVE_SILENT_FAILURE_RESPONSE);

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
    it("retries with a continuation turn when finishReason is stop and tool calls were made", async () => {
      // initial check returns "" triggering the block. After continuation, the
      // assistant message in mockSession.messages contains "recovered response"
      // for the continuation re-check and all subsequent reads
      // (getVisibleAssistantText reads messages directly, so we wire the
      // recovery via the prompt mock pushing a new assistant).
      setMockAssistantText("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 4,
        finishReason: "stop",
      });
      mockPrompt.mockImplementation(async (text: string) => {
        if (text === "(continued from previous message)") {
          setMockAssistantText("recovered response");
        }
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.response).toBe("recovered response");
      expect(result.finishReason).not.toBe("error");
      expect(mockPrompt).toHaveBeenCalledWith(
        "(continued from previous message)",
        { expandPromptTemplates: false, source: "extension" },
      );
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
      expect(mockPrompt).not.toHaveBeenCalledWith(
        "(continued from previous message)",
        { expandPromptTemplates: false, source: "extension" },
      );
    });

    it("retries with a continuation turn when thinking-only with zero tool calls", async () => {
      // initial check returns "" triggering the block. After continuation, the
      // assistant message in mockSession.messages contains "recovered response".
      setMockAssistantText("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
      });
      mockPrompt.mockImplementation(async (text: string) => {
        if (text === "(continued from previous message)") {
          setMockAssistantText("recovered response");
        }
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.response).toBe("recovered response");
      expect(result.finishReason).not.toBe("error");
      expect(mockPrompt).toHaveBeenCalledWith(
        "(continued from previous message)",
        { expandPromptTemplates: false, source: "extension" },
      );
    });

    it("falls through to failure when the zero-tool continuation stays empty", async () => {
      // Assistant content always empty — even after continuation
      setMockAssistantText("");
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
      expect(mockPrompt).toHaveBeenCalledWith(
        "(continued from previous message)",
        { expandPromptTemplates: false, source: "extension" },
      );
    });

    it("falls through to failure when the continuation also produces an empty response", async () => {
      // Assistant content always empty — even after continuation
      setMockAssistantText("");
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
      expect(mockPrompt).toHaveBeenCalledWith(
        "(continued from previous message)",
        { expandPromptTemplates: false, source: "extension" },
      );
    });

    it("strips empty assistant turn and retries via model retry on silent failure (recovery succeeds)", async () => {
      // First prompt: finishReason "stop" but empty text (thinking-only response).
      // The continuation also stays empty. Strip the empty assistant turn and re-enter model retry.
      // Second prompt: returns "recovered text".
      // getVisibleAssistantText reads mockSession.messages directly,
      // so we drive the recovery via mockPrompt's mockImplementation: the second
      // prompt call replaces messages with the recovered text.
      let promptCallCount = 0;
      mockPrompt.mockImplementation(async () => {
        promptCallCount++;
        if (promptCallCount === 3) {
          // Model retry — replace the thinking-only assistant with recovered text.
          mockSession.messages = [
            { role: "user", content: "hello", timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "text", text: "recovered text" }],
              stopReason: "stop",
              timestamp: 3,
            },
          ];
        }
        return undefined;
      });

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
      // Initial turn + continuation attempt + model retry.
      expect(mockPrompt).toHaveBeenCalledTimes(3);

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
      // Initial turn + continuation attempt + model retry.
      expect(mockPrompt).toHaveBeenCalledTimes(3);
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
        .mockReturnValueOnce("") // after continuation
        .mockReturnValue("recovered text"); // after retry

      mockGetResult.mockReturnValue({
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.01 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop",
      });
      mockFollowUp.mockResolvedValue(undefined);

      // Simulate: user message + thinking-only assistant + continuation assistant (also thinking-only)
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
          content: [{ type: "thinking", thinking: "continuation thinking" }],
          stopReason: "stop",
          timestamp: 3,
        },
      ];

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      await executor.execute(testMessage, testSessionKey);

      // On the retry call (third prompt), the thinking-only assistant messages
      // should have been stripped. The snapshot should show only non-assistant messages.
      expect(messageSnapshots.length).toBe(3);
      const retryMessages = messageSnapshots[2];
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

      // Initial turn + one continuation + one model retry (no infinite loop).
      expect(mockPrompt).toHaveBeenCalledTimes(3);
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

    it("returns a visible failure when no assistant message has a text block", async () => {
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

      expect(result.response).toBe(INTERACTIVE_SILENT_FAILURE_RESPONSE);
      expect(result.finishReason).toBe("error");
    });

    it("preserves NO_REPLY after message-tool delivery to the request route", async () => {
      mockHasOutboundDelivery.mockReturnValue(true);
      mockGetLastAssistantText.mockReturnValue("NO_REPLY");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 3,
        finishReason: "stop",
        textEmitted: true,
      });
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

      expect(result.response).toBe("NO_REPLY");
      expect(result.response).not.toContain("Not bad!");
      expect(result.finishReason).not.toBe("error");
    });

    it("preserves HEARTBEAT_OK for a heartbeat operation", async () => {
      mockGetLastAssistantText.mockReturnValue("HEARTBEAT_OK");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 3,
        llmCalls: 3,
        finishReason: "stop",
        textEmitted: true,
      });
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
      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        undefined, undefined, { operationType: "heartbeat" },
      );

      expect(result.response).toBe("HEARTBEAT_OK");
      expect(result.response).not.toContain("All systems are running normally.");
      expect(result.finishReason).not.toBe("error");
    });

    it("preserves HEARTBEAT_OK for heartbeat history containing NO_REPLY", async () => {
      mockGetLastAssistantText.mockReturnValue("HEARTBEAT_OK");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        stepsExecuted: 4,
        llmCalls: 4,
        finishReason: "stop",
        textEmitted: true,
      });
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
      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        undefined, undefined, { operationType: "heartbeat" },
      );

      expect(result.response).toBe("HEARTBEAT_OK");
      expect(result.response).not.toContain("Here is the analysis result.");
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

      // L3 cross-boundary guard: synthesis is bounded by userMessageIndex, so it
      // sees ONLY Execution 2's image_generate tool call. The pipeline status from
      // Execution 1 must NOT leak through into the synthesized summary.
      expect(result.response).toContain("tool-call summary recovered");
      expect(result.response).toContain("image_generate");
      expect(result.response).not.toContain("Pipeline status");
      expect(result.response).not.toContain("trading pipeline");
    });

    it("synthesizes tool-call summary instead of leaking framing/step prose (stock-scanner scenario)", async () => {
      // Final turn: empty → triggers recovery
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 800, output: 300, total: 1100 },
        cost: { total: 0.08 },
        stepsExecuted: 6,
        llmCalls: 6,
        finishReason: "stop",
        textEmitted: true,
      });
      // L3 stock-scanner update: the agent emitted step progress annotations
      // mixed with tool calls. Under L3 synthesis, recovery returns a structured
      // tool-call summary — neither the framing prose nor the step annotation
      // leaks through as the user-visible reply.
      // getVisibleAssistantText reads messages directly; the
      // "empty final turn" is modeled as a trailing assistant with no visible
      // content (was previously implied via SDK mock returning "").
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
        // Trailing empty assistant — the executor's "final turn empty" probe.
        { role: "assistant", content: [], stopReason: "stop", timestamp: 12 },
      ];
      // SDK mock kept in sync with messages — the SDK's tail walk would also
      // skip the empty assistant and return the prior text, but our reader no
      // longer delegates. Setting it preserves callsites that may still read
      // it as a defensive fallback elsewhere in the executor.
      mockGetLastAssistantText.mockReturnValue("");

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      // Positive: synthesis fires and lists the actual tools used.
      expect(result.response).toContain("tool-call summary recovered");
      expect(result.response).toContain("Completed 3 tool calls");
      expect(result.response).toContain("read");
      expect(result.response).toContain("exec");
      expect(result.response).toContain("sessions_spawn");
      // Negative: neither the framing prose nor the step annotations leak through.
      expect(result.response).not.toContain("I'm going to build");
      expect(result.response).not.toContain("Step 4/4");
      expect(result.response).not.toContain("sanity-testing");
    });

    it("synthesizes tool-call summary when no standalone text turns exist (replaces deleted pre-tool commentary fallback)", async () => {
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
      // All assistant turns with text also have tool calls — no standalone text.
      // Under L3, synthesis now returns a structured tool-call summary instead
      // of leaking the framing prose ("Let me handle that for you.").
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

      // Positive: synthesis output, NOT the framing prose.
      expect(result.response).toContain("tool-call summary recovered");
      expect(result.response).toContain("exec");
      // Negative: framing prose must NOT leak through.
      expect(result.response).not.toContain("Let me handle that for you.");
    });
  });

  // -------------------------------------------------------------------------
  // Late continuation after all-thinking execution
  // -------------------------------------------------------------------------

  describe("late continuation after all-thinking execution", () => {
    it("synthesis covers thinking-only-with-tools case before late continuation can fire", async () => {
      // L3 synthesis closes the late-continuation pathway for fixtures that
      // include tool calls: synthesis produces non-empty output, so the
      // `result.response === ""` precondition for late-continuation is false
      // and followUp is NOT called. The user gets immediate context (which
      // tools ran) instead of waiting for a follow-up nudge.

      mockGetLastAssistantText.mockReturnValue("");

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

      // Synthesis fires from the exec tool call.
      expect(result.response).toContain("tool-call summary recovered");
      expect(result.response).toContain("exec");
      expect(result.finishReason).not.toBe("error");
      // Late continuation is short-circuited — synthesis already filled in a
      // useful response.
      expect(mockFollowUp).not.toHaveBeenCalled();
    });

    it("returns a visible failure when late continuation remains silent", async () => {
      mockGetLastAssistantText.mockReturnValue("");
      mockGetResult.mockReturnValue({
        tokensUsed: { input: 500, output: 200, total: 700 },
        cost: { total: 0.05 },
        // stepsExecuted > 0 is the late-continuation precondition; here it
        // reflects internal LLM work (e.g. thinking deltas) without tool calls.
        stepsExecuted: 3,
        llmCalls: 4,
        finishReason: "stop",
        textEmitted: true,
      });

      // All assistant messages are thinking-only AND there are zero tool calls
      // in the current execution window. Synthesis is short-circuited (no tool
      // calls collected), standalone walk-backward finds no visible text →
      // recovery returns "" → late continuation fires.
      mockSession.messages = [
        { role: "user", content: "Process the data", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Processing data internally." },
          ],
          stopReason: "stop",
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Data processed." },
          ],
          stopReason: "stop",
          timestamp: 3,
        },
      ];
      mockFollowUp.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

      expect(result.response).toBe(INTERACTIVE_SILENT_FAILURE_RESPONSE);
      expect(result.finishReason).toBe("error");
      expect(mockPrompt).toHaveBeenCalledWith(
        "Please provide a visible response summarizing what you did.",
        { expandPromptTemplates: false, source: "extension" },
      );
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
      setMockAssistantText("Here is your answer.");
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
  // afterToolCall result handling
  // -------------------------------------------------------------------------

  describe("afterToolCall result handling", () => {
    it("appends an active declared alternative and blocks another call to the exhausted tool", async () => {
      registerToolMetadata("search_primary_fallback_test", {
        failureFallbacks: [{
          onErrorCode: "all_providers_failed",
          toolName: "browser_fallback_test",
          guidance: "Use browser_fallback_test next for the same query.",
        }],
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const afterToolCall = mockSession.agent.afterToolCall;
      const result = {
        content: [{ type: "text" as const, text: "{\"error\":\"all_providers_failed\"}" }],
        details: { error: "all_providers_failed" },
      };
      const replacement = await afterToolCall({
        toolCall: { name: "search_primary_fallback_test" },
        args: { query: "latest AI news" },
        result,
        isError: false,
        context: {
          tools: [
            { name: "search_primary_fallback_test" },
            { name: "browser_fallback_test" },
          ],
        },
      });

      expect(replacement).toEqual({
        content: [
          ...result.content,
          {
            type: "text",
            text: expect.stringContaining(
              "Use browser_fallback_test next for the same query.",
            ),
          },
        ],
      });
      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "tool-failure-alternative",
          toolName: "search_primary_fallback_test",
          alternativeToolName: "browser_fallback_test",
          errorCode: "all_providers_failed",
        }),
        "Added active alternative guidance to failed tool result",
      );

      const retryVerdict = await mockSession.agent.beforeToolCall({
        toolCall: { name: "search_primary_fallback_test" },
        args: { query: "different query" },
      });
      expect(retryVerdict).toEqual({
        block: true,
        reason: expect.stringContaining(
          "Use browser_fallback_test next for the same query.",
        ),
      });
    });

    it("does not append a declared alternative that is absent from the live tool set", async () => {
      registerToolMetadata("search_disabled_fallback_test", {
        failureFallbacks: [{
          onErrorCode: "all_providers_failed",
          toolName: "browser_disabled_fallback_test",
          guidance: "Use browser_disabled_fallback_test next for the same query.",
        }],
      });

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      const replacement = await mockSession.agent.afterToolCall({
        toolCall: { name: "search_disabled_fallback_test" },
        args: { query: "latest AI news" },
        result: {
          content: [{ type: "text" as const, text: "{\"error\":\"all_providers_failed\"}" }],
          details: { error: "all_providers_failed" },
        },
        isError: false,
        context: { tools: [{ name: "search_disabled_fallback_test" }] },
      });

      expect(replacement).toBeUndefined();
    });

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
      const { createMutationSerializer } = await import("../tool-parallelism.js");

      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);

      await executor.execute(testMessage, testSessionKey);

      expect(createMutationSerializer).toHaveBeenCalledOnce();
    });
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
      const mod = await import("../schema-stripping.js");
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
        tenantId: testSessionKey.tenantId,
        userId: "u1",
        sessionKey: formatSessionKey(testSessionKey),
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
        tenantId: "tenant-a",
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
        tenantId: "tenant-a",
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
          tenantId: "tenant-a",
          userId: "u1",
          sessionKey: "s1",
          traceId: crypto.randomUUID(),
          startedAt: Date.now(),
          totallyUnknownField: true,
        }),
      ).toThrow();
    });
  });

  describe("request context principal immutability", () => {
    it("rejects execution when the selected agent disagrees with resolved ALS identity", async () => {
      mockPrompt.mockClear();
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const deliveryOrigin = createDeliveryOrigin({
        channelType: "telegram",
        channelId: "chat_a",
        userId: "user_a",
        tenantId: "default",
      });
      const ctx = {
        tenantId: "default",
        userId: testSessionKey.userId,
        sessionKey: formatSessionKey(testSessionKey),
        agentId: "agent-a",
        traceId: crypto.randomUUID(),
        startedAt: Date.now(),
        trustLevel: "admin" as const,
        channelType: "telegram",
        deliveryOrigin,
      };

      const result = await runWithContext(ctx, () => executor.execute(
        testMessage,
        testSessionKey,
        undefined,
        undefined,
        "agent-b",
      ));

      expect(result.finishReason).toBe("error");
      expect(result.errorContext).toMatchObject({
        errorType: "RequestContextIdentityMismatch",
        retryable: false,
      });
      expect(ctx.agentId).toBe("agent-a");
      expect(ctx.trustLevel).toBe("admin");
      expect(ctx.deliveryOrigin).toBe(deliveryOrigin);
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(deps.authStorage.getApiKey).not.toHaveBeenCalled();
      expect(deps.eventBus.emit).toHaveBeenCalledWith("security:warn", expect.objectContaining({
        category: "request_context_identity_mismatch",
        agentId: "agent-b",
      }));
    });

    it("does not populate unresolved ALS agent identity from an execute argument", async () => {
      mockPrompt.mockClear();
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const ctx = {
        tenantId: "default",
        userId: testSessionKey.userId,
        sessionKey: formatSessionKey(testSessionKey),
        traceId: crypto.randomUUID(),
        startedAt: Date.now(),
        trustLevel: "user" as const,
      };

      let inScopeAgentId: string | undefined;
      await runWithContext(ctx, async () => {
        await executor.execute(
          testMessage,
          testSessionKey,
          undefined,
          undefined,
          "agent-b",
        );
        inScopeAgentId = tryGetContext()?.agentId;
      });

      expect(inScopeAgentId).toBeUndefined();
      expect("agentId" in ctx).toBe(false);
    });

    it("returns the exact identity-mismatch result and reaches later security observers after failures", async () => {
      mockPrompt.mockClear();
      const eventBus = new TypedEventBus();
      const laterObserver = vi.fn();
      eventBus.on("security:warn", () => {
        throw new Error("private sync identity subscriber content");
      });
      eventBus.on("security:warn", async () => {
        throw new Error("private async identity subscriber content");
      });
      eventBus.on("security:warn", laterObserver);
      const deps = createMockDeps({ eventBus });
      const executor = createPiExecutor(testConfig, deps);
      const ctx = {
        tenantId: "default",
        userId: testSessionKey.userId,
        sessionKey: formatSessionKey(testSessionKey),
        agentId: "agent-a",
        traceId: crypto.randomUUID(),
        startedAt: Date.now(),
        trustLevel: "admin" as const,
      };

      const result = await runWithContext(ctx, () => executor.execute(
        testMessage,
        testSessionKey,
        undefined,
        undefined,
        "agent-b",
      ));

      expect(result).toMatchObject({
        finishReason: "error",
        stepsExecuted: 0,
        errorContext: {
          errorType: "RequestContextIdentityMismatch",
          retryable: false,
        },
      });
      expect(laterObserver).toHaveBeenCalledOnce();
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(deps.authStorage.getApiKey).not.toHaveBeenCalled();
      await new Promise((resolve) => setImmediate(resolve));
    });

    it("rejects execution when the selected session disagrees with resolved ALS identity", async () => {
      mockPrompt.mockClear();
      const deps = createMockDeps();
      const executor = createPiExecutor(testConfig, deps);
      const ctx = {
        tenantId: "default",
        userId: testSessionKey.userId,
        sessionKey: "default:other-user:other-session",
        agentId: "agent-a",
        traceId: crypto.randomUUID(),
        startedAt: Date.now(),
        trustLevel: "admin" as const,
      };

      const result = await runWithContext(ctx, () => executor.execute(
        testMessage,
        testSessionKey,
        undefined,
        undefined,
        "agent-a",
      ));

      expect(result.finishReason).toBe("error");
      expect(result.errorContext?.errorType).toBe("RequestContextIdentityMismatch");
      expect(ctx.sessionKey).toBe("default:other-user:other-session");
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(deps.authStorage.getApiKey).not.toHaveBeenCalled();
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
      const result = await executor.execute(testMessage, testSessionKey);

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
      await executor.execute(testMessage, testSessionKey);

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
      await executor.execute(testMessage, testSessionKey);

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
      await executor.execute(testMessage, testSessionKey);

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

      // getVisibleAssistantText reads mockSession.messages directly.
      // The original test relied on getLastAssistantText's mock-counter returning
      // "truncated" on the first call and "full escalated" on subsequent calls,
      // which under the OLD contract drove the final result.response from the
      // later read at executor-prompt-runner.ts:914. Under the new contract we
      // model the same outcome by setting messages to the post-escalation final
      // state — the executor's downstream rawResponse read picks it up. The
      // escalation event itself is verified in the sibling
      // "emits execution:output_escalated" test; here we only assert the
      // response replacement.
      setMockAssistantText("full escalated response with complete content");
      mockPrompt.mockResolvedValue(undefined);

      const deps = createMockDeps();
      const escalationConfig: PerAgentConfig = {
        ...testConfig,
        contextEngine: {
          outputEscalation: { enabled: true, escalatedMaxTokens: 32_768 },
        },
      } as PerAgentConfig;

      const executor = createPiExecutor(escalationConfig, deps);
      const result = await executor.execute(testMessage, testSessionKey);

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

    it("injects a continuation prompt when the budget tracker says continue", async () => {
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
      setMockAssistantText("extended response after budget nudge");

      const result = await executor.execute(
        testMessage, testSessionKey, undefined, undefined, undefined,
        { userTokenBudget: 500_000 },
      );

      expect(mockPrompt).toHaveBeenCalledWith(
        expect.stringContaining("[budget:nudge]"),
        { expandPromptTemplates: false, source: "extension" },
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
      // so no escalation retry happens. Budget continuation calls carry the
      // extension source and are excluded from this initial/escalation count.
      const promptCallsDuringExec = mockPrompt.mock.calls.slice(promptCallsBefore);
      const nonContinuationCalls = promptCallsDuringExec.filter((call) => call[1]?.source !== "extension");
      expect(nonContinuationCalls).toHaveLength(1);
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

    it("sets a universal prepareArguments stringified-JSON coercer (identity no-op) even when provider is not xai", async () => {
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
      // Every tool carries the universal stringified-JSON coercer via
      // prepareArguments (no xAI html-entity decode for a non-xai provider). On an
      // empty-properties schema it is an identity no-op.
      expect(testToolInSession).toHaveProperty("prepareArguments");
      expect(testToolInSession.prepareArguments({ a: "1" })).toEqual({ a: "1" });
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
            errorKind: "internal" as const,
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
    expect(logWarn.mock.calls[0][0].errorKind).toBe("internal");
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

// ---------------------------------------------------------------------------
// Per-session trajectory recorder lifecycle wiring
// ---------------------------------------------------------------------------

describe("creates_and_closes_trajectory_recorder_for_session", () => {
  async function readPiExecutorSrc(): Promise<string> {
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.resolve(here, "pi-executor.ts"), "utf-8");
    return src;
  }

  it("imports createTrajectoryRecorder and attachTrajectoryToEventBus from @comis/observability", async () => {
    const src = await readPiExecutorSrc();
    // The import line lives in the top imports.
    expect(src).toMatch(
      /import\s+\{[\s\S]*?createTrajectoryRecorder[\s\S]*?\}\s+from\s+"@comis\/observability"/m,
    );
    expect(src).toMatch(
      /import\s+\{[\s\S]*?attachTrajectoryToEventBus[\s\S]*?\}\s+from\s+"@comis\/observability"/m,
    );
  });

  it("resolves the recorder after the formattedKey materialization (registry or legacy fallback)", async () => {
    const src = await readPiExecutorSrc();
    const formattedKeyIdx = src.indexOf(
      "const formattedKey = formatSessionKey(sessionKey)",
    );
    // The recorder may come from the registry's
    // getOrCreate OR the legacy per-turn createTrajectoryRecorder fall-
    // back path. Either expression appears AFTER formattedKey lands.
    const registryIdx = src.indexOf(
      "deps.trajectoryRegistry.getOrCreate(",
    );
    const legacyIdx = src.indexOf("createTrajectoryRecorder(trajectoryInit");
    expect(formattedKeyIdx).toBeGreaterThan(0);
    expect(Math.min(registryIdx, legacyIdx)).toBeGreaterThan(formattedKeyIdx);
  });

  it("attaches the bridge subscription only when the recorder is non-null (legacy fallback) or delegates to the registry", async () => {
    const src = await readPiExecutorSrc();
    // Either: legacy `if (trajectoryRecorder !== null) { ... attachTrajectoryToEventBus }`
    // (the fall-back path), OR the registry-owned subscription via
    // `getOrCreate` (the production session-scoped path).
    expect(src).toMatch(
      /if\s*\(\s*trajectoryRecorder\s*!==\s*null\s*\)[\s\S]*?attachTrajectoryToEventBus/m,
    );
    expect(src).toMatch(/deps\.trajectoryRegistry\.getOrCreate\(/);
  });

  it("legacy fallback path (no registry) still cleans up via the runner-block finally", async () => {
    const src = await readPiExecutorSrc();
    // The cleanup follows postExecution in the existing finally block;
    // the registry path skips this branch (registry owns close()).
    expect(src).toMatch(/trajectoryUnsubscribe\?\.\(\)/);
    expect(src).toMatch(/await\s+trajectoryRecorder\.flushAndClose\(\)/);
    // Registry-present branch shortcuts the cleanup.
    expect(src).toMatch(/deps\.trajectoryRegistry\s*===\s*undefined/);
  });

  it("forwards deps.trajectoryConfig fields into the recorder init", async () => {
    const src = await readPiExecutorSrc();
    expect(src).toMatch(/deps\.trajectoryConfig\?\.enabled/);
    expect(src).toMatch(/deps\.trajectoryConfig\?\.dir/);
    expect(src).toMatch(/deps\.trajectoryConfig\?\.maxFileBytes/);
  });

  it("forwards the executor logger into the trajectory recorder init", async () => {
    const src = await readPiExecutorSrc();
    const trajectoryInitStart = src.indexOf("const trajectoryInit = {");
    expect(trajectoryInitStart).toBeGreaterThan(0);
    const closeIdx = src.indexOf("};", trajectoryInitStart);
    expect(closeIdx).toBeGreaterThan(trajectoryInitStart);
    expect(src.slice(trajectoryInitStart, closeIdx)).toMatch(/logger:\s*deps\.logger/);
  });

  it("surfaces trajectory resume failures without caching them as disabled", async () => {
    const src = await readPiExecutorSrc();
    expect(src).toMatch(/trajectoryResult\.ok/);
    expect(src).toMatch(/failureKind:\s*error\.failureKind/);
    expect(src).toMatch(/eventBus\.emit\(\s*"observability:trajectory_degraded"/);
    expect(src).toContain("Trajectory recorder could not resume persisted state");
  });

  it("trajectory_init_includes_sessionFile_from_sessionAdapter (pointer sidecar)", async () => {
    // The pointer file <sessionFile>.trajectory-path.json
    // is written by createTrajectoryRecorder ONLY when init.sessionFile
    // is provided. The recorder writer is already wired up
    // — this site is the missing production caller. Threading
    // sessionAdapter.getSessionPath(sessionKey) into trajectoryInit makes
    // the pointer sidecar land on disk for every live session.
    const src = await readPiExecutorSrc();
    expect(src).toMatch(/sessionFile:\s*sessionAdapter\.getSessionPath\(sessionKey\)/);
  });

  it("sessionFile lands inside the trajectoryInit literal (not on the bridge or registry call)", async () => {
    // Anchor the assertion: the sessionFile field must appear inside the
    // `const trajectoryInit = { ... };` literal, between agentId and
    // model. This is the single site that flows into both the registry
    // path and the legacy fallback (registry.getOrCreate or
    // createTrajectoryRecorder respectively).
    const src = await readPiExecutorSrc();
    const trajectoryInitStart = src.indexOf("const trajectoryInit = {");
    expect(trajectoryInitStart).toBeGreaterThan(0);
    // Walk forward to the closing `};` for the literal.
    const closeIdx = src.indexOf("};", trajectoryInitStart);
    expect(closeIdx).toBeGreaterThan(trajectoryInitStart);
    const initLiteral = src.slice(trajectoryInitStart, closeIdx);
    expect(initLiteral).toMatch(/sessionFile:\s*sessionAdapter\.getSessionPath\(sessionKey\)/);
  });
});

// ---------------------------------------------------------------------------
// Populated runtimeSnapshot.skills
// ---------------------------------------------------------------------------

describe("populated runtimeSnapshot.skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock returns after vi.clearAllMocks() wiped them.
    mockPrompt.mockResolvedValue(undefined);
    mockGetLastAssistantText.mockReturnValue("test response");
    mockSetModel.mockResolvedValue(undefined);
    mockSubscribe.mockReturnValue(vi.fn());
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
    mockSession.messages = [
      { role: "assistant", content: [{ type: "text", text: "test response" }] },
    ];
    mockGetSkills.mockReturnValue({ skills: [], diagnostics: [] });
  });

  it("skillRegistry_with_getSnapshot_populates_trace_metadata_skills", async () => {
    // Arrange: skillRegistry mock that exposes getSnapshot() with two skills.
    const mockSkillRegistry = {
      getEligibleSkillNames: vi.fn().mockReturnValue(new Set<string>(["fileops", "search"])),
      initFromSdkSkills: vi.fn(),
      getSnapshot: vi.fn().mockReturnValue({
        skills: [
          { name: "fileops", version: "1.0" },
          { name: "search" },
        ],
      }),
    };

    const deps = createMockDeps({ skillRegistry: mockSkillRegistry });
    const executor = createPiExecutor(testConfig, deps);
    await executor.execute(testMessage, testSessionKey);

    // The runtimeSnapshot is passed to createPiEventBridge as a field.
    // vi.clearAllMocks() in beforeEach ensures mock.calls[0] is from this test.
    const bridgeCall = (createPiEventBridge as Mock).mock.calls[0]![0]!;
    const snapshot = bridgeCall.runtimeSnapshot;

    expect(snapshot).toBeDefined();
    // name->id mapping + version passthrough
    expect(snapshot.skills).toEqual([
      { id: "fileops", version: "1.0" },
      { id: "search" },
    ]);
  });

  it("stamps deps.appVersion into runtimeSnapshot.harness.version (the trajectory build stamp)", async () => {
    // trace.metadata stamped version:"unknown", so triage could not confirm
    // which build produced an artifact (observed live — HEAD had diverged from
    // the deployed release). Thread the daemon version through.
    const deps = createMockDeps({ appVersion: "9.9.9" });
    const executor = createPiExecutor(testConfig, deps);
    await executor.execute(testMessage, testSessionKey);

    const bridgeCall = (createPiEventBridge as Mock).mock.calls[0]![0]!;
    expect(bridgeCall.runtimeSnapshot.harness.version).toBe("9.9.9");
  });

  it("falls back to \"unknown\" harness.version when appVersion is absent (existing callers unchanged)", async () => {
    const deps = createMockDeps();
    const executor = createPiExecutor(testConfig, deps);
    await executor.execute(testMessage, testSessionKey);

    const bridgeCall = (createPiEventBridge as Mock).mock.calls[0]![0]!;
    expect(bridgeCall.runtimeSnapshot.harness.version).toBe("unknown");
  });

  it("skillRegistry_without_getSnapshot_keeps_skills_empty", async () => {
    // Arrange: legacy two-method mock (no getSnapshot) — back-compat preserved.
    const legacySkillRegistry = {
      getEligibleSkillNames: vi.fn().mockReturnValue(new Set<string>(["fileops"])),
      initFromSdkSkills: vi.fn(),
      // intentionally no getSnapshot
    };

    const deps = createMockDeps({ skillRegistry: legacySkillRegistry });
    const executor = createPiExecutor(testConfig, deps);
    await executor.execute(testMessage, testSessionKey);

    // vi.clearAllMocks() in beforeEach ensures mock.calls[0] is from this test.
    const bridgeCall = (createPiEventBridge as Mock).mock.calls[0]![0]!;
    const snapshot = bridgeCall.runtimeSnapshot;

    expect(snapshot).toBeDefined();
    // Back-compat: legacy mock without getSnapshot keeps skills []
    expect(snapshot.skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildPromptingSnapshot redaction scaffold
// ---------------------------------------------------------------------------

describe("buildPromptingSnapshot redaction scaffold", () => {
  it("buildPromptingSnapshot_with_undefined_inputs_returns_empty", () => {
    const result = buildPromptingSnapshot({});
    expect(result).toEqual({});
  });

  it("buildPromptingSnapshot_redacts_userPromptPrefixText", () => {
    // The long decimal ID (123456789012) should be redacted by the
    // long-decimal-id pattern. The result must NOT contain the raw digits.
    const result = buildPromptingSnapshot({
      userPromptPrefixText: "User connected 123456789012 now",
    });
    expect(result.userPromptPrefixText).toBeDefined();
    expect(result.userPromptPrefixText).toContain("<REDACTED:");
    expect(result.userPromptPrefixText).not.toContain("123456789012");
  });

  it("buildPromptingSnapshot_substitutes_paths_in_userPromptPrefixText", () => {
    const result = buildPromptingSnapshot({
      userPromptPrefixText: "Read /Users/alice/foo first",
      pathOpts: { homeDir: "/Users/alice" },
    });
    expect(result.userPromptPrefixText).toBeDefined();
    expect(result.userPromptPrefixText).toContain("$HOME/foo");
    expect(result.userPromptPrefixText).not.toContain("/Users/alice/foo");
  });

  it("buildPromptingSnapshot_preserves_byteLen_and_digest", () => {
    const result = buildPromptingSnapshot({
      systemPromptDigest: "sha256:abc",
      systemPromptByteLen: 1234,
    });
    expect(result.systemPromptDigest).toBe("sha256:abc");
    expect(result.systemPromptByteLen).toBe(1234);
    // No userPromptPrefixText when not provided
    expect(result.userPromptPrefixText).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// capabilityClassOverride from providerCapabilities
// ---------------------------------------------------------------------------
// Tests that the resolveModelProfile call in pi-executor correctly threads the
// operator-supplied capabilityClassOverride from deps.providerCapabilities?.capabilityClass.
// Validates the wiring contract: when override is present it wins; absent → heuristic.

describe("capabilityClassOverride from providerCapabilities", () => {
  it("providerCapabilities.capabilityClass overrides provider-family heuristic", () => {
    // resolveModelProfile with an ollama provider (→ "small" by default)
    // but an explicit override forces "frontier"
    const profile = resolveModelProfile(
      { id: "qwen3.6:4b", provider: "ollama", contextWindow: 256_000, maxTokens: 8_192 },
      "frontier",  // capabilityClassOverride — as supplied by deps.providerCapabilities?.capabilityClass
    );
    expect(profile.capabilityClass).toBe("frontier");
    // frontier → securityLevel="standard", scaffoldLevel="light"
    expect(profile.securityLevel).toBe("standard");
    expect(profile.scaffoldLevel).toBe("light");
  });

  it("undefined providerCapabilities → normal heuristic (ollama → small)", () => {
    const profile = resolveModelProfile(
      { id: "qwen3.6:4b", provider: "ollama", contextWindow: 256_000, maxTokens: 8_192 },
      undefined,  // no override → provider-family heuristic applies
    );
    expect(profile.capabilityClass).toBe("small");
    expect(profile.securityLevel).toBe("locked");
  });

  it("mid override on an anthropic provider → mid class (not frontier)", () => {
    // Override wins over the anthropic → frontier heuristic
    const profile = resolveModelProfile(
      { id: "claude-3-opus", provider: "anthropic", contextWindow: 200_000, maxTokens: 4_096 },
      "mid",
    );
    expect(profile.capabilityClass).toBe("mid");
    expect(profile.securityLevel).toBe("hardened");
    expect(profile.scaffoldLevel).toBe("standard");
  });
});

// ---------------------------------------------------------------------------
// Non-keyless (anthropic) characterization — effectiveWindow unchanged
// ---------------------------------------------------------------------------
// Verifies that DEFAULT_EFFECTIVE_CAP_BY_CLASS is exported from budget-capacity-cap.ts
// and that for anthropic (frontier, cap=Infinity, no servedContextWindow), the
// resolveEffectiveContextWindow pure function returns the configured window exactly.
// This is a wiring-correctness characterization: if the import fails or the cap table
// is wrong, the test fails and blocks the pi-executor reconcile wiring.

describe("anthropic provider — effectiveWindow byte-identical to configured", () => {
  it("DEFAULT_EFFECTIVE_CAP_BY_CLASS exported from budget-capacity-cap (precondition for pi-executor wiring)", async () => {
    // This dynamic import FAILS before the export is added → RED gate.
    const mod = await import("../../context-engine/budget-capacity-cap.js");
    expect(typeof (mod as Record<string, unknown>).DEFAULT_EFFECTIVE_CAP_BY_CLASS).toBe("object");
  });

  it("frontier cap is Infinity (anthropic → no capability constraint)", async () => {
    const mod = await import("../../context-engine/budget-capacity-cap.js");
    const cap = (mod as Record<string, unknown>).DEFAULT_EFFECTIVE_CAP_BY_CLASS as Record<string, number>;
    expect(cap["frontier"]).toBe(Infinity);
  });

  it("resolveEffectiveContextWindow: anthropic no served → effectiveWindow=200000, source='configured' (exact-pin)", async () => {
    const { resolveEffectiveContextWindow } = await import("../../model/effective-context-window.js");
    const mod = await import("../../context-engine/budget-capacity-cap.js");
    const cap = (mod as Record<string, unknown>).DEFAULT_EFFECTIVE_CAP_BY_CLASS as Record<string, number>;

    // Anthropic: frontier cap = Infinity; no servedContextWindow (undefined)
    const result = resolveEffectiveContextWindow({
      configured: 200_000,
      served: undefined,
      capabilityCap: cap["frontier"] ?? Infinity,
    });

    // EXACT-PIN: effectiveWindow must equal the configured value (no probe, no cap constraint)
    expect(result.effectiveWindow).toBe(200_000);
    expect(result.source).toBe("configured");
  });
});

// ---------------------------------------------------------------------------
// Regression — pi-executor wiring with providerCapabilities=undefined
// ---------------------------------------------------------------------------
// The bug: when providerCapabilities is absent (plain anthropic/openai provider,
// no providers.entries block), the old code defaulted capabilityClass to "nano" (16K cap),
// silently capping a 200K anthropic context to 16K on every execution.
//
// This test exercises the FULL pi-executor.execute() path (not just the pure function)
// with providerCapabilities=undefined and resolvedModel.contextWindow=200_000, and asserts
// that NO capability-cap debug log is emitted (source === "configured"), proving the
// effective window stays 200_000 (not capped to 16_000).

describe("regression: pi-executor capabilityCap is Infinity when providerCapabilities is absent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolNameSnapshot(formatSessionKey(testSessionKey));
    clearSessionBootstrapFileSnapshot(formatSessionKey(testSessionKey));
    clearSessionPromptSkillsXmlSnapshot(formatSessionKey(testSessionKey));
    clearSessionToolSchemaSnapshot(formatSessionKey(testSessionKey));
    clearSessionToolSchemaSnapshotHash(formatSessionKey(testSessionKey));
    mockPrompt.mockResolvedValue(undefined);
    mockGetLastAssistantText.mockReturnValue("test response");
    mockSetModel.mockResolvedValue(undefined);
    mockSubscribe.mockReturnValue(vi.fn());
  });

  it("anthropic provider with no providerCapabilities and contextWindow=200000 → no capability-cap log emitted (effectiveWindow stays 200000)", async () => {
    // Deps with providerCapabilities explicitly absent (undefined) and
    // modelRegistry.find() returning a model with a large frontier contextWindow.
    // servedContextWindow is also absent (not an Ollama provider).
    const deps = createMockDeps({
      modelRegistry: {
        find: vi.fn().mockReturnValue({
          provider: "anthropic",
          id: "claude-sonnet-4-5-20250929",
          contextWindow: 200_000,
        }),
        getAll: vi.fn().mockReturnValue([]),
        getAvailable: vi.fn().mockReturnValue([]),
      } as any,
      providerCapabilities: undefined,
      servedContextWindow: undefined,
    });
    const executor = createPiExecutor(testConfig, deps);

    await executor.execute(testMessage, testSessionKey);

    // With the fix, capabilityCap = Infinity (no explicit class).
    // resolveEffectiveContextWindow({configured:200000,served:undefined,capabilityCap:Infinity})
    //   → source="configured" (Infinity excluded from the min race).
    // The debug log "Context window reconciled" is ONLY emitted when source !== "configured",
    // so its ABSENCE proves the effective window was NOT capped below 200_000.
    const debugCalls = vi.mocked(deps.logger.debug).mock.calls;
    const capLogCall = debugCalls.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Context window reconciled"),
    );
    expect(capLogCall).toBeUndefined();
  });

  it("ollama provider with explicit capabilityClass=small and contextWindow=256000 → capability-cap log IS emitted (cap applied)", async () => {
    // Regression guard: when capabilityClass IS set (small → 32K), the cap SHOULD apply.
    // This ensures the fix only removes the cap for absent providers, not for
    // explicitly-classified small/nano providers.
    const deps = createMockDeps({
      modelRegistry: {
        find: vi.fn().mockReturnValue({
          provider: "ollama",
          id: "qwen3.6:4b",
          contextWindow: 256_000,
        }),
        getAll: vi.fn().mockReturnValue([]),
        getAvailable: vi.fn().mockReturnValue([]),
      } as any,
      providerCapabilities: { capabilityClass: "small" } as any,
      servedContextWindow: undefined,
    });
    const executor = createPiExecutor(testConfig, deps);

    await executor.execute(testMessage, testSessionKey);

    // small capabilityClass → DEFAULT_EFFECTIVE_CAP_BY_CLASS["small"] = 32_000.
    // resolveEffectiveContextWindow({configured:256000,served:undefined,capabilityCap:32000})
    //   → source="capability" (32_000 < 256_000).
    // The debug log SHOULD be emitted here.
    const debugCalls = vi.mocked(deps.logger.debug).mock.calls;
    const capLogCall = debugCalls.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Context window reconciled"),
    );
    expect(capLogCall).toBeDefined();
    // Verify the capabilityCap in the log is 32_000 (not Infinity, not 16_000).
    const logPayload = capLogCall![0] as Record<string, unknown>;
    expect(logPayload["source"]).toBe("capability");
    expect(logPayload["effectiveWindow"]).toBe(32_000);
  });
});

// ---------------------------------------------------------------------------
// The primary provider's served window must NOT be
// applied (or attributed) to per-execution override models on other providers.
// ---------------------------------------------------------------------------
// deps.servedContextWindow is bound ONCE at executor construction to the
// agent's PRIMARY provider. Pre-patch, the reconcile consumed the bare number
// unconditionally: an Ollama-primary agent with served num_ctx 8192 whose
// graph node overrides to anthropic:claude-* (200K) had its window silently
// crushed to 8K, with the window-provenance surfaces confidently asserting
// `source: "served"` / "Ollama serves only 8192" for a model Ollama does not
// serve. Post-patch the dep pairs {providerKey, window} and the reconcile
// applies the window only when the executing model resolves to that provider.

describe("served-window gate on per-execution provider identity", () => {
  /** The probed primary provider (config providers.entries key space). */
  const OLLAMA_PRIMARY = "qwen-local";
  const ollamaConfig: PerAgentConfig = {
    ...testConfig,
    model: "qwen3.6:35b",
    provider: OLLAMA_PRIMARY,
  } as PerAgentConfig;

  /** Registry resolving BOTH providers — the override target carries a 200K
   *  frontier window; the primary carries the configured 131_072. */
  function makeTwoProviderRegistry() {
    return {
      find: vi.fn().mockImplementation((provider: string, id: string) => {
        if (provider === OLLAMA_PRIMARY) {
          return { provider: OLLAMA_PRIMARY, id, contextWindow: 131_072 };
        }
        if (provider === "anthropic") {
          return { provider: "anthropic", id, contextWindow: 200_000 };
        }
        return undefined;
      }),
      getAll: vi.fn().mockReturnValue([]),
      getAvailable: vi.fn().mockReturnValue([]),
    } as any;
  }

  function findReconcileDebug(deps: PiExecutorDeps) {
    return vi.mocked(deps.logger.debug).mock.calls.find(
      (args) => typeof args[1] === "string" && args[1].includes("Context window reconciled"),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolNameSnapshot(formatSessionKey(testSessionKey));
    clearSessionBootstrapFileSnapshot(formatSessionKey(testSessionKey));
    clearSessionPromptSkillsXmlSnapshot(formatSessionKey(testSessionKey));
    clearSessionToolSchemaSnapshot(formatSessionKey(testSessionKey));
    clearSessionToolSchemaSnapshotHash(formatSessionKey(testSessionKey));
    clearWindowReconcileLogged(formatSessionKey(testSessionKey));
    mockPrompt.mockResolvedValue(undefined);
    mockGetLastAssistantText.mockReturnValue("test response");
    mockSetModel.mockResolvedValue(undefined);
    mockSubscribe.mockReturnValue(vi.fn());
  });

  it("an override model on ANOTHER provider keeps its full window — no served clamp, no served attribution (RED pre-patch: source 'served', effectiveWindow 8192)", async () => {
    const deps = createMockDeps({
      modelRegistry: makeTwoProviderRegistry(),
      providerCapabilities: undefined, // isolate the served gate (capabilityCap = Infinity)
      servedContextWindow: { providerKey: OLLAMA_PRIMARY, window: 8_192 },
    });
    const executor = createPiExecutor(ollamaConfig, deps);

    await executor.execute(
      testMessage, testSessionKey, undefined, undefined, deps.agentId,
      undefined, undefined, { model: "anthropic:claude-sonnet-4-5-20250929" },
    );

    // Override applied → executing provider is "anthropic" ≠ probed
    // "qwen-local" → served skipped → configured 200_000 wins with
    // capabilityCap Infinity → source "configured" → NO reconcile line at any
    // level (nothing was reconciled). Pre-patch the bare served 8_192 entered
    // the min race and emitted source:"served" / effectiveWindow:8192 here.
    expect(findReconcileDebug(deps)).toBeUndefined();
  });

  it("the PRIMARY provider's execution still gets the served clamp (no-regression control: source 'served', effectiveWindow 8192)", async () => {
    const deps = createMockDeps({
      modelRegistry: makeTwoProviderRegistry(),
      providerCapabilities: undefined,
      servedContextWindow: { providerKey: OLLAMA_PRIMARY, window: 8_192 },
    });
    const executor = createPiExecutor(ollamaConfig, deps);

    await executor.execute(testMessage, testSessionKey, undefined, undefined, deps.agentId);

    const reconcile = findReconcileDebug(deps);
    expect(reconcile).toBeDefined();
    const payload = reconcile![0] as Record<string, unknown>;
    expect(payload["source"]).toBe("served");
    expect(payload["effectiveWindow"]).toBe(8_192);
    expect(payload["served"]).toBe(8_192);
  });

  it("an override model on the SAME probed provider still gets the served clamp (the map is keyed per provider, not per model)", async () => {
    const deps = createMockDeps({
      modelRegistry: makeTwoProviderRegistry(),
      providerCapabilities: undefined,
      servedContextWindow: { providerKey: OLLAMA_PRIMARY, window: 8_192 },
    });
    const executor = createPiExecutor(ollamaConfig, deps);

    await executor.execute(
      testMessage, testSessionKey, undefined, undefined, deps.agentId,
      undefined, undefined, { model: `${OLLAMA_PRIMARY}:qwen3.6:4b` },
    );

    const reconcile = findReconcileDebug(deps);
    expect(reconcile).toBeDefined();
    expect((reconcile![0] as Record<string, unknown>)["source"]).toBe("served");
    expect((reconcile![0] as Record<string, unknown>)["effectiveWindow"]).toBe(8_192);
  });
});

// ---------------------------------------------------------------------------
// Delta→stall-reset wiring at the composition root.
// ---------------------------------------------------------------------------
// The bridge presence-gates on deps.onDelta (pi-event-bridge.ts message_update
// case), so the hand-off at the bridge-deps literal must be an ALWAYS-DEFINED
// composed wrapper — not the raw channel callback, which is undefined for
// channel-less runs (cron, graph, this harness) and silently disables
// delta→reset: a silent local prefill then dies at the whole-turn race.
// The wrapper is unconditional for ALL providers — no providerType gating.

describe("composed onDelta wrapper at the bridge hand-off", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolNameSnapshot(formatSessionKey(testSessionKey));
    clearSessionBootstrapFileSnapshot(formatSessionKey(testSessionKey));
    clearSessionPromptSkillsXmlSnapshot(formatSessionKey(testSessionKey));
    clearSessionToolSchemaSnapshot(formatSessionKey(testSessionKey));
    clearSessionToolSchemaSnapshotHash(formatSessionKey(testSessionKey));
    clearWindowReconcileLogged(formatSessionKey(testSessionKey));
    mockPrompt.mockResolvedValue(undefined);
    mockGetLastAssistantText.mockReturnValue("test response");
    mockSetModel.mockResolvedValue(undefined);
    mockSubscribe.mockReturnValue(vi.fn());
  });

  it("bridge deps onDelta is ALWAYS defined with no channel callback, and invoking it re-arms the stall timer through the live ref", async () => {
    // Hung prompt keeps the resettable race live while the bridge deps are
    // probed (the resetTimer hand-off happens when the race starts).
    mockPrompt.mockReturnValue(new Promise(() => {}));
    const probe = createMockDeps();
    const setTimeoutSpy = vi.fn(probe.timers.setTimeout);
    const deps = createMockDeps({ timers: { ...probe.timers, setTimeout: setTimeoutSpy } });
    // Small budgets so the stall kill unwinds the hung run quickly (real timers).
    const cfg = {
      ...testConfig,
      promptTimeout: { promptTimeoutMs: 300, retryPromptTimeoutMs: 100 },
    } as PerAgentConfig;
    const executor = createPiExecutor(cfg, deps);

    const execPromise = executor.execute(testMessage, testSessionKey); // NO onDelta supplied

    // Wait until the bridge exists AND the prompt race armed the stall timer
    // (withResettablePromptTimeout arms synchronously beside the onResetTimer
    // hand-off, so currentResetTimer is assigned once a timer is armed).
    await vi.waitFor(() => {
      expect((createPiEventBridge as Mock).mock.calls.length).toBeGreaterThan(0);
      expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(0);
    });

    const bridgeCall = (createPiEventBridge as Mock).mock.calls.at(-1)![0] as {
      onDelta: ((delta: string, kind: "text" | "thinking") => void) | undefined;
    };
    // RED (pre-patch): the bridge-deps literal passes the RAW channel
    // callback — undefined here — and the bridge's presence gate then drops
    // every delta, so streaming activity never resets the stall budget.
    expect(typeof bridgeCall.onDelta).toBe("function");

    // Invoking the wrapper reads currentResetTimer through the LIVE ref and
    // re-arms the stall timer: exactly one new timers.setTimeout call,
    // synchronously (nothing else can interleave between these two lines).
    const armsBefore = setTimeoutSpy.mock.calls.length;
    bridgeCall.onDelta!("streamed token", "text");
    expect(setTimeoutSpy.mock.calls.length).toBe(armsBefore + 1);

    // Unwind: the stall budget (300ms after the delta) kills the hung prompt
    // and the execution resolves with a failed-but-handled result.
    await execPromise;
  }, 15_000);
});

describe("per-turn locale inheritance wiring", () => {
  it("publishes the resolved request locale to the live request context before sub-agent work", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "pi-executor.ts"), "utf-8");
    const policyIndex = src.indexOf("responseLocalePolicy,\n  } = promptResult");
    const assignmentIndex = src.indexOf(
      "turnContext.resolvedLanguage = responseLocalePolicy.locale",
    );
    const prepareIndex = src.indexOf("const preparedTurnResult = await prepareTurn", policyIndex);

    expect(policyIndex).toBeGreaterThan(0);
    expect(assignmentIndex).toBeGreaterThan(policyIndex);
    expect(prepareIndex).toBeGreaterThan(assignmentIndex);
  });
});

// ---------------------------------------------------------------------------
// Source-text wiring guard: normalizeModelCompat call-site threading
// ---------------------------------------------------------------------------

describe("normalizeModelCompat call-site wiring guard", () => {
  it("passes providerType and comisCompat from deps resolvers into normalizeModelCompat", () => {
    // Built-but-not-wired guard. RED on pre-patch code: the call
    // passed only {provider, id}, dropping the user's models[].comisCompat
    // entirely and giving auto-detection no provider-type signal. Resolver
    // form (deps.getProviderType / deps.getModelCompat) is load-bearing:
    // per-execution model overrides can switch providers mid-agent, so a
    // static agent-primary value would mis-gate.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "pi-executor.ts"), "utf-8");

    const callStart = src.indexOf("normalizeModelCompat({");
    expect(callStart).toBeGreaterThan(-1);
    const callEnd = src.indexOf("})", callStart);
    expect(callEnd).toBeGreaterThan(callStart);

    const callBlock = src.slice(callStart, callEnd);
    expect(callBlock).toContain(
      "providerType: deps.getProviderType?.(resolvedModel.provider)",
    );
    expect(callBlock).toContain(
      "comisCompat: deps.getModelCompat?.(resolvedModel.provider, resolvedModel.id)",
    );
  });
});

// ---------------------------------------------------------------------------
// Source-text wiring guard: agent-level capabilityClass pin
// The agents.<id>.capabilityClass operator pin must (a) take precedence over the
// provider-level value when resolving explicitClass, AND (b) flow into BOTH the
// capabilityCap derivation and the resolveModelProfile override — so a pinned
// class forces the reduced prompt + nano deferral + effectiveContextCap on ANY
// provider. RED on pre-patch code (explicitClass read only the provider-level
// value; the override passed deps.providerCapabilities?.capabilityClass directly).
// A built-but-not-wired guard: the schema field is inert unless the call site reads it.
// ---------------------------------------------------------------------------

describe("capabilityClass pin call-site wiring guard", () => {
  it("resolves explicitClass with config.capabilityClass taking precedence over the provider-level value", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "pi-executor.ts"), "utf-8");
    expect(src).toContain(
      "const explicitClass = config.capabilityClass ?? deps.providerCapabilities?.capabilityClass;",
    );
  });

  it("passes the resolved explicitClass (NOT the raw provider-level value) into resolveModelProfile", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "pi-executor.ts"), "utf-8");
    const callStart = src.indexOf("resolveModelProfile(");
    expect(callStart).toBeGreaterThan(-1);
    const callEnd = src.indexOf(");", callStart);
    expect(callEnd).toBeGreaterThan(callStart);
    const callBlock = src.slice(callStart, callEnd);
    // The override arg is the resolved explicitClass; the raw provider read must NOT
    // be passed directly here (that would ignore the agent-level pin).
    expect(callBlock).toContain("explicitClass");
    expect(callBlock).not.toContain("deps.providerCapabilities?.capabilityClass");
  });
});
