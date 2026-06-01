// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated end-to-end RECALL-OUTCOME-LEARNING-LIFT harness (SUITE-03) — measures a
 * SHIPPED differentiator: recall that LEARNS from outcomes. It drives Comis's
 * SHIPPED FEED loop over N episodes of the SAME query and measures whether the gold
 * memory's rank LIFTS as it is repeatedly recorded "used":
 *   1. `createSqliteMemoryUsefulnessStore({ db })` — the durable per-memory used/
 *      ignored counts (FEED-02),
 *   2. `createMemoryRecall` folds usefulness when `deps.usefulnessStore` is present
 *      AND `cfg.feedback.enabled === true`, bounded by `cfg.scoring.usefulnessAlpha`
 *      (FEED-03), and
 *   3. `score.ts` `usefulnessNorm = usedCount/(usedCount+ignoredCount)` (absent →
 *      0.5 neutral): a repeatedly-"used" memory's rate rises → its rank rises.
 *
 * THE NUMBER: `scoreLearningLift` (pure, Task 1) folds the gold doc's per-episode
 * 0-based rank into `rankLift = firstRank − lastRank`. A POSITIVE lift is the
 * directional learning result an operator confirms on real data (the leapfrog
 * Hindsight cannot follow — its `access_count` is dead schema). The harness asserts
 * only STRUCTURAL invariants (episode/rank counts, the secret-omission gate); the
 * hard lift sign is signal-dependent on FTS scoring of the constructed docs, so it
 * is logged, NOT asserted (RESEARCH Anti-Pattern: never a machine-dependent floor).
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory (a devDependency) — the agent→memory cut excludes the `.test.ts`
 * suffix (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). The pure
 * modules it consumes (learning-lift-scorer.ts, suite-scenario.ts, suite-report.ts)
 * import ONLY @comis/core types / nothing. Mirrors the blessed precedent
 * retrieval-harness.bench.test.ts (the no-LLM sibling) + qa-judge-harness.bench.test.ts.
 *
 * DUPLICATED INGEST WIRING (intentional, RESEARCH Anti-Pattern): makeBenchConfig /
 * BENCH_SESSION_KEY / resolveReportDir are DUPLICATED from the QA/retrieval
 * harnesses rather than factored into a shared non-`.test.ts` helper — a shared
 * helper importing @comis/memory WOULD trip the cut.
 *
 * TWO-TIER GATE:
 * - UNGATED (default `pnpm test`/`pnpm validate`): the pure scorer's correctness is
 *   unit-tested in learning-lift-scorer.test.ts (the keyless-CI value).
 * - GATED (this file's describe): `COMIS_BENCH=1` enables the full ingest + episode
 *   FEED loop + the FEED-store witness. NO answer/judge LLM is needed (it measures
 *   RANK, not QA), so it gates on `COMIS_BENCH` ONLY (like retrieval-harness.bench.test.ts).
 *
 * SECURITY:
 * - Bench store is a fresh `mkdtempSync` tmp DB (NEVER ~/.comis), `tenantId:
 *   "default"` / `agentId:"bench"` — isolated from any live agent (T-99-03-01).
 *   Closed via `adapter.close()`.
 * - The FEED store is content-free (counts only), so no body can leak (T-99-03-02);
 *   the report is built via buildSuiteReport (structural secret omission) + written
 *   via the confined `writeRegularFile`, and the gated body asserts the serialized
 *   report carries none of `/apiKey|sk-|Bearer/`.
 * - Fixture content is ingested as memory CONTENT only, never `eval`'d (T-99-03-03).
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent→memory cut excludes *.test.ts).
import {
  SqliteMemoryAdapter,
  createEmbeddingProvider,
  createLocalRerankerProvider,
  createSqliteMemoryUsefulnessStore,
} from "@comis/memory";
// BARE production orchestrator (the live recall pipeline this harness drives).
import { createMemoryRecall, type MemoryRecallDeps } from "@comis/agent";
// VALUE obs import (fine in a .test.ts) — the confined report writer.
import { writeRegularFile } from "@comis/observability";
// RELATIVE Wave-1 (99-01) constructed learning fixture — no external corpus.
import { buildLearningEpisodes } from "./suite-scenario.js";
// RELATIVE Wave-1 (99-01) secret-free per-tier report builder.
import { buildSuiteReport } from "./suite-report.js";
// RELATIVE Task-1 (this plan) pure first→last rank-lift scorer.
import { scoreLearningLift } from "./learning-lift-scorer.js";
// Determinism helpers (test/support — 5 segments up from packages/agent/src/memory/benchmark/).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type { MemoryConfig, MemorySearchResult, SessionKey, TrustLevel } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ENV GATES — read process.env ONLY at the test boundary (allowed in a .test.ts).
const COMIS_BENCH = process.env.COMIS_BENCH; // enables the full ingest + FEED-loop run
const LLAMA_MODEL_PATH = process.env.LLAMA_MODEL_PATH; // optional vector lane (embeddings)
const LLAMA_RERANKER_MODEL_PATH = process.env.LLAMA_RERANKER_MODEL_PATH; // optional rerank lift
const COMIS_BENCH_DATA = process.env.COMIS_BENCH_DATA; // optional report-output base

