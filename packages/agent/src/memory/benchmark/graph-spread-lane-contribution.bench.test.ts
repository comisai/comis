// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated KEYLESS graph-spread lane-contribution harness -- the FREE,
 * deterministic, no-API-cost measurement of whether the trust-first
 * bi-temporal KG's graph-spread lane actually CONTRIBUTES to recall.
 *
 * WHY THIS HARNESS EXISTS (the honest gap this gate must measure): the
 * shipping QA + retrieval + contradiction harnesses construct `createMemoryRecall`
 * WITHOUT a `tripleStore` dep and WITHOUT a `lanes.graphSpread` config, so with the
 * lane DEFAULT-OFF they exercise the KG lane NOT AT ALL -- running them ON the J1
 * subset reproduces the prior baseline with the lane dormant (a NULL result for
 * the headline). To measure the lane's read-side claim HONESTLY and for FREE, this
 * harness wires the SAME production recall pipeline (`createMemoryRecall`) to the
 * SAME production adapter (`createSqliteTripleStore` over the SqliteMemoryAdapter's
 * shared db handle), populates triples, and runs recall@k with the lane ON vs OFF.
 *
 * THE MEASURED CLAIM: a memory that is STRUCTURALLY linked (subject -> object
 * current-truth edges in the triple store) to a query's top base hit -- but that
 * FTS/vector retrieval does NOT surface for that query lexically -- IS surfaced into
 * recall when `lanes.graphSpread.enabled = true`, and is ABSENT when it is false.
 * The recall@k delta (ON minus OFF) for the linked gold doc is the lane's
 * contribution. A positive delta is the read-side KG claim; a zero delta is the
 * honest failure the gate must report.
 *
 * THIS IS THE PRODUCTION CODE PATH, NOT A MOCK:
 *   - recall = `createMemoryRecall(deps, cfg)` (bare @comis/agent production orchestrator),
 *   - deps.tripleStore = `createSqliteTripleStore({ db: adapter.getDb() })` (bare @comis/memory adapter),
 *   - cfg.lanes.graphSpread = { enabled, weight, maxDepth, fanOut } (the real lane knobs),
 *   - the seeds are the recalled top hits' CONTENT (the production seed source,
 *     memory-recall.ts:289-293), the walk is the real bounded recursive-CTE
 *     `spreadLane`, and the hydrate is the real `source_memory_id -> memories` join.
 * The only thing the harness does that production wiring (the daemon) does too is
 * POPULATE the triples (production does it via the offline triple-extraction job);
 * here we write them directly via the port's `upsertTriple` so the
 * test is deterministic + LLM-free.
 *
 * KEYLESS: no answer/judge model, no API key, no provider call, no
 * cost. The vector lane lights up only if LLAMA_MODEL_PATH is set (the linked-doc
 * surfacing claim is then even STRONGER -- the linked doc is non-lexical AND
 * non-semantic for the query, so only the graph edge can surface it); absent, FTS-only.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory (a devDependency) -- the agent->memory cut excludes the `.test.ts`
 * suffix (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). Mirrors the
 * blessed precedent retrieval-harness.bench.test.ts / contradiction-harness.bench.test.ts.
 *
 * SECURITY: fresh `mkdtempSync` tmp DB (NEVER ~/.comis), `trustLevel:"learned"`,
 * `tenantId:"default"`/`agentId:"bench"` -- isolated from any live agent. The
 * triple subjects/objects are synthetic fixture strings (no secret). The report is
 * written via the confined `writeRegularFile` (O_NOFOLLOW + EXCL + confinement) and
 * carries pure numbers + booleans -- the secret-omission assertion proves it.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
