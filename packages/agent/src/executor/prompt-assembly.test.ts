// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted ensures availability before vi.mock factory hoisting)
// ---------------------------------------------------------------------------

const {
  mockAssembleRichSystemPrompt,
  mockBuildDateTimeSection,
  mockBuildInboundMetadataSection,
  mockBuildSenderTrustSection,
  mockLoadWorkspaceBootstrapFiles,
  mockBuildBootstrapContextFiles,
  mockFilterBootstrapFilesForLightContext,
  mockFilterBootstrapFilesForCron,
  mockFilterBootstrapFilesForGroupChat,
  mockDeduplicateResults,
  mockFormatMemorySection,
  mockHybridSplit,
  mockCreateHybridMemoryInjector,
  mockRecall,
  mockCreateMemoryRecall,
  mockReadFile,
  mockIsBootContentEffectivelyEmpty,
  mockDetectOnboardingState,
  mockBuildSubagentRoleSection,
  mockAssembleRichSystemPromptBlocks,
} = vi.hoisted(() => ({
  mockAssembleRichSystemPrompt: vi.fn().mockReturnValue("assembled-prompt"),
  mockAssembleRichSystemPromptBlocks: vi.fn().mockReturnValue({ staticPrefix: "static-prefix", attribution: "attribution", semiStableBody: "semi-stable-body" }),
  mockBuildDateTimeSection: vi.fn().mockReturnValue(["## Current Date & Time", "2026-03-12T00:00:00.000Z (mock)"]),
  mockBuildInboundMetadataSection: vi.fn().mockReturnValue([]),
  mockBuildSenderTrustSection: vi.fn().mockReturnValue(["## Authorized Senders", "", "### Admin", "- user-1"]),
  mockLoadWorkspaceBootstrapFiles: vi.fn().mockResolvedValue([]),
  mockBuildBootstrapContextFiles: vi.fn().mockReturnValue([]),
  mockFilterBootstrapFilesForLightContext: vi.fn((files: any[]) => files.filter((f: any) => f.name === "HEARTBEAT.md")),
  mockFilterBootstrapFilesForCron: vi.fn((files: any[]) => files.filter((f: any) => f.name === "SOUL.md" || f.name === "ROLE.md")),
  mockFilterBootstrapFilesForGroupChat: vi.fn((files: any[]) => files.filter((f: any) => f.name !== "USER.md")),
  mockDeduplicateResults: vi.fn((results: any[]) => results),
  // Default: returns undefined (no pinned section) so existing tests are unaffected.
  // Overridden per-test in the pinnedChars budget describe block.
  mockFormatMemorySection: vi.fn().mockReturnValue(undefined as string | undefined),
  mockHybridSplit: vi.fn().mockReturnValue({ inlineMemory: undefined, systemPromptSections: ["rag-section-1"] }),
  mockCreateHybridMemoryInjector: vi.fn(),
  // createMemoryRecall(...).recall(...) is mocked: prompt-assembly's job is to call
  // recall and feed its ranked output to the injector + emit memory:injected. The
  // recall pipeline internals (fuse/rerank/score/trust-filter/dedup) are covered by
  // memory-recall.test.ts; here recall is a controllable seam returning Result<...>.
  mockRecall: vi.fn(),
  mockCreateMemoryRecall: vi.fn(),
  mockReadFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mockIsBootContentEffectivelyEmpty: vi.fn().mockReturnValue(true),
  mockDetectOnboardingState: vi.fn().mockResolvedValue(false),
  mockBuildSubagentRoleSection: vi.fn().mockReturnValue([]),
}));

// Wire mockCreateHybridMemoryInjector to return an object with mockHybridSplit
mockCreateHybridMemoryInjector.mockReturnValue({ split: mockHybridSplit });
// Wire createMemoryRecall(...) to return { recall: mockRecall }.
mockCreateMemoryRecall.mockReturnValue({ recall: mockRecall });

vi.mock("../bootstrap/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadWorkspaceBootstrapFiles: mockLoadWorkspaceBootstrapFiles,
    buildBootstrapContextFiles: mockBuildBootstrapContextFiles,
    assembleRichSystemPrompt: mockAssembleRichSystemPrompt,
    assembleRichSystemPromptBlocks: mockAssembleRichSystemPromptBlocks,
    buildDateTimeSection: mockBuildDateTimeSection,
    buildInboundMetadataSection: mockBuildInboundMetadataSection,
    buildSenderTrustSection: mockBuildSenderTrustSection,
    buildSubagentRoleSection: mockBuildSubagentRoleSection,
    filterBootstrapFilesForLightContext: mockFilterBootstrapFilesForLightContext,
    filterBootstrapFilesForCron: mockFilterBootstrapFilesForCron,
    filterBootstrapFilesForGroupChat: mockFilterBootstrapFilesForGroupChat,
    resolveSenderDisplay: vi.fn().mockImplementation((sid: string) => sid),
  };
});

vi.mock("../rag/rag-retriever.js", () => ({
  deduplicateResults: mockDeduplicateResults,
  formatMemorySection: mockFormatMemorySection,
}));

vi.mock("../rag/hybrid-memory-injector.js", () => ({
  createHybridMemoryInjector: mockCreateHybridMemoryInjector,
}));

