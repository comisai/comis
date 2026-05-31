// SPDX-License-Identifier: Apache-2.0
/**
 * Reproducible benchmark report builder (BENCH-04) -- assembles the run config +
 * accuracy results into the single JSON object the gated harness (Plan 89-03)
 * writes to disk, so a Comis benchmark number is comparable across changes and
 * against Hindsight's published figures.
 *
 * BUILD-THEN-WRITE split (analog graph-completion.ts:585-607): this module builds
 * the report object PURELY (no I/O, fully unit-testable); the writeRegularFile
 * call lives in the gated `.bench.test.ts`. The dataset sha256 is computed in the
 * harness (where the dataset bytes are read) and passed in as `dataset.sha256` --
 * this module just records the string.
 *
 * SECURITY -- structural secret omission (Pitfall 6 / T-89-02-03, ASVS V7): the
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
 * output object. (RED gate: the unit asserts the serialized report contains none
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
 * The BENCH-04 reproducibility object. Records WHAT built/answered/judged
 * (model identities), the dataset, the recall defaults, and the accuracy results
 * (carrying `invalid` + `validTotal` per the corrected denominator) -- with no
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
  /** The accuracy results (overall + per-category, with the corrected denominator fields). */
  results: AccuracyResult;
  /** The harness version tag (e.g. "phase-89-v1"). */
  harnessVersion: string;
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
}

/** Rebuild a model role as a fresh identity-only record (drops any extra fields). */
function pickIdentity(role: { provider: string; modelId: string }): ModelIdentity {
  return { provider: role.provider, modelId: role.modelId };
}

/**
 * Strip any embedded credential from a model URI, keeping only the non-secret
 * identity anchor (scheme + host + path) for reproducibility (WR-01, ASVS V7).
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
  };
}
