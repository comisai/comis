// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ConversationRefSchema } from "@comis/core";
import { createSqliteDeliveryMirror } from "./delivery-mirror-adapter.js";
import { createSqliteDeliveryQueue } from "./delivery-queue-adapter.js";
import { createObservabilityStore } from "./observability-store/index.js";
import { initSchema } from "./schema.js";

interface ColumnRow {
  name: string;
}

interface PersistedAuthorityRow {
  tenant_id: string;
  agent_id: string;
  conversation_ref: string;
  destination_endpoint: string;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[])
    .map((row) => row.name);
}

describe("delivery persistence authority", () => {
  it.each(["delivery_queue", "delivery_mirror"])(
    "%s rejects an old authority-incomplete layout with a backup instruction",
    (table) => {
      const db = new Database(":memory:");
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);

      expect(() => initSchema(db, 128)).toThrow(
        new RegExp(`${table}.*Back up the database`, "i"),
      );

      db.close();
    },
  );

  it("delivery queue mirror and observability rows carry one identical authority triple", () => {
    const db = new Database(":memory:");
    initSchema(db, 128);

    const authorityColumns = ["tenant_id", "agent_id", "conversation_ref"];
    for (const table of ["delivery_queue", "delivery_mirror", "obs_delivery"]) {
      expect(columnNames(db, table)).toEqual(expect.arrayContaining(authorityColumns));
    }

    db.close();
  });

  it("delivery records bind the destination endpoint snapshot", () => {
    const db = new Database(":memory:");
    initSchema(db, 128);

    for (const table of ["delivery_queue", "delivery_mirror", "obs_delivery"]) {
      expect(columnNames(db, table)).toContain("destination_endpoint");
    }

    db.close();
  });

  it("real queue mirror and observability writes preserve identical authority values", async () => {
    const db = new Database(":memory:");
    initSchema(db, 128);
    const authority = {
      tenantId: "tenant-authority",
      agentId: "agent-authority",
      conversationRef: ConversationRefSchema.parse(`cv_${"a".repeat(43)}`),
    };
    const destinationEndpoint = {
      channelType: "telegram",
      channelInstanceId: "primary-account",
      conversationId: "conversation-42",
      threadId: "thread-7",
      conversationKind: "shared" as const,
    };
    const queue = createSqliteDeliveryQueue(db, {
      emitSafely: () => ({
        hadListeners: false,
        failures: [],
        pendingFailures: Promise.resolve([]),
      }),
    });
    const mirror = createSqliteDeliveryMirror(db);
    const observability = createObservabilityStore(db);

    const queued = await queue.enqueue({
      ...authority,
      destinationEndpoint,
      text: "queued",
      channelType: destinationEndpoint.channelType,
      channelId: destinationEndpoint.conversationId,
      optionsJson: "{}",
      origin: "agent",
      maxAttempts: 3,
      createdAt: 1_000,
      scheduledAt: 1_000,
      expireAt: 2_000,
      traceId: "trace-authority",
    });
    const mirrored = await mirror.record({
      ...authority,
      destinationEndpoint,
      text: "mirrored",
      mediaUrls: [],
      channelType: destinationEndpoint.channelType,
      channelId: destinationEndpoint.conversationId,
      origin: "agent",
      idempotencyKey: "authority-proof",
    });
    observability.insertDelivery({
      ...authority,
      destinationEndpoint,
      timestamp: 1_000,
      traceId: "trace-authority",
      channelType: destinationEndpoint.channelType,
      channelId: destinationEndpoint.conversationId,
      status: "success",
      latencyMs: 10,
    });

    expect(queued.ok).toBe(true);
    expect(mirrored.ok).toBe(true);
    const persisted = ["delivery_queue", "delivery_mirror", "obs_delivery"].map(
      (table) => db.prepare(`
        SELECT tenant_id, agent_id, conversation_ref, destination_endpoint
        FROM ${table}
        LIMIT 1
      `).get() as PersistedAuthorityRow,
    );
    for (const row of persisted) {
      expect(row).toEqual({
        tenant_id: authority.tenantId,
        agent_id: authority.agentId,
        conversation_ref: authority.conversationRef,
        destination_endpoint: JSON.stringify(destinationEndpoint),
      });
    }

    db.close();
  });
});
