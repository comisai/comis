// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated KEYLESS forgetting harness -- the FREE, deterministic, no-API-cost
 * measurement of the forgetting MECHANISM: the per-type FadeMem decay factor the recall
 * hot path folds and the SCAFFOLD-DORMANT lifecycle sweep the daemon cron drives. It is
 * the MECHANICAL gate that ships alongside the manifest; any COSTED QA-accuracy impact of
 * the decay is DEFERRED to an operator-costed re-run (FadeMem's decay is never ablated
 * in isolation -- a known research pitfall -- so a "decay improves QA" claim has no
 * keyless evidence and a fresh one here would be fabricated).
 *
 * WHY THIS HARNESS EXISTS (the honest gap this gate must measure -- the SAME
 * structural gap the sibling IQ / learning-IQ gates verified): the
 * shipping QA + retrieval harnesses construct `createMemoryRecall`
 * with forget DEFAULT-OFF, so they exercise the decay NOT AT ALL. To measure the
 * decay + byte-identity claims HONESTLY and for FREE, this harness wires the
 * SAME production recall pipeline (`createMemoryRecall`) to the SAME production adapters
 * (`SqliteMemoryAdapter` + `createSqliteMemoryLifecycleStore`, both over one shared
 * `getDb()` handle), seeds synthetic memories at KNOWN event-ages under a fixed fake
 * clock so the decay's Δt is deterministic, and runs recall with the forget knob ON vs
 * OFF.
 *
 * THE FOUR MEASURED CLAIMS (each mechanical, keyless, $0 -- NOT a decay-accuracy claim):
 *   1. BYTE-IDENTITY AT NEUTRAL IMPORTANCE (the safety gate): a NEUTRAL/legacy memory
 *      (no memoryType, no proof/usefulness enrichment) recalled at EVENT-AGE 0 scores +
 *      ranks IDENTICALLY three ways -- forget OFF, forget ON-at-neutral, and a pre-forget
 *      reference (the `forget` field absent). At Δt=0 the FadeMem factor is `0.5 +
 *      0.5·exp(0) = 1.0` EXACTLY, independent of λ/β/imp, so a fresh neutral row is never
 *      reordered even with the decay enabled at a live `forgetAlpha`.
 *   2. DETERMINISTIC DECAY EFFECT (MEASURED): an OLD (90-day event-age) low-importance
 *      EPHEMERAL memory (memoryType:"episodic", β=1.2) decays BELOW a FRESH (1-day) durable
 *      memory (memoryType:"semantic", β=0.8) under the fixed BENCH_NOW fake clock. Measured
 *      as the per-memory forget CONTRIBUTION -- the multiplicative factor recovered as
 *      `scoreForgetOn / scoreForgetOff` (forget is a pure multiplicand on the boosted
 *      score, all other factors held fixed) -- the old-ephemeral's factor < the
 *      fresh-durable's. The intended FadeMem behavior, MEASURED, not a QA claim.
 *   3. FOOTPRINT UNCHANGED WHEN THE EVICTION SCAFFOLD IS OFF/DORMANT: running the WIRED
 *      lifecycle sweep (`createSqliteMemoryLifecycleStore.runLifecycleSweep`, the
 *      DORMANT scaffold) over N real rows evicts/demotes 0 -- the row COUNT(*) is
 *      unchanged, the `evicted_at IS NOT NULL` + `lifecycle_demoted_at IS NOT NULL`
 *      marker counts are 0, and the report is `{promoted:0,demoted:0,evicted:0}`
 *      (the live eviction policy is the deferred operator step).
 *   4. ZERO CATEGORY REGRESSION: the recall hot path with forget OFF is byte-identical to
 *      a no-forget baseline run (the `forget` field absent) on the same fixtures -- the
 *      established keyless no-regression tier, referenced to the committed baseline.
 *
 * THIS IS THE PRODUCTION CODE PATH, NOT A MOCK:
 *   - recall = `createMemoryRecall(deps, cfg)` (bare @comis/agent production orchestrator),
 *   - memoryPort = a fresh `mkdtempSync` `SqliteMemoryAdapter` (the sole @comis/memory adapter),
 *   - the lifecycle sweep = `createSqliteMemoryLifecycleStore({ db: adapter.getDb() })`
 *     (bare @comis/memory -- the SOLE DORMANT lifecycle adapter, over the SAME handle),
 *   - cfg.forget = { enabled } (the shipped forget knob) toggled per claim;
 *     cfg.scoring.forgetAlpha carries the decay MAGNITUDE (the single canonical knob). The
 *     decay is LAZY-at-read (pure over the injected `clock.now()` -- no Date.now, no write
 *     mutation); the sweep is the daemon-cron-side DORMANT pass (evicts nothing).
 *
 * KEYLESS (the honest protocol): no answer model, no judge, no API key,
 * no provider call, no cost -- the suite reads ONLY the COMIS_BENCH gate, with no costed
 * answer-model or judge-model env lane at all (the beam-harness.bench.test.ts
 * COMIS_BENCH-only precedent). The forget claims need NO model:
 * the decay is the deterministic LLM-free `createMemoryRecall` factor and the sweep is the
 * deterministic DORMANT adapter. Any COSTED QA-accuracy impact of the decay is DEFERRED to
 * the operator (kept STRICTLY SEPARATE -- no fabricated decay-accuracy number).
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import @comis/memory
 * (a devDependency) -- the agent->memory cut excludes the `.test.ts` suffix
 * (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). Mirrors the blessed precedent
 * learning-iq.bench.test.ts / recall-iq-contribution.bench.test.ts.
 *
 * SECURITY: fresh `mkdtempSync` tmp DB (NEVER ~/.comis), `trustLevel:"learned"`,
 * `tenantId:"default"`/`agentId:"bench"` -- isolated from any live agent. All fixture
 * strings are synthetic (no secret). Each report is written via the confined
 * `writeRegularFile` (O_NOFOLLOW + EXCL + confinement) and carries pure numbers + booleans
 * (scores, factors, counts, the claim booleans) -- NEVER the memory bodies or query text;
 * the post-write secret-shape sweep proves it. No superiority string, no echoed synthetic
 * storage headline.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent->memory cut excludes *.test.ts).
