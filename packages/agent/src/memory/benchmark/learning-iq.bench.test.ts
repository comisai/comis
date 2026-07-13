// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated KEYLESS learning-IQ harness -- the
 * FREE, deterministic, no-API-cost measurement of the learning MECHANISM:
 * the per-intent usefulness bucket the recall hot path reads
 * and the citation->FEED accrual the dialectic answer feeds.
 * It is the MECHANICAL gate that ships alongside the PARTIAL manifest; the costed
 * rank-over-episodes learning-LIFT (the accuracy number) is DEFERRED to a costed
 * run over real episodes.
 *
 * WHY THIS HARNESS EXISTS (the honest gap the learning gate must measure -- the
 * SAME structural finding the IQ and dialectic gates
 * verified): the shipping QA + retrieval harnesses construct `createMemoryRecall`
 * with feedback DEFAULT-OFF and no `usefulnessStore`, so they exercise the learning
 * features NOT AT ALL. To measure the read-side + write-side learning claims
 * HONESTLY and for FREE, this harness wires the SAME production recall pipeline
 * (`createMemoryRecall`) to the SAME production adapters (`SqliteMemoryAdapter` +
 * `createSqliteMemoryUsefulnessStore`, both over one shared `getDb()` handle),
 * seeds the per-intent usefulness buckets DIRECTLY (the write path the daemon
 * subscriber drives), and runs recall with the learning knobs ON
 * vs OFF.
 *
 * THE FOUR MEASURED CLAIMS (each mechanical, keyless, $0 -- NOT a learning-LIFT):
 *   1. PER-INTENT BUCKET DRIVES THE ORDER: a memory recorded used-for-intent-X
 *      (a high used-rate in the X bucket, none in the Y bucket) ranks HIGHER for an
 *      X-classified query than for a Y-classified query -- the per-intent usefulness
 *      bucket reorders recall. The two queries are picked so the
 *      DETERMINISTIC `classifyIntent` lands them in different buckets; the harness
 *      measures the OBSERVABLE rank effect and never imports `classifyIntent`.
 *   2. DEFAULT-OFF BYTE-IDENTITY + READ-SPY=0: with `feedback` OFF, recall is
 *      byte-identical to a no-store run AND `readUsefulness` is NEVER called (the
 *      cost/no-op gate -- the `readEmbeddings`-spy=0 precedent).
 *   3. CITATION->FEED ACCRUAL: a cited id's usefulness accrues -- `recordUsage`
 *      with `usedIds=[cited]` then `readUsefulness` shows the cited id's used-rate
 *      HIGHER than an ignored sibling's (the citation attribution emitted
 *      into the SHIPPED FEED write path; here measured at the store level, $0).
 *   4. TENANT/AGENT/INTENT ISOLATION: a write under (tenantA, agentA, intentX) is
 *      INVISIBLE to a read under (tenantB, *) or (*, agentB) -- (tenant, agent)
 *      stay the load-bearing isolation boundary; intent is an ADDITIONAL key, never
 *      a relaxation.
 *
 * THIS IS THE PRODUCTION CODE PATH, NOT A MOCK:
 *   - recall = `createMemoryRecall(deps, cfg)` (bare @comis/agent production orchestrator),
 *   - deps.usefulnessStore = `createSqliteMemoryUsefulnessStore({ db: adapter.getDb() })`
 *     (bare @comis/memory -- the SOLE per-intent usefulness adapter),
 *   - cfg.feedback = { enabled } + cfg.queryUnderstanding = { intentReweight } (the
 *     real learning knobs). With both ON the recall read scope carries the per-intent
 *     bucket (the SAME pure `classifyIntent` already done for lane reweighting -- NO
 *     second classify, NO model call on the read path); with feedback OFF
 *     the read block is SKIPPED entirely (the cost gate). The sole thing the harness
 *     does that production wiring does too is POPULATE the usefulness buckets (the
 *     daemon subscriber does this from the turn-end / citation FEED emit).
 *
 * KEYLESS (honest protocol): no answer model, no judge, no API
 * key, no provider call, no cost. The learning claims need NO model: the per-intent
 * buckets are seeded DIRECTLY via `recordUsage` and recall is the LLM-free
 * `createMemoryRecall`. The costed rank-over-episodes learning-LIFT (the accuracy
 * number) is a separate, deferred measurement (its pure rank math lives in
 * `learning-lift-scorer.ts`); this
 * harness produces NO lift number -- a fresh one here would be fabricated.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory (a devDependency) -- the agent->memory cut excludes the `.test.ts`
 * suffix (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). Mirrors the
 * blessed precedent recall-iq-contribution.bench.test.ts /
 * learning-lift-harness.bench.test.ts.
 *
 * SECURITY: fresh `mkdtempSync` tmp DB (NEVER ~/.comis), `trustLevel:"learned"`,
 * `tenantId:"default"`/`agentId:"bench"` -- isolated from any live agent. All fixture
 * strings are synthetic (no secret). Each report is written via the confined
 * `writeRegularFile` (O_NOFOLLOW + EXCL + confinement) and carries pure numbers +
 * booleans (ranks, counts, the claim booleans) -- NEVER the memory bodies or query
 * text; the post-write secret-shape sweep proves it.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent->memory cut excludes *.test.ts).
