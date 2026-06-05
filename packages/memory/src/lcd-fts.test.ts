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
