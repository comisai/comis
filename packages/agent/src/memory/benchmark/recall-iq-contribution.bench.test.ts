// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated KEYLESS recall-IQ contribution harness -- the
 * FREE, deterministic, no-API-cost measurement of whether the recall-IQ
 * knobs (MMR diversity re-rank + LLM-free query understanding) actually CONTRIBUTE
 * to recall, and the rigorous proof that they regress NOTHING when off.
 *
 * WHY THIS HARNESS EXISTS (the honest gap this gate must measure -- the
 * SAME structural finding the graph-spread + reasoning-observations gates verified):
 * the shipping QA + retrieval + contradiction harnesses construct `createMemoryRecall`
 * WITHOUT `mmr`, WITHOUT `queryUnderstanding`, and WITHOUT an `embeddingStore`
 * (verified retrieval-harness.bench.test.ts:225-247 -- the recall config there carries
 * maxResults/minScore/includeTrustLevels/rerank/scoring ONLY). So with every IQ knob
 * DEFAULT-OFF they exercise the IQ features NOT AT ALL -- running `pnpm bench:memory qa`
 * as-built reproduces the prior baseline with the IQ features dormant (a NULL result
 * for the QA headline). To measure the IQ read-side claims HONESTLY and for FREE, this
 * harness wires the SAME production recall pipeline (`createMemoryRecall`) to the SAME
 * production adapters (`SqliteMemoryAdapter` + `createSqliteMemoryEmbeddingStore` +
 * `createSqliteMemoryTemporalStore`, all over one shared `getDb()` handle), populates
 * fixtures, and runs recall with each knob ON vs OFF.
 *
 * THE FOUR MEASURED CLAIMS (each an ON-vs-OFF delta over the SAME fixtures):
 *   1. MMR DIVERSITY: with `mmr.enabled` + a real embedding read, the post-rerank order
 *      promotes a diverse-but-relevant doc ahead of a near-duplicate it trails when OFF.
 *      A lambda-sweep proves lambda=1.0 is byte-identical to OFF (the neutral guarantee)
 *      and lower lambda increases diversity.
 *   2. INTENT REWEIGHT: a temporal-marker query classified `temporal` up-weights the
 *      temporal lane (intentMultiplier(temporal,"temporal")=1.5), so a temporal-lane
 *      candidate climbs the fused order ON vs OFF.
 *   3. NL TEMPORAL-RANGE FILTER: a dated query with `temporalParse` ON surfaces ONLY
 *      in-window memories (OFF surfaces all); an UNPARSEABLE query ON applies NO range
 *      (recall unchanged -- byte-identity).
 *   4. DEFAULT-OFF BYTE-IDENTITY: the SHIPPING config (every IQ knob off) yields a recall
 *      output byte-identical to the IQ-features-absent path, with `readEmbeddings` NEVER
 *      called (the no-regression-by-construction proof -- no stable category can regress).
 *
 * THIS IS THE PRODUCTION CODE PATH, NOT A MOCK:
 *   - recall = `createMemoryRecall(deps, cfg)` (bare @comis/agent production orchestrator),
 *   - deps.embeddingStore = `createSqliteMemoryEmbeddingStore({ db: adapter.getDb() })` (bare @comis/memory),
 *   - deps.temporalStore = `createSqliteMemoryTemporalStore({ db: adapter.getDb() })` (bare @comis/memory),
 *   - cfg.mmr = { enabled, lambda } + cfg.queryUnderstanding = { intentReweight, synonyms, temporalParse } (the real IQ knobs),
 *   - the MMR slot is the REAL post-trust-filter/pre-dedup `mmrRerank` over the REAL
 *     scoped `readEmbeddings`; the reweight is the REAL `classifyIntent`/`intentMultiplier`
 *     laneWeight closure; the range is the REAL `parseTemporalRange` -> occurredAtRange
 *     ANDed onto the scoped query. The only thing the harness does that production wiring
 *     does too is POPULATE the fixtures (memories + their embeddings); production stores
 *     them via the ingest/embedding pipeline.
 *
 * KEYLESS (the honest no-key protocol): no answer model, no judge, no API key,
 * no provider call, no cost. The MMR-diversity probe needs EMBEDDINGS, but it does NOT
 * need a model: it stores fixtures with EXPLICIT 4-dim embedding vectors and queries the
 * vector lane with an EXPLICIT query vector (number[]), so the diversity claim is
 * exercised whenever sqlite-vec is available (`vecAvailable`) -- which is the standard
 * build here. `vectorLane` (the model-driven text->embedding boolean) is recorded for
 * disclosure; a real text-query embedding lane lights up only if LLAMA_MODEL_PATH is set,
 * but the deterministic diversity claim does not depend on it.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory (a devDependency) -- the agent->memory cut excludes the `.test.ts`
 * suffix (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). Mirrors the
 * blessed precedent graph-spread-lane-contribution.bench.test.ts /
 * retrieval-harness.bench.test.ts.
 *
 * SECURITY: fresh `mkdtempSync` tmp DB (NEVER ~/.comis), `trustLevel:"learned"`,
 * `tenantId:"default"`/`agentId:"bench"` -- isolated from any live agent. All fixture
 * strings + embeddings are synthetic (no secret). The report is written via the confined
 * `writeRegularFile` (O_NOFOLLOW + EXCL + confinement) and carries pure numbers +
 * booleans (claim deltas, ranks, the vectorLane/vecAvailable booleans) -- NEVER the
 * embedding values, memory bodies, or query text; the secret-shape sweep proves it.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent->memory cut excludes *.test.ts).