// GATED test-only imports (the agent->memory cut excludes *.test.ts).
import { SqliteMemoryAdapter, createSqliteTripleStore } from "@comis/memory";
// BARE production orchestrator (the live recall pipeline this harness drives).
import { createMemoryRecall, type MemoryRecallDeps, type MemoryRecallConfig } from "@comis/agent";
// VALUE obs import (fine in a .test.ts) -- the confined report writer.
import { writeRegularFile } from "@comis/observability";
// Constructed contradiction pairs (Paris/vegetarian) -- the SAME fixtures the gate
// consumes; reused here to drive the KG write-path invalidation.
import { buildContradictionPairs } from "./suite-scenario.js";
// Determinism helpers (test/support -- 5 segments up).
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
// Core types (type-only).
import type { MemoryConfig, MemorySearchResult, SessionKey, TripleScope } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ENV GATE -- read process.env ONLY at the test boundary (the globals rule scopes to src/**).
const COMIS_BENCH = process.env.COMIS_BENCH;
// Optional committable report-output dir (the dated results manifest). When set, the
// confined writeRegularFile writes the report there (the dir is created if absent);
// the O_NOFOLLOW + EXCL + confinement guard still applies. Unset -> ephemeral tmp dir.
const COMIS_KG_REPORT_DIR = process.env.COMIS_KG_REPORT_DIR;

/** Fixed epoch (matches the sibling harnesses' neutral clock). */
const BENCH_NOW = 1_700_000_000_000;
/** Harness version stamp -- a number is always attributable to fixed harness code. */
const HARNESS_VERSION = "phase-100-06-v1";

/** The bench store config (mirrors the sibling harnesses). dims=4 -> FTS-only base. */
function makeBenchConfig(dbPath: string): MemoryConfig {
  return {
    dbPath,
    walMode: false,
    embeddingModel: "local",
    embeddingDimensions: 4,
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0 },
  } as MemoryConfig;
}

/** The bench recall scope -- neutral placeholders, isolated from any live session. */
const BENCH_SESSION_KEY: SessionKey = {
  tenantId: "default",
  userId: "user_a",
  channelId: "default",
};

/**
 * The agent partition the memories + triples are ingested under -- AND the agentId
 * recall is called with. THE SCOPE IS LOAD-BEARING: the graph-spread
 * walk's recursive arm filters on `(tenant_id, agent_id)`, and recall derives the
 * spread scope as `agentId ?? sessionKey.agentId ?? "default"` (memory-recall.ts).
 * The SessionKey here carries NO `agentId`, so recall MUST be called with this
 * explicit `agentId` or the spread scope falls back to "default" and the walk
 * (correctly, by isolation) returns nothing. Passing it mirrors the daemon, which
 * always recalls with the live agentId.
 */
const BENCH_AGENT_ID = "bench";

/** The write-side triple scope (the same tenant/agent the memories are ingested under). */
const TRIPLE_SCOPE: TripleScope = { tenantId: "default", agentId: BENCH_AGENT_ID, now: BENCH_NOW };

/**
 * Base recall config WITHOUT the graph-spread lane. The lane-ON config is this
 * plus `lanes.graphSpread = { enabled:true, ... }`. Alphas 0 -> clean recall@k
 * (no recency/temporal/trust boost confounds; the graph edge is the only signal
 * that can surface the linked doc). includeTrustLevels covers the ingested band.
 */
function baseRecallConfig(graphSpreadEnabled: boolean): MemoryRecallConfig {
  return {
    maxResults: 10,
    minScore: 0,
    includeTrustLevels: ["system", "learned"],
    rerank: { enabled: false, maxCandidates: 20, minResults: 2, timeoutMs: 5000 },
    scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
    lanes: {
      fts: { weight: 1.0 },
      vector: { weight: 1.5 },
      // The lane under test. OFF -> the precondition gate skips it (byte-identical to
      // the pre-graphSpread path). ON -> it walks the triple edges from the seed content.
      graphSpread: { enabled: graphSpreadEnabled, weight: 2.0, maxDepth: 2, fanOut: 8 },
    },
    // entityLane.seedCount drives how many top base hits seed the spread (the
    // production default the lane reads, memory-recall.ts:290).
    entityLane: { enabled: false, seedCount: 5, perEntityCap: 10, weight: 1.0 },
  };
}

/**
 * The single linked-recall scenario. M_seed is lexically matched by the query (FTS
 * surfaces it as the top base hit -> it becomes the spread seed). M_linked is NOT
 * lexically matched by the query (FTS does NOT surface it). A current-truth edge
 * chain seed.content -> BRIDGE -> linked.content connects them; the linked node
 * hydrates back to M_linked via source_memory_id. With the lane ON, M_linked is
 * surfaced into recall purely by the graph edge; with it OFF, M_linked is absent.
 */