import { SqliteMemoryAdapter, createSqliteMemoryLifecycleStore } from "@comis/memory";
// BARE production orchestrator (the live LLM-free recall pipeline this harness drives).
import { createMemoryRecall, type MemoryRecallDeps, type MemoryRecallConfig } from "@comis/agent";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// Determinism helpers (test/support -- 5 segments up).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type { MemoryConfig, MemoryEntry, MemorySearchResult, SessionKey } from "@comis/core";
import { MemoryConfigSchema } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ENV GATE -- read process.env ONLY at the test boundary (the globals rule scopes to src/**).
const COMIS_BENCH = process.env.COMIS_BENCH;
// Optional committable report-output dir (the dated results manifest). When set, the
// confined writeRegularFile writes the reports there (created if absent); the O_NOFOLLOW +
// EXCL + confinement guard still applies. Unset -> ephemeral tmp dir.
const COMIS_FORGET_REPORT_DIR = process.env.COMIS_FORGET_REPORT_DIR;

/** Fixed epoch (matches the sibling harnesses' neutral clock) -> deterministic Δt. */
const BENCH_NOW = 1_700_000_000_000;
/** Harness version stamp -- a number is always attributable to fixed harness code. */
const HARNESS_VERSION = "phase-112-05-v1";
/** The committed baseline this gate's no-regression claim references. */
const BASELINE_REF = "benchmarks/results/2026-06-01-phase106-baser/";

/** dims=4 keeps the (unused-here) vec index tiny; the forget claims are FTS-driven. */
const EMBED_DIMS = 4;
/** Milliseconds per day -- the event-age axis. */
const DAY_MS = 86_400_000;

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
 * The agent partition the memories are ingested under AND the agentId recall is called
 * with. THE SCOPE IS LOAD-BEARING: recall derives the scope as
 * `agentId ?? sessionKey.agentId ?? "default"`; the SessionKey carries NO `agentId`, so
 * recall MUST be called with this explicit `agentId` (mirrors the daemon).
 */
const BENCH_AGENT_ID = "bench";

/**
 * Base recall config -- all scoring alphas 0 EXCEPT forgetAlpha (set HIGH, 1.0, so the
 * decay factor's full swing is measurable and the forget contribution is recoverable as
 * the on/off score ratio). forgetAlpha is the SINGLE canonical decay magnitude (on
 * `scoring`, exactly like the other alphas -- the toggle lives on `cfg.forget`). Only the
 * fts lane is lit (no temporal/entity lane). includeTrustLevels covers the ingested band.
 * The `forget` GATE is set per-claim by the caller (absent / off / on).
 */
function baseRecallConfig(): MemoryRecallConfig {
  return {
    maxResults: 10,
    minScore: 0,
    includeTrustLevels: ["system", "learned"],
    rerank: { mode: "off", maxCandidates: 20, minResults: 2, timeoutMs: 5000 },
    scoring: {
      recencyAlpha: 0,
      temporalAlpha: 0,
      proofAlpha: 0,
      trustAlpha: 0,
      usefulnessAlpha: 0,
      forgetAlpha: 1.0,
    },
    lanes: {
      fts: { weight: 1.0 },
      vector: { weight: 1.5 },
    },
  };
}

/** Recall deps over the fresh adapter + the deterministic fake clock (no usefulness store). */
function makeRecallDeps(adapter: SqliteMemoryAdapter): MemoryRecallDeps {
  return {
    memoryPort: adapter,
    clock: createFakeClock(BENCH_NOW),
    timers: createFakeTimers(BENCH_NOW),
    logger: createMockLogger(),
  } as MemoryRecallDeps;
}

/**
 * Store one synthetic memory with optional decay-relevant fields (memoryType / occurredAt /
 * proofCount). A neutral/legacy fixture omits memoryType + proofCount (-> parity β, minimal
 * imp). createdAt is the record time; occurredAt (when given) is the EVENT time the decay's
 * Δt is computed from (occurredAt ?? createdAt).
 */
async function storeFixture(
  adapter: SqliteMemoryAdapter,
  args: {
    id: string;
    content: string;
    createdAt: number;
    occurredAt?: number;
    memoryType?: MemoryEntry["memoryType"];
    proofCount?: number;
  },
): Promise<void> {
  const entry: MemoryEntry = {
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
    ...(args.memoryType !== undefined ? { memoryType: args.memoryType } : {}),
    ...(args.proofCount !== undefined ? { proofCount: args.proofCount } : {}),
  };
  const stored = await adapter.store(entry);
  expect(stored.ok, `fixture ${args.id} stored`).toBe(true);
}

/** rank (1-based) of an id in a recall result list; 0 = absent. */
function rankOf(results: MemorySearchResult[], id: string): number {
  const idx = results.findIndex((r) => r.entry.id === id);
  return idx < 0 ? 0 : idx + 1;
}

/** the boosted score of an id in a recall result list; undefined = absent. */
function scoreOf(results: MemorySearchResult[], id: string): number | undefined {
  const hit = results.find((r) => r.entry.id === id);
  return hit?.score;
}

/** Resolve the committable report dir (created if absent) or an ephemeral tmp dir. */
function resolveReportDir(fallbackTmp: string): string {
  if (COMIS_FORGET_REPORT_DIR !== undefined && COMIS_FORGET_REPORT_DIR.length > 0) {
    const dir = resolve(COMIS_FORGET_REPORT_DIR);
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
  console.log(`BENCH forget ${name}`, reportJson);
  // The report must carry NO credential substring (the post-run secret-shape sweep). The
  // shapes: a `sk-`+16 token, a `Bearer ` token, an `apiKey` field marker.
  expect(reportJson).not.toMatch(/apiKey|sk-[A-Za-z0-9]{16,}|Bearer /);
  return reportJson;
}

// ---------------------------------------------------------------------------
// CLAIM 1 -- byte-identity at neutral importance (the safety gate)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("forget: byte-identity at neutral importance (claim 1, keyless gated)", () => {
  // A NEUTRAL/legacy memory: no memoryType (-> parity β=1.0), no proofCount/confidence
  // (-> minimal imp), at EVENT-AGE 0 (createdAt = occurredAt = BENCH_NOW). At Δt=0 the
  // FadeMem factor is `0.5 + 0.5·exp(0) = 1.0` EXACTLY for ANY λ/β/imp, so the recall
  // score + rank must be IDENTICAL three ways: forget OFF, forget ON-at-neutral (with a
  // live forgetAlpha=1.0), and a pre-forget reference (the `forget` field absent). A
  // SECOND legacy memory anchors the rank ordering so "rank unchanged" is observable.
  const NEUTRAL = { id: "", content: "legacy neutral memory anchor topic note baseline" };
  const OTHER = { id: "", content: "legacy neutral memory anchor topic note sibling extra" };
  const QUERY = "legacy neutral memory anchor topic note";

  let scoreForgetOff = -1;
  let scoreForgetOnNeutral = -1;
  let scoreForgetAbsent = -1;
  let rankForgetOff = 0;
  let rankForgetOnNeutral = 0;
  let rankForgetAbsent = 0;
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-forget-byte-identity-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "forget-byte-identity.db")), undefined);
    NEUTRAL.id = randomUUID();
    OTHER.id = randomUUID();
    // Event-age 0: createdAt = occurredAt = BENCH_NOW (the neutral-in-time byte-identity point).
    await storeFixture(adapter, { id: NEUTRAL.id, content: NEUTRAL.content, createdAt: BENCH_NOW, occurredAt: BENCH_NOW });
    await storeFixture(adapter, { id: OTHER.id, content: OTHER.content, createdAt: BENCH_NOW, occurredAt: BENCH_NOW });

    const recall = createMemoryRecall(makeRecallDeps(adapter), { ...baseRecallConfig(), forget: { enabled: false } });
    const rOff = await recall.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    scoreForgetOff = scoreOf(rOff.ok ? rOff.value : [], NEUTRAL.id) ?? -1;
    rankForgetOff = rankOf(rOff.ok ? rOff.value : [], NEUTRAL.id);

    const recallOn = createMemoryRecall(makeRecallDeps(adapter), { ...baseRecallConfig(), forget: { enabled: true } });
    const rOn = await recallOn.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    scoreForgetOnNeutral = scoreOf(rOn.ok ? rOn.value : [], NEUTRAL.id) ?? -1;
    rankForgetOnNeutral = rankOf(rOn.ok ? rOn.value : [], NEUTRAL.id);

    // Pre-forget reference: the `forget` field ABSENT entirely (a caller predating the knob).
    const recallAbsent = createMemoryRecall(makeRecallDeps(adapter), baseRecallConfig());
    const rAbsent = await recallAbsent.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    scoreForgetAbsent = scoreOf(rAbsent.ok ? rAbsent.value : [], NEUTRAL.id) ?? -1;
    rankForgetAbsent = rankOf(rAbsent.ok ? rAbsent.value : [], NEUTRAL.id);

    adapter.close();
  }, 600_000);

  it("a neutral/legacy memory's score + rank are identical with forget OFF, ON-at-neutral, and absent", () => {
    expect(scoreForgetOff, "neutral memory present (forget off)").toBeGreaterThan(0);
    expect(scoreForgetOnNeutral, "neutral memory present (forget on-at-neutral)").toBeGreaterThan(0);
    expect(scoreForgetAbsent, "neutral memory present (forget field absent)").toBeGreaterThan(0);

    // THE CLAIM: at event-age 0 the FadeMem factor is EXACTLY 1.0, so the boosted score is
    // byte-identical across all three forget states (even ON with a live forgetAlpha=1.0).
    expect(scoreForgetOnNeutral, "forget ON-at-neutral byte-identical to forget OFF").toBe(scoreForgetOff);
    expect(scoreForgetAbsent, "forget absent byte-identical to forget OFF").toBe(scoreForgetOff);
    // The rank is likewise unchanged.
    expect(rankForgetOnNeutral, "rank unchanged ON-at-neutral").toBe(rankForgetOff);
    expect(rankForgetAbsent, "rank unchanged when absent").toBe(rankForgetOff);

    const byteIdentical =
      scoreForgetOnNeutral === scoreForgetOff &&
      scoreForgetAbsent === scoreForgetOff &&
      rankForgetOnNeutral === rankForgetOff &&
      rankForgetAbsent === rankForgetOff;
    const report = {
      harnessVersion: HARNESS_VERSION,
      claim: "byte-identity-at-neutral-importance",
      scoreForgetOff,
      scoreForgetOnNeutral,
      scoreForgetAbsent,
      rankForgetOff,
      rankForgetOnNeutral,
      rankForgetAbsent,
      byteIdentical,
      pass: byteIdentical,
    };
    writeReport(reportDir, "claim1-byte-identity-report.json", report);
  });
});