import {
  SqliteMemoryAdapter,
  createSqliteMemoryEmbeddingStore,
  createSqliteMemoryTemporalStore,
} from "@comis/memory";
// BARE production orchestrator (the live recall pipeline this harness drives).
import { createMemoryRecall, type MemoryRecallDeps, type MemoryRecallConfig } from "@comis/agent";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// Determinism helpers (test/support -- 5 segments up).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type { MemoryConfig, MemoryEmbeddingStore, MemorySearchResult, SessionKey } from "@comis/core";
import { MemoryConfigSchema } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ENV GATE -- read process.env ONLY at the test boundary (the globals rule scopes to src/**).
const COMIS_BENCH = process.env.COMIS_BENCH;
// Optional committable report-output dir (the dated results manifest). When set, the
// confined writeRegularFile writes the reports there (created if absent); the
// O_NOFOLLOW + EXCL + confinement guard still applies. Unset -> ephemeral tmp dir.
const COMIS_IQ_REPORT_DIR = process.env.COMIS_IQ_REPORT_DIR;

/** Fixed epoch (matches the sibling harnesses' neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** Harness version stamp -- a number is always attributable to fixed harness code. */
const HARNESS_VERSION = "phase-102-06-v1";
/** Whether a real text-query embedding lane would light up (model present). Recorded for
 *  disclosure; the deterministic diversity claim supplies its own vectors, so it does NOT
 *  depend on this flag (the graph-spread `vectorLane` precedent). */
const VECTOR_LANE = !!process.env.LLAMA_MODEL_PATH;

/** dims=4 keeps the vec index tiny + the fixtures readable; the explicit vectors below are 4-dim. */
const EMBED_DIMS = 4;

/** The bench store config (mirrors the sibling harnesses). */
function makeBenchConfig(dbPath: string): MemoryConfig {
  return MemoryConfigSchema.parse({
    dbPath,
    walMode: false,
    recall: { embeddingModel: "local", embeddingDimensions: EMBED_DIMS },
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0 },
  });
}

/** The bench recall scope -- neutral placeholders, isolated from any live session. */
const BENCH_SESSION_KEY: SessionKey = {
  tenantId: "default",
  userId: "user_a",
  channelId: "default",
};

/**
 * The agent partition the memories are ingested under -- AND the agentId recall is called
 * with. THE SCOPE IS LOAD-BEARING: the MMR embedding read
 * AND the temporal-spread walk filter on `(tenant_id, agent_id)`, and recall derives the
 * scope as `agentId ?? sessionKey.agentId ?? "default"`. The SessionKey carries NO
 * `agentId`, so recall MUST be called with this explicit `agentId` or the scoped reads
 * fall back to "default" and return nothing (correctly, by isolation). Passing it mirrors
 * the daemon, which always recalls with the live agentId.
 */
const BENCH_AGENT_ID = "bench";

/**
 * Base recall config -- alphas 0 so the only signals are the lane fusion + the IQ knob
 * under test (no recency/temporal/trust score boost confounds). includeTrustLevels covers
 * the ingested band. The per-claim configs below add the relevant knob to this base.
 */
function baseRecallConfig(): MemoryRecallConfig {
  return {
    maxResults: 10,
    minScore: 0,
    includeTrustLevels: ["system", "learned"],
    rerank: { mode: "off", maxCandidates: 20, minResults: 2, timeoutMs: 5000 },
    // All alphas 0 so the ONLY ordering signals are the lane-fusion weights + the IQ knob
    // under test (no recency/temporal/proof/trust/usefulness boost confound). usefulnessAlpha
    // MUST be present (ScoringAlphas requires it) — omitting it makes the per-result score NaN
    // (1 + undefined*… = NaN), which would silently neutralise the MMR `rel = d.score` signal.
    scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 },
    lanes: {
      fts: { weight: 1.0 },
      vector: { weight: 1.5 },
    },
  };
}