vi.mock("../rag/memory-recall.js", () => ({
  createMemoryRecall: mockCreateMemoryRecall,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("../workspace/boot-file.js", () => ({
  isBootContentEffectivelyEmpty: mockIsBootContentEffectivelyEmpty,
  BOOT_FILE_NAME: "BOOT.md",
}));

vi.mock("../workspace/onboarding-detector.js", () => ({
  detectOnboardingState: mockDetectOnboardingState,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const overrides = {
    hostname: () => "test-host",
    platform: () => "linux",
    arch: () => "x64",
    userInfo: () => ({ shell: "/bin/bash" }),
  };
  return {
    ...actual,
    ...overrides,
    default: { ...actual.default, ...overrides },
  };
});

import { assembleExecutionPrompt, extractUserLanguage, resolvePromptModeForProfile, clearSessionToolNameSnapshot, clearSessionBootstrapFileSnapshot, clearSessionPromptSkillsXmlSnapshot, clearWr02SenderTrustWarned, getCacheSafeParams, clearCacheSafeParams, buildRecallTrace, parseSkillLocationIndex, getSessionPromptSkillLocations, getSessionPromptMemoryInjected, clearSessionPromptMemoryInjected, type PromptAssemblyParams, type CacheSafeParams } from "./prompt-assembly.js";
import { resolveRecallTraceFilePath } from "@comis/observability";
// node:fs (sync) is NOT mocked here (only node:fs/promises is) — safe for the
// sub-agent-language source-grep chokepoint below.
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeOs from "node:os";
import { formatSessionKey, type SpawnPacket, type MemorySearchResult } from "@comis/core";
// Real (un-mocked) temporal-guidance formatter — prompt-assembly pushes its block into
// the prompt when >=2 memories are surfaced. It is FIXED guidance text, NOT a
// retrieved memory, so it must NOT inflate retrieved-memory telemetry:
// charsInjected / ragHits count retrieved memory only, never the guidance block.
import { buildTemporalGuidanceBlock } from "../rag/temporal-guidance.js";
import { createSpawnPacketBuilder } from "../spawn/spawn-packet-builder.js";
// Fixture stub for the capability-index gate. Default returns `false` so
// existing tests stay on the gate-off path (byte-identical baseline).
// Architecture-grep boundary forbids production-stub crossover both ways:
// tests use the __test-helpers/ source path, never the production no-op
// factory.
import { createCapabilityPortStub } from "../../../core/src/ports/__test-helpers/tool-capability-stub.js";

/** Formatted session key matching makeParams() default sessionKey. */
const DEFAULT_SESSION_KEY = formatSessionKey({ agentId: "agent-1", channelType: "telegram", channelId: "chat-1" } as any);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides?: Record<string, unknown>) {
  return {
    id: "msg-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "Hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  } as any;
}

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    name: "TestAgent",
    provider: "anthropic",
    model: "claude-3-opus",
    bootstrap: { promptMode: "full" },
    rag: { enabled: false },
    ...overrides,
  } as any;
}

function makeParams(overrides?: Partial<PromptAssemblyParams>): PromptAssemblyParams {
  // Ensure every fixture supplies a ToolCapabilityPort. Overriders pass full
  // deps objects (REPLACING the default), so we inject the stub on the merged
  // deps rather than the default literal — the field is REQUIRED and any
  // missing site would throw at runtime.
  const merged: PromptAssemblyParams = {
    config: makeConfig(),
    deps: { workspaceDir: "/workspace" },
    msg: makeMsg(),
    sessionKey: { agentId: "agent-1", channelType: "telegram", channelId: "chat-1" },
    agentId: "agent-1",
    mergedCustomTools: [],
    logger: createMockLogger(),
    operationType: "interactive",
    ...overrides,
  };
  if (!(merged.deps as Record<string, unknown>).clock) {
    merged.deps = {
      ...merged.deps,
      // Required clock for prompt-assembly time reads.
      clock: { now: () => Date.now(), nowDate: () => new Date() },
    } as PromptAssemblyParams["deps"];
  }
  if (!(merged.deps as Record<string, unknown>).toolCapabilityPort) {
    merged.deps = {
      ...merged.deps,
      // The static prompt does not branch on `isCapabilityIndexEnabled`
      // (the capability-index-on path is the only path). The port stub
      // is still required by downstream dynamic-preamble consumers that
      // honor the live gate.
      toolCapabilityPort: createCapabilityPortStub({ isCapabilityIndexEnabled: () => false }),
    };
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assembleExecutionPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear snapshots to prevent cross-test leakage
    clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
    clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    clearSessionPromptSkillsXmlSnapshot(DEFAULT_SESSION_KEY);
    clearCacheSafeParams(DEFAULT_SESSION_KEY);
    mockAssembleRichSystemPrompt.mockReturnValue("assembled-prompt");
    mockLoadWorkspaceBootstrapFiles.mockResolvedValue([]);
    mockBuildBootstrapContextFiles.mockReturnValue([]);
    mockFilterBootstrapFilesForLightContext.mockImplementation((files: any[]) => files.filter((f: any) => f.name === "HEARTBEAT.md"));
    mockFilterBootstrapFilesForCron.mockImplementation((files: any[]) => files.filter((f: any) => f.name === "SOUL.md" || f.name === "ROLE.md"));
    mockFilterBootstrapFilesForGroupChat.mockImplementation((files: any[]) => files.filter((f: any) => f.name !== "USER.md"));
    mockDeduplicateResults.mockImplementation((results: any[]) => results);
    mockHybridSplit.mockReturnValue({ inlineMemory: undefined, systemPromptSections: ["rag-section-1"] });
    mockCreateHybridMemoryInjector.mockReturnValue({ split: mockHybridSplit });
    // createMemoryRecall(...).recall(...) default: empty ranked result (ok). RAG tests
    // override mockRecall per case to drive the ranked output the injector consumes.
    mockCreateMemoryRecall.mockReturnValue({ recall: mockRecall });
    mockRecall.mockResolvedValue({ ok: true, value: [] });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockIsBootContentEffectivelyEmpty.mockReturnValue(true);
    mockDetectOnboardingState.mockResolvedValue(false);
    mockBuildSubagentRoleSection.mockReturnValue([]);
  });

  // -----------------------------------------------------------------
  // 1. Basic assembly
  // -----------------------------------------------------------------
  it("calls assembleRichSystemPrompt with correct agentName, promptMode, toolNames, hasMemoryTools", async () => {
    const params = makeParams({ mergedCustomTools: [{ name: "read" }, { name: "exec" }] as any[] });
    await assembleExecutionPrompt(params);

    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledTimes(1);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.agentName).toBe("TestAgent");
    expect(call.promptMode).toBe("full");
    expect(call.toolNames).toEqual(["read", "exec"]);
    expect(call.hasMemoryTools).toBe(false);
  });

  // -----------------------------------------------------------------
  // The "sender-trust not injected in compact-secure" WARN fires ONCE
  // PER AGENT, not once per prompt assembly. Trigger (small/nano
  // compact-secure + senderTrustDisplayConfig disabled) is static per
  // agent, so per-turn repetition is pure log noise.
  // -----------------------------------------------------------------
  it("warns about disabled sender-trust ONCE per agent, not per assembly", async () => {
    clearWr02SenderTrustWarned();
    const logger = createMockLogger();
    const params = makeParams({
      agentId: "wr02-agent",
      // small capabilityClass + baseMode "full" → compact-secure promptMode
      modelProfile: { capabilityClass: "small" } as any,
      // senderTrustDisplayConfig omitted → disabled → the sender-trust warn trigger fires
      logger,
    });

    await assembleExecutionPrompt(params);
    await assembleExecutionPrompt(params);
    await assembleExecutionPrompt(params);

    const wr02Calls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[1] === "string" && (c[1] as string).includes("sender-trust not injected"),
    );
    // Without the per-agent dedup this would be 3 (one per assembly).
    expect(wr02Calls.length).toBe(1);
  });

  // -----------------------------------------------------------------
  // 2. promptMode "none" skips bootstrap loading
  // -----------------------------------------------------------------
  it("skips bootstrap loading when promptMode is 'none'", async () => {
    const params = makeParams({
      config: makeConfig({ bootstrap: { promptMode: "none" } }),
    });
    await assembleExecutionPrompt(params);

    expect(mockLoadWorkspaceBootstrapFiles).not.toHaveBeenCalled();
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.bootstrapFiles).toEqual([]);
  });

  // -----------------------------------------------------------------
  // 3. promptMode "minimal" still loads bootstrap
  // -----------------------------------------------------------------
  it("loads bootstrap files when promptMode is 'minimal'", async () => {
    const params = makeParams({
      config: makeConfig({ bootstrap: { promptMode: "minimal" } }),
    });
    await assembleExecutionPrompt(params);

    expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalled();
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.promptMode).toBe("minimal");
  });

  // -----------------------------------------------------------------
  // 3b. Degenerate-window compact-prompt fallback
  //
  // The user's hard requirement: the agent must NEVER context-exhaust, even when
  // the effective window is SMALLER than the system prompt itself (e.g. an 8K
  // window mid-class model whose ~10K full prompt overflows even after every tool
  // is deferred). When windowFitBudget shows the resolved-mode prompt cannot fit
  // (systemPromptOnlyTokens + outputHeadroom + messageFloorTokens > effectiveWindow),
  // assembleExecutionPrompt falls back to the existing compact-secure mode
  // (~700 tok, security floor intact) so the agent still runs — instead of
  // throwing fixed_overhead_exceeds_window downstream.
  // -----------------------------------------------------------------
  it("falls back to compact-secure when the full prompt cannot fit the effective window", async () => {
    // Mock returns "assembled-prompt" (~5 tok). A tiny window (budget 4 tok) makes
    // even that degenerate, forcing the fallback. Default modelProfile → full mode
    // (the mid/frontier-class small-window case that compact-secure never covered).
    mockAssembleRichSystemPrompt.mockReturnValue("x".repeat(40)); // ~12 tok
    const logger = createMockLogger();
    const params = makeParams({
      logger,
      windowFitBudget: { effectiveWindow: 10, outputHeadroom: 4, messageFloorTokens: 2 },
    });
    await assembleExecutionPrompt(params);

    // assembleRichSystemPrompt called TWICE: once for the resolved (full) mode,
    // once for the compact-secure re-assembly.
    expect(mockAssembleRichSystemPrompt.mock.calls.length).toBeGreaterThanOrEqual(2);
    const firstMode = mockAssembleRichSystemPrompt.mock.calls[0][0].promptMode;
    const lastMode = mockAssembleRichSystemPrompt.mock.calls.at(-1)![0].promptMode;
    expect(firstMode).toBe("full");
    expect(lastMode).toBe("compact-secure");
    // A WARN names the degenerate fallback so an operator sees why the prompt shrank.
    const fbCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[1] === "string" && (c[1] as string).toLowerCase().includes("compact"),
    );
    expect(fbCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT shrink the prompt when the full prompt fits the effective window (no regression)", async () => {
    mockAssembleRichSystemPrompt.mockReturnValue("x".repeat(40)); // ~12 tok
    const params = makeParams({
      // Big window — the full prompt fits comfortably, so no fallback.
      windowFitBudget: { effectiveWindow: 200_000, outputHeadroom: 768, messageFloorTokens: 2_048 },
    });
    await assembleExecutionPrompt(params);

    // Exactly one assembly, in the resolved (full) mode — no compact re-assembly.
    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledTimes(1);
    expect(mockAssembleRichSystemPrompt.mock.calls[0][0].promptMode).toBe("full");
  });

  it("does not re-assemble when no windowFitBudget is supplied (window-agnostic baseline)", async () => {
    mockAssembleRichSystemPrompt.mockReturnValue("x".repeat(40));
    const params = makeParams(); // no windowFitBudget
    await assembleExecutionPrompt(params);
    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not double-shrink a prompt already resolved to compact-secure (small-class, tiny window)", async () => {
    // small class → compact-secure already. Even a tiny window must not trigger a
    // SECOND compact-secure re-assembly (it's already the floor). Distinct agentId
    // so this case's compact-secure sender-trust-warn dedup never collides with other
    // tests' shared wr02SenderTrustWarned state (the failing-otherwise interaction).
    mockAssembleRichSystemPrompt.mockReturnValue("x".repeat(40));
    const params = makeParams({
      agentId: "double-shrink-agent",
      modelProfile: { capabilityClass: "small" } as any,
      windowFitBudget: { effectiveWindow: 10, outputHeadroom: 4, messageFloorTokens: 2 },
    });
    await assembleExecutionPrompt(params);
    // Resolved mode is already compact-secure → assembled once, no re-assembly.
    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledTimes(1);
    expect(mockAssembleRichSystemPrompt.mock.calls[0][0].promptMode).toBe("compact-secure");
  });

  // -----------------------------------------------------------------
  // 4. RAG retrieval via hybrid memory injector
  // -----------------------------------------------------------------
  it("routes recall output to the hybrid memory injector when memoryPort and rag.enabled are set", async () => {
    const mockSearchResult = {
      entry: { id: "m1", tenantId: "t", content: "Test memory", createdAt: Date.now(), tags: [], trustLevel: "learned", source: { channel: "test" } },
      score: 0.85,
    };
    const memoryPort = {
      search: vi.fn().mockResolvedValue({ ok: true, value: [mockSearchResult] }),
      store: vi.fn(),
    } as any;
    // recall returns the ranked, trust-filtered, deduped result the injector consumes.
    mockRecall.mockResolvedValue({ ok: true, value: [mockSearchResult] });
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
      deps: { workspaceDir: "/workspace", memoryPort },
    });
    const result = await assembleExecutionPrompt(params);

    // recall is the single orchestrator; prompt-assembly no longer searches inline.
    expect(mockCreateMemoryRecall).toHaveBeenCalledOnce();
    expect(mockRecall).toHaveBeenCalledOnce();
    expect(mockCreateHybridMemoryInjector).toHaveBeenCalledOnce();
    // The injector consumes recall's ranked output (not a raw search result).
    expect(mockHybridSplit).toHaveBeenCalledWith([mockSearchResult], 5000);
    // RAG relocated to dynamic preamble, not system prompt
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.additionalSections).toEqual([]);
    expect(result.dynamicPreamble).toContain("rag-section-1");
  });

  it("threads deps.tripleStore into createMemoryRecall so the graph-spread lane has its store", async () => {
    // Production-wiring regression guard for the LAST link of the chain:
    // PromptAssemblyParams.deps.tripleStore → createMemoryRecall's deps.tripleStore.
    // If the createMemoryRecall call object listed
    // entityStore/temporalStore/causalStore/usefulnessStore but NOT tripleStore,
    // the 6th graphSpread lane gate (`deps.tripleStore !== undefined`) would be
    // always false and spreadLane would never run — the lane dead even with the
    // store injected and rag.lanes.graphSpread.enabled flipped on.
    const memoryPort = {
      search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      store: vi.fn(),
    } as any;
    const tripleStore = {
      upsertTriple: vi.fn(),
      asOf: vi.fn(),
      currentTruth: vi.fn(),
      spreadLane: vi.fn(),
    } as unknown as import("@comis/core").TripleStorePort;
    mockRecall.mockResolvedValue({ ok: true, value: [] });
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
      deps: { workspaceDir: "/workspace", memoryPort, tripleStore },
    });
    await assembleExecutionPrompt(params);

    expect(mockCreateMemoryRecall).toHaveBeenCalledOnce();
    const recallDeps = mockCreateMemoryRecall.mock.calls[0][0] as { tripleStore?: unknown };
    expect(recallDeps.tripleStore).toBe(tripleStore);
  });

  it("threads deps.provenanceStore into createMemoryRecall so the provenance down-weighting pass has its store (the built-but-not-wired guard, last link)", async () => {
    // Production-wiring regression guard for the LAST link of the
    // 5-link composition chain: PromptAssemblyParams.deps.provenanceStore →
    // createMemoryRecall's deps.provenanceStore. If the
    // createMemoryRecall deps object omitted provenanceStore, the pass gate
    // (`deps.provenanceStore != null`) would be ALWAYS false in the live daemon —
    // the provenance down-weighting BUILT but DORMANT (the classic
    // built-but-not-wired failure). The store reaches here only when every
    // prior link threads it.
    const memoryPort = {
      search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      store: vi.fn(),
    } as any;
    const provenanceStore = {
      getProvenanceForSummary: vi.fn(() => []),
    } as unknown as import("@comis/core").LcdProvenanceReadStore;
    mockRecall.mockResolvedValue({ ok: true, value: [] });
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
      deps: { workspaceDir: "/workspace", memoryPort, provenanceStore },
    });
    await assembleExecutionPrompt(params);

    expect(mockCreateMemoryRecall).toHaveBeenCalledOnce();
    const recallDeps = mockCreateMemoryRecall.mock.calls[0][0] as { provenanceStore?: unknown };
    expect(recallDeps.provenanceStore).toBe(provenanceStore);
  });

  it("threads deps.embeddingStore + config.rag.mmr/queryUnderstanding into createMemoryRecall so the MMR re-rank has its store and knobs", async () => {
    // Production-wiring regression guard for the LAST link of the chain:
    // PromptAssemblyParams.deps.embeddingStore → createMemoryRecall's deps.embeddingStore,
    // and config.rag.mmr / config.rag.queryUnderstanding → createMemoryRecall's config.
    // If the createMemoryRecall call object listed
    // entityStore/temporalStore/causalStore/tripleStore/usefulnessStore but NOT
    // embeddingStore, and its config object omitted mmr + queryUnderstanding, the
    // MMR slot gate (`deps.embeddingStore !== undefined && cfg.mmr?.enabled`) would be
    // always false and the diversity re-rank would never run — a silent no-op even
    // with the store injected and rag.mmr.enabled flipped on (the field-plumbing hazard).
    const memoryPort = {
      search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      store: vi.fn(),
    } as any;
    const embeddingStore = {
      readEmbeddings: vi.fn(),
    } as unknown as import("@comis/core").MemoryEmbeddingStore;
    mockRecall.mockResolvedValue({ ok: true, value: [] });
    const params = makeParams({
      config: makeConfig({
        rag: {
          enabled: true,
          maxResults: 5,
          minScore: 0.3,
          includeTrustLevels: ["learned"],
          maxContextChars: 5000,
          mmr: { enabled: true, lambda: 0.7 },
          queryUnderstanding: { intentReweight: true, synonyms: false, temporalParse: true },
        },
      }),
      deps: { workspaceDir: "/workspace", memoryPort, embeddingStore },
    });
    await assembleExecutionPrompt(params);

    expect(mockCreateMemoryRecall).toHaveBeenCalledOnce();
    const recallDeps = mockCreateMemoryRecall.mock.calls[0][0] as { embeddingStore?: unknown };
    expect(recallDeps.embeddingStore).toBe(embeddingStore);
    const recallCfg = mockCreateMemoryRecall.mock.calls[0][1] as {
      mmr?: unknown;
      queryUnderstanding?: unknown;
    };
    expect(recallCfg.mmr).toEqual({ enabled: true, lambda: 0.7 });
    expect(recallCfg.queryUnderstanding).toEqual({
      intentReweight: true,
      synonyms: false,
      temporalParse: true,
    });
  });

  // -----------------------------------------------------------------
  // 4a-ter. Recall scoring source: the `scoring:` arg into
  // createMemoryRecall is exactly config.rag.scoring — no learned
  // overlay, no tuned-alpha store read, even when such a store is
  // wired and `onlineTuning` is flipped on.
  // -----------------------------------------------------------------
  describe("recall scoring is fixed config.rag.scoring (no learned bandit overlay)", () => {
    // There is NO UCB online-tuning bandit or tuned-alpha overlay. Recall
    // scoring is the fixed config.rag.scoring alphas (fused RRF + the existing
    // cross-encoder reranker, no learned-weight write path). These tests pin
    // that: the `scoring` arg into createMemoryRecall is exactly
    // config.rag.scoring (object identity — NO merge/clone), and NO
    // tunedAlphaStore read fires even when one is wired. They FAIL on
    // any overlay code that wraps scoring in a merged object or reads the
    // store behind an onlineTuning gate.

    /** The static config alphas — the SOLE scoring source (no overlay). */
    const CONFIG_SCORING = {
      recencyAlpha: 0.2,
      temporalAlpha: 0.2,
      proofAlpha: 0.1,
      trustAlpha: 0.1,
      usefulnessAlpha: 0.1,
    };

    /** A learned-vector store spy: counts reads + returns a vector whose alphas DIFFER
     *  from config — so any overlay would visibly rewrite scoring (a loud failure signal).
     *  Typed structurally: there is no TunedAlphaStore port, so this is a
     *  structural stub fed through `deps as any` to prove no read path exists. */
    function makeLearnedStore(): {
      store: { upsert: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
      reads: () => number;
    } {
      let readCalls = 0;
      const store = {
        upsert: vi.fn(),
        read: vi.fn(async () => {
          readCalls += 1;
          return {
            ok: true as const,
            value: {
              recencyAlpha: 0.91,
              temporalAlpha: 0.82,
              proofAlpha: 0.73,
              usefulnessAlpha: 0.64,
            },
          };
        }),
      };
      return { store, reads: () => readCalls };
    }

    /** A memoryPort + a non-empty recall result so the recall path runs end-to-end. */
    function ragMemoryPort() {
      mockRecall.mockResolvedValue({ ok: true, value: [] });
      return {
        search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
        store: vi.fn(),
      } as any;
    }

    /** Base rag config with the static scoring alphas. `onlineTuning` is set ON here so
     *  these tests exercise the most overlay-favorable condition: with a gated
     *  read+overlay in place the store would be read and the vector would overlay
     *  scoring; with the fixed-alphas contract neither happens. */
    function tuningConfig() {
      return makeConfig({
        rag: {
          enabled: true,
          maxResults: 5,
          minScore: 0.3,
          includeTrustLevels: ["learned"],
          maxContextChars: 5000,
          scoring: { ...CONFIG_SCORING },
          onlineTuning: { enabled: true },
        },
      });
    }

    /** The `scoring` arg captured off the (mocked) createMemoryRecall options object. */
    function capturedScoring(): {
      recencyAlpha: number;
      temporalAlpha: number;
      proofAlpha: number;
      trustAlpha: number;
      usefulnessAlpha: number;
    } {
      expect(mockCreateMemoryRecall).toHaveBeenCalledOnce();
      return (mockCreateMemoryRecall.mock.calls[0][1] as { scoring: any }).scoring;
    }

    it("scoring is the FIXED config alphas even with onlineTuning ON + a learned vector wired (no overlay rewrite)", async () => {
      // The binding proof. onlineTuning is ON and a learned store returning
      // DIFFERENT alphas (0.91/0.82/0.73/0.64) is wired. An overlay would read that
      // vector and rewrite scoring to those values; with no read+overlay path,
      // scoring is the untouched config alphas (0.2/0.2/0.1/0.1/0.1).
      const learned = makeLearnedStore();
      const config = tuningConfig();
      await assembleExecutionPrompt(
        makeParams({
          config,
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            // tunedAlphaStore is not a dep field → cast through any.
            tunedAlphaStore: learned.store,
          } as any,
          sessionKey: { tenantId: "t", agentId: "agent-1", channelType: "telegram", channelId: "chat-1" } as any,
          agentId: "agent-1",
        }),
      );
      // The learned vector did NOT reach scoring — the config alphas are untouched.
      expect(capturedScoring()).toEqual(CONFIG_SCORING);
    });

    it("scoring is config.rag.scoring by OBJECT IDENTITY — the call site forwards the config ref, no overlay clone", async () => {
      // The call site passes `config.rag.scoring` straight through, so the
      // captured arg IS the same reference as the input config's rag.scoring. Any
      // overlay would BUILD a NEW merged object (tuned alphas + config trust) —
      // a different reference — which this identity check rejects.
      const learned = makeLearnedStore();
      const config = tuningConfig();
      const configScoringRef = config.rag.scoring; // the exact reference the call site must forward
      await assembleExecutionPrompt(
        makeParams({
          config,
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            tunedAlphaStore: learned.store,
          } as any,
          sessionKey: { tenantId: "t", agentId: "agent-1", channelType: "telegram", channelId: "chat-1" } as any,
          agentId: "agent-1",
        }),
      );
      expect(capturedScoring()).toBe(configScoringRef);
    });

    it("a wired tunedAlphaStore is NEVER read even with onlineTuning ON — no gated overlay read exists", async () => {
      // No read path exists: even with onlineTuning ON the store is never read.
      // An overlay would read it once behind the gate; this pins reads === 0.
      const learned = makeLearnedStore();
      const config = tuningConfig();
      await assembleExecutionPrompt(
        makeParams({
          config,
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            tunedAlphaStore: learned.store,
          } as any,
          sessionKey: { tenantId: "t", agentId: "agent-1", channelType: "telegram", channelId: "chat-1" } as any,
          agentId: "agent-1",
        }),
      );
      expect(learned.reads(), "the deleted overlay must never read the store").toBe(0);
      expect(capturedScoring()).toEqual(CONFIG_SCORING);
    });
  });

  // -----------------------------------------------------------------
  // 4a-bis. The LLM-free per-user-profile standing block.
  // The <user_profile> block reads from the mental-model store
  // (`mentalModelStore.list(scope, "profile")` → buildProfileBlock). The
  // per-user doc is selected by `topicKey === sessionKey.userId` (the profile
  // groupKey is the userId; LearningScope carries only (tenant, agent), so the
  // user axis lives in the doc's topicKey). The gate is the collapsed
  // `learning.enabled` flag + the store dep. Binding proofs: default-OFF
  // byte-identity (no store dep ⇒ list() 0 times, byte-identical prompt), the cost
  // gate (knob off ⇒ list() 0 times), the standing block injects on a zero-recall turn
  // and with rag.enabled=false (it lives OUTSIDE the recall `if`), and the injection is
  // LLM-free (a store.list + the pure formatter — never a model call). The
  // <user_profile> content is DISJOINT from <available_skills> (no double-surface).
  // -----------------------------------------------------------------
  describe("per-user-profile injection (LLM-free standing block, mental-model store)", () => {
    /**
     * The standing-block config: the collapsed gate `learning.enabled` is ON
     * (it defaults on, but set it explicitly). `rag.enabled` is left ON only so the
     * recall path also runs (the recall-construction assertions still hold); the
     * standing block does NOT need a recall hit to inject.
     */
    function ragConfig() {
      return makeConfig({
        learning: { enabled: true },
        rag: {
          enabled: true,
          maxResults: 5,
          minScore: 0.3,
          includeTrustLevels: ["learned"],
          maxContextChars: 5000,
        },
      });
    }
    /**
     * The standing-block config WITHOUT a recall hit: `learning` ON but
     * `rag.enabled` OFF (no recall). The durable profile MUST still inject on a
     * zero-recall turn — the push must NOT be nested inside the recall-hit branch.
     */
    function learningOnlyConfig() {
      return makeConfig({
        learning: { enabled: true },
        rag: { enabled: false },
      });
    }
    /** A memoryPort + a non-empty recall result so `recalled.value.length > 0`. */
    function ragMemoryPort() {
      const mockSearchResult = {
        entry: {
          id: "m1",
          tenantId: "t",
          content: "Test memory",
          createdAt: 1_000,
          tags: [],
          trustLevel: "learned",
          source: { channel: "test" },
        },
        score: 0.85,
      };
      mockRecall.mockResolvedValue({ ok: true, value: [mockSearchResult] });
      return {
        search: vi.fn().mockResolvedValue({ ok: true, value: [mockSearchResult] }),
        store: vi.fn(),
      } as any;
    }
    /** A kind:profile MentalModel for user `userId` carrying the 4 prefix-type facts. */
    function profileDoc(userId: string): import("@comis/core").MentalModel {
      return {
        id: `mm-profile-${userId}`,
        name: `profile-${userId}`,
        description: `Durable profile for ${userId}`,
        body: "(rendered)",
        kind: "profile",
        topicKey: userId, // the profile groupKey IS the userId (the per-user axis)
        trustLevel: "learned",
        state: "active",
        proofCount: 2,
        confidence: 0.7,
        mutating: false,
        sourceTrajIds: ["s1", "s2"],
        structuredBody: {
          sections: [
            { id: "identity", heading: "Identity", body: "- name is Sam" },
            { id: "preference", heading: "Preferences", body: "- likes terse replies" },
          ],
        },
        createdAt: 1_000,
      };
    }
    /**
     * A spy MentalModelStorePort counting list() calls + recording the (scope, kind)
     * each call received, returning a fixed doc set.
     */
    function makeSpyStore(
      docs: import("@comis/core").MentalModel[],
    ): {
      store: import("@comis/core").MentalModelStorePort;
      lists: () => number;
      lastScope: () => import("@comis/core").LearningScope | undefined;
      lastKind: () => string | undefined;
    } {
      let listCalls = 0;
      let scope: import("@comis/core").LearningScope | undefined;
      let kind: string | undefined;
      const store = {
        admit: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async (s: import("@comis/core").LearningScope, k?: string) => {
          listCalls += 1;
          scope = s;
          kind = k;
          // Mimic listByKindStmt: filter by kind when supplied.
          const filtered = k === undefined ? docs : docs.filter((d) => d.kind === k);
          return { ok: true as const, value: filtered };
        }),
        promote: vi.fn(),
        demote: vi.fn(),
        promoteByName: vi.fn(),
        demoteByName: vi.fn(),
        supersede: vi.fn(),
        evict: vi.fn(),
      } as unknown as import("@comis/core").MentalModelStorePort;
      return { store, lists: () => listCalls, lastScope: () => scope, lastKind: () => kind };
    }

    it("default-OFF: with NO mentalModelStore dep the prompt is byte-identical (no <user_profile> block)", async () => {
      const params = makeParams({
        config: ragConfig(),
        deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
        sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
      });
      const result = await assembleExecutionPrompt(params);

      // No store dep ⇒ no profile list ⇒ no block ⇒ byte-identity preserved.
      expect(result.dynamicPreamble).not.toContain("<user_profile>");
      expect(result.systemPrompt).not.toContain("<user_profile>");
    });

    it("default-OFF cost gate: with NO store dep, list() is called 0 times AND the prompt equals the no-store baseline", async () => {
      // The store is CONSTRUCTED (spy) but NOT wired into deps — the off config.
      const spy = makeSpyStore([profileDoc("u")]);

      const baseline = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // THE COST GATE: the store was never wired, so its list() was never called.
      expect(spy.lists(), "list() NEVER called in the off (no-store-dep) config").toBe(0);
      expect(baseline.dynamicPreamble).not.toContain("<user_profile>");
    });

    it("store present but no profile for this user: list() runs, the formatter yields nothing → byte-identical prompt", async () => {
      const emptySpy = makeSpyStore([]); // no profile docs at all
      const withStore = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            mentalModelStore: emptySpy.store,
          },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );
      const withoutStore = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // The list ran (store present) but found nothing → no block → identical prompt.
      expect(emptySpy.lists(), "list() runs once when the store is present").toBe(1);
      expect(withStore.dynamicPreamble).not.toContain("<user_profile>");
      expect(withStore.dynamicPreamble).toEqual(withoutStore.dynamicPreamble);
      expect(withStore.systemPrompt).toEqual(withoutStore.systemPrompt);
    });

    it("LLM-free injection ON: a profile doc injects the <user_profile> block via list() + buildProfileBlock (no model call)", async () => {
      const spy = makeSpyStore([profileDoc("u")]);
      const result = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            mentalModelStore: spy.store,
          },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // The block + the doc's facts appear; the list drove it (LLM-free).
      expect(result.dynamicPreamble).toContain("<user_profile>");
      expect(result.dynamicPreamble).toContain("name is Sam");
      expect(result.dynamicPreamble).toContain("likes terse replies");
      expect(spy.lists(), "the injection is a store.list (deterministic, LLM-free)").toBe(1);
      // The profile block now reads from ONE unfiltered list
      // (kind omitted) shared with the skill topic-match, filtering kind=profile in-process — so
      // the list is no longer kind-filtered, but it still runs exactly ONCE (the cost contract above).
      expect(spy.lastKind()).toBeUndefined();
      // The injection adds NO extra model/recall seam: recall is still constructed once.
      expect(mockCreateMemoryRecall).toHaveBeenCalledOnce();
    });

    it("selects the CURRENT user's profile doc by topicKey===userId (cross-user isolation at read)", async () => {
      // Two users' profile docs in the (tenant, agent) scope; only THIS user's renders.
      const mine = profileDoc("user-me");
      const theirs: import("@comis/core").MentalModel = {
        ...profileDoc("user-other"),
        structuredBody: { sections: [{ id: "identity", heading: "Identity", body: "- SECRET other-user fact" }] },
      };
      const spy = makeSpyStore([theirs, mine]);
      const result = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort(), mentalModelStore: spy.store },
          sessionKey: { tenantId: "t", userId: "user-me", channelId: "chat-1" } as any,
        }),
      );

      expect(result.dynamicPreamble).toContain("<user_profile>");
      expect(result.dynamicPreamble).toContain("name is Sam"); // mine
      expect(result.dynamicPreamble).not.toContain("SECRET other-user fact"); // theirs
    });

    it("standing block: a profile injects on a ZERO-recall turn (recall returns ok([])) — NOT recall-conditional", async () => {
      const memoryPort = ragMemoryPort();
      mockRecall.mockResolvedValue({ ok: true, value: [] }); // zero recall hits this turn
      const spy = makeSpyStore([profileDoc("u")]);
      const result = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: { workspaceDir: "/workspace", memoryPort, mentalModelStore: spy.store },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // The standing block injects even though recall returned NOTHING this turn.
      expect(result.dynamicPreamble).toContain("<user_profile>");
      expect(result.dynamicPreamble).toContain("name is Sam");
      expect(spy.lists(), "the standing-block list runs on a zero-recall turn").toBe(1);
    });

    it("standing block: injects with rag.enabled=false (no memoryPort recall path) — decoupled from the RAG knob", async () => {
      const spy = makeSpyStore([profileDoc("u")]);
      const result = await assembleExecutionPrompt(
        makeParams({
          config: learningOnlyConfig(), // rag.enabled = false, NO memoryPort wired
          deps: { workspaceDir: "/workspace", mentalModelStore: spy.store },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      expect(result.dynamicPreamble).toContain("<user_profile>");
      expect(result.dynamicPreamble).toContain("name is Sam");
      expect(spy.lists(), "the standing-block list runs even with rag.enabled=false").toBe(1);
    });

    it("cost gate: learning OFF + store present + recall HIT ⇒ list() NEVER called and the prompt is byte-identical", async () => {
      // Prove the collapsed gate is load-bearing: wire the store AND drive a recall
      // HIT, but set learning.enabled=false. list() must NEVER fire and the
      // prompt must equal the gate-off baseline (default-OFF byte-identity).
      const memoryPort = ragMemoryPort();
      const spy = makeSpyStore([profileDoc("u")]);
      const gateOff = await assembleExecutionPrompt(
        makeParams({
          config: makeConfig({
            learning: { enabled: false },
            rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 },
          }),
          deps: { workspaceDir: "/workspace", memoryPort, mentalModelStore: spy.store },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );
      const baseline = await assembleExecutionPrompt(
        makeParams({
          config: makeConfig({
            learning: { enabled: false },
            rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 },
          }),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      expect(spy.lists(), "gate off ⇒ list() NEVER called even on a recall hit (the cost gate)").toBe(0);
      expect(gateOff.dynamicPreamble).not.toContain("<user_profile>");
      expect(gateOff.dynamicPreamble).toEqual(baseline.dynamicPreamble);
      expect(gateOff.systemPrompt).toEqual(baseline.systemPrompt);
    });

    it("the <user_profile> content is DISJOINT from the <available_skills> source (no double-surface)", async () => {
      // The profile facts surface ONCE — in the <user_profile> block — never ALSO in
      // the <available_skills> source (which prompt-assembly reads via the SEPARATE
      // getPromptSkillsXml seam). The two channels are disjoint by SOURCE: the profile
      // comes from mentalModelStore.list(scope,"profile"); the skills surface is
      // daemon-materialized from list(scope,"skill") (kind-filtered). This
      // asserts the two sources never share content (the harness mocks the rich-prompt
      // assembler, so assert the disjointness at the source, not the assembled string).
      const skillsXml =
        "<available_skills>\n<skill><name>alpha</name><description>a skill</description></skill>\n</available_skills>";
      const spy = makeSpyStore([profileDoc("u")]);
      const result = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            mentalModelStore: spy.store,
            getPromptSkillsXml: () => skillsXml,
          },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // The profile facts are in the <user_profile> block (the dynamic preamble)…
      expect(result.dynamicPreamble).toContain("<user_profile>");
      expect(result.dynamicPreamble).toContain("name is Sam");
      // …and the <available_skills> SOURCE carries NEITHER profile fact (disjoint).
      expect(skillsXml).toContain("<available_skills>");
      expect(skillsXml).not.toContain("name is Sam");
      expect(skillsXml).not.toContain("likes terse replies");
      // ONE unfiltered list serves both consumers (profile + reuse-attribution); the
      // profile/skill sources stay DISJOINT via in-process kind partition (kind=profile vs
      // kind=skill), proven by the content assertions above (profile facts absent from the
      // skills XML). The list call itself is no longer kind-filtered.
      expect(spy.lastKind()).toBeUndefined();
    });

    it("non-fatal: a list() err is swallowed → no block, the agent proceeds (no throw)", async () => {
      const store = {
        admit: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => ({ ok: false as const, error: new Error("unresolved scope") })),
        promote: vi.fn(),
        demote: vi.fn(),
        promoteByName: vi.fn(),
        demoteByName: vi.fn(),
        supersede: vi.fn(),
        evict: vi.fn(),
      } as unknown as import("@comis/core").MentalModelStorePort;

      const result = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort(), mentalModelStore: store },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      expect(result.dynamicPreamble).not.toContain("<user_profile>");
    });

    it("forward-presence: deps.mentalModelStore reaches the list site with the prompt's own (tenant, agent) scope", async () => {
      const spy = makeSpyStore([profileDoc("user-Q")]);
      await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            tenantId: "tenant-X",
            mentalModelStore: spy.store,
          },
          agentId: "agent-Z",
          sessionKey: { tenantId: "tenant-X", userId: "user-Q", channelId: "chat-1" } as any,
        }),
      );

      // The exact dep the caller passed is the one that ran (forward-presence), scoped
      // to THIS prompt's (tenant, agent) — the load-bearing isolation boundary.
      expect(spy.lists()).toBe(1);
      const scopeArg = spy.lastScope()!;
      expect(scopeArg.tenantId).toBe("tenant-X");
      expect(scopeArg.agentId).toBe("agent-Z");
      // The single shared list is unfiltered (kind omitted) —
      // partitioned in-process for the profile block + the skill topic-match.
      expect(spy.lastKind()).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // 4b. memory:injected event emit
  // -----------------------------------------------------------------
  it("STORES the memory-injection summary (hitCount/charsInjected/trustTags) for postExecution to emit after the bridge subscribes", async () => {
    clearSessionPromptMemoryInjected(DEFAULT_SESSION_KEY);
    const mockSearchResults = [
      {
        entry: { id: "m1", tenantId: "t", content: "Inline pick", createdAt: Date.now(), tags: [], trustLevel: "learned", source: { channel: "test" } },
        score: 0.9,
      },
      {
        entry: { id: "m2", tenantId: "t", content: "Section pick", createdAt: Date.now(), tags: [], trustLevel: "system", source: { channel: "test" } },
        score: 0.8,
      },
    ];
    const memoryPort = {
      search: vi.fn().mockResolvedValue({ ok: true, value: mockSearchResults }),
      store: vi.fn(),
    } as any;
    // recall returns both ranked results -> hitCount/trustTags computed from them.
    mockRecall.mockResolvedValue({ ok: true, value: mockSearchResults });
    const emit = vi.fn();
    const eventBus = { emit, on: vi.fn(), off: vi.fn(), once: vi.fn(), listenerCount: vi.fn().mockReturnValue(0) } as any;
    // Hybrid split: inline memory present, plus a non-empty system section.
    mockHybridSplit.mockReturnValueOnce({
      inlineMemory: "[inline rag chunk]",
      systemPromptSections: ["section body"],
    });

    const params = makeParams({
      config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned", "system"], maxContextChars: 5000 } }),
      deps: { workspaceDir: "/workspace", memoryPort, eventBus },
    });
    await assembleExecutionPrompt(params);

    // Emit-timing contract: assembly STORES the summary (it does NOT emit inline — the bridge
    // isn't subscribed yet); postExecution emits memory:injected from the store after the bridge.
    const memoryEmit = emit.mock.calls.find((c: any[]) => c[0] === "memory:injected");
    expect(memoryEmit, "assembly must NOT emit memory:injected inline (pre-bridge — it would be lost)").toBeUndefined();
    const summary = getSessionPromptMemoryInjected(DEFAULT_SESSION_KEY);
    expect(summary, "the injection summary must be stored for postExecution to emit").toBeTruthy();
    expect(summary!.hitCount).toBe(2);
    // ranked.length === 2 -> the temporal-guidance block IS injected into the
    // prompt, but it is FIXED guidance text, NOT a retrieved memory. The
    // memory:injected telemetry must count retrieved memory ONLY (inline +
    // retrieved sections) and must NOT include the guidance-block length —
    // otherwise charsInjected disagrees with hitCount about what "injected"
    // means. Pin that charsInjected reflects ONLY the retrieved memory.
    const guidanceLen = buildTemporalGuidanceBlock(mockSearchResults as unknown as MemorySearchResult[])!.length;
    expect(guidanceLen, "guard: the guidance block must be non-empty for this assertion to bite").toBeGreaterThan(0);
    expect(summary!.charsInjected).toBe("[inline rag chunk]".length + "section body".length);
    // Consistency with hitCount: charsInjected must NOT carry the guidance block.
    expect(summary!.charsInjected).not.toBe(
      "[inline rag chunk]".length + "section body".length + guidanceLen,
    );
    expect(new Set(summary!.trustTags)).toEqual(new Set(["learned", "system"]));
  });

  it("does_not_store_when_no_injection (deduped is empty, the if-block is skipped)", async () => {
    clearSessionPromptMemoryInjected(DEFAULT_SESSION_KEY);
    const memoryPort = {
      // Empty results — deduplicateResults will produce an empty array
      // and the injector block is skipped entirely.
      search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      store: vi.fn(),
    } as any;
    const emit = vi.fn();
    const eventBus = { emit, on: vi.fn(), off: vi.fn(), once: vi.fn(), listenerCount: vi.fn().mockReturnValue(0) } as any;

    const params = makeParams({
      config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
      deps: { workspaceDir: "/workspace", memoryPort, eventBus },
    });
    await assembleExecutionPrompt(params);

    const memoryEmit = emit.mock.calls.find((c: any[]) => c[0] === "memory:injected");
    expect(memoryEmit, "memory:injected must not fire when no injection occurred").toBeUndefined();
    expect(getSessionPromptMemoryInjected(DEFAULT_SESSION_KEY), "nothing stored when no injection").toBeUndefined();
  });

  // -----------------------------------------------------------------
  // 5. RAG failure is non-fatal
  // -----------------------------------------------------------------
  it("does not throw when recall throws (non-fatal try/catch preserved)", async () => {
    const memoryPort = {
      search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    } as any;
    // recall throwing must be swallowed by the surrounding non-fatal try/catch.
    mockRecall.mockRejectedValue(new Error("RAG boom"));
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true } }),
      deps: { workspaceDir: "/workspace", memoryPort },
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("assembled-prompt");
    // memorySections fallback to empty
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.additionalSections).toEqual([]);
    // recall failed, so nothing injected into dynamic preamble either
    expect(result.dynamicPreamble).not.toContain("rag-section");
    expect(result.inlineMemory).toBeUndefined();
  });

  it("does not inject when recall returns an err Result (non-fatal degrade)", async () => {
    const memoryPort = {
      search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    } as any;
    mockRecall.mockResolvedValue({ ok: false, error: new Error("search failed in recall") });
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true } }),
      deps: { workspaceDir: "/workspace", memoryPort },
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.inlineMemory).toBeUndefined();
    expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------
  // 6. RAG skipped when no memoryPort
  // -----------------------------------------------------------------
  it("does not invoke RAG when memoryPort is absent", async () => {
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true } }),
      deps: { workspaceDir: "/workspace" }, // no memoryPort
    });
    const result = await assembleExecutionPrompt(params);

    expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
    expect(result.inlineMemory).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // 7. RAG skipped when rag.enabled=false
  // -----------------------------------------------------------------
  it("does not invoke RAG when rag.enabled is false", async () => {
    const memoryPort = { search: vi.fn() } as any;
    const params = makeParams({
      config: makeConfig({ rag: { enabled: false } }),
      deps: { workspaceDir: "/workspace", memoryPort },
    });
    const result = await assembleExecutionPrompt(params);

    expect(memoryPort.search).not.toHaveBeenCalled();
    expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
    expect(result.inlineMemory).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // 7b. RAG skipped when skipRag is true
  // -----------------------------------------------------------------
  it("does not invoke RAG when skipRag is true", async () => {
    const memoryPort = { search: vi.fn() } as any;
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
      deps: { workspaceDir: "/workspace", memoryPort },
      skipRag: true,
    });
    const result = await assembleExecutionPrompt(params);

    expect(memoryPort.search).not.toHaveBeenCalled();
    expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
    expect(result.inlineMemory).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // 8. hasMemoryTools detection
  // -----------------------------------------------------------------
  it("detects hasMemoryTools when memory_store is in tools", async () => {
    const params = makeParams({
      mergedCustomTools: [{ name: "memory_store" }] as any[],
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.hasMemoryTools).toBe(true);
  });

  it("detects hasMemoryTools when memory_search is in tools", async () => {
    const params = makeParams({
      mergedCustomTools: [{ name: "memory_search" }] as any[],
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.hasMemoryTools).toBe(true);
  });

  // -----------------------------------------------------------------
  // 9. Hook injection: systemPrompt override
  // -----------------------------------------------------------------
  it("uses hook systemPrompt override when provided", async () => {
    const hookRunner = {
      runBeforeAgentStart: vi.fn().mockResolvedValue({ systemPrompt: "hook-override" }),
    };
    const params = makeParams({
      deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("hook-override");
  });

  // -----------------------------------------------------------------
  // 10. Hook prependContext (relocated to dynamicPreamble)
  // -----------------------------------------------------------------
  it("relocates hook prependContext to dynamicPreamble", async () => {
    const hookRunner = {
      runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "PREPEND" }),
    };
    const params = makeParams({
      deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
    });
    const result = await assembleExecutionPrompt(params);

    // prependContext now in dynamicPreamble, not systemPrompt
    expect(result.dynamicPreamble).toContain("PREPEND");
    expect(result.systemPrompt).not.toContain("PREPEND");
    expect(result.systemPrompt).toBe("assembled-prompt");
  });

  // -----------------------------------------------------------------
  // 11. Safety reinforcement injection (relocated to dynamic preamble)
  // -----------------------------------------------------------------
  it("relocates safety reinforcement to dynamicPreamble", async () => {
    const params = makeParams({ safetyReinforcement: "SAFETY LINE" });
    const result = await assembleExecutionPrompt(params);

    // Safety reinforcement no longer in system prompt
    expect(result.systemPrompt).not.toContain("SAFETY LINE");
    // Now appears in dynamic preamble
    expect(result.dynamicPreamble).toContain("SAFETY LINE");
  });

  // -----------------------------------------------------------------
  // 12. API system prompt override (relocated to dynamicPreamble)
  // -----------------------------------------------------------------
  it("relocates wrapped external API system prompt to dynamicPreamble", async () => {
    const params = makeParams({
      msg: makeMsg({ metadata: { openaiSystemPrompt: "external instruction" } }),
    });
    const result = await assembleExecutionPrompt(params);

    // API system prompt now in dynamicPreamble, not systemPrompt
    expect(result.dynamicPreamble).toContain("external instruction");
    expect(result.systemPrompt).not.toContain("external instruction");
    // System prompt is untouched
    expect(result.systemPrompt).toBe("assembled-prompt");
  });

  // -----------------------------------------------------------------
  // 12b. SystemPromptReport build + persist
  // -----------------------------------------------------------------
  it("assembles_and_persists_system_prompt_report when observabilityStore wired", async () => {
    const insertSystemPromptReport = vi.fn();
    const observabilityStore = { insertSystemPromptReport };
    const params = makeParams({
      mergedCustomTools: [
        { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } as any,
      ],
      deps: { workspaceDir: "/workspace", observabilityStore: observabilityStore as any },
    });
    await assembleExecutionPrompt(params);

    expect(insertSystemPromptReport).toHaveBeenCalledTimes(1);
    const row = insertSystemPromptReport.mock.calls[0]![0];
    expect(row.agentId).toBe("agent-1");
    // sessionId is the formatSessionKey result; sanity check it's a string.
    expect(typeof row.sessionId).toBe("string");
    expect(row.sessionId.length).toBeGreaterThan(0);
    // The assembled prompt is the mock "assembled-prompt" — chars=16.
    expect(row.systemChars).toBe("assembled-prompt".length);
    // sha256 over "assembled-prompt"
    expect(typeof row.systemSha256).toBe("string");
    expect(row.systemSha256.length).toBe(64);
    // report_json is parsable and carries the schema marker
    const parsed = JSON.parse(row.reportJson);
    expect(parsed.traceSchema).toBe("comis-system-prompt-report");
    expect(parsed.schemaVersion).toBe(1);
    // The tool we registered surfaces in the tools.entries (with callable=true)
    const tool = parsed.tools.entries.find((t: any) => t.name === "read_file");
    expect(tool).toBeDefined();
    expect(tool.callable).toBe(true);
  });

  it("does_not_persist_when_no_observability_store_or_session_store_provided", async () => {
    const params = makeParams({
      mergedCustomTools: [],
      deps: { workspaceDir: "/workspace" },
    });
    // Should not throw — guarded by the `deps.observabilityStore !== undefined ||
    // deps.sessionStore !== undefined` check.
    const result = await assembleExecutionPrompt(params);
    expect(result.systemPrompt).toBe("assembled-prompt");
  });

  // -----------------------------------------------------------------
  // memoryInjection block must populate for RAG-section-only sessions,
  // not just inlineMemory.
  // -----------------------------------------------------------------
  it("memoryInjection populated when memorySections is non-empty even without inlineMemory", async () => {
    // Wire a RAG-enabled memoryPort + hybrid injector returning
    // sections-only (inlineMemory undefined, systemPromptSections populated).
    const sectionBody = "RAG section body here";
    const memoryPort = {
      search: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            entry: { id: "m1", tenantId: "t", content: "memory entry", createdAt: Date.now(), tags: [], trustLevel: "learned", source: { channel: "test" } },
            score: 0.9,
          },
        ],
      }),
      store: vi.fn(),
    } as any;
    mockRecall.mockResolvedValue({
      ok: true,
      value: [
        {
          entry: { id: "m1", tenantId: "t", content: "memory entry", createdAt: Date.now(), tags: [], trustLevel: "learned", source: { channel: "test" } },
          score: 0.9,
        },
      ],
    });
    mockHybridSplit.mockReturnValueOnce({
      inlineMemory: undefined,
      systemPromptSections: [sectionBody],
    });

    const insertSystemPromptReport = vi.fn();
    const observabilityStore = { insertSystemPromptReport };
    const params = makeParams({
      config: makeConfig({
        rag: {
          enabled: true,
          maxResults: 5,
          minScore: 0.3,
          includeTrustLevels: ["learned"],
          maxContextChars: 5000,
        },
      }),
      deps: {
        workspaceDir: "/workspace",
        observabilityStore: observabilityStore as any,
        memoryPort,
      },
    });
    await assembleExecutionPrompt(params);

    expect(insertSystemPromptReport).toHaveBeenCalledTimes(1);
    const row = insertSystemPromptReport.mock.calls[0]![0];
    const parsed = JSON.parse(row.reportJson);
    // The persisted report MUST carry a memoryInjection block (not
    // undefined) reflecting the RAG-sections-only injection. A predicate
    // of `inlineMemory ? { … } : undefined` would drop the block
    // entirely even when memorySections.length > 0 — this pins the
    // sections-only branch.
    expect(parsed.memoryInjection).toBeDefined();
    expect(parsed.memoryInjection.ragHits).toBe(1);
    expect(parsed.memoryInjection.charsInjected).toBe(sectionBody.length);
    expect(parsed.memoryInjection.trustTags).toEqual([]);
  });

  it("SystemPromptReport.memoryInjection excludes the temporal-guidance block from ragHits/charsInjected", async () => {
    // >=2 surfaced memories -> the temporal-guidance block IS pushed into
    // the prompt. The persisted report's ragHits/charsInjected must count the
    // RETRIEVED memory ONLY (the one inline + one section here), NOT the fixed
    // guidance text. Counting the guidance block over-counts: ragHits tallies it
    // as a RAG hit (2 sections -> ragHits 3 incl. inline) and
    // charsInjected includes the block's length.
    const sectionBody = "RAG section body for report path";
    const ranked = [
      {
        entry: { id: "m1", tenantId: "t", content: "Inline pick", createdAt: Date.now(), tags: [], trustLevel: "learned", source: { channel: "test" } },
        score: 0.9,
      },
      {
        entry: { id: "m2", tenantId: "t", content: "Section pick", createdAt: Date.now(), tags: [], trustLevel: "learned", source: { channel: "test" } },
        score: 0.8,
      },
    ];
    const memoryPort = {
      search: vi.fn().mockResolvedValue({ ok: true, value: ranked }),
      store: vi.fn(),
    } as any;
    mockRecall.mockResolvedValue({ ok: true, value: ranked });
    // Inline top-1 + one retrieved section; guidance block appended by source.
    mockHybridSplit.mockReturnValueOnce({
      inlineMemory: "[inline rag chunk]",
      systemPromptSections: [sectionBody],
    });

    const insertSystemPromptReport = vi.fn();
    const observabilityStore = { insertSystemPromptReport };
    const params = makeParams({
      config: makeConfig({
        rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 },
      }),
      deps: { workspaceDir: "/workspace", observabilityStore: observabilityStore as any, memoryPort },
    });
    await assembleExecutionPrompt(params);

    const guidanceLen = buildTemporalGuidanceBlock(ranked as unknown as MemorySearchResult[])!.length;
    expect(guidanceLen, "guard: the guidance block must be non-empty for this assertion to bite").toBeGreaterThan(0);

    expect(insertSystemPromptReport).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(insertSystemPromptReport.mock.calls[0]![0].reportJson);
    expect(parsed.memoryInjection).toBeDefined();
    // 1 inline + 1 retrieved section = 2 retrieved components. The guidance
    // block must NOT bump this to 3.
    expect(parsed.memoryInjection.ragHits).toBe(2);
    expect(parsed.memoryInjection.charsInjected).toBe("[inline rag chunk]".length + sectionBody.length);
    expect(parsed.memoryInjection.charsInjected).not.toBe(
      "[inline rag chunk]".length + sectionBody.length + guidanceLen,
    );
  });

  // -----------------------------------------------------------------
  // 13. Chat type resolution via metadata (tests resolveChatType)
  // -----------------------------------------------------------------
  describe("chat type resolution", () => {
    async function getChatType(metadata: Record<string, unknown>, channelType = "telegram") {
      const params = makeParams({
        msg: makeMsg({ metadata, channelType }),
      });
      await assembleExecutionPrompt(params);
      return mockAssembleRichSystemPrompt.mock.calls[0][0].inboundMeta.chatType;
    }

    it("resolves Telegram private to 'dm'", async () => {
      expect(await getChatType({ telegramChatType: "private" })).toBe("dm");
    });

    it("resolves Telegram group to 'group'", async () => {
      expect(await getChatType({ telegramChatType: "group" })).toBe("group");
    });

    it("resolves Telegram supergroup to 'group'", async () => {
      expect(await getChatType({ telegramChatType: "supergroup" })).toBe("group");
    });

    it("resolves Telegram channel to 'channel'", async () => {
      expect(await getChatType({ telegramChatType: "channel" })).toBe("channel");
    });

    it("resolves Discord with parentChannelId to 'thread'", async () => {
      expect(await getChatType({ parentChannelId: "parent-1" }, "discord")).toBe("thread");
    });

    it("resolves Discord with guildId to 'group'", async () => {
      expect(await getChatType({ guildId: "guild-1" }, "discord")).toBe("group");
    });

    it("resolves Discord plain to 'dm'", async () => {
      expect(await getChatType({}, "discord")).toBe("dm");
    });

    it("resolves Slack with slackThreadTs to 'thread'", async () => {
      expect(await getChatType({ slackThreadTs: "1234.5678" }, "slack")).toBe("thread");
    });

    it("resolves WhatsApp with isGroup=true to 'group'", async () => {
      expect(await getChatType({ isGroup: true }, "whatsapp")).toBe("group");
    });

    it("resolves Signal with signalGroupId to 'group'", async () => {
      expect(await getChatType({ signalGroupId: "group-1" }, "signal")).toBe("group");
    });

    it("resolves IRC with ircIsDm=true to 'dm'", async () => {
      expect(await getChatType({ ircIsDm: true }, "irc")).toBe("dm");
    });

    it("resolves IRC without ircIsDm to 'channel'", async () => {
      expect(await getChatType({}, "irc")).toBe("channel");
    });

    it("resolves LINE with lineSourceType 'group' to 'group'", async () => {
      expect(await getChatType({ lineSourceType: "group" }, "line")).toBe("group");
    });

    it("resolves LINE with lineSourceType 'room' to 'group'", async () => {
      expect(await getChatType({ lineSourceType: "room" }, "line")).toBe("group");
    });

    it("resolves LINE with lineSourceType 'user' to 'dm'", async () => {
      expect(await getChatType({ lineSourceType: "user" }, "line")).toBe("dm");
    });

    it("defaults to 'dm' with no metadata", async () => {
      expect(await getChatType({})).toBe("dm");
    });
  });

  // -----------------------------------------------------------------
  // 14. Message flags via metadata (tests buildMessageFlags)
  // -----------------------------------------------------------------
  describe("message flags", () => {
    async function getFlags(msgOverrides: Record<string, unknown>) {
      const params = makeParams({ msg: makeMsg(msgOverrides) });
      await assembleExecutionPrompt(params);
      return mockAssembleRichSystemPrompt.mock.calls[0][0].inboundMeta.flags;
    }

    it("sets isGroup when metadata.isGroup is true", async () => {
      const flags = await getFlags({ metadata: { isGroup: true } });
      expect(flags.isGroup).toBe(true);
    });

    it("sets isGroup when metadata.imsgIsGroup is true", async () => {
      const flags = await getFlags({ metadata: { imsgIsGroup: true } });
      expect(flags.isGroup).toBe(true);
    });

    it("sets isGroup when metadata.signalGroupId is present", async () => {
      const flags = await getFlags({ metadata: { signalGroupId: "g1" } });
      expect(flags.isGroup).toBe(true);
    });

    it("sets isThread when metadata.parentChannelId is present", async () => {
      const flags = await getFlags({ metadata: { parentChannelId: "p1" } });
      expect(flags.isThread).toBe(true);
    });

    it("sets isThread when metadata.slackThreadTs is present", async () => {
      const flags = await getFlags({ metadata: { slackThreadTs: "123.456" } });
      expect(flags.isThread).toBe(true);
    });

    it("sets hasAttachments when attachments array is non-empty", async () => {
      const flags = await getFlags({
        attachments: [{ type: "image", url: "https://example.com/img.png" }],
      });
      expect(flags.hasAttachments).toBe(true);
    });

    it("does not set hasAttachments when attachments is empty", async () => {
      const flags = await getFlags({ attachments: [] });
      expect(flags.hasAttachments).toBeUndefined();
    });

    it("sets isReply when replyTo is set", async () => {
      const flags = await getFlags({ replyTo: "reply-msg-1" });
      expect(flags.isReply).toBe(true);
    });

    it("sets isScheduled when metadata.isScheduled is true", async () => {
      const flags = await getFlags({ metadata: { isScheduled: true } });
      expect(flags.isScheduled).toBe(true);
    });

    it("sets isCronAgentTurn when metadata.isCronAgentTurn is true", async () => {
      const flags = await getFlags({ metadata: { isCronAgentTurn: true } });
      expect(flags.isCronAgentTurn).toBe(true);
    });

    it("does not set isScheduled for isCronAgentTurn messages", async () => {
      const flags = await getFlags({ metadata: { isCronAgentTurn: true } });
      expect(flags.isScheduled).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // 15. Prompt skills forwarding
  // -----------------------------------------------------------------
  it("puts promptSkillsXml in system prompt and activePromptSkillContent in preamble", async () => {
    const params = makeParams({
      deps: {
        workspaceDir: "/workspace",
        getPromptSkillsXml: () => "<skills>xml</skills>",
      },
      msg: makeMsg({ metadata: { promptSkillContent: "Active content" } }),
    });
    const result = await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    // promptSkillsXml routed through assemblerParams to semiStableBody (1h cache)
    expect(call.promptSkillsXml).toBe("<skills>xml</skills>");
    // Skills XML should NOT appear in dynamic preamble (removed from per-message injection)
    expect(result.dynamicPreamble).not.toContain("<skills>xml</skills>");
    expect(result.dynamicPreamble).not.toContain("## Available Skills");
    // activePromptSkillContent relocated to dynamic preamble
    expect(call.activePromptSkillContent).toBeUndefined();
    expect(result.dynamicPreamble).toContain("## Active Skill");
    expect(result.dynamicPreamble).toContain("Active content");
  });

  // -----------------------------------------------------------------
  // Additional: RuntimeInfo construction
  // -----------------------------------------------------------------
  it("builds runtimeInfo with os, host, model, channel from config and msg", async () => {
    const params = makeParams({
      config: makeConfig({ model: "gpt-4o" }),
      msg: makeMsg({ channelType: "discord" }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    const ri = call.runtimeInfo;
    expect(ri.host).toBe("test-host");
    expect(ri.os).toBe("linux");
    expect(ri.arch).toBe("x64");
    expect(ri.model).toBe("gpt-4o");
    expect(ri.channel).toBe("discord");
    expect(ri.shell).toBe("/bin/bash");
  });

  // -----------------------------------------------------------------
  // Additional: channelContext forwarding
  // -----------------------------------------------------------------
  it("passes channelContext as undefined for cache stability", async () => {
    const params = makeParams({
      msg: makeMsg({ channelType: "slack", channelId: "C123" }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.channelContext).toBeUndefined();
  });

  it("includes channel ID and announce hint in dynamic preamble", async () => {
    const params = makeParams({
      msg: makeMsg({ channelType: "slack", channelId: "C123" }),
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.dynamicPreamble).toContain("Current channel: slack (ID: C123)");
    expect(result.dynamicPreamble).toContain('announce_channel_type="slack"');
  });

  // -----------------------------------------------------------------
  // Additional: reasoningTagHint based on provider
  // -----------------------------------------------------------------
  it("sets reasoningTagHint=false for anthropic provider", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "anthropic" }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(false);
  });

  it("sets reasoningTagHint=true for non-anthropic provider", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai" }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(true);
  });

  it("sets reasoningTagHint=false for non-anthropic provider with native reasoning active", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai", thinkingLevel: "high" }),
    });
    await assembleExecutionPrompt(params);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(false);
  });

  it("sets reasoningTagHint=true for non-anthropic provider with thinkingLevel off", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai", thinkingLevel: "off" }),
    });
    await assembleExecutionPrompt(params);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(true);
  });

  it("sets reasoningTagHint=true for non-anthropic provider with no thinkingLevel config", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai" }),
    });
    await assembleExecutionPrompt(params);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(true);
  });

  it("sets reasoningTagHint=false for non-anthropic provider with resolvedModelReasoning=true", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai" }),
      resolvedModelReasoning: true,
    });
    await assembleExecutionPrompt(params);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(false);
  });

  it("sets reasoningTagHint=true for non-anthropic provider with resolvedModelReasoning=false", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai" }),
      resolvedModelReasoning: false,
    });
    await assembleExecutionPrompt(params);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(true);
  });

  // -----------------------------------------------------------------
  // Additional: safety reinforcement and hook prependContext both in dynamicPreamble
  // -----------------------------------------------------------------
  it("safety reinforcement and hook prependContext both appear in dynamicPreamble", async () => {
    const hookRunner = {
      runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "HOOK-CONTEXT" }),
    };
    const params = makeParams({
      deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
      safetyReinforcement: "SAFETY",
    });
    const result = await assembleExecutionPrompt(params);

    // Both safety and hook prependContext in dynamic preamble
    expect(result.dynamicPreamble).toContain("SAFETY");
    expect(result.dynamicPreamble).toContain("HOOK-CONTEXT");
    // Neither in system prompt
    expect(result.systemPrompt).not.toContain("HOOK-CONTEXT");
    expect(result.systemPrompt).not.toContain("SAFETY");
  });

  // -----------------------------------------------------------------
  // Additional: hook systemPrompt override + safety reinforcement in preamble
  // -----------------------------------------------------------------
  it("safety reinforcement in dynamicPreamble even when hook overrides systemPrompt", async () => {
    const hookRunner = {
      runBeforeAgentStart: vi.fn().mockResolvedValue({ systemPrompt: "hook-prompt" }),
    };
    const params = makeParams({
      deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
      safetyReinforcement: "SAFETY",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("hook-prompt");
    expect(result.dynamicPreamble).toContain("SAFETY");
  });

  // -----------------------------------------------------------------
  // Additional: media flags forwarding
  // -----------------------------------------------------------------
  it("forwards mediaPersistenceEnabled and autonomousMediaEnabled to assembler", async () => {
    const params = makeParams({
      deps: {
        workspaceDir: "/workspace",
        mediaPersistenceEnabled: true,
        autonomousMediaEnabled: true,
        outboundMediaEnabled: true,
      },
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.mediaPersistenceEnabled).toBe(true);
    expect(call.autonomousMediaEnabled).toBe(true);
    expect(call.outboundMediaEnabled).toBe(true);
  });

  // -----------------------------------------------------------------
  // Additional: default promptMode when bootstrap config is missing
  // -----------------------------------------------------------------
  it("defaults to 'full' promptMode when bootstrap config is missing", async () => {
    const params = makeParams({
      config: makeConfig({ bootstrap: undefined }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.promptMode).toBe("full");
  });

  // -----------------------------------------------------------------
  // 16. postCompactionSections config threading
  // -----------------------------------------------------------------
  it("threads postCompactionSections from config.session.compaction to assembler", async () => {
    const params = makeParams({
      config: makeConfig({
        session: { compaction: { postCompactionSections: ["Custom Section", "Another"] } },
      }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.postCompactionSections).toEqual(["Custom Section", "Another"]);
  });

  it("passes undefined postCompactionSections when session config is absent", async () => {
    const params = makeParams({
      config: makeConfig({ session: undefined }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.postCompactionSections).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // Context filtering
  // -----------------------------------------------------------------
  describe("context filtering", () => {
    const fakeBootstrapFiles = [
      { name: "SOUL.md", path: "/ws/SOUL.md", content: "soul", missing: false },
      { name: "IDENTITY.md", path: "/ws/IDENTITY.md", content: "identity", missing: false },
      { name: "USER.md", path: "/ws/USER.md", content: "user", missing: false },
      { name: "AGENTS.md", path: "/ws/AGENTS.md", content: "agents", missing: false },
      { name: "TOOLS.md", path: "/ws/TOOLS.md", content: "tools", missing: false },
      { name: "HEARTBEAT.md", path: "/ws/HEARTBEAT.md", content: "heartbeat", missing: false },
      { name: "BOOTSTRAP.md", path: "/ws/BOOTSTRAP.md", content: "bootstrap", missing: false },
    ];

    // tests (lightContext)

    it("applies lightContext filter when msg.metadata.lightContext is true", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { lightContext: true, trigger: "heartbeat", isScheduled: true } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForLightContext).toHaveBeenCalledOnce();
      expect(mockFilterBootstrapFilesForLightContext).toHaveBeenCalledWith(fakeBootstrapFiles);
      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    it("does not apply lightContext filter when metadata.lightContext is absent", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: {} }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForLightContext).not.toHaveBeenCalled();
    });

    // tests (group chat)

    it("applies group chat filter for Telegram group messages", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { telegramChatType: "group" } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForGroupChat).toHaveBeenCalledOnce();
    });

    it("applies group chat filter for Discord guild threads", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { parentChannelId: "p1", guildId: "g1" }, channelType: "discord" }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForGroupChat).toHaveBeenCalledOnce();
    });

    it("does not apply group chat filter for DM messages", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { telegramChatType: "private" } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    // tests (config opt-out)

    it("does not apply group chat filter when groupChatFiltering is false", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        config: makeConfig({ bootstrap: { promptMode: "full", groupChatFiltering: false } }),
        msg: makeMsg({ metadata: { telegramChatType: "group" } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    // Filter precedence test

    it("lightContext takes precedence over group chat filter", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { lightContext: true, telegramChatType: "group" } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForLightContext).toHaveBeenCalledOnce();
      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    // test (sub-agent / promptMode none)

    it("promptMode none skips all filtering", async () => {
      const params = makeParams({
        config: makeConfig({ bootstrap: { promptMode: "none" } }),
        msg: makeMsg({ metadata: { lightContext: true, telegramChatType: "group" } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockLoadWorkspaceBootstrapFiles).not.toHaveBeenCalled();
      expect(mockFilterBootstrapFilesForLightContext).not.toHaveBeenCalled();
      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    // Operational-mode filter tests

    it("operationType='heartbeat' implies effectiveLightContext=true even without metadata flag", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: {} }), // no lightContext flag
        operationType: "heartbeat",
      });
      await assembleExecutionPrompt(params);

      // Heartbeat auto-derives the light-context filter -- HEARTBEAT.md only
      expect(mockFilterBootstrapFilesForLightContext).toHaveBeenCalledOnce();
      expect(mockFilterBootstrapFilesForLightContext).toHaveBeenCalledWith(fakeBootstrapFiles);
      expect(mockFilterBootstrapFilesForCron).not.toHaveBeenCalled();
      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    it("operationType='cron' applies cron bootstrap filter (SOUL.md + ROLE.md only)", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: {} }),
        operationType: "cron",
      });
      await assembleExecutionPrompt(params);

      // Cron bootstrap filter is applied instead of light-context / group-chat filters
      expect(mockFilterBootstrapFilesForCron).toHaveBeenCalledOnce();
      expect(mockFilterBootstrapFilesForCron).toHaveBeenCalledWith(fakeBootstrapFiles);
      expect(mockFilterBootstrapFilesForLightContext).not.toHaveBeenCalled();
      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    it("operationType='cron' upgrades promptMode from 'full' to 'operational'", async () => {
      const params = makeParams({
        config: makeConfig({ bootstrap: { promptMode: "full" } }),
        operationType: "cron",
      });
      await assembleExecutionPrompt(params);

      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.promptMode).toBe("operational");
    });

    it("operationType='heartbeat' upgrades promptMode from 'full' to 'operational'", async () => {
      const params = makeParams({
        config: makeConfig({ bootstrap: { promptMode: "full" } }),
        operationType: "heartbeat",
      });
      await assembleExecutionPrompt(params);

      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.promptMode).toBe("operational");
    });

    it("explicit config promptMode='minimal' wins over cron auto-upgrade", async () => {
      const params = makeParams({
        config: makeConfig({ bootstrap: { promptMode: "minimal" } }),
        operationType: "cron",
      });
      await assembleExecutionPrompt(params);

      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.promptMode).toBe("minimal");
    });

    it("operationType='interactive' leaves promptMode='full' unchanged", async () => {
      const params = makeParams({
        config: makeConfig({ bootstrap: { promptMode: "full" } }),
        operationType: "interactive",
      });
      await assembleExecutionPrompt(params);

      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.promptMode).toBe("full");
    });

    it("metadata.lightContext=true takes precedence over cron bootstrap filter", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { lightContext: true } }),
        operationType: "cron",
      });
      await assembleExecutionPrompt(params);

      // effectiveLightContext short-circuits to the light-context filter before the cron branch
      expect(mockFilterBootstrapFilesForLightContext).toHaveBeenCalledOnce();
      expect(mockFilterBootstrapFilesForCron).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // resolvePromptModeForProfile priority ladder (compact-secure wins
  // over the cron/heartbeat → operational downgrade for small/nano).
  // -----------------------------------------------------------------
  describe("resolvePromptModeForProfile cron/heartbeat on small/nano", () => {
    const smallProfile = { capabilityClass: "small" } as any;
    const nanoProfile = { capabilityClass: "nano" } as any;
    const frontierProfile = { capabilityClass: "frontier" } as any;
    const compactOn = { enabled: true };

    it("small + cron + full → compact-secure (NOT operational) — keeps the anti-injection hardening", () => {
      expect(resolvePromptModeForProfile("full", "cron", smallProfile, compactOn)).toBe("compact-secure");
    });

    it("nano + heartbeat + full → compact-secure (NOT operational)", () => {
      expect(resolvePromptModeForProfile("full", "heartbeat", nanoProfile, compactOn)).toBe("compact-secure");
    });

    it("small + interactive + full → compact-secure (unchanged)", () => {
      expect(resolvePromptModeForProfile("full", "interactive", smallProfile, compactOn)).toBe("compact-secure");
    });

    it("frontier + cron + full → operational (large-tier downgrade preserved)", () => {
      expect(resolvePromptModeForProfile("full", "cron", frontierProfile, compactOn)).toBe("operational");
    });

    it("no profile + cron + full → operational (existing behavior preserved)", () => {
      expect(resolvePromptModeForProfile("full", "cron", undefined, compactOn)).toBe("operational");
    });

    it("small + cron + full but compactPrompt disabled → operational (opt-out respected)", () => {
      expect(resolvePromptModeForProfile("full", "cron", smallProfile, { enabled: false })).toBe("operational");
    });

    it("explicit minimal baseMode wins for small + cron (no auto-upgrade from non-full)", () => {
      expect(resolvePromptModeForProfile("minimal", "cron", smallProfile, compactOn)).toBe("minimal");
    });
  });

  // -----------------------------------------------------------------
  // BOOT.md injection (relocated from system prompt to dynamic preamble)
  // -----------------------------------------------------------------
  describe("BOOT.md injection", () => {
    it("injects BOOT.md content into dynamicPreamble when isFirstMessageInSession=true", async () => {
      mockReadFile.mockResolvedValue("Check HEARTBEAT.md for pending tasks");
      mockIsBootContentEffectivelyEmpty.mockReturnValue(false);
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("[Session startup instructions from BOOT.md]");
      expect(result.dynamicPreamble).toContain("Check HEARTBEAT.md for pending tasks");
      expect(result.dynamicPreamble).toContain("[End startup instructions]");
      // System prompt remains unchanged
      expect(result.systemPrompt).not.toContain("[Session startup instructions");
    });

    it("skips BOOT.md injection when isFirstMessageInSession=false", async () => {
      mockReadFile.mockResolvedValue("Some boot content");
      mockIsBootContentEffectivelyEmpty.mockReturnValue(false);
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: false },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[Session startup instructions");
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("skips BOOT.md injection when lightContext=true even if isFirstMessageInSession=true", async () => {
      mockReadFile.mockResolvedValue("Some boot content");
      mockIsBootContentEffectivelyEmpty.mockReturnValue(false);
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
        msg: makeMsg({ metadata: { lightContext: true } }),
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[Session startup instructions");
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("skips BOOT.md injection when file content is effectively empty", async () => {
      mockReadFile.mockResolvedValue("# BOOT.md\n\n# Just headers");
      mockIsBootContentEffectivelyEmpty.mockReturnValue(true);
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[Session startup instructions");
    });

    it("skips BOOT.md injection when file is missing (no error thrown)", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.systemPrompt).toBe("assembled-prompt");
      expect(result.dynamicPreamble).not.toContain("[Session startup instructions");
    });
  });

  // -----------------------------------------------------------------
  // userLanguage extraction from USER.md
  // -----------------------------------------------------------------
  it("passes userLanguage to assembler when USER.md has preferred language", async () => {
    mockBuildBootstrapContextFiles.mockReturnValue([
      { path: "USER.md", content: "- **Preferred language:** Hebrew\n- **Notes:**" },
    ]);
    await assembleExecutionPrompt(makeParams());

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.userLanguage).toBe("Hebrew");
  });

  it("passes undefined userLanguage when USER.md has no preferred language", async () => {
    mockBuildBootstrapContextFiles.mockReturnValue([
      { path: "USER.md", content: "- **Name:** Mosh\n- **Notes:**" },
    ]);
    await assembleExecutionPrompt(makeParams());

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.userLanguage).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // Onboarding injection (relocated from system prompt to dynamic preamble)
  // -----------------------------------------------------------------
  describe("Onboarding injection", () => {
    it("injects BOOTSTRAP.md with onboarding framing into dynamicPreamble", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("Bootstrap content here");
      const params = makeParams();
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("[ONBOARDING ACTIVE");
      expect(result.dynamicPreamble).toContain("Bootstrap content here");
      expect(result.dynamicPreamble).toContain("[End onboarding instructions]");
      // System prompt remains unchanged
      expect(result.systemPrompt).not.toContain("[ONBOARDING ACTIVE");
    });

    it("passes excludeBootstrapFromContext=true to assembler when onboarding", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("Bootstrap content");
      const params = makeParams();
      await assembleExecutionPrompt(params);

      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.excludeBootstrapFromContext).toBe(true);
    });

    it("does not inject onboarding when isOnboarding=false", async () => {
      mockDetectOnboardingState.mockResolvedValue(false);
      const params = makeParams();
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[ONBOARDING ACTIVE");
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.excludeBootstrapFromContext).toBe(true);  // Always excluded: either elevated (onboarding) or dead weight (post-onboarding)
    });

    it("onboarding injection coexists with BOOT.md injection in dynamicPreamble", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("file content");
      mockIsBootContentEffectivelyEmpty.mockReturnValue(false);
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
      });
      const result = await assembleExecutionPrompt(params);

      // Both blocks present in dynamic preamble
      expect(result.dynamicPreamble).toContain("[ONBOARDING ACTIVE");
      expect(result.dynamicPreamble).toContain("[Session startup instructions from BOOT.md]");
      // Onboarding appears first due to unshift ordering
      const onboardIdx = result.dynamicPreamble.indexOf("[ONBOARDING ACTIVE");
      const bootIdx = result.dynamicPreamble.indexOf("[Session startup instructions from BOOT.md]");
      expect(onboardIdx).toBeLessThan(bootIdx);
    });

    it("skips onboarding injection when BOOTSTRAP.md read fails", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const params = makeParams();
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[ONBOARDING ACTIVE");
      // excludeBootstrapFromContext is still true because detection passed
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.excludeBootstrapFromContext).toBe(true);
    });

    // Specialist-profile agents are task workers and must never receive the
    // "greet the user, ask who I am" onboarding script, even when their
    // workspace is freshly seeded and detectOnboardingState returns true.
    it("does NOT inject onboarding for workspace.profile='specialist' even when isOnboarding=true", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("Bootstrap content that must not leak");
      const params = makeParams({
        config: makeConfig({ workspace: { profile: "specialist" } }),
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[ONBOARDING ACTIVE");
      expect(result.dynamicPreamble).not.toContain("Bootstrap content that must not leak");
    });

    it("still injects onboarding for workspace.profile='full' (default-agent path preserved)", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("First-run greeting");
      const params = makeParams({
        config: makeConfig({ workspace: { profile: "full" } }),
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("[ONBOARDING ACTIVE");
      expect(result.dynamicPreamble).toContain("First-run greeting");
    });
  });

  // -----------------------------------------------------------------
  // Dynamic content relocation tests
  // -----------------------------------------------------------------
  describe("dynamic content relocation", () => {
    it("channel appears in dynamicPreamble not system prompt Runtime section", async () => {
      const params = makeParams({
        msg: makeMsg({ channelType: "discord" }),
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("## Channel");
      expect(result.dynamicPreamble).toContain("discord");
      // RuntimeInfo struct still carries channel for internal use
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.runtimeInfo.channel).toBe("discord");
    });

    it("sender trust entries appear in dynamicPreamble not system prompt", async () => {
      const params = makeParams({
        config: makeConfig({
          elevatedReply: { senderTrustMap: { "user-1": "admin" }, defaultTrustLevel: "external" },
        }),
        deps: {
          workspaceDir: "/workspace",
          senderTrustDisplayConfig: { enabled: true, displayMode: "raw" },
        },
      });
      const result = await assembleExecutionPrompt(params);

      // trust section appears in dynamicPreamble
      expect(result.dynamicPreamble).toContain("## Authorized Senders");
      // Not passed to assembler
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.senderTrustEntries).toEqual([]);
      expect(call.senderTrustDisplayMode).toBe("raw");
    });

    it("additionalSections is always empty (RAG relocated to preamble)", async () => {
      const mockSearchResult = {
        entry: { id: "m1", tenantId: "t", content: "Test memory", createdAt: Date.now(), tags: [], trustLevel: "learned", source: { channel: "test" } },
        score: 0.85,
      };
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [mockSearchResult] }),
        store: vi.fn(),
      } as any;
      mockRecall.mockResolvedValue({ ok: true, value: [mockSearchResult] });
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.additionalSections).toEqual([]);
      expect(result.dynamicPreamble).toContain("rag-section-1");
    });

    it("subagentRole passed as undefined to assembler (relocated to dynamic preamble)", async () => {
      mockBuildSubagentRoleSection.mockReturnValue(["## Subagent Role", "", "You are a subagent."]);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          spawnPacket: { task: "Analyze logs", depth: 1 } as any,
        },
      });
      const result = await assembleExecutionPrompt(params);

      // Verify subagentRole is passed as undefined to assembler
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.subagentRole).toBeUndefined();
      // Subagent role appears in dynamic preamble
      expect(result.dynamicPreamble).toContain("## Subagent Role");
      expect(result.dynamicPreamble).toContain("You are a subagent.");
    });

    it("canarySecret and sessionKey not passed to assembler (relocated to dynamic preamble)", async () => {
      const secretManager = { get: (key: string) => key === "CANARY_SECRET" ? "test-secret" : undefined };
      const params = makeParams({
        deps: { workspaceDir: "/workspace", secretManager: secretManager as any },
      });
      await assembleExecutionPrompt(params);

      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.canarySecret).toBeUndefined();
      expect(call.sessionKey).toBeUndefined();
    });

    // compact-secure + senderTrustDisplayConfig disabled → WARN log
    it("compact-secure active with senderTrustDisplayConfig disabled emits the sender-trust WARN log", async () => {
      // Trigger compact-secure mode: small capabilityClass + compactPrompt.enabled (default true).
      const smallProfile = {
        capabilityClass: "small",
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
        securityLevel: "standard",
      } as any;
      const params = makeParams({
        // senderTrustDisplayConfig NOT set (undefined → disabled by default)
        deps: { workspaceDir: "/workspace" },
        // Pass a small-class model profile to trigger compact-secure mode
        modelProfile: smallProfile,
      });
      // Also clear snapshot so promptMode resolves fresh (not cached from another test)
      const sessionKey = formatSessionKey(params.sessionKey as any);
      clearSessionToolNameSnapshot(sessionKey);
      clearSessionBootstrapFileSnapshot(sessionKey);
      clearSessionPromptSkillsXmlSnapshot(sessionKey);
      clearCacheSafeParams(sessionKey);

      await assembleExecutionPrompt(params);

      // Must emit exactly the sender-trust WARN
      const warnCalls = (params.logger.warn as any).mock.calls;
      const wr02Warn = warnCalls.find(
        (c: any[]) => typeof c[1] === "string" && c[1].includes("S1: sender-trust not injected in compact-secure"),
      );
      expect(wr02Warn).toBeDefined();
      // Structured log field assertions (submodule per CLAUDE.md logging — module is bound via getLogger)
      expect(wr02Warn![0]).toMatchObject({
        submodule: "prompt-assembly",
        errorKind: "config",
        hint: expect.stringContaining("senderTrustDisplayConfig"),
      });
    });

    it("compact-secure with senderTrustDisplayConfig.enabled=true does NOT emit the sender-trust WARN", async () => {
      const smallProfile = {
        capabilityClass: "small",
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
        securityLevel: "standard",
      } as any;
      const params = makeParams({
        config: makeConfig({
          elevatedReply: { senderTrustMap: { "user-1": "trusted" }, defaultTrustLevel: "external" },
        }),
        deps: {
          workspaceDir: "/workspace",
          // senderTrustDisplayConfig IS enabled → WARN must not fire
          senderTrustDisplayConfig: { enabled: true, displayMode: "raw" },
        },
        modelProfile: smallProfile,
      });
      const sessionKey = formatSessionKey(params.sessionKey as any);
      clearSessionToolNameSnapshot(sessionKey);
      clearSessionBootstrapFileSnapshot(sessionKey);
      clearSessionPromptSkillsXmlSnapshot(sessionKey);
      clearCacheSafeParams(sessionKey);

      await assembleExecutionPrompt(params);

      const warnCalls = (params.logger.warn as any).mock.calls;
      const wr02Warn = warnCalls.find(
        (c: any[]) => typeof c[1] === "string" && c[1].includes("S1: sender-trust not injected in compact-secure"),
      );
      expect(wr02Warn).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // System prompt stability across session states
  // -----------------------------------------------------------------
  it("system prompt is identical regardless of isFirstMessageInSession or safetyReinforcement", async () => {
    // Turn 1 with BOOT.md and safety
    mockReadFile.mockResolvedValue("Boot content");
    mockIsBootContentEffectivelyEmpty.mockReturnValue(false);
    const params1 = makeParams({
      deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
      safetyReinforcement: "SAFETY LINE",
    });
    const result1 = await assembleExecutionPrompt(params1);

    // Turn 2 without BOOT.md or safety
    const params2 = makeParams({
      deps: { workspaceDir: "/workspace", isFirstMessageInSession: false },
    });
    const result2 = await assembleExecutionPrompt(params2);

    // System prompts must be identical (both just "assembled-prompt" from mock)
    expect(result1.systemPrompt).toBe(result2.systemPrompt);
    // But dynamic preambles differ
    expect(result1.dynamicPreamble).not.toBe(result2.dynamicPreamble);
    expect(result1.dynamicPreamble).toContain("SAFETY LINE");
    expect(result1.dynamicPreamble).toContain("[Session startup instructions from BOOT.md]");
    expect(result2.dynamicPreamble).not.toContain("SAFETY LINE");
    expect(result2.dynamicPreamble).not.toContain("[Session startup instructions from BOOT.md]");
  });

  // -----------------------------------------------------------------
  // Prompt budget breakdown logging
  // -----------------------------------------------------------------

  it("emits Prompt budget breakdown INFO log with all required fields", async () => {
    const params = makeParams({
      mergedCustomTools: [{ name: "bash" }, { name: "file_read" }] as any[],
      deps: {
        workspaceDir: "/workspace",
        isFirstMessageInSession: true,
        spawnPacket: { task: "Analyze logs", depth: 1 } as any,
      },
    });
    await assembleExecutionPrompt(params);

    const infoCalls = (params.logger.info as any).mock.calls;
    const budgetCall = infoCalls.find(
      ([_fields, msg]: [any, string]) => msg === "Prompt budget breakdown",
    );
    expect(budgetCall).toBeDefined();
    const [fields] = budgetCall!;
    expect(typeof fields.systemPromptTokens).toBe("number");
    expect(typeof fields.dynamicPreambleTokens).toBe("number");
    expect(typeof fields.systemPromptChars).toBe("number");
    expect(typeof fields.dynamicPreambleChars).toBe("number");
    expect(typeof fields.bootstrapChars).toBe("number");
    expect(typeof fields.bootstrapPercent).toBe("number");
    expect(fields.toolCount).toBe(2);
    expect(fields.isFirstMessage).toBe(true);
    expect(fields.hasSpawnPacket).toBe(true);
  });

  it("defaults isFirstMessage to false when undefined", async () => {
    const params = makeParams({
      deps: { workspaceDir: "/workspace" },
    });
    await assembleExecutionPrompt(params);

    const infoCalls = (params.logger.info as any).mock.calls;
    const budgetCall = infoCalls.find(
      ([_fields, msg]: [any, string]) => msg === "Prompt budget breakdown",
    );
    expect(budgetCall).toBeDefined();
    const [fields] = budgetCall!;
    expect(fields.isFirstMessage).toBe(false);
  });

  it("defaults hasSpawnPacket to false when no spawnPacket", async () => {
    const params = makeParams({
      deps: { workspaceDir: "/workspace" },
    });
    await assembleExecutionPrompt(params);

    const infoCalls = (params.logger.info as any).mock.calls;
    const budgetCall = infoCalls.find(
      ([_fields, msg]: [any, string]) => msg === "Prompt budget breakdown",
    );
    expect(budgetCall).toBeDefined();
    const [fields] = budgetCall!;
    expect(fields.hasSpawnPacket).toBe(false);
  });

  it("bootstrap budget warn includes toolDefOverheadChars and totalEstimatedChars when warn fires", async () => {
    // Non-brittle: only assert field types, not exact values (threshold/content-dependent).
    const params = makeParams({
      deps: { workspaceDir: "/workspace" },
    });
    await assembleExecutionPrompt(params);

    const warnCalls = (params.logger.warn as any).mock.calls;
    const warnCall = warnCalls.find(
      ([_fields, msg]: [any, string]) => msg === "Bootstrap content exceeds budget threshold",
    );
    if (warnCall) {
      const [fields] = warnCall;
      expect(typeof fields.toolDefOverheadChars).toBe("number");
      expect(typeof fields.totalEstimatedChars).toBe("number");
    }
    // If warn didn't fire (below threshold), that's fine — test is non-brittle
  });

  // -----------------------------------------------------------------
  // Delivery mirror injection
  // -----------------------------------------------------------------
  describe("delivery mirror injection", () => {
    function createMockMirror(pendingEntries: any[] = []) {
      return {
        record: vi.fn(),
        pending: vi.fn().mockResolvedValue({ ok: true, value: pendingEntries }),
        acknowledge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        pruneOld: vi.fn(),
      };
    }

    function makeMirrorEntry(overrides: Record<string, unknown> = {}) {
      return {
        id: "mirror-1",
        sessionKey: "agent-1:telegram:chat-1",
        text: "Hello from the other side",
        mediaUrls: [],
        channelType: "telegram",
        channelId: "chat-1",
        origin: "agent",
        idempotencyKey: "key-1",
        status: "pending",
        createdAt: Date.now(),
        acknowledgedAt: null,
        ...overrides,
      };
    }

    it("injects mirror entries into dynamicPreamble when deliveryMirror has pending entries", async () => {
      const entries = [
        makeMirrorEntry({ id: "m1", text: "First message" }),
        makeMirrorEntry({ id: "m2", text: "Second message", channelType: "discord" }),
      ];
      const mirror = createMockMirror(entries);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          deliveryMirror: mirror as any,
          deliveryMirrorConfig: { maxEntriesPerInjection: 10, maxCharsPerInjection: 4000 },
        },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("## Your Recent Outbound Messages");
      expect(result.dynamicPreamble).toContain("[You sent on telegram]: First message");
      expect(result.dynamicPreamble).toContain("[You sent on discord]: Second message");
    });

    it("respects maxEntriesPerInjection budget", async () => {
      const entries = [
        makeMirrorEntry({ id: "m1", text: "Entry 1" }),
        makeMirrorEntry({ id: "m2", text: "Entry 2" }),
        makeMirrorEntry({ id: "m3", text: "Entry 3" }),
        makeMirrorEntry({ id: "m4", text: "Entry 4" }),
        makeMirrorEntry({ id: "m5", text: "Entry 5" }),
      ];
      const mirror = createMockMirror(entries);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          deliveryMirror: mirror as any,
          deliveryMirrorConfig: { maxEntriesPerInjection: 2, maxCharsPerInjection: 40000 },
        },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("Entry 1");
      expect(result.dynamicPreamble).toContain("Entry 2");
      expect(result.dynamicPreamble).not.toContain("Entry 3");
      // Only 2 IDs acknowledged
      expect(mirror.acknowledge).toHaveBeenCalledWith(["m1", "m2"]);
    });

    it("respects maxCharsPerInjection budget", async () => {
      const entries = [
        makeMirrorEntry({ id: "m1", text: "Short" }),       // 5 chars
        makeMirrorEntry({ id: "m2", text: "A".repeat(20) }), // 20 chars -- total 25, under 30
        makeMirrorEntry({ id: "m3", text: "B".repeat(20) }), // 20 chars -- total 45, over 30
      ];
      const mirror = createMockMirror(entries);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          deliveryMirror: mirror as any,
          deliveryMirrorConfig: { maxEntriesPerInjection: 100, maxCharsPerInjection: 30 },
        },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("Short");
      expect(result.dynamicPreamble).toContain("A".repeat(20));
      expect(result.dynamicPreamble).not.toContain("B".repeat(20));
      // Only 2 IDs acknowledged
      expect(mirror.acknowledge).toHaveBeenCalledWith(["m1", "m2"]);
    });

    it("calls acknowledge for injected entries", async () => {
      const entries = [
        makeMirrorEntry({ id: "m1", text: "Msg 1" }),
        makeMirrorEntry({ id: "m2", text: "Msg 2" }),
      ];
      const mirror = createMockMirror(entries);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          deliveryMirror: mirror as any,
        },
      });
      await assembleExecutionPrompt(params);

      expect(mirror.acknowledge).toHaveBeenCalledWith(["m1", "m2"]);
    });

    it("skips injection when deliveryMirror is undefined", async () => {
      const params = makeParams({
        deps: { workspaceDir: "/workspace" },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("Your Recent Outbound Messages");
    });

    it("skips injection when no pending entries", async () => {
      const mirror = createMockMirror([]);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          deliveryMirror: mirror as any,
        },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("Your Recent Outbound Messages");
      expect(mirror.acknowledge).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // Tool name snapshotting
  // -----------------------------------------------------------------
  describe("tool name snapshotting", () => {
    afterEach(() => {
      // Clean up snapshot between tests
      clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
    });

    it("uses first-turn tool names for system prompt on subsequent turns", async () => {
      // First turn: 3 tools
      const params1 = makeParams({
        mergedCustomTools: [{ name: "read" }, { name: "exec" }, { name: "write" }] as any[],
      });
      await assembleExecutionPrompt(params1);
      const call1 = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call1.toolNames).toEqual(["read", "exec", "write"]);

      mockAssembleRichSystemPrompt.mockClear();

      // Second turn: different tools (simulating MCP tools connecting)
      const params2 = makeParams({
        mergedCustomTools: [{ name: "read" }, { name: "exec" }, { name: "write" }, { name: "mcp_search" }, { name: "mcp_query" }] as any[],
      });
      await assembleExecutionPrompt(params2);
      const call2 = mockAssembleRichSystemPrompt.mock.calls[0][0];
      // Should still use the first-turn snapshot
      expect(call2.toolNames).toEqual(["read", "exec", "write"]);
    });

    it("creates fresh snapshot after clearSessionToolNameSnapshot", async () => {
      const params1 = makeParams({
        mergedCustomTools: [{ name: "read" }] as any[],
      });
      await assembleExecutionPrompt(params1);

      clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
      mockAssembleRichSystemPrompt.mockClear();

      const params2 = makeParams({
        mergedCustomTools: [{ name: "read" }, { name: "exec" }] as any[],
      });
      await assembleExecutionPrompt(params2);
      const call2 = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call2.toolNames).toEqual(["read", "exec"]);
    });
  });

  // -----------------------------------------------------------------
  // Bootstrap file snapshotting
  // -----------------------------------------------------------------
  describe("bootstrap file snapshotting", () => {
    beforeEach(() => {
      // Reset loadWorkspaceBootstrapFiles completely (clear once-queue and default)
      // to prevent cross-test leakage from earlier tests that also call assembleExecutionPrompt.
      mockLoadWorkspaceBootstrapFiles.mockReset();
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue([]);
      clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    });

    afterEach(() => {
      clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    });

    it("loads bootstrap files from disk only on first turn", async () => {
      // First turn: returns IDENTITY.md content
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce([
        { name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "original identity", missing: false },
      ]);
      mockBuildBootstrapContextFiles.mockReturnValue([
        { path: "IDENTITY.md", content: "original identity" },
      ]);

      const params1 = makeParams();
      await assembleExecutionPrompt(params1);

      expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalledTimes(1);

      // Second turn: mock returns different content (simulating agent writing file)
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce([
        { name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "CHANGED identity", missing: false },
      ]);

      mockAssembleRichSystemPrompt.mockClear();
      mockBuildBootstrapContextFiles.mockClear();

      const params2 = makeParams();
      await assembleExecutionPrompt(params2);

      // loadWorkspaceBootstrapFiles should NOT be called again -- snapshot reused
      expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalledTimes(1);
      // buildBootstrapContextFiles should receive the original snapshot
      expect(mockBuildBootstrapContextFiles).toHaveBeenCalledWith(
        [{ name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "original identity", missing: false }],
        expect.any(Object),
      );
    });

    it("creates fresh snapshot after clearSessionBootstrapFileSnapshot", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce([
        { name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "v1", missing: false },
      ]);

      const params1 = makeParams();
      await assembleExecutionPrompt(params1);

      clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce([
        { name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "v2", missing: false },
      ]);
      mockBuildBootstrapContextFiles.mockClear();

      const params2 = makeParams();
      await assembleExecutionPrompt(params2);

      // After clearing, should load fresh from disk
      expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalledTimes(2);
      expect(mockBuildBootstrapContextFiles).toHaveBeenCalledWith(
        [{ name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "v2", missing: false }],
        expect.any(Object),
      );
    });

    it("applies per-turn lightContext filtering on snapshotted files", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce([
        { name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "identity", missing: false },
        { name: "HEARTBEAT.md", path: "/workspace/HEARTBEAT.md", content: "heartbeat", missing: false },
      ]);

      // First turn: normal context
      const params1 = makeParams();
      await assembleExecutionPrompt(params1);

      // Second turn: light context (heartbeat) -- should filter snapshot, not reload
      mockBuildBootstrapContextFiles.mockClear();
      const params2 = makeParams({
        msg: makeMsg({ metadata: { lightContext: true } }),
      });
      await assembleExecutionPrompt(params2);

      // Still only 1 disk load
      expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalledTimes(1);
      // But buildBootstrapContextFiles receives filtered set (only HEARTBEAT.md)
      expect(mockBuildBootstrapContextFiles).toHaveBeenCalledWith(
        [{ name: "HEARTBEAT.md", path: "/workspace/HEARTBEAT.md", content: "heartbeat", missing: false }],
        expect.any(Object),
      );
    });
  });

  // -----------------------------------------------------------------
  // Hybrid memory injector -- inlineMemory
  // -----------------------------------------------------------------
  describe("hybrid memory injector -- inlineMemory", () => {
    function makeSearchResult(content: string, score: number, trustLevel = "learned") {
      return {
        entry: {
          id: `mem-${Math.random().toString(36).slice(2, 8)}`,
          tenantId: "test-tenant",
          content,
          createdAt: Date.now(),
          tags: [],
          trustLevel,
          source: { channel: "test" },
        },
        score,
      };
    }

    it("returns inlineMemory when hybrid injector produces one", async () => {
      const result1 = makeSearchResult("User prefers dark mode", 0.85);
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [result1] }),
      } as any;
      mockRecall.mockResolvedValue({ ok: true, value: [result1] });
      mockHybridSplit.mockReturnValue({
        inlineMemory: "\n[Relevant context: User prefers dark mode]\n",
        systemPromptSections: [],
      });
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.inlineMemory).toBe("\n[Relevant context: User prefers dark mode]\n");
      expect(result.dynamicPreamble).not.toContain("Relevant context");
    });

    it("returns undefined inlineMemory when all results are low-score", async () => {
      const result1 = makeSearchResult("Vague memory", 0.5);
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [result1] }),
      } as any;
      mockRecall.mockResolvedValue({ ok: true, value: [result1] });
      mockHybridSplit.mockReturnValue({
        inlineMemory: undefined,
        systemPromptSections: ["## Relevant Memories\n- some section"],
      });
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.inlineMemory).toBeUndefined();
      expect(result.dynamicPreamble).toContain("## Relevant Memories");
    });

    it("returns undefined inlineMemory when RAG is disabled", async () => {
      const memoryPort = { search: vi.fn() } as any;
      const params = makeParams({
        config: makeConfig({ rag: { enabled: false } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.inlineMemory).toBeUndefined();
      expect(memoryPort.search).not.toHaveBeenCalled();
    });

    it("passes the recall-ranked (trust-filtered) output to the hybrid injector", async () => {
      // Trust filtering is now recall's responsibility (covered by memory-recall.test.ts);
      // prompt-assembly forwards exactly what recall returns. Here recall already excluded
      // the external entry, so only the learned result reaches the injector.
      const learnedResult = makeSearchResult("Learned memory", 0.9, "learned");
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [learnedResult] }),
      } as any;
      mockRecall.mockResolvedValue({ ok: true, value: [learnedResult] });
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      await assembleExecutionPrompt(params);

      // The injector consumes recall's ranked output verbatim.
      expect(mockHybridSplit).toHaveBeenCalledWith([learnedResult], 5000);
    });

    it("skips hybrid injector when recall returns no results", async () => {
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      } as any;
      mockRecall.mockResolvedValue({ ok: true, value: [] });
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
      expect(result.inlineMemory).toBeUndefined();
    });

    it("skips hybrid injector when recall result is not ok", async () => {
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      } as any;
      mockRecall.mockResolvedValue({ ok: false, error: new Error("recall failed") });
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
      expect(result.inlineMemory).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // dynamic preamble relocation
  // -----------------------------------------------------------------
  describe("dynamic preamble relocation", () => {
    it("prependContext appears in dynamicPreamble, not systemPrompt", async () => {
      const hookRunner = {
        runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "Hook injected context" }),
      };
      const params = makeParams({
        deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("Hook injected context");
      expect(result.systemPrompt).not.toContain("Hook injected context");
    });

    it("systemPrompt digest is stable when prependContext varies", async () => {
      // Turn 1: prependContext = "context-turn-1"
      const hookRunner1 = {
        runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "context-turn-1" }),
      };
      const params1 = makeParams({
        deps: { workspaceDir: "/workspace", hookRunner: hookRunner1 as any },
      });
      const result1 = await assembleExecutionPrompt(params1);

      mockAssembleRichSystemPrompt.mockClear();

      // Turn 2: prependContext = "context-turn-2"
      const hookRunner2 = {
        runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "context-turn-2" }),
      };
      const params2 = makeParams({
        deps: { workspaceDir: "/workspace", hookRunner: hookRunner2 as any },
      });
      const result2 = await assembleExecutionPrompt(params2);

      // System prompts identical (both just "assembled-prompt" from mock)
      expect(result1.systemPrompt).toBe(result2.systemPrompt);
      // Dynamic preambles differ
      expect(result1.dynamicPreamble).toContain("context-turn-1");
      expect(result2.dynamicPreamble).toContain("context-turn-2");
      expect(result1.dynamicPreamble).not.toContain("context-turn-2");
    });

    it("hookResult.systemPrompt still replaces system prompt (hook override contract)", async () => {
      const hookRunner = {
        runBeforeAgentStart: vi.fn().mockResolvedValue({ systemPrompt: "Completely replaced prompt" }),
      };
      const params = makeParams({
        deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.systemPrompt).toBe("Completely replaced prompt");
    });

    it("API system prompt appears in dynamicPreamble, not systemPrompt", async () => {
      const params = makeParams({
        msg: makeMsg({ metadata: { openaiSystemPrompt: "External API instructions" } }),
      });
      const result = await assembleExecutionPrompt(params);

      // Wrapped content appears in dynamicPreamble
      expect(result.dynamicPreamble).toContain("External API instructions");
      // Not in systemPrompt
      expect(result.systemPrompt).not.toContain("External API instructions");
    });

    it("different API system prompts produce identical system prompt digests", async () => {
      // Call 1: API system prompt A
      const params1 = makeParams({
        msg: makeMsg({ metadata: { openaiSystemPrompt: "API instructions A" } }),
      });
      const result1 = await assembleExecutionPrompt(params1);

      mockAssembleRichSystemPrompt.mockClear();

      // Call 2: API system prompt B
      const params2 = makeParams({
        msg: makeMsg({ metadata: { openaiSystemPrompt: "API instructions B" } }),
      });
      const result2 = await assembleExecutionPrompt(params2);

      // System prompts identical
      expect(result1.systemPrompt).toBe(result2.systemPrompt);
      // Dynamic preambles differ
      expect(result1.dynamicPreamble).toContain("API instructions A");
      expect(result2.dynamicPreamble).toContain("API instructions B");
      expect(result1.dynamicPreamble).not.toContain("API instructions B");
    });

    it("wrapExternalContent is applied to API system prompt in dynamicPreamble", async () => {
      const params = makeParams({
        msg: makeMsg({ metadata: { openaiSystemPrompt: "Test API prompt" } }),
      });
      const result = await assembleExecutionPrompt(params);

      // Wrapped content should contain security markers from wrapExternalContent
      expect(result.dynamicPreamble).toContain("Test API prompt");
      // wrapExternalContent wraps with UNTRUSTED markers
      expect(result.dynamicPreamble).toMatch(/<<<UNTRUSTED_\w+>>>/);
      expect(result.dynamicPreamble).toMatch(/<<<END_UNTRUSTED_\w+>>>/);
    });
  });

  // -----------------------------------------------------------------
  // MCP server instructions injection
  // -----------------------------------------------------------------
  describe("MCP server instructions injection", () => {
    it("injects MCP server instructions into dynamic preamble", async () => {
      const result = await assembleExecutionPrompt(makeParams({
        deps: {
          workspaceDir: "/workspace",
          mcpServerInstructions: [
            { serverName: "context7", instructions: "Use resolve-library-id before query-docs." },
            { serverName: "filesystem", instructions: "Prefer read_file over read_directory." },
          ],
        },
      }));

      expect(result.dynamicPreamble).toContain("## MCP Server Instructions");
      expect(result.dynamicPreamble).toContain("### context7");
      expect(result.dynamicPreamble).toContain("Use resolve-library-id before query-docs.");
      expect(result.dynamicPreamble).toContain("### filesystem");
      expect(result.dynamicPreamble).toContain("Prefer read_file over read_directory.");
    });

    it("omits MCP server instructions section when none provided", async () => {
      const result = await assembleExecutionPrompt(makeParams({
        deps: { workspaceDir: "/workspace", mcpServerInstructions: undefined },
      }));

      expect(result.dynamicPreamble).not.toContain("MCP Server Instructions");
    });

    it("omits MCP server instructions section when array is empty", async () => {
      const result = await assembleExecutionPrompt(makeParams({
        deps: { workspaceDir: "/workspace", mcpServerInstructions: [] },
      }));

      expect(result.dynamicPreamble).not.toContain("MCP Server Instructions");
    });

    it("does not inject MCP server instructions into systemPrompt", async () => {
      const result = await assembleExecutionPrompt(makeParams({
        deps: {
          workspaceDir: "/workspace",
          mcpServerInstructions: [
            { serverName: "test-server", instructions: "Test instructions for cache stability." },
          ],
        },
      }));

      expect(result.systemPrompt).not.toContain("MCP Server Instructions");
      expect(result.systemPrompt).not.toContain("test-server");
      expect(result.dynamicPreamble).toContain("## MCP Server Instructions");
    });
  });
  // -----------------------------------------------------------------
  // Verbosity hints in dynamic preamble
  // -----------------------------------------------------------------
  describe("verbosity hints in dynamic preamble", () => {
    it("includes character limit hint when auto mode with channelMaxChars", async () => {
      const params = makeParams({
        config: makeConfig({
          verbosity: { enabled: true, defaultLevel: "auto", overrides: {} },
        }),
        deps: { workspaceDir: "/workspace", channelMaxChars: 4096 },
      });
      const result = await assembleExecutionPrompt(params);
      expect(result.dynamicPreamble).toContain("4096 character message limit");
    });

    it("omits verbosity hint when config.verbosity is undefined", async () => {
      const params = makeParams({
        config: makeConfig({ verbosity: undefined }),
      });
      const result = await assembleExecutionPrompt(params);
      expect(result.dynamicPreamble).not.toContain("character message limit");
      expect(result.dynamicPreamble).not.toContain("Response Style");
    });

    it("omits verbosity hint when config.verbosity.enabled is false", async () => {
      const params = makeParams({
        config: makeConfig({
          verbosity: { enabled: false, defaultLevel: "auto", overrides: {} },
        }),
        deps: { workspaceDir: "/workspace", channelMaxChars: 4096 },
      });
      const result = await assembleExecutionPrompt(params);
      expect(result.dynamicPreamble).not.toContain("character message limit");
    });

    it("includes Response Style section for concise level", async () => {
      const params = makeParams({
        config: makeConfig({
          verbosity: { enabled: true, defaultLevel: "concise", overrides: {} },
        }),
      });
      const result = await assembleExecutionPrompt(params);
      expect(result.dynamicPreamble).toContain("## Response Style");
      expect(result.dynamicPreamble).toContain("brief and focused");
    });

    it("does not leak verbosity hint into systemPrompt", async () => {
      const params = makeParams({
        config: makeConfig({
          verbosity: { enabled: true, defaultLevel: "auto", overrides: {} },
        }),
        deps: { workspaceDir: "/workspace", channelMaxChars: 2000 },
      });
      const result = await assembleExecutionPrompt(params);
      expect(result.systemPrompt).not.toContain("character message limit");
    });
  });

  // -----------------------------------------------------------------
  // Paired cache-fence regression tests. Both call
  // `assembleExecutionPrompt` twice and assert
  // `result1.systemPrompt === result2.systemPrompt` (BYTE-IDENTICAL),
  // mutating DIFFERENT inputs between calls to exercise complementary
  // cache-fence threats.
  //
  //   - Skill-registry reload: a "reload" between turns (live-runtime
  //     port accessor returns different values on call 1 vs call 2).
  //     Defends against a transitive code path that pulls
  //     `getPromptSkillCapabilities()` (or a derived value) into
  //     `assemblerParams` — the dynamic complement to the static
  //     architecture-grep in __tests__/architecture.test.ts.
  //
  //   - Gate hot-flip: a hot-flip of `tooling.capabilityIndex.enabled`
  //     mid-session (the gate accessor returns true on call 1, false on
  //     call 2). Defends against a section builder re-reading the port
  //     after construction — the gate is RESTART-REQUIRED by config
  //     contract (IMMUTABLE_CONFIG_PREFIXES), so the cached systemPrompt
  //     MUST be immune to mid-session toggles. Both directions
  //     (true→false and false→true) are exercised so a lazy-memoization
  //     regression that captures only the first observed value cannot
  //     pass under just one direction.
  //
  // Defense in depth: the architecture-grep catches static violations
  // (an import line in prompt-assembly.ts); these regression tests catch
  // dynamic violations (a transitive code path that pulls live-runtime
  // data into assemblerParams).
  // -----------------------------------------------------------------

  it("skill-registry reload between turns does NOT invalidate the cached system-prompt prefix", async () => {
    // The cache fence: live-runtime port accessors (skill catalog,
    // connected MCP servers) MUST NOT flow into assemblerParams. If the
    // skill registry reloads between turns (operator adds a skill, or
    // skill discovery sweep runs), the next turn's dynamic capability
    // index updates BUT the cached system-prompt prefix MUST stay
    // byte-identical. Anthropic's prompt cache invalidation cost is
    // 25-50% of the input-token cost — a per-turn invalidation cascade
    // doubles the agent's cost.
    //
    // Strategy: simulate two turns through assembleExecutionPrompt(...),
    // mutating the port's live-runtime view of skill capabilities that
    // WOULD invalidate the prefix if the cache fence were broken. Assert
    // the two systemPrompt strings are byte-identical.
    //
    // Implementation note: `prompt-assembly.ts` does NOT consume
    // `getPromptSkillCapabilities()` — that's the whole invariant the
    // architecture-grep statically enforces. The stub call-counter may
    // stay 0 because the cache-fence-correct code path never reaches the
    // live accessor. The byte-identity assertion below is the actual
    // contract.

    let skillCallCount = 0;
    const portStub = createCapabilityPortStub({
      // Gate stable across both calls — this test exercises the cache
      // fence against a SKILL-REGISTRY mutation, not a gate flip.
      isCapabilityIndexEnabled: () => false,
      // Live-runtime accessor returns different values on call 1 vs
      // call 2; if any code path in prompt-assembly.ts (or a transitive
      // helper) reads this, the cached prefix will diverge between calls.
      getPromptSkillCapabilities: () => {
        skillCallCount++;
        return skillCallCount === 1
          ? [
              {
                name: "skill-a",
                description: "First-turn baseline",
                replacesPackages: [],
              },
            ]
          : [
              {
                name: "skill-a",
                description: "First-turn baseline",
                replacesPackages: [],
              },
              {
                name: "skill-b",
                description: "Added between turns",
                replacesPackages: [],
              },
            ];
      },
    });

    // Turn 1
    const result1 = await assembleExecutionPrompt(makeParams({
      deps: {
        workspaceDir: "/workspace",
        toolCapabilityPort: portStub,
      },
    }));

    // Skill registry "reloads" between turns — getPromptSkillCapabilities()
    // will now return different content on the next invocation. Turn 2
    // hits the same params shape; only the port's live view has shifted.
    const result2 = await assembleExecutionPrompt(makeParams({
      deps: {
        workspaceDir: "/workspace",
        toolCapabilityPort: portStub,
      },
    }));

    // CRITICAL: systemPrompt is BYTE-IDENTICAL across turns.
    // The reload MUST affect only the dynamic capability index (renderer
    // consumed in executor-tool-assembly.ts), NEVER the cached prefix.
    // If this assertion fails, the cache fence is broken: someone wired
    // a live-runtime port accessor (or a derived value) into
    // assemblerParams in prompt-assembly.ts.
    expect(result2.systemPrompt).toBe(result1.systemPrompt);

    // Sanity: skillCallCount remaining 0 is the architecturally CORRECT
    // outcome (prompt-assembly.ts is on the cache-fence-clean side of the
    // boundary). If a future regression wires the accessor in, the byte-
    // identity assertion above catches it before this counter does.
    expect(skillCallCount).toBeGreaterThanOrEqual(0);
  });

  it("hot-flipping tooling.capabilityIndex.enabled between assembleExecutionPrompt calls does NOT mutate the cached systemPrompt (true→false direction)", async () => {
    // The cache fence — gate-accessor edition. The
    // tooling.capabilityIndex.enabled flag is RESTART-REQUIRED.
    // Mid-session toggles MUST NOT retroactively rewrite the cached
    // system-prompt prefix.
    //
    // Structural mechanism: the static system prompt no longer branches
    // on `tooling.capabilityIndex.enabled` — the capability-index-on
    // path is the only path; the gate-off branch was deleted. The
    // cache-fence byte-identity invariant therefore holds trivially
    // under hot-flip — neither turn's prompt depends on the
    // (now-irrelevant) port toggle. The dynamic-preamble per-turn
    // capability-index renderer respects the live port value, but the
    // cached static prompt is immune.
    //
    // Strategy: stub the port with a closure-captured mutable boolean.
    // Call assembleExecutionPrompt(...) once with the stub returning
    // true. Mutate the closure variable to flip the gate to false. Call
    // assembleExecutionPrompt(...) again. Assert
    // result1.systemPrompt === result2.systemPrompt (BYTE-IDENTICAL —
    // the cached prefix is immune to the hot-flip).
    //
    // If this assertion fails, the cache fence is broken: a section
    // builder is re-reading the port directly (or a non-cache-fence-safe
    // derived value flowed into assemblerParams), and the operator-
    // restart-required contract is now silently violated.

    let gateValue = true;
    const portStub = createCapabilityPortStub({
      isCapabilityIndexEnabled: () => gateValue,
    });

    // Turn 1 — gate is true.
    const result1 = await assembleExecutionPrompt(makeParams({
      deps: {
        workspaceDir: "/workspace",
        toolCapabilityPort: portStub,
      },
    }));

    // Hot-flip the gate mid-session. Per the restart-required contract,
    // this flip MUST NOT take effect for the in-flight session.
    gateValue = false;

    // Turn 2 — gate accessor would now return false IF the port were re-read.
    const result2 = await assembleExecutionPrompt(makeParams({
      deps: {
        workspaceDir: "/workspace",
        toolCapabilityPort: portStub,
      },
    }));

    // BYTE-IDENTITY: the cached prefix did not flip with the operator-late
    // toggle. The hot-flip contract is satisfied IFF this assertion holds.
    expect(result2.systemPrompt).toBe(result1.systemPrompt);
  });

  it("hot-flipping tooling.capabilityIndex.enabled between assembleExecutionPrompt calls does NOT mutate the cached systemPrompt (false→true direction, symmetric)", async () => {
    // Symmetric inverse of the prior test. Establishes that the
    // byte-identity contract holds in BOTH directions of the hot-flip.
    // A green test in only one direction could mask a bug where the
    // cache fence works for the gate-on-then-off case but not the
    // gate-off-then-on case (e.g. a lazy memoization that captures only
    // the first observed value).
    let gateValue = false;
    const portStub = createCapabilityPortStub({
      isCapabilityIndexEnabled: () => gateValue,
    });

    const result1 = await assembleExecutionPrompt(makeParams({
      deps: {
        workspaceDir: "/workspace",
        toolCapabilityPort: portStub,
      },
    }));
    gateValue = true;
    const result2 = await assembleExecutionPrompt(makeParams({
      deps: {
        workspaceDir: "/workspace",
        toolCapabilityPort: portStub,
      },
    }));

    expect(result2.systemPrompt).toBe(result1.systemPrompt);
  });
});

