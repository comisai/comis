// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated BEAM scale-probe harness (1M; 10M stretch) — the
 * long-context per-ability recall measurement engine. It GENERATES a deterministic
 * synthetic haystack AT RUN TIME via {@link generateBeamHaystack} (the haystack is
 * NEVER read from disk and NEVER committed — at ~1M / ~10M tokens it is megabytes of
 * text reproduced from the seed), ingests every generated doc into a REAL fresh
 * `SqliteMemoryAdapter`, runs the LIVE `createMemoryRecall` pipeline per planted
 * needle, and scores per-ability recall@k by REUSING the pure {@link scoreBeam}
 * (which reuses `scoreRanking`). The number it prints is the BEAM scale signal —
 * the measured footprint/recall pressure that tells whether FORGET (footprint
 * reduction at scale) is worth building.
 *
 * KEYLESS: recall@k needs no answer/judge model, so the gate is `COMIS_BENCH` ONLY
 * (no `COMIS_BENCH_ANSWER_*` / `COMIS_BENCH_JUDGE_*` lane). A default `pnpm test`
 * (no COMIS_BENCH) skips this entire suite.
 *
 * THE 1M / 10M SPLIT:
 * - The 1M `it` ALWAYS runs under COMIS_BENCH — the haystack token budget
 *   is ~1,000,000 tokens (≈4M chars ≈ ~1,250 seeded ~800-char docs + 4 planted
 *   needles). On-device embedding of that many docs is genuinely slow, so the ingest
 *   runs inside `runBeam` under the 2h `it` budget.
 * - The 10M `it` is behind `COMIS_BENCH_BEAM_10M` (a deferrable stretch tier) —
 *   it SKIPS unless that flag is set, so default CI never pays the 10M cost.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory (a devDependency) — the agent→memory cut excludes the `.test.ts`
 * suffix (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). The pure modules
 * it consumes (beam-generator.ts, beam-scorer.ts, suite-report.ts) import ONLY
 * @comis/core types. Mirrors the blessed precedent retrieval-harness.bench.test.ts.
 *
 * DUPLICATED INGEST WIRING (intentional): makeBenchConfig /
 * BENCH_SESSION_KEY / resolveReportDir are DUPLICATED from the retrieval/QA harnesses
 * rather than factored into a shared non-`.test.ts` helper — a shared helper importing
 * @comis/memory WOULD trip the cut.
 *
 * SECURITY:
 * - Bench store is a fresh `mkdtempSync` tmp DB (NEVER ~/.comis), `tenantId:"default"`
 *   / `agentId:"bench"` — isolated from any live agent. Closed per run.
 * - The report is built via buildSuiteReport (structural secret omission) and written
 *   via the confined `writeRegularFile` (O_NOFOLLOW + EXCL + confinement, outside
 *   Pino's redaction net); recall@k is KEYLESS so no secret exists, but the gated body
 *   still asserts the serialized report carries none of `/apiKey|sk-|Bearer/`.
 *   The harness `console.log`s ONLY the score object, never content.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent→memory cut excludes *.test.ts). Public-barrel
