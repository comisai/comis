// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for {@link buildBenchmarkReport} (BENCH-04) -- the
 * reproducible benchmark report builder, and its LOAD-BEARING security
 * property: it structurally omits all secrets.
 *
 * UNGATED, default-CI: pure deterministic object construction (the only import
 * with behavior is `systemDateFrom`, which takes an injected `nowMs`); imports
 * `qa-report.ts` so it is never a 0%-coverage file under the agent all:true
 * floor.
 *
 * THE SECURITY GATE (Pitfall 6 / T-89-02-03, ASVS V7): the report is written via
 * writeRegularFile (NOT Pino), so Pino's credential redaction does NOT apply.
 * The builder MUST structurally select only `{ provider, modelId }` per model
 * role and NEVER spread the config -- so `JSON.stringify(report)` can contain no
 * `apiKey` / `sk-` / `Bearer` / `base_url` substring even when the input config
 * carries an apiKey. Test 3 below is that RED gate.
 *
 * ARCHITECTURE: imports the in-package pure modules + `@comis/core` types only --
 * no @comis/memory.
 */

import { describe, it, expect } from "vitest";
import { buildBenchmarkReport, type BenchmarkReport } from "./qa-report.js";
import { aggregateAccuracy } from "./qa-accuracy.js";

const NOW_MS = Date.UTC(2026, 4, 31, 12, 0, 0); // deterministic injected clock

/** A representative metrics object (the corrected aggregator output). */
function sampleMetrics(): ReturnType<typeof aggregateAccuracy> {
  return aggregateAccuracy([
    { category: "single-session-user", correct: true, invalid: false },
    { category: "single-session-user", correct: false, invalid: true },
    { category: "multi-session", correct: true, invalid: false },
  ]);
}

/** A clean config (no secrets) carrying only the comparability anchors. */
function cleanConfig() {
  return {
    benchmark: "longmemeval" as const,
    models: {
      extraction: { provider: "openai", modelId: "gpt-4o-mini" },
      answer: { provider: "openai", modelId: "gpt-4o" },
      judge: { provider: "anthropic", modelId: "claude-sonnet" },
      embedding: { provider: "local" as const, modelUri: "llama:bge-small" },
      reranker: { provider: "local" as const, modelUri: "llama:bge-reranker" },
    },
    dataset: { name: "longmemeval-s", itemCount: 3, source: "vendored-fixture" as const, sha256: "abc123" },
    defaults: {
      maxResults: 10,
      includeTrustLevels: ["learned", "asserted"],
      rerankEnabled: true,
      scoringAlphas: { recency: 0.25, temporal: 0.25, proof: 0.25, trust: 0.25 },
    },
    harnessVersion: "phase-89-v1",
  };
}

