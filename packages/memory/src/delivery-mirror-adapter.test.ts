// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createSqliteDeliveryMirror } from "./delivery-mirror-adapter.js";
import { createNoOpDeliveryMirror } from "@comis/core";
import { initSchema } from "./schema.js";

describe("createSqliteDeliveryMirror", () => {
  let db: Database.Database;
  let mirror: ReturnType<typeof createSqliteDeliveryMirror>;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 128);
    mirror = createSqliteDeliveryMirror(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      sessionKey: "telegram:dm:user123",
      text: "Hello from agent",
      mediaUrls: [] as string[],
      channelType: "telegram",
      channelId: "chat-001",
      origin: "agent",
      idempotencyKey: `key-${Date.now()}-${Math.random()}`,
      ...overrides,
    };
  }

  it("record() inserts a mirror entry and returns an id", async () => {
    const result = await mirror.record(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value).toBe("string");
    expect(result.value.length).toBeGreaterThan(0);

    const pending = await mirror.pending("telegram:dm:user123");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value).toHaveLength(1);
    expect(pending.value[0].text).toBe("Hello from agent");
  });

  it("record() with duplicate idempotency key is silently ignored", async () => {
    const input = makeInput({ idempotencyKey: "dup-key-001" });
    const r1 = await mirror.record(input);
    expect(r1.ok).toBe(true);

    const r2 = await mirror.record({ ...input, text: "Different text" });
    expect(r2.ok).toBe(true);

    const pending = await mirror.pending("telegram:dm:user123");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value).toHaveLength(1);
    expect(pending.value[0].text).toBe("Hello from agent");
  });

  it("pending() returns entries ordered by created_at ASC", async () => {
    // Insert directly with controlled timestamps to ensure ordering
    db.exec(`
      INSERT INTO delivery_mirror (id, session_key, text, media_urls, channel_type, channel_id, origin, idempotency_key, status, created_at)
      VALUES ('id-3', 'sess-a', 'Third', '[]', 'telegram', 'ch1', 'agent', 'k3', 'pending', 3000);
    `);
    db.exec(`
      INSERT INTO delivery_mirror (id, session_key, text, media_urls, channel_type, channel_id, origin, idempotency_key, status, created_at)
      VALUES ('id-1', 'sess-a', 'First', '[]', 'telegram', 'ch1', 'agent', 'k1', 'pending', 1000);
    `);
    db.exec(`
      INSERT INTO delivery_mirror (id, session_key, text, media_urls, channel_type, channel_id, origin, idempotency_key, status, created_at)
      VALUES ('id-2', 'sess-a', 'Second', '[]', 'telegram', 'ch1', 'agent', 'k2', 'pending', 2000);
    `);

    const pending = await mirror.pending("sess-a");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value).toHaveLength(3);
    expect(pending.value[0].text).toBe("First");
    expect(pending.value[1].text).toBe("Second");
    expect(pending.value[2].text).toBe("Third");
  });

  it("pending() returns only entries for the given sessionKey", async () => {
    await mirror.record(makeInput({ sessionKey: "sess-a", idempotencyKey: "ka" }));
    await mirror.record(makeInput({ sessionKey: "sess-b", idempotencyKey: "kb" }));

    const pendingA = await mirror.pending("sess-a");
    expect(pendingA.ok).toBe(true);
    if (!pendingA.ok) return;
    expect(pendingA.value).toHaveLength(1);

    const pendingB = await mirror.pending("sess-b");
    expect(pendingB.ok).toBe(true);
    if (!pendingB.ok) return;
    expect(pendingB.value).toHaveLength(1);
  });

  it("acknowledge() marks entries as acknowledged", async () => {
    const r1 = await mirror.record(makeInput({ idempotencyKey: "ack-1" }));
    const r2 = await mirror.record(makeInput({ idempotencyKey: "ack-2" }));
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const ackResult = await mirror.acknowledge([r1.value, r2.value]);
    expect(ackResult.ok).toBe(true);

    const pending = await mirror.pending("telegram:dm:user123");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value).toHaveLength(0);
  });

  it("pruneOld() removes entries older than maxAgeMs", async () => {
    const now = Date.now();
    // Insert old entry via direct SQL
    db.exec(`
      INSERT INTO delivery_mirror (id, session_key, text, media_urls, channel_type, channel_id, origin, idempotency_key, status, created_at)
      VALUES ('old-1', 'sess-a', 'Old', '[]', 'telegram', 'ch1', 'agent', 'prune-old', 'pending', ${now - 100_000});
    `);
    // Insert recent entry via adapter
    await mirror.record(makeInput({ sessionKey: "sess-a", idempotencyKey: "prune-new" }));

    const pruned = await mirror.pruneOld(50_000);
    expect(pruned.ok).toBe(true);
    if (!pruned.ok) return;
    expect(pruned.value).toBe(1);

    const pending = await mirror.pending("sess-a");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value).toHaveLength(1);
    expect(pending.value[0].idempotencyKey).toBe("prune-new");
  });

  it("record() stores mediaUrls as JSON", async () => {
    const urls = ["https://example.com/a.png", "https://example.com/b.jpg"];
    await mirror.record(makeInput({ mediaUrls: urls, idempotencyKey: "media-1" }));

    const pending = await mirror.pending("telegram:dm:user123");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value[0].mediaUrls).toEqual(urls);
  });
});

describe("createNoOpDeliveryMirror", () => {
  it("returns success for all operations", async () => {
    const noop = createNoOpDeliveryMirror();

    const recordResult = await noop.record({
      sessionKey: "s",
      text: "t",
      mediaUrls: [],
      channelType: "echo",
      channelId: "c",
      origin: "agent",
      idempotencyKey: "k",
    });
    expect(recordResult.ok).toBe(true);
    if (recordResult.ok) expect(typeof recordResult.value).toBe("string");

    const pendingResult = await noop.pending("s");
    expect(pendingResult.ok).toBe(true);
    if (pendingResult.ok) expect(pendingResult.value).toEqual([]);

    const ackResult = await noop.acknowledge(["id1"]);
    expect(ackResult.ok).toBe(true);

    const pruneResult = await noop.pruneOld(1000);
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) expect(pruneResult.value).toBe(0);
  });
});
