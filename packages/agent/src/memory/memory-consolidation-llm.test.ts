// SPDX-License-Identifier: Apache-2.0
//
// Unit suite for the consolidation LLM seam (split out of the job for the
// 800-line cap). The LLM is MOCKED (pi-ai completeSimple/getModel) for
// determinism — these tests pin the SHARED completion scaffold's failure
// branches (model-resolve throw / model-null / LLM throw) and the two public
// calls: mergeCluster (raw, UNWRAPPED) + synthesizeGeneralization (the SEC-01
// wrapExternalContent boundary + the lenient parse → undefined-on-bad-output).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryConsolidationConfig, MemoryEntry } from "@comis/core";

// Mock pi-ai — canned response, configured per-test.
vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(),
}));

import {
  mergeCluster,
  synthesizeGeneralization,
  buildClusterPrompt,
  extractResponseText,
  MAX_MEMORY_CHARS,
  type LlmClusterDeps,
} from "./memory-consolidation-llm.js";
import { completeSimple, getModel } from "@earendil-works/pi-ai";

const NOW = 1_700_000_000_000;

/** Wrap canned text in the pi-ai completeSimple response envelope. */
function llmText(text: string) {
  return { content: [{ type: "text", text }] };
}

let uuidCounter = 0;
function nextId(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? nextId(),
    tenantId: "default",
    agentId: "test-agent",
    userId: "system",
    content: overrides.content ?? "a fact",
    trustLevel: overrides.trustLevel ?? "learned",
    source: { who: "system", channel: "test" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? NOW,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<MemoryConsolidationConfig> = {}): MemoryConsolidationConfig {
  return {
    enabled: true,
    schedule: "30 3 * * *",
    similarityThreshold: 0.82,
    dedupThreshold: 0.9,
    maxCandidatesPerRun: 200,
    maxClusterSize: 12,
    maxClustersPerRun: 25,
    maxConsolidationTokens: 1024,
    consolidateExternal: false,
    autoTags: [],
    generalize: { enabled: false, minDistinctContexts: 3 },
    ...overrides,
  };
}

function makeDeps(): LlmClusterDeps {
  return {
    config: makeConfig(),
    agentId: "test-agent",
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "test-key",
    clock: { now: () => NOW, nowDate: () => new Date(NOW) },
    logger: { debug: vi.fn(), warn: vi.fn() },
  };
}

beforeEach(() => {
  uuidCounter = 0;
  vi.clearAllMocks();
  (getModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "mock-model" });
});

describe("buildClusterPrompt — bounded per-member input", () => {
  it("slices each member's content to the per-member cap (the input DoS guard)", () => {
    const huge = "x".repeat(10_000);
    const prompt = buildClusterPrompt([makeEntry({ content: huge })]);
    const longestRun = prompt.match(/x+/g)?.reduce((m, s) => Math.max(m, s.length), 0) ?? 0;
    expect(longestRun).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
    expect(prompt).not.toContain(huge);
  });

  it("preserves a short member's content verbatim", () => {
    const prompt = buildClusterPrompt([makeEntry({ content: "the sky is blue" })]);
    expect(prompt).toContain("the sky is blue");
  });
});

describe("extractResponseText — total, guarded part extraction", () => {
  it("concatenates text parts and ignores non-text/malformed parts", () => {
    const text = extractResponseText({
      content: [
        { type: "text", text: "hello " },
        { type: "image", url: "x" } as unknown as { type: string },
        { type: "text", text: "world" },
        null as unknown as object,
      ],
    });
    expect(text).toBe("hello world");
  });

  it("returns an empty string when there is no content array", () => {
    expect(extractResponseText({})).toBe("");
  });
});

describe("mergeCluster — the MERGE call (raw, UNWRAPPED input)", () => {
  it("returns the raw response text on success and does NOT wrap the cluster prompt", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(llmText('{"content":"merged"}'));
    const text = await mergeCluster(makeDeps(), [makeEntry({ content: "fact one" })]);
    expect(text).toBe('{"content":"merged"}');
    // The merge input is intentionally NOT wrapped (out of this phase's scope).
    const userContent = (completeSimple as ReturnType<typeof vi.fn>).mock.calls[0][1].messages[0].content;
    expect(userContent).not.toContain("<<<UNTRUSTED_");
    expect(userContent).toContain("fact one");
  });

  it("returns undefined (non-fatal) when getModel throws", async () => {
    (getModel as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("provider exploded");
    });
    const deps = makeDeps();
    const text = await mergeCluster(deps, [makeEntry()]);
    expect(text).toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("returns undefined (non-fatal) when getModel resolves to null", async () => {
    (getModel as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const deps = makeDeps();
    const text = await mergeCluster(deps, [makeEntry()]);
    expect(text).toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("returns undefined (non-fatal) when the LLM call throws", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const deps = makeDeps();
    const text = await mergeCluster(deps, [makeEntry()]);
    expect(text).toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});

describe("synthesizeGeneralization — the GENERALIZE call (SEC-01 wrapped input)", () => {
  it("WRAPS the cluster input with wrapExternalContent BEFORE the LLM (the injection boundary)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText('{"content":"alice prefers concise answers in general","confidence":0.8}'),
    );
    const result = await synthesizeGeneralization(makeDeps(), [
      makeEntry({ content: "alice asked for short replies" }),
      makeEntry({ content: "alice wanted a brief answer" }),
    ]);
    expect(result).toEqual({ content: "alice prefers concise answers in general", confidence: 0.8 });
    // The user content must carry the wrapExternalContent delimiter sentinel.
    const userContent = (completeSimple as ReturnType<typeof vi.fn>).mock.calls[0][1].messages[0].content;
    expect(userContent).toMatch(/<<<UNTRUSTED_[a-f0-9]{24}>>>/);
    expect(userContent).toMatch(/<<<END_UNTRUSTED_[a-f0-9]{24}>>>/);
    expect(userContent).toContain("Source: Memory generalization cluster input");
  });

  it("returns undefined when the synthesized output fails to parse (non-fatal skip)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(llmText("not json {{{"));
    const result = await synthesizeGeneralization(makeDeps(), [makeEntry()]);
    expect(result).toBeUndefined();
  });

  it("returns undefined when the LLM call fails (non-fatal skip)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const deps = makeDeps();
    const result = await synthesizeGeneralization(deps, [makeEntry()]);
    expect(result).toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("defaults confidence to undefined when the model omits it (the caller applies ?? 1)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(llmText('{"content":"a general fact"}'));
    const result = await synthesizeGeneralization(makeDeps(), [makeEntry()]);
    expect(result).toEqual({ content: "a general fact", confidence: undefined });
  });
});
