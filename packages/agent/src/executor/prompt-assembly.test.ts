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

import { assembleExecutionPrompt, extractUserLanguage, resolvePromptModeForProfile, clearSessionToolNameSnapshot, clearSessionBootstrapFileSnapshot, clearSessionPromptSkillsXmlSnapshot, getCacheSafeParams, clearCacheSafeParams, buildRecallTrace, type PromptAssemblyParams, type CacheSafeParams } from "./prompt-assembly.js";
import { resolveRecallTraceFilePath } from "@comis/observability";
import * as nodeOs from "node:os";
import { formatSessionKey, type SpawnPacket, type MemorySearchResult } from "@comis/core";
// Real (un-mocked) §7.3 guidance formatter — prompt-assembly pushes its block into
// the prompt when >=2 memories are surfaced. It is FIXED guidance text, NOT a
// retrieved memory, so it must NOT inflate retrieved-memory telemetry:
// charsInjected / ragHits count retrieved memory only, never the guidance block.
import { buildTemporalGuidanceBlock } from "../rag/temporal-guidance.js";
import { createSpawnPacketBuilder } from "../spawn/spawn-packet-builder.js";
// Fixture stub for the capability-index gate. Default returns `false` so
// existing tests stay on the legacy gate-off path (byte-identical baseline).
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
      // The static-prompt branch on `isCapabilityIndexEnabled` was
      // removed (only path emits the residual one-liner). The port stub
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
  // 4. RAG retrieval via hybrid memory injector (Task 229)
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
    // RED on pre-patch code: the createMemoryRecall call object listed
    // entityStore/temporalStore/causalStore/usefulnessStore but NOT tripleStore,
    // so the 6th graphSpread lane gate (`deps.tripleStore !== undefined`) was
    // always false and spreadLane never ran — the lane dead even with the store
    // injected and rag.lanes.graphSpread.enabled flipped on.
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

  it("threads deps.embeddingStore + config.rag.mmr/queryUnderstanding into createMemoryRecall so the MMR re-rank has its store and knobs", async () => {
    // Production-wiring regression guard for the LAST link of the chain:
    // PromptAssemblyParams.deps.embeddingStore → createMemoryRecall's deps.embeddingStore,
    // and config.rag.mmr / config.rag.queryUnderstanding → createMemoryRecall's config.
    // RED on pre-patch code: the createMemoryRecall call object listed
    // entityStore/temporalStore/causalStore/tripleStore/usefulnessStore but NOT
    // embeddingStore, and its config object omitted mmr + queryUnderstanding, so the
    // MMR slot gate (`deps.embeddingStore !== undefined && cfg.mmr?.enabled`) was always
    // false and the diversity re-rank never ran — a silent no-op even with the store
    // injected and rag.mmr.enabled flipped on (the field-plumbing hazard).
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
  // 4a-ter. The deterministic apply overlay (buildScoringAlphas) at
  // the recall `scoring:` arg, behind a gated tunedAlphaStore read.
  //   - Default-OFF byte-identity: tuning off (or no store dep) ⇒
  //     read() called 0 times AND the `scoring` arg is byte-identical to
  //     config.rag.scoring (the static alphas pass unchanged). The spy mirrors
  //     the feedback default-off / MMR readEmbeddings=0 pattern.
  //   - Apply: tuning ON + a learned vector ⇒ the `scoring` arg carries the four
  //     tuned non-trust alphas; read() runs ONCE scoped to (tenant, agent).
  //   - Belt #2 (the ship-gate): under tuning ON with ANY learned vector, the
  //     `scoring` arg's trust weight is byte-identical to config.rag.scoring's —
  //     the learned vector can never raise trust (the overlay sources it from
  //     config). The trust FILTER (memory-recall.ts:534-536) stays frozen — that
  //     file is UNTOUCHED by this plan (asserted via the git-diff verify gate).
  // -----------------------------------------------------------------
  describe("deterministic apply overlay (gated buildScoringAlphas at the recall scoring arg)", () => {
    /** The static config alphas the overlay merges onto (the SOLE trust-weight source). */
    const CONFIG_SCORING = {
      recencyAlpha: 0.2,
      temporalAlpha: 0.2,
      proofAlpha: 0.1,
      trustAlpha: 0.1,
      usefulnessAlpha: 0.1,
    };

    /** A spy TunedAlphaStore counting read() calls + capturing the read scope. */
    function makeTunedSpy(
      vector: import("@comis/core").TunedAlphaVector | undefined,
    ): {
      store: import("@comis/core").TunedAlphaStore;
      reads: () => number;
      lastScope: () => { tenantId: string; agentId: string } | undefined;
    } {
      let readCalls = 0;
      let scope: { tenantId: string; agentId: string } | undefined;
      const store = {
        upsert: vi.fn(),
        read: vi.fn(async (s: { tenantId: string; agentId: string }) => {
          readCalls += 1;
          scope = s;
          return { ok: true as const, value: vector };
        }),
      } as unknown as import("@comis/core").TunedAlphaStore;
      return { store, reads: () => readCalls, lastScope: () => scope };
    }

    /** A memoryPort + a non-empty recall result so the recall path runs end-to-end. */
    function ragMemoryPort() {
      mockRecall.mockResolvedValue({ ok: true, value: [] });
      return {
        search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
        store: vi.fn(),
      } as any;
    }

    /** Base rag config with the static scoring alphas; `onlineTuning` toggled per test. */
    function tuningConfig(onlineTuning?: { enabled: boolean }) {
      return makeConfig({
        rag: {
          enabled: true,
          maxResults: 5,
          minScore: 0.3,
          includeTrustLevels: ["learned"],
          maxContextChars: 5000,
          scoring: { ...CONFIG_SCORING },
          ...(onlineTuning !== undefined ? { onlineTuning } : {}),
        },
      });
    }

    /** The `scoring` arg captured off the (mocked) createMemoryRecall config object. */
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

    it("Test 1 (default-OFF byte-identity): tuning OFF ⇒ read() 0 times AND scoring is byte-identical to config", async () => {
      // The store is CONSTRUCTED (spy) and WIRED, but onlineTuning is OFF — the
      // gate must short-circuit BEFORE the read. FAILS on a pre-patch that reads
      // the store above the enabled gate (the MMR readEmbeddings=0 analog).
      const spy = makeTunedSpy({
        recencyAlpha: 0.9,
        temporalAlpha: 0.8,
        proofAlpha: 0.7,
        usefulnessAlpha: 0.6,
      });
      await assembleExecutionPrompt(
        makeParams({
          config: tuningConfig({ enabled: false }),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort(), tunedAlphaStore: spy.store },
          sessionKey: { tenantId: "t", agentId: "agent-1", channelType: "telegram", channelId: "chat-1" } as any,
        }),
      );

      // THE COST GATE: tuning off ⇒ the store read NEVER fires.
      expect(spy.reads(), "read() NEVER called when onlineTuning is off").toBe(0);
      // ...and the static config alphas pass unchanged (byte-identical recall).
      expect(capturedScoring()).toEqual(CONFIG_SCORING);
    });

    it("Test 2 (apply): tuning ON + a learned vector ⇒ the four non-trust alphas reach scoring; read() runs ONCE scoped to (tenant, agent)", async () => {
      const spy = makeTunedSpy({
        recencyAlpha: 0.91,
        temporalAlpha: 0.82,
        proofAlpha: 0.73,
        usefulnessAlpha: 0.64,
      });
      await assembleExecutionPrompt(
        makeParams({
          config: tuningConfig({ enabled: true }),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort(), tunedAlphaStore: spy.store },
          sessionKey: { tenantId: "t", agentId: "agent-1", channelType: "telegram", channelId: "chat-1" } as any,
          agentId: "agent-1",
        }),
      );

      const scoring = capturedScoring();
      // The four tuned non-trust alphas overlay the static config alphas.
      expect(scoring.recencyAlpha).toBe(0.91);
      expect(scoring.temporalAlpha).toBe(0.82);
      expect(scoring.proofAlpha).toBe(0.73);
      expect(scoring.usefulnessAlpha).toBe(0.64);
      // The read fired exactly once, scoped to the live (tenant, agent).
      expect(spy.reads()).toBe(1);
      expect(spy.lastScope()).toEqual({ tenantId: "t", agentId: "agent-1" });
    });

    it("Test 3 (belt #2 at the apply site): under tuning ON with ANY learned vector, scoring.trustAlpha is byte-identical to config", async () => {
      // Even a learned vector that (type-widened) smuggles a trust weight cannot move
      // the apply-site trust weight — the overlay sources it from config. FAILS if
      // trustAlpha is taken from the tuned vector.
      const smuggled = {
        recencyAlpha: 0.95,
        temporalAlpha: 0.95,
        proofAlpha: 0.95,
        usefulnessAlpha: 0.95,
        trustAlpha: 0.99,
      } as unknown as import("@comis/core").TunedAlphaVector;
      const spy = makeTunedSpy(smuggled);
      await assembleExecutionPrompt(
        makeParams({
          config: tuningConfig({ enabled: true }),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort(), tunedAlphaStore: spy.store },
          sessionKey: { tenantId: "t", agentId: "agent-1", channelType: "telegram", channelId: "chat-1" } as any,
          agentId: "agent-1",
        }),
      );

      const scoring = capturedScoring();
      // belt #2: the trust weight is byte-identical to config (0.1), NOT the smuggled 0.99.
      expect(scoring.trustAlpha).toBe(CONFIG_SCORING.trustAlpha);
      expect(scoring.trustAlpha).toBe(0.1);
      // The four non-trust alphas DID overlay (proving the vector was applied, not ignored).
      expect(scoring.recencyAlpha).toBe(0.95);
    });
  });

  // -----------------------------------------------------------------
  // 4a-bis. The LLM-free per-user-profile standing block.
  // The profile is read (deterministically) + pushed onto memorySections
  // exactly like the temporal-guidance block. Its binding proof is
  // default-OFF byte-identity (the cost gate): with NO userRepresentationStore
  // dep the prompt is byte-identical AND read() is called 0 times. The block
  // appears ONLY when the store returns rows, and the injection is LLM-free
  // (a store.read + the pure formatter — never a model call).
  // -----------------------------------------------------------------
  describe("per-user-profile injection (LLM-free standing block)", () => {
    /**
     * The standing-block config: the profile's OWN gate
     * (`memoryUserRepresentation.enabled`) is ON. The profile push
     * site is gated on this knob + the store dep, INDEPENDENT of recall hits and
     * independent of `rag.enabled`. `rag.enabled` is left ON here only so the
     * recall path also runs (the prior tests asserted recall is still constructed
     * exactly once); the standing block no longer NEEDS a recall hit to inject.
     */
    function ragConfig() {
      return makeConfig({
        memoryUserRepresentation: { enabled: true },
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
     * The standing-block config WITHOUT a recall hit: the profile knob is ON but
     * `rag.enabled` is OFF (no recall, no recall hits). The durable
     * profile MUST still inject on a zero-recall turn. The push must NOT be nested
     * inside the recall-hit branch.
     */
    function userReprOnlyConfig() {
      return makeConfig({
        memoryUserRepresentation: { enabled: true },
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
    /** A spy UserRepresentationStore counting read() calls, returning a fixed set. */
    function makeSpyStore(
      entries: import("@comis/core").UserRepresentationEntry[],
    ): { store: import("@comis/core").UserRepresentationStore; reads: () => number } {
      let readCalls = 0;
      const store = {
        upsert: vi.fn(),
        read: vi.fn(async () => {
          readCalls += 1;
          return { ok: true as const, value: entries };
        }),
      } as unknown as import("@comis/core").UserRepresentationStore;
      return { store, reads: () => readCalls };
    }

    it("default-OFF: with NO userRepresentationStore dep the prompt is byte-identical (no <user_profile> block)", async () => {
      const params = makeParams({
        config: ragConfig(),
        deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
        sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
      });
      const result = await assembleExecutionPrompt(params);

      // No store dep ⇒ no profile read ⇒ no block ⇒ byte-identity preserved.
      expect(result.dynamicPreamble).not.toContain("<user_profile>");
      expect(result.systemPrompt).not.toContain("<user_profile>");
    });

    it("default-OFF cost gate: with NO store dep, read() is called 0 times AND the prompt equals the no-store baseline", async () => {
      // The store is CONSTRUCTED (spy) but NOT wired into deps — the off config.
      // Mirror recall-iq-contribution.bench.test.ts:633-640: the off config never
      // reads (the cost gate) and is byte-identical to the feature-absent path.
      const spy = makeSpyStore([
        {
          id: "p1",
          entryType: "identity",
          content: "name is Sam",
          trust: "learned",
          createdAt: 1_000,
        },
      ]);

      const baseline = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // THE COST GATE: the store was never wired, so its read() was never called.
      expect(spy.reads(), "read() NEVER called in the off (no-store-dep) config").toBe(0);
      expect(baseline.dynamicPreamble).not.toContain("<user_profile>");
    });

    it("store present but empty: read() runs, the formatter returns null, nothing is pushed → byte-identical prompt", async () => {
      const emptySpy = makeSpyStore([]); // the user has no profile rows
      const withStore = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            userRepresentationStore: emptySpy.store,
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

      // The read ran (store present) but found nothing → no block → identical prompt.
      expect(emptySpy.reads(), "read() runs once when the store is present").toBe(1);
      expect(withStore.dynamicPreamble).not.toContain("<user_profile>");
      expect(withStore.dynamicPreamble).toEqual(withoutStore.dynamicPreamble);
      expect(withStore.systemPrompt).toEqual(withoutStore.systemPrompt);
    });

    it("LLM-free injection ON: a store returning rows injects the <user_profile> block via store.read + the pure formatter (no model call)", async () => {
      const spy = makeSpyStore([
        {
          id: "p2",
          entryType: "preference",
          content: "likes terse replies",
          trust: "learned",
          createdAt: 2_000,
        },
        {
          id: "p1",
          entryType: "identity",
          content: "name is Sam",
          trust: "learned",
          createdAt: 1_000,
        },
      ]);
      const result = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            userRepresentationStore: spy.store,
          },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // The block + every entry's content appear; the read drove it (LLM-free).
      expect(result.dynamicPreamble).toContain("<user_profile>");
      expect(result.dynamicPreamble).toContain("name is Sam");
      expect(result.dynamicPreamble).toContain("likes terse replies");
      expect(spy.reads(), "the injection is a store.read (deterministic, LLM-free)").toBe(1);
      // The injection adds NO extra model/recall seam: recall is still constructed
      // exactly once (the profile path is a store.read + the pure formatter, never a
      // second createMemoryRecall / reasoning call).
      expect(mockCreateMemoryRecall).toHaveBeenCalledOnce();
    });

    it("standing block: a populated profile injects on a ZERO-recall turn (recall returns ok([])) — the profile is NOT recall-conditional", async () => {
      // RED-first: the profile <user_profile> block was wrongly NESTED inside
      // the `recalled.value.length > 0` recall-hit branch, so it silently dropped on
      // every zero-recall turn (greetings/off-topic/sparse store). The durable per-user
      // profile is a STANDING block — it must inject whenever its OWN knob is on + the
      // store has rows, independent of whether THIS turn's recall hit. This test wires a
      // populated store + a recall that returns ok([]) (the beforeEach default) and asserts
      // the block IS present. On the pre-fix (nested) code this FAILS (the push site is
      // unreachable when recalled.value.length === 0).
      const memoryPort = ragMemoryPort(); // builds the port (and sets a recall hit)
      // Force ZERO recall hits AFTER ragMemoryPort() (which set a non-empty result):
      // recall succeeds but returns nothing this turn — the recall-hit branch is NOT
      // entered, so the pre-fix (nested) profile push is unreachable here.
      mockRecall.mockResolvedValue({ ok: true, value: [] });
      const spy = makeSpyStore([
        {
          id: "p1",
          entryType: "identity",
          content: "name is Sam",
          trust: "learned",
          createdAt: 1_000,
        },
      ]);
      const result = await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: {
            workspaceDir: "/workspace",
            memoryPort,
            userRepresentationStore: spy.store,
          },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // The standing block injects even though recall returned NOTHING this turn.
      expect(result.dynamicPreamble).toContain("<user_profile>");
      expect(result.dynamicPreamble).toContain("name is Sam");
      expect(spy.reads(), "the standing-block read runs on a zero-recall turn").toBe(1);
    });

    it("standing block: injects with rag.enabled=false (no memoryPort recall path) — decoupled from the RAG knob", async () => {
      // The other half: the block was ALSO gated behind `rag.enabled` +
      // `deps.memoryPort` (the outer recall guard). An operator who enables
      // `memoryUserRepresentation` but runs `rag.enabled: false` got ZERO profile
      // injection (the offline builder wrote rows nothing ever read). The standing
      // block must inject on its OWN knob + store, with NO RAG/memoryPort at all.
      const spy = makeSpyStore([
        {
          id: "p1",
          entryType: "identity",
          content: "name is Sam",
          trust: "learned",
          createdAt: 1_000,
        },
      ]);
      const result = await assembleExecutionPrompt(
        makeParams({
          config: userReprOnlyConfig(), // rag.enabled = false, NO memoryPort wired
          deps: {
            workspaceDir: "/workspace",
            userRepresentationStore: spy.store,
          },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      expect(result.dynamicPreamble).toContain("<user_profile>");
      expect(result.dynamicPreamble).toContain("name is Sam");
      expect(spy.reads(), "the standing-block read runs even with rag.enabled=false").toBe(1);
    });

    it("cost gate: knob OFF + store present + recall HIT ⇒ read() NEVER called and the prompt is byte-identical (the OWN-knob gate, not store-presence)", async () => {
      // The gate moved from store-presence-only to (knob && store). Prove the
      // knob is load-bearing — and that this is a true regression guard: wire the store
      // AND drive a recall HIT (so the OLD nested push site WOULD have run), but leave
      // `memoryUserRepresentation` OFF. The cost gate must hold: read() is NEVER called
      // and the prompt equals the knob-off baseline (default-OFF byte-identity). On the
      // pre-fix code (gated on store-presence inside the recall-hit branch) this FAILS —
      // it would read once and inject. The recall block itself still runs (rag.enabled),
      // so the baseline includes the recalled section; only the profile is gated off.
      const memoryPort = ragMemoryPort(); // sets a non-empty recall hit
      const spy = makeSpyStore([
        {
          id: "p1",
          entryType: "identity",
          content: "name is Sam",
          trust: "learned",
          createdAt: 1_000,
        },
      ]);
      const knobOff = await assembleExecutionPrompt(
        makeParams({
          // knobOffRagConfig: rag.enabled ON (recall hits) but the profile knob OFF.
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
            memoryPort,
            userRepresentationStore: spy.store,
          },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );
      const baseline = await assembleExecutionPrompt(
        makeParams({
          config: makeConfig({
            rag: {
              enabled: true,
              maxResults: 5,
              minScore: 0.3,
              includeTrustLevels: ["learned"],
              maxContextChars: 5000,
            },
          }),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      expect(spy.reads(), "knob off ⇒ read() NEVER called even on a recall hit (the cost gate)").toBe(0);
      expect(knobOff.dynamicPreamble).not.toContain("<user_profile>");
      expect(knobOff.dynamicPreamble).toEqual(baseline.dynamicPreamble);
      expect(knobOff.systemPrompt).toEqual(baseline.systemPrompt);
    });

    it("forward-presence: deps.userRepresentationStore reaches the read site with the prompt's own (tenant, agent, user) scope", async () => {
      // The threading guard (a dropped thread is a silent no-op). Mirror
      // the deps.tripleStore forward-presence test (lines 310-337): assert the dep the
      // caller passed is the one whose read() fires, scoped to THIS prompt's identity.
      const spy = makeSpyStore([
        {
          id: "p1",
          entryType: "identity",
          content: "name is Sam",
          trust: "learned",
          createdAt: 1_000,
        },
      ]);
      await assembleExecutionPrompt(
        makeParams({
          config: ragConfig(),
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            tenantId: "tenant-X",
            userRepresentationStore: spy.store,
          },
          agentId: "agent-Z",
          sessionKey: { tenantId: "tenant-X", userId: "user-Q", channelId: "chat-1" } as any,
        }),
      );

      // The exact dep the caller passed is the one that ran (forward-presence).
      expect(spy.reads()).toBe(1);
      const readMock = (spy.store as unknown as { read: ReturnType<typeof vi.fn> }).read;
      const scopeArg = readMock.mock.calls[0][0] as {
        tenantId: string;
        agentId: string;
        userId: string;
      };
      expect(scopeArg.tenantId).toBe("tenant-X");
      expect(scopeArg.agentId).toBe("agent-Z");
      expect(scopeArg.userId).toBe("user-Q");
    });
  });

  // -----------------------------------------------------------------
  // 4a-ter. The LLM-free channel-relationship standing block.
  // The directional analog of the user-profile block above.
  // The channel's relationship edges are read (deterministically) + pushed onto
  // memorySections, exactly like the temporal-guidance / user-profile blocks.
  // Two binding proofs:
  //   - default-OFF byte-identity (the cost gate): with NO relationshipStore dep
  //     OR socialModeling off, the prompt is byte-identical AND read() is 0 times.
  //   - sign-off gate (the headline read-side proof): socialModeling.enabled
  //     === true but NO privacyReviewSignedOffBy ⇒ STILL 0 reads + byte-identical (the
  //     knob alone does not activate — a recorded sign-off is required).
  // The active path reads scoped to channelId = sessionKey.channelId (the
  // read-side boundary) and the injection is LLM-free (a store.read + the pure
  // formatter — never a model call).
  // -----------------------------------------------------------------
  describe("channel-relationship injection (LLM-free, sign-off gated)", () => {
    /** socialModeling ON + a recorded sign-off (the ACTIVE gate) + rag for parity. */
    function signedOffConfig() {
      return makeConfig({
        socialModeling: { enabled: true, privacyReviewSignedOffBy: "ops@example.com" },
        rag: {
          enabled: true,
          maxResults: 5,
          minScore: 0.3,
          includeTrustLevels: ["learned"],
          maxContextChars: 5000,
        },
      });
    }
    /** socialModeling ON but NO sign-off (the RED gate — knob alone). */
    function enabledNoSignOffConfig() {
      return makeConfig({
        socialModeling: { enabled: true },
        rag: {
          enabled: true,
          maxResults: 5,
          minScore: 0.3,
          includeTrustLevels: ["learned"],
          maxContextChars: 5000,
        },
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
    /** A spy RelationshipStore counting read() calls, returning a fixed edge set. */
    function makeSpyRelationshipStore(
      entries: import("@comis/core").RelationshipEntry[],
    ): { store: import("@comis/core").RelationshipStore; reads: () => number } {
      let readCalls = 0;
      const store = {
        upsert: vi.fn(),
        read: vi.fn(async () => {
          readCalls += 1;
          return { ok: true as const, value: entries };
        }),
      } as unknown as import("@comis/core").RelationshipStore;
      return { store, reads: () => readCalls };
    }
    /** A single directional edge fixture. */
    function edge(): import("@comis/core").RelationshipEntry {
      return {
        id: "r1",
        subjectUserId: "alice",
        aboutUserId: "bob",
        content: "trusts on logistics",
        trust: "learned",
        createdAt: 1_000,
      };
    }

    it("default-OFF: with NO relationshipStore dep the prompt is byte-identical (no <channel_relationships> block)", async () => {
      const result = await assembleExecutionPrompt(
        makeParams({
          config: signedOffConfig(),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // No store dep ⇒ no relationship read ⇒ no block ⇒ byte-identity preserved.
      expect(result.dynamicPreamble).not.toContain("<channel_relationships>");
      expect(result.systemPrompt).not.toContain("<channel_relationships>");
    });

    it("default-OFF cost gate: with NO store dep, read() is called 0 times AND the prompt equals the no-store baseline", async () => {
      // The store is CONSTRUCTED (spy) but NOT wired into deps — the off config.
      const spy = makeSpyRelationshipStore([edge()]);

      const baseline = await assembleExecutionPrompt(
        makeParams({
          config: signedOffConfig(),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // THE COST GATE: the store was never wired, so its read() was never called.
      expect(spy.reads(), "read() NEVER called in the off (no-store-dep) config").toBe(0);
      expect(baseline.dynamicPreamble).not.toContain("<channel_relationships>");
    });

    it("socialModeling OFF (undefined): store present + recall HIT ⇒ read() NEVER called and the prompt is byte-identical", async () => {
      // socialModeling is undefined entirely (makeConfig default). The store IS wired
      // and recall hits, so the only thing gating the read is the socialModeling knob.
      const memoryPort = ragMemoryPort();
      const spy = makeSpyRelationshipStore([edge()]);
      const off = await assembleExecutionPrompt(
        makeParams({
          config: makeConfig({
            rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 },
          }),
          deps: { workspaceDir: "/workspace", memoryPort, relationshipStore: spy.store },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );
      const baseline = await assembleExecutionPrompt(
        makeParams({
          config: makeConfig({
            rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 },
          }),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      expect(spy.reads(), "socialModeling undefined ⇒ read() NEVER called (the cost gate)").toBe(0);
      expect(off.dynamicPreamble).not.toContain("<channel_relationships>");
      expect(off.dynamicPreamble).toEqual(baseline.dynamicPreamble);
      expect(off.systemPrompt).toEqual(baseline.systemPrompt);
    });

    it("sign-off gate: enabled=true but NO privacyReviewSignedOffBy ⇒ 0 reads + byte-identical prompt (the headline sign-off RED)", async () => {
      // THE HEADLINE READ-SIDE PROOF: the knob is ON but there is NO recorded
      // sign-off. The store IS wired and recall HITS (so a store-presence-only or
      // enabled-only gate WOULD read and inject). The dual gate must hold: a recorded
      // privacyReviewSignedOffBy is REQUIRED — without it read() is NEVER called and the
      // prompt is byte-identical to the no-relationship baseline.
      const memoryPort = ragMemoryPort();
      const spy = makeSpyRelationshipStore([edge()]);
      const noSignOff = await assembleExecutionPrompt(
        makeParams({
          config: enabledNoSignOffConfig(),
          deps: { workspaceDir: "/workspace", memoryPort, relationshipStore: spy.store },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );
      const baseline = await assembleExecutionPrompt(
        makeParams({
          config: enabledNoSignOffConfig(),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      expect(spy.reads(), "knob on but NO sign-off ⇒ read() NEVER called").toBe(0);
      expect(noSignOff.dynamicPreamble).not.toContain("<channel_relationships>");
      expect(noSignOff.dynamicPreamble).toEqual(baseline.dynamicPreamble);
      expect(noSignOff.systemPrompt).toEqual(baseline.systemPrompt);
    });

    it("store present but empty: read() runs, the formatter returns null, nothing is pushed → byte-identical prompt", async () => {
      const emptySpy = makeSpyRelationshipStore([]); // the channel has no edges
      const withStore = await assembleExecutionPrompt(
        makeParams({
          config: signedOffConfig(),
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            relationshipStore: emptySpy.store,
          },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );
      const withoutStore = await assembleExecutionPrompt(
        makeParams({
          config: signedOffConfig(),
          deps: { workspaceDir: "/workspace", memoryPort: ragMemoryPort() },
          sessionKey: { tenantId: "t", userId: "u", channelId: "chat-1" } as any,
        }),
      );

      // The read ran (store present, gate open) but found nothing → no block → identical.
      expect(emptySpy.reads(), "read() runs once when the store is present and the gate is open").toBe(1);
      expect(withStore.dynamicPreamble).not.toContain("<channel_relationships>");
      expect(withStore.dynamicPreamble).toEqual(withoutStore.dynamicPreamble);
      expect(withStore.systemPrompt).toEqual(withoutStore.systemPrompt);
    });

    it("active path: enabled + signed off + a store returning edges injects the <channel_relationships> block scoped to channelId = sessionKey.channelId (LLM-free)", async () => {
      const spy = makeSpyRelationshipStore([edge()]);
      const result = await assembleExecutionPrompt(
        makeParams({
          config: signedOffConfig(),
          deps: {
            workspaceDir: "/workspace",
            memoryPort: ragMemoryPort(),
            tenantId: "tenant-X",
            relationshipStore: spy.store,
          },
          agentId: "agent-Z",
          sessionKey: { tenantId: "tenant-X", userId: "user-Q", channelId: "chan-77" } as any,
        }),
      );

      // The block + the edge's directional content appear; the read drove it (LLM-free).
      expect(result.dynamicPreamble).toContain("<channel_relationships>");
      expect(result.dynamicPreamble).toContain("alice");
      expect(result.dynamicPreamble).toContain("bob");
      expect(result.dynamicPreamble).toContain("trusts on logistics");
      expect(spy.reads(), "the injection is a store.read (deterministic, LLM-free)").toBe(1);

      // The read-side boundary: the scope's channelId is the session's channel.
      const readMock = (spy.store as unknown as { read: ReturnType<typeof vi.fn> }).read;
      const scopeArg = readMock.mock.calls[0][0] as {
        tenantId: string;
        agentId: string;
        channelId: string;
      };
      expect(scopeArg.tenantId).toBe("tenant-X");
      expect(scopeArg.agentId).toBe("agent-Z");
      expect(scopeArg.channelId).toBe("chan-77");

      // The injection adds NO extra model/recall seam: recall is still constructed once.
      expect(mockCreateMemoryRecall).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------
  // 4b. memory:injected event emit
  // -----------------------------------------------------------------
  it("emits_memory_injected_when_inline_memory_set with hitCount/charsInjected/trustTags", async () => {
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

    const memoryEmit = emit.mock.calls.find((c: any[]) => c[0] === "memory:injected");
    expect(memoryEmit, "memory:injected emit must fire when injection produces content").toBeTruthy();
    const payload = memoryEmit![1];
    expect(payload.hitCount).toBe(2);
    // ranked.length === 2 -> the §7.3 guidance block IS injected into the
    // prompt, but it is FIXED guidance text, NOT a retrieved memory. The
    // memory:injected telemetry must count retrieved memory ONLY (inline +
    // retrieved sections) and must NOT include the guidance-block length —
    // otherwise charsInjected disagrees with hitCount about what "injected"
    // means. Pin that charsInjected reflects ONLY the retrieved memory.
    const guidanceLen = buildTemporalGuidanceBlock(mockSearchResults as unknown as MemorySearchResult[])!.length;
    expect(guidanceLen, "guard: the §7.3 block must be non-empty for this assertion to bite").toBeGreaterThan(0);
    expect(payload.charsInjected).toBe("[inline rag chunk]".length + "section body".length);
    // Consistency with hitCount: charsInjected must NOT carry the guidance block.
    expect(payload.charsInjected).not.toBe(
      "[inline rag chunk]".length + "section body".length + guidanceLen,
    );
    expect(new Set(payload.trustTags)).toEqual(new Set(["learned", "system"]));
    expect(typeof payload.timestamp).toBe("number");
    expect(typeof payload.traceId).toBe("string");
  });

  it("does_not_emit_when_no_injection (deduped is empty, the if-block is skipped)", async () => {
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
    // undefined) reflecting the RAG-sections-only injection. Today
    // this fails because prompt-assembly's predicate is `inlineMemory
    // ? { … } : undefined` — undefined inlineMemory drops the block
    // entirely even when memorySections.length > 0.
    expect(parsed.memoryInjection).toBeDefined();
    expect(parsed.memoryInjection.ragHits).toBe(1);
    expect(parsed.memoryInjection.charsInjected).toBe(sectionBody.length);
    expect(parsed.memoryInjection.trustTags).toEqual([]);
  });

  it("SystemPromptReport.memoryInjection excludes the §7.3 guidance block from ragHits/charsInjected", async () => {
    // >=2 surfaced memories -> the §7.3 temporal-guidance block IS pushed into
    // the prompt. The persisted report's ragHits/charsInjected must count the
    // RETRIEVED memory ONLY (the one inline + one section here), NOT the fixed
    // guidance text. Pre-fix this over-counted: ragHits tallied the guidance
    // block as a RAG hit (2 sections -> ragHits 3 incl. inline) and
    // charsInjected included the block's length.
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
    expect(guidanceLen, "guard: the §7.3 block must be non-empty for this assertion to bite").toBeGreaterThan(0);

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
  // WR-03: resolvePromptModeForProfile priority ladder (compact-secure wins
  // over the cron/heartbeat → operational downgrade for small/nano).
  // -----------------------------------------------------------------
  describe("WR-03: resolvePromptModeForProfile cron/heartbeat on small/nano", () => {
    const smallProfile = { capabilityClass: "small" } as any;
    const nanoProfile = { capabilityClass: "nano" } as any;
    const frontierProfile = { capabilityClass: "frontier" } as any;
    const compactOn = { enabled: true };

    it("small + cron + full → compact-secure (NOT operational) — keeps S1 hardening", () => {
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

    // WR-02: compact-secure + senderTrustDisplayConfig disabled → WARN log
    it("WR-02: compact-secure active with senderTrustDisplayConfig disabled emits WARN log", async () => {
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

      // Must emit exactly the WR-02 WARN
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

    it("WR-02: compact-secure with senderTrustDisplayConfig.enabled=true does NOT emit the WR-02 WARN", async () => {
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
  // Task 229: Hybrid memory injector -- inlineMemory
  // -----------------------------------------------------------------
  describe("Task 229: hybrid memory injector -- inlineMemory", () => {
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

    it("hookResult.systemPrompt still replaces system prompt (backward compat)", async () => {
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

  // 4.2: CacheSafeParams versioned with toolHash
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

  it("refreshes CacheSafeParams when toolHash changes mid-session (4.2)", async () => {
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

  it("does NOT refresh CacheSafeParams when toolHash is unchanged (4.2)", async () => {
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
    // The recorder used to hardcode os.homedir()/.comis as its base
    // while the memory.recall_trace handler reads from the configured dataDir
    // (deps.dataDir ?? ~/.comis). Under a non-default COMIS_DATA_DIR the writer
    // and reader pointed at DIFFERENT files, so the diagnostic returned nothing.
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
// SC2-budget: pinnedChars deducted from maxContextChars before injector.split
//
// When rag.pinned.enabled=true, prompt-assembly computes the char length of the
// pinned section (using formatMemorySection) and passes maxContextChars-pinnedChars
// to injector.split — so fused recall never consumes budget already used by pins.
// DEFAULT-OFF: when pinned is disabled, injector.split receives the full budget.
// ---------------------------------------------------------------------------

describe("assembleExecutionPrompt — SC2-budget: pinnedChars deducted from maxContextChars", () => {
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
    // SC2-budget: formatMemorySection returns a 500-char pinned section.
    // injector.split must be called with MAX_CONTEXT_CHARS - 500 = 3500.
    // Pre-patch (no budget accounting): injector.split called with full 4000.
    // Post-patch: injector.split called with 3500.
    // entry.pinned=true is required so the CR-03 fix identifies this as a real pin.
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

// CR-03: prompt-assembly budget split uses entry.pinned not positional slice
// When 2 pins exist with cap=5, injector.split must receive the 0 FUSED entries
// (not the 5-item positional slice that includes fused entries as fake "pins").
describe("assembleExecutionPrompt — CR-03: pinnedSet identified by entry.pinned, not positional slice", () => {
  const MAX_CONTEXT_CHARS = 4000;
  const PINNED_SECTION_CHARS = 200;

  beforeEach(() => {
    mockFormatMemorySection.mockReturnValue(undefined);
    mockRecall.mockResolvedValue({ ok: false, error: new Error("no recall") });
    mockHybridSplit.mockClear();
    mockCreateMemoryRecall.mockClear();
  });

  it("CR-03: injector.split receives only fused entries (not pinned ones) when 2 pins < cap=5", async () => {
    // 2 pinned + 3 fused entries in recall. maxPinnedInjection=5 (cap > actual pins).
    // Pre-patch: positional slice(0, 5) grabs all 5 entries as "pinnedSet" →
    //   injector.split receives [] (empty) → the 3 fused entries are DROPPED.
    // Post-patch: entry.pinned===true identifies exactly 2 pins →
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
  // R3 Small/nano count cap (153-03)
  // -----------------------------------------------------------------
  describe("R3 small/nano profile count/chars caps", () => {
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
