// SPDX-License-Identifier: Apache-2.0
/**
 * Reproducible benchmark report builder -- assembles the run config +
 * accuracy results into the single JSON object the gated harness writes to disk,
 * so a Comis benchmark number is comparable across changes and against
 * Hindsight's published figures.
 *
 * BUILD-THEN-WRITE split (analog graph-completion.ts:585-607): this module builds
 * the report object PURELY (no I/O, fully unit-testable); the writeRegularFile
 * call lives in the gated `.bench.test.ts`. The dataset sha256 is computed in the
 * harness (where the dataset bytes are read) and passed in as `dataset.sha256` --
 * this module just records the string.
 *
 * SECURITY -- structural secret omission (ASVS V7): the
 * report is persisted via writeRegularFile, OUTSIDE Pino's redaction safety-net,
 * so the builder itself must guarantee no credential ever reaches the file. It
 * does so STRUCTURALLY: each model role is rebuilt as a fresh `{ provider,
 * modelId }` (or `{ provider, modelUri? }` for the local embed/rerank roles) --
 * the input config object is NEVER spread, and no credential / base-url field is
 * ever copied. The one field that is itself free-form (`modelUri`, a HF URI or
 * local path) is additionally run through `sanitizeModelUri`, which strips any
 * URL userinfo + query/fragment so an authenticated-weights endpoint
 * (`https://user:token@host/...?token=...`) cannot smuggle a credential through.
 * Even when the operator config carries a per-role secret, it cannot appear in
 * `JSON.stringify(report)` because there is no path from the input secret to the
 * output object. (The unit gate asserts the serialized report contains none
 * of the known secret substrings -- apiKey/Bearer/base_url AND a credential-bearing
 * modelUri -- with a secret-bearing config.)
 *
 * GLOBALS: `timestamp` is `systemDateFrom(nowMs).toISOString()` with `nowMs`
 * INJECTED by the caller -- never a wall-clock read (no raw Date constructor or
 * wall-clock now() call in src; the sanctioned `systemDateFrom` indirection only,
 * exactly graph-completion.ts:588).
 *
 * ARCHITECTURE CUT (architecture-graph.test.ts:133): a PURE module; the agent
 * package may not import the memory package. Imports are limited to
 * `systemDateFrom` from `@comis/core` and the `AccuracyResult` TYPE from the
 * in-package `qa-accuracy.ts`.
 *
 * @module
 */

import { systemDateFrom } from "@comis/core";
import type { AccuracyResult } from "./qa-accuracy.js";

/** A model role recorded by identity only -- provider + modelId, NEVER a secret. */
export interface ModelIdentity {
  /** The provider key (e.g. "openai", "anthropic"). */
  provider: string;
  /** The model id (e.g. "gpt-4o"). The comparability anchor. */
  modelId: string;
}

/** A local-weight role (embedding / reranker) recorded by provider + optional model URI. */
export interface LocalModelIdentity {
  /** "local" when a GGUF weight is loaded, "none" when the role is disabled. */
  provider: "local" | "none";
  /** The model weight URI/path (identity only; no secret). */
  modelUri?: string;
}

/** Scoring-fusion alpha weights recorded for reproducibility. */
export interface ScoringAlphas {
  recency: number;
  temporal: number;
  proof: number;
  trust: number;
}

/**
 * Cost block: mean tokens/query for the answer + judge
 * roles, plus the combined total and (optionally) the provider-reported USD cost.
 *
 * SECURITY: pure numbers only — no model identity, no key. Recorded by copying
 * field-by-field (never spreading the input config), so this block cannot smuggle
 * a credential into the persisted manifest (Test 8 in qa-report.test.ts re-asserts
 * the secret-omission gate with this block populated).
 */
export interface BenchmarkCost {
  /** Mean answer-LLM tokens per question (across the valid questions). */
  answerTokensPerQuery: number;
  /** Mean judge-LLM tokens per question (across the valid questions). */
  judgeTokensPerQuery: number;
  /** Mean total (answer + judge) tokens per question. */
  totalTokensPerQuery: number;
  /** Summed answer-LLM USD cost across the run (optional; provider-reported). */
  answerCostUsd?: number;
  /** Summed judge-LLM USD cost across the run (optional; provider-reported). */
  judgeCostUsd?: number;
}

