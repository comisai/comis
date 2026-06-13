// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LCD FTS5 helper (lcd-fts.ts) — the FTS5-availability probe, the
 * MATCH query builder, and the LIKE-scan fallback that keeps searchLcd from ever
 * hard-failing on a host whose better-sqlite3 lacks compiled FTS5.
 *
 * Drives E1 ("recover any compressed region; FTS with fallback"): when the FTS
 * virtual tables are absent (uncompiled FTS5, or a just-created base-tables-only
 * db), searchLcdImpl degrades to a LIKE scan over lcd_summaries.content / a
 * rendered message-parts projection and returns hits with `rank === undefined`.
 *
 * Also covers the schema-lcd.ts boot-safety guard: ensureLcdTables must NOT
 * throw when `CREATE VIRTUAL TABLE … USING fts5` fails (initSchema must boot on
 * an FTS5-less host — the base tables are still created).
 */
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { normalizeForSearch, dominantScript } from "@comis/core";
import { ensureLcdTables } from "./schema-lcd.js";
import { renderMessageFtsText, searchLcdImpl } from "./lcd-fts.js";

/**
 * Create a db with ONLY the base LCD tables (no FTS virtual tables). This is the
 * "FTS5 unavailable" shape from searchLcdImpl's perspective: the probe MATCH hits
 * `no such table: lcd_summaries_fts` → it routes to the LIKE scan.
 */
function baseTablesOnlyDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE lcd_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, session_key TEXT NOT NULL, seq INTEGER NOT NULL,
      role TEXT NOT NULL, token_count INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE lcd_message_parts (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT, tool_input TEXT,
      tool_output TEXT, is_error INTEGER, metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE lcd_summaries (
      summary_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, session_key TEXT NOT NULL, kind TEXT NOT NULL, depth INTEGER NOT NULL,
      earliest_at INTEGER NOT NULL, latest_at INTEGER NOT NULL, descendant_count INTEGER NOT NULL,
      token_count INTEGER NOT NULL, content TEXT NOT NULL, file_ids TEXT NOT NULL DEFAULT '[]',
      taint INTEGER NOT NULL DEFAULT 0, fallback INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe("lcd-fts — LIKE fallback when FTS5 is unavailable", () => {
  it("searchLcdImpl falls back to a LIKE scan and returns rank undefined when the FTS tables are absent", () => {
    const db = baseTablesOnlyDb();
    db.prepare(`
      INSERT INTO lcd_summaries
        (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
         earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
      VALUES ('s1','conv-a','t','a','s','leaf',0,1,1,1,1,'the quarterly revenue report','[]',0,0,1)
    `).run();

    // No FTS table exists → the probe reports unavailable → LIKE scan, never throws.
    let result: ReturnType<typeof searchLcdImpl> = { hits: [], cjkZeroHit: false, lane: "word", matchErrored: false };
    expect(() => {
      result = searchLcdImpl(db, "conv-a", "a", "revenue", { limit: 10, scope: "summaries" });
    }).not.toThrow();
    const { hits } = result;

    const hit = hits.find((h) => h.refId === "s1");
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("summary");
    // LIKE scan has no ranking — rank MUST be undefined (the contract's fallback marker).
    expect(hit!.rank).toBeUndefined();
    expect(hit!.snippet).toContain("revenue");
  });

  it("searchLcdImpl LIKE fallback finds a message by rendered part text and is scoped by conversation", () => {
    const db = baseTablesOnlyDb();
    // Two conversations, same keyword — only conv-a must come back.
    db.prepare(`INSERT INTO lcd_messages VALUES ('m1','conv-a','t','a','s',0,'user',1,1)`).run();
    db.prepare(`INSERT INTO lcd_message_parts VALUES ('p1','m1',0,'text',NULL,NULL,NULL,NULL,NULL,?)`).run(
      JSON.stringify({ raw: { type: "text", text: "ship the falcon release" }, rawType: "text" }),
    );
    db.prepare(`INSERT INTO lcd_messages VALUES ('m2','conv-b','t','a','s',0,'user',1,1)`).run();
    db.prepare(`INSERT INTO lcd_message_parts VALUES ('p2','m2',0,'text',NULL,NULL,NULL,NULL,NULL,?)`).run(
      JSON.stringify({ raw: { type: "text", text: "ship the falcon release" }, rawType: "text" }),
    );

    const { hits } = searchLcdImpl(db, "conv-a", "a", "falcon", { limit: 10, scope: "messages" });
    expect(hits.map((h) => h.refId)).toContain("m1");
    expect(hits.some((h) => h.refId === "m2")).toBe(false); // conv-b excluded
    expect(hits.every((h) => h.rank === undefined)).toBe(true);
  });

  it("searchLcdImpl caps LIKE fallback results at opts.limit", () => {
    const db = baseTablesOnlyDb();
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO lcd_summaries
          (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
           earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
        VALUES (?,'conv-a','t','a','s','leaf',0,1,1,1,1,?, '[]',0,0,?)
      `).run(`s${i}`, `keyword match number ${i}`, i);
    }
    const { hits } = searchLcdImpl(db, "conv-a", "a", "keyword", { limit: 2, scope: "summaries" });
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});

describe("lcd-fts — renderMessageFtsText projection", () => {
  it("renderMessageFtsText concatenates text-part text plus tool input/output into one searchable string", () => {
    const text = renderMessageFtsText([
      { kind: "text", metadata: { raw: { type: "text", text: "hello world" }, rawType: "text" } },
      {
        kind: "tool_use",
        toolName: "read",
        toolInput: { path: "/etc/hosts" },
        metadata: { raw: undefined },
      },
      {
        kind: "tool_result",
        toolOutput: [{ type: "text", text: "127.0.0.1 localhost" }],
        metadata: { raw: undefined },
      },
    ]);
    expect(text).toContain("hello world");
    expect(text).toContain("/etc/hosts");
    expect(text).toContain("localhost");
  });
});

/**
 * Create a db that REPORTS FTS5 as available (a real, queryable
 * `lcd_summaries_fts` virtual table so `isFtsAvailable`'s probe MATCH succeeds),
 * then intercept `prepare` so the two scope MATCH queries return CALLER-SUPPLIED
 * rows. This drives `searchViaFts` / `mapFtsRows` directly with controlled FTS
 * result shapes (corrupt rows, cross-table BM25 ranks) that real BM25 scoring
 * cannot be made to emit deterministically. Non-MATCH prepares pass through.
 */
function ftsDbReturning(rowsByScope: {
  summary?: unknown[];
  message?: unknown[];
}): Database.Database {
  const real = new Database(":memory:");
  real.pragma("foreign_keys = ON");
  // A minimal real FTS table so the availability probe MATCH compiles+runs.
  real.exec(`CREATE VIRTUAL TABLE lcd_summaries_fts USING fts5(content, conversation_id UNINDEXED, summary_id UNINDEXED)`);

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string): unknown => {
          const isMatch = /MATCH/i.test(sql);
          const isSummaryQuery = /FROM\s+lcd_summaries_fts/i.test(sql);
          const isMessageQuery = /FROM\s+lcd_messages_fts/i.test(sql);
          // Only stub the scope MATCH SELECTs; the probe (also a summaries MATCH)
          // is distinguished by its `SELECT rowid` shape — let it pass through.
          if (isMatch && /SELECT\s+rowid/i.test(sql)) {
            return target.prepare(sql);
          }
          if (isMatch && isSummaryQuery) {
            return { all: () => rowsByScope.summary ?? [] };
          }
          if (isMatch && isMessageQuery) {
            return { all: () => rowsByScope.message ?? [] };
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Database.Database;
}

describe("lcd-fts — FTS path degrades a corrupt hit PER ROW, not all-or-nothing (WR-01)", () => {
  it("searchLcdImpl returns the valid FTS hits and skips only the corrupt row instead of nulling every hit", () => {
    // One valid summary hit + one schema-violating row (snippet NULL — the
    // strict LcdSearchHitRowSchema requires a string). The all-or-nothing
    // `parseRows` errs on the bad row and discards the VALID sibling too,
    // returning []. The per-row `parseOptionalRow`+skip keeps the valid hit.
    const db = ftsDbReturning({
      summary: [
        { ref_id: "s-good", snippet: "the quarterly revenue report", rank: -1.5 },
        { ref_id: "s-bad", snippet: null, rank: -0.5 }, // corrupt: snippet must be a string
      ],
    });

    const { hits } = searchLcdImpl(db, "conv-a", "a", "revenue", { limit: 10, scope: "summaries" });

    // The good row survives the bad sibling (WR-01: one bad row must not poison
    // the whole result set).
    expect(hits.map((h) => h.refId)).toContain("s-good");
    expect(hits.some((h) => h.refId === "s-bad")).toBe(false);
  });
});

/**
 * A base-tables-only db (FTS5 reported UNAVAILABLE, so `searchLcdImpl` routes to
 * the LIKE-scan fallback) whose LIKE SELECTs return CALLER-SUPPLIED rows. The
 * availability probe (`SELECT rowid FROM lcd_summaries_fts … MATCH …`) throws on
 * the missing FTS table and is left to pass through; the two LIKE SELECTs (a
 * `FROM lcd_summaries` scan and a `FROM lcd_messages … JOIN lcd_message_parts`
 * scan, neither a MATCH) are intercepted so we can inject a corrupt row that the
 * typed write path could never produce (on-disk drift / a NULL projected column).
 */
function likeDbReturning(rowsByScope: {
  summary?: unknown[];
  message?: unknown[];
}): Database.Database {
  const real = baseTablesOnlyDb(); // no FTS vtables → isFtsAvailable() === false

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string): unknown => {
          const isMatch = /MATCH/i.test(sql);
          // The FTS availability probe is a MATCH — let it pass through so it
          // throws on the absent vtable and routes searchLcdImpl to the LIKE path.
          if (isMatch) return target.prepare(sql);
          // The summaries LIKE scan: FROM lcd_summaries (+ LIKE), no JOIN.
          if (/FROM\s+lcd_summaries\b/i.test(sql) && /LIKE/i.test(sql)) {
            return { all: () => rowsByScope.summary ?? [] };
          }
          // The messages LIKE scan: FROM lcd_messages m JOIN lcd_message_parts.
          if (/FROM\s+lcd_messages\b/i.test(sql) && /JOIN\s+lcd_message_parts/i.test(sql)) {
            return { all: () => rowsByScope.message ?? [] };
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Database.Database;
}

describe("lcd-fts — LIKE fallback degrades a corrupt hit PER ROW, not all-or-nothing (WR-02)", () => {
  it("searchLcdImpl LIKE summaries fallback keeps the valid hit and skips only the corrupt row (no undefined snippet leaks)", () => {
    // One valid summary hit + one schema-violating row (snippet NULL — a drifted/
    // corrupt column the typed write path cannot produce). The pre-patch LIKE
    // fallback cast `raw as { ref_id, snippet }` with NO validation, so the bad
    // row's `undefined` snippet flowed straight into the LcdSearchHit (and onward
    // into wrapExternalContent at the tool boundary). The fix routes the LIKE rows
    // through the same per-row `parseOptionalRow`+skip the MATCH path uses.
    const db = likeDbReturning({
      summary: [
        { ref_id: "s-good", snippet: "the quarterly revenue report" },
        { ref_id: "s-bad", snippet: null }, // corrupt: snippet must be a string
      ],
    });

    const { hits: summaryHits } = searchLcdImpl(db, "conv-a", "a", "revenue", { limit: 10, scope: "summaries" });

    // The valid hit survives its corrupt sibling.
    expect(summaryHits.map((h) => h.refId)).toContain("s-good");
    // The corrupt row is SKIPPED, not surfaced with an undefined snippet.
    expect(summaryHits.some((h) => h.refId === "s-bad")).toBe(false);
    // No hit ever carries a non-string snippet (the bug this guards).
    expect(summaryHits.every((h) => typeof h.snippet === "string")).toBe(true);
  });

  it("searchLcdImpl LIKE messages fallback skips a corrupt row (undefined ref_id) instead of emitting it", () => {
    // A corrupt message row whose projected ref_id is missing — the pre-patch
    // cast would `seen.add(undefined)` and push a hit with `refId: undefined`.
    const db = likeDbReturning({
      message: [
        { ref_id: "m-good", snippet: "ship the falcon release" },
        { ref_id: null, snippet: "drifted row with no id" }, // corrupt: ref_id must be a string
      ],
    });

    const { hits: msgHits } = searchLcdImpl(db, "conv-a", "a", "falcon", { limit: 10, scope: "messages" });

    expect(msgHits.map((h) => h.refId)).toContain("m-good");
    // Every emitted hit has a real string id + snippet — the corrupt row is gone.
    expect(msgHits.every((h) => typeof h.refId === "string" && typeof h.snippet === "string")).toBe(true);
  });
});

describe("lcd-fts — scope=both merges fairly across the two FTS tables (WR-03)", () => {
  it("searchLcdImpl both keeps representation from each table instead of dropping a whole table by raw BM25", () => {
    // BM25 ranks are corpus-relative — NOT comparable across two FTS indexes.
    // Here the (single) summary's rank (-0.5) is numerically LARGER than both
    // message ranks (-5, -4). The buggy cross-table raw sort+truncate orders
    // ascending and slices to limit=2 → both messages win, the summary is
    // dropped entirely. A correct merge gives each table fair representation.
    const db = ftsDbReturning({
      summary: [{ ref_id: "s-top", snippet: "the only matching summary", rank: -0.5 }],
      message: [
        { ref_id: "m1", snippet: "message one", rank: -5 },
        { ref_id: "m2", snippet: "message two", rank: -4 },
      ],
    });

    const { hits } = searchLcdImpl(db, "conv-a", "a", "match", { limit: 2, scope: "both" });

    expect(hits.length).toBe(2);
    // The summary table must NOT be wholly evicted by the message table's
    // (incomparable) BM25 scale.
    expect(hits.some((h) => h.kind === "summary" && h.refId === "s-top")).toBe(true);
    expect(hits.some((h) => h.kind === "message")).toBe(true);
  });

  it("searchLcdImpl both interleaves the two tables fairly instead of front-loading one table by incomparable BM25", () => {
    // Every summary rank here is MORE negative than every message rank, purely
    // because the two FTS indexes score on different scales — not because the
    // summaries are genuinely more relevant. The buggy raw-BM25 cross-sort sorts
    // the merged list ascending and yields [s1, s2, s3, m1, m2, m3]: ALL three
    // summaries front-loaded, every message demoted below them (and starved
    // entirely under a tight limit). A fair within-table round-robin (each
    // table's best, then each table's second, …) yields [s1, m1, s2, m2, s3, m3]
    // — the top message m1 rightly sits ahead of the SECOND summary s2.
    const db = ftsDbReturning({
      summary: [
        { ref_id: "s1", snippet: "summary one", rank: -9 },
        { ref_id: "s2", snippet: "summary two", rank: -8 },
        { ref_id: "s3", snippet: "summary three", rank: -7 },
      ],
      message: [
        { ref_id: "m1", snippet: "message one", rank: -6 },
        { ref_id: "m2", snippet: "message two", rank: -5 },
        { ref_id: "m3", snippet: "message three", rank: -4 },
      ],
    });

    const { hits } = searchLcdImpl(db, "conv-a", "a", "one", { limit: 6, scope: "both" });

    expect(hits.length).toBe(6);
    const order = hits.map((h) => h.refId);
    // Each table's own (already-ranked) order is preserved within the merge.
    expect(order.indexOf("m1")).toBeLessThan(order.indexOf("m2"));
    expect(order.indexOf("m2")).toBeLessThan(order.indexOf("m3"));
    expect(order.indexOf("s1")).toBeLessThan(order.indexOf("s2"));
    // The discriminator: a fair merge puts the TOP message ahead of the SECOND
    // summary. The buggy cross-table sort front-loads all summaries, so m1 lands
    // behind s2/s3 — RED on the raw sort, GREEN on the round-robin merge.
    expect(order.indexOf("m1")).toBeLessThan(order.indexOf("s2"));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// lcd-fts — R4 cross-agent search isolation (the Phase-131 WR-02 close)
// ───────────────────────────────────────────────────────────────────────────
// Two agents (agent-a, agent-b) share ONE conversation_id (formatSessionKey omits
// agentId). searchLcd must filter the FTS MATCH path AND the LIKE fallback by
// agent_id so agent A never recovers agent B's hits within the shared
// conversation (Pitfall 3 — BOTH paths must filter, not just the base-table
// reads). These tests pass the NEW agent-scoped signature
// (`searchLcdImpl(db, conversationId, agentId, query, opts)`) and MUST fail on the
// pre-patch tree (the signature does not compile, and neither path filters
// agent_id). The FTS path uses a real FTS5 db; the LIKE path uses a base-tables-
// only db (the documented FTS-absent fallback shape).
describe("lcd-fts — R4 cross-agent search isolation (WR-02)", () => {
  /**
   * A full LCD schema db (FTS5 present) seeded with one summary per agent under
   * the SAME conversation, both matching the SAME term. The summaries-FTS path
   * (lcd_summaries_fts, external-content + triggers) indexes both; only the
   * agent-scoped read must return the caller's own row.
   */
  function ftsDbWithTwoAgentSummaries(term: string): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    ensureLcdTables(db);
    const insert = db.prepare(`
      INSERT INTO lcd_summaries
        (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
         earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
      VALUES (?, 'conv-shared', 'tenant_shared', ?, 'sess-shared', 'leaf', 0, 1, 1, 1, 1, ?, '[]', 0, 0, ?)
    `);
    insert.run("sum-a", "agent-a", `agent-a note about ${term}`, 1);
    insert.run("sum-b", "agent-b", `agent-b note about ${term}`, 2);
    return db;
  }

  it("searchLcd via FTS scoped to agent A does not return agent B's hits within a shared conversation", () => {
    const db = ftsDbWithTwoAgentSummaries("revenue");

    // Agent A's scoped FTS search returns ONLY agent A's summary.
    const { hits: aHits } = searchLcdImpl(db, "conv-shared", "agent-a", "revenue", { limit: 10, scope: "summaries" });
    expect(aHits.map((h) => h.refId)).toContain("sum-a");
    expect(aHits.some((h) => h.refId === "sum-b")).toBe(false);

    // Agent B's scoped search returns ONLY agent B's summary (symmetry).
    const { hits: bHits } = searchLcdImpl(db, "conv-shared", "agent-b", "revenue", { limit: 10, scope: "summaries" });
    expect(bHits.map((h) => h.refId)).toContain("sum-b");
    expect(bHits.some((h) => h.refId === "sum-a")).toBe(false);
  });

  it("searchLcd via the LIKE fallback scoped to agent A does not return agent B's hits within a shared conversation", () => {
    // Base-tables-only db forces the LIKE fallback (no FTS vtables). Pitfall 3:
    // the fallback MUST filter agent_id too, not just the FTS path.
    const db = baseTablesOnlyDb();
    const insert = db.prepare(`
      INSERT INTO lcd_summaries
        (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
         earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
      VALUES (?, 'conv-shared', 'tenant_shared', ?, 'sess-shared', 'leaf', 0, 1, 1, 1, 1, ?, '[]', 0, 0, ?)
    `);
    insert.run("sum-a", "agent-a", "agent-a margin figures", 1);
    insert.run("sum-b", "agent-b", "agent-b margin figures", 2);

    // The LIKE fallback (FTS absent) must still scope by agent_id.
    const { hits: aHits } = searchLcdImpl(db, "conv-shared", "agent-a", "margin", { limit: 10, scope: "summaries" });
    expect(aHits.map((h) => h.refId)).toContain("sum-a");
    expect(aHits.some((h) => h.refId === "sum-b")).toBe(false);
    // Fallback hits carry no rank (the contract marker).
    expect(aHits.every((h) => h.rank === undefined)).toBe(true);
  });

  it("searchLcd via the LIKE fallback scopes message hits by agent_id within a shared conversation", () => {
    // The messages LIKE branch joins lcd_message_parts; it must add AND m.agent_id = ?.
    const db = baseTablesOnlyDb();
    db.prepare(`INSERT INTO lcd_messages VALUES ('m-a','conv-shared','tenant_shared','agent-a','sess-shared',0,'user',1,1)`).run();
    db.prepare(`INSERT INTO lcd_message_parts VALUES ('p-a','m-a',0,'text',NULL,NULL,NULL,NULL,NULL,?)`).run(
      JSON.stringify({ raw: { type: "text", text: "deploy the falcon build" }, rawType: "text" }),
    );
    db.prepare(`INSERT INTO lcd_messages VALUES ('m-b','conv-shared','tenant_shared','agent-b','sess-shared',1,'user',1,1)`).run();
    db.prepare(`INSERT INTO lcd_message_parts VALUES ('p-b','m-b',0,'text',NULL,NULL,NULL,NULL,NULL,?)`).run(
      JSON.stringify({ raw: { type: "text", text: "deploy the falcon build" }, rawType: "text" }),
    );

    const { hits: aHits } = searchLcdImpl(db, "conv-shared", "agent-a", "falcon", { limit: 10, scope: "messages" });
    expect(aHits.map((h) => h.refId)).toContain("m-a");
    expect(aHits.some((h) => h.refId === "m-b")).toBe(false); // agent B's message excluded
  });
});

// ───────────────────────────────────────────────────────────────────────────
// EFF-03 → OBS-01: the zero-hit signal, generalized from CJK to every script
// ───────────────────────────────────────────────────────────────────────────
// searchLcdImpl returns the LcdSearchResult wrapper with cjkZeroHit DERIVED from
// the new scriptZeroHit (= scriptZeroHit === "cjk"). The standalone
// hasCjkCodepoints export is DELETED (Plan 180-05): its corpus now gates the
// dominantScript-based detection — re-asserted in the "dominantScript preserves
// the hasCjkCodepoints corpus verdicts" block below. The cjkZeroHit cases below
// keep proving the derived boolean still fires for PURE-CJK queries; the mixed
// Latin-dominant case moved BY DESIGN (any-codepoint → dominant-script).

describe("EFF-03-T-1 — CJK query with zero FTS hits returns cjkZeroHit=true", () => {
  it("searchLcdImpl returns cjkZeroHit=true when query has CJK codepoints and hits is empty", () => {
    // Seed with English-only messages — no CJK content.
    const db = baseTablesOnlyDb();
    db.prepare(`
      INSERT INTO lcd_summaries
        (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
         earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
      VALUES ('s1','conv-a','t','a','s','leaf',0,1,1,1,1,'the quarterly revenue report','[]',0,0,1)
    `).run();
    db.prepare(`
      INSERT INTO lcd_summaries
        (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
         earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
      VALUES ('s2','conv-a','t','a','s','leaf',0,1,1,1,1,'another english summary','[]',0,0,2)
    `).run();

    const result = searchLcdImpl(db, "conv-a", "a", "你好", { limit: 10, scope: "summaries" });
    // Must return a wrapper, not a bare array.
    expect(result.hits).toBeDefined();
    expect(Array.isArray(result.hits)).toBe(true);
    expect(result.hits).toHaveLength(0);
    // CJK codepoints present + zero hits → cjkZeroHit must be true.
    expect(result.cjkZeroHit).toBe(true);
  });
});

describe("EFF-03-T-2 — CJK query WITH matching hits returns cjkZeroHit=false", () => {
  it("searchLcdImpl returns cjkZeroHit=false when hits is non-empty even with CJK query", () => {
    // Seed with CJK content so the LIKE fallback can match.
    const db = baseTablesOnlyDb();
    db.prepare(`
      INSERT INTO lcd_summaries
        (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
         earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
      VALUES ('s1','conv-a','t','a','s','leaf',0,1,1,1,1,'你好 greetings','[]',0,0,1)
    `).run();

    const result = searchLcdImpl(db, "conv-a", "a", "你好", { limit: 10, scope: "summaries" });
    // CJK content matched → hits non-empty → cjkZeroHit must be false.
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.cjkZeroHit).toBe(false);
  });
});

describe("EFF-03-T-3 — Non-CJK query returns cjkZeroHit=false regardless of hit count", () => {
  it("searchLcdImpl returns cjkZeroHit=false for a Latin-only query with zero hits", () => {
    // Empty db — no matches expected, but query is Latin-only.
    const db = baseTablesOnlyDb();

    const result = searchLcdImpl(db, "conv-a", "a", "hello", { limit: 10, scope: "summaries" });
    expect(result.hits).toHaveLength(0);
    // No CJK in query → cjkZeroHit must be false even with zero hits.
    expect(result.cjkZeroHit).toBe(false);
  });

  it("searchLcdImpl returns cjkZeroHit=false for a Latin query that has hits", () => {
    const db = baseTablesOnlyDb();
    db.prepare(`
      INSERT INTO lcd_summaries
        (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
         earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
      VALUES ('s1','conv-a','t','a','s','leaf',0,1,1,1,1,'hello world','[]',0,0,1)
    `).run();

    const result = searchLcdImpl(db, "conv-a", "a", "hello", { limit: 10, scope: "summaries" });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.cjkZeroHit).toBe(false);
  });
});

describe("EFF-03-T-4 — mixed-script zero-hit signals by DOMINANT script (the by-design change)", () => {
  it("a LATIN-dominant mixed query does NOT fire cjkZeroHit (was any-codepoint, now dominant-script)", () => {
    // BY DESIGN (Plan 180-05): detection moved from "any CJK codepoint" to
    // dominantScript. "hello 你好" is 5 Latin / 2 CJK = CJK share 0.286 < the 0.30
    // threshold → dominant latin → NOT a CJK lane gap. The old any-codepoint test
    // asserted true here; the new semantics route/signal by the dominant script.
    const db = baseTablesOnlyDb();
    const result = searchLcdImpl(db, "conv-a", "a", "hello 你好", { limit: 10, scope: "summaries" });
    expect(result.hits).toHaveLength(0);
    expect(result.cjkZeroHit).toBe(false);
    expect(result.scriptZeroHit).toBeUndefined(); // latin-dominant → no signal
  });

  it("a CJK-dominant mixed query DOES fire cjkZeroHit (the dominant script is cjk)", () => {
    // 你好世界 (4 CJK) + " hi" (2 Latin) → CJK share 0.67 ≥ 0.30 → dominant cjk.
    const db = lcdDbWithTwins();
    const result = searchLcdImpl(db, "conv-a", "a", `${String.fromCodePoint(0x4f60, 0x597d, 0x4e16, 0x754c)} hi`, {
      limit: 10,
      scope: "messages",
    });
    expect(result.hits).toHaveLength(0);
    expect(result.scriptZeroHit).toBe("cjk");
    expect(result.cjkZeroHit).toBe(true);
  });
});

describe("schema-lcd — boot-safety when FTS5 is uncompiled", () => {
  it("ensureLcdTables does not throw when the FTS5 CREATE VIRTUAL TABLE fails; base tables still created", () => {
    const real = new Database(":memory:");
    real.pragma("foreign_keys = ON");

    // A thin proxy whose `.exec` throws `no such module: fts5` for any DDL that
    // uses FTS5, simulating an FTS5-less better-sqlite3. Every other call (the
    // base-table DDL, the trigger DDL is also FTS-only) passes through.
    const proxy = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "exec") {
          return (sql: string): Database.Database => {
            if (/USING\s+fts5/i.test(sql)) {
              throw new Error("no such module: fts5");
            }
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as Database.Database;

    // Boot must NOT throw even though the FTS DDL fails.
    expect(() => ensureLcdTables(proxy)).not.toThrow();

    // The base tables were still created (the FTS guard is scoped, not global).
    const tables = real
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("lcd_messages");
    expect(tables).toContain("lcd_summaries");
    expect(tables).toContain("lcd_summary_parents");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FTS-01 / OBS-01 (Plan 180-05): LCD script routing — twin MATCH lane, the
// bounded normalized-scan floor, isTriAvailable probe, safeAll signal-purity
// reshape, and the LcdSearchResult widening (scriptZeroHit/lane/matchErrored/
// scanCapped).
//
// These pins MUST fail on the pre-patch tree: searchLcdImpl currently has a
// PLACEHOLDER body (always lane "word", never routes non-Latin to the trigram
// twins, no scan floor, no script-aware scriptZeroHit). The word-lane + R4 +
// WR + cjkZeroHit-corpus suites above stay GREEN (the placeholder keeps the
// Latin path byte-identical).
//
// All non-Latin strings are assembled from String.fromCodePoint (the WR-01
// boundary-codepoint discipline) so they survive shell/editor round-trips
// intact — a live probe showed inline Arabic/Hebrew glyphs get mangled, which
// would silently desync a stored row from its query (180-01 SUMMARY issue).
// ═══════════════════════════════════════════════════════════════════════════

// ── Hebrew ──────────────────────────────────────────────────────────────────
const HE_HASEFARIM = String.fromCodePoint(0x5d4, 0x5e1, 0x5e4, 0x5e8, 0x5d9, 0x5dd); // הספרים ("the books")
const HE_SEFER = String.fromCodePoint(0x5e1, 0x5e4, 0x5e8); // ספר ("book")
const HE_SEFARIM = String.fromCodePoint(0x5e1, 0x5e4, 0x5e8, 0x5d9, 0x5dd); // ספרים ("books")
const HE_MELACHIM = String.fromCodePoint(0x5de, 0x5dc, 0x5db, 0x5d9, 0x5dd); // מלכים ("kings")
const HE_MELECH = String.fromCodePoint(0x5de, 0x5dc, 0x5da); // מלך ("king", final kaf)
const HE_GAM = String.fromCodePoint(0x5d2, 0x5dd); // גם ("also") — 2 codepoints → below the trigram floor
// ── Cyrillic (suffixing — Option B OR-of-trigrams) ───────────────────────────
const RU_KNIGI = String.fromCodePoint(0x43a, 0x43d, 0x438, 0x433, 0x438); // книги ("books")
const RU_KNIGA = String.fromCodePoint(0x43a, 0x43d, 0x438, 0x433, 0x430); // книга ("book")
// ── CJK ──────────────────────────────────────────────────────────────────────
const CJK_PHRASE = String.fromCodePoint(0x6211, 0x559c, 0x6b22, 0x8bfb, 0x4e2d, 0x6587, 0x4e66, 0x7c4d); // 我喜欢读中文书籍
const CJK_QUERY = String.fromCodePoint(0x4e2d, 0x6587, 0x4e66); // 中文书 ("Chinese book")
// ── Arabic ─────────────────────────────────────────────────────────────────
const AR_WALKITAB = String.fromCodePoint(0x648, 0x627, 0x644, 0x643, 0x62a, 0x627, 0x628); // والكتاب ("and the book")
const AR_KITAB = String.fromCodePoint(0x643, 0x62a, 0x627, 0x628); // كتاب ("book")

/**
 * A full LCD-schema db (base tables + word-lane FTS + the trigram twins, via
 * ensureLcdTables which calls ensureTrigramTwins as its last statement). This is
 * the routing-matrix harness: the twins exist and isTriAvailable verdicts true,
 * so a non-Latin query routes to the trigram lane. Twin rows are inserted with
 * NORMALIZED content via raw SQL (this plan does NOT depend on 180-04's populate;
 * the twins store normalizeForSearch(content) per FTS-02).
 */
function lcdDbWithTwins(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureLcdTables(db);
  return db;
}

/** Insert a NORMALIZED message-twin row (the FTS-02 stored shape). `content` is
 *  pre-normalized by the caller to mirror the real TS-side write path. */
function seedMessageTwin(
  db: Database.Database,
  args: { content: string; conversationId?: string; agentId?: string; messageId: string },
): void {
  db.prepare(
    "INSERT INTO lcd_messages_fts_tri(content, conversation_id, agent_id, message_id) VALUES (?,?,?,?)",
  ).run(args.content, args.conversationId ?? "conv-a", args.agentId ?? "agent-a", args.messageId);
}

/** Insert a NORMALIZED summary-twin row (the FTS-02 stored shape). */
function seedSummaryTwin(
  db: Database.Database,
  args: { content: string; conversationId?: string; agentId?: string; summaryId: string },
): void {
  db.prepare(
    "INSERT INTO lcd_summaries_fts_tri(content, conversation_id, agent_id, summary_id) VALUES (?,?,?,?)",
  ).run(args.content, args.conversationId ?? "conv-a", args.agentId ?? "agent-a", args.summaryId);
}

/** Insert a base lcd_messages row + a text part whose RAW text feeds the scan
 *  floor's haystack (the scan floor reads the SAME columns the LIKE floor LIKEs:
 *  lcd_summaries.content and the message parts' tool_input/tool_output/metadata).
 *  For the scan floor over messages we put the searchable text in metadata.raw.text. */
function seedBaseMessage(
  db: Database.Database,
  args: { id: string; seq: number; text: string; conversationId?: string; agentId?: string },
): void {
  db.prepare(
    "INSERT INTO lcd_messages(id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(args.id, args.conversationId ?? "conv-a", "t", args.agentId ?? "agent-a", "s", args.seq, "user", 1, args.seq);
  db.prepare(
    "INSERT INTO lcd_message_parts(id, message_id, ordinal, kind, tool_call_id, tool_name, tool_input, tool_output, is_error, metadata) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(`${args.id}-p0`, args.id, 0, "text", null, null, null, null, null,
    JSON.stringify({ raw: { type: "text", text: args.text }, rawType: "text" }));
}

/** Insert a base lcd_summaries row (the scan floor over summaries reads .content). */
function seedBaseSummary(
  db: Database.Database,
  args: { id: string; content: string; createdAt: number; conversationId?: string; agentId?: string },
): void {
  db.prepare(`
    INSERT INTO lcd_summaries
      (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
       earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
    VALUES (?, ?, 't', ?, 's', 'leaf', 0, 1, 1, 1, 1, ?, '[]', 0, 0, ?)
  `).run(args.id, args.conversationId ?? "conv-a", args.agentId ?? "agent-a", args.content, args.createdAt);
}

describe("lcd-fts (180-05) — word lane stays byte-identical for all-Latin (I1)", () => {
  it("routes an all-Latin query to the word lane and feeds searchViaFts the ORIGINAL query string", () => {
    const db = lcdDbWithTwins();
    // Seed the WORD-lane FTS (not the twins) so a real word-FTS hit comes back.
    db.prepare(`INSERT INTO lcd_messages VALUES ('m1','conv-a','t','agent-a','s',0,'user',1,1)`).run();
    db.prepare(`INSERT INTO lcd_message_parts VALUES ('p1','m1',0,'text',NULL,NULL,NULL,NULL,NULL,?)`).run(
      JSON.stringify({ raw: { type: "text", text: "docker compose orchestration" }, rawType: "text" }),
    );
    // Drive the word-FTS populate the store normally does (renderMessageFtsText → lcd_messages_fts).
    db.prepare(
      "INSERT INTO lcd_messages_fts(content, conversation_id, agent_id, message_id) VALUES (?,?,?,?)",
    ).run("docker compose orchestration", "conv-a", "agent-a", "m1");

    const result = searchLcdImpl(db, "conv-a", "agent-a", "docker compose", { limit: 10, scope: "messages" });
    expect(result.lane).toBe("word");
    expect(result.matchErrored).toBe(false);
    expect(result.hits.map((h) => h.refId)).toContain("m1");
  });

  it("a word-lane query intercepted at prepare receives the ORIGINAL string (never a normalized copy)", () => {
    // Source-shape pin: intercept the word-FTS MATCH and capture the bound query
    // arg. The word lane must pass `query` (the ORIGINAL parameter) through — NOT
    // a normalizeForSearch copy (I1 byte-identical SQL + bound params).
    const real = new Database(":memory:");
    real.pragma("foreign_keys = ON");
    ensureLcdTables(real);
    let boundQueryArg: unknown = undefined;
    const proxy = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string): unknown => {
            const stmt = target.prepare(sql);
            if (/FROM\s+lcd_messages_fts\b/i.test(sql) && /MATCH/i.test(sql) && !/SELECT\s+rowid/i.test(sql)) {
              return {
                all: (...params: unknown[]) => {
                  boundQueryArg = params[0];
                  return stmt.all(...(params as [])); // delegate so it still runs
                },
              };
            }
            return stmt;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as Database.Database;

    searchLcdImpl(proxy, "conv-a", "agent-a", "Docker COMPOSE", { limit: 5, scope: "messages" });
    // The ORIGINAL mixed-case string reaches the MATCH — not a lowercased/normalized copy.
    expect(boundQueryArg).toBe("Docker COMPOSE");
  });
});

describe("lcd-fts (180-05) — trigram lane: query-time normalization symmetry (I7)", () => {
  it("a Hebrew query finds a normalized stored Hebrew message through the trigram twin", () => {
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(HE_HASEFARIM), messageId: "m1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_SEFER, { limit: 10, scope: "messages" });
    expect(result.lane).toBe("tri");
    expect(result.matchErrored).toBe(false);
    expect(result.hits.map((h) => h.refId)).toContain("m1");
  });

  it("a Hebrew query with final-letter morphology finds the stored inflection (מלך → מלכים)", () => {
    // Query-time normalization regression: fails if ONLY the index side normalizes.
    // Stored מלכים → מלכימ; query מלך → מלכ (final kaf folded) which is a substring.
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(HE_MELACHIM), messageId: "m1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_MELECH, { limit: 10, scope: "messages" });
    expect(result.hits.map((h) => h.refId)).toContain("m1");
  });

  it("a Russian query finds a stored suffixing inflection via Option B OR-of-trigrams (книга → книги)", () => {
    // The OQ-1 Option B end-to-end pin: книга is NOT a substring of книги, so a
    // whole-quoted token misses; the OR-of-trigrams group matches it.
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(RU_KNIGI), messageId: "m1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", RU_KNIGA, { limit: 10, scope: "messages" });
    expect(result.lane).toBe("tri");
    expect(result.hits.map((h) => h.refId)).toContain("m1");
  });

  it("a CJK phrase query finds a stored CJK message substring (中文书 ⊂ 我喜欢读中文书籍)", () => {
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(CJK_PHRASE), messageId: "m1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", CJK_QUERY, { limit: 10, scope: "messages" });
    expect(result.lane).toBe("tri");
    expect(result.hits.map((h) => h.refId)).toContain("m1");
  });

  it("an Arabic query finds a stored Arabic inflection (كتاب ⊂ والكتاب)", () => {
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(AR_WALKITAB), messageId: "m1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", AR_KITAB, { limit: 10, scope: "messages" });
    expect(result.lane).toBe("tri");
    expect(result.hits.map((h) => h.refId)).toContain("m1");
  });

  it("a short token in an implicit-AND Hebrew query is dropped, not allowed to kill the match (ספרים גם → הספרים)", () => {
    // Probe correction #2 at the lane level: גם (2 cp) is below the trigram floor.
    // It must be DROPPED so the surviving ספרים still matches — not ANDed in (which
    // would return zero rows). Stored הספרים → הספרימ; query token ספרים → ספרימ.
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(HE_HASEFARIM), messageId: "m1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", `${HE_SEFARIM} ${HE_GAM}`, { limit: 10, scope: "messages" });
    expect(result.lane).toBe("tri");
    expect(result.hits.map((h) => h.refId)).toContain("m1");
  });

  it("scope 'both' interleaves matching message AND summary twin rows by rank", () => {
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(HE_HASEFARIM), messageId: "m1" });
    seedSummaryTwin(db, { content: normalizeForSearch(HE_HASEFARIM), summaryId: "s1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_SEFER, { limit: 10, scope: "both" });
    expect(result.lane).toBe("tri");
    expect(result.hits.some((h) => h.kind === "message" && h.refId === "m1")).toBe(true);
    expect(result.hits.some((h) => h.kind === "summary" && h.refId === "s1")).toBe(true);
  });
});

describe("lcd-fts (180-05) — opts.scope is honored on the trigram lane (the relevance-eviction contract)", () => {
  it("scope 'messages' returns ONLY the message-twin hit, never the summary twin", () => {
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(HE_HASEFARIM), messageId: "m1" });
    seedSummaryTwin(db, { content: normalizeForSearch(HE_HASEFARIM), summaryId: "s1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_SEFER, { limit: 10, scope: "messages" });
    expect(result.hits.map((h) => h.refId)).toContain("m1");
    expect(result.hits.every((h) => h.kind === "message")).toBe(true);
    expect(result.hits.some((h) => h.refId === "s1")).toBe(false); // summary twin excluded
  });

  it("scope 'summaries' returns ONLY the summary-twin hit, never the message twin", () => {
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(HE_HASEFARIM), messageId: "m1" });
    seedSummaryTwin(db, { content: normalizeForSearch(HE_HASEFARIM), summaryId: "s1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_SEFER, { limit: 10, scope: "summaries" });
    expect(result.hits.map((h) => h.refId)).toContain("s1");
    expect(result.hits.every((h) => h.kind === "summary")).toBe(true);
    expect(result.hits.some((h) => h.refId === "m1")).toBe(false); // message twin excluded
  });

  it("an OR-joined eviction-shape query routes cleanly to the tri lane and returns message hits (scope 'messages')", () => {
    // The exact lcd-arbiter-seam tokenizer output form: bare tokens joined with
    // " OR ". Operators must be preserved (the route stays "tri", not "scan").
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(HE_HASEFARIM), messageId: "m1" });
    const query = `${HE_SEFARIM} OR docker OR ${HE_MELECH}`;
    const result = searchLcdImpl(db, "conv-a", "agent-a", query, { limit: 10, scope: "messages" });
    expect(result.lane).toBe("tri");
    expect(result.matchErrored).toBe(false);
    expect(result.hits.map((h) => h.refId)).toContain("m1");
  });

  it("the SAME OR-joined query against an EMPTY twin set returns a clean empty (hits [], matchErrored false, no throw)", () => {
    // The relevance-eviction recency fallback keys on hits.length === 0 — a clean
    // empty (NOT a throw, NOT matchErrored) must come back so the fallback fires.
    const db = lcdDbWithTwins(); // twins exist but hold no rows
    const query = `${HE_SEFARIM} OR docker OR ${HE_MELECH}`;
    let result: ReturnType<typeof searchLcdImpl> | undefined;
    expect(() => {
      result = searchLcdImpl(db, "conv-a", "agent-a", query, { limit: 10, scope: "messages" });
    }).not.toThrow();
    expect(result!.hits).toHaveLength(0);
    expect(result!.matchErrored).toBe(false);
  });
});

describe("lcd-fts (180-05) — the bounded normalized-scan floor (all-short / trigram-absent)", () => {
  it("an all-short non-Latin query routes to the scan floor and finds rows by normalized substring", () => {
    const db = lcdDbWithTwins();
    // גם (2 cp) is below the trigram floor → route lane "scan". The scan floor reads
    // the message parts' raw text the LIKE floor reads; the haystack normalizes and
    // .includes the normalized scan token.
    seedBaseMessage(db, { id: "m1", seq: 0, text: `${HE_SEFARIM} ${HE_GAM}` });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_GAM, { limit: 10, scope: "messages" });
    expect(result.lane).toBe("scan");
    expect(result.hits.map((h) => h.refId)).toContain("m1");
  });

  it("the scan floor honors scope 'messages' — a matching summary row is never scanned", () => {
    const db = lcdDbWithTwins();
    seedBaseMessage(db, { id: "m1", seq: 0, text: `${HE_SEFARIM} ${HE_GAM}` });
    seedBaseSummary(db, { id: "s1", content: `${HE_SEFARIM} ${HE_GAM}`, createdAt: 1 });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_GAM, { limit: 10, scope: "messages" });
    expect(result.lane).toBe("scan");
    expect(result.hits.map((h) => h.refId)).toContain("m1");
    expect(result.hits.every((h) => h.kind === "message")).toBe(true);
    expect(result.hits.some((h) => h.refId === "s1")).toBe(false);
  });

  it("the scan floor honors scope 'summaries' — a matching message row is never scanned", () => {
    const db = lcdDbWithTwins();
    seedBaseMessage(db, { id: "m1", seq: 0, text: `${HE_SEFARIM} ${HE_GAM}` });
    seedBaseSummary(db, { id: "s1", content: `${HE_SEFARIM} ${HE_GAM}`, createdAt: 1 });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_GAM, { limit: 10, scope: "summaries" });
    expect(result.lane).toBe("scan");
    expect(result.hits.map((h) => h.refId)).toContain("s1");
    expect(result.hits.every((h) => h.kind === "summary")).toBe(true);
    expect(result.hits.some((h) => h.refId === "m1")).toBe(false);
  });

  it("the scan floor is R4-scoped — agent A never scans agent B's row (both directions)", () => {
    const db = lcdDbWithTwins();
    seedBaseSummary(db, { id: "s-a", content: `${HE_SEFARIM} ${HE_GAM}`, createdAt: 1, agentId: "agent-a" });
    seedBaseSummary(db, { id: "s-b", content: `${HE_SEFARIM} ${HE_GAM}`, createdAt: 2, agentId: "agent-b" });
    const a = searchLcdImpl(db, "conv-a", "agent-a", HE_GAM, { limit: 10, scope: "summaries" });
    expect(a.hits.map((h) => h.refId)).toContain("s-a");
    expect(a.hits.some((h) => h.refId === "s-b")).toBe(false);
    const b = searchLcdImpl(db, "conv-a", "agent-b", HE_GAM, { limit: 10, scope: "summaries" });
    expect(b.hits.map((h) => h.refId)).toContain("s-b");
    expect(b.hits.some((h) => h.refId === "s-a")).toBe(false);
  });

  it("the scan floor sets scanCapped=true when it exhausts its row cap before finding enough hits", () => {
    const db = lcdDbWithTwins();
    // The honest DoS scenario: seed MORE than SCAN_ROW_CAP (2000) rows that do NOT
    // contain the query token, so the scan examines the full cap newest-first,
    // finds 0 hits, and stops at the cap with rows still unexamined → scanCapped.
    // (If the rows matched, the early-exit at `limit` would stop BEFORE the cap and
    // scanCapped would correctly stay false — that is the non-capped path.)
    const insert = db.prepare(`
      INSERT INTO lcd_summaries
        (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
         earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
      VALUES (?, 'conv-a', 't', 'agent-a', 's', 'leaf', 0, 1, 1, 1, 1, ?, '[]', 0, 0, ?)
    `);
    const txn = db.transaction(() => {
      for (let i = 0; i < 2100; i++) insert.run(`s${i}`, `english filler row ${i}`, i); // no Hebrew token
    });
    txn();
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_GAM, { limit: 5, scope: "summaries" });
    expect(result.lane).toBe("scan");
    expect(result.hits.length).toBeLessThanOrEqual(5);
    expect(result.scanCapped).toBe(true);
  });

  it("the scan floor leaves scanCapped falsy when the conversation fits within the cap", () => {
    // A small conversation (well under the cap) → the cursor exhausts naturally,
    // never hits the cap → scanCapped must be undefined/false (no false alarm).
    const db = lcdDbWithTwins();
    seedBaseSummary(db, { id: "s1", content: `${HE_SEFARIM} ${HE_GAM}`, createdAt: 1 });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_GAM, { limit: 5, scope: "summaries" });
    expect(result.lane).toBe("scan");
    expect(result.hits.map((h) => h.refId)).toContain("s1");
    expect(result.scanCapped ?? false).toBe(false);
  });

  it("a Hebrew query on a trigram-ABSENT host routes to the scan floor (probe verdicts false)", () => {
    // Simulate a host whose better-sqlite3 lacks the trigram tokenizer: the twins
    // were never created (base + word-FTS only), so isTriAvailable verdicts false on
    // `no such table` → the non-Latin query falls to the scan floor, never throws.
    const db = baseTablesOnlyDb();
    seedBaseMessage(db, { id: "m1", seq: 0, text: HE_SEFARIM });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_SEFER, { limit: 10, scope: "messages" });
    expect(result.lane).toBe("scan");
    expect(result.hits.map((h) => h.refId)).toContain("m1");
  });
});

describe("lcd-fts (180-05) — FTS5-absent host: Latin queries keep the LIKE floor (lane word)", () => {
  it("an all-Latin query on a base-tables-only db uses the LIKE floor and reports lane 'word'", () => {
    const db = baseTablesOnlyDb();
    db.prepare(`
      INSERT INTO lcd_summaries
        (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
         earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
      VALUES ('s1','conv-a','t','agent-a','s','leaf',0,1,1,1,1,'the quarterly revenue report','[]',0,0,1)
    `).run();
    const result = searchLcdImpl(db, "conv-a", "agent-a", "revenue", { limit: 10, scope: "summaries" });
    expect(result.lane).toBe("word");
    expect(result.matchErrored).toBe(false);
    expect(result.hits.map((h) => h.refId)).toContain("s1");
  });
});

describe("lcd-fts (180-05) — R4 cross-agent isolation on the trigram MATCH lane (both directions)", () => {
  it("agent A's twin MATCH returns only agent A's row; agent B's returns only agent B's", () => {
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(HE_HASEFARIM), agentId: "agent-a", messageId: "m-a" });
    seedMessageTwin(db, { content: normalizeForSearch(HE_HASEFARIM), agentId: "agent-b", messageId: "m-b" });

    const a = searchLcdImpl(db, "conv-a", "agent-a", HE_SEFER, { limit: 10, scope: "messages" });
    expect(a.lane).toBe("tri");
    expect(a.hits.map((h) => h.refId)).toContain("m-a");
    expect(a.hits.some((h) => h.refId === "m-b")).toBe(false);

    const b = searchLcdImpl(db, "conv-a", "agent-b", HE_SEFER, { limit: 10, scope: "messages" });
    expect(b.hits.map((h) => h.refId)).toContain("m-b");
    expect(b.hits.some((h) => h.refId === "m-a")).toBe(false);
  });
});

describe("lcd-fts (180-05) — OBS-01 signal purity: an errored zero-result is NOT a lane gap", () => {
  it("a swallowed MATCH error sets matchErrored=true and leaves scriptZeroHit UNDEFINED", () => {
    // Cache isTriAvailable=true (a clean probe), THEN drop the twin tables so the
    // scoped MATCH throws and safeAll swallows it to []. The zero result is an
    // ERROR, not a true lane gap: matchErrored must be true and scriptZeroHit must
    // stay undefined (the OBS-01 emit at the tool boundary gates on !matchErrored).
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch(HE_HASEFARIM), messageId: "m1" });
    // Prime the isTriAvailable WeakMap with a CLEAN true verdict (twins present).
    const primed = searchLcdImpl(db, "conv-a", "agent-a", HE_SEFER, { limit: 1, scope: "messages" });
    expect(primed.lane).toBe("tri");
    // Now drop BOTH twins — the cached probe still says available → the scoped
    // MATCH throws → safeAll → [] but matchErrored must surface the error fact.
    db.exec("DROP TABLE lcd_messages_fts_tri; DROP TABLE lcd_summaries_fts_tri;");
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_SEFER, { limit: 10, scope: "messages" });
    expect(result.hits).toHaveLength(0);
    expect(result.matchErrored).toBe(true);
    expect(result.scriptZeroHit).toBeUndefined(); // an errored zero is NOT a signal
  });

  it("a CLEAN zero-hit non-Latin query sets scriptZeroHit to the dominant script (lane tri)", () => {
    // Twins exist, the MATCH runs cleanly, but no row matches → a true lane gap.
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch("hello world"), messageId: "m1" }); // no Hebrew
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_SEFER, { limit: 10, scope: "messages" });
    expect(result.hits).toHaveLength(0);
    expect(result.matchErrored).toBe(false);
    expect(result.lane).toBe("tri");
    expect(result.scriptZeroHit).toBe("hebrew");
  });
});

describe("lcd-fts (180-05) — LcdSearchResult widening: cjkZeroHit derives from scriptZeroHit", () => {
  it("a clean CJK zero-hit sets scriptZeroHit='cjk' AND the derived cjkZeroHit=true", () => {
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch("hello world"), messageId: "m1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", CJK_QUERY, { limit: 10, scope: "messages" });
    expect(result.hits).toHaveLength(0);
    expect(result.scriptZeroHit).toBe("cjk");
    expect(result.cjkZeroHit).toBe(true);
    // The derived-boolean identity holds.
    expect(result.cjkZeroHit).toBe(result.scriptZeroHit === "cjk");
  });

  it("a clean Hebrew zero-hit sets scriptZeroHit='hebrew' but cjkZeroHit STAYS false (the derivation)", () => {
    const db = lcdDbWithTwins();
    seedMessageTwin(db, { content: normalizeForSearch("hello world"), messageId: "m1" });
    const result = searchLcdImpl(db, "conv-a", "agent-a", HE_SEFER, { limit: 10, scope: "messages" });
    expect(result.scriptZeroHit).toBe("hebrew");
    expect(result.cjkZeroHit).toBe(false); // hebrew !== cjk
  });

  it("a neutral / all-Latin zero-hit query never signals (scriptZeroHit undefined, cjkZeroHit false)", () => {
    // dominantScript("") and dominantScript(neutral/Latin) → "latin"; the guard
    // script !== "latin" keeps neutral-only and Latin queries silent.
    const db = lcdDbWithTwins();
    const latin = searchLcdImpl(db, "conv-a", "agent-a", "no such latin term", { limit: 10, scope: "messages" });
    expect(latin.scriptZeroHit).toBeUndefined();
    expect(latin.cjkZeroHit).toBe(false);
    const numeric = searchLcdImpl(db, "conv-a", "agent-a", "12345", { limit: 10, scope: "messages" });
    expect(numeric.scriptZeroHit).toBeUndefined();
    expect(numeric.cjkZeroHit).toBe(false);
  });
});

// The :439-483 hasCjkCodepoints corpus (above) is the SUPERSET gate for the new
// dominantScript-based detection. Mixed-string semantics moved from
// "any CJK codepoint" to "dominant script" BY DESIGN — but that corpus is
// single-script per case, so EVERY verdict is preserved. This re-asserts the
// load-bearing ones against dominantScript directly (the detection's new basis):
// 你好/こんにちは/カタカナ/안녕하세요 → cjk; hello/café/"" → latin; the boundary
// codepoints (Yi U+A000, Hangul-Jamo U+1100 → NOT cjk; U+F900 → cjk).
describe("lcd-fts (180-05) — dominantScript preserves the hasCjkCodepoints corpus verdicts", () => {
  it("classifies every CJK corpus string as the cjk dominant script", () => {
    expect(dominantScript("你好")).toBe("cjk");
    expect(dominantScript(String.fromCodePoint(0x3053, 0x3093, 0x306b, 0x3061, 0x306f))).toBe("cjk"); // こんにちは
    expect(dominantScript(String.fromCodePoint(0x30ab, 0x30bf, 0x30ab, 0x30ca))).toBe("cjk"); // カタカナ
    expect(dominantScript(String.fromCodePoint(0xc548, 0xb155, 0xd558, 0xc138, 0xc694))).toBe("cjk"); // 안녕하세요
    expect(dominantScript(String.fromCodePoint(0xf900))).toBe("cjk"); // U+F900 compat ideograph → cjk
  });

  it("classifies the non-CJK corpus strings as latin (the false verdicts)", () => {
    expect(dominantScript("hello")).toBe("latin");
    expect(dominantScript("café")).toBe("latin");
    expect(dominantScript("")).toBe("latin");
    // Boundary codepoints that hasCjkCodepoints (corrected) returns false for: a Yi
    // syllable (U+A000) and a Hangul Jamo leading consonant (U+1100) are NOT cjk.
    expect(dominantScript(String.fromCodePoint(0xa000))).not.toBe("cjk");
    expect(dominantScript(String.fromCodePoint(0x1100))).not.toBe("cjk");
  });
});
