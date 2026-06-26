// SPDX-License-Identifier: Apache-2.0
/**
 * Recall-diagnostics isolation + end-to-end redaction integration test
 * (the security capstone for the recall-observability surface).
 *
 * The Wave-4 capstone for the recall-observability surface. It proves, through
 * the REAL wired stores + the REAL admin-gated RPC handlers + the REAL agent
 * recall path (NOT mocks), that the diagnostics never widen the security
 * surface:
 *
 *   1. CROSS-SCOPE-LEAK NEGATIVE (failing-first) — a diagnostic query
 *      for agent A NEVER returns agent B's data, in EITHER direction, for both
 *      the provenance lane (`listObservations` / the `memory.observations`
 *      handler) AND the entity-graph lane (`listEntities` / the
 *      `memory.entities` handler). Seeded with the BYTE-IDENTICAL entity name
 *      across SCOPE_1 / SCOPE_2 so the ONLY thing separating them is the
 *      `(tenant, agent)` SQL predicate (mirrors the capstone in
 *      `entity-associative-isolation.test.ts`). The negatives turn RED if the
 *      WHERE scope is dropped: the foreign-scope rows share the same name, so
 *      only the scope predicate excludes them.
 *
 *   2. POSITIVE CONTROL (same scope) — the SCOPE_1 diagnostic returns the
 *      SCOPE_1 rows (proving the scope is not just "returns nothing").
 *
 *   3. ADMIN-REJECT (EoP) — every diagnostic handler (recall_trace,
 *      observations, entities, recall_stats), invoked with a non-admin
 *      `_trustLevel`, throws "Admin access required ..." BEFORE any query runs.
 *
 *   4. END-TO-END REDACTION PROOF (failing-first) — a recall driven
 *      through the REAL `createMemoryRecall` path over a memory seeded with a
 *      secret token + a fake message body + an absolute path records a
 *      recall-trace JSONL that contains NONE of them, yet still parses as a
 *      valid `RecallTraceEventSchema` record (redaction did not drop
 *      everything). The integration sibling of the unit redaction proof.
 *
 * INTEGRATION TIER (CLAUDE.md / RESEARCH Pitfall 6): imports the REAL stores,
 * handlers, and recall via BARE "@comis" package specifiers (vitest aliases
 * them to the per-package dist entrypoints), so "pnpm build" MUST run first: a
 * src edit is invisible until the dist is rebuilt. No deep relative import into
 * any package src tree appears in this file.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ok, type Result } from "@comis/shared";
import type {
  MemoryEntry,
  MemoryConfig,
  EmbeddingPort,
  ClockPort,
  ComisLogger,
  SessionKey,
} from "@comis/core";
import {
  SqliteMemoryAdapter,
  createSqliteMemoryEntityStore,
  createSqliteMemoryConsolidationStore,
} from "@comis/memory";
import { createMemoryHandlers, type MemoryHandlerDeps } from "@comis/daemon";
import { createMemoryRecall, buildRecallTrace } from "@comis/agent";
import { createRecallTrace, RecallTraceEventSchema } from "@comis/observability";
import type Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Fixtures (mirror entity-associative-isolation.test.ts)
// ---------------------------------------------------------------------------

const memoryConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
};

// The shared entity name used across BOTH scopes — byte-identical so the only
// thing separating the two scopes' entity rows is the (tenant, agent) partition.
const SHARED_ENTITY = "Project Helios";

// Two isolated scopes. The negatives assert neither leaks into the other.
const SCOPE_1 = { tenantId: "tenant_1", agentId: "agent_1" } as const;
const SCOPE_2 = { tenantId: "tenant_2", agentId: "agent_2" } as const;

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? randomUUID(),
    tenantId: overrides.tenantId ?? "tenant_1",
    agentId: overrides.agentId ?? "agent_1",
    userId: overrides.userId ?? "user_a",
    content: overrides.content ?? "neutral content",
    trustLevel: overrides.trustLevel ?? "learned",
    source: overrides.source ?? { who: "agent", channel: "test" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    ...(overrides.embedding ? { embedding: overrides.embedding } : {}),
    ...(overrides.proofCount !== undefined ? { proofCount: overrides.proofCount } : {}),
    ...(overrides.sourceIds !== undefined ? { sourceIds: overrides.sourceIds } : {}),
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
    ...(overrides.consolidatedAt !== undefined ? { consolidatedAt: overrides.consolidatedAt } : {}),
  };
}

function deterministicEmbeddingPort(): EmbeddingPort {
  return {
    provider: "test",
    dimensions: 4,
    modelId: "test-embed",
    async embed(text: string): Promise<Result<number[], Error>> {
      const v = new Array(4).fill(0);
      for (let i = 0; i < Math.min(text.length, 4); i++) {
        v[i] = text.charCodeAt(i) / 256;
      }
      return ok(v);
    },
    async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
      const v: number[][] = [];
      for (const t of texts) {
        const r = await this.embed(t);
        if (r.ok) v.push(r.value);
      }
      return ok(v);
    },
  };
}

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
} as unknown as ComisLogger;

/** Minimal MemoryHandlerDeps wiring the two REAL scoped stores + deps.tenantId. */
function makeHandlerDeps(
  adapter: SqliteMemoryAdapter,
  entityStore: ReturnType<typeof createSqliteMemoryEntityStore>,
  consolidationStore: ReturnType<typeof createSqliteMemoryConsolidationStore>,
  tenantId: string,
  defaultAgentId: string,
  dataDir?: string,
): MemoryHandlerDeps {
  return {
    defaultAgentId,
    defaultWorkspaceDir: os.tmpdir(),
    tenantId,
    workspaceDirs: new Map<string, string>(),
    // When set, the memory.recall_trace handler reads
    // <dataDir>/logs/recall-trace.jsonl — the SAME path the recorder writes.
    ...(dataDir !== undefined ? { dataDir } : {}),
    // memoryApi is required by the slice but the diagnostic handlers under test
    // never touch it — a structural stub that throws if any handler does.
    memoryApi: new Proxy(
      {},
      {
        get() {
          throw new Error("memoryApi must not be called by the diagnostic handlers under test");
        },
      },
    ) as unknown as MemoryHandlerDeps["memoryApi"],
    memoryAdapter: adapter,
    logger: noopLogger,
    entityStore,
    consolidationStore,
  };
}