// factories mirrored VERBATIM from retrieval-harness.bench.test.ts.
import {
  SqliteMemoryAdapter,
  createEmbeddingProvider,
  createLocalRerankerProvider,
} from "@comis/memory";
// BARE production orchestrator (the live recall pipeline this harness drives).
import { createMemoryRecall, type MemoryRecallDeps } from "@comis/agent";
// RELATIVE deterministic generator + the pure per-ability scorer.
import { generateBeamHaystack, type BeamAbility, type BeamNeedle } from "./beam-generator.js";
import { scoreBeam, type BeamScore } from "./beam-scorer.js";
// RELATIVE secret-free per-tier report builder + its types.
import { buildSuiteReport, type AbilityScore } from "./suite-report.js";
import type { CategoryAccuracy } from "./qa-accuracy.js";
import type { RankingMetrics } from "../recall-eval.js";
// VALUE obs import (fine in a .test.ts) — the confined report writer.
import { writeRegularFile } from "@comis/observability";
// Determinism helpers (test/support — 5 segments up from packages/agent/src/memory/benchmark/).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type { MemoryConfig, MemorySearchResult, SessionKey } from "@comis/core";
import { MemoryConfigSchema } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ENV GATES — read process.env ONLY at the test boundary (allowed in a .test.ts; the
// globals rule scopes to src/**).
const COMIS_BENCH = process.env.COMIS_BENCH; // enables the full generate+ingest+recall+score run
const LLAMA_MODEL_PATH = process.env.LLAMA_MODEL_PATH; // optional vector lane (embeddings)
const LLAMA_RERANKER_MODEL_PATH = process.env.LLAMA_RERANKER_MODEL_PATH; // optional rerank lift
const COMIS_BENCH_DATA = process.env.COMIS_BENCH_DATA; // optional report-output base
// The 10M stretch flag (deferrable) — when set, the 10M `it` runs; else it skips.
const BEAM_10M = process.env.COMIS_BENCH_BEAM_10M;

/** Fixed epoch (matches the sibling harnesses' neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** The BEAM tier's harness version stamp (recorded in the report). */
const HARNESS_VERSION = "phase-99-v1";
/** The fixed generator seed — a BEAM run is reproducible from this one command + git. */
const BEAM_SEED = 1234;
/** The 2h beforeAll/it budget — a 1M-token ingest far exceeds the 2-min default. */
const BEAM_TIMEOUT_MS = 7_200_000;

/**
 * The bench store config (mirrors retrieval-harness.bench.test.ts). built through `MemoryConfigSchema.parse` so schema
 * drift fails loudly here instead of at adapter runtime; `dims` = the probed embedding dimensions (or 4
 * for the FTS-only honest fallback).
 */
function makeBenchConfig(dbPath: string, dims: number): MemoryConfig {
  return MemoryConfigSchema.parse({
    dbPath,
    walMode: false,
    recall: { embeddingModel: "local", embeddingDimensions: dims },
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0 },
  });
}

/** The bench recall scope — neutral placeholders, isolated from any live session. */
const BENCH_SESSION_KEY: SessionKey = {
  tenantId: "default",
  userId: "user_a",
  channelId: "default",
};

/**
 * Resolve the report output directory (DUPLICATED from the retrieval harness). The
 * write itself uses `writeRegularFile({ confinedBaseDir })`, so the O_NOFOLLOW + EXCL +
 * confinement guard applies regardless.
 */
function resolveReportDir(fallbackTmpDir: string): string {
  if (COMIS_BENCH_DATA !== undefined && COMIS_BENCH_DATA.length > 0) {
    return fallbackTmpDir; // operator base handled by the confined writer; keep tmp
  }
  return fallbackTmpDir;
}

/**
 * Map an ability's recall@k {@link RankingMetrics} into the report-row
 * {@link AbilityScore} shape (buildSuiteReport carries an `AccuracyResult` per
 * ability). The headline `overall` is recall@1 as a percentage; the recall@k/MRR
 * metrics ride `perCategory` (on a null-prototype map) so the BEAM report row is
 * comparable per ability. PURELY structural — no secret path.
 */
function abilityScoreFrom(ability: string, m: RankingMetrics): AbilityScore {
  const perCategory: Record<string, CategoryAccuracy> = Object.create(null) as Record<
    string,
    CategoryAccuracy
  >;
  // Literal-keyed numeric buckets only (recall@k carried as the `accuracy` field).
  perCategory["recallAt1"] = { correct: 0, total: 0, invalid: 0, accuracy: m.recallAt1 };
  perCategory["recallAt3"] = { correct: 0, total: 0, invalid: 0, accuracy: m.recallAt3 };
  perCategory["recallAt5"] = { correct: 0, total: 0, invalid: 0, accuracy: m.recallAt5 };
  perCategory["mrr"] = { correct: 0, total: 0, invalid: 0, accuracy: m.mrr };
  return {
    ability,
    result: {
      overall: m.recallAt1 * 100,
      correct: 0,
      total: 0,
      invalid: 0,
      validTotal: 0,
      perCategory,
    },
  };
}

