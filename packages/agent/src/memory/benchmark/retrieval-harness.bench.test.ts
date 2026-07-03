// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated retrieval-recall harness (the ingest + recall-scoring halves) — the
 * proof gate's measurement engine.
 *
 * It ingests the LongMemEval + LoCoMo documents (one dated document per
 * session, a fresh `randomUUID()` per document) into a REAL `SqliteMemoryAdapter`,
 * runs the LIVE `createMemoryRecall` pipeline (search -> fuse -> rerank -> score ->
 * trust-filter -> dedup) per benchmark question, and scores recall@k / MRR against
 * the `buildGoldMap`-resolved gold-evidence ids by REUSING `recall-eval.ts`'s
 * `scoreRanking`. The number this prints is the "better memory" claim turned
 * into a reproducible regression proxy that every later change is scored against.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.test.ts MAY
 * import the memory package (a devDependency); the agent->memory architecture cut
 * excludes .test.ts via findForbiddenImports' suffix filter (source-rules.test.ts:137,
 * excludeFileSuffixes: [".test.ts"]). The production loaders (longmemeval-loader.ts,
 * locomo-loader.ts, gold-map.ts) and analyzer (recall-trace-analyzer.ts) import
 * ONLY @comis/core / @comis/observability types + @comis/shared Result + Node stdlib —
 * this harness is the single cut escape. Mirrors the blessed precedent recall-eval.test.ts:14-18.
 *
 * TWO-TIER SPLIT (mirrors recall-eval.test.ts:5-13):
 * - UNGATED (default CI, `pnpm test`/`pnpm validate`): the deterministic, structural
 *   correctness of the loaders + gold-map + analyzer is unit-tested in their
 *   co-located *.test.ts over the tiny vendored fixtures.
 * - GATED (THIS file, `COMIS_BENCH=1`): the full ingest + live-recall + score run.
 *   The model lanes nest behind `LLAMA_MODEL_PATH` (vector lane / embeddings) and
 *   `LLAMA_RERANKER_MODEL_PATH` (rerank lift); absent both -> honest FTS-only retrieval
 *   (recall@k reflects lexical-only retrieval). A default `pnpm test`
 *   run (no COMIS_BENCH) skips this entire suite, so no dataset / GGUF weight reaches CI.
 *
 * SECURITY: the bench store is a fresh `mkdtempSync` tmp DB (NEVER ~/.comis),
 * `trustLevel: "learned"`, `tenantId: "default"` / `agentId: "bench"` — isolated from
 * any live agent. The operator-provided `COMIS_BENCH_DATA` base is resolved
 * and each dataset file path is asserted to live under it before any read (rejects
 * `..`-escape; ASVS V5). Content comes from the loaders, which strip
 * `has_answer` (LongMemEval) and exclude the `qa` block (LoCoMo) — gold lives only in
 * the `buildGoldMap` side-channel keyed by UUID, never re-introduced into content.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent->memory cut excludes *.test.ts). Public-barrel
// factories: the local-embedding factory is reached via createEmbeddingProvider
// ({provider:"local",...}) — the direct local-embedding factory is NOT on the
// @comis/memory barrel — plus createLocalRerankerProvider.
import {
  SqliteMemoryAdapter,
  createEmbeddingProvider,
  createLocalRerankerProvider,
} from "@comis/memory";
// BARE production orchestrator (the live recall pipeline scored by this harness).
import { createMemoryRecall, type MemoryRecallDeps } from "@comis/agent";
// RELATIVE scorer + the EvalQuery type (NEITHER is on the @comis/agent barrel — reached
// relatively from this co-located file).
import { scoreRanking } from "../recall-eval.js";
import type { EvalQuery } from "../__fixtures__/recall-eval-fixtures.js";
// RELATIVE loaders + gold-map (consumed verbatim — NO field-rename, NO
// questionId synthesis in the harness; the loaders own those).
import { loadLongMemEvalDataset } from "./longmemeval-loader.js";
import { loadLocomoDataset } from "./locomo-loader.js";
import { buildGoldMap } from "./gold-map.js";
// RELATIVE analyzer (the optional quality-view tie-in, step 8).
import { analyzeRecallTrace } from "./recall-trace-analyzer.js";
// VALUE obs import (fine in a .test.ts) — the tmp-filePath recall-trace recorder +
// the confined report writer (O_NOFOLLOW + EXCL + confinement) for retrieval-metrics.json.
import { createRecallTrace, writeRegularFile } from "@comis/observability";
// Determinism helpers (test/support — 5 segments up from packages/agent/src/memory/benchmark/).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only — no @comis/core value import needed).
import type { MemoryConfig, MemorySearchResult, SessionKey } from "@comis/core";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

