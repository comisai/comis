// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for delivery-mirror-adapter.ts.
 *
 * Closes the catch-block error paths in record()/pending()/acknowledge()/
 * pruneOld() — the missing branch-paths are the
 * `e instanceof Error ? e : new Error(String(e))` ternary halves.
 *
 * @module
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "./schema.js";
import { createSqliteDeliveryMirror } from "./delivery-mirror-adapter.js";
import { ConversationRefSchema, type DeliveryMirrorPort } from "@comis/core";

const CONVERSATION_REF = ConversationRefSchema.parse(`cv_${"a".repeat(43)}`);
const AUTHORITY = {
  tenantId: "tenant-a",
  agentId: "agent-a",
  conversationRef: CONVERSATION_REF,
};
const ENDPOINT = {
  channelType: "telegram",
  channelInstanceId: "telegram-account",
  conversationId: "ch-1",
  conversationKind: "direct" as const,
};

describe("SqliteDeliveryMirrorAdapter — branch-gap coverage", () => {
  let db: Database.Database;
  let mirror: DeliveryMirrorPort;

  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      ...AUTHORITY,
      destinationEndpoint: ENDPOINT,
      text: "mirrored hello",
      mediaUrls: [] as string[],
      channelType: "telegram",
      channelId: "ch-1",
      origin: "agent",
      idempotencyKey: `key-${Math.random()}`,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 128);
    mirror = createSqliteDeliveryMirror(db);
  });

  it("returns err result when record runs against a closed database", async () => {
    db.close();
    const result = await mirror.record(makeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns err result when pending runs against a closed database", async () => {
    db.close();
    const result = await mirror.pending(AUTHORITY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns err result when acknowledge runs against a closed database", async () => {
    db.close();
    const result = await mirror.acknowledge(["non-existent-id"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns err result when clearSession runs against a closed database", async () => {
    db.close();
    const result = await mirror.clearSession(AUTHORITY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns err result when pruneOld runs against a closed database", async () => {
    db.close();
    const result = await mirror.pruneOld(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("acknowledge no-ops cleanly when given empty id array", async () => {
    const result = await mirror.acknowledge([]);
    expect(result.ok).toBe(true);
  });

  it("pruneOld returns 0 when no rows are older than the cutoff", async () => {
    await mirror.record(makeInput());
    const result = await mirror.pruneOld(60_000); // 60s -- recent row stays
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(0);
    }
  });

  it("pruneOld removes rows whose created_at is older than the cutoff", async () => {
    // Insert a row directly with a stale timestamp so pruneOld removes it
    db.prepare(
      `INSERT INTO delivery_mirror (
                                     id, tenant_id, agent_id, conversation_ref, destination_endpoint,
                                     text, media_urls, channel_type, channel_id,
                                     origin, idempotency_key, status, created_at)
       VALUES ('stale-id', ?, ?, ?, ?, 'old', '[]', 'telegram', 'ch-1', 'agent', 'k1', 'pending', ?)`,
    ).run(
      AUTHORITY.tenantId,
      AUTHORITY.agentId,
      AUTHORITY.conversationRef,
      JSON.stringify(ENDPOINT),
      0,
    ); // created_at=0 -> definitely stale
    const result = await mirror.pruneOld(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(1);
    }
  });
});