// ---------------------------------------------------------------------------
// CLAIM 2 -- the deterministic decay effect (MEASURED)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("forget: deterministic decay effect (claim 2, keyless gated)", () => {
  // An OLD (90-day event-age) low-importance EPHEMERAL memory (memoryType:"episodic",
  // β=1.2 sharp drop, no proofCount -> minimal imp) vs a FRESH (1-day) DURABLE memory
  // (memoryType:"semantic", β=0.8 slow tail), under the fixed BENCH_NOW fake clock with
  // forget ENABLED. The FadeMem factor demotes the old-ephemeral far more than the
  // fresh-durable. We recover each memory's forget CONTRIBUTION as the per-memory ratio
  // `scoreForgetOn / scoreForgetOff` (forget is a pure multiplicand on the boosted score
  // and all other alphas are 0, so the ratio IS the forgetFactor). THE CLAIM: the
  // old-ephemeral's forgetFactor < the fresh-durable's. MEASURED -- not a QA-accuracy claim.
  const OLD_EPHEMERAL = { id: "", content: "decay probe memory shared lexical anchor token alpha" };
  const FRESH_DURABLE = { id: "", content: "decay probe memory shared lexical anchor token beta" };
  const QUERY = "decay probe memory shared lexical anchor token";

  let oldForgetFactor = -1;
  let freshForgetFactor = -1;
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-forget-decay-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "forget-decay.db")), undefined);
    OLD_EPHEMERAL.id = randomUUID();
    FRESH_DURABLE.id = randomUUID();
    // OLD ephemeral: 90-day event-age, episodic (β=1.2). FRESH durable: 1-day, semantic (β=0.8).
    await storeFixture(adapter, {
      id: OLD_EPHEMERAL.id,
      content: OLD_EPHEMERAL.content,
      createdAt: BENCH_NOW - 90 * DAY_MS,
      occurredAt: BENCH_NOW - 90 * DAY_MS,
      memoryType: "episodic",
    });
    await storeFixture(adapter, {
      id: FRESH_DURABLE.id,
      content: FRESH_DURABLE.content,
      createdAt: BENCH_NOW - 1 * DAY_MS,
      occurredAt: BENCH_NOW - 1 * DAY_MS,
      memoryType: "semantic",
    });

    // forget OFF -> the no-decay baseline score for each memory (forgetFactor === 1.0).
    const recallOff = createMemoryRecall(makeRecallDeps(adapter), { ...baseRecallConfig(), forget: { enabled: false } });
    const rOff = await recallOff.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    const oldOff = scoreOf(rOff.ok ? rOff.value : [], OLD_EPHEMERAL.id) ?? -1;
    const freshOff = scoreOf(rOff.ok ? rOff.value : [], FRESH_DURABLE.id) ?? -1;

    // forget ON -> the decayed score. The recovered factor is on/off (forget is a pure
    // multiplicand; every other alpha is 0 so no other factor differs between the runs).
    const recallOn = createMemoryRecall(makeRecallDeps(adapter), { ...baseRecallConfig(), forget: { enabled: true } });
    const rOn = await recallOn.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    const oldOn = scoreOf(rOn.ok ? rOn.value : [], OLD_EPHEMERAL.id) ?? -1;
    const freshOn = scoreOf(rOn.ok ? rOn.value : [], FRESH_DURABLE.id) ?? -1;

    oldForgetFactor = oldOff > 0 ? oldOn / oldOff : -1;
    freshForgetFactor = freshOff > 0 ? freshOn / freshOff : -1;

    adapter.close();
  }, 600_000);

  it("an old low-importance ephemeral memory's forget factor is lower than a fresh durable memory's (decays below)", () => {
    // Both factors are recovered and in the demote-only band (0,1] (the factor only ever
    // fades a stale memory; a fresh durable one stays near 1.0).
    expect(oldForgetFactor, "old-ephemeral forget factor recovered").toBeGreaterThan(0);
    expect(freshForgetFactor, "fresh-durable forget factor recovered").toBeGreaterThan(0);
    expect(oldForgetFactor, "old-ephemeral forget factor in the demote band (<=1)").toBeLessThanOrEqual(1.0000001);
    expect(freshForgetFactor, "fresh-durable forget factor in the demote band (<=1)").toBeLessThanOrEqual(1.0000001);

    // THE CLAIM: the old low-importance ephemeral decays STRICTLY BELOW the fresh durable
    // (the per-type β + the event-age both push the old-ephemeral's factor lower). The
    // intended FadeMem behavior, MEASURED at $0 -- decay RANKS, never GATES.
    expect(oldForgetFactor, "old-ephemeral decays below fresh-durable").toBeLessThan(freshForgetFactor);

    const report = {
      harnessVersion: HARNESS_VERSION,
      claim: "deterministic-decay-effect",
      oldEphemeralForgetFactor: oldForgetFactor,
      freshDurableForgetFactor: freshForgetFactor,
      decayedBelow: oldForgetFactor < freshForgetFactor,
      // The magnitude of the relative demotion (a positive number = the old memory faded more).
      forgetFactorGap: freshForgetFactor - oldForgetFactor,
      pass: oldForgetFactor < freshForgetFactor,
    };
    writeReport(reportDir, "claim2-deterministic-decay-report.json", report);
  });
});