/**
 * Latency block: p50/p95 wall-clock latency (ms) for the
 * recall, answer, and judge segments, plus the end-to-end (recall+answer+judge)
 * per-question total. Captured in the harness via real `performance.now()` deltas
 * (NOT the injected fake clock — that exists to neutralize recency scoring and
 * would read constant).
 *
 * SECURITY: pure numbers only — same structural no-secret guarantee as
 * {@link BenchmarkCost}.
 */
export interface BenchmarkLatency {
  recallP50Ms: number;
  recallP95Ms: number;
  answerP50Ms: number;
  answerP95Ms: number;
  judgeP50Ms: number;
  judgeP95Ms: number;
  endToEndP50Ms: number;
  endToEndP95Ms: number;
}

/**
 * Control row: a Letta-style filesystem-baseline
 * reference — the SAME questions answered from the FULL haystack ("filesystem
 * dump", no recall ranking) by the SAME answer+judge models, recorded under an
 * explicit `label` so it can NEVER be mistaken for Comis's own score (the headline
 * `results` stays the recall accuracy). Its purpose is a sanity control: if a
 * full-dump baseline ties/beats Comis's ranked recall, the *benchmark* is weak
 * (Letta's filesystem agent scored 74.0% on LoCoMo, above Mem0's self-reported 68.5%).
 *
 * SECURITY: `label` is a fixed identifier string and `results` is a pure
 * {@link AccuracyResult} (numbers) — structurally secret-free, like
 * {@link BenchmarkCost}/{@link BenchmarkLatency}. The existing secret-omission gate
 * (Test 3/3b/8/12 in qa-report.test.ts) still holds with this block populated.
 */
export interface BenchmarkControl {
  /** The control label (e.g. "filesystem-baseline-full-context-control") — never Comis's score. */
  label: string;
  /** The control's accuracy (the same AccuracyResult shape as the headline `results`). */
  results: AccuracyResult;
}

/**
 * The reproducibility object. Records WHAT built/answered/judged
 * (model identities), the dataset, the recall defaults, and the accuracy results
 * (carrying `invalid` + `validTotal` for the invalid-excluded denominator) -- with no
 * secret anywhere.
 */
export interface BenchmarkReport {
  /** Which dataset(s) the run covered. */
  benchmark: "longmemeval" | "locomo" | "combined";
  /** ISO timestamp derived from the injected `nowMs`. */
  timestamp: string;
  /** The model roles, each recorded by identity only (no secret). */
  models: {
    extraction: ModelIdentity;
    answer: ModelIdentity;
    judge: ModelIdentity;
    embedding: LocalModelIdentity;
    reranker: LocalModelIdentity;
  };
  /** The dataset descriptor + optional content hash. */
  dataset: {
    name: string;
    itemCount: number;
    source: "vendored-fixture" | "operator";
    /** sha256 of the dataset bytes (computed in the harness; identity only). */
    sha256?: string;
  };
  /** The recall/scoring defaults the run used. */
  defaults: {
    maxResults: number;
    includeTrustLevels: string[];
    rerankEnabled: boolean;
    scoringAlphas: ScoringAlphas;
  };
  /** The accuracy results (overall + per-category, with the invalid-excluded denominator fields). */
  results: AccuracyResult;
  /** The harness version tag -- a fixed stamp identifying the harness code that produced the run. */
  harnessVersion: string;
  /**
   * Tokens/query (answer + judge). Present only when the run measured it;
   * omitted byte-identically otherwise (mirrors `dataset.sha256`).
   */
  cost?: BenchmarkCost;
  /**
   * Wall-clock latency (recall/answer/judge/end-to-end, p50/p95). Present
   * only when the run measured it; omitted byte-identically otherwise.
   */
  latency?: BenchmarkLatency;
  /**
   * Letta-style filesystem-baseline CONTROL row. Present only when the run
   * computed the control (full-haystack reference); omitted byte-identically
   * otherwise. NEVER Comis's own score — the headline `results` is the recall
   * accuracy.
   */
  control?: BenchmarkControl;
}

