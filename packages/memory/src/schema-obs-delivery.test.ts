// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "./schema.js";
import { ensureObsDeliveryColumns } from "./schema-obs-delivery.js";

describe("obs_delivery schema preflight", () => {
  it("rejects an authority-incomplete delivery table with a backup instruction", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE obs_delivery (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        trace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        session_key TEXT DEFAULT '',
        status TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        error_message TEXT DEFAULT '',
        message_preview TEXT DEFAULT '',
        tool_calls INTEGER,
        llm_calls INTEGER,
        tokens_total INTEGER DEFAULT 0,
        cost_total REAL DEFAULT 0
      );
      INSERT INTO obs_delivery (
        timestamp, trace_id, agent_id, channel_type, channel_id,
        status, latency_ms
      ) VALUES (1000, 'trace-existing', 'agent-a', 'telegram', 'chat-a',
        'error', 25);
    `);

    expect(() => initSchema(db, 384)).toThrow(/obs_delivery.*Back up the database/i);

    db.close();
  });

  it("adds optional delivery failure classifications to an existing current table", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE obs_delivery (id INTEGER PRIMARY KEY)");

    ensureObsDeliveryColumns(db);

    const columns = db.prepare("PRAGMA table_info(obs_delivery)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["failure_stage", "error_kind"]),
    );
    db.close();
  });
});