/** Fixed epoch (matches the sibling harnesses' neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** The recall-learning tier's harness version stamp (recorded in the report). */
const HARNESS_VERSION = "phase-99-v1";
/**
 * The usefulness boost weight. Nonzero so the lift is OBSERVABLE; the shipped
 * default is `rag.scoring.usefulnessAlpha` = 0.1 (schema-agent), and 0.3 stays well
 * within [0,1] and the "same small magnitude as trust/proof so it cannot overturn
 * trust-first" bound (score.ts Pitfall 5). All other alphas are 0 to ISOLATE the
 * usefulness signal so the rank delta reflects FEED alone.
 */
const USEFULNESS_ALPHA = 0.3;

/**
 * The bench store config (mirrors the QA/retrieval harnesses). `as MemoryConfig`:
 * the adapter reads the fields it needs; `dims` = the probed embedding dimensions
 * (or 4 for the FTS-only honest fallback).
 */
function makeBenchConfig(dbPath: string, dims: number): MemoryConfig {
  return {
    dbPath,
    walMode: false,
    embeddingModel: "local",
    embeddingDimensions: dims,
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0 },
  } as MemoryConfig;
}

/** The bench recall scope — neutral placeholders, isolated from any live session. */
const BENCH_SESSION_KEY: SessionKey = {
  tenantId: "default",
  userId: "user_a",
  channelId: "default",
};

/**
 * Resolve the report output directory (DUPLICATED from the QA/retrieval harness).
 * The write itself uses `writeRegularFile({ confinedBaseDir })`, so the O_NOFOLLOW +
 * EXCL + confinement guard applies regardless (T-99-03-02).
 */
function resolveReportDir(fallbackTmpDir: string): string {
  if (COMIS_BENCH_DATA !== undefined && COMIS_BENCH_DATA.length > 0) {
    return fallbackTmpDir; // operator base handled by the confined writer; keep tmp
  }
  return fallbackTmpDir;
}

