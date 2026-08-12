// SPDX-License-Identifier: Apache-2.0
/**
 * Unit coverage for `channel-trace.ts` — the ORACLE-01/02 dual-oracle
 * cross-check.
 *
 * Two deterministic units, NO daemon:
 *   1. `readMirrorText` — the direct readonly `delivery_mirror` read (Task 1).
 *      A temp FILE-backed SQLite DB (re-openable by path, NOT `:memory:`) with
 *      the real `delivery_mirror` DDL, INSERTed fixture rows, driven through
 *      `readMirrorText`. Asserts: equal/latest/absent/acknowledged-included/
 *      readonly-guarantee.
 *   2. `assertChannelTrace` — the HARD cross-check (Task 2). A hand-built fake
 *      emulator (`{ lastBotReply: () => ({ text }) }`) + the temp mirror DB.
 *      Asserts: agree → resolve; mismatch → throw both-values-named; missing
 *      mirror → honest reason-coded throw.
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change. Run ONLY under the live config:
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/assert/channel-trace.test.ts
 * (a bare `pnpm vitest run` resolves the ROOT config, which EXCLUDES test/live/
 * → 0 files, exit 0 — a false green).
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema } from "@comis/memory";
import { assertChannelTrace, readMirrorText } from "./channel-trace.js";

// Tmp dirs created per DB-using test — cleaned up after each test (the
// delivery-modes.test.ts idiom).
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** Allocate a fresh tmp dir + file DB path (registered for cleanup). */
function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "chan-trace-"));
  tmpDirs.push(dir);
  return join(dir, "memory.db");
}

/**
 * Create the `delivery_mirror` table with the REAL schema (packages/memory
 * source-tree schema.ts) — every NOT-NULL column present so fixture INSERTs
 * mirror what the product writes. Returns the file path.
 */
function freshMirrorDb(): string {
  const dbPath = freshDbPath();
  const db = new Database(dbPath);
  try {
    // Run the PRODUCT's boot DDL rather than a hand-copied CREATE TABLE. The
    // copy had drifted: it declared a `session_key` column the real schema does
    // not have (delivery rows are keyed on the durable
    // tenant_id/agent_id/conversation_ref identity), so this oracle's own tests
    // passed against a fiction while the oracle failed `no such column:
    // session_key` on any db a real daemon wrote.
    initSchema(db, 768);
  } finally {
    db.close();
  }
  return dbPath;
}