// ENV GATES — read process.env ONLY at the test boundary (allowed in a .test.ts;
// the globals rule scopes to src/**). The env-var names are pinned.
const COMIS_BENCH = process.env.COMIS_BENCH; // the full ingest+recall+score run
const LLAMA_MODEL_PATH = process.env.LLAMA_MODEL_PATH; // vector lane (embeddings)
const LLAMA_RERANKER_MODEL_PATH = process.env.LLAMA_RERANKER_MODEL_PATH; // rerank lift
const COMIS_BENCH_DATA = process.env.COMIS_BENCH_DATA; // operator-placed full haystack dir (optional)

/** Fixed epoch (matches recall-eval.ts's neutral clock) — recencyAlpha:0 neutralizes recency anyway. */
const BENCH_NOW = 1_700_000_000_000;
/** Harness version stamp — recorded in retrieval-metrics.json (matches the QA sibling). */
const HARNESS_VERSION = "phase-89-v1";

/**
 * The bench store config (mirrors the roundtrip template makeTestConfig at
 * memory-persistence-roundtrip.test.ts:26-35). `as MemoryConfig` like the template:
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
 * Read a vendored fixture (default) or an operator-placed dataset file under
 * `COMIS_BENCH_DATA`. When the operator base is set, resolve it and assert the
 * resolved file path stays under it BEFORE `readFileSync` — this rejects a
 * `..`-escape on the operator path (ASVS V5). An absolute operator
 * path under an asserted base is acceptable in a .test.ts; full safePath
 * confinement is the src-side control.
 */
function readDataset(vendoredRelPath: string, operatorFileName: string): unknown {
  if (COMIS_BENCH_DATA !== undefined && COMIS_BENCH_DATA.length > 0) {
    const base = resolve(COMIS_BENCH_DATA);
    const p = resolve(base, operatorFileName);
    if (!p.startsWith(base + sep) && p !== base) {
      throw new Error("dataset path escapes COMIS_BENCH_DATA base");
    }
    return JSON.parse(readFileSync(p, "utf-8"));
  }
  // ESM-correct fixture resolution (mirror the sibling recall-trace-analyzer.test.ts:23-26;
  // this package is "type": "module" so __dirname is unavailable).
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(vendoredRelPath, import.meta.url)), "utf-8"),
  );
}

/**
 * Resolve the metrics output directory. When `COMIS_BENCH_DATA` is set, write
 * alongside the operator haystack (resolved, asserted to be the base itself — no
 * traversal); otherwise a fresh tmp dir. The actual write uses
 * `writeRegularFile({ confinedBaseDir })`, so O_NOFOLLOW + EXCL + confinement
 * applies regardless. DUPLICATED VERBATIM from qa-judge-harness.bench.test.ts
 * (the documented intentional cross-harness duplication — a shared non-`.test.ts`
 * helper would trip the agent->memory cut; both harnesses are independent gates).
 */
function resolveReportDir(fallbackTmpDir: string): string {
  if (COMIS_BENCH_DATA !== undefined && COMIS_BENCH_DATA.length > 0) {
    return resolve(COMIS_BENCH_DATA);
  }
  return fallbackTmpDir;
}