describe("buildBenchmarkReport -- BENCH-04 reproducibility object", () => {
  it("Test 1: carries ALL required reproducibility fields", () => {
    const report = buildBenchmarkReport(cleanConfig(), sampleMetrics(), NOW_MS);
    expect(report.benchmark).toBe("longmemeval");
    expect(typeof report.timestamp).toBe("string");
    // models block: all five roles present
    expect(report.models.extraction).toBeDefined();
    expect(report.models.answer).toBeDefined();
    expect(report.models.judge).toBeDefined();
    expect(report.models.embedding).toBeDefined();
    expect(report.models.reranker).toBeDefined();
    // dataset block
    expect(report.dataset.name).toBe("longmemeval-s");
    expect(report.dataset.itemCount).toBe(3);
    expect(report.dataset.source).toBe("vendored-fixture");
    // defaults block
    expect(report.defaults.maxResults).toBe(10);
    expect(report.defaults.includeTrustLevels).toEqual(["learned", "asserted"]);
    expect(report.defaults.rerankEnabled).toBe(true);
    expect(report.defaults.scoringAlphas).toEqual({ recency: 0.25, temporal: 0.25, proof: 0.25, trust: 0.25 });
    // results block + harnessVersion
    expect(report.results.overall).toBeDefined();
    expect(report.harnessVersion).toBe("phase-89-v1");
  });

  it("Test 2 (BENCH-04): each models.* role records { provider, modelId } -- the comparability anchor", () => {
    const report = buildBenchmarkReport(cleanConfig(), sampleMetrics(), NOW_MS);
    expect(report.models.extraction).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
    expect(report.models.answer).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(report.models.judge).toEqual({ provider: "anthropic", modelId: "claude-sonnet" });
    expect(report.models.embedding.provider).toBe("local");
    expect(report.models.reranker.provider).toBe("local");
  });

  it("Test 3 (THE SECURITY GATE, Pitfall 6): JSON.stringify(report) contains NO secret substrings even with a secret-bearing config", () => {
    // A config whose model roles ALSO carry apiKey + base_url (as the live operator
    // config does) -- the builder must structurally drop them.
    const configWithSecrets = {
      ...cleanConfig(),
      models: {
        extraction: { provider: "openai", modelId: "gpt-4o-mini", apiKey: "sk-secret-extract-key", base_url: "https://api.example.com" },
        answer: { provider: "openai", modelId: "gpt-4o", apiKey: "sk-secret-answer-key", base_url: "https://api.example.com" },
        judge: { provider: "anthropic", modelId: "claude-sonnet", apiKey: "Bearer-secret-judge-token", base_url: "https://api.anthropic.com" },
        embedding: { provider: "local" as const, modelUri: "llama:bge-small", apiKey: "sk-embed" },
        reranker: { provider: "local" as const, modelUri: "llama:bge-reranker", apiKey: "sk-rerank" },
      },
    };
    const report = buildBenchmarkReport(configWithSecrets, sampleMetrics(), NOW_MS);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("base_url");
    // The non-secret anchors ARE still present (proves we kept the right fields).
    expect(serialized).toContain("gpt-4o-mini");
    expect(serialized).toContain("claude-sonnet");
  });

  it("Test 4: timestamp is an ISO string derived from the injected clock (deterministic); results mirror aggregateAccuracy", () => {
    const metrics = sampleMetrics();
    const report = buildBenchmarkReport(cleanConfig(), metrics, NOW_MS);
    // deterministic: same nowMs -> same timestamp.
    expect(report.timestamp).toBe(new Date(NOW_MS).toISOString());
    expect(buildBenchmarkReport(cleanConfig(), metrics, NOW_MS).timestamp).toBe(report.timestamp);
    // results block mirrors the corrected aggregator output (invalid + validTotal carried).
    expect(report.results.overall).toBe(metrics.overall);
    expect(report.results.correct).toBe(metrics.correct);
    expect(report.results.total).toBe(metrics.total);
    expect(report.results.invalid).toBe(metrics.invalid);
    expect(report.results.validTotal).toBe(metrics.validTotal);
    expect(report.results.perCategory).toEqual(metrics.perCategory);
  });

  it("records a disabled local role (provider 'none', no modelUri) without inventing a URI", () => {
    const cfg = cleanConfig();
    const cfgNoLocal = {
      ...cfg,
      models: {
        ...cfg.models,
        embedding: { provider: "none" as const },
        reranker: { provider: "none" as const },
      },
    };
    const report = buildBenchmarkReport(cfgNoLocal, sampleMetrics(), NOW_MS);
    expect(report.models.embedding).toEqual({ provider: "none" });
    expect(report.models.reranker).toEqual({ provider: "none" });
    expect(report.models.embedding.modelUri).toBeUndefined();
  });

  it("omits a dataset.sha256 cleanly when not provided (optional reproducibility field)", () => {
    const cfg = cleanConfig();
    const cfgNoHash = { ...cfg, dataset: { name: cfg.dataset.name, itemCount: cfg.dataset.itemCount, source: cfg.dataset.source } };
    const report: BenchmarkReport = buildBenchmarkReport(cfgNoHash, sampleMetrics(), NOW_MS);
    expect(report.dataset.sha256).toBeUndefined();
    expect(report.dataset.name).toBe("longmemeval-s");
  });
});