// ---------------------------------------------------------------------------
// extractUserLanguage (unit tests)
// ---------------------------------------------------------------------------

describe("extractUserLanguage", () => {
  it("extracts language from USER.md with bold markdown", () => {
    expect(extractUserLanguage([
      { path: "USER.md", content: "- **Preferred language:** Hebrew" },
    ])).toBe("Hebrew");
  });

  it("extracts language without bold markdown", () => {
    expect(extractUserLanguage([
      { path: "USER.md", content: "- Preferred language: Arabic" },
    ])).toBe("Arabic");
  });

  it("returns undefined when field has placeholder text", () => {
    expect(extractUserLanguage([
      { path: "USER.md", content: "- **Preferred language:** _(e.g., English, Hebrew)_" },
    ])).toBeUndefined();
  });

  it("returns undefined when USER.md is missing", () => {
    expect(extractUserLanguage([
      { path: "SOUL.md", content: "some content" },
    ])).toBeUndefined();
  });

  it("returns undefined when field is absent", () => {
    expect(extractUserLanguage([
      { path: "USER.md", content: "- **Name:** Mosh\n- **Notes:**" },
    ])).toBeUndefined();
  });

  it("handles case-insensitive file matching", () => {
    expect(extractUserLanguage([
      { path: "user.md", content: "- **Preferred language:** Japanese" },
    ])).toBe("Japanese");
  });
});