// ===========================================================================
// Cross-scope-leak NEGATIVE + positive control + admin-reject
// ===========================================================================

describe("Recall diagnostics -- cross-scope isolation through the wired stores + handlers", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let entityStore: ReturnType<typeof createSqliteMemoryEntityStore>;
  let consolidationStore: ReturnType<typeof createSqliteMemoryConsolidationStore>;

  async function seedMemory(overrides: Partial<MemoryEntry>): Promise<string> {
    const entry = makeEntry(overrides);
    const r = await adapter.store(entry);
    expect(r.ok).toBe(true);
    return entry.id;
  }

  /** Mint an observation (proof_count IS NOT NULL) under a scope via the REAL
   *  store write path so `listObservations` surfaces it. (Phase 226 trimmed the
   *  consolidation-cron `applyConsolidation` writer; an observation is identified
   *  by `proof_count IS NOT NULL`, so a direct `store(...)` of an observation row
   *  + a scoped source-mark is the equivalent seed.) */
  async function seedObservation(
    scope: { tenantId: string; agentId: string },
    sourceId: string,
    content: string,
  ): Promise<string> {
    const observation = makeEntry({
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      content,
      trustLevel: "learned",
      proofCount: 1,
      sourceIds: [sourceId],
      confidence: 0.9,
      consolidatedAt: 1_700_000_100_000,
    });
    const stored = await adapter.store(observation);
    expect(stored.ok).toBe(true);
    // Mark the source consolidated_at (scoped) — the side effect the retired
    // applyConsolidation used to perform, kept so the source leaves the raw pool.
    db.prepare("UPDATE memories SET consolidated_at = ? WHERE id = ? AND tenant_id = ?").run(
      1_700_000_100_000,
      sourceId,
      scope.tenantId,
    );
    return observation.id;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig, deterministicEmbeddingPort());
    db = adapter.getDb();
    // The REAL wired stores the daemon's setup-memory builds — on ONE shared db
    // handle (NOT a mock), so the FK rows + the (tenant, agent) scope are
    // consistent across the memory / entity / observation tables.
    entityStore = createSqliteMemoryEntityStore({ db, logger: noopLogger });
    consolidationStore = createSqliteMemoryConsolidationStore({ db, logger: noopLogger });
  });

  afterEach(() => {
    db.close();
  });

  it("returns the in-scope observations + entities for a same-scope diagnostic (positive control)", async () => {
    const m1 = await seedMemory({ ...SCOPE_1 });
    const obsId = await seedObservation(SCOPE_1, m1, "scope_1 observation body");
    const m2 = await seedMemory({ ...SCOPE_1 });
    const linkRes = await entityStore.resolveAndLink(m2, SHARED_ENTITY, { ...SCOPE_1, now: 1_000 });
    expect(linkRes.ok).toBe(true);

    // (a) directly via the scoped ports
    const obs = await consolidationStore.listObservations(SCOPE_1.agentId, SCOPE_1.tenantId, 50);
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.value.map((e) => e.id)).toContain(obsId);

    const ents = await entityStore.listEntities(SCOPE_1.agentId, SCOPE_1.tenantId, 100);
    expect(ents.ok).toBe(true);
    if (!ents.ok) return;
    expect(ents.value.some((row) => row.name === SHARED_ENTITY)).toBe(true);

    // (b) through the REAL admin-gated handlers (tenant omitted ⇒ deps.tenantId)
    const handlers = createMemoryHandlers(
      makeHandlerDeps(adapter, entityStore, consolidationStore, SCOPE_1.tenantId, SCOPE_1.agentId),
    );
    const obsResp = (await handlers["memory.observations"]({
      _trustLevel: "admin",
      agent_id: SCOPE_1.agentId,
    })) as { observations: Array<{ id: string }> };
    expect(obsResp.observations.map((o) => o.id)).toContain(obsId);

    const entResp = (await handlers["memory.entities"]({
      _trustLevel: "admin",
      agent_id: SCOPE_1.agentId,
    })) as { entities: Array<{ name: string }> };
    expect(entResp.entities.some((e) => e.name === SHARED_ENTITY)).toBe(true);
  });

  it("does NOT surface a cross-tenant/cross-agent OBSERVATION in either direction (provenance cross-scope-leak negative)", async () => {
    // SCOPE_1 observations (oA, oB) + a SCOPE_2 observation (oC). The
    // (tenant, agent) WHERE in listObservations is the ONLY thing that excludes
    // the foreign rows — drop it and oC leaks into the SCOPE_1 result (and
    // oA/oB into the SCOPE_2 result). That is the RED construction.
    const s1m1 = await seedMemory({ ...SCOPE_1 });
    const s1m2 = await seedMemory({ ...SCOPE_1 });
    const oA = await seedObservation(SCOPE_1, s1m1, "scope_1 observation A");
    const oB = await seedObservation(SCOPE_1, s1m2, "scope_1 observation B");

    const s2m1 = await seedMemory({ ...SCOPE_2 });
    const oC = await seedObservation(SCOPE_2, s2m1, "scope_2 observation C");

    // FORWARD: the SCOPE_1 provenance diagnostic returns ONLY SCOPE_1 rows.
    const fromScope1 = await consolidationStore.listObservations(SCOPE_1.agentId, SCOPE_1.tenantId, 50);
    expect(fromScope1.ok).toBe(true);
    if (!fromScope1.ok) return;
    const ids1 = fromScope1.value.map((e) => e.id);
    expect(ids1).toContain(oA);
    expect(ids1).toContain(oB);
    expect(ids1).not.toContain(oC); // <-- the cross-scope leak guard (provenance)

    // REVERSE: the SCOPE_2 provenance diagnostic returns ONLY SCOPE_2 rows.
    const fromScope2 = await consolidationStore.listObservations(SCOPE_2.agentId, SCOPE_2.tenantId, 50);
    expect(fromScope2.ok).toBe(true);
    if (!fromScope2.ok) return;
    const ids2 = fromScope2.value.map((e) => e.id);
    expect(ids2).toContain(oC);
    expect(ids2).not.toContain(oA);
    expect(ids2).not.toContain(oB);

    // Through the handler too: a SCOPE_1-scoped handler asked for SCOPE_1 never
    // returns the SCOPE_2 observation, and vice versa.
    const h1 = createMemoryHandlers(
      makeHandlerDeps(adapter, entityStore, consolidationStore, SCOPE_1.tenantId, SCOPE_1.agentId),
    );
    const r1 = (await h1["memory.observations"]({
      _trustLevel: "admin",
      agent_id: SCOPE_1.agentId,
    })) as { observations: Array<{ id: string }> };
    expect(r1.observations.map((o) => o.id)).not.toContain(oC);

    const h2 = createMemoryHandlers(
      makeHandlerDeps(adapter, entityStore, consolidationStore, SCOPE_2.tenantId, SCOPE_2.agentId),
    );
    const r2 = (await h2["memory.observations"]({
      _trustLevel: "admin",
      agent_id: SCOPE_2.agentId,
    })) as { observations: Array<{ id: string }> };
    expect(r2.observations.map((o) => o.id)).not.toContain(oA);
    expect(r2.observations.map((o) => o.id)).not.toContain(oB);
  });

  it("does NOT surface a cross-tenant/cross-agent ENTITY sharing the byte-identical name in either direction (entity-graph cross-scope-leak negative)", async () => {
    // The SAME entity name in BOTH scopes. The resolver partitions by
    // (tenant, agent), so listEntities(SCOPE_1) returns only the SCOPE_1 row and
    // listEntities(SCOPE_2) only the SCOPE_2 row — even though the NAME is
    // byte-identical. The scope predicate is the only thing keeping the foreign
    // row out: drop it and BOTH rows surface in BOTH directions.
    const s1m = await seedMemory({ ...SCOPE_1 });
    const l1 = await entityStore.resolveAndLink(s1m, SHARED_ENTITY, { ...SCOPE_1, now: 1_000 });
    expect(l1.ok).toBe(true);

    const s2m = await seedMemory({ ...SCOPE_2 });
    const l2 = await entityStore.resolveAndLink(s2m, SHARED_ENTITY, { ...SCOPE_2, now: 1_100 });
    expect(l2.ok).toBe(true);
    if (!l1.ok || !l2.ok) return;

    // The two scopes minted DIFFERENT entity ids for the same name (partitioned).
    expect(l1.value).not.toBe(l2.value);

    // FORWARD: SCOPE_1 entity-graph diagnostic returns the SCOPE_1 row only.
    const fromScope1 = await entityStore.listEntities(SCOPE_1.agentId, SCOPE_1.tenantId, 100);
    expect(fromScope1.ok).toBe(true);
    if (!fromScope1.ok) return;
    const entIds1 = fromScope1.value.map((row) => row.id);
    expect(entIds1).toContain(l1.value);
    expect(entIds1).not.toContain(l2.value); // <-- the cross-scope leak guard (entity)

    // REVERSE: SCOPE_2 entity-graph diagnostic returns the SCOPE_2 row only.
    const fromScope2 = await entityStore.listEntities(SCOPE_2.agentId, SCOPE_2.tenantId, 100);
    expect(fromScope2.ok).toBe(true);
    if (!fromScope2.ok) return;
    const entIds2 = fromScope2.value.map((row) => row.id);
    expect(entIds2).toContain(l2.value);
    expect(entIds2).not.toContain(l1.value);

    // Through the handler: SCOPE_1-scoped never returns the SCOPE_2 entity id.
    const h1 = createMemoryHandlers(
      makeHandlerDeps(adapter, entityStore, consolidationStore, SCOPE_1.tenantId, SCOPE_1.agentId),
    );
    const r1 = (await h1["memory.entities"]({
      _trustLevel: "admin",
      agent_id: SCOPE_1.agentId,
    })) as { entities: Array<{ id: string }> };
    expect(r1.entities.map((e) => e.id)).not.toContain(l2.value);
  });

  it("rejects every diagnostic handler when the caller is not an admin (EoP admin-reject)", async () => {
    const handlers = createMemoryHandlers(
      makeHandlerDeps(adapter, entityStore, consolidationStore, SCOPE_1.tenantId, SCOPE_1.agentId),
    );
    // Each of the 4 admin-gated diagnostic handlers throws BEFORE any query when
    // _trustLevel !== "admin" (the V4/EoP fence — non-admin gets nothing).
    await expect(
      handlers["memory.observations"]({ _trustLevel: "rpc", agent_id: SCOPE_1.agentId }),
    ).rejects.toThrow(/Admin access required/);
    await expect(
      handlers["memory.entities"]({ _trustLevel: "rpc", agent_id: SCOPE_1.agentId }),
    ).rejects.toThrow(/Admin access required/);
    await expect(
      handlers["memory.recall_stats"]({ _trustLevel: "user" }),
    ).rejects.toThrow(/Admin access required/);
    await expect(
      handlers["memory.recall_trace"]({ _trustLevel: "user", session_key: "s1" }),
    ).rejects.toThrow(/Admin access required/);
  });
});