import { SqliteMemoryAdapter, createSqliteMemoryUsefulnessStore } from "@comis/memory";
// BARE production orchestrator (the live recall pipeline this harness drives).
import { createMemoryRecall, type MemoryRecallDeps, type MemoryRecallConfig } from "@comis/agent";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// Determinism helpers (test/support -- 5 segments up).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type {
  MemoryConfig,
  MemorySearchResult,
  MemoryUsefulnessStore,
  SessionKey,
  UsefulnessScope,
  UsefulnessSignal,
} from "@comis/core";
import { MemoryConfigSchema } from "@comis/core";
import type { Result } from "@comis/shared";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ENV GATE -- read process.env ONLY at the test boundary (the globals rule scopes to src/**).
const COMIS_BENCH = process.env.COMIS_BENCH;
// Optional committable report-output dir (the dated results manifest). When set, the
// confined writeRegularFile writes the reports there (created if absent); the
// O_NOFOLLOW + EXCL + confinement guard still applies. Unset -> ephemeral tmp dir.
const COMIS_LEARN_REPORT_DIR = process.env.COMIS_LEARN_REPORT_DIR;

/** Fixed epoch (matches the sibling harnesses' neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** Harness version stamp -- a number is always attributable to fixed harness code. */
const HARNESS_VERSION = "phase-110-06-v1";

/** dims=4 keeps the (unused-here) vec index tiny; the learning claims are FTS-driven. */
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
 * The agent partition the memories are ingested under -- AND the agentId recall is
 * called with. THE SCOPE IS LOAD-BEARING: the usefulness read filters on
 * `(tenant_id, agent_id)`, and recall derives the scope as
 * `agentId ?? sessionKey.agentId ?? "default"`. The SessionKey carries NO `agentId`,
 * so recall MUST be called with this explicit `agentId` (mirrors the daemon, which
 * always recalls with the live agentId) or the scoped read falls back to "default".
 */
const BENCH_AGENT_ID = "bench";

/**
 * Base recall config -- all scoring alphas 0 EXCEPT usefulnessAlpha, so the ONLY
 * ordering signal beyond lane fusion is the per-intent usefulness boost under test
 * (no recency/temporal/trust confound). usefulnessAlpha is set HIGH (3.0) so the
 * used-rate centered on 0.5 produces a clearly-measurable reorder: a memory with a
 * 1.0 used-rate gets factor 1+3*(1.0-0.5)=2.5 vs an absent-signal neutral 1.0. Only
 * the fts lane is lit (no temporal/entity lane) so `intentMultiplier` has NO lane to
 * reweight (temporal->temporal-lane absent; preference->entity-lane absent) -- the
 * SOLE intent-driven ordering difference is the per-intent USEFULNESS bucket, not the
 * lane reweight. includeTrustLevels covers the ingested band.
 */
function baseRecallConfig(): MemoryRecallConfig {
  return {
    maxResults: 10,
    minScore: 0,
    includeTrustLevels: ["system", "learned"],
    rerank: { enabled: false, maxCandidates: 20, minResults: 2, timeoutMs: 5000 },
    scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 3.0 },
    lanes: {
      fts: { weight: 1.0 },
      vector: { weight: 1.5 },
    },
  };
}