// ---------------------------------------------------------------------------
// CacheSafeParams
// ---------------------------------------------------------------------------

describe("CacheSafeParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
    clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    clearSessionPromptSkillsXmlSnapshot(DEFAULT_SESSION_KEY);
    clearCacheSafeParams(DEFAULT_SESSION_KEY);
    mockAssembleRichSystemPrompt.mockReturnValue("assembled-prompt");
    mockLoadWorkspaceBootstrapFiles.mockResolvedValue([]);
    mockBuildBootstrapContextFiles.mockReturnValue([]);
    mockDeduplicateResults.mockImplementation((results: any[]) => results);
    mockHybridSplit.mockReturnValue({ inlineMemory: undefined, systemPromptSections: [] });
    mockCreateHybridMemoryInjector.mockReturnValue({ split: mockHybridSplit });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockIsBootContentEffectivelyEmpty.mockReturnValue(true);
    mockDetectOnboardingState.mockResolvedValue(false);
    mockBuildSubagentRoleSection.mockReturnValue([]);
  });

  it("getCacheSafeParams returns undefined for unknown session key", () => {
    expect(getCacheSafeParams("unknown-session-key")).toBeUndefined();
  });

  it("captures CacheSafeParams after assembleExecutionPrompt completes (first turn)", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "read" }, { name: "exec" }] as any[],
    });
    await assembleExecutionPrompt(params);

    const captured = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(captured).toBeDefined();
    expect(captured!.frozenSystemPrompt).toBe("assembled-prompt");
    expect(captured!.toolNames).toEqual(["read", "exec"]);
    expect(captured!.model).toBe("claude-3-opus");
    expect(captured!.provider).toBe("anthropic");
    expect(captured!.cacheRetention).toBe("short");
  });

  it("does NOT overwrite CacheSafeParams on second call when toolHash unchanged", async () => {
    const params1 = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params1);

    const first = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(first).toBeDefined();
    expect(first!.frozenSystemPrompt).toBe("assembled-prompt");

    // Second call with different system prompt but SAME tools -- toolHash unchanged
    mockAssembleRichSystemPrompt.mockReturnValue("different-prompt");
    const params2 = makeParams({
      config: makeConfig({ model: "claude-4-opus", provider: "google", cacheRetention: "long" }),
      mergedCustomTools: [{ name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params2);

    const second = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(second).toBeDefined();
    // Should still have first-turn values (toolHash unchanged, no refresh)
    expect(second!.frozenSystemPrompt).toBe("assembled-prompt");
    expect(second!.model).toBe("claude-3-opus");
    expect(second!.provider).toBe("anthropic");
    expect(second!.cacheRetention).toBe("short");
  });

  it("clearCacheSafeParams causes getCacheSafeParams to return undefined", async () => {
    const params = makeParams();
    await assembleExecutionPrompt(params);
    expect(getCacheSafeParams(DEFAULT_SESSION_KEY)).toBeDefined();

    clearCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(getCacheSafeParams(DEFAULT_SESSION_KEY)).toBeUndefined();
  });

  it("does NOT capture CacheSafeParams for sub-agent sessions (spawnPacket present)", async () => {
    const params = makeParams({
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: {
          task: "sub-task",
          artifactRefs: [],
          domainKnowledge: [],
          toolGroups: [],
          objective: "test",
          workspaceDir: "/workspace",
          depth: 1,
          maxDepth: 3,
        },
      },
    });
    await assembleExecutionPrompt(params);

    expect(getCacheSafeParams(DEFAULT_SESSION_KEY)).toBeUndefined();
  });

  it("captures CacheSafeParams with undefined cacheRetention when not set", async () => {
    const params = makeParams({
      config: makeConfig({ model: "model-1", provider: "openai" }),
    });
    await assembleExecutionPrompt(params);

    const captured = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(captured).toBeDefined();
    expect(captured!.cacheRetention).toBeUndefined();
  });

  // CacheSafeParams is versioned with toolHash for staleness detection.
  it("includes cacheWriteTimestamp and toolHash in captured CacheSafeParams", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "exec" }, { name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params);

    const captured = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(captured).toBeDefined();
    expect(captured!.cacheWriteTimestamp).toBeTypeOf("number");
    expect(captured!.cacheWriteTimestamp).toBeGreaterThan(0);
    // toolHash is sorted tool names joined with ","
    expect(captured!.toolHash).toBe("exec,read");
  });

  it("refreshes CacheSafeParams when toolHash changes mid-session", async () => {
    // First turn with tools [read]
    const params1 = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params1);

    const first = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(first).toBeDefined();
    expect(first!.toolHash).toBe("read");

    // Second turn with different tools [exec, read] -- MCP server connected mid-session
    mockAssembleRichSystemPrompt.mockReturnValue("refreshed-prompt");
    const params2 = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "exec" }, { name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params2);

    const second = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(second).toBeDefined();
    // Should be refreshed with new toolHash
    expect(second!.toolHash).toBe("exec,read");
    // Frozen prompt should be updated to the new value
    expect(second!.frozenSystemPrompt).toBe("refreshed-prompt");
    // New cacheWriteTimestamp should be set
    expect(second!.cacheWriteTimestamp).toBeTypeOf("number");
  });

  it("does NOT refresh CacheSafeParams when toolHash is unchanged", async () => {
    // First turn
    const params1 = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "read" }, { name: "exec" }] as any[],
    });
    await assembleExecutionPrompt(params1);

    const first = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(first).toBeDefined();
    const firstTimestamp = first!.cacheWriteTimestamp;

    // Second turn with same tools (different order -- hash is sorted so same)
    mockAssembleRichSystemPrompt.mockReturnValue("different-prompt");
    const params2 = makeParams({
      config: makeConfig({ model: "claude-4-opus", provider: "google", cacheRetention: "long" }),
      mergedCustomTools: [{ name: "exec" }, { name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params2);

    const second = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(second).toBeDefined();
    // Should NOT be refreshed (toolHash is the same: "exec,read")
    expect(second!.frozenSystemPrompt).toBe("assembled-prompt");
    expect(second!.model).toBe("claude-3-opus");
    expect(second!.cacheWriteTimestamp).toBe(firstTimestamp);
  });
});

