import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initContextSchema } from "./context-schema.js";

/** Open an in-memory database with foreign keys enabled and schema initialized. */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initContextSchema(db);
  return db;
}

/** Insert a minimal conversation row and return its id. */
function insertConversation(db: Database.Database, id = "conv-1"): string {
  db.prepare(
    `INSERT INTO ctx_conversations (conversation_id, tenant_id, agent_id, session_key)
     VALUES (?, 'tenant-1', 'agent-1', ?)`,
  ).run(id, `session-${id}`);
  return id;
}

/** Insert a minimal message row and return its message_id. */
function insertMessage(
  db: Database.Database,
  conversationId: string,
  seq: number,
  role = "user",
  content = "hello",
): number {
  const info = db
    .prepare(
      `INSERT INTO ctx_messages (conversation_id, seq, role, content, content_hash, token_count)
       VALUES (?, ?, ?, ?, 'hash-' || ?, 1)`,
    )
    .run(conversationId, seq, role, content, seq);
  return Number(info.lastInsertRowid);
}

/** Insert a minimal summary row and return its summary_id. */
function insertSummary(
  db: Database.Database,
  summaryId: string,
  conversationId: string,
  kind = "leaf",
): string {
  db.prepare(
    `INSERT INTO ctx_summaries (summary_id, conversation_id, kind, content, token_count)
     VALUES (?, ?, ?, 'summary content', 10)`,
  ).run(summaryId, conversationId, kind);
  return summaryId;
}

