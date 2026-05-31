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

  it("Test 3b (THE SECURITY GATE, WR-01): a credential-bearing local modelUri is sanitized -- no userinfo / auth query param reaches JSON.stringify(report)", () => {
    // modelUri is a free-form z.string() (HF URI or local path). An authenticated
    // weights endpoint can embed a credential in BOTH userinfo (`user:token@`) AND
    // an auth-bearing query param (`?token=...`). Both must be stripped structurally,
    // exactly as apiKey/Bearer/base_url already are -- the report is written via
    // writeRegularFile, OUTSIDE Pino's redaction net.
    const configWithUriSecret = {
      ...cleanConfig(),
      models: {
        ...cleanConfig().models,
        embedding: { provider: "local" as const, modelUri: "https://user:sk-uri-secret@host/bge?token=tok-embed-secret" },
        reranker: { provider: "local" as const, modelUri: "https://svc:hf_rerankerpw@host/rerank?access_token=tok-rr-secret&api_key=key-rr" },
      },
    };
    const report = buildBenchmarkReport(configWithUriSecret, sampleMetrics(), NOW_MS);
    const serialized = JSON.stringify(report);
    // Neither the userinfo credential nor the auth query-param value survives.
    expect(serialized).not.toContain("sk-uri-secret");
    expect(serialized).not.toContain("hf_rerankerpw");
    expect(serialized).not.toContain("tok-embed-secret");
    expect(serialized).not.toContain("tok-rr-secret");
    expect(serialized).not.toContain("key-rr");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("api_key");
    // The non-secret identity anchor (scheme + host + path) IS retained for reproducibility.
    expect(report.models.embedding.modelUri).toContain("host/bge");
    expect(report.models.embedding.modelUri).toMatch(/^https:\/\//);
    expect(serialized).not.toContain("user:sk");
    expect(serialized).not.toContain("svc:hf");
  });

  it("Test 3c (WR-01): a plain local path / authority-less scheme modelUri is preserved verbatim (it carries no credential)", () => {
    const cfg = cleanConfig();
    const cfgPaths = {
      ...cfg,
      models: {
        ...cfg.models,
        embedding: { provider: "local" as const, modelUri: "/home/op/models/bge-small.gguf" },
        reranker: { provider: "local" as const, modelUri: "hf:BAAI/bge-reranker-base" },
      },
    };
    const report = buildBenchmarkReport(cfgPaths, sampleMetrics(), NOW_MS);
    expect(report.models.embedding.modelUri).toBe("/home/op/models/bge-small.gguf");
    expect(report.models.reranker.modelUri).toBe("hf:BAAI/bge-reranker-base");
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

  // ─────────────────────────────────────────────────────────────────────────
  // BASE-01 (v2.8 Phase 98): the manifest must also carry tokens/query (cost) +
  // latency (p50/p95). RED-first — these assert fields the pre-patch builder does
  // not yet produce. Mirrors the dataset.sha256 optional-field pattern above:
  // additive, byte-identity when omitted, and structurally secret-free (pure
  // numbers) so the Test-3/3b security gate still holds with them populated.
  // ─────────────────────────────────────────────────────────────────────────

  /** A representative cost block (tokens/query, answer + judge). */
  function sampleCost() {
    return {
      answerTokensPerQuery: 812.5,
      judgeTokensPerQuery: 143,
      totalTokensPerQuery: 955.5,
      answerCostUsd: 0.0123,
      judgeCostUsd: 0.0009,
    };
  }

  /** A representative latency block (recall/answer/judge/end-to-end, p50/p95). */
  function sampleLatency() {
    return {
      recallP50Ms: 12.3,
      recallP95Ms: 48.1,
      answerP50Ms: 1840,
      answerP95Ms: 5210,
      judgeP50Ms: 420,
      judgeP95Ms: 980,
      endToEndP50Ms: 2272.3,
      endToEndP95Ms: 6238.1,
    };
  }

  it("Test 5 (BASE-01): records cost.tokensPerQuery (answer + judge) as numbers when the config carries a cost block", () => {
    const cfg = { ...cleanConfig(), cost: sampleCost() };
    const report = buildBenchmarkReport(cfg, sampleMetrics(), NOW_MS);
    expect(report.cost).toBeDefined();
    expect(typeof report.cost?.answerTokensPerQuery).toBe("number");
    expect(typeof report.cost?.judgeTokensPerQuery).toBe("number");
    expect(report.cost?.answerTokensPerQuery).toBe(812.5);
    expect(report.cost?.judgeTokensPerQuery).toBe(143);
    expect(report.cost?.totalTokensPerQuery).toBe(955.5);
    expect(report.cost?.answerCostUsd).toBe(0.0123);
    expect(report.cost?.judgeCostUsd).toBe(0.0009);
  });

  it("Test 6 (BASE-01): records latency p50/p95 (recall/answer/judge/end-to-end) as numbers when the config carries a latency block", () => {
    const cfg = { ...cleanConfig(), latency: sampleLatency() };
    const report = buildBenchmarkReport(cfg, sampleMetrics(), NOW_MS);
    expect(report.latency).toBeDefined();
    expect(typeof report.latency?.recallP50Ms).toBe("number");
    expect(typeof report.latency?.endToEndP50Ms).toBe("number");
    expect(report.latency?.recallP50Ms).toBe(12.3);
    expect(report.latency?.recallP95Ms).toBe(48.1);
    expect(report.latency?.answerP50Ms).toBe(1840);
    expect(report.latency?.answerP95Ms).toBe(5210);
    expect(report.latency?.judgeP50Ms).toBe(420);
    expect(report.latency?.judgeP95Ms).toBe(980);
    expect(report.latency?.endToEndP50Ms).toBe(2272.3);
    expect(report.latency?.endToEndP95Ms).toBe(6238.1);
  });

  it("Test 7 (BASE-01): omits cost AND latency cleanly when absent from the config (byte-identity for an unmeasured run)", () => {
    const report: BenchmarkReport = buildBenchmarkReport(cleanConfig(), sampleMetrics(), NOW_MS);
    expect(report.cost).toBeUndefined();
    expect(report.latency).toBeUndefined();
    // The serialized manifest carries no `cost`/`latency` keys at all when unmeasured.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("\"cost\"");
    expect(serialized).not.toContain("\"latency\"");
  });

  it("Test 8 (THE SECURITY GATE, BASE-01): the secret-omission gate still holds with cost + latency populated alongside a secret-bearing config", () => {
    // Even with the new numeric fields populated, a secret-bearing model config must
    // NOT leak into JSON.stringify(report). cost/latency are pure numbers — structurally
    // secret-free — so they cannot reopen the Test-3/3b hole.
    const cfg = {
      ...cleanConfig(),
      models: {
        extraction: { provider: "openai", modelId: "gpt-4o-mini", apiKey: "sk-secret-extract-key" },
        answer: { provider: "openai", modelId: "gpt-4o", apiKey: "sk-secret-answer-key", base_url: "https://api.example.com" },
        judge: { provider: "anthropic", modelId: "claude-sonnet", apiKey: "Bearer-secret-judge-token" },
        embedding: { provider: "local" as const, modelUri: "https://user:sk-uri-secret@host/bge?token=tok-embed-secret" },
        reranker: { provider: "local" as const, modelUri: "llama:bge-reranker" },
      },
      cost: sampleCost(),
      latency: sampleLatency(),
    };
    const report = buildBenchmarkReport(cfg, sampleMetrics(), NOW_MS);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/apiKey|sk-|Bearer/);
    expect(serialized).not.toContain("base_url");
    expect(serialized).not.toContain("tok-embed-secret");
    expect(serialized).not.toContain("token=");
    // The new numeric fields ARE present (proves they were recorded, not dropped).
    expect(report.cost?.answerTokensPerQuery).toBe(812.5);
    expect(report.latency?.endToEndP50Ms).toBe(2272.3);
  });
});
