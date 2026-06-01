// SPDX-License-Identifier: Apache-2.0
/**
 * Behavioral tests for the extracted LLM-backed memory-cron sentinel handlers
 * (`__MEMORY_CONSOLIDATION__` + `__MEMORY_REASONING__`), Phase 84 + Phase 101.
 *
 * These mirror the assertions in setup-channels-credentials.test.ts (which drives
 * the handlers through registerCronEventListeners end-to-end); here they exercise
 * the extracted `handleMemoryCronSentinel` directly so the helper carries its own
 * neighbor test (the coverage-gate file-neighbor invariant) and per-package floor.
 *
 * The reasoning sentinel's distinguishing assertion: it injects BOTH the
 * consolidation store AND the triple store (the deductive write path, the
 * field-plumbing chain) + the built reason() seam. runMemoryReasoning /
 * createReasoningSeam are mocked — no real LLM, no key.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunMemoryConsolidation = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: undefined })));
const mockReasonSeam = vi.hoisted(() => vi.fn(async () => ({ deductive: [], inductive: [] })));
const mockCreateReasoningSeam = vi.hoisted(() => vi.fn(() => mockReasonSeam));
const mockRunMemoryReasoning = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: undefined })));
const mockResolveOperationModel = vi.hoisted(() => vi.fn(() => ({
  provider: "anthropic",
  modelId: "anthropic:claude-haiku",
  model: "anthropic:claude-haiku",
  timeoutMs: 60_000,
  source: "default",
})));

vi.mock("@comis/agent", () => ({
  resolveOperationModel: mockResolveOperationModel,
  resolveProviderFamily: vi.fn(() => "anthropic"),
  runMemoryConsolidation: mockRunMemoryConsolidation,
  runMemoryReasoning: mockRunMemoryReasoning,
  createReasoningSeam: mockCreateReasoningSeam,
}));

import { handleMemoryCronSentinel, type MemoryCronContext } from "./setup-channels-memory-crons.js";

function makeCtx(overrides: {
  agents?: Record<string, any>;
  apiKey?: string | undefined;
} = {}): MemoryCronContext {
  const logger = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => logger),
  };
  const container = {
    config: { tenantId: "tenant-a", agents: overrides.agents ?? {}, providers: { entries: {} } },
    eventBus: { emit: vi.fn(), on: vi.fn() },
    secretManager: { get: vi.fn(() => (overrides.apiKey === undefined ? undefined : overrides.apiKey)) },
  };
  return {
    container: container as any,
    logger: logger as any,
    clock: { now: () => 1_000, nowDate: () => new Date(1_000) } as any,
    agents: overrides.agents ?? {},
    tenantId: "tenant-a",
    consolidationStore: { listConsolidationCandidates: vi.fn() } as any,
    tripleStore: { upsertTriple: vi.fn(), currentTruth: vi.fn() } as any,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunMemoryConsolidation.mockResolvedValue({ ok: true as const, value: undefined });
  mockRunMemoryReasoning.mockResolvedValue({ ok: true as const, value: undefined });
  mockCreateReasoningSeam.mockReturnValue(mockReasonSeam);
});

describe("handleMemoryCronSentinel", () => {
  it("returns false for a non-memory-cron sentinel (falls through to the delivery path)", async () => {
    const ctx = makeCtx();
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__SOMETHING_ELSE__", { result: "__SOMETHING_ELSE__", agentId: "a", onComplete }, ctx);
    expect(handled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("short-circuits reasoning ok and runs nothing when the agent has it disabled (opt-in gate)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": { name: "Agent 1" } } });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__MEMORY_REASONING__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    expect(mockCreateReasoningSeam).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("runs runMemoryReasoning with BOTH stores + the built seam when reasoning is enabled", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryReasoning: { enabled: true } } },
      apiKey: "test-key",
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__MEMORY_REASONING__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunMemoryReasoning).toHaveBeenCalledOnce();
    const arg = mockRunMemoryReasoning.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.consolidationStore).toBe(ctx.consolidationStore);
    expect(arg.tripleStore).toBe(ctx.tripleStore);
    expect(arg.reason).toBe(mockReasonSeam);
    expect(mockCreateReasoningSeam).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("skips reasoning with an error when an enabled agent has no API key (no key value used)", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryReasoning: { enabled: true } } },
      apiKey: undefined,
    });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_REASONING__", { agentId: "agent-1", onComplete }, ctx);
    expect(mockCreateReasoningSeam).not.toHaveBeenCalled();
    expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No API key for anthropic" });
  });

  it("still handles the consolidation sentinel (the extraction preserved both branches)", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryConsolidation: { enabled: true } } },
      apiKey: "test-key",
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__MEMORY_CONSOLIDATION__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunMemoryConsolidation).toHaveBeenCalledOnce();
    const arg = mockRunMemoryConsolidation.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.consolidationStore).toBe(ctx.consolidationStore);
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("warns + errors when a memory-cron sentinel fires without an agentId", async () => {
    const ctx = makeCtx();
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_REASONING__", { agentId: undefined, onComplete }, ctx);
    expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for memory reasoning" });
  });
});