// ---------------------------------------------------------------------------
// SpawnPacket.cacheSafeParams
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Parent prefix reuse early-return path
// ---------------------------------------------------------------------------

describe("parent prefix reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
    clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    clearSessionPromptSkillsXmlSnapshot(DEFAULT_SESSION_KEY);
    clearCacheSafeParams(DEFAULT_SESSION_KEY);
    mockAssembleRichSystemPrompt.mockReturnValue("assembled-prompt");
    mockLoadWorkspaceBootstrapFiles.mockResolvedValue([]);
    mockBuildBootstrapContextFiles.mockReturnValue([]);
    mockDeduplicateResults.mockImplementation((results: any[]) => results);
    mockHybridSplit.mockReturnValue({ inlineMemory: undefined, systemPromptSections: [] });
    mockCreateHybridMemoryInjector.mockReturnValue({ split: mockHybridSplit });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockIsBootContentEffectivelyEmpty.mockReturnValue(true);
    mockDetectOnboardingState.mockResolvedValue(false);
    mockBuildSubagentRoleSection.mockReturnValue(["## Sub-Agent Role", "Task: do-thing"]);
  });

  /** Build a SpawnPacket with cacheSafeParams for testing prefix reuse. */
  function makeSpawnPacketWithCache(overrides?: Partial<CacheSafeParams>): SpawnPacket {
    return {
      task: "sub-task",
      artifactRefs: [],
      domainKnowledge: [],
      toolGroups: [],
      objective: "test-objective",
      workspaceDir: "/workspace",
      depth: 1,
      maxDepth: 3,
      cacheSafeParams: {
        frozenSystemPrompt: "parent-frozen-prompt",
        toolNames: ["read", "exec"],
        model: "claude-3-opus",
        provider: "anthropic",
        cacheRetention: "short",
        ...overrides,
      },
    } as SpawnPacket;
  }

  it("returns parent's frozenSystemPrompt when model+provider match", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    // Full assembly should NOT be called (early return)
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();
  });

  it("falls through to full assembly when model mismatches", async () => {
    const params = makeParams({
      config: makeConfig({ model: "gpt-4o", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache({ model: "claude-3-opus" }),
      },
      resolvedModelId: "gpt-4o",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    // Should use full assembly path
    expect(result.systemPrompt).toBe("assembled-prompt");
    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledOnce();
  });

  it("falls through to full assembly when provider mismatches", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "openai" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache({ provider: "anthropic" }),
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "openai",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("assembled-prompt");
    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledOnce();
  });

  it("falls through to full assembly when cacheSafeParams not present on spawnPacket", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: {
          task: "sub-task",
          artifactRefs: [],
          domainKnowledge: [],
          toolGroups: [],
          objective: "test",
          workspaceDir: "/workspace",
          depth: 1,
          maxDepth: 3,
          // No cacheSafeParams
        } as SpawnPacket,
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("assembled-prompt");
    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledOnce();
  });

  it("independently assembles dynamic preamble on prefix reuse", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
        getPromptSkillsXml: () => "<skills>test-xml</skills>",
        mcpServerInstructions: [{ serverName: "test-mcp", instructions: "Use test tools" }],
      },
      msg: makeMsg({ metadata: { promptSkillContent: "Active skill content" } }),
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
      safetyReinforcement: "SAFETY-REMINDER",
    });
    const result = await assembleExecutionPrompt(params);

    // System prompt is parent's frozen prompt
    expect(result.systemPrompt).toBe("parent-frozen-prompt");

    // Dynamic preamble is independently assembled
    expect(result.dynamicPreamble).toContain("2026-03-12"); // dateTime section from mock
    expect(result.dynamicPreamble).toContain("## Sub-Agent Role"); // subagent role from mock
    expect(result.dynamicPreamble).toContain("<skills>test-xml</skills>"); // prompt skills
    expect(result.dynamicPreamble).toContain("Active skill content"); // active skill
    expect(result.dynamicPreamble).toContain("SAFETY-REMINDER"); // safety reinforcement
    expect(result.dynamicPreamble).toContain("test-mcp"); // MCP instructions
    expect(result.inlineMemory).toBeUndefined();
  });

  it("populates the skill-location attribution index on the parent-cache reuse path", async () => {
    // The reuse path re-emits `## Available Skills\n${promptSkillsXml}` into the
    // dynamic preamble, so a learned-skill <location> is visible to the model —
    // it must ALSO populate sessionPromptSkillLocations, else the bridge's
    // getSessionPromptSkillLocations() returns undefined and skill-use
    // attribution silently no-ops for cache-reuse sub-agents (the dominant path).
    const distinctKey = { agentId: "agent-attr-reuse", channelType: "telegram", channelId: "chat-attr" } as any;
    const formattedKey = formatSessionKey(distinctKey);
    clearSessionToolNameSnapshot(formattedKey);
    clearSessionBootstrapFileSnapshot(formattedKey);
    clearSessionPromptSkillsXmlSnapshot(formattedKey);
    clearCacheSafeParams(formattedKey);

    const skillsXml =
      "<available_skills>\n" +
      "  <skill>\n" +
      "    <name>rotate-key</name>\n" +
      "    <description>Use when rotating a key</description>\n" +
      "    <location>/home/user/.comis/skills/rotate-key/SKILL.md</location>\n" +
      "  </skill>\n" +
      "</available_skills>";

    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
        getPromptSkillsXml: () => skillsXml,
      },
      sessionKey: distinctKey,
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });

    const result = await assembleExecutionPrompt(params);

    // Early-return reuse path (no full assembly).
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();
    expect(result.dynamicPreamble).toContain("/home/user/.comis/skills/rotate-key/SKILL.md");

    // The keystone assertion: the bridge can now attribute a read of that location.
    const index = getSessionPromptSkillLocations(formattedKey);
    expect(index).toBeDefined();
    expect(index?.get("/home/user/.comis/skills/rotate-key/SKILL.md")).toBe("rotate-key");

    clearSessionToolNameSnapshot(formattedKey);
    clearSessionBootstrapFileSnapshot(formattedKey);
    clearSessionPromptSkillsXmlSnapshot(formattedKey);
    clearCacheSafeParams(formattedKey);
  });

  it("does NOT populate sessionToolNameSnapshots on reuse path", async () => {
    // Use a distinct session key for this test to avoid cross-test pollution
    const distinctKey = { agentId: "agent-sub-unique", channelType: "telegram", channelId: "chat-sub" } as any;
    const distinctFormattedKey = formatSessionKey(distinctKey);

    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
      },
      sessionKey: distinctKey,
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
      mergedCustomTools: [{ name: "tool-a" }, { name: "tool-b" }] as any[],
    });
    await assembleExecutionPrompt(params);

    // assembleRichSystemPrompt should NOT be called (early return)
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();

    // Clean up
    clearSessionToolNameSnapshot(distinctFormattedKey);
    clearSessionBootstrapFileSnapshot(distinctFormattedKey);
    clearSessionPromptSkillsXmlSnapshot(distinctFormattedKey);
    clearCacheSafeParams(distinctFormattedKey);
  });

  it("uses resolvedModelId/resolvedModelProvider for match, not config.model/config.provider", async () => {
    // config.model differs from resolvedModelId but resolvedModelId matches parent
    const params = makeParams({
      config: makeConfig({ model: "claude-config-model", provider: "config-provider" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache({ model: "claude-3-opus", provider: "anthropic" }),
      },
      resolvedModelId: "claude-3-opus",       // matches parent
      resolvedModelProvider: "anthropic",      // matches parent
    });
    const result = await assembleExecutionPrompt(params);

    // Early return should trigger because resolved matches, even though config differs
    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();
  });

  it("falls back to config.model/config.provider when resolvedModelId/resolvedModelProvider absent", async () => {
    // No resolvedModelId/Provider; config.model matches parent
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache({ model: "claude-3-opus", provider: "anthropic" }),
      },
      // resolvedModelId: undefined -- falls back to config.model
      // resolvedModelProvider: undefined -- falls back to config.provider
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();
  });

  it("runs hook beforeAgentStart on prefix reuse path for dynamic content", async () => {
    const hookRunner = {
      runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "HOOK-DYNAMIC" }),
    };
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
        hookRunner: hookRunner as any,
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledOnce();
    expect(result.dynamicPreamble).toContain("HOOK-DYNAMIC");
    expect(result.systemPrompt).toBe("parent-frozen-prompt");
  });

  // The sub-agent `### Language` directive must reach the role
  // section on the parent-cache reuse path — the DOMINANT runtime path for
  // same-model sub-agents. If only the full-assembly call site
  // threaded `language`, the reuse-path call would drop
  // it and a Hebrew/Arabic/Russian sub-agent would produce English output on its
  // primary path. The leaf-level context-sections.test.ts masks this because it
  // exercises buildSubagentRoleSection directly. This probe goes through the
  // real assembleExecutionPrompt reuse path and asserts the language reaches the
  // role-section builder.
  it("threads spawnPacket.language into the role section on the parent-cache reuse path", async () => {
    const spawnPacket = makeSpawnPacketWithCache();
    spawnPacket.language = "he";
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket,
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    // Reuse path was taken (no full assembly).
    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();

    // The role-section builder must have received the inherited language so it
    // can emit the `### Language` directive (a reuse-path call site that
    // omits `language` fails here).
    expect(mockBuildSubagentRoleSection).toHaveBeenCalledWith(
      expect.objectContaining({ language: "he" }),
    );
  });

  // The en/undefined language path on the reuse branch stays byte-identical
  // — no `language` key is fabricated, so the packet shape is unchanged.
  it("passes language=undefined on the reuse path for an en (unset) spawnPacket", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(), // no language set
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    await assembleExecutionPrompt(params);

    expect(mockBuildSubagentRoleSection).toHaveBeenCalledWith(
      expect.objectContaining({ language: undefined }),
    );
  });

  // Source-grep chokepoint (mirrors the degraded-reply source-grep at
  // executor-post-execution.test.ts): BOTH role-section feeds in
  // prompt-assembly.ts must thread `language: deps.spawnPacket.language`, so the
  // two consumers (the cache-reuse inline call and the full-assembly
  // subagentRole object) can never drift apart again. There are exactly two such
  // feeds; both must carry the language.
  it("source-grep — BOTH sub-agent role-section feeds thread language: deps.spawnPacket.language", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolvePath(here, "prompt-assembly.ts"), "utf-8");
    // Strip block + line comments so a comment mention cannot satisfy the gate.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    // Two role-section feeds (reuse-path inline object + full-assembly
    // subagentRole object) each thread the inherited language.
    const matches = stripped.match(/language:\s*deps\.spawnPacket\.language/g) ?? [];
    expect(matches.length).toBe(2);
  });

  // Reply-language tier-2: USER.md's "Preferred language" must reach the
  // degraded-reply resolver on the cache-reuse path too. If the reuse
  // path hardcoded `userLanguage: undefined`, tier-2 would be silently dropped — a user
  // whose USER.md sets a preferred language but who sends a Latin-script message
  // on a reuse turn would get an English degraded reply. The reuse path
  // computes userLanguage from the same snapshot-aware bootstrap load + filter
  // dispatch as the full path.
  it("resolves USER.md preferred language (tier-2) on the parent-cache reuse path", async () => {
    mockLoadWorkspaceBootstrapFiles.mockResolvedValue([
      { name: "USER.md", content: "- **Preferred language:** Arabic" },
    ]);
    mockBuildBootstrapContextFiles.mockReturnValue([
      { path: "USER.md", content: "- **Preferred language:** Arabic" },
    ]);
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    // Reuse path was taken.
    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();
    // Tier-2 is carried on the reuse path (a hardcoded-undefined reuse path fails here).
    expect(result.userLanguage).toBe("Arabic");
  });

  // Privacy: group-chat filtering strips USER.md, so tier-2 must be
  // absent on a reuse turn in a group context (the resolver falls through to
  // tier-3 inbound script) — matching the full path's group-chat behavior.
  it("omits tier-2 on the reuse path in a group chat (USER.md stripped)", async () => {
    mockLoadWorkspaceBootstrapFiles.mockResolvedValue([
      { name: "USER.md", content: "- **Preferred language:** Arabic" },
    ]);
    // The group-chat filter (mocked in beforeEach) strips USER.md; the build
    // step then sees no USER.md, so extractUserLanguage returns undefined.
    mockBuildBootstrapContextFiles.mockReturnValue([]);
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
      },
      // Group context (Telegram group) → USER.md stripped for privacy.
      msg: makeMsg({ metadata: { chatType: "group" }, isGroup: true }),
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    expect(result.userLanguage).toBeUndefined();
  });
});