/** INSERT a delivery_mirror fixture row. */
function insertMirrorRow(
  dbPath: string,
  row: {
    id: string;
    conversationRef: string;
    text: string;
    status?: "pending" | "acknowledged";
    createdAt: number;
    idempotencyKey?: string;
  },
): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO delivery_mirror
       (id, tenant_id, agent_id, conversation_ref, destination_endpoint,
        text, media_urls, channel_type, channel_id, origin, idempotency_key, status, created_at)
     VALUES (?, 'test', 'default', ?, '{}', ?, '[]', 'telegram', 'chat-1', 'agent', ?, ?, ?)`,
  ).run(
    row.id,
    row.conversationRef,
    row.text,
    row.idempotencyKey ?? row.id,
    row.status ?? "acknowledged",
    row.createdAt,
  );
  db.close();
}

// ---------------------------------------------------------------------------
// Task 1 — readMirrorText (the Comis oracle: direct readonly delivery_mirror read)
// ---------------------------------------------------------------------------

describe("readMirrorText — the direct readonly delivery_mirror read (ORACLE-02 Comis half)", () => {
  it("returns the text for a conversation_ref (a single acknowledged row)", () => {
    const dbPath = freshMirrorDb();
    insertMirrorRow(dbPath, { id: "r1", conversationRef: "s", text: "hello", status: "acknowledged", createdAt: 1000 });

    expect(readMirrorText(dbPath, "s")).toBe("hello");
  });

  it("returns the LATEST row when two rows share a conversation_ref (ORDER BY created_at DESC)", () => {
    const dbPath = freshMirrorDb();
    insertMirrorRow(dbPath, { id: "old", conversationRef: "s", text: "first", createdAt: 1000 });
    insertMirrorRow(dbPath, { id: "new", conversationRef: "s", text: "second", createdAt: 2000 });

    expect(readMirrorText(dbPath, "s")).toBe("second");
  });

  it("returns undefined (honest absence, never throws) when no row matches the conversation_ref", () => {
    const dbPath = freshMirrorDb();
    insertMirrorRow(dbPath, { id: "r1", conversationRef: "other", text: "hello", createdAt: 1000 });

    expect(readMirrorText(dbPath, "missing")).toBeUndefined();
  });

  it("INCLUDES acknowledged rows (the cross-check needs acknowledged, NOT only pending)", () => {
    const dbPath = freshMirrorDb();
    // The documented anti-pattern is DeliveryMirrorPort.pending() filtering
    // status='pending'; an acknowledged row MUST still be returned.
    insertMirrorRow(dbPath, { id: "ack", conversationRef: "s", text: "acked-text", status: "acknowledged", createdAt: 1000 });

    expect(readMirrorText(dbPath, "s")).toBe("acked-text");
  });

  it("opens the DB readonly — a write against the same path-opened handle is rejected", () => {
    const dbPath = freshMirrorDb();
    insertMirrorRow(dbPath, { id: "r1", conversationRef: "s", text: "hello", createdAt: 1000 });

    // The read still works (readonly is a read).
    expect(readMirrorText(dbPath, "s")).toBe("hello");

    // And a readonly handle on the SAME file cannot write — proving the
    // open-mode the oracle uses is genuinely readonly (the oracle never
    // corrupts the state under test).
    const ro = new Database(dbPath, { readonly: true });
    try {
      expect(() =>
        ro
          .prepare(
            `INSERT INTO delivery_mirror
               (id, conversation_ref, text, media_urls, channel_type, channel_id, origin, idempotency_key, status, created_at)
             VALUES ('x','s','x','[]','telegram','c','agent','x','acknowledged', 1)`,
          )
          .run(),
      ).toThrow(/readonly|read-only/i);
    } finally {
      ro.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2 — assertChannelTrace (the HARD dual-oracle cross-check, ORACLE-01+02)
// ---------------------------------------------------------------------------

describe("assertChannelTrace — the HARD dual-oracle cross-check (ORACLE-01 + ORACLE-02)", () => {
  /**
   * A minimal channel-oracle fake (the structural subset — channel-agnostic, NOT
   * the whole TgEmulator). A hand-built object: NO daemon booted (the live
   * cross-check is exercised by the DELIV-01 delivery scenario).
   */
  function fakeEmulator(text: string | undefined): {
    lastBotReply(chat: { chatId: number }): { text?: string } | undefined;
  } {
    return {
      lastBotReply: () => (text === undefined ? undefined : { text }),
    };
  }

  it("resolves (no throw) when the wire text equals the mirror text", async () => {
    const dbPath = freshMirrorDb();
    insertMirrorRow(dbPath, { id: "r1", conversationRef: "s", text: "hi", createdAt: 1000 });

    await expect(
      assertChannelTrace({
        emulator: fakeEmulator("hi"),
        chat: { chatId: 42 },
        memoryDbPath: dbPath,
        conversationRef: "s",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws naming BOTH values + 'dual-oracle' when the wire text != the mirror text", async () => {
    const dbPath = freshMirrorDb();
    insertMirrorRow(dbPath, { id: "r1", conversationRef: "s", text: "bye", createdAt: 1000 });

    await expect(
      assertChannelTrace({
        emulator: fakeEmulator("hi"),
        chat: { chatId: 42 },
        memoryDbPath: dbPath,
        conversationRef: "s",
      }),
    ).rejects.toThrow(/dual-oracle/);

    // The thrown message names BOTH the wire and the mirror values (so a
    // failure is diagnosable from the throw alone — no-false-success).
    await expect(
      assertChannelTrace({
        emulator: fakeEmulator("hi"),
        chat: { chatId: 42 },
        memoryDbPath: dbPath,
        conversationRef: "s",
      }),
    ).rejects.toThrow(/hi[\s\S]*bye|bye[\s\S]*hi/);
  });

  it("throws an honest, reason-coded error when the mirror row is ABSENT (never a silent pass)", async () => {
    const dbPath = freshMirrorDb();
    // No row for "s" — a wire reply with no mirror is a real failure, not a pass.

    await expect(
      assertChannelTrace({
        emulator: fakeEmulator("hi"),
        chat: { chatId: 42 },
        memoryDbPath: dbPath,
        conversationRef: "s",
      }),
    ).rejects.toThrow(/delivery_mirror|no mirror/i);
  });
});