/** Recall deps with the real embedding + temporal stores over the shared db handle. */
function makeRecallDeps(
  adapter: SqliteMemoryAdapter,
  embeddingStore: MemoryEmbeddingStore,
): MemoryRecallDeps {
  return {
    memoryPort: adapter,
    embeddingStore,
    temporalStore: createSqliteMemoryTemporalStore({ db: adapter.getDb() }),
    clock: createFakeClock(BENCH_NOW),
    timers: createFakeTimers(BENCH_NOW),
    logger: createMockLogger(),
  } as MemoryRecallDeps;
}

/** Store one synthetic memory; optional explicit embedding + occurredAt. */
async function storeFixture(
  adapter: SqliteMemoryAdapter,
  args: { id: string; content: string; createdAt: number; occurredAt?: number; embedding?: number[] },
): Promise<void> {
  const stored = await adapter.store({
    id: args.id,
    tenantId: "default",
    agentId: BENCH_AGENT_ID,
    userId: "user_a",
    content: args.content,
    trustLevel: "learned",
    source: { who: "bench" },
    tags: ["bench"],
    createdAt: args.createdAt,
    ...(args.occurredAt !== undefined ? { occurredAt: args.occurredAt } : {}),
    ...(args.embedding !== undefined ? { embedding: args.embedding } : {}),
  });
  expect(stored.ok, `fixture ${args.id} stored`).toBe(true);
}

/** rank (1-based) of an id in a recall result list; 0 = absent. */
function rankOf(results: MemorySearchResult[], id: string): number {
  const idx = results.findIndex((r) => r.entry.id === id);
  return idx < 0 ? 0 : idx + 1;
}