// ---------------------------------------------------------------------------
// CLAIM 3 -- footprint unchanged when the eviction scaffold is off/dormant
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("forget: footprint unchanged when dormant (claim 3, keyless gated)", () => {
  // Seed N real memories on the SqliteMemoryAdapter, construct the SOLE lifecycle adapter
  // `createSqliteMemoryLifecycleStore` on the SAME `getDb()` handle, and run the WIRED
  // `runLifecycleSweep` (the DORMANT scaffold). THE CLAIM: the sweep evicts/demotes
  // 0 rows -- the row COUNT(*) is unchanged, the `evicted_at IS NOT NULL` + the
  // `lifecycle_demoted_at IS NOT NULL` marker counts are 0, and the report is all-0. The
  // fixtures include a deliberately STALE low-importance row (an eviction CANDIDATE a live
  // policy would touch) so "evicts nothing even with a candidate present" is observable.
  const SEED_COUNT = 5;
  const seedIds: string[] = [];

  let rowCountBefore = -1;
  let rowCountAfter = -1;
  let evictedMarkerCount = -1;
  let demotedMarkerCount = -1;
  let reportScanned = -1;
  let reportPromoted = -1;
  let reportDemoted = -1;
  let reportEvicted = -1;
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-forget-footprint-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "forget-footprint.db")), undefined);
    // 4 ordinary fresh rows + 1 deliberately STALE low-importance ephemeral row (an
    // eviction CANDIDATE a live policy would mark; the DORMANT scaffold marks it NOT).
    for (let i = 0; i < SEED_COUNT - 1; i += 1) {
      const id = randomUUID();
      seedIds.push(id);
      await storeFixture(adapter, {
        id,
        content: `footprint probe memory row ${i} synthetic body content`,
        createdAt: BENCH_NOW - (i + 1) * DAY_MS,
        memoryType: "semantic",
      });
    }
    const staleId = randomUUID();
    seedIds.push(staleId);
    await storeFixture(adapter, {
      id: staleId,
      content: "footprint probe memory stale ephemeral row synthetic body content",
      createdAt: BENCH_NOW - 3650 * DAY_MS, // ~10 years dormant
      occurredAt: BENCH_NOW - 3650 * DAY_MS,
      memoryType: "episodic",
    });

    const db = adapter.getDb();
    const countRows = (): number =>
      (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE tenant_id = ? AND agent_id = ?").get("default", BENCH_AGENT_ID) as { c: number }).c;
    const countMarker = (col: "evicted_at" | "lifecycle_demoted_at"): number =>
      (
        db
          .prepare(`SELECT COUNT(*) AS c FROM memories WHERE tenant_id = ? AND agent_id = ? AND ${col} IS NOT NULL`)
          .get("default", BENCH_AGENT_ID) as { c: number }
      ).c;

    rowCountBefore = countRows();

    // The SOLE DORMANT lifecycle adapter over the SHARED handle (the daemon-cron path).
    const lifecycleStore = createSqliteMemoryLifecycleStore({ db });
    const sweep = await lifecycleStore.runLifecycleSweep({
      tenantId: "default",
      agentId: BENCH_AGENT_ID,
      now: BENCH_NOW,
    });
    expect(sweep.ok, "dormant lifecycle sweep ran without error").toBe(true);
    if (sweep.ok) {
      reportScanned = sweep.value.scanned;
      reportPromoted = sweep.value.promoted;
      reportDemoted = sweep.value.demoted;
      reportEvicted = sweep.value.evicted;
    }

    rowCountAfter = countRows();
    evictedMarkerCount = countMarker("evicted_at");
    demotedMarkerCount = countMarker("lifecycle_demoted_at");

    adapter.close();
  }, 600_000);

  it("the dormant lifecycle sweep evicts/demotes 0 rows -- the footprint is unchanged", () => {
    // THE CLAIM: the wired DORMANT sweep touches nothing.
    expect(rowCountBefore, "rows seeded").toBe(SEED_COUNT);
    expect(rowCountAfter, "row count unchanged after the sweep").toBe(rowCountBefore);
    expect(evictedMarkerCount, "no row marked evicted_at").toBe(0);
    expect(demotedMarkerCount, "no row marked lifecycle_demoted_at").toBe(0);
    // The sweep scanned the candidates (it is wired + live) but acted on NOTHING.
    expect(reportScanned, "the sweep scanned the seeded rows").toBe(SEED_COUNT);
    expect(reportPromoted, "report promoted = 0").toBe(0);
    expect(reportDemoted, "report demoted = 0").toBe(0);
    expect(reportEvicted, "report evicted = 0").toBe(0);

    const footprintUnchanged =
      rowCountAfter === rowCountBefore &&
      evictedMarkerCount === 0 &&
      demotedMarkerCount === 0 &&
      reportPromoted === 0 &&
      reportDemoted === 0 &&
      reportEvicted === 0;
    const report = {
      harnessVersion: HARNESS_VERSION,
      claim: "footprint-unchanged-when-dormant",
      rowCountBefore,
      rowCountAfter,
      evictedMarkerCount,
      demotedMarkerCount,
      sweepReport: { scanned: reportScanned, promoted: reportPromoted, demoted: reportDemoted, evicted: reportEvicted },
      footprintUnchanged,
      pass: footprintUnchanged,
    };
    writeReport(reportDir, "claim3-footprint-unchanged-report.json", report);
  });
});