describe.skipIf(!COMIS_BENCH)("BEAM scale probe (gated)", () => {
  // Shared providers built ONCE in beforeAll, reused across both the 1M + 10M runs.
  // `RerankerPort` is the unwrapped success value of the reranker factory (mirrors the
  // retrieval harness's `reranker?.ok ? reranker.value : undefined`).
  type RerankerFactoryResult = Awaited<ReturnType<typeof createLocalRerankerProvider>>;
  type RerankerPort = Extract<RerankerFactoryResult, { ok: true }>["value"];
  let embed: Awaited<ReturnType<typeof createEmbeddingProvider>> | undefined;
  let dims = 4;
  let rerankerPort: RerankerPort | undefined;
  let reportDir = "";

  beforeAll(async () => {
    // EMBEDDING PROVIDER — built ONCE; only when LLAMA_MODEL_PATH is set, else honest
    // FTS-only (dims=4, the vector lane does not contribute).
    if (LLAMA_MODEL_PATH !== undefined && LLAMA_MODEL_PATH.length > 0) {
      embed = await createEmbeddingProvider({
        provider: "local",
        local: { modelUri: LLAMA_MODEL_PATH, modelsDir: "/tmp/comis-test-models" },
      });
      if (embed.ok) dims = embed.value.dimensions;
    }

    // SHARED reranker (built ONCE) + the report dir (a fresh tmp dir).
    const dir = mkdtempSync(join(tmpdir(), "comis-beam-bench-"));
    reportDir = resolveReportDir(dir);
    const reranker =
      LLAMA_RERANKER_MODEL_PATH !== undefined && LLAMA_RERANKER_MODEL_PATH.length > 0
        ? await createLocalRerankerProvider({
            modelUri: LLAMA_RERANKER_MODEL_PATH,
            modelsDir: "/tmp/comis-test-models",
            threads: 8,
          })
        : undefined;
    rerankerPort = reranker?.ok ? reranker.value : undefined;
    // 2h hook timeout — provider warm-up (a GGUF load) can be slow; the heavy
    // per-scale ingest runs in `runBeam` inside each `it` body (also at the 2h budget).
  }, BEAM_TIMEOUT_MS);

  /**
   * Generate a deterministic ~`approxTokens`-token haystack AT RUN TIME, ingest every
   * doc into a fresh tmp `SqliteMemoryAdapter` (keyed `genId → randomUUID` via a side-map,
   * mirroring retrieval-harness.bench.test.ts's `ingestedIdByRef`), recall per planted
   * needle through the LIVE pipeline, resolve each needle's `goldDocId` through the
   * side-map, and score per-ability recall@k via {@link scoreBeam}. The store is closed
   * before returning. The haystack is NEVER read from disk and NEVER committed.
   */
  const runBeam = async (approxTokens: number): Promise<BeamScore> => {
    // Generate the haystack HERE at run time (deterministic; never from disk).
    const haystack = generateBeamHaystack({ approxTokens, seed: BEAM_SEED, abilities: 4 });

    const adapter = new SqliteMemoryAdapter(
      makeBenchConfig(join(reportDir, `beam-${approxTokens}.db`), dims),
      embed?.ok ? embed.value : undefined,
    );

    // Ingest every doc at trustLevel "learned"; the generator's ids need not be uuids,
    // so map a fresh randomUUID per doc and key a `genId → uuid` side-map (the safe
    // choice, exactly the retrieval-harness `ingestedIdByRef` pattern).
    const ingestedIdByRef = new Map<string, string>();
    for (const doc of haystack.docs) {
      const id = randomUUID();
      const stored = await adapter.store({
        id,
        tenantId: "default",
        agentId: "bench",
        userId: "user_a",
        content: doc.content,
        trustLevel: "learned",
        source: { who: "bench" },
        tags: ["bench"],
        createdAt: doc.createdAt,
      });
      expect(stored.ok, "BEAM doc stored").toBe(true);
      ingestedIdByRef.set(doc.id, id);
    }

    // The live recall pipeline (shipped defaults; all alphas 0 → clean recall@k; the
    // shipped trust filter ["system","learned"] keeps the learned needles in scope).
    const recall = createMemoryRecall(
      {
        memoryPort: adapter,
        clock: createFakeClock(BENCH_NOW),
        timers: createFakeTimers(BENCH_NOW),
        logger: createMockLogger(),
        ...(rerankerPort ? { reranker: rerankerPort } : {}),
      } as MemoryRecallDeps,
      {
        maxResults: 10,
        minScore: 0,
        includeTrustLevels: ["system", "learned"],
        rerank: { mode: rerankerPort ? "on" : "off", maxCandidates: 20, minResults: 2, timeoutMs: 5000 },
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
      },
    );

    // Recall per needle; key the ranked memo on the needle's query, and resolve the
    // needle's gold genId through the side-map so the scorer's relevantIds are the
    // INGESTED uuids (never the generator's synthetic ids).
    const rankedByNeedle = new Map<string, MemorySearchResult[]>();
    const resolvedNeedles: BeamNeedle[] = [];
    for (const n of haystack.needles) {
      const r = await recall.recall(n.query, BENCH_SESSION_KEY);
      rankedByNeedle.set(n.query, r.ok ? r.value : []);
      const goldUuid = ingestedIdByRef.get(n.goldDocId);
      expect(goldUuid, "needle gold doc was ingested").toBeDefined();
      resolvedNeedles.push({
        ability: n.ability,
        query: n.query,
        goldDocId: goldUuid ?? n.goldDocId,
      });
    }

    const score = scoreBeam(resolvedNeedles, rankedByNeedle);
    adapter.close();
    return score;
  };

  /**
   * Assert a BEAM score's STRUCTURAL invariants (never a hard recall floor — the
   * number is machine/retrieval-dependent): every metric in [0,1] and recall@5 ≥
   * recall@1 (monotone @k) for the overall fold + every per-ability fold.
   */
  const assertStructural = (score: BeamScore): void => {
    const all: RankingMetrics[] = [score.overall, ...Object.values(score.perAbility)];
    for (const m of all) {
      for (const v of [m.recallAt1, m.recallAt3, m.recallAt5, m.mrr]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(m.recallAt5).toBeGreaterThanOrEqual(m.recallAt1); // monotone @k
    }
  };

  /**
   * Build the BEAM report from a score, assert secret omission, and write it to the
   * confined report dir. Returns the serialized report (for the operator console line).
   */
  const writeBeamReport = (score: BeamScore, fileName: string): string => {
    const abilities: AbilityScore[] = Object.keys(score.perAbility).map((ability) =>
      abilityScoreFrom(ability, score.perAbility[ability as BeamAbility]),
    );
    const report = buildSuiteReport(
      { tier: "beam", harnessVersion: HARNESS_VERSION, abilities },
      Date.now(),
    );
    const reportJson = JSON.stringify(report, null, 2);
    // KEYLESS recall@k → no secret exists; the assertion is the structural guarantee.
    // The ONLY allowed occurrence of these tokens in this file.
    expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);
    const writeResult = writeRegularFile({
      path: join(reportDir, fileName),
      content: reportJson,
      confinedBaseDir: reportDir,
    });
    expect(writeResult.ok, `${fileName} written to the confined dir`).toBe(true);
    return reportJson;
  };

  it(
    "recalls per-ability hits at BEAM 1M scale",
    async () => {
      const score = await runBeam(1_000_000);
      // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
      console.log("BENCH BEAM 1M", JSON.stringify(score));
      writeBeamReport(score, "beam-1m-report.json");
      assertStructural(score);
    },
    // 2h `it` budget — the 1M-token ingest is genuinely slow.
    BEAM_TIMEOUT_MS,
  );

  it.skipIf(!BEAM_10M)(
    "BEAM 10M per-ability recall (stretch)",
    async () => {
      // Stretch tier — SKIPS unless COMIS_BENCH_BEAM_10M is set (deferrable;
      // default CI never pays the 10M cost).
      const score = await runBeam(10_000_000);
      // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
      console.log("BENCH BEAM 10M", JSON.stringify(score));
      writeBeamReport(score, "beam-10m-report.json");
      assertStructural(score);
    },
    // 2h `it` budget — the 10M-token ingest is far slower than 1M.
    BEAM_TIMEOUT_MS,
  );
});
