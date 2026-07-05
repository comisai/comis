// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createSqliteMsTeamsConversationStore — the conversation-id → routing
 * tuple store that unblocks proactive delivery.
 *
 * Pins the load-bearing invariants:
 *   - capture then get round-trips the routing tuple (thread_id NULL → threadId undefined),
 *   - a second capture for the SAME conversation id upserts (refreshes, one row),
 *   - a reference older than the TTL is pruned on the next capture,
 *   - the table is capped (the oldest is evicted) on capture,
 *   - get on a never-captured id is ok(undefined),
 *   - a corrupt row degrades get to Result.err (never a throw),
 *   - the table persists routing columns only (no credential/content column),
 *   - the REAL initSchema creates the table + its index.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createSqliteMsTeamsConversationStore } from "./msteams-conversation-store.js";
import { ensureMsTeamsConversationTable } from "./schema-msteams-conversation.js";
import { initSchema } from "./schema.js";
import type { ConversationReference } from "@comis/core";

// The store's documented internal bounds (kept in lockstep with the module).
const CAP = 1000;
const TTL_MS = 365 * 24 * 60 * 60 * 1000;

// Deterministic clock — the injected nowMs drives the TTL prune boundary only.
let fakeNow = 1_700_000_000_000;
const nowMs = (): number => fakeNow;

let db: Database.Database;

function makeRef(over: Partial<ConversationReference> = {}): ConversationReference {
  return {
    conversationId: "19:conv_default@thread.v2",
    serviceUrl: "https://smba.example.com/emea/",
    tenantId: "tenant-1",
    threadId: "19:thread_root",
    updatedAt: fakeNow,
    ...over,
  };
}

function rowCount(): number {
  const raw = db.prepare(`SELECT COUNT(*) AS c FROM msteams_conversation_refs`).get() as {
    c: number;
  };
  return raw.c;
}

beforeEach(() => {
  fakeNow = 1_700_000_000_000;
  db = new Database(":memory:");
  ensureMsTeamsConversationTable(db);
});

afterEach(() => {
  db.close();
});

describe("createSqliteMsTeamsConversationStore — capture + get round-trip", () => {
  it("captures a full reference that get returns unchanged", async () => {
    const store = createSqliteMsTeamsConversationStore(db, nowMs);
    const ref = makeRef({ conversationId: "conv-full" });

    const captured = await store.capture(ref);
    expect(captured.ok).toBe(true);

    const found = await store.get("conv-full");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toBeDefined();
    expect(found.value?.conversationId).toBe("conv-full");
    expect(found.value?.serviceUrl).toBe(ref.serviceUrl);
    expect(found.value?.tenantId).toBe(ref.tenantId);
    expect(found.value?.threadId).toBe(ref.threadId);
    expect(found.value?.updatedAt).toBe(ref.updatedAt);
  });

  it("round-trips a reference with no thread as threadId undefined", async () => {
    const store = createSqliteMsTeamsConversationStore(db, nowMs);
    const { threadId: _omitted, ...withoutThread } = makeRef({ conversationId: "conv-dm" });
    void _omitted;

    const captured = await store.capture(withoutThread);
    expect(captured.ok).toBe(true);

    const found = await store.get("conv-dm");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.threadId).toBeUndefined();
  });

  it("returns ok(undefined) for a conversation that was never captured", async () => {
    const store = createSqliteMsTeamsConversationStore(db, nowMs);
    const found = await store.get("conv-never-seen");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toBeUndefined();
  });
});

describe("createSqliteMsTeamsConversationStore — upsert refresh", () => {
  it("a second capture for the same conversation id refreshes the tuple in one row", async () => {
    const store = createSqliteMsTeamsConversationStore(db, nowMs);

    await store.capture(
      makeRef({
        conversationId: "conv-refresh",
        serviceUrl: "https://old.example.com/",
        tenantId: "tenant-old",
        threadId: "19:old_thread",
        updatedAt: 1_700_000_000_000,
      }),
    );

    await store.capture(
      makeRef({
        conversationId: "conv-refresh",
        serviceUrl: "https://new.example.com/",
        tenantId: "tenant-new",
        threadId: "19:new_thread",
        updatedAt: 1_700_000_500_000,
      }),
    );

    // Upsert, not a second row.
    expect(rowCount()).toBe(1);

    const found = await store.get("conv-refresh");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.serviceUrl).toBe("https://new.example.com/");
    expect(found.value?.tenantId).toBe("tenant-new");
    expect(found.value?.threadId).toBe("19:new_thread");
    expect(found.value?.updatedAt).toBe(1_700_000_500_000);
  });
});