describe("initContextSchema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  // --- Group 1: table creation ---

  describe("table creation", () => {
    it("creates all 9 regular ctx_ tables", () => {
      // FTS5 creates shadow tables (e.g. ctx_messages_fts_content, _data, etc.)
      // Filter them out by excluding names containing '_fts_' and the FTS5 virtual tables themselves.
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='table' AND name LIKE 'ctx_%'
             AND name NOT LIKE '%_fts%'
           ORDER BY name`,
        )
        .all() as { name: string }[];

      const names = tables.map((r) => r.name);
      expect(names).toEqual([
        "ctx_context_items",
        "ctx_conversations",
        "ctx_expansion_grants",
        "ctx_large_files",
        "ctx_message_parts",
        "ctx_messages",
        "ctx_summaries",
        "ctx_summary_messages",
        "ctx_summary_parents",
      ]);
    });

    it("creates 2 FTS5 virtual tables", () => {
      const fts = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE sql LIKE '%fts5%' AND name LIKE 'ctx_%'
           ORDER BY name`,
        )
        .all() as { name: string }[];

      const names = fts.map((r) => r.name);
      expect(names).toEqual(["ctx_messages_fts", "ctx_summaries_fts"]);
    });

    it("creates all expected indexes", () => {
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='index' AND name LIKE 'ctx_%'
           ORDER BY name`,
        )
        .all() as { name: string }[];

      const names = indexes.map((r) => r.name);
      expect(names).toContain("ctx_messages_conv_seq");
      expect(names).toContain("ctx_messages_hash");
      expect(names).toContain("ctx_summaries_conv");
      expect(names).toContain("ctx_summaries_depth");
      expect(names).toContain("ctx_large_files_conv");
      expect(names).toContain("ctx_large_files_hash");
      expect(names).toContain("ctx_grants_session");
      expect(names).toContain("ctx_grants_expires");
    });
  });

  // --- Group 2: idempotency ---

  describe("idempotency", () => {
    it("calling initContextSchema twice produces no errors", () => {
      // db already had initContextSchema called in createTestDb
      expect(() => initContextSchema(db)).not.toThrow();

      // Verify tables still exist and are usable
      const convId = insertConversation(db);
      insertMessage(db, convId, 1);

      const count = db
        .prepare("SELECT COUNT(*) as c FROM ctx_messages")
        .get() as { c: number };
      expect(count.c).toBe(1);
    });
  });

  // --- Group 3: constraints ---

  describe("constraints", () => {
    it("ctx_messages role CHECK constraint rejects invalid roles", () => {
      const convId = insertConversation(db);
      expect(() => {
        db.prepare(
          `INSERT INTO ctx_messages (conversation_id, seq, role, content, content_hash, token_count)
           VALUES (?, 1, 'invalid', 'test', 'hash', 1)`,
        ).run(convId);
      }).toThrow();
    });

    it("ctx_messages role CHECK allows valid roles", () => {
      const convId = insertConversation(db);
      for (const [i, role] of ["system", "user", "assistant", "tool"].entries()) {
        expect(() => {
          db.prepare(
            `INSERT INTO ctx_messages (conversation_id, seq, role, content, content_hash, token_count)
             VALUES (?, ?, ?, 'content', 'hash-' || ?, 1)`,
          ).run(convId, i + 1, role, i);
        }).not.toThrow();
      }
    });

    it("ctx_messages UNIQUE(conversation_id, seq) prevents duplicates", () => {
      const convId = insertConversation(db);
      insertMessage(db, convId, 1);
      expect(() => insertMessage(db, convId, 1)).toThrow();
    });

    it("ctx_summaries kind CHECK constraint rejects invalid kinds", () => {
      const convId = insertConversation(db);
      expect(() => {
        db.prepare(
          `INSERT INTO ctx_summaries (summary_id, conversation_id, kind, content, token_count)
           VALUES ('s1', ?, 'invalid', 'content', 10)`,
        ).run(convId);
      }).toThrow();
    });

    it("ctx_context_items CHECK enforces item_type exclusivity", () => {
      const convId = insertConversation(db);
      const msgId = insertMessage(db, convId, 1);
      const sumId = insertSummary(db, "sum-1", convId);

      // item_type='message' with summary_id set -- should fail
      expect(() => {
        db.prepare(
          `INSERT INTO ctx_context_items (conversation_id, ordinal, item_type, message_id, summary_id)
           VALUES (?, 1, 'message', ?, ?)`,
        ).run(convId, msgId, sumId);
      }).toThrow();

      // item_type='summary' with message_id set -- should fail
      expect(() => {
        db.prepare(
          `INSERT INTO ctx_context_items (conversation_id, ordinal, item_type, message_id, summary_id)
           VALUES (?, 2, 'summary', ?, ?)`,
        ).run(convId, msgId, sumId);
      }).toThrow();

      // Valid: message item with only message_id
      expect(() => {
        db.prepare(
          `INSERT INTO ctx_context_items (conversation_id, ordinal, item_type, message_id, summary_id)
           VALUES (?, 1, 'message', ?, NULL)`,
        ).run(convId, msgId);
      }).not.toThrow();

      // Valid: summary item with only summary_id
      expect(() => {
        db.prepare(
          `INSERT INTO ctx_context_items (conversation_id, ordinal, item_type, message_id, summary_id)
           VALUES (?, 2, 'summary', NULL, ?)`,
        ).run(convId, sumId);
      }).not.toThrow();
    });

    it("ctx_messages AUTOINCREMENT prevents rowid reuse", () => {
      const convId = insertConversation(db);
      insertMessage(db, convId, 1); // message_id = 1
      insertMessage(db, convId, 2); // message_id = 2
      const thirdId = insertMessage(db, convId, 3); // message_id = 3
      expect(thirdId).toBe(3);

      // Delete the last message
      db.prepare("DELETE FROM ctx_messages WHERE message_id = ?").run(thirdId);

      // Insert a new message -- must get id=4, not 3 (AUTOINCREMENT)
      const fourthId = insertMessage(db, convId, 3, "user", "new content");
      expect(fourthId).toBe(4);
    });
  });

  // --- Group 4: foreign keys and cascades ---

  describe("foreign keys and cascades", () => {
    it("deleting a conversation cascades to messages", () => {
      const convId = insertConversation(db);
      insertMessage(db, convId, 1);
      insertMessage(db, convId, 2);

      db.prepare("DELETE FROM ctx_conversations WHERE conversation_id = ?").run(
        convId,
      );

      const count = db
        .prepare("SELECT COUNT(*) as c FROM ctx_messages")
        .get() as { c: number };
      expect(count.c).toBe(0);
    });

    it("deleting a conversation cascades to summaries and context_items", () => {
      const convId = insertConversation(db);
      const msgId = insertMessage(db, convId, 1);
      insertSummary(db, "sum-1", convId);

      db.prepare(
        `INSERT INTO ctx_context_items (conversation_id, ordinal, item_type, message_id, summary_id)
         VALUES (?, 1, 'message', ?, NULL)`,
      ).run(convId, msgId);

      db.prepare("DELETE FROM ctx_conversations WHERE conversation_id = ?").run(
        convId,
      );

      const sumCount = db
        .prepare("SELECT COUNT(*) as c FROM ctx_summaries")
        .get() as { c: number };
      const itemCount = db
        .prepare("SELECT COUNT(*) as c FROM ctx_context_items")
        .get() as { c: number };
      expect(sumCount.c).toBe(0);
      expect(itemCount.c).toBe(0);
    });

    it("cannot delete a message referenced by ctx_summary_messages (RESTRICT)", () => {
      const convId = insertConversation(db);
      const msgId = insertMessage(db, convId, 1);
      insertSummary(db, "sum-1", convId);

      db.prepare(
        `INSERT INTO ctx_summary_messages (summary_id, message_id, ordinal)
         VALUES ('sum-1', ?, 0)`,
      ).run(msgId);

      expect(() => {
        db.prepare("DELETE FROM ctx_messages WHERE message_id = ?").run(msgId);
      }).toThrow();
    });

    it("cannot delete a parent summary referenced by ctx_summary_parents (RESTRICT)", () => {
      const convId = insertConversation(db);
      const parentId = insertSummary(db, "sum-parent", convId, "leaf");
      const childId = insertSummary(db, "sum-child", convId, "condensed");

      db.prepare(
        `INSERT INTO ctx_summary_parents (summary_id, parent_summary_id, ordinal)
         VALUES (?, ?, 0)`,
      ).run(childId, parentId);

      expect(() => {
        db.prepare("DELETE FROM ctx_summaries WHERE summary_id = ?").run(
          parentId,
        );
      }).toThrow();
    });
  });

  // --- Group 5: FTS5 standalone tables ---

  describe("FTS5 standalone tables", () => {
    it("can insert and query ctx_messages_fts", () => {
      db.prepare(
        "INSERT INTO ctx_messages_fts(rowid, content) VALUES (1, 'the quick brown fox')",
      ).run();

      const results = db
        .prepare(
          "SELECT rowid, content FROM ctx_messages_fts WHERE ctx_messages_fts MATCH 'brown'",
        )
        .all() as { rowid: number; content: string }[];

      expect(results).toHaveLength(1);
      expect(results[0]!.rowid).toBe(1);
      expect(results[0]!.content).toBe("the quick brown fox");
    });

    it("can insert and query ctx_summaries_fts", () => {
      db.prepare(
        "INSERT INTO ctx_summaries_fts(summary_id, content) VALUES ('sum-1', 'summary of important events')",
      ).run();

      const results = db
        .prepare(
          "SELECT summary_id, content FROM ctx_summaries_fts WHERE content MATCH 'important'",
        )
        .all() as { summary_id: string; content: string }[];

      expect(results).toHaveLength(1);
      expect(results[0]!.summary_id).toBe("sum-1");
      expect(results[0]!.content).toBe("summary of important events");
    });

    it("FTS5 uses porter tokenizer", () => {
      // "running" should stem to "run" via porter tokenizer
      db.prepare(
        "INSERT INTO ctx_messages_fts(rowid, content) VALUES (1, 'running quickly')",
      ).run();

      const results = db
        .prepare(
          "SELECT rowid FROM ctx_messages_fts WHERE ctx_messages_fts MATCH 'run'",
        )
        .all();

      expect(results).toHaveLength(1);
    });
  });
});