/** Recall deps with the real per-intent usefulness store over the shared db handle. */
function makeRecallDeps(
  adapter: SqliteMemoryAdapter,
  usefulnessStore: MemoryUsefulnessStore | undefined,
): MemoryRecallDeps {
  return {
    memoryPort: adapter,
    ...(usefulnessStore !== undefined ? { usefulnessStore } : {}),
    clock: createFakeClock(BENCH_NOW),
    timers: createFakeTimers(BENCH_NOW),
    logger: createMockLogger(),
  } as MemoryRecallDeps;
}

/** Store one synthetic memory (FTS content + a fixed createdAt). */
async function storeFixture(
  adapter: SqliteMemoryAdapter,
  args: { id: string; content: string; createdAt: number },
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
  if (COMIS_LEARN_REPORT_DIR !== undefined && COMIS_LEARN_REPORT_DIR.length > 0) {
    const dir = resolve(COMIS_LEARN_REPORT_DIR);
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
  console.log(`BENCH learning-iq ${name}`, reportJson);
  // The report must carry NO credential substring (the post-run secret-shape sweep). The
  // shapes: a `sk-`+16 token, a `Bearer ` token, an `apiKey` field marker.
  expect(reportJson).not.toMatch(/apiKey|sk-[A-Za-z0-9]{16,}|Bearer /);
  return reportJson;
}

// ---------------------------------------------------------------------------
// CLAIM 1 -- the per-intent usefulness bucket drives the recall order
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("learning-IQ: per-intent bucket drives order (claim 1, keyless gated)", () => {
  // Two memories, BOTH FTS-matched by BOTH queries (the shared lexical anchor). OTHER
  // repeats the anchor terms MORE, so on a NEUTRAL query (no usefulness boost) OTHER
  // out-ranks M by raw FTS relevance. M is recorded used-for-intent "temporal" (a high
  // used-rate in the temporal bucket) and NOT recorded under "preference" (absent ->
  // neutral). With feedback ON + intentReweight ON:
  //   - a TEMPORAL-classified query reads the temporal bucket -> M's used-rate boosts
  //     its score ABOVE OTHER's raw-FTS lead -> M ranks ABOVE OTHER (rank 1);
  //   - a PREFERENCE-classified query reads the preference bucket -> ABSENT -> neutral
  //     -> M is NOT boosted -> OTHER's raw-FTS lead holds -> M ranks BELOW OTHER (rank 2).
  // Only the fts lane is lit, so intentMultiplier has no lane to reweight (the SOLE
  // intent-driven difference is the per-intent USEFULNESS bucket). The harness picks
  // queries whose DETERMINISTIC classification differs (a "when ... last" temporal
  // marker vs a "prefer/favorite" preference marker) -- the observable-effect proof; it
  // NEVER imports classifyIntent.
  const M = { id: "", content: "rotation roster handoff schedule anchor topic note" };
  // OTHER repeats the high-frequency anchor terms -> a higher raw FTS score than M, so
  // OTHER leads M on a neutral query (and M must be usefulness-boosted to overtake it).
  const OTHER = {
    id: "",
    content: "rotation rotation roster roster handoff handoff schedule schedule anchor anchor topic memo",
  };
  // A temporal-marker query ("when ... last") -> classifyIntent => "temporal".
  const TEMPORAL_QUERY = "when did the rotation roster handoff last happen";
  // A preference-marker query ("prefer ... favorite") -> classifyIntent => "preference".
  const PREFERENCE_QUERY = "which rotation roster handoff schedule do you prefer as a favorite";

  let mRankTemporalQuery = 0;
  let mRankPreferenceQuery = 0;
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-learn-intent-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "learn-intent.db")), undefined);
    const usefulnessStore = createSqliteMemoryUsefulnessStore({ db: adapter.getDb() });

    M.id = randomUUID();
    OTHER.id = randomUUID();
    await storeFixture(adapter, { id: M.id, content: M.content, createdAt: BENCH_NOW - 20_000 });
    await storeFixture(adapter, { id: OTHER.id, content: OTHER.content, createdAt: BENCH_NOW - 10_000 });

    // Seed the per-intent buckets DIRECTLY (the write path the daemon subscriber drives):
    // M is used-for-"temporal" 3x (a high used-rate in the temporal bucket),
    // and NOT recorded under "preference" (the preference bucket is absent -> neutral).
    // OTHER is left with no signal in either bucket (neutral everywhere). The writes touch
    // ONLY their (…, intent) bucket -- the no-clobber per-intent upsert.
    for (let i = 0; i < 3; i += 1) {
      const rec = await usefulnessStore.recordUsage([M.id], [], {
        tenantId: "default",
        agentId: BENCH_AGENT_ID,
        now: BENCH_NOW,
        intent: "temporal",
      });
      expect(rec.ok, "temporal-bucket recordUsage ok").toBe(true);
    }

    // Recall config: feedback ON + intentReweight ON (the per-intent read path lights up).
    const cfg: MemoryRecallConfig = {
      ...baseRecallConfig(),
      feedback: { enabled: true },
      queryUnderstanding: { intentReweight: true, synonyms: false, temporalParse: false },
    };

    const recall = createMemoryRecall(makeRecallDeps(adapter, usefulnessStore), cfg);

    const rTemporal = await recall.recall(TEMPORAL_QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    mRankTemporalQuery = rankOf(rTemporal.ok ? rTemporal.value : [], M.id);

    const rPreference = await recall.recall(PREFERENCE_QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    mRankPreferenceQuery = rankOf(rPreference.ok ? rPreference.value : [], M.id);

    adapter.close();
  }, 600_000);

  it("a memory used-for-intent-X ranks higher for an X-classified query than for a Y-classified query", () => {
    // M is present on BOTH queries (both lexically match it) -- the per-intent bucket
    // changes ORDER, not membership.
    expect(mRankTemporalQuery, "M present on the temporal query").toBeGreaterThan(0);
    expect(mRankPreferenceQuery, "M present on the preference query").toBeGreaterThan(0);

    // THE CLAIM: the temporal bucket's high used-rate lifts M for the temporal-classified
    // query, while the (absent) preference bucket leaves M neutral for the preference
    // query -- so M ranks STRICTLY HIGHER (a smaller 1-based rank number) on the temporal
    // query. The per-intent usefulness bucket drives the order.
    expect(
      mRankTemporalQuery,
      "M ranks higher (smaller rank #) for its used-for intent than for the other intent",
    ).toBeLessThan(mRankPreferenceQuery);

    const report = {
      harnessVersion: HARNESS_VERSION,
      claim: "per-intent-bucket-drives-order",
      mRankForUsedForIntentQuery: mRankTemporalQuery,
      mRankForOtherIntentQuery: mRankPreferenceQuery,
      // The headline: how many places the per-intent bucket lifts M on its used-for intent.
      perIntentRankLift: mRankPreferenceQuery - mRankTemporalQuery,
      perIntentReorders: mRankTemporalQuery < mRankPreferenceQuery,
      pass: mRankTemporalQuery < mRankPreferenceQuery,
    };
    writeReport(reportDir, "claim1-per-intent-bucket-report.json", report);
  });
});