describe("createSqliteMsTeamsConversationStore — TTL prune + cap eviction", () => {
  it("prunes a reference older than the TTL on the next capture", async () => {
    const store = createSqliteMsTeamsConversationStore(db, nowMs);

    const t0 = 1_700_000_000_000;
    fakeNow = t0;
    await store.capture(makeRef({ conversationId: "conv-old", updatedAt: t0 }));
    const stillFresh = await store.get("conv-old");
    expect(stillFresh.ok && stillFresh.value).toBeDefined();

    // Advance beyond the TTL, then capture a different conversation — the prune
    // runs on capture and evicts the now-expired conv-old.
    fakeNow = t0 + TTL_MS + 1;
    await store.capture(makeRef({ conversationId: "conv-new", updatedAt: fakeNow }));

    const pruned = await store.get("conv-old");
    expect(pruned.ok).toBe(true);
    if (!pruned.ok) return;
    expect(pruned.value).toBeUndefined();

    const survivor = await store.get("conv-new");
    expect(survivor.ok && survivor.value).toBeDefined();
  });

  it("caps the table and evicts the oldest reference on capture", async () => {
    const store = createSqliteMsTeamsConversationStore(db, nowMs);
    // Keep the TTL prune inert (all rows well within the window); exercise the cap.
    fakeNow = 1_000_000_000_000;
    const base = 1_000_000_000_000;

    for (let i = 0; i <= CAP; i++) {
      // CAP + 1 distinct conversations, strictly increasing updatedAt so conv-0
      // is the oldest.
      await store.capture(makeRef({ conversationId: `conv-${i}`, updatedAt: base + i }));
    }

    expect(rowCount()).toBe(CAP);

    // The oldest (conv-0) was evicted; the newest survives.
    const evicted = await store.get("conv-0");
    expect(evicted.ok).toBe(true);
    if (!evicted.ok) return;
    expect(evicted.value).toBeUndefined();

    const kept = await store.get(`conv-${CAP}`);
    expect(kept.ok && kept.value).toBeDefined();
  });
});

describe("createSqliteMsTeamsConversationStore — corrupt-row resilience + content-free", () => {
  it("degrades get to err on a corrupt row rather than throwing", async () => {
    const store = createSqliteMsTeamsConversationStore(db, nowMs);
    await store.capture(makeRef({ conversationId: "conv-corrupt" }));

    // Tamper the INTEGER updated_at_ms to a non-numeric string. SQLite's INTEGER
    // affinity stores a non-numeric string as TEXT, so on read the row schema's
    // z.number() rejects it and createRowMapper degrades get to err — never a
    // throw that would abort a proactive send resolve.
    db.prepare(
      `UPDATE msteams_conversation_refs SET updated_at_ms = 'not-a-number'`,
    ).run();

    const found = await store.get("conv-corrupt");
    expect(found.ok).toBe(false);
  });

  it("persists routing columns only with no credential or content column", async () => {
    const store = createSqliteMsTeamsConversationStore(db, nowMs);
    void store; // the assertion is structural: the table shape carries no secret/body column.
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('msteams_conversation_refs')`)
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("service_url");
    expect(names).toContain("tenant_id");
    expect(names).not.toContain("token");
    expect(names).not.toContain("access_token");
    expect(names).not.toContain("bearer");
    expect(names).not.toContain("body");
    expect(names).not.toContain("text");
    expect(names).not.toContain("message");
  });
});

describe("ensureMsTeamsConversationTable wiring — real initSchema layout", () => {
  it("the REAL initSchema creates msteams_conversation_refs + its updated_at index", () => {
    // A table defined in schema-msteams-conversation.ts but not wired into
    // initSchema is MISSING at runtime — assert against the REAL initSchema, not
    // the local ensureMsTeamsConversationTable helper, so a regression that drops
    // the initSchema call is caught here.
    const fresh = new Database(":memory:");
    try {
      initSchema(fresh, 384);

      const table = fresh
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='msteams_conversation_refs'`,
        )
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("msteams_conversation_refs");

      const idx = fresh
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_msteams_conv_updated'`,
        )
        .get() as { name: string } | undefined;
      expect(idx?.name).toBe("idx_msteams_conv_updated");
    } finally {
      fresh.close();
    }
  });
});