/**
 * The input config the harness assembles. Model roles MAY carry extra fields
 * (a credential, a base url); this builder reads ONLY `{ provider, modelId }`
 * (or `{ provider, modelUri }`) and never the rest -- so excess secret-bearing
 * fields on the input are structurally dropped.
 */
export interface BenchmarkReportConfig {
  benchmark: BenchmarkReport["benchmark"];
  models: {
    extraction: { provider: string; modelId: string };
    answer: { provider: string; modelId: string };
    judge: { provider: string; modelId: string };
    embedding: { provider: "local" | "none"; modelUri?: string };
    reranker: { provider: "local" | "none"; modelUri?: string };
  };
  dataset: BenchmarkReport["dataset"];
  defaults: BenchmarkReport["defaults"];
  harnessVersion: string;
  /** Tokens/query block (optional — present only when measured). */
  cost?: BenchmarkCost;
  /** Latency block (optional — present only when measured). */
  latency?: BenchmarkLatency;
  /** Letta-style filesystem-baseline control row (optional — present only when computed). */
  control?: BenchmarkControl;
}

/** Rebuild a model role as a fresh identity-only record (drops any extra fields). */
function pickIdentity(role: { provider: string; modelId: string }): ModelIdentity {
  return { provider: role.provider, modelId: role.modelId };
}

/**
 * Strip any embedded credential from a model URI, keeping only the non-secret
 * identity anchor (scheme + host + path) for reproducibility (ASVS V7).
 *
 * `modelUri` is a free-form `z.string()` (schema-embedding.ts:14) -- a HuggingFace
 * URI or a local GGUF path. An authenticated weights endpoint can carry a secret in
 * BOTH the URL userinfo (`https://user:token@host/...`) AND a query param
 * (`?token=...`, `?access_token=...`, `?api_key=...`). Without this, the secret
 * flows verbatim into `JSON.stringify(report)` -- which is persisted via
 * writeRegularFile, OUTSIDE Pino's redaction net -- defeating the module's
 * structural no-secret guarantee.
 *
 * Strategy: only an AUTHORITY-bearing URL (`scheme://`) can hold userinfo/query
 * credentials, so an authority-less scheme (`hf:org/model`) or a plain filesystem
 * path (`/models/x.gguf`) is returned VERBATIM (it carries no credential, and is the
 * exact reproducibility anchor). For an authority URL we drop userinfo AND the whole
 * query+fragment (a query param can hold a secret under any name, so dropping the
 * lot is the only structural no-leak choice), keeping scheme+host+path. The guard
 * regex is anchored with non-nested quantifiers (ReDoS-free, the loaders' convention).
 */