describe("SpawnPacket.cacheSafeParams post-build assignment", () => {
  it("SpawnPacket from createSpawnPacketBuilder().build() accepts post-build cacheSafeParams assignment", () => {
    const builder = createSpawnPacketBuilder({
      workspaceDir: "/workspace",
      currentDepth: 0,
      maxSpawnDepth: 3,
    });
    const packet: SpawnPacket = builder.build({
      task: "test-task",
      objective: "test-objective",
    });

    // Verify cacheSafeParams is initially undefined (builder does not set it)
    expect(packet.cacheSafeParams).toBeUndefined();

    // Assign cacheSafeParams post-build (this is the pattern setup-cross-session uses)
    const cacheSafeParams: CacheSafeParams = {
      frozenSystemPrompt: "frozen-system-prompt",
      toolNames: ["read", "write"],
      model: "claude-3-opus",
      provider: "anthropic",
      cacheRetention: "short",
    };
    packet.cacheSafeParams = cacheSafeParams;

    // Verify the field is readable and has correct shape
    expect(packet.cacheSafeParams).toBeDefined();
    expect(packet.cacheSafeParams!.frozenSystemPrompt).toBe("frozen-system-prompt");
    expect(packet.cacheSafeParams!.toolNames).toEqual(["read", "write"]);
    expect(packet.cacheSafeParams!.model).toBe("claude-3-opus");
    expect(packet.cacheSafeParams!.provider).toBe("anthropic");
    expect(packet.cacheSafeParams!.cacheRetention).toBe("short");
  });
});

