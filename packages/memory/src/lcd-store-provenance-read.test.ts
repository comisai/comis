// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildProvenanceReadStore — the concrete LcdProvenanceReadStore
 * adapter.
 *
 * The read-mirror of the write-side `lcd-store-provenance.ts` (buildProvenanceWrites).
 * It owns the single scoped SELECT the dormant recall provenance pass
 * (packages/agent/src/rag/recall-provenance.ts) reads to find the EXACT
 * provenance-linked memoryIds a distilled summary subsumes.
 *
 * Tenant + agent isolation is the load-bearing security property: the SELECT carries
 * `WHERE summary_id = ? AND tenant_id = ? AND agent_id = ?` (mirror the write side).
 * A cross-tenant OR cross-agent read MUST return ZERO rows (fail-closed) — a
 * summary_id collision under a different scope can never leak another scope's
 * provenance into the recall down-weighting pass.
 *
 * In-memory db + initSchema/ensureLcdTables, seeding via buildProvenanceWrites
 * (the production write path) — mirrors lcd-store.test.ts's provenance fixtures.
 */
import { type ContextStoreScope } from "@comis/core";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { initSchema } from "./schema.js";
import { buildProvenanceWrites } from "./lcd-store-provenance.js";
import { buildProvenanceReadStore } from "./lcd-store-provenance-read.js";

const T = "tenant-p";
const A = "agent-p";
const S = "sum-1";
const M = "mem-1";

/** The matching (tenant, agent) scope for summary S. summaryId/sessionKey on the
 *  scope are not load-bearing for the read (it filters on summary_id arg +
 *  scope.tenantId + scope.agentId), but the port takes a full scope. */
const SCOPE_MATCH: ContextStoreScope = {
  conversationId: "conv-p",
  tenantId: T,
  agentId: A,
  sessionKey: "sess-p",
};

describe("buildProvenanceReadStore — tenant/agent-scoped getProvenanceForSummary", () => {
  let db: Database.Database;
  let reader: ReturnType<typeof buildProvenanceReadStore>;

  /** Insert a minimal memories row so the provenance FK (memory_id → memories.id) resolves. */
  function seedMemoryRow(id: string, tenantId = T, agentId = A, sessionKey = "sess-p"): void {
    db.prepare(
      "INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, source_session_key, tags, created_at)" +
        " VALUES (?, ?, ?, 'user-p', 'distilled content', 'learned', 'episodic', 'agent', ?, '[]', 1)",
    ).run(id, tenantId, agentId, sessionKey);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536); // also runs ensureLcdTables (lcd_memory_provenance DDL)
    reader = buildProvenanceReadStore(db);
  });

  it("returns the provenance row for the matching (tenant, agent) scope and summaryId", () => {
    const writes = buildProvenanceWrites(db);
    seedMemoryRow(M);
    writes.appendProvenance({
      provenanceId: "prov-1",
      memoryId: M,
      summaryId: S,
      sourceSessionKey: "sess-p",
      conversationId: "conv-p",
      agentId: A,
      tenantId: T,
      createdAt: 123,
    });

    const rows = reader.getProvenanceForSummary(SCOPE_MATCH, S);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      provenanceId: "prov-1",
      memoryId: M,
      sourceSessionKey: "sess-p",
      supersededBy: null,
    });
  });

  it("returns ZERO rows for a DIFFERENT tenant (cross-tenant fail-closed)", () => {
    const writes = buildProvenanceWrites(db);
    seedMemoryRow(M);
    writes.appendProvenance({
      provenanceId: "prov-1",
      memoryId: M,
      summaryId: S,
      sourceSessionKey: "sess-p",
      conversationId: "conv-p",
      agentId: A,
      tenantId: T,
      createdAt: 123,
    });

    // Same summaryId + same agent, but a DIFFERENT tenant — must not leak.
    const crossTenant: ContextStoreScope = { ...SCOPE_MATCH, tenantId: "tenant-OTHER" };
    expect(reader.getProvenanceForSummary(crossTenant, S)).toEqual([]);
  });

  it("returns ZERO rows for a DIFFERENT agent (cross-agent fail-closed)", () => {
    const writes = buildProvenanceWrites(db);
    seedMemoryRow(M);
    writes.appendProvenance({
      provenanceId: "prov-1",
      memoryId: M,
      summaryId: S,
      sourceSessionKey: "sess-p",
      conversationId: "conv-p",
      agentId: A,
      tenantId: T,
      createdAt: 123,
    });

    // Same summaryId + same tenant, but a DIFFERENT agent — must not leak.
    const crossAgent: ContextStoreScope = { ...SCOPE_MATCH, agentId: "agent-OTHER" };
    expect(reader.getProvenanceForSummary(crossAgent, S)).toEqual([]);
  });

  it("returns ZERO rows for a non-existent summaryId", () => {
    expect(reader.getProvenanceForSummary(SCOPE_MATCH, "sum-does-not-exist")).toEqual([]);
  });

  it("surfaces superseded_by when set, and returns every linked row for the summary", () => {
    const writes = buildProvenanceWrites(db);
    seedMemoryRow(M);
    seedMemoryRow("mem-2");
    seedMemoryRow("mem-subsumer");
    writes.appendProvenance({
      provenanceId: "prov-1",
      memoryId: M,
      summaryId: S,
      sourceSessionKey: "sess-p",
      conversationId: "conv-p",
      agentId: A,
      tenantId: T,
      createdAt: 1,
    });
    writes.appendProvenance({
      provenanceId: "prov-2",
      memoryId: "mem-2",
      summaryId: S,
      sourceSessionKey: "sess-p",
      conversationId: "conv-p",
      agentId: A,
      tenantId: T,
      createdAt: 2,
    });
    // Pyramid rule: mark the summary's rows superseded by a newer distilled memory.
    writes.markProvenanceSuperseded(S, "mem-subsumer", T, A);

    const rows = reader.getProvenanceForSummary(SCOPE_MATCH, S);
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.memoryId, r]));
    expect(byId.get(M)?.supersededBy).toBe("mem-subsumer");
    expect(byId.get("mem-2")?.supersededBy).toBe("mem-subsumer");
  });
});