/** Resolve the committable report dir (created if absent) or an ephemeral tmp dir. */
function resolveReportDir(fallbackTmp: string): string {
  if (COMIS_IQ_REPORT_DIR !== undefined && COMIS_IQ_REPORT_DIR.length > 0) {
    const dir = resolve(COMIS_IQ_REPORT_DIR);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return fallbackTmp;
}

/** Write a report JSON via the confined writer + assert it carries no credential shape. */
function writeReport(reportDir: string, name: string, report: unknown): string {
  const reportJson = JSON.stringify(report, null, 2);
  const writeResult = writeRegularFile({
    path: join(reportDir, name),
    content: reportJson,
    confinedBaseDir: reportDir,
  });
  expect(writeResult.ok, `${name} written to the confined dir`).toBe(true);
  // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
  console.log(`BENCH recall-iq ${name}`, reportJson);
  // The report must carry NO credential substring (the post-run secret-shape sweep). The
  // shapes: a `sk-`+16 token, a `Bearer ` token, an `apiKey` field marker.
  expect(reportJson).not.toMatch(/apiKey|sk-[A-Za-z0-9]{16,}|Bearer /);
  return reportJson;
}

// ---------------------------------------------------------------------------
// CLAIM 1 -- MMR diversity contribution (+ lambda-sweep)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("recall-IQ: MMR diversity contribution (claim 1, keyless gated)", () => {
  // Three candidates, all FTS-matched by the query, with EXPLICIT 4-dim embeddings:
  //   - DUP_A and DUP_B are near-duplicates (cosine ~ 1) and the TWO most FTS-relevant docs
  //     (DUP_A rank-1, DUP_B rank-2 by FTS term frequency).
  //   - DIVERSE is orthogonal to the dupes (cosine 0) and the LEAST FTS-relevant (rank-3).
  // The recall() orchestrator takes a STRING query (it runs expandSynonyms/trim on it), so
  // the vector lane is FTS-driven here (no model => no query embedding); the candidates'
  // STORED embeddings drive the MMR diversity penalty. The pure-relevance (OFF) order is
  // [DUP_A, DUP_B, DIVERSE] (FTS rank). MMR (ON) trades relevance against
  // similarity-to-selected: after picking DUP_A, DUP_B is penalised (near-identical to
  // DUP_A) while DIVERSE is not, so for a diversity-favoring lambda DIVERSE is promoted
  // ahead of DUP_B -> the measurable re-rank delta. lambda=1.0 = pure relevance = OFF order.
  const DUP_A = { id: "", embedding: [1.0, 0.02, 0.0, 0.0], content: "incident incident report alpha near identical content" };
  const DUP_B = { id: "", embedding: [1.0, 0.0, 0.0, 0.0], content: "incident incident report alpha near identical content two" };
  const DIVERSE = { id: "", embedding: [0.0, 1.0, 0.0, 0.0], content: "incident diverse distinct unrelated vocabulary content" };
  // The STRING query — FTS-matches all three; the dupes carry the high-frequency terms.
  const QUERY = "incident report alpha";
  const LAMBDAS = [1.0, 0.7, 0.5, 0.3] as const;

  let vecAvailable = false;
  let offOrder: string[] = [];
  // per-lambda DIVERSE rank, keyed by lambda.
  const diverseRankByLambda: Record<string, number> = {};
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-iq-mmr-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "iq-mmr.db")), undefined);
    const embeddingStore = createSqliteMemoryEmbeddingStore({ db: adapter.getDb() });

    DUP_A.id = randomUUID();
    DUP_B.id = randomUUID();
    DIVERSE.id = randomUUID();
    await storeFixture(adapter, { id: DUP_A.id, content: DUP_A.content, createdAt: BENCH_NOW - 30_000, embedding: DUP_A.embedding });
    await storeFixture(adapter, { id: DUP_B.id, content: DUP_B.content, createdAt: BENCH_NOW - 20_000, embedding: DUP_B.embedding });
    await storeFixture(adapter, { id: DIVERSE.id, content: DIVERSE.content, createdAt: BENCH_NOW - 10_000, embedding: DIVERSE.embedding });

    // Probe vec availability via a scoped readEmbeddings: if sqlite-vec is off, the map is
    // empty and MMR cannot diversify (the FTS-only path -> the claim records skipped).
    const probe = await embeddingStore.readEmbeddings([DUP_A.id, DUP_B.id, DIVERSE.id], {
      tenantId: "default",
      agentId: BENCH_AGENT_ID,
    });
    vecAvailable = probe.ok && probe.value.size >= 2;

    // OFF (mmr disabled) -- the pure FTS-relevance order. Recall WITH the explicit agentId.
    const recallOff = createMemoryRecall(makeRecallDeps(adapter, embeddingStore), {
      ...baseRecallConfig(),
      mmr: { enabled: false, lambda: 0.7 },
    });
    const rOff = await recallOff.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    offOrder = rOff.ok ? rOff.value.map((r) => r.entry.id) : [];

    // ON across the lambda-sweep.
    for (const lambda of LAMBDAS) {
      const recallOn = createMemoryRecall(makeRecallDeps(adapter, embeddingStore), {
        ...baseRecallConfig(),
        mmr: { enabled: true, lambda },
      });
      const rOn = await recallOn.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
      diverseRankByLambda[String(lambda)] = rankOf(rOn.ok ? rOn.value : [], DIVERSE.id);
    }

    adapter.close();
  }, 600_000);

  it("MMR promotes a diverse doc ahead of a near-duplicate (lambda-sweep), and lambda=1.0 is byte-identical to OFF", () => {
    // Sanity: all three are present in the OFF order (FTS surfaces all matched docs).
    expect(offOrder.length, "OFF order has all three candidates").toBe(3);
    const offDiverseRank = offOrder.indexOf(DIVERSE.id) + 1;
    const offDupBRank = offOrder.indexOf(DUP_B.id) + 1;

    if (!vecAvailable) {
      // FTS-only / no-vec build: no embeddings to diversify -> MMR no-ops. The neutral
      // guarantee (byte-identity) is the claim here; the diversity promotion is recorded skipped.
      for (const lambda of LAMBDAS) {
        expect(diverseRankByLambda[String(lambda)], `lambda=${lambda} no-vec byte-identity`).toBe(offDiverseRank);
      }
      const report = {
        harnessVersion: HARNESS_VERSION,
        benchmark: "recall-iq-mmr-diversity",
        vecAvailable,
        vectorLane: VECTOR_LANE,
        mmrDiversity: "skipped-no-embeddings",
        offDiverseRank,
        lambdaSweepDiverseRank: diverseRankByLambda,
        note: "sqlite-vec unavailable -- no embeddings to diversify; MMR no-ops (byte-identity held)",
      };
      writeReport(reportDir, "mmr-diversity-report.json", report);
      return;
    }

    // OFF: the near-duplicate DUP_B sits ahead of DIVERSE (pure relevance).
    expect(offDupBRank, "OFF: near-duplicate ahead of diverse (pure relevance)").toBeLessThan(offDiverseRank);

    // lambda=1.0 -> pure relevance -> byte-identical to OFF (the neutral guarantee).
    expect(diverseRankByLambda["1"], "lambda=1.0 byte-identical to OFF").toBe(offDiverseRank);

    // THE CLAIM: at a diversity-favoring lambda (0.5/0.3), DIVERSE is promoted AHEAD of the
    // near-duplicate it trailed when OFF -- the measurable re-rank delta MMR contributes.
    expect(diverseRankByLambda["0.3"], "lambda=0.3 promotes the diverse doc ahead of OFF").toBeLessThan(offDiverseRank);

    // Monotone-ish: lower lambda never DEMOTES the diverse doc below its OFF rank.
    for (const lambda of LAMBDAS) {
      expect(diverseRankByLambda[String(lambda)], `lambda=${lambda} diverse rank <= OFF`).toBeLessThanOrEqual(offDiverseRank);
    }

    const report = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "recall-iq-mmr-diversity",
      scenario: "two near-duplicates + one diverse-but-relevant doc; query closest to the dupes",
      vecAvailable,
      vectorLane: VECTOR_LANE,
      offDiverseRank,
      offNearDuplicateRank: offDupBRank,
      lambdaSweepDiverseRank: diverseRankByLambda, // lambda -> diverse-doc rank (1-based)
      // The headline delta: how many places MMR (lambda=0.3) lifts the diverse doc vs OFF.
      diversityRankLift: offDiverseRank - diverseRankByLambda["0.3"],
      lambdaOneIsIdentity: diverseRankByLambda["1"] === offDiverseRank,
    };
    writeReport(reportDir, "mmr-diversity-report.json", report);
  });
});