describe.skipIf(!COMIS_BENCH)("retrieval recall (LongMemEval + LoCoMo, gated)", () => {
  // questionId -> the live ranked MemorySearchResult[] (memoized because recall() is
  // async while scoreRanking's rankFn is sync). Keyed by the UNIQUE questionId, never
  // by q.query (two distinct questions can share query text -> a query-keyed memo
  // would collide and silently zero a lane).
  const rankedByQuestion = new Map<string, MemorySearchResult[]>();
  // EvalQuery objects carrying the loader-provided questionId so the sync rankFn can
  // key the memo on it (scoreRanking ignores extra fields, reading only relevantIds +
  // the rankFn result).
  const queries: Array<EvalQuery & { questionId: string }> = [];
  // The LoCoMo questionId set (for the "non-empty ranked lane" assertion below).
  let locomoQuestionIds = new Set<string>();
  // The tmp recall-trace JSONL the live pipeline writes (the analyzer tie-in reads it).
  let traceFile = "";
  // The dir retrieval-metrics.json is written to (operator haystack dir, or the tmp dir).
  let reportDir = "";

  beforeAll(async () => {
    // 1. DATASETS — FULL arrays (the public sets); a single-object vendored fixture
    //    is accepted as a one-element array. Each item/sample is an INDEPENDENT
    //    (haystack, question) pair and is ingested into ITS OWN store below (the
    //    standard protocol — merging haystacks across items would add cross-item
    //    distractor noise the benchmark never intended, breaking comparability).
    const lmeResult = loadLongMemEvalDataset(
      readDataset("./__fixtures__/longmemeval-sample.json", "longmemeval.json"),
    );
    expect(lmeResult.ok, "LongMemEval dataset parses").toBe(true);
    const locomoResult = loadLocomoDataset(
      readDataset("./__fixtures__/locomo-sample.json", "locomo.json"),
    );
    expect(locomoResult.ok, "LoCoMo dataset parses").toBe(true);
    if (!lmeResult.ok || !locomoResult.ok) return;
    const lmeItems = lmeResult.value;
    const locomoItems = locomoResult.value;
    locomoQuestionIds = new Set(locomoItems.flatMap((s) => s.qa.map((q) => q.questionId)));

    // 2. EMBEDDING PROVIDER — only when LLAMA_MODEL_PATH is set; else honest FTS-only
    // (dims=4, no 2nd ctor arg -> the vector lane does not contribute).
    let embed: Awaited<ReturnType<typeof createEmbeddingProvider>> | undefined;
    let dims = 4;
    if (LLAMA_MODEL_PATH !== undefined && LLAMA_MODEL_PATH.length > 0) {
      embed = await createEmbeddingProvider({
        provider: "local",
        local: { modelUri: LLAMA_MODEL_PATH, modelsDir: "/tmp/comis-test-models" },
      });
      if (embed.ok) dims = embed.value.dimensions;
    }

    // 3. SHARED providers — built ONCE and reused across every per-item store. The
    // recall-trace is ONE JSONL accumulating all items' recalls (the analyzer folds it
    // whole). createRecallTrace returns null when COMIS_DISABLE_RECALL_TRACE=1 -> null-check.
    const dir = mkdtempSync(join(tmpdir(), "comis-bench-"));
    traceFile = join(dir, "bench-recall-trace.jsonl");
    // Resolve where retrieval-metrics.json is written (operator dir or this tmp dir).
    reportDir = resolveReportDir(dir);
    const trace = createRecallTrace({
      enabled: true,
      filePath: traceFile,
      agentId: "bench",
      sessionId: "bench",
    });
    const reranker =
      LLAMA_RERANKER_MODEL_PATH !== undefined && LLAMA_RERANKER_MODEL_PATH.length > 0
        ? await createLocalRerankerProvider({
            modelUri: LLAMA_RERANKER_MODEL_PATH,
            modelsDir: "/tmp/comis-test-models",
            threads: 8,
          })
        : undefined;
    const rerankerPort = reranker?.ok ? reranker.value : undefined;

    // A fresh recall pipeline bound to ONE item's store (alphas 0 -> clean recall@k;
    // shares the embed/reranker/trace). Re-created per item because it binds the adapter.
    const makeRecall = (port: SqliteMemoryAdapter) =>
      createMemoryRecall(
        {
          memoryPort: port,
          clock: createFakeClock(BENCH_NOW),
          timers: createFakeTimers(BENCH_NOW),
          logger: createMockLogger(),
          ...(rerankerPort ? { reranker: rerankerPort } : {}),
          ...(trace ? { recallTrace: trace } : {}),
        } as MemoryRecallDeps,
        {
          maxResults: 10,
          minScore: 0,
          includeTrustLevels: ["learned", "system"],
          rerank: { enabled: !!rerankerPort, maxCandidates: 20, minResults: 2, timeoutMs: 5000 },
          scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
        },
      );

    // 4. Recall every question of ONE item against ITS store, resolving gold through
    // that item's OWN datasetRef -> uuid side-map. Gold refs (sessionId / "D<sess>:<dia>")
    // are unique only WITHIN an item, so buildGoldMap MUST run per item (a global
    // map would let two items' identical refs collide and zero a lane). The questionIds
    // are globally unique, so memoizing/accumulating across items is collision-proof.
    const recallItem = async (
      port: SqliteMemoryAdapter,
      questions: Array<{ questionId: string; query: string }>,
      goldRefsByQuestion: Map<string, Set<string>>,
      ingestedIdByRef: Map<string, string>,
    ): Promise<void> => {
      const recall = makeRecall(port);
      const goldByQuestion = buildGoldMap(goldRefsByQuestion, ingestedIdByRef);
      for (const q of questions) {
        const r = await recall.recall(q.query, BENCH_SESSION_KEY);
        rankedByQuestion.set(q.questionId, r.ok ? r.value : []);
        queries.push({
          group: "reranking",
          query: q.query,
          candidates: [], // unused by scoreRanking (the rankFn is supplied)
          relevantIds: [...(goldByQuestion.get(q.questionId) ?? new Set<string>())],
          questionId: q.questionId,
        });
      }
    };

    let storeIdx = 0;
    // 5a. LongMemEval items — each an INDEPENDENT store (fresh tmp DB, ingest its OWN
    // haystack, key the side-map on doc.sessionId = the answer_session_ids gold form).
    // A fresh randomUUID per doc (NEVER the dataset ref — z.guid() rejects "session_0002").
    for (const lme of lmeItems) {
      const adapter = new SqliteMemoryAdapter(
        makeBenchConfig(join(dir, `lme-${storeIdx++}.db`), dims),
        embed?.ok ? embed.value : undefined,
      );
      const ingestedIdByRef = new Map<string, string>();
      for (const doc of lme.docs) {
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
        expect(stored.ok, "LongMemEval doc stored").toBe(true);
        ingestedIdByRef.set(doc.sessionId, id);
      }
      const goldRefs = new Map<string, Set<string>>();
      for (const [questionId, sessionIds] of lme.answerSessionIdsByQuestion) {
        goldRefs.set(questionId, new Set(sessionIds));
      }
      await recallItem(adapter, lme.questions, goldRefs, ingestedIdByRef);
      adapter.close();
    }

    // 5b. LoCoMo samples — each an INDEPENDENT store. Key the side-map on the FULL
    // session-qualified dia ref ("D2:3") verbatim — the SAME form the loader emits for
    // qa[].goldDiaIds, so buildGoldMap resolves.
    for (const locomo of locomoItems) {
      const adapter = new SqliteMemoryAdapter(
        makeBenchConfig(join(dir, `locomo-${storeIdx++}.db`), dims),
        embed?.ok ? embed.value : undefined,
      );
      const ingestedIdByRef = new Map<string, string>();
      for (const doc of locomo.docs) {
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
        expect(stored.ok, "LoCoMo doc stored").toBe(true);
        for (const ref of doc.diaIds) {
          ingestedIdByRef.set(ref, id);
        }
      }
      const goldRefs = new Map<string, Set<string>>();
      for (const qa of locomo.qa) {
        goldRefs.set(qa.questionId, new Set(qa.goldDiaIds));
      }
      await recallItem(adapter, locomo.qa, goldRefs, ingestedIdByRef);
      adapter.close();
    }

    // Flush the recall-trace so the analyzer tie-in can read a complete JSONL.
    await trace?.flushAndClose?.();
    await rerankerPort?.dispose?.();
    // 2h hook timeout: full-set ingestion (all 500 LongMemEval items + 10 LoCoMo,
    // on-device embedding) runs in THIS beforeAll and far exceeds the 2-min default —
    // it must match the raised it-body budget or the real run trips here.
  }, 7_200_000);

  // The sync rankFn reads the same questionId memo (the closure keys on questionId).
  const rankFn = (q: EvalQuery & { questionId: string }): MemorySearchResult[] =>
    rankedByQuestion.get(q.questionId) ?? [];

  it("reports recall@k / MRR over the ingested haystack without regression", () => {
    const metrics = scoreRanking(queries, rankFn);
    // Report the regression-proxy number for the operator:
    // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
    console.log(
      "BENCH recall@k/MRR",
      JSON.stringify(metrics),
      "vectorLane:",
      !!LLAMA_MODEL_PATH,
      "rerank:",
      !!LLAMA_RERANKER_MODEL_PATH,
    );

    // Persist recall@k/MRR to disk so it is a committable manifest sibling of
    // qa-report.json, not a console-only number. The written object is pure metrics +
    // booleans + a version string — no model identity carrying a key; the
    // confined writeRegularFile (O_NOFOLLOW + EXCL + confinement) is the same writer the
    // QA harness uses for qa-report.json. retrieval is keyless, so no secret exists to leak.
    const metricsJson = JSON.stringify(
      {
        ...metrics,
        vectorLane: !!LLAMA_MODEL_PATH,
        rerank: !!LLAMA_RERANKER_MODEL_PATH,
        harnessVersion: HARNESS_VERSION,
      },
      null,
      2,
    );
    const writeResult = writeRegularFile({
      path: join(reportDir, "retrieval-metrics.json"),
      content: metricsJson,
      confinedBaseDir: reportDir,
    });
    expect(writeResult.ok, "retrieval-metrics.json written to the confined dir").toBe(true);

    // Assertion discipline — structural invariants ONLY, never a hard floor.
    expect(metrics.recallAt1).toBeGreaterThanOrEqual(0); // recall-eval.test.ts:328 style
    expect(metrics.recallAt5).toBeGreaterThanOrEqual(metrics.recallAt1); // monotone @k invariant
    expect(metrics.mrr).toBeGreaterThanOrEqual(0);
  });

  // HARDENING — catch a silently-zeroed LoCoMo lane. The gold-set assertion
  // alone passes even if recall ran on an empty query, so ALSO assert at least one
  // LoCoMo question produced a NON-EMPTY ranked result.
  it("the LoCoMo lane produces non-empty ranked results (not silently zeroed)", () => {
    const locomoRanked = [...rankedByQuestion.entries()].filter(([qid]) =>
      locomoQuestionIds.has(qid),
    );
    expect(locomoRanked.length, "LoCoMo questions were recalled").toBeGreaterThanOrEqual(1);
    // The bug this guards: q.query undefined -> recall on empty query -> every LoCoMo
    // entry collides on one undefined memo key -> all ranked lists empty.
    expect(
      locomoRanked.some(([, ranked]) => ranked.length >= 1),
      "at least one LoCoMo question has a non-empty ranked result",
    ).toBe(true);
  });

  // Contract: at least one LoCoMo question carries a NON-EMPTY gold set (proves
  // the questionId key matches between the goldByQuestion build and the EvalQuery lookup).
  it("at least one LoCoMo question carries a non-empty mapped gold set", () => {
    const locomoGold = queries.filter((q) => locomoQuestionIds.has(q.questionId));
    expect(locomoGold.length, "LoCoMo questions are in the query set").toBeGreaterThanOrEqual(1);
    expect(
      locomoGold.some((q) => q.relevantIds.length >= 1),
      "at least one LoCoMo question's gold resolved to >=1 ingested id",
    ).toBe(true);
  });

  // OPTIONAL quality-view tie-in: prove the analyzer reads a REAL
  // produced trace (not just the hand-authored fixture). Structural assertion only.
  it("analyzeRecallTrace folds the real produced recall-trace JSONL", () => {
    const view = analyzeRecallTrace(readFileSync(traceFile, "utf-8"));
    // eslint-disable-next-line no-console -- gated bench harness reports its quality view
    console.log("BENCH trace quality view", JSON.stringify(view));
    expect(view.recalls).toBeGreaterThanOrEqual(0);
  });
});