// ---------------------------------------------------------------------------
// CLAIM 2 -- DEFAULT-OFF byte-identity + readUsefulness-spy=0 (the cost gate)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("learning-IQ: default-OFF byte-identity + read-spy=0 (claim 2, keyless gated)", () => {
  // The SHIPPING config ships feedback OFF. With the store PRESENT (the daemon always
  // injects it) but feedback off, recall must be byte-identical to a no-store run AND
  // readUsefulness must NEVER be called (the cost/no-op gate -- the readEmbeddings-spy=0
  // precedent). Even with a FLIPPING per-intent bucket seeded + intentReweight ON, the
  // OFF read block is skipped: the spy records 0 calls and the order is unchanged.
  const A = { id: "", content: "baseline learning memory lexical anchor token one" };
  const B = { id: "", content: "baseline learning memory lexical anchor token two" };
  const C = { id: "", content: "baseline learning memory lexical anchor token three" };
  const QUERY = "when did the baseline learning memory lexical anchor token last appear"; // temporal-classified; matches all three

  let noStoreOrder: string[] = []; // recall with NO usefulness store wired
  let shippingOrder: string[] = []; // recall with the store PRESENT but feedback OFF
  let readUsefulnessCalls = 0;
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-learn-default-off-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "learn-default-off.db")), undefined);
    A.id = randomUUID();
    B.id = randomUUID();
    C.id = randomUUID();
    await storeFixture(adapter, { id: A.id, content: A.content, createdAt: BENCH_NOW - 30_000 });
    await storeFixture(adapter, { id: B.id, content: B.content, createdAt: BENCH_NOW - 20_000 });
    await storeFixture(adapter, { id: C.id, content: C.content, createdAt: BENCH_NOW - 10_000 });

    const realStore = createSqliteMemoryUsefulnessStore({ db: adapter.getDb() });
    // Seed a STRONG temporal-bucket signal that WOULD reorder if read -- proving the OFF
    // gate skips the read (no reorder) rather than reading-then-not-folding.
    for (let i = 0; i < 3; i += 1) {
      await realStore.recordUsage([C.id], [], {
        tenantId: "default",
        agentId: BENCH_AGENT_ID,
        now: BENCH_NOW,
        intent: "temporal",
      });
    }
    // A spy wrapping the real store -- proves the shipping (off) config NEVER reads it.
    const spyStore: MemoryUsefulnessStore = {
      async recordUsage(usedIds, ignoredIds, scope): Promise<Result<void, Error>> {
        return realStore.recordUsage(usedIds, ignoredIds, scope);
      },
      async readUsefulness(
        ids: string[],
        scope: Omit<UsefulnessScope, "now">,
      ): Promise<Result<Map<string, UsefulnessSignal>, Error>> {
        readUsefulnessCalls += 1;
        return realStore.readUsefulness(ids, scope);
      },
    };

    // (a) The store-ABSENT path: no usefulnessStore dep at all (the pre-FEED reference).
    const recallNoStore = createMemoryRecall(makeRecallDeps(adapter, undefined), {
      ...baseRecallConfig(),
      feedback: { enabled: false },
      queryUnderstanding: { intentReweight: true, synonyms: false, temporalParse: false },
    });
    const rNoStore = await recallNoStore.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    noStoreOrder = rNoStore.ok ? rNoStore.value.map((r) => r.entry.id) : [];

    // (b) The SHIPPING config: the store IS injected (the daemon always does) but feedback
    // is OFF. intentReweight ON to prove the OFF gate alone skips the usefulness read.
    const recallShipping = createMemoryRecall(makeRecallDeps(adapter, spyStore), {
      ...baseRecallConfig(),
      feedback: { enabled: false },
      queryUnderstanding: { intentReweight: true, synonyms: false, temporalParse: false },
    });
    const rShipping = await recallShipping.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    shippingOrder = rShipping.ok ? rShipping.value.map((r) => r.entry.id) : [];

    adapter.close();
  }, 600_000);

  it("the shipping config (feedback off) is byte-identical to the store-absent path, and readUsefulness is never called", () => {
    expect(noStoreOrder.length, "store-absent path returned the fixtures").toBeGreaterThan(0);

    // THE CORE PROOF: the shipping (feedback-off) order is byte-identical to the
    // store-absent order, even though a reorder-strength bucket was seeded.
    expect(shippingOrder, "shipping config byte-identical to the store-absent path").toEqual(noStoreOrder);

    // THE COST GATE: with feedback.enabled=false, readUsefulness is NEVER called (spy=0).
    expect(readUsefulnessCalls, "readUsefulness NEVER called in the shipping (off) config").toBe(0);

    const report = {
      harnessVersion: HARNESS_VERSION,
      claim: "default-off-byte-identity",
      noStoreOrderLength: noStoreOrder.length,
      shippingOrderLength: shippingOrder.length,
      defaultOffByteIdentical: JSON.stringify(shippingOrder) === JSON.stringify(noStoreOrder),
      readUsefulnessCalls,
      pass:
        JSON.stringify(shippingOrder) === JSON.stringify(noStoreOrder) && readUsefulnessCalls === 0,
    };
    writeReport(reportDir, "claim2-default-off-byte-identity-report.json", report);
  });
});

