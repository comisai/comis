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
    let hits: ReturnType<typeof searchLcdImpl> = [];
    expect(() => {
      hits = searchLcdImpl(db, "conv-a", "revenue", { limit: 10, scope: "summaries" });
    }).not.toThrow();

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

    const hits = searchLcdImpl(db, "conv-a", "falcon", { limit: 10, scope: "messages" });
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
    const hits = searchLcdImpl(db, "conv-a", "keyword", { limit: 2, scope: "summaries" });
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

    const hits = searchLcdImpl(db, "conv-a", "revenue", { limit: 10, scope: "summaries" });

    // The good row survives the bad sibling (WR-01: one bad row must not poison
    // the whole result set).
    expect(hits.map((h) => h.refId)).toContain("s-good");
    expect(hits.some((h) => h.refId === "s-bad")).toBe(false);
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

    const hits = searchLcdImpl(db, "conv-a", "match", { limit: 2, scope: "both" });

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

    const hits = searchLcdImpl(db, "conv-a", "one", { limit: 6, scope: "both" });

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
    const aHits = searchLcdImpl(db, "conv-shared", "agent-a", "revenue", { limit: 10, scope: "summaries" });
    expect(aHits.map((h) => h.refId)).toContain("sum-a");
    expect(aHits.some((h) => h.refId === "sum-b")).toBe(false);

    // Agent B's scoped search returns ONLY agent B's summary (symmetry).
    const bHits = searchLcdImpl(db, "conv-shared", "agent-b", "revenue", { limit: 10, scope: "summaries" });
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
    const aHits = searchLcdImpl(db, "conv-shared", "agent-a", "margin", { limit: 10, scope: "summaries" });
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

    const aHits = searchLcdImpl(db, "conv-shared", "agent-a", "falcon", { limit: 10, scope: "messages" });
    expect(aHits.map((h) => h.refId)).toContain("m-a");
    expect(aHits.some((h) => h.refId === "m-b")).toBe(false); // agent B's message excluded
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