function sanitizeModelUri(uri: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return uri; // no authority -> no embedded credential
  try {
    const u = new URL(uri);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    // Unparseable authority URL: fall back to a userinfo strip so a `user:pass@`
    // credential still cannot survive (no worse than the input for anything else).
    return uri.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}

/** Rebuild a local-weight role as provider + sanitized URI (drops any extra fields + credential). */
function pickLocalIdentity(role: { provider: "local" | "none"; modelUri?: string }): LocalModelIdentity {
  return role.modelUri === undefined
    ? { provider: role.provider }
    : { provider: role.provider, modelUri: sanitizeModelUri(role.modelUri) };
}

/** Rebuild the dataset descriptor, carrying sha256 only when present. */
function pickDataset(d: BenchmarkReport["dataset"]): BenchmarkReport["dataset"] {
  const base = { name: d.name, itemCount: d.itemCount, source: d.source };
  return d.sha256 === undefined ? base : { ...base, sha256: d.sha256 };
}

/**
 * Rebuild the cost block field-by-field (never spreads the input config), keeping
 * the optional USD fields only when present. Pure numbers in -> pure numbers out;
 * no path from a config secret to the output (module no-secret doctrine).
 */
function pickCost(c: BenchmarkCost): BenchmarkCost {
  const base: BenchmarkCost = {
    answerTokensPerQuery: c.answerTokensPerQuery,
    judgeTokensPerQuery: c.judgeTokensPerQuery,
    totalTokensPerQuery: c.totalTokensPerQuery,
  };
  if (c.answerCostUsd !== undefined) base.answerCostUsd = c.answerCostUsd;
  if (c.judgeCostUsd !== undefined) base.judgeCostUsd = c.judgeCostUsd;
  return base;
}

/** Rebuild the latency block field-by-field (never spreads the input config). */
function pickLatency(l: BenchmarkLatency): BenchmarkLatency {
  return {
    recallP50Ms: l.recallP50Ms,
    recallP95Ms: l.recallP95Ms,
    answerP50Ms: l.answerP50Ms,
    answerP95Ms: l.answerP95Ms,
    judgeP50Ms: l.judgeP50Ms,
    judgeP95Ms: l.judgeP95Ms,
    endToEndP50Ms: l.endToEndP50Ms,
    endToEndP95Ms: l.endToEndP95Ms,
  };
}

/**
 * Rebuild the control row structurally (never spreads the input config): a fresh
 * `{ label, results }` carrying the explicit label string + the pure
 * {@link AccuracyResult}. Both are secret-free (a fixed identifier + numbers), so
 * this block cannot smuggle a credential into the persisted manifest (Test 12
 * re-asserts the secret-omission gate with it populated).
 */
function pickControl(c: BenchmarkControl): BenchmarkControl {
  return { label: c.label, results: c.results };
}

/**
 * Build the reproducible {@link BenchmarkReport} from the run config, the
 * accuracy metrics, and an injected `nowMs`.
 *
 * SECURITY: structurally selects only `{ provider, modelId }` / `{ provider,
 * modelUri }` per model role -- the input `config` is never spread, so no
 * credential or base-url field on `config.models.*` can reach the output (and
 * thus the persisted file); the free-form `modelUri` is additionally sanitized
 * (userinfo + query/fragment stripped). The timestamp uses the injected clock.
 */
export function buildBenchmarkReport(
  config: BenchmarkReportConfig,
  metrics: AccuracyResult,
  nowMs: number,
): BenchmarkReport {
  return {
    benchmark: config.benchmark,
    timestamp: systemDateFrom(nowMs).toISOString(),
    models: {
      extraction: pickIdentity(config.models.extraction),
      answer: pickIdentity(config.models.answer),
      judge: pickIdentity(config.models.judge),
      embedding: pickLocalIdentity(config.models.embedding),
      reranker: pickLocalIdentity(config.models.reranker),
    },
    dataset: pickDataset(config.dataset),
    defaults: {
      maxResults: config.defaults.maxResults,
      includeTrustLevels: [...config.defaults.includeTrustLevels],
      rerankEnabled: config.defaults.rerankEnabled,
      scoringAlphas: { ...config.defaults.scoringAlphas },
    },
    results: metrics,
    harnessVersion: config.harnessVersion,
    // cost/latency: appended STRUCTURALLY (mirror pickDataset) -- the key
    // exists only when the run measured it, so an unmeasured run is byte-identical
    // to the cost/latency-free report. Copied field-by-field (pickCost/pickLatency),
    // never spreading the config, consistent with the module no-secret doctrine.
    ...(config.cost !== undefined ? { cost: pickCost(config.cost) } : {}),
    ...(config.latency !== undefined ? { latency: pickLatency(config.latency) } : {}),
    // control row: appended STRUCTURALLY (same as cost/latency) -- the key
    // exists only when the run computed the Letta-style filesystem-baseline control,
    // so a run without it is byte-identical. Recorded under an explicit label so it
    // can NEVER be mistaken for Comis's score (the headline `results` above stays the
    // recall accuracy); secret-free (label + pure AccuracyResult).
    ...(config.control !== undefined ? { control: pickControl(config.control) } : {}),
  };
}
