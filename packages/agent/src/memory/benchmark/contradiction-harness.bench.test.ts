// SPDX-License-Identifier: Apache-2.0
/**
 * GATED trust-first contradiction-correctness harness (SUITE-04, Plan 99-04, Task 2).
 *
 * THE MEASUREMENT: for each constructed contradiction pair (an OLDER high-trust
 * fact + a NEWER low-trust contradicting claim), ingest BOTH into a REAL
 * `SqliteMemoryAdapter`, recall through the SHIPPED `createMemoryRecall` pipeline
 * with the shipped trust filter (`includeTrustLevels: ["system","learned"]`, so
 * the newer external claim is EXCLUDED — the strongest trust-first outcome) and a
 * nonzero `trustAlpha` (the `score.ts` `compareBoosted` tie-break), answer with
 * the answer model, and judge whether the answer reflects the OLDER high-trust
 * fact (trust-first won) or the newer low-trust claim (the failure the Phase-100
 * KG work must fix). The pure {@link scoreContradiction} folds the verdicts into
 * the trust-first-correct rate — the SUITE-04 metric the KG gate consumes.
 *
 * Comis's invariant is trust-FIRST, recency-SECOND: a newer low-trust claim must
 * NEVER supersede an older high-trust fact. This harness proves the SHIPPED
 * behavior does the right thing on the constructed pairs.
 *
 * GUIDANCE BLOCK (CONTRA-01): the plan anticipated prepending
 * `buildTemporalGuidanceBlock(...)` (the read-time "higher-TRUST wins even if
 * older" instruction the production injector adds). That symbol is NOT on the
 * `@comis/agent` barrel and does not exist as a source symbol in this checkout, so
 * — per the plan's documented fallback — this harness measures the trust-first
 * property via the recall RANKING + trust FILTER ONLY; the guidance-block property
 * is left to its own unit test. See 99-04-SUMMARY.md.
 *
 * GATING: the whole describe is `describe.skipIf(!COMIS_BENCH)` — keyless CI skips
 * it entirely (the pure {@link scoreContradiction} test is the keyless signal).
 * The structural witness (no provider needed) lives inside the gated describe
 * because it imports `@comis/memory` (the agent↛memory cut escape); keyless value
 * is the scorer unit test.
 *
 * @module
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEmbeddingProvider,
  createLocalRerankerProvider,
  SqliteMemoryAdapter,
} from "@comis/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// NOTE: @comis/memory is imported ONLY in this .bench.test.ts (the agent↛memory cut escape).
import {
  createMemoryRecall,
  type MemoryRecall,
  type MemoryRecallDeps,
} from "../../../rag/memory-recall.js";
import { buildAnswerPrompt, formatAnswerContext } from "./qa-answer-prompt.js";
import { aggregateAccuracy, type CategorizedVerdict } from "./qa-accuracy.js";
import { buildJudgePrompt } from "./qa-judge-prompt.js";
import { parseJudgeVerdict } from "./qa-judge-parse.js";
import { scoreContradiction } from "./contradiction-scorer.js";
import { buildContradictionPairs, type ContradictionPair } from "./suite-scenario.js";
import { buildSuiteReport } from "./suite-report.js";

const COMIS_BENCH = process.env.COMIS_BENCH === "1";
const ANSWER_MODEL = process.env.COMIS_BENCH_ANSWER_MODEL;
const JUDGE_MODEL = process.env.COMIS_BENCH_JUDGE_MODEL;

const BENCH_SESSION_KEY = "bench-session";

/** A FIXED epoch-ms clock so the harness is deterministic (no wall-clock read). */
const FIXED_NOW_MS = Date.UTC(2024, 0, 15, 12, 0, 0);

interface ContradictionStore {
  readonly adapter: SqliteMemoryAdapter;
  readonly recall: MemoryRecall;
  readonly dbDir: string;
}

function makeBenchConfig(
  overrides: Partial<MemoryRecallDeps["config"]> = {},
): MemoryRecallDeps["config"] {
  return {
    maxResults: 10,
    minScore: 0,
    recencyHalfLifeMs: 0,
    // Recency OFF as a sort lever; trust is the deciding factor (trust-FIRST).
    recencyAlpha: 0,
    // Nonzero trust weight — the shipped value; exercises the compareBoosted
    // tie-break so the older high-trust memory out-ranks a newer low-trust one
    // at equal base relevance.
    trustAlpha: 0.1,
    usefulnessAlpha: 0,
    usefulnessHalfLifeMs: 0,
    // Shipped default: external excluded — the strongest trust-first outcome.
    includeTrustLevels: ["system", "learned"],
    enableQueryExpansion: false,
    expansionConcurrency: 1,
    rerankCandidatePoolSize: 50,
    minKeywordScore: 0,
    ...overrides,
  };
}