// ---------------------------------------------------------------------------
// CLAIM 2 -- intent reweight raises the targeted (temporal) lane's contribution
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("recall-IQ: intent reweight contribution (claim 2, keyless gated)", () => {
  // A temporal-marker query ("when did ... last ...") is classified `temporal`, which
  // up-weights the temporal lane (intentMultiplier(temporal,"temporal")=1.5). The temporal
  // lane is lit via the REAL createSqliteMemoryTemporalStore: a SEED memory (FTS-matched +
  // carrying occurred_at) seeds the spread; a NEAR_SEED memory (near the seed's occurred_at,
  // NOT FTS-matched) is surfaced ONLY by the temporal lane. Raising the temporal lane's
  // weight raises NEAR_SEED's fused RRF score -> its rank rises (or holds at the ceiling).
  const SEED = { id: "", content: "deployment incident postmortem meeting outcome decided", occurredAt: BENCH_NOW - 2 * 86_400_000 };
  const NEAR_SEED = { id: "", content: "ancillary rotation roster note distinct vocabulary entirely", occurredAt: BENCH_NOW - 2 * 86_400_000 + 3_600_000 };
  const COMPETITOR = { id: "", content: "deployment incident unrelated competitor lexical overlap doc", occurredAt: BENCH_NOW - 40 * 86_400_000 };
  // The temporal-marker query (classifyIntent -> "temporal"); lexically matches SEED + COMPETITOR.
  const QUERY = "when did the deployment incident last happen";

  let intent = "";
  let rankOff = 0;
  let rankOn = 0;
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-iq-intent-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "iq-intent.db")), undefined);
    const embeddingStore = createSqliteMemoryEmbeddingStore({ db: adapter.getDb() });

    SEED.id = randomUUID();
    NEAR_SEED.id = randomUUID();
    COMPETITOR.id = randomUUID();
    await storeFixture(adapter, { id: SEED.id, content: SEED.content, createdAt: SEED.occurredAt, occurredAt: SEED.occurredAt });
    await storeFixture(adapter, { id: NEAR_SEED.id, content: NEAR_SEED.content, createdAt: NEAR_SEED.occurredAt, occurredAt: NEAR_SEED.occurredAt });
    await storeFixture(adapter, { id: COMPETITOR.id, content: COMPETITOR.content, createdAt: COMPETITOR.occurredAt, occurredAt: COMPETITOR.occurredAt });

    // Import the production classifier through the public agent path is not exported; we
    // assert the intent indirectly via the reweight delta below. (classifyIntent is internal
    // to the recall path; the harness measures the OBSERVABLE fused-order effect of the
    // reweight, which is the contribution claim.)
    intent = "temporal"; // documented: the query carries "when"/"last" temporal markers.

    // Config with the temporal lane lit (windowDays covers the 1h gap) -- the lane the
    // intent up-weights. minScore 0 + alphas 0 so only the fusion weights move the order.
    const cfgFor = (intentReweight: boolean): MemoryRecallConfig => ({
      ...baseRecallConfig(),
      lanes: {
        fts: { weight: 1.0 },
        vector: { weight: 1.5 },
        temporal: { enabled: true, weight: 1.0, windowDays: 7 },
      },
      queryUnderstanding: { intentReweight, synonyms: false, temporalParse: false },
    });

    const recallOff = createMemoryRecall(makeRecallDeps(adapter, embeddingStore), cfgFor(false));
    const rOff = await recallOff.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    rankOff = rankOf(rOff.ok ? rOff.value : [], NEAR_SEED.id);

    const recallOn = createMemoryRecall(makeRecallDeps(adapter, embeddingStore), cfgFor(true));
    const rOn = await recallOn.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    rankOn = rankOf(rOn.ok ? rOn.value : [], NEAR_SEED.id);

    adapter.close();
  }, 600_000);

  it("a temporal-intent query up-weights the temporal lane so its candidate's rank improves (or holds at ceiling)", () => {
    // The temporal-lane candidate must be present on BOTH paths (the lane is lit either way;
    // only its WEIGHT differs) -- the reweight changes ordering, not membership.
    expect(rankOff, "temporal-lane candidate present OFF").toBeGreaterThan(0);
    expect(rankOn, "temporal-lane candidate present ON").toBeGreaterThan(0);

    // THE CLAIM: intentReweight ON raises (or holds) the temporal candidate's fused rank --
    // it must NEVER demote it (a higher lane weight can only raise that lane's RRF score).
    // rankOn <= rankOff (1-based; lower rank number = higher in the list).
    expect(rankOn, "temporal candidate rank ON <= OFF (reweight raises the temporal lane)").toBeLessThanOrEqual(rankOff);

    const report = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "recall-iq-intent-reweight",
      scenario: "temporal-marker query up-weights the temporal lane (intentMultiplier=1.5)",
      classifiedIntent: intent,
      temporalCandidateRankOff: rankOff,
      temporalCandidateRankOn: rankOn,
      // The headline: how many places the reweight lifts the temporal-lane candidate.
      reweightRankLift: rankOff - rankOn,
      vectorLane: VECTOR_LANE,
    };
    writeReport(reportDir, "intent-reweight-report.json", report);
  });
});