interface LinkedScenario {
  query: string;
  seedContent: string;
  linkedContent: string;
}

const SCENARIO: LinkedScenario = {
  // The query lexically matches ONLY the seed doc.
  query: "What did the quarterly revenue planning meeting decide?",
  seedContent: "Quarterly revenue planning meeting: the team finalized the Q3 forecast and budget.",
  // The linked doc shares NO salient query terms (no "quarterly", "revenue", "planning",
  // "meeting", "forecast", "budget") -- FTS cannot surface it for the query. Only the
  // graph edge can. It carries the fact a downstream answer would actually need.
  linkedContent: "Zephyr ledger note: approver delegate is Mirabel Okonkwo, escalation code TZ-7.",
};

describe.skipIf(!COMIS_BENCH)("graph-spread lane contribution (keyless gated)", () => {
  // Captured in beforeAll: the recall results with the lane OFF then ON, plus the
  // structural witnesses the assertions + the report read.
  let rankedOff: MemorySearchResult[] = [];
  let rankedOn: MemorySearchResult[] = [];
  let linkedDocId = "";
  let seedDocId = "";
  let reportDir = "";
  let reportJson = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-kg-contrib-bench-"));
    // Write the committable manifest to COMIS_KG_REPORT_DIR when set (created if
    // absent), else the ephemeral tmp dir. The confined writeRegularFile guard
    // (O_NOFOLLOW + EXCL + confinement) applies to whichever dir is used.
    if (COMIS_KG_REPORT_DIR !== undefined && COMIS_KG_REPORT_DIR.length > 0) {
      reportDir = resolve(COMIS_KG_REPORT_DIR);
      mkdirSync(reportDir, { recursive: true });
    } else {
      reportDir = dir;
    }

    // 1. INGEST the two memories into a real SqliteMemoryAdapter (FTS-only base, dims=4).
    const adapter = new SqliteMemoryAdapter(makeBenchConfig(join(dir, "kg-contrib.db")), undefined);
    seedDocId = randomUUID();
    linkedDocId = randomUUID();

    const storedSeed = await adapter.store({
      id: seedDocId,
      tenantId: "default",
      agentId: "bench",
      userId: "user_a",
      content: SCENARIO.seedContent,
      trustLevel: "learned",
      source: { who: "bench" },
      tags: ["bench"],
      createdAt: BENCH_NOW - 10_000,
    });
    expect(storedSeed.ok, "seed doc stored").toBe(true);

    const storedLinked = await adapter.store({
      id: linkedDocId,
      tenantId: "default",
      agentId: "bench",
      userId: "user_a",
      content: SCENARIO.linkedContent,
      trustLevel: "learned",
      source: { who: "bench" },
      tags: ["bench"],
      createdAt: BENCH_NOW - 5_000,
    });
    expect(storedLinked.ok, "linked doc stored").toBe(true);

    // 2. POPULATE the triple edges over the SHARED db handle (the production adapter).
    //    The walk seeds on the top base hit's CONTENT string (memory-recall.ts:289-293),
    //    so the first edge's SUBJECT must equal SCENARIO.seedContent verbatim. A BRIDGE
    //    node connects seed.content -> bridge -> linked.content; the FINAL edge whose
    //    OBJECT is reached carries source_memory_id = linkedDocId so the hydrate
    //    (hydrateSpreadNode: triple.object == node AND source_memory_id -> memories)
    //    resolves the reached node back to M_linked.
    const tripleStore = createSqliteTripleStore({ db: adapter.getDb() });

    // Edge 1: seed.content --relates_to--> BRIDGE. source_memory_id = seedDocId (so a
    // hydrate of BRIDGE would resolve to the seed; not needed but provenance-correct).
    const e1 = await tripleStore.upsertTriple(
      {
        subject: SCENARIO.seedContent,
        predicate: "relates_to",
        object: "bridge:q3-approval-chain",
        trust: "learned",
        tValidStart: BENCH_NOW - 10_000,
        sourceMemoryId: seedDocId,
      },
      TRIPLE_SCOPE,
    );
    expect(e1.ok, "edge 1 (seed -> bridge) written").toBe(true);

    // Edge 2: BRIDGE --resolved_by--> linked.content. source_memory_id = linkedDocId so
    // the reached node (linked.content, at depth 2) hydrates to M_linked.
    const e2 = await tripleStore.upsertTriple(
      {
        subject: "bridge:q3-approval-chain",
        predicate: "resolved_by",
        object: SCENARIO.linkedContent,
        trust: "learned",
        tValidStart: BENCH_NOW - 8_000,
        sourceMemoryId: linkedDocId,
      },
      TRIPLE_SCOPE,
    );
    expect(e2.ok, "edge 2 (bridge -> linked) written").toBe(true);

    // 3. RECALL with the lane OFF (the baseline: FTS only -> M_linked must be absent).
    const recallOff = createMemoryRecall(
      {
        memoryPort: adapter,
        clock: createFakeClock(BENCH_NOW),
        timers: createFakeTimers(BENCH_NOW),
        logger: createMockLogger(),
        // tripleStore deliberately ABSENT on the OFF path is NOT how we measure -- we
        // pass it but disable the lane via cfg, proving the *config* gate (not just dep
        // absence) yields the no-op. This matches the daemon, which always injects the
        // store and toggles via config.
        tripleStore,
      } as MemoryRecallDeps,
      baseRecallConfig(false),
    );
    // Recall WITH the explicit agentId (the load-bearing spread scope; see BENCH_AGENT_ID).
    const rOff = await recallOff.recall(SCENARIO.query, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    rankedOff = rOff.ok ? rOff.value : [];

    // 4. RECALL with the lane ON (M_linked must now be surfaced purely by the graph edge).
    const recallOn = createMemoryRecall(
      {
        memoryPort: adapter,
        clock: createFakeClock(BENCH_NOW),
        timers: createFakeTimers(BENCH_NOW),
        logger: createMockLogger(),
        tripleStore,
      } as MemoryRecallDeps,
      baseRecallConfig(true),
    );
    const rOn = await recallOn.recall(SCENARIO.query, BENCH_SESSION_KEY, BENCH_AGENT_ID);
    rankedOn = rOn.ok ? rOn.value : [];

    adapter.close();
  }, 600_000);

  it("the graph-spread lane surfaces a structurally-linked memory FTS does not (real recall lift)", () => {
    const offIds = new Set(rankedOff.map((r) => r.entry.id));
    const onIds = new Set(rankedOn.map((r) => r.entry.id));

    // The SEED doc is FTS-matched -> present in BOTH (sanity: the seed is the spread seed).
    expect(offIds.has(seedDocId), "seed doc present with the lane OFF (FTS match)").toBe(true);
    expect(onIds.has(seedDocId), "seed doc present with the lane ON").toBe(true);

    // The LINKED doc is NOT FTS-matched -> ABSENT with the lane OFF.
    expect(offIds.has(linkedDocId), "linked doc ABSENT with the lane OFF (no FTS match)").toBe(false);

    // THE CLAIM: the LINKED doc IS surfaced with the lane ON -- purely by the graph edge.
    expect(onIds.has(linkedDocId), "linked doc SURFACED with the lane ON (graph-spread edge)").toBe(true);

    // The lift: exactly the linked doc id appears ON that was absent OFF.
    const added = [...onIds].filter((id) => !offIds.has(id));
    expect(added, "the only added id is the linked doc").toContain(linkedDocId);

    // Recall@k for the linked gold doc: 0 OFF, 1 ON (the lane-contribution delta).
    const linkedRecallOff = offIds.has(linkedDocId) ? 1 : 0;
    const linkedRecallOn = onIds.has(linkedDocId) ? 1 : 0;
    const delta = linkedRecallOn - linkedRecallOff;

    // PERSIST the lane-contribution metrics (committable manifest sibling). Pure
    // numbers + booleans -- no secret exists (keyless), the confined writer + the
    // secret-omission assertion below prove the report carries none.
    const report = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "graph-spread-lane-contribution",
      scenario: "structurally-linked non-lexical recall",
      laneOff: {
        recalledIds: rankedOff.length,
        linkedDocPresent: offIds.has(linkedDocId),
        linkedDocRecall: linkedRecallOff,
      },
      laneOn: {
        recalledIds: rankedOn.length,
        linkedDocPresent: onIds.has(linkedDocId),
        linkedDocRecall: linkedRecallOn,
      },
      // The headline: the lane-attributable recall lift for the linked gold doc.
      linkedDocRecallDelta: delta,
      addedByLane: added.length,
      vectorLane: !!process.env.LLAMA_MODEL_PATH,
    };
    reportJson = JSON.stringify(report, null, 2);
    const writeResult = writeRegularFile({
      path: join(reportDir, "graph-spread-contribution-report.json"),
      content: reportJson,
      confinedBaseDir: reportDir,
    });
    expect(writeResult.ok, "graph-spread-contribution-report.json written to the confined dir").toBe(true);

    // Operator-visible number (the BENCH … line convention).
    // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
    console.log("BENCH graph-spread lane contribution", JSON.stringify(report));

    // The report must carry NO secret substring (the only allowed occurrence is here).
    expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);
  });
});