describe.skipIf(!COMIS_BENCH)("recall-outcome learning lift (gated)", () => {
  // The gold doc's 0-based rank per episode (undefined = not recalled) — filled in
  // beforeAll by the live FEED loop; folded by scoreLearningLift in the it body.
  const ranksPerEpisode: Array<number | undefined> = [];
  let episodeCount = 0;
  let candidatePoolSize = 0;
  let reportDir = "";

  beforeAll(async () => {
    // 1. SCENARIO — constructed (Wave 1): a fixed query, N episodes, known goldDocIndex.
    const scenario = buildLearningEpisodes();
    expect(scenario.episodes, "learning episodes").toBeGreaterThanOrEqual(2);
    episodeCount = scenario.episodes;
    candidatePoolSize = scenario.docs.length;

    // 2. EMBEDDING PROVIDER — built ONCE; only when LLAMA_MODEL_PATH is set, else
    //    honest FTS-only (dims=4, the vector lane does not contribute).
    let embed: Awaited<ReturnType<typeof createEmbeddingProvider>> | undefined;
    let dims = 4;
    if (LLAMA_MODEL_PATH !== undefined && LLAMA_MODEL_PATH.length > 0) {
      embed = await createEmbeddingProvider({
        provider: "local",
        local: { modelUri: LLAMA_MODEL_PATH, modelsDir: "/tmp/comis-test-models" },
      });
      if (embed.ok) dims = embed.value.dimensions;
    }

    const dir = mkdtempSync(join(tmpdir(), "comis-learning-bench-"));
    reportDir = resolveReportDir(dir);

    const reranker =
      LLAMA_RERANKER_MODEL_PATH !== undefined && LLAMA_RERANKER_MODEL_PATH.length > 0
        ? await createLocalRerankerProvider({
            modelUri: LLAMA_RERANKER_MODEL_PATH,
            modelsDir: "/tmp/comis-test-models",
            threads: 8,
          })
        : undefined;
    const rerankerPort = reranker?.ok ? reranker.value : undefined;

    // 3. FRESH per-run store. Ingest the docs at trustLevel "learned" (the trusted
    //    band kept by the shipped filter), tracking which uuid is the gold doc.
    const adapter = new SqliteMemoryAdapter(
      makeBenchConfig(join(dir, "learning.db"), dims),
      embed?.ok ? embed.value : undefined,
    );

    let goldUuid = "";
    for (const [index, doc] of scenario.docs.entries()) {
      const id = randomUUID();
      if (index === scenario.goldDocIndex) goldUuid = id;
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
      expect(stored.ok, "doc stored").toBe(true);
    }

    // 4. The SHIPPED usefulness store over the adapter's shared db handle (FEED-02).
    const usefulnessStore = createSqliteMemoryUsefulnessStore({ db: adapter.getDb() });

    // The live recall pipeline WITH the usefulness fold enabled. usefulnessAlpha is
    // nonzero so the lift is observable; all OTHER alphas are 0 to isolate FEED.
    const includeTrustLevels: TrustLevel[] = ["system", "learned"];
    const recall = createMemoryRecall(
      {
        memoryPort: adapter,
        clock: createFakeClock(BENCH_NOW),
        timers: createFakeTimers(BENCH_NOW),
        logger: createMockLogger(),
        usefulnessStore,
        ...(rerankerPort ? { reranker: rerankerPort } : {}),
      } as MemoryRecallDeps,
      {
        maxResults: 10,
        minScore: 0,
        includeTrustLevels,
        rerank: { enabled: !!rerankerPort, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
        scoring: {
          recencyAlpha: 0,
          temporalAlpha: 0,
          proofAlpha: 0,
          trustAlpha: 0,
          usefulnessAlpha: USEFULNESS_ALPHA,
        },
        feedback: { enabled: true },
      },
    );

    // 5. EPISODE LOOP — recall, find the gold's 0-based rank, THEN record the gold as
    //    USED + the rest as IGNORED so the NEXT episode's usefulnessNorm raises the
    //    gold's used-rate and (within usefulnessAlpha) its rank.
    for (let e = 0; e < scenario.episodes; e += 1) {
      const r = await recall.recall(scenario.query, BENCH_SESSION_KEY);
      const ranked: MemorySearchResult[] = r.ok ? r.value : [];
      const rankedIds = ranked.map((m) => m.entry.id);
      const goldRank = rankedIds.indexOf(goldUuid);
      ranksPerEpisode.push(goldRank === -1 ? undefined : goldRank);

      const otherRankedUuids = rankedIds.filter((id) => id !== goldUuid);
      const rec = await usefulnessStore.recordUsage([goldUuid], otherRankedUuids, {
        tenantId: "default",
        agentId: "bench",
        now: BENCH_NOW + e,
      });
      expect(rec.ok, "recordUsage ok").toBe(true);
    }

    adapter.close();
    await rerankerPort?.dispose?.();
    // 2h hook timeout (BUG-001): defensive even though the no-LLM loop is fast — the
    // ingest + per-episode recall for a non-trivial set could exceed the 2-min default.
  }, 7_200_000);

  it("measures the FEED rank lift across episodes", () => {
    // 7. The pure first→last rank delta (absent gold counts as the worst pool rank).
    const score = scoreLearningLift(ranksPerEpisode, candidatePoolSize);

    // 8. The reproducible per-tier report. The lift rides as a single numeric ability
    //    overall (clamped into [0,1] so the AccuracyResult shape stays valid); the raw
    //    LearningLiftScore is logged below. The builder structurally omits any secret.
    const clampedLift = Math.max(0, Math.min(1, score.rankLift / Math.max(1, candidatePoolSize)));
    const report = buildSuiteReport(
      {
        tier: "recall-learning",
        harnessVersion: HARNESS_VERSION,
        abilities: [
          {
            ability: "feed-rank-lift",
            result: {
              overall: clampedLift,
              correct: score.rankLift > 0 ? 1 : 0,
              total: 1,
              invalid: 0,
              validTotal: 1,
              perCategory: {},
            },
          },
        ],
      },
      Date.now(),
    );
    const reportJson = JSON.stringify(report, null, 2);

    // WRITE via the CONFINED writer (T-99-03-02) — O_NOFOLLOW + EXCL + confinement.
    const writeResult = writeRegularFile({
      path: join(reportDir, "learning-lift-report.json"),
      content: reportJson,
      confinedBaseDir: reportDir,
    });
    expect(writeResult.ok, "learning-lift report written to the confined dir").toBe(true);

    // 9. Operator-visible number — the raw LearningLiftScore (pure numbers; no secret,
    //    no content). A POSITIVE rankLift is the expected directional result the
    //    operator confirms on real data; NOT asserted here (FTS-signal-dependent).
    // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
    console.log("BENCH learning lift", JSON.stringify(score));

    // STRUCTURAL assertions ONLY (Anti-Pattern: never a hard positive-lift floor).
    expect(score.episodes).toBe(episodeCount);
    expect(score.ranks.length).toBe(episodeCount);
    // The report must carry NO secret substring (T-99-03-02) — the ONLY allowed
    // occurrence of these tokens in this file is inside this negation.
    expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);
  });

  // 10. FEED-store witness (inside the gated describe because it imports the
  //     @comis/memory store): a fresh tmp adapter records a used id and reads it back
  //     with usedCount >= 1 — proves the shipped FEED store engages without the full
  //     episode loop. (The keyless-CI value is the scorer unit test, which is ungated.)
  //     The memory row is STORED FIRST: memory_usefulness.memory_id has an FK →
  //     memories(id) with FKs ON (openSqliteDatabase), so recordUsage for an unstored
  //     id fails the FK insert — exactly the seedMemory discipline in
  //     sqlite-memory-usefulness-store.test.ts.
  it("the usefulness store records and reads back used/ignored counts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-feed-witness-"));
    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "feed.db"), 4), undefined);
    try {
      const store = createSqliteMemoryUsefulnessStore({ db: adapter.getDb() });
      const m1 = randomUUID();
      // Seed the memory row first so the usefulness FK (memory_id → memories.id) holds.
      const stored = await adapter.store({
        id: m1,
        tenantId: "default",
        agentId: "bench",
        userId: "user_a",
        content: "witness memory",
        trustLevel: "learned",
        source: { who: "bench" },
        tags: ["bench"],
        createdAt: BENCH_NOW,
      });
      expect(stored.ok, "witness memory stored").toBe(true);
      const wrote = await store.recordUsage([m1], [], {
        tenantId: "default",
        agentId: "bench",
        now: BENCH_NOW,
      });
      expect(wrote.ok).toBe(true);
      const read = await store.readUsefulness([m1], { tenantId: "default", agentId: "bench" });
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.value.get(m1)?.usedCount ?? 0).toBeGreaterThanOrEqual(1);
      }
    } finally {
      adapter.close();
    }
  });
});