/**
 * Ingest a contradiction pair into a fresh tmp store (T-99-04-01: never ~/.comis;
 * closed per pair). The OLDER high-trust fact is stored at its `trustLevel`
 * (system/learned) with its earlier `createdAt`; the NEWER low-trust claim is
 * stored as `external` with its later `createdAt` — so the contradiction is REAL
 * and the trust-first behavior must keep the older high-trust fact on top.
 */
async function ingestPair(
  pair: ContradictionPair,
  includeTrustLevels: MemoryRecallDeps["config"]["includeTrustLevels"],
): Promise<ContradictionStore> {
  const dbDir = mkdtempSync(join(tmpdir(), "comis-bench-contra-"));
  const dbPath = join(dbDir, "memory.db");
  const adapter = new SqliteMemoryAdapter({ dbPath });
  await adapter.init();

  const embedding = createEmbeddingProvider({ provider: "local" });
  const reranker = createLocalRerankerProvider();

  const olderRes = await adapter.store({
    content: pair.olderHighTrustDoc.content,
    source: "agent",
    trustLevel: pair.olderHighTrustDoc.trustLevel,
    createdAt: pair.olderHighTrustDoc.createdAt,
  });
  if (!olderRes.ok) throw new Error(`older high-trust ingest failed: ${String(olderRes.error)}`);

  const newerRes = await adapter.store({
    content: pair.newerLowTrustDoc.content,
    source: "agent",
    trustLevel: pair.newerLowTrustDoc.trustLevel,
    createdAt: pair.newerLowTrustDoc.createdAt,
  });
  if (!newerRes.ok) throw new Error(`newer low-trust ingest failed: ${String(newerRes.error)}`);

  const deps: MemoryRecallDeps = {
    adapter,
    embeddingProvider: embedding,
    rerankerProvider: reranker,
    config: makeBenchConfig({ includeTrustLevels }),
    clock: { nowMs: () => FIXED_NOW_MS },
  };
  const recall = createMemoryRecall(deps);
  return { adapter, recall, dbDir };
}