// ---------------------------------------------------------------------------
// CLAIM 3 -- citation->FEED accrual (a cited id's usefulness rises)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("learning-IQ: citation->FEED accrual (claim 3, keyless gated)", () => {
  // The dialectic emits the VALIDATED citations of a grounded memory.ask
  // answer into the SHIPPED `memory:recall_used` FEED write path: usedIds = the citations,
  // ignoredIds = the recalled-but-not-cited complement. The daemon subscriber forwards
  // that to recordUsage (the GLOBAL bucket -- the handler does not re-classify).
  // Here we measure the STORE-level accrual that emit drives, at $0: record a CITED id as
  // used and an OTHER recalled id as ignored, then read both back -- the cited id's
  // used-count incremented and its used-rate is HIGHER than the ignored sibling's.
  const CITED = { id: "", content: "incident postmortem decision outcome cited evidence body" };
  const OTHER = { id: "", content: "incident postmortem decision outcome sibling evidence body" };

  let citedBeforeUsed = -1;
  let citedAfterUsed = -1;
  let otherUsed = -1;
  let citedUsedRate = -1;
  let otherUsedRate = -1;
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-learn-citation-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "learn-citation.db")), undefined);
    const usefulnessStore = createSqliteMemoryUsefulnessStore({ db: adapter.getDb() });

    CITED.id = randomUUID();
    OTHER.id = randomUUID();
    await storeFixture(adapter, { id: CITED.id, content: CITED.content, createdAt: BENCH_NOW - 20_000 });
    await storeFixture(adapter, { id: OTHER.id, content: OTHER.content, createdAt: BENCH_NOW - 10_000 });

    // Before: neither id has a row -> absent -> a 0 used-count snapshot.
    const before = await usefulnessStore.readUsefulness([CITED.id, OTHER.id], {
      tenantId: "default",
      agentId: BENCH_AGENT_ID,
    });
    citedBeforeUsed = before.ok ? (before.value.get(CITED.id)?.usedCount ?? 0) : -1;

    // The citation->FEED write (the GLOBAL bucket -- the dialectic emit shape:
    // usedIds = the validated citations, ignoredIds = the recalled complement). No
    // intent is supplied (the handler does not re-classify) -> the adapter's global bucket.
    const rec = await usefulnessStore.recordUsage([CITED.id], [OTHER.id], {
      tenantId: "default",
      agentId: BENCH_AGENT_ID,
      now: BENCH_NOW,
    });
    expect(rec.ok, "citation recordUsage ok").toBe(true);

    // After: the cited id's used-count incremented; the other id has an ignored count.
    const after = await usefulnessStore.readUsefulness([CITED.id, OTHER.id], {
      tenantId: "default",
      agentId: BENCH_AGENT_ID,
    });
    const citedSig = after.ok ? after.value.get(CITED.id) : undefined;
    const otherSig = after.ok ? after.value.get(OTHER.id) : undefined;
    citedAfterUsed = citedSig?.usedCount ?? -1;
    otherUsed = otherSig?.usedCount ?? -1;
    // used-rate = used / (used + ignored); the cited id is all-used (1.0), the other all-ignored (0.0).
    citedUsedRate =
      citedSig !== undefined ? citedSig.usedCount / (citedSig.usedCount + citedSig.ignoredCount) : -1;
    otherUsedRate =
      otherSig !== undefined ? otherSig.usedCount / (otherSig.usedCount + otherSig.ignoredCount) : -1;

    adapter.close();
  }, 600_000);

  it("a cited id's usefulness accrues -- its used-count increments and its used-rate exceeds an ignored sibling's", () => {
    // THE CLAIM: the cited id's used-count rose from its before-snapshot, and the cited
    // id's used-rate is strictly higher than the ignored sibling's (the citation->FEED path).
    expect(citedBeforeUsed, "cited id had no prior used-count").toBe(0);
    expect(citedAfterUsed, "cited id's used-count incremented after the citation write").toBe(1);
    expect(otherUsed, "ignored sibling has no used-count").toBe(0);
    expect(citedUsedRate, "cited id's used-rate exceeds the ignored sibling's").toBeGreaterThan(
      otherUsedRate,
    );

    const report = {
      harnessVersion: HARNESS_VERSION,
      claim: "citation-feed-accrual",
      citedUsedCountBefore: citedBeforeUsed,
      citedUsedCountAfter: citedAfterUsed,
      otherUsedCountAfter: otherUsed,
      citedUsedRate,
      otherUsedRate,
      citedAccrues: citedAfterUsed > citedBeforeUsed && citedUsedRate > otherUsedRate,
      pass: citedAfterUsed === 1 && citedBeforeUsed === 0 && citedUsedRate > otherUsedRate,
    };
    writeReport(reportDir, "claim3-citation-feed-accrual-report.json", report);
  });
});