// ---------------------------------------------------------------------------
// SystemPromptBlocks threading through pipeline
// ---------------------------------------------------------------------------

describe("SystemPromptBlocks threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
    clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    clearSessionPromptSkillsXmlSnapshot(DEFAULT_SESSION_KEY);
    clearCacheSafeParams(DEFAULT_SESSION_KEY);
    mockAssembleRichSystemPrompt.mockReturnValue("assembled-prompt");
    mockAssembleRichSystemPromptBlocks.mockReturnValue({ staticPrefix: "static-prefix", attribution: "attribution", semiStableBody: "semi-stable-body" });
    mockLoadWorkspaceBootstrapFiles.mockResolvedValue([]);
    mockBuildBootstrapContextFiles.mockReturnValue([]);
    mockDeduplicateResults.mockImplementation((results: any[]) => results);
    mockHybridSplit.mockReturnValue({ inlineMemory: undefined, systemPromptSections: [] });
    mockCreateHybridMemoryInjector.mockReturnValue({ split: mockHybridSplit });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockIsBootContentEffectivelyEmpty.mockReturnValue(true);
    mockDetectOnboardingState.mockResolvedValue(false);
    mockBuildSubagentRoleSection.mockReturnValue([]);
  });

  it("assembleExecutionPrompt returns systemPromptBlocks in ExecutionPromptResult for full mode", async () => {
    const params = makeParams({
      config: makeConfig({ bootstrap: { promptMode: "full" } }),
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPromptBlocks).toBeDefined();
    expect(result.systemPromptBlocks!.staticPrefix).toBe("static-prefix");
    expect(result.systemPromptBlocks!.attribution).toBe("attribution");
    expect(result.systemPromptBlocks!.semiStableBody).toBe("semi-stable-body");
  });

  it("CacheSafeParams.frozenSystemPromptBlocks is populated in session snapshot after first turn", async () => {
    mockAssembleRichSystemPromptBlocks.mockReturnValue({ staticPrefix: "cached-prefix", attribution: "cached-attribution", semiStableBody: "cached-body" });
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
    });
    await assembleExecutionPrompt(params);

    const captured = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(captured).toBeDefined();
    expect(captured!.frozenSystemPromptBlocks).toBeDefined();
    expect(captured!.frozenSystemPromptBlocks!.staticPrefix).toBe("cached-prefix");
    expect(captured!.frozenSystemPromptBlocks!.attribution).toBe("cached-attribution");
    expect(captured!.frozenSystemPromptBlocks!.semiStableBody).toBe("cached-body");
  });

  it("sub-agent prefix reuse returns systemPromptBlocks from parent cacheSafeParams when model/provider match", async () => {
    const parentBlocks = { staticPrefix: "parent-prefix", attribution: "parent-attribution", semiStableBody: "parent-body" };
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: {
          task: "sub-task",
          artifactRefs: [],
          domainKnowledge: [],
          toolGroups: [],
          objective: "test-objective",
          workspaceDir: "/workspace",
          depth: 1,
          maxDepth: 3,
          cacheSafeParams: {
            frozenSystemPrompt: "parent-frozen-prompt",
            frozenSystemPromptBlocks: parentBlocks,
            toolNames: ["read", "exec"],
            model: "claude-3-opus",
            provider: "anthropic",
            cacheRetention: "short",
          },
        } as SpawnPacket,
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    expect(result.systemPromptBlocks).toBeDefined();
    expect(result.systemPromptBlocks!.staticPrefix).toBe("parent-prefix");
    expect(result.systemPromptBlocks!.attribution).toBe("parent-attribution");
    expect(result.systemPromptBlocks!.semiStableBody).toBe("parent-body");
    // Should NOT call the full assembly path
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();
    expect(mockAssembleRichSystemPromptBlocks).not.toHaveBeenCalled();
  });
});

describe("computeFeatureFlagHash", () => {
  // Import directly -- this is a pure function, no mocks needed
  let computeFeatureFlagHash: (config: { toolPolicy?: { mode?: string }; tools?: { enabledGroups?: string[] } }) => string;

  beforeEach(async () => {
    // Dynamic import to get the actual function (not mocked)
    const mod = await vi.importActual<typeof import("./prompt-assembly.js")>("./prompt-assembly.js");
    computeFeatureFlagHash = mod.computeFeatureFlagHash;
  });

  it("returns different hash when toolPolicy.mode changes (feature-flag)", () => {
    const hash1 = computeFeatureFlagHash({ toolPolicy: { mode: "auto" } });
    const hash2 = computeFeatureFlagHash({ toolPolicy: { mode: "filtered" } });
    expect(hash1).not.toBe(hash2);
  });

  it("returns same hash when unrelated config differs (feature-flag)", () => {
    const hash1 = computeFeatureFlagHash({ toolPolicy: { mode: "auto" } });
    const hash2 = computeFeatureFlagHash({ toolPolicy: { mode: "auto" } });
    expect(hash1).toBe(hash2);
  });

  it("includes enabledGroups in hash computation (feature-flag)", () => {
    const hash1 = computeFeatureFlagHash({ tools: { enabledGroups: ["web", "code"] } });
    const hash2 = computeFeatureFlagHash({ tools: { enabledGroups: ["web"] } });
    expect(hash1).not.toBe(hash2);
  });

  it("returns 'default' when no feature flags set (feature-flag)", () => {
    const hash = computeFeatureFlagHash({});
    expect(hash).toBe("default");
  });
});

describe("buildRecallTrace -- data-dir agreement with the reader", () => {
  it("resolves the recorder base from the configured dataDir so writer and reader agree", () => {
    // If the recorder hardcoded os.homedir()/.comis as its base while the
    // memory.recall_trace handler reads from the configured dataDir
    // (deps.dataDir ?? ~/.comis), a non-default COMIS_DATA_DIR would point the
    // writer and reader at DIFFERENT files, so the diagnostic returns nothing.
    // The recorder must resolve its confinedBaseDir from the SAME data-dir
    // source the reader uses.
    const customDataDir = `${nodeOs.tmpdir()}/comis-wr02-${Math.random().toString(36).slice(2)}`;
    const recorder = buildRecallTrace(
      { enabled: true },
      "agent-x",
      "tenant:user:chan",
      customDataDir,
    );
    expect(recorder).not.toBeNull();
    // The reader resolves the same path from the same dataDir.
    const readerPath = resolveRecallTraceFilePath({ confinedBaseDir: customDataDir });
    expect(recorder!.filePath).toBe(readerPath);
    // And the resolved path is rooted under the custom dataDir (NOT ~/.comis).
    expect(recorder!.filePath.startsWith(customDataDir)).toBe(true);
  });

  it("falls back to the home .comis base when no dataDir is supplied (default deployments unaffected)", () => {
    const recorder = buildRecallTrace({ enabled: true }, "agent-x", "tenant:user:chan");
    expect(recorder).not.toBeNull();
    const defaultBase = `${nodeOs.homedir()}/.comis`;
    const readerPath = resolveRecallTraceFilePath({ confinedBaseDir: defaultBase });
    expect(recorder!.filePath).toBe(readerPath);
  });
});