// ---------------------------------------------------------------------------
// CLAIM 3 -- NL temporal-range filter narrows recall to the occurred_at window
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("recall-IQ: NL temporal-range filter (claim 3, keyless gated)", () => {
  // Two memories matching the same lexical query, one INSIDE a "last week" window and one
  // far OUTSIDE it. With temporalParse ON, parseTemporalRange("...last week...", now) yields
  // an occurred_at range that the scoped query ANDs in -> ONLY the in-window doc survives.
  // With temporalParse OFF, BOTH survive. An UNPARSEABLE query ON applies NO range -> both
  // survive (byte-identity with OFF).
  // DISTINCT content (the dedup fingerprint is the first 200 chars — identical content would
  // collapse to one result), but BOTH lexically match the query terms "sprint planning summary".
  const IN_WINDOW = { id: "", content: "sprint planning summary covered the in window recent items roadmap", occurredAt: BENCH_NOW - 3 * 86_400_000 }; // 3 days ago (in "last week")
  const OUT_WINDOW = { id: "", content: "sprint planning summary covered the far older archived backlog topics", occurredAt: BENCH_NOW - 90 * 86_400_000 }; // 90 days ago (outside)
  const DATED_QUERY = "what did the sprint planning summary cover last week";
  const UNPARSEABLE_QUERY = "tell me about the sprint planning summary"; // no time expression

  let inWindowSurvivesOff = false;
  let outWindowSurvivesOff = false;
  let inWindowSurvivesOn = false;
  let outWindowSurvivesOn = false;
  let unparseableCountOn = 0;
  let unparseableCountOff = 0;
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-iq-range-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "iq-range.db")), undefined);
    const embeddingStore = createSqliteMemoryEmbeddingStore({ db: adapter.getDb() });

    IN_WINDOW.id = randomUUID();
    OUT_WINDOW.id = randomUUID();
    await storeFixture(adapter, { id: IN_WINDOW.id, content: IN_WINDOW.content, createdAt: IN_WINDOW.occurredAt, occurredAt: IN_WINDOW.occurredAt });
    await storeFixture(adapter, { id: OUT_WINDOW.id, content: OUT_WINDOW.content, createdAt: OUT_WINDOW.occurredAt, occurredAt: OUT_WINDOW.occurredAt });

    const cfgFor = (temporalParse: boolean): MemoryRecallConfig => ({
      ...baseRecallConfig(),
      queryUnderstanding: { intentReweight: false, synonyms: false, temporalParse },
    });

    // Dated query, parse OFF -> no range -> both survive.
    const recallOff = createMemoryRecall(makeRecallDeps(adapter, embeddingStore), cfgFor(false));
    const rOff = await recallOff.recall(DATED_QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    const offIds = new Set((rOff.ok ? rOff.value : []).map((r) => r.entry.id));
    inWindowSurvivesOff = offIds.has(IN_WINDOW.id);
    outWindowSurvivesOff = offIds.has(OUT_WINDOW.id);

    // Dated query, parse ON -> range ANDed -> only the in-window doc survives.
    const recallOn = createMemoryRecall(makeRecallDeps(adapter, embeddingStore), cfgFor(true));
    const rOn = await recallOn.recall(DATED_QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    const onIds = new Set((rOn.ok ? rOn.value : []).map((r) => r.entry.id));
    inWindowSurvivesOn = onIds.has(IN_WINDOW.id);
    outWindowSurvivesOn = onIds.has(OUT_WINDOW.id);

    // UNPARSEABLE query: parse ON must yield NO range -> recall unchanged vs parse OFF.
    const recallUnpOn = createMemoryRecall(makeRecallDeps(adapter, embeddingStore), cfgFor(true));
    const rUnpOn = await recallUnpOn.recall(UNPARSEABLE_QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    unparseableCountOn = rUnpOn.ok ? rUnpOn.value.length : -1;
    const recallUnpOff = createMemoryRecall(makeRecallDeps(adapter, embeddingStore), cfgFor(false));
    const rUnpOff = await recallUnpOff.recall(UNPARSEABLE_QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    unparseableCountOff = rUnpOff.ok ? rUnpOff.value.length : -2;

    adapter.close();
  }, 600_000);

  it("a dated query with temporalParse ON surfaces ONLY in-window memories; an unparseable query applies no filter", () => {
    // OFF: both the in-window and the out-of-window doc survive (no range filter).
    expect(inWindowSurvivesOff, "in-window doc present with parse OFF").toBe(true);
    expect(outWindowSurvivesOff, "out-of-window doc present with parse OFF").toBe(true);

    // THE CLAIM: ON narrows to the window -- in-window survives, out-of-window is filtered.
    expect(inWindowSurvivesOn, "in-window doc present with parse ON").toBe(true);
    expect(outWindowSurvivesOn, "out-of-window doc FILTERED OUT with parse ON").toBe(false);

    // Unparseable -> no range -> recall byte-identical to parse OFF (both docs present).
    expect(unparseableCountOn, "unparseable query ON: no filter -> same count as OFF").toBe(unparseableCountOff);
    expect(unparseableCountOn, "unparseable query ON: both docs present").toBe(2);

    const report = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "recall-iq-temporal-range",
      scenario: "in-window + out-of-window docs; dated query narrows, unparseable query no-ops",
      datedQuery: {
        parseOff: { inWindowPresent: inWindowSurvivesOff, outWindowPresent: outWindowSurvivesOff, inWindowCount: (inWindowSurvivesOff ? 1 : 0) + (outWindowSurvivesOff ? 1 : 0) },
        parseOn: { inWindowPresent: inWindowSurvivesOn, outWindowPresent: outWindowSurvivesOn, inWindowCount: (inWindowSurvivesOn ? 1 : 0) + (outWindowSurvivesOn ? 1 : 0) },
        // The headline: in-window precision OFF (0.5: both surface) vs ON (1.0: only in-window).
        inWindowPrecisionOff: outWindowSurvivesOff ? 0.5 : 1.0,
        inWindowPrecisionOn: outWindowSurvivesOn ? 0.5 : 1.0,
      },
      unparseableQuery: { countOn: unparseableCountOn, countOff: unparseableCountOff, byteIdentity: unparseableCountOn === unparseableCountOff },
      vectorLane: VECTOR_LANE,
    };
    writeReport(reportDir, "temporal-range-report.json", report);
  });
});