// ---------------------------------------------------------------------------
// CLAIM 4 -- zero category regression (the no-regression tier)
// ---------------------------------------------------------------------------

describe.skipIf(!COMIS_BENCH)("forget: zero category regression (claim 4, keyless gated)", () => {
  // The recall hot path with forget OFF must be byte-identical to a no-forget baseline run
  // (the `forget` field ABSENT) on the SAME mixed-age, mixed-type fixtures -- the
  // established keyless no-regression tier, referenced to the committed baseline. The
  // fixtures span every memoryType + a range of event-ages so "no category is reordered
  // when forget is off" is observable across the whole ordering.
  const FIXTURES: Array<{ id: string; content: string; memoryType: MemoryEntry["memoryType"]; ageDays: number }> = [
    { id: "", content: "regression probe shared anchor token category one body", memoryType: "semantic", ageDays: 1 },
    { id: "", content: "regression probe shared anchor token category two body", memoryType: "episodic", ageDays: 30 },
    { id: "", content: "regression probe shared anchor token category three body", memoryType: "procedural", ageDays: 60 },
    { id: "", content: "regression probe shared anchor token category four body", memoryType: "working", ageDays: 90 },
  ];
  const QUERY = "regression probe shared anchor token";

  let forgetOffOrder: string[] = [];
  let baselineAbsentOrder: string[] = [];
  let reportDir = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-forget-regression-bench-"));
    reportDir = resolveReportDir(dir);

    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "forget-regression.db")), undefined);
    for (const f of FIXTURES) {
      f.id = randomUUID();
      const eventMs = BENCH_NOW - f.ageDays * DAY_MS;
      await storeFixture(adapter, {
        id: f.id,
        content: f.content,
        createdAt: eventMs,
        occurredAt: eventMs,
        memoryType: f.memoryType,
      });
    }

    // (a) The baseline: the `forget` field ABSENT (a caller predating the forget knob).
    const recallAbsent = createMemoryRecall(makeRecallDeps(adapter), baseRecallConfig());
    const rAbsent = await recallAbsent.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    baselineAbsentOrder = rAbsent.ok ? rAbsent.value.map((r) => r.entry.id) : [];

    // (b) forget present but OFF (the shipping default).
    const recallOff = createMemoryRecall(makeRecallDeps(adapter), { ...baseRecallConfig(), forget: { enabled: false } });
    const rOff = await recallOff.recall(QUERY, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    forgetOffOrder = rOff.ok ? rOff.value.map((r) => r.entry.id) : [];

    adapter.close();
  }, 600_000);

  it("the recall hot path with forget OFF is byte-identical to the no-forget baseline (no category regression)", () => {
    expect(baselineAbsentOrder.length, "baseline returned the fixtures").toBeGreaterThan(0);

    // THE CLAIM: forget OFF is byte-identical to the no-forget baseline ordering -- the
    // shipping default moves no stable-category ranking (the committed baseline holds).
    expect(forgetOffOrder, "forget-off order byte-identical to the no-forget baseline").toEqual(baselineAbsentOrder);

    const noRegression = JSON.stringify(forgetOffOrder) === JSON.stringify(baselineAbsentOrder);
    const report = {
      harnessVersion: HARNESS_VERSION,
      claim: "zero-category-regression",
      baselineRef: BASELINE_REF,
      baselineOrderLength: baselineAbsentOrder.length,
      forgetOffOrderLength: forgetOffOrder.length,
      noRegression,
      pass: noRegression,
    };
    writeReport(reportDir, "claim4-no-regression-report.json", report);
  });
});
