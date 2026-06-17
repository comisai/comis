// SPDX-License-Identifier: Apache-2.0
/**
 * Behavioral tests for the WS7-wired memory-cron sentinel handlers
 * (`__USEFULNESS_JUDGE__` WIRE-02 + `__MEMORY_TRIPLE_EXTRACTION__` WIRE-01),
 * exercising `handleWireMemoryCronSentinel` DIRECTLY (the neighbor-test invariant
 * — the file carries its own coverage). The end-to-end delegation from
 * `handleMemoryCronSentinel` is covered in setup-channels-memory-crons.test.ts.
 *
 * createUsefulnessJudgeSeam / runMemoryTripleExtraction / createReasoningSeam are
 * mocked — no real LLM, no key.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockJudgeSeam = vi.hoisted(() => vi.fn(async () => ({ usedIds: [] as string[], ignoredIds: [] as string[] })));
const mockCreateUsefulnessJudgeSeam = vi.hoisted(() => vi.fn(() => mockJudgeSeam));
const mockReasonSeam = vi.hoisted(() => vi.fn(async () => ({ deductive: [], inductive: [] })));
const mockCreateReasoningSeam = vi.hoisted(() => vi.fn(() => mockReasonSeam));
const mockRunMemoryTripleExtraction = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { extracted: 0, written: 0, blocked: 0, downgraded: 0, skippedOverCap: 0 } })));
const mockResolveOperationModel = vi.hoisted(() => vi.fn(() => ({ provider: "anthropic", modelId: "anthropic:claude-haiku", model: "anthropic:claude-haiku", timeoutMs: 60_000, source: "default" })));

vi.mock("@comis/agent", () => ({
  resolveOperationModel: mockResolveOperationModel,
  resolveProviderFamily: vi.fn(() => "anthropic"),
  createUsefulnessJudgeSeam: mockCreateUsefulnessJudgeSeam,
  createReasoningSeam: mockCreateReasoningSeam,
  runMemoryTripleExtraction: mockRunMemoryTripleExtraction,
  // The other named imports the module pulls (consolidation/reasoning/userrep/social/tuning)
  // are not on this leaf's code path, but the wholesale mock must satisfy the import list of
  // any transitively-imported module — keep them present as no-op spies.
  runMemoryConsolidation: vi.fn(),
  runMemoryReasoning: vi.fn(),
  runUserRepresentationBuild: vi.fn(),
  createUserRepresentationSeam: vi.fn(),
  runRelationshipBuild: vi.fn(),
  createRelationshipSeam: vi.fn(),
  runOnlineTuning: vi.fn(),
  resolveModelProfile: vi.fn(() => ({ capabilityClass: "frontier" })),
}));

import { handleWireMemoryCronSentinel } from "./setup-channels-memory-crons-wire.js";
import type { MemoryCronContext } from "./setup-channels-memory-crons-types.js";

function makeCtx(overrides: {
  agents?: Record<string, any>;
  apiKey?: string | undefined;
  inspectRows?: Array<{ id: string; content: string }>;
  recordUsage?: ReturnType<typeof vi.fn>;
} = {}): MemoryCronContext {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => logger) };
  const container = {
    config: { tenantId: "tenant-a", agents: overrides.agents ?? {}, providers: { entries: {} } },
    eventBus: { emit: vi.fn(), on: vi.fn() },
    secretManager: { get: vi.fn(() => (overrides.apiKey === undefined ? undefined : overrides.apiKey)) },
  };
  const memoryApi = { inspect: vi.fn(() => overrides.inspectRows ?? []) };
  return {
    container: container as any,
    logger: logger as any,
    clock: { now: () => 1_000, nowDate: () => new Date(1_000) } as any,
    agents: overrides.agents ?? {},
    tenantId: "tenant-a",
    tripleStore: { upsertTriple: vi.fn(), currentTruth: vi.fn() } as any,
    usefulnessStore: {
      recordUsage: overrides.recordUsage ?? vi.fn(async () => ({ ok: true as const, value: undefined })),
      readUsefulness: vi.fn(async () => ({ ok: true as const, value: new Map() })),
    } as any,
    memoryApi: memoryApi as any,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveOperationModel.mockReturnValue({ provider: "anthropic", modelId: "anthropic:claude-haiku", model: "anthropic:claude-haiku", timeoutMs: 60_000, source: "default" } as any);
  mockCreateUsefulnessJudgeSeam.mockReturnValue(mockJudgeSeam);
  mockJudgeSeam.mockResolvedValue({ usedIds: [], ignoredIds: [] });
  mockCreateReasoningSeam.mockReturnValue(mockReasonSeam);
  mockRunMemoryTripleExtraction.mockResolvedValue({ ok: true as const, value: { extracted: 0, written: 0, blocked: 0, downgraded: 0, skippedOverCap: 0 } });
});

describe("handleWireMemoryCronSentinel", () => {
  it("returns false for an unrecognized sentinel (the caller falls through to delivery)", async () => {
    const handled = await handleWireMemoryCronSentinel("__SOMETHING_ELSE__", { agentId: "a", onComplete: vi.fn() }, makeCtx());
    expect(handled).toBe(false);
  });

  // ----- __USEFULNESS_JUDGE__ (WIRE-02) -----
  it("__USEFULNESS_JUDGE__ writes the judge verdict through recordUsage scoped to (tenant, agent)", async () => {
    mockJudgeSeam.mockResolvedValue({ usedIds: ["m1"], ignoredIds: ["m2"] });
    const recordUsage = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const ctx = makeCtx({
      agents: { "agent-1": { provider: "anthropic", memoryUsefulnessJudge: { enabled: true } } },
      apiKey: "k",
      inspectRows: [{ id: "m1", content: "x" }, { id: "m2", content: "y" }],
      recordUsage,
    });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockCreateUsefulnessJudgeSeam).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledOnce();
    const [used, ignored, scope] = recordUsage.mock.calls[0] as [string[], string[], Record<string, unknown>];
    expect(used).toEqual(["m1"]);
    expect(ignored).toEqual(["m2"]);
    expect(scope).toMatchObject({ tenantId: "tenant-a", agentId: "agent-1" });
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("__USEFULNESS_JUDGE__ short-circuits ok + no write when disabled (defence-in-depth)", async () => {
    const recordUsage = vi.fn();
    const ctx = makeCtx({ agents: { "agent-1": {} }, recordUsage });
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(recordUsage).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("__USEFULNESS_JUDGE__ errors (no write) when fired without an agentId", async () => {
    const recordUsage = vi.fn();
    const ctx = makeCtx({ recordUsage });
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: undefined, onComplete }, ctx);
    expect(recordUsage).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for usefulness judge" });
  });

  it("__USEFULNESS_JUDGE__ reports a non-fatal error when recordUsage fails (no throw)", async () => {
    mockJudgeSeam.mockResolvedValue({ usedIds: ["m1"], ignoredIds: [] });
    const recordUsage = vi.fn(async () => ({ ok: false as const, error: new Error("boom") }));
    const ctx = makeCtx({
      agents: { "agent-1": { provider: "anthropic", memoryUsefulnessJudge: { enabled: true } } },
      apiKey: "k",
      inspectRows: [{ id: "m1", content: "x" }],
      recordUsage,
    });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "boom" });
  });

  it("__USEFULNESS_JUDGE__ errors when an enabled agent has no API key", async () => {
    const recordUsage = vi.fn();
    const ctx = makeCtx({ agents: { "agent-1": { provider: "anthropic", memoryUsefulnessJudge: { enabled: true } } }, apiKey: undefined, recordUsage });
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(mockCreateUsefulnessJudgeSeam).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No API key for anthropic" });
  });

  // ----- __MEMORY_TRIPLE_EXTRACTION__ (WIRE-01) -----
  it("__MEMORY_TRIPLE_EXTRACTION__ short-circuits ok + does NOT run the job when disabled (default-OFF re-check)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": {} } });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__MEMORY_TRIPLE_EXTRACTION__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunMemoryTripleExtraction).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("__MEMORY_TRIPLE_EXTRACTION__ runs runMemoryTripleExtraction with the injected tripleStore when enabled", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { provider: "anthropic", memoryTripleExtraction: { enabled: true, maxCandidatesPerRun: 50 } } },
      apiKey: "k",
      inspectRows: [{ id: "m1", content: "alice knows bob" }],
    });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__MEMORY_TRIPLE_EXTRACTION__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunMemoryTripleExtraction).toHaveBeenCalledOnce();
    const arg = mockRunMemoryTripleExtraction.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.tripleStore).toBe(ctx.tripleStore);
    expect(arg.config).toMatchObject({ enabled: true, maxCandidatesPerRun: 50 });
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("__MEMORY_TRIPLE_EXTRACTION__ errors (no run) when fired without an agentId", async () => {
    const ctx = makeCtx();
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__MEMORY_TRIPLE_EXTRACTION__", { agentId: undefined, onComplete }, ctx);
    expect(mockRunMemoryTripleExtraction).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for triple extraction" });
  });
});