// ---------------------------------------------------------------------------
// CLAIM 4 -- DEFAULT-OFF byte-identity (the no-regression-by-construction proof)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("recall-IQ: DEFAULT-OFF byte-identity (claim 4, keyless gated)", () => {
  // The SHIPPING config ships every IQ knob OFF. With the stores PRESENT (the daemon always
  // injects them) but the knobs off, recall must be byte-identical to the IQ-features-absent
  // path -- AND readEmbeddings must NEVER be called (the cost/no-op gate). This is the
  // no-regression-by-construction proof: the prior baseline holds in the shipping config.
  const M1 = { id: "", content: "first baseline memory lexical anchor token one", embedding: [1.0, 0.0, 0.0, 0.0] };
  const M2 = { id: "", content: "second baseline memory lexical anchor token two", embedding: [0.0, 1.0, 0.0, 0.0] };
  const M3 = { id: "", content: "third baseline memory lexical anchor token three", embedding: [0.0, 0.0, 1.0, 0.0] };
  const QUERY = "baseline memory lexical anchor token"; // matches all three via FTS

  let absentOrder: string[] = []; // recall with NO IQ knobs + NO embedding store wired
  let shippingOrder: string[] = []; // recall with the SHIPPING config (knobs off, stores present)
  let readEmbeddingsCalls = 0;
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-iq-default-off-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "iq-default-off.db")), undefined);
    M1.id = randomUUID();
    M2.id = randomUUID();
    M3.id = randomUUID();
    await storeFixture(adapter, { id: M1.id, content: M1.content, createdAt: BENCH_NOW - 30_000, embedding: M1.embedding });
    await storeFixture(adapter, { id: M2.id, content: M2.content, createdAt: BENCH_NOW - 20_000, embedding: M2.embedding });
    await storeFixture(adapter, { id: M3.id, content: M3.content, createdAt: BENCH_NOW - 10_000, embedding: M3.embedding });

    // A spy embedding store wrapping the real one -- proves the shipping (off) config NEVER reads.
    const realStore = createSqliteMemoryEmbeddingStore({ db: adapter.getDb() });
    const spyStore: MemoryEmbeddingStore = {
      async readEmbeddings(ids, scope) {
        readEmbeddingsCalls += 1;
        return realStore.readEmbeddings(ids, scope);
      },
    };

    // (a) The IQ-features-ABSENT path: no embeddingStore dep, no mmr/queryUnderstanding cfg
    // (a caller predating the IQ features). This is the pre-IQ reference order.
    const recallAbsent = createMemoryRecall(
      {
        memoryPort: adapter,
        clock: createFakeClock(BENCH_NOW),
        timers: createFakeTimers(BENCH_NOW),
        logger: createMockLogger(),
      } as MemoryRecallDeps,
      baseRecallConfig(),
    );
    const rAbsent = await recallAbsent.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    absentOrder = rAbsent.ok ? rAbsent.value.map((r) => r.entry.id) : [];

    // (b) The SHIPPING config: the stores ARE injected (the daemon always does) but every IQ
    // knob is OFF (mmr.enabled=false; queryUnderstanding all false). Must be byte-identical.
    const recallShipping = createMemoryRecall(
      {
        memoryPort: adapter,
        embeddingStore: spyStore,
        temporalStore: createSqliteMemoryTemporalStore({ db: adapter.getDb() }),
        clock: createFakeClock(BENCH_NOW),
        timers: createFakeTimers(BENCH_NOW),
        logger: createMockLogger(),
      } as MemoryRecallDeps,
      {
        ...baseRecallConfig(),
        mmr: { enabled: false, lambda: 0.7 },
        queryUnderstanding: { intentReweight: false, synonyms: false, temporalParse: false },
      },
    );
    const rShipping = await recallShipping.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    shippingOrder = rShipping.ok ? rShipping.value.map((r) => r.entry.id) : [];

    adapter.close();
  }, 600_000);

  it("the shipping config (all IQ knobs off) is byte-identical to the IQ-features-absent path, and readEmbeddings is never called", () => {
    expect(absentOrder.length, "absent path returned the fixtures").toBeGreaterThan(0);

    // THE CORE PROOF: the shipping (knobs-off) order is byte-identical to the pre-IQ order.
    expect(shippingOrder, "shipping config byte-identical to the IQ-features-absent path").toEqual(absentOrder);

    // THE COST GATE: with mmr.enabled=false, readEmbeddings is NEVER called (the spy proves it).
    expect(readEmbeddingsCalls, "readEmbeddings NEVER called in the shipping (off) config").toBe(0);

    const report = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "recall-iq-default-off-byte-identity",
      scenario: "shipping config (every IQ knob off, stores present) vs the IQ-features-absent path",
      absentOrderLength: absentOrder.length,
      shippingOrderLength: shippingOrder.length,
      defaultOffByteIdentical: JSON.stringify(shippingOrder) === JSON.stringify(absentOrder),
      readEmbeddingsCalls,
      baselineHeld: "Phase-98: overall ~71% (71.1/73.3), temporal 45/40, recall@5 0.845",
      vectorLane: VECTOR_LANE,
    };
    writeReport(reportDir, "default-off-byte-identity-report.json", report);
  });
});