// ===========================================================================
// End-to-end recall-trace redaction proof
// ===========================================================================

describe("recall-trace redaction (end-to-end)", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let tmpFile: string;

  // The three things that must NEVER reach the on-disk trace.
  const SECRET = "sk-ABCDEF0123456789SECRET";
  const FAKE_BODY = "the user's bank password is hunter2";
  const ABS_PATH = "/Users/alice/.comis/secrets.yaml";

  const fixedClock: ClockPort = {
    now: () => 1_700_000_000_000,
    monotonicNow: () => 0,
  } as unknown as ClockPort;

  const SESSION_KEY = {
    tenantId: "tenant_redact",
    userId: "user_a",
    channelId: "chan_1",
    agentId: "agent_redact",
  } as unknown as SessionKey;

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig, deterministicEmbeddingPort());
    db = adapter.getDb();
    tmpFile = `${os.tmpdir()}/recall-trace-e2e-${randomUUID()}.jsonl`;
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
  });

  it("records a redacted-yet-valid recall trace that contains no seeded secret, body, or absolute path", async () => {
    // Seed a memory whose CONTENT carries a secret token, a fake message body,
    // and an absolute path — exactly the three leak classes.
    const memId = randomUUID();
    const stored = await adapter.store(
      makeEntry({
        id: memId,
        tenantId: SESSION_KEY.tenantId as string,
        agentId: SESSION_KEY.agentId as string,
        userId: "user_a",
        content: `secret=${SECRET}; ${FAKE_BODY}; path=${ABS_PATH}`,
        trustLevel: "learned",
        createdAt: 1_700_000_000_000,
      }),
    );
    expect(stored.ok).toBe(true);

    // Build the REAL recorder (the recording chokepoint) writing to a tmp file.
    const recallTrace = createRecallTrace({
      enabled: true,
      filePath: tmpFile,
      agentId: SESSION_KEY.agentId as string,
      sessionId: "session-redact",
      envelope: { tenantId: SESSION_KEY.tenantId as string },
    });
    expect(recallTrace).not.toBeNull();
    if (recallTrace === null) return;

    // Drive a real recall through createMemoryRecall (the capture path):
    // the memory is surfaced AND recorded. recallTrace + clock + logger mirror
    // prompt-assembly's deps.
    const recall = createMemoryRecall(
      {
        memoryPort: adapter,
        clock: fixedClock,
        logger: noopLogger,
        recallTrace,
      },
      {
        maxResults: 5,
        minScore: 0,
        includeTrustLevels: ["system", "learned"],
        rerank: { enabled: false, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
        scoring: {
          recencyAlpha: 0.2,
          temporalAlpha: 0.2,
          proofAlpha: 0.1,
          trustAlpha: 0.1,
          // The usefulness and forget weights are two more required ScoringAlphas.
          // Production config defaults both to 0.1; omitting them here left usefulnessAlpha
          // undefined, so `1 + undefined*(…)` = NaN propagated into the breakdown's
          // `usefulness`/`final`, which JSON-serialize as `null` and fail the
          // RecallScoreBreakdownSchema's z.number() (real callers always supply all six).
          usefulnessAlpha: 0.1,
          forgetAlpha: 0.1,
        },
      },
    );

    // Query with the secret token itself so the FTS lane surfaces the memory —
    // this also proves the raw QUERY never lands on disk (it is recorded as a
    // sha256 digest, never raw text).
    const result = await recall.recall(SECRET, SESSION_KEY, SESSION_KEY.agentId as string);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The seeded memory was actually surfaced (so the trace recorded a non-empty recall).
    expect(result.value.map((r) => r.entry.id)).toContain(memId);

    await recallTrace.flush();

    // Read the on-disk trace and assert NONE of the three leak classes appear.
    const onDisk = fs.readFileSync(tmpFile, "utf-8");
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).not.toContain("hunter2");
    expect(onDisk).not.toContain(ABS_PATH);
    // The raw query (= the secret token) must not appear either — it is digested.
    expect(onDisk).not.toContain("ABCDEF0123456789");

    // Redaction did NOT simply drop everything: the line parses as a valid
    // recall record (schema-conformant) and references the surfaced memory id.
    const lines = onDisk.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = RecallTraceEventSchema.safeParse(JSON.parse(lines[0]!));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.queryDigest.length).toBeGreaterThan(0);
    expect(parsed.data.ranked.map((r) => r.id)).toContain(memId);
  });
});