describe.skipIf(!COMIS_BENCH)("trust-first contradiction correctness (gated)", () => {
  const pairs = buildContradictionPairs();

  afterAll(() => {
    // per-pair stores are cleaned inline; nothing global to tear down.
  });

  beforeAll(async () => {
    // Warm the local embedding/reranker model once so a slow first-load does not
    // count against a per-pair lane (the 2h budget mirrors the sibling harnesses).
    if (pairs.length === 0) throw new Error("no contradiction pairs");
    const store = await ingestPair(pairs[0]!, ["system", "learned"]);
    try {
      const warm = await store.recall.recall(pairs[0]!.query, BENCH_SESSION_KEY);
      if (!warm.ok) throw new Error(`warmup recall failed: ${String(warm.error)}`);
    } finally {
      rmSync(store.dbDir, { recursive: true, force: true });
    }
  }, 7_200_000);

  it(
    "measures trust-first contradiction correctness (older high-trust fact wins)",
    async () => {
      const haveAnswer = ANSWER_MODEL !== undefined && ANSWER_MODEL !== "";
      const haveJudge = JUDGE_MODEL !== undefined && JUDGE_MODEL !== "";
      if (!haveAnswer || !haveJudge) {
        // eslint-disable-next-line no-console -- bench skip notice
        console.log(
          "BENCH trust-first contradiction skipped: set COMIS_BENCH_ANSWER_MODEL + COMIS_BENCH_JUDGE_MODEL",
        );
        return;
      }

      const { completeSimple, getModel } = await import("@earendil-works/pi-ai");
      const verdicts: CategorizedVerdict[] = [];
      const evidence: Array<Record<string, unknown>> = [];

      for (const pair of pairs) {
        const store = await ingestPair(pair, ["system", "learned"]);
        try {
          const recalled = await store.recall.recall(pair.query, BENCH_SESSION_KEY);
          if (!recalled.ok) throw new Error(`recall failed: ${String(recalled.error)}`);
          const ranked = recalled.value;
          const context = formatAnswerContext(
            ranked.map((r) => ({ content: r.entry.content, score: r.score })),
          );

          const answerPrompt = buildAnswerPrompt(pair.query, context);
          const answer = await completeSimple({
            model: getModel(ANSWER_MODEL),
            messages: [{ role: "user", content: answerPrompt }],
          });
          const answerText = typeof answer === "string" ? answer : String(answer);

          // Grade against the OLDER high-trust fact (the knowledge-update rubric is
          // the closest fit: the LATEST fact is correct UNLESS a higher-trust
          // source says otherwise — here the higher-trust source is OLDER).
          const judgePrompt = buildJudgePrompt(
            "knowledge-update",
            pair.query,
            pair.correctAnswerSubstring,
            answerText,
          );
          const judgeRaw = await completeSimple({
            model: getModel(JUDGE_MODEL),
            messages: [{ role: "user", content: judgePrompt }],
          });
          const judgeText = typeof judgeRaw === "string" ? judgeRaw : String(judgeRaw);
          const verdict = parseJudgeVerdict(judgeText);
          verdicts.push({
            category: "trust-first-contradiction",
            correct: verdict.correct,
            invalid: verdict.invalid,
          });
          evidence.push({
            query: pair.query,
            // Evidence: did the external contradiction get filtered, and did the
            // high-trust fact survive at the top of the ranked list?
            rankedTrust: ranked.map((r) => r.entry.trustLevel),
          });
        } finally {
          rmSync(store.dbDir, { recursive: true, force: true });
        }
      }

      const score = scoreContradiction(verdicts);
      const acc = aggregateAccuracy(verdicts);
      // eslint-disable-next-line no-console -- bench observability
      console.log("BENCH trust-first contradiction", JSON.stringify(score));

      const report = buildSuiteReport(
        {
          tier: "trust-contradiction",
          harnessVersion: "phase-99-v1",
          abilities: [{ ability: "older-high-trust-wins", result: acc }],
        },
        Date.now(),
      );
      const reportJson = JSON.stringify(report);
      expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);

      // Write the report to a confined temp dir (never ~/.comis) — T-99-04-02.
      const { writeRegularFile } = await import("@comis/observability");
      const reportDir = mkdtempSync(join(tmpdir(), "comis-bench-contra-report-"));
      const writeRes = await writeRegularFile({
        baseDir: reportDir,
        relativePath: "trust-contradiction-report.json",
        contents: reportJson,
      });
      if (!writeRes.ok) throw new Error(`report write failed: ${String(writeRes.error)}`);

      // Structural assertions only (the rate itself is a measurement, not a gate).
      expect(score.trustFirstCorrectRate).toBeGreaterThanOrEqual(0);
      expect(score.trustFirstCorrectRate).toBeLessThanOrEqual(100);
      expect(score.validTotal).toBe(score.total - score.invalid);
      rmSync(reportDir, { recursive: true, force: true });
    },
    7_200_000,
  );

  it(
    "recall keeps the older high-trust fact and excludes the newer low-trust claim",
    async () => {
      // No-LLM structural witness of the SHIPPED trust-first behavior: with the
      // shipped trust filter ["system","learned"], the NEWER external
      // contradiction is excluded entirely (the strongest trust-first outcome),
      // while the OLDER high-trust fact survives in the ranked recall. This proves
      // the trust filter + ladder do the right thing without any provider.
      let witnessed = 0;
      for (const pair of pairs) {
        const store = await ingestPair(pair, ["system", "learned"]);
        try {
          const recalled = await store.recall.recall(pair.query, BENCH_SESSION_KEY);
          if (!recalled.ok) throw new Error(`recall failed: ${String(recalled.error)}`);
          const ranked = recalled.value;
          const trustLevels = ranked.map((r) => r.entry.trustLevel);
          // The newer external (low-trust) contradiction must NOT appear.
          expect(trustLevels).not.toContain("external");
          // The older high-trust fact must survive recall.
          const olderPresent = ranked.some(
            (r) => r.entry.content === pair.olderHighTrustDoc.content,
          );
          expect(olderPresent).toBe(true);
          witnessed += 1;
        } finally {
          rmSync(store.dbDir, { recursive: true, force: true });
        }
      }
      expect(witnessed).toBeGreaterThan(0);
    },
  );
});