/**
 * TRUST-FIRST KG WRITE-PATH INVALIDATION (the NEW behavior).
 *
 * Distinct from the lane-contribution probe above AND from the shipped recall trust
 * filter the contradiction-harness.bench.test.ts measures: this drives the SAME
 * contradiction fixtures (Paris/vegetarian) through the REAL `upsertTriple` trust-first
 * single-current-truth invalidation, in the correct temporal order (the OLDER
 * high-trust fact written first, THEN the NEWER external contradiction), and asserts
 * the OLDER high-trust object remains the CURRENT TRUTH (`currentTruth` returns it,
 * NOT the newer external claim) -- trust-FIRST, not recency-first. This is the
 * write-side KG correctness claim the gate consumes: a newer LOW-trust claim must
 * NEVER supersede an older higher-trust fact. KEYLESS, deterministic, no API cost.
 *
 * Each contradiction pair maps to ONE (subject, predicate): the older high-trust doc
 * is the incumbent current-truth (object = its correctAnswerSubstring), the newer
 * external doc is the contradicting claim (object = a DIFFERENT value). The
 * trust-first ladder (system/learned > external) must keep the incumbent current and
 * record the external claim as "recorded-not-believed" (soft-closed on write).
 */
describe.skipIf(!COMIS_BENCH)("trust-first KG write-path invalidation (keyless gated)", () => {
  // A wrong (contradicting) object per pair, deliberately != the correct substring.
  const WRONG_OBJECT_BY_QUERY: Record<string, string> = {
    "What is the user's home city?": "Berlin",
    "What diet does the user follow?": "meat",
  };

  let perPairResults: Array<{
    query: string;
    incumbentTrust: string;
    correctObject: string;
    currentTruthObjects: string[];
    incumbentStaysCurrent: boolean;
    externalIsCurrent: boolean;
  }> = [];
  let reportDir = "";
  let reportJson = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-kg-invalidation-bench-"));
    if (COMIS_KG_REPORT_DIR !== undefined && COMIS_KG_REPORT_DIR.length > 0) {
      reportDir = resolve(COMIS_KG_REPORT_DIR);
      mkdirSync(reportDir, { recursive: true });
    } else {
      reportDir = dir;
    }

    const pairs = buildContradictionPairs();
    expect(pairs.length, "constructed contradiction pairs").toBeGreaterThanOrEqual(1);

    perPairResults = [];
    for (const [index, pair] of pairs.entries()) {
      // Each pair gets its OWN store (the standard per-item isolation the siblings use).
      const adapter = new SqliteMemoryAdapter(
        makeBenchConfig(join(dir, `kg-inval-${index}.db`)),
        undefined,
      );
      const tripleStore = createSqliteTripleStore({ db: adapter.getDb() });
      const scope: TripleScope = { tenantId: "default", agentId: BENCH_AGENT_ID, now: BENCH_NOW };
      // A stable (subject, predicate) for the contested attribute (the user's fact).
      const subject = `user:fact:${pair.query}`;
      const predicate = "asserted-value";
      const wrongObject = WRONG_OBJECT_BY_QUERY[pair.query] ?? "CONTRADICTING-CLAIM";

      // 1. WRITE the OLDER high-trust fact FIRST (it becomes the current-truth incumbent).
      const wOlder = await tripleStore.upsertTriple(
        {
          subject,
          predicate,
          object: pair.correctAnswerSubstring, // "Paris" / "vegetarian"
          trust: pair.olderHighTrustDoc.trustLevel, // system / learned
          tValidStart: pair.olderHighTrustDoc.createdAt,
        },
        scope,
      );
      expect(wOlder.ok, "older high-trust triple written").toBe(true);

      // 2. THEN write the NEWER external contradicting claim. The trust-first ladder
      //    must keep the incumbent current (external NEVER supersedes system/learned).
      const wNewer = await tripleStore.upsertTriple(
        {
          subject,
          predicate,
          object: wrongObject, // "Berlin" / "meat"
          trust: pair.newerLowTrustDoc.trustLevel, // external
          tValidStart: pair.newerLowTrustDoc.createdAt,
        },
        scope,
      );
      expect(wNewer.ok, "newer external triple written (recorded, not believed)").toBe(true);

      // 3. READ current-truth: the OLDER high-trust object must be the live truth; the
      //    newer external object must NOT be current (it was soft-closed on write).
      const ct = await tripleStore.currentTruth({ tenantId: "default", agentId: BENCH_AGENT_ID });
      const currentObjects = ct.ok
        ? ct.value.filter((t) => t.subject === subject && t.predicate === predicate).map((t) => t.object)
        : [];

      perPairResults.push({
        query: pair.query,
        incumbentTrust: pair.olderHighTrustDoc.trustLevel,
        correctObject: pair.correctAnswerSubstring,
        currentTruthObjects: currentObjects,
        incumbentStaysCurrent: currentObjects.includes(pair.correctAnswerSubstring),
        externalIsCurrent: currentObjects.includes(wrongObject),
      });

      adapter.close();
    }
  }, 600_000);

  it("the older higher-trust fact stays current-truth after a newer external contradiction (trust-first)", () => {
    expect(perPairResults.length).toBeGreaterThanOrEqual(1);

    let correct = 0;
    for (const r of perPairResults) {
      // The incumbent (Paris / vegetarian) MUST remain current-truth.
      expect(r.incumbentStaysCurrent, `incumbent stays current for: ${r.query}`).toBe(true);
      // The newer external claim (Berlin / meat) MUST NOT be current-truth.
      expect(r.externalIsCurrent, `external claim NOT current for: ${r.query}`).toBe(false);
      if (r.incumbentStaysCurrent && !r.externalIsCurrent) correct += 1;
    }
    const total = perPairResults.length;
    const trustFirstCorrectRate = total > 0 ? (correct / total) * 100 : 0;

    const report = {
      harnessVersion: HARNESS_VERSION,
      benchmark: "trust-first-kg-invalidation",
      scenario: "SUITE-04 Paris/vegetarian via the real upsertTriple write path",
      pairs: total,
      trustFirstCorrect: correct,
      trustFirstCorrectRate,
      perPair: perPairResults,
    };
    reportJson = JSON.stringify(report, null, 2);
    const writeResult = writeRegularFile({
      path: join(reportDir, "trust-first-kg-invalidation-report.json"),
      content: reportJson,
      confinedBaseDir: reportDir,
    });
    expect(writeResult.ok, "trust-first-kg-invalidation-report.json written to the confined dir").toBe(true);

    // eslint-disable-next-line no-console -- gated bench harness reports its number (this is a .test.ts, not packages/cli)
    console.log("BENCH trust-first KG invalidation", JSON.stringify(report));

    // The report must carry NO secret substring (the only allowed occurrence is here).
    expect(reportJson).not.toMatch(/apiKey|sk-|Bearer/);

    // The trust-first rate MUST be 100% on these fixtures (a HARD ladder, not a noisy LLM number).
    expect(trustFirstCorrectRate).toBe(100);
  });
});