// ---------------------------------------------------------------------------
// Pinned-budget accounting: pinnedChars deducted from maxContextChars before
// injector.split.
//
// When rag.pinned.enabled=true, prompt-assembly computes the char length of the
// pinned section (using formatMemorySection) and passes maxContextChars-pinnedChars
// to injector.split — so fused recall never consumes budget already used by pins.
// DEFAULT-OFF: when pinned is disabled, injector.split receives the full budget.
// ---------------------------------------------------------------------------

describe("assembleExecutionPrompt — pinnedChars deducted from maxContextChars", () => {
  const PINNED_SECTION_CONTENT = "x".repeat(500); // 500-char pinned section
  const MAX_CONTEXT_CHARS = 4000;

  beforeEach(() => {
    // Reset to default (no pinned section) before each test
    mockFormatMemorySection.mockReturnValue(undefined);
    mockRecall.mockResolvedValue({ ok: false, error: new Error("no recall") });
    // Clear the call history on these mocks so each test starts fresh
    mockHybridSplit.mockClear();
    mockCreateMemoryRecall.mockClear();
  });

  it("pinnedChars are deducted from maxContextChars before passing to injector split", async () => {
    // Budget accounting: formatMemorySection returns a 500-char pinned section.
    // injector.split must be called with MAX_CONTEXT_CHARS - 500 = 3500.
    // Without pinned-budget accounting injector.split would get the full 4000.
    // entry.pinned=true is required so the pinned-set filter identifies this as a real pin.
    const pinnedEntry = {
      entry: { id: "pinned-001", tenantId: "t", content: "pinned content", createdAt: Date.now(), tags: [], trustLevel: "system" as const, source: { channel: "test" }, pinned: true as const },
      score: 1.0,
    };
    const fusedEntry = {
      entry: { id: "fused-001", tenantId: "t", content: "fused content", createdAt: Date.now(), tags: [], trustLevel: "learned" as const, source: { channel: "test" } },
      score: 0.8,
    };
    // Recall returns: pinnedEntry first (as head), then fusedEntry
    // (simulating the Step-0 pinned lane having prepended the pinned entry)
    mockRecall.mockResolvedValue({ ok: true, value: [pinnedEntry, fusedEntry] });
    // formatMemorySection returns a 500-char string when called with the pinned set
    mockFormatMemorySection.mockReturnValue(PINNED_SECTION_CONTENT);

    const memoryPort = { search: vi.fn().mockResolvedValue({ ok: true, value: [] }), store: vi.fn() } as any;
    const params = makeParams({
      config: makeConfig({
        rag: {
          enabled: true,
          maxResults: 5,
          minScore: 0.3,
          includeTrustLevels: ["learned", "system"],
          maxContextChars: MAX_CONTEXT_CHARS,
          pinned: { enabled: true, maxPinnedInjection: 1 },
        },
      }),
      deps: { workspaceDir: "/workspace", memoryPort },
    });
    await assembleExecutionPrompt(params);

    expect(mockHybridSplit).toHaveBeenCalledOnce();
    const splitMaxChars = mockHybridSplit.mock.calls[0][1] as number;
    // After pinnedChars(500) deducted: 4000 - 500 = 3500
    expect(splitMaxChars).toBe(MAX_CONTEXT_CHARS - PINNED_SECTION_CONTENT.length);
    expect(splitMaxChars).toBeLessThan(MAX_CONTEXT_CHARS);
  });

  it("pinnedChars deduction is DEFAULT-OFF: pinned disabled passes full maxContextChars to split", async () => {
    // Safety gate: when pinning is off, injector.split gets the full budget unchanged.
    const fusedEntry = {
      entry: { id: "fused-only", tenantId: "t", content: "fused content", createdAt: Date.now(), tags: [], trustLevel: "learned", source: { channel: "test" } },
      score: 0.8,
    };
    mockRecall.mockResolvedValue({ ok: true, value: [fusedEntry] });
    // formatMemorySection is NOT called (no pinned section); returns undefined (default mock)

    const memoryPort = { search: vi.fn().mockResolvedValue({ ok: true, value: [] }), store: vi.fn() } as any;
    const params = makeParams({
      config: makeConfig({
        rag: {
          enabled: true,
          maxResults: 5,
          minScore: 0.3,
          includeTrustLevels: ["learned"],
          maxContextChars: MAX_CONTEXT_CHARS,
          // pinned NOT enabled (default-off)
        },
      }),
      deps: { workspaceDir: "/workspace", memoryPort },
    });
    await assembleExecutionPrompt(params);

    expect(mockHybridSplit).toHaveBeenCalledOnce();
    const splitMaxChars = mockHybridSplit.mock.calls[0][1] as number;
    expect(splitMaxChars).toBe(MAX_CONTEXT_CHARS);
  });
});

// Prompt-assembly budget split uses entry.pinned, not a positional slice.
// When 2 pins exist with cap=5, injector.split must receive the FUSED entries
// (not the 5-item positional slice that includes fused entries as fake "pins").
describe("assembleExecutionPrompt — pinnedSet identified by entry.pinned, not positional slice", () => {
  const MAX_CONTEXT_CHARS = 4000;
  const PINNED_SECTION_CHARS = 200;

  beforeEach(() => {
    mockFormatMemorySection.mockReturnValue(undefined);
    mockRecall.mockResolvedValue({ ok: false, error: new Error("no recall") });
    mockHybridSplit.mockClear();
    mockCreateMemoryRecall.mockClear();
  });

  it("injector.split receives only fused entries (not pinned ones) when 2 pins < cap=5", async () => {
    // 2 pinned + 3 fused entries in recall. maxPinnedInjection=5 (cap > actual pins).
    // A positional slice(0, 5) would grab all 5 entries as "pinnedSet" →
    //   injector.split receives [] (empty) → the 3 fused entries are DROPPED.
    // The entry.pinned===true filter identifies exactly 2 pins →
    //   injector.split receives the 3 fused entries (none dropped).
    const pinnedEntry1 = {
      entry: { id: "pin-1", tenantId: "t", content: "pin one", createdAt: Date.now(), tags: [], trustLevel: "system" as const, source: { channel: "test" }, pinned: true as const },
      score: 1.0,
    };
    const pinnedEntry2 = {
      entry: { id: "pin-2", tenantId: "t", content: "pin two", createdAt: Date.now(), tags: [], trustLevel: "system" as const, source: { channel: "test" }, pinned: true as const },
      score: 1.0,
    };
    const fusedEntry1 = {
      entry: { id: "fused-1", tenantId: "t", content: "fused one", createdAt: Date.now(), tags: [], trustLevel: "learned" as const, source: { channel: "test" } },
      score: 0.9,
    };
    const fusedEntry2 = {
      entry: { id: "fused-2", tenantId: "t", content: "fused two", createdAt: Date.now(), tags: [], trustLevel: "learned" as const, source: { channel: "test" } },
      score: 0.8,
    };
    const fusedEntry3 = {
      entry: { id: "fused-3", tenantId: "t", content: "fused three", createdAt: Date.now(), tags: [], trustLevel: "learned" as const, source: { channel: "test" } },
      score: 0.7,
    };
    // Recall returns 2 pinned (pinned===true) + 3 fused (no pinned field).
    mockRecall.mockResolvedValue({ ok: true, value: [pinnedEntry1, pinnedEntry2, fusedEntry1, fusedEntry2, fusedEntry3] });
    // formatMemorySection returns a 200-char string for the pinned section.
    mockFormatMemorySection.mockReturnValue("x".repeat(PINNED_SECTION_CHARS));

    const memoryPort = { search: vi.fn().mockResolvedValue({ ok: true, value: [] }), store: vi.fn() } as any;
    const params = makeParams({
      config: makeConfig({
        rag: {
          enabled: true,
          maxResults: 5,
          minScore: 0.3,
          includeTrustLevels: ["learned", "system"],
          maxContextChars: MAX_CONTEXT_CHARS,
          pinned: { enabled: true, maxPinnedInjection: 5 }, // cap=5, but only 2 real pins
        },
      }),
      deps: { workspaceDir: "/workspace", memoryPort },
    });
    await assembleExecutionPrompt(params);

    expect(mockHybridSplit).toHaveBeenCalledOnce();
    const splitArg = mockHybridSplit.mock.calls[0][0] as Array<{ entry: { id: string } }>;
    const splitIds = splitArg.map((r) => r.entry.id);
    // All 3 fused entries must be passed to injector.split (none dropped).
    expect(splitIds).toContain("fused-1");
    expect(splitIds).toContain("fused-2");
    expect(splitIds).toContain("fused-3");
    // Pinned entries must NOT be passed to injector.split.
    expect(splitIds).not.toContain("pin-1");
    expect(splitIds).not.toContain("pin-2");
    // Budget: 2 pins measured (200 chars) → split gets 4000 - 200 = 3800.
    const splitMaxChars = mockHybridSplit.mock.calls[0][1] as number;
    expect(splitMaxChars).toBe(MAX_CONTEXT_CHARS - PINNED_SECTION_CHARS);
  });

  // -----------------------------------------------------------------
  // Small/nano recall injection count/chars caps
  // -----------------------------------------------------------------
  describe("small/nano profile count/chars caps", () => {
    const SMALL_PROFILE = {
      capabilityClass: "small",
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
      securityLevel: "locked",
      scaffoldLevel: "max",
      supportsVision: false,
      supportsTools: true,
      supportsPromptCache: false,
      supportsServerToolSearch: false,
      supportsStructuredOutput: false,
      reasoningStyle: "none",
    } as any;

    const NANO_PROFILE = {
      capabilityClass: "nano",
      contextWindow: 16_000,
      maxOutputTokens: 2_048,
      securityLevel: "locked",
      scaffoldLevel: "max",
      supportsVision: false,
      supportsTools: true,
      supportsPromptCache: false,
      supportsServerToolSearch: false,
      supportsStructuredOutput: false,
      reasoningStyle: "none",
    } as any;

    const FRONTIER_PROFILE = {
      capabilityClass: "frontier",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      securityLevel: "standard",
      scaffoldLevel: "light",
      supportsVision: true,
      supportsTools: true,
      supportsPromptCache: true,
      supportsServerToolSearch: true,
      supportsStructuredOutput: true,
      reasoningStyle: "none",
    } as any;

    function makeRankedMemory(id: string, contentLength: number) {
      return {
        entry: {
          id,
          tenantId: "default",
          agentId: "default",
          userId: "user_a",
          content: "x".repeat(contentLength),
          trustLevel: "learned",
          source: { who: "agent" },
          tags: [],
          createdAt: Date.now(),
          pinned: false,
        },
        score: 0.8,
      } as any;
    }

    // A stub memoryPort that satisfies `deps.memoryPort && config.rag?.enabled` gate.
    const stubMemoryPort = { search: vi.fn().mockResolvedValue({ ok: true, value: [] }) } as any;
    // A full rag config (all required fields) used across caps tests.
    const ragConfig = { enabled: true, maxResults: 10, minScore: 0.1, includeTrustLevels: ["system", "learned"], maxContextChars: 8000 };

    it("small profile: count cap of 3 — only 3 items pass to injector.split when 5 recalled", async () => {
      const fiveMemories = [1, 2, 3, 4, 5].map((i) => makeRankedMemory(`mem-${i}`, 100));
      mockRecall.mockResolvedValue({ ok: true, value: fiveMemories });

      const params = makeParams({
        config: makeConfig({ rag: ragConfig }),
        deps: { workspaceDir: "/workspace", memoryPort: stubMemoryPort },
        modelProfile: SMALL_PROFILE,
      });
      const sessionKey = formatSessionKey(params.sessionKey as any);
      clearSessionToolNameSnapshot(sessionKey);
      clearSessionBootstrapFileSnapshot(sessionKey);
      clearSessionPromptSkillsXmlSnapshot(sessionKey);
      clearCacheSafeParams(sessionKey);

      await assembleExecutionPrompt(params);

      expect(mockHybridSplit).toHaveBeenCalledOnce();
      const splitArg = mockHybridSplit.mock.calls[0][0] as Array<{ entry: { id: string } }>;
      // Small profile caps at 3 items — only the first 3 should be passed to split
      expect(splitArg).toHaveLength(3);
      expect(splitArg.map((r) => r.entry.id)).toEqual(["mem-1", "mem-2", "mem-3"]);
    });

    it("nano profile: count cap of 3 — only 3 items pass to injector.split when 5 recalled", async () => {
      const fiveMemories = [1, 2, 3, 4, 5].map((i) => makeRankedMemory(`mem-${i}`, 100));
      mockRecall.mockResolvedValue({ ok: true, value: fiveMemories });

      const params = makeParams({
        config: makeConfig({ rag: ragConfig }),
        deps: { workspaceDir: "/workspace", memoryPort: stubMemoryPort },
        modelProfile: NANO_PROFILE,
      });
      const sessionKey = formatSessionKey(params.sessionKey as any);
      clearSessionToolNameSnapshot(sessionKey);
      clearSessionBootstrapFileSnapshot(sessionKey);
      clearSessionPromptSkillsXmlSnapshot(sessionKey);
      clearCacheSafeParams(sessionKey);

      await assembleExecutionPrompt(params);

      expect(mockHybridSplit).toHaveBeenCalledOnce();
      const splitArg = mockHybridSplit.mock.calls[0][0] as Array<{ entry: { id: string } }>;
      // Nano profile caps at 3 items
      expect(splitArg).toHaveLength(3);
    });

    it("frontier profile: no count cap — all 5 items pass to injector.split", async () => {
      const fiveMemories = [1, 2, 3, 4, 5].map((i) => makeRankedMemory(`mem-${i}`, 100));
      mockRecall.mockResolvedValue({ ok: true, value: fiveMemories });

      const params = makeParams({
        config: makeConfig({ rag: ragConfig }),
        deps: { workspaceDir: "/workspace", memoryPort: stubMemoryPort },
        modelProfile: FRONTIER_PROFILE,
      });
      const sessionKey = formatSessionKey(params.sessionKey as any);
      clearSessionToolNameSnapshot(sessionKey);
      clearSessionBootstrapFileSnapshot(sessionKey);
      clearSessionPromptSkillsXmlSnapshot(sessionKey);
      clearCacheSafeParams(sessionKey);

      await assembleExecutionPrompt(params);

      expect(mockHybridSplit).toHaveBeenCalledOnce();
      const splitArg = mockHybridSplit.mock.calls[0][0] as Array<{ entry: { id: string } }>;
      // Frontier: no cap → all 5 pass
      expect(splitArg).toHaveLength(5);
    });

    it("no modelProfile: no count cap — all 5 items pass to injector.split", async () => {
      const fiveMemories = [1, 2, 3, 4, 5].map((i) => makeRankedMemory(`mem-${i}`, 100));
      mockRecall.mockResolvedValue({ ok: true, value: fiveMemories });

      const params = makeParams({
        config: makeConfig({ rag: ragConfig }),
        deps: { workspaceDir: "/workspace", memoryPort: stubMemoryPort },
        // modelProfile omitted
      });
      const sessionKey = formatSessionKey(params.sessionKey as any);
      clearSessionToolNameSnapshot(sessionKey);
      clearSessionBootstrapFileSnapshot(sessionKey);
      clearSessionPromptSkillsXmlSnapshot(sessionKey);
      clearCacheSafeParams(sessionKey);

      await assembleExecutionPrompt(params);

      expect(mockHybridSplit).toHaveBeenCalledOnce();
      const splitArg = mockHybridSplit.mock.calls[0][0] as Array<{ entry: { id: string } }>;
      // No profile: no cap → all 5 pass
      expect(splitArg).toHaveLength(5);
    });

    it("small profile chars cap of 2000: maxContextChars passed to split is capped at 2000", async () => {
      const twoMemories = [1, 2].map((i) => makeRankedMemory(`mem-${i}`, 100));
      mockRecall.mockResolvedValue({ ok: true, value: twoMemories });

      const params = makeParams({
        // maxContextChars=8000 but small profile chars cap=2000 overrides it
        config: makeConfig({ rag: ragConfig }),
        deps: { workspaceDir: "/workspace", memoryPort: stubMemoryPort },
        modelProfile: SMALL_PROFILE,
      });
      const sessionKey = formatSessionKey(params.sessionKey as any);
      clearSessionToolNameSnapshot(sessionKey);
      clearSessionBootstrapFileSnapshot(sessionKey);
      clearSessionPromptSkillsXmlSnapshot(sessionKey);
      clearCacheSafeParams(sessionKey);

      await assembleExecutionPrompt(params);

      expect(mockHybridSplit).toHaveBeenCalledOnce();
      const splitMaxChars = mockHybridSplit.mock.calls[0][1] as number;
      // Small profile caps chars at 2000 (takes min with remainingChars)
      expect(splitMaxChars).toBeLessThanOrEqual(2000);
    });

    it("nano profile chars cap of 1000: maxContextChars passed to split is capped at 1000", async () => {
      const twoMemories = [1, 2].map((i) => makeRankedMemory(`mem-${i}`, 100));
      mockRecall.mockResolvedValue({ ok: true, value: twoMemories });

      const params = makeParams({
        // maxContextChars=8000 but nano profile chars cap=1000 overrides it
        config: makeConfig({ rag: ragConfig }),
        deps: { workspaceDir: "/workspace", memoryPort: stubMemoryPort },
        modelProfile: NANO_PROFILE,
      });
      const sessionKey = formatSessionKey(params.sessionKey as any);
      clearSessionToolNameSnapshot(sessionKey);
      clearSessionBootstrapFileSnapshot(sessionKey);
      clearSessionPromptSkillsXmlSnapshot(sessionKey);
      clearCacheSafeParams(sessionKey);

      await assembleExecutionPrompt(params);

      expect(mockHybridSplit).toHaveBeenCalledOnce();
      const splitMaxChars = mockHybridSplit.mock.calls[0][1] as number;
      // Nano profile caps chars at 1000
      expect(splitMaxChars).toBeLessThanOrEqual(1000);
    });
  });
});

// ---------------------------------------------------------------------------
// parseSkillLocationIndex — parse the frozen <available_skills> XML
// (the exact processor.ts formatAvailableSkillsXml shape) into a
// location→skillName Map, unescaping XML entities so the key matches the raw
// read path.
// ---------------------------------------------------------------------------
describe("parseSkillLocationIndex (frozen-XML location→skillName index)", () => {
  it("parses a two-<skill> block into the exact location→name map", () => {
    const xml =
      "<available_skills>\n" +
      "  <skill>\n" +
      "    <name>deploy</name>\n" +
      "    <description>Deploy the app</description>\n" +
      "    <location>/home/user/.comis/skills/deploy/SKILL.md</location>\n" +
      "  </skill>\n" +
      "  <skill>\n" +
      "    <name>backup</name>\n" +
      "    <description>Back up data</description>\n" +
      "    <location>/home/user/.comis/skills/backup/SKILL.md</location>\n" +
      "  </skill>\n" +
      "</available_skills>";

    const index = parseSkillLocationIndex(xml);
    expect(index.get("/home/user/.comis/skills/deploy/SKILL.md")).toBe("deploy");
    expect(index.get("/home/user/.comis/skills/backup/SKILL.md")).toBe("backup");
    expect(index.size).toBe(2);
  });

  it("unescapes XML entities in BOTH the location and the name (inverse of escapeXml)", () => {
    // escapeXml turns & < > " ' into entities; a real path/name with those chars
    // is stored escaped in the frozen XML and must round-trip back to raw.
    const xml =
      "<available_skills>\n" +
      "  <skill>\n" +
      "    <name>a&amp;b &lt;tag&gt;</name>\n" +
      "    <description>d</description>\n" +
      "    <location>/tmp/a &amp; b/&quot;x&apos;.md</location>\n" +
      "  </skill>\n" +
      "</available_skills>";

    const index = parseSkillLocationIndex(xml);
    // raw location key (unescaped) → raw name (unescaped)
    expect(index.get("/tmp/a & b/\"x'.md")).toBe("a&b <tag>");
  });

  it("returns an empty map for undefined / empty / no-skill input", () => {
    expect(parseSkillLocationIndex(undefined).size).toBe(0);
    expect(parseSkillLocationIndex("").size).toBe(0);
    expect(parseSkillLocationIndex("<available_skills>\n</available_skills>").size).toBe(0);
  });

  it("an ABSOLUTE learned-skill <location> (mixed with a platform skill) is indexed → name, so a `read` of that path attributes", () => {
    // The learned surface (mergeLearnedSkillsXml) emits an ABSOLUTE materialized
    // SKILL.md path for the learned <location> — the SAME absolute shape platform
    // skills use (metadata.path) and the read tool reports. A `read` whose path
    // equals that absolute location must attribute the learned skill. A
    // workspace-RELATIVE learned location (.learned-skills/deploy/SKILL.md)
    // (a) does NOT match an absolute read path and (b) is an inconsistent
    // mixed-format block the model may "normalize", silently breaking attribution.
    const platformLoc = "/home/user/.comis/skills/build/SKILL.md";
    const learnedLoc = "/home/user/workspace/.learned-skills/deploy/SKILL.md"; // absolute, as the learned surface emits
    const xml =
      "<available_skills>\n" +
      "  <skill>\n" +
      "    <name>build</name>\n" +
      "    <description>Build it</description>\n" +
      `    <location>${platformLoc}</location>\n` +
      "    <source>bundled</source>\n" +
      "  </skill>\n" +
      "  <skill>\n" +
      "    <name>deploy</name>\n" +
      "    <description>Deploy it</description>\n" +
      `    <location>${learnedLoc}</location>\n` +
      "    <source>learned</source>\n" +
      "  </skill>\n" +
      "</available_skills>";

    const index = parseSkillLocationIndex(xml);
    // A `read` of the absolute learned location attributes the learned skill.
    expect(index.get(learnedLoc)).toBe("deploy");
    // Both locations are absolute — the block is format-consistent (no relative key).
    expect([...index.keys()].every((k) => k.startsWith("/"))).toBe(true);
    expect(index.get(platformLoc)).toBe("build");
  });
});