// ===========================================================================
// Recall-trace READ-BACK through the production recorder path
// ===========================================================================

describe("memory.recall_trace read-back via the REAL production recorder", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let dataDir: string;

  const fixedClock: ClockPort = {
    now: () => 1_700_000_000_000,
    monotonicNow: () => 0,
  } as unknown as ClockPort;

  // The scope the recorder writes and the handler filters on.
  const SESSION_KEY = {
    tenantId: "tenant_wr01",
    userId: "user_a",
    channelId: "chan_1",
    agentId: "agent_wr01",
  } as unknown as SessionKey;
  // The formatted session key the CLI's `recall-trace <session>` selector passes
  // (tenantId:userId:channelId — formatSessionKey does NOT serialize agentId).
  const SESSION_KEY_STR = "tenant_wr01:user_a:chan_1";

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig, deterministicEmbeddingPort());
    db = adapter.getDb();
    dataDir = fs.mkdtempSync(`${os.tmpdir()}/comis-wr01-`);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Drive a real recall through the PRODUCTION recorder wiring (buildRecallTrace
   *  → createRecallTrace with the authoritative envelope + dataDir-derived base)
   *  and createMemoryRecall, writing to <dataDir>/logs/recall-trace.jsonl. */
  async function recordRealRecall(scope: SessionKey, tenantId: string): Promise<string> {
    const memId = randomUUID();
    const stored = await adapter.store(
      makeEntry({
        id: memId,
        tenantId: scope.tenantId as string,
        agentId: scope.agentId as string,
        userId: "user_a",
        content: "a recalled note about the quarterly plan",
        trustLevel: "learned",
        createdAt: 1_700_000_000_000,
      }),
    );
    expect(stored.ok).toBe(true);

    // THE PRODUCTION WIRING: buildRecallTrace threads the envelope (sessionKey +
    // tenantId) and resolves confinedBaseDir from dataDir — exactly as
    // prompt-assembly does. No hand-written fixture.
    const recallTrace = buildRecallTrace(
      { enabled: true },
      scope.agentId as string,
      "tenant_wr01:user_a:chan_1".replace("tenant_wr01", scope.tenantId as string),
      dataDir,
      {
        sessionKey: "tenant_wr01:user_a:chan_1".replace("tenant_wr01", scope.tenantId as string),
        tenantId,
      },
    );
    expect(recallTrace).not.toBeNull();
    if (recallTrace === null) throw new Error("recorder unexpectedly null");

    const recall = createMemoryRecall(
      { memoryPort: adapter, clock: fixedClock, logger: noopLogger, recallTrace },
      {
        maxResults: 5,
        minScore: 0,
        includeTrustLevels: ["system", "learned"],
        rerank: { enabled: false, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
        scoring: {
          recencyAlpha: 0.2,
          temporalAlpha: 0.2,
          proofAlpha: 0.1,
          trustAlpha: 0.1,
          // The usefulness and forget weights are two more required ScoringAlphas.
          // Production config defaults both to 0.1; omitting them here left usefulnessAlpha
          // undefined, so `1 + undefined*(…)` = NaN propagated into the breakdown's
          // `usefulness`/`final`, which JSON-serialize as `null` and fail the
          // RecallScoreBreakdownSchema's z.number() (real callers always supply all six).
          usefulnessAlpha: 0.1,
          forgetAlpha: 0.1,
        },
      },
    );
    const result = await recall.recall("quarterly plan", scope, scope.agentId as string);
    expect(result.ok).toBe(true);
    await recallTrace.flush();
    return memId;
  }

  it("returns the recorded trace when read back by session_key (RED on the pre-fix selector)", async () => {
    const memId = await recordRealRecall(SESSION_KEY, SESSION_KEY.tenantId as string);

    const handlers = createMemoryHandlers(
      makeHandlerDeps(
        adapter,
        // entity/consolidation stores are unused by recall_trace — structural stubs.
        createSqliteMemoryEntityStore({ db, logger: noopLogger }),
        createSqliteMemoryConsolidationStore({ db, logger: noopLogger }),
        SESSION_KEY.tenantId as string,
        SESSION_KEY.agentId as string,
        dataDir,
      ),
    );

    const resp = (await handlers["memory.recall_trace"]({
      _trustLevel: "admin",
      session_key: SESSION_KEY_STR,
    })) as { records: Array<Record<string, unknown>> };

    // THE BINDING ASSERTION: the production recorder's record is RETURNED.
    // Pre-fix this was [] — the recorder wrote `sessionId` (no `sessionKey`) and
    // the handler matched only `rec.sessionKey`.
    expect(resp.records.length).toBeGreaterThan(0);
    const rec = resp.records[0]!;
    // The record carries the authoritative scope the envelope wired.
    expect(rec.sessionKey).toBe(SESSION_KEY_STR);
    expect(rec.tenantId).toBe(SESSION_KEY.tenantId);
    expect(rec.agentId).toBe(SESSION_KEY.agentId);
    // And it references the surfaced memory (the trace is the real recall).
    expect(JSON.stringify(rec)).toContain(memId);
  });

  it("does NOT return a recall trace recorded under a DIFFERENT tenant (read-side cross-tenant filter)", async () => {
    // Record under tenant_wr01, then ask the handler scoped to a DIFFERENT
    // tenant. The read-side tenant scope-filter (rec.tenantId) was revived,
    // so the foreign-tenant query returns nothing even though the session_key
    // string would otherwise match.
    await recordRealRecall(SESSION_KEY, SESSION_KEY.tenantId as string);

    const handlers = createMemoryHandlers(
      makeHandlerDeps(
        adapter,
        createSqliteMemoryEntityStore({ db, logger: noopLogger }),
        createSqliteMemoryConsolidationStore({ db, logger: noopLogger }),
        "tenant_OTHER",
        SESSION_KEY.agentId as string,
        dataDir,
      ),
    );

    const resp = (await handlers["memory.recall_trace"]({
      _trustLevel: "admin",
      session_key: SESSION_KEY_STR,
    })) as { records: Array<Record<string, unknown>> };

    expect(resp.records).toHaveLength(0);
  });
});