// ---------------------------------------------------------------------------
// CLAIM 4 -- tenant/agent/intent isolation (the load-bearing security scope)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("learning-IQ: tenant/agent/intent isolation (claim 4, keyless gated)", () => {
  // A usefulness write under (tenantA, agentA, intentX) must be INVISIBLE to a read under
  // a foreign tenant OR a foreign agent -- (tenant, agent) is the load-bearing isolation
  // boundary; intent is an ADDITIONAL key, never a relaxation. The
  // in-scope read (same tenant + agent + intent) DOES see it. (memory_id is byte-identical
  // across the reads -- the isolation is the scope, not the id.) The memory ROW is stored
  // under (tenantA, agentA) first to satisfy the usefulness FK (memory_id -> memories(id)
  // ON DELETE CASCADE); the isolation comes from the usefulness read's (tenant, agent)
  // filter, NOT from the memory row's existence.
  const M = { id: "", content: "isolation probe memory anchor body content single" };
  const TENANT_A = "tenant_a";
  const AGENT_A = "agent_a";
  const TENANT_B = "tenant_b";
  const AGENT_B = "agent_b";
  const INTENT_X = "temporal";

  let inScopePresent = false;
  let foreignTenantPresent = true; // must flip to false
  let foreignAgentPresent = true; // must flip to false
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-learn-isolation-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "learn-isolation.db")), undefined);
    const usefulnessStore = createSqliteMemoryUsefulnessStore({ db: adapter.getDb() });

    M.id = randomUUID();

    // Store the memory ROW under (tenantA, agentA) so the usefulness FK (memory_id ->
    // memories(id)) is satisfied; the isolation tested below is the usefulness read's
    // (tenant, agent) filter, not the memory row's presence.
    const stored = await adapter.store({
      id: M.id,
      tenantId: TENANT_A,
      agentId: AGENT_A,
      userId: "user_a",
      content: M.content,
      trustLevel: "learned",
      source: { who: "bench" },
      tags: ["bench"],
      createdAt: BENCH_NOW - 10_000,
    });
    expect(stored.ok, "isolation fixture stored under (tenantA, agentA)").toBe(true);

    // Write under (tenantA, agentA, intentX).
    const rec = await usefulnessStore.recordUsage([M.id], [], {
      tenantId: TENANT_A,
      agentId: AGENT_A,
      now: BENCH_NOW,
      intent: INTENT_X,
    });
    expect(rec.ok, "in-scope recordUsage ok").toBe(true);

    // In-scope read (same tenant + agent + intent) -> the signal is present.
    const inScope = await usefulnessStore.readUsefulness([M.id], {
      tenantId: TENANT_A,
      agentId: AGENT_A,
      intent: INTENT_X,
    });
    inScopePresent = inScope.ok && inScope.value.has(M.id);

    // Foreign-TENANT read (tenantB, agentA) -> the signal is ABSENT (tenant isolation).
    const foreignTenant = await usefulnessStore.readUsefulness([M.id], {
      tenantId: TENANT_B,
      agentId: AGENT_A,
      intent: INTENT_X,
    });
    foreignTenantPresent = foreignTenant.ok ? foreignTenant.value.has(M.id) : true;

    // Foreign-AGENT read (tenantA, agentB) -> the signal is ABSENT (agent isolation).
    const foreignAgent = await usefulnessStore.readUsefulness([M.id], {
      tenantId: TENANT_A,
      agentId: AGENT_B,
      intent: INTENT_X,
    });
    foreignAgentPresent = foreignAgent.ok ? foreignAgent.value.has(M.id) : true;

    adapter.close();
  }, 600_000);

  it("a write under (tenantA, agentA, intentX) is invisible to a foreign-tenant / foreign-agent read", () => {
    // THE CLAIM: the in-scope read sees the signal; BOTH the foreign-tenant and the
    // foreign-agent reads do NOT (the load-bearing isolation boundary).
    expect(inScopePresent, "in-scope read sees the signal").toBe(true);
    expect(foreignTenantPresent, "foreign-tenant read does NOT see the signal").toBe(false);
    expect(foreignAgentPresent, "foreign-agent read does NOT see the signal").toBe(false);

    const report = {
      harnessVersion: HARNESS_VERSION,
      claim: "tenant-agent-intent-isolation",
      inScopePresent,
      foreignTenantPresent,
      foreignAgentPresent,
      isolationHolds: inScopePresent && !foreignTenantPresent && !foreignAgentPresent,
      pass: inScopePresent && !foreignTenantPresent && !foreignAgentPresent,
    };
    writeReport(reportDir, "claim4-tenant-agent-intent-isolation-report.json", report);
  });
});
