// SPDX-License-Identifier: Apache-2.0
/**
 * Real-SQLite regressions for conservative outbound queue recovery.
 *
 * A queue row can remain in_flight after the platform accepted a message but
 * before the local acknowledgement committed. Neither startup nor a competing
 * drainer may replay that uncertain effect.
 */

import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { err, ok } from "@comis/shared";
import {
  AMBIGUOUS_SEND_OUTCOME_ERROR,
  TypedEventBus,
  type AppConfig,
  type DeliveryAdapter,
  type DeliveryQueuePort,
} from "@comis/core";
import { createSqliteDeliveryQueue, initSchema } from "@comis/memory";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { drainDeliveryQueue, setupDeliveryQueue } from "./setup-delivery.js";

function queueConfig(): AppConfig {
  return {
    deliveryQueue: {
      enabled: true,
      maxQueueDepth: 10_000,
      defaultMaxAttempts: 5,
      defaultExpireMs: 3_600_000,
      drainOnStartup: true,
      drainBudgetMs: 60_000,
      drainIntervalMs: 60_000,
      pruneIntervalMs: 60_000,
    },
  } as unknown as AppConfig;
}

function seedRow(
  db: Database.Database,
  id: string,
  text: string,
  status: "pending" | "in_flight",
): void {
  const now = Date.now();
  const conversationRef = `cv_${"d".repeat(43)}`;
  const destinationEndpoint = JSON.stringify({
    channelType: "telegram",
    channelInstanceId: "telegram-test",
    conversationId: "chat-a",
    conversationKind: "direct",
  });
  db.prepare(
    `INSERT INTO delivery_queue (
       id, text, channel_type, channel_id, tenant_id, agent_id, conversation_ref,
       destination_endpoint, options_json, origin,
       status, attempt_count, max_attempts, created_at, scheduled_at, expire_at
     ) VALUES (?, ?, 'telegram', 'chat-a', 'default', 'agent-a', ?, ?, '{}', 'agent', ?, 0, 5, ?, ?, ?)`,
  ).run(id, text, conversationRef, destinationEndpoint, status, now, now, now + 3_600_000);
}

function makeBarrierQueue(queue: DeliveryQueuePort): DeliveryQueuePort {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    ...queue,
    async pendingEntries() {
      const selected = await queue.pendingEntries();
      arrivals++;
      if (arrivals === 2) release?.();
      await barrier;
      return selected;
    },
  };
}

describe("delivery queue conservative replay safety", () => {
  it("startup parks a stale in-flight row and drains only a genuinely pending row", async () => {
    const db = new Database(":memory:");
    initSchema(db, 768);
    seedRow(db, "uncertain", "possibly delivered", "in_flight");
    seedRow(db, "pending", "not attempted", "pending");

    const sentTexts: string[] = [];
    const adapter: DeliveryAdapter = {
      channelId: "telegram-test",
      channelType: "telegram",
      sendMessage: vi.fn(async (_channelId, text) => {
        sentTexts.push(text);
        return ok(`message-${sentTexts.length}`);
      }),
    };
    const setup = await setupDeliveryQueue({
      db,
      config: queueConfig(),
      eventBus: createMockEventBus() as unknown as TypedEventBus,
      logger: createMockLogger(),
      channelAdapters: new Map([["telegram", adapter]]),
    });

    await setup.drainAndStart();
    setup.shutdown();

    expect(sentTexts).toEqual(["not attempted"]);
    const uncertain = db
      .prepare("SELECT status, last_error FROM delivery_queue WHERE id = 'uncertain'")
      .get() as { status: string; last_error: string | null };
    expect(uncertain).toEqual({
      status: "failed",
      last_error: AMBIGUOUS_SEND_OUTCOME_ERROR,
    });
    db.close();
  });

  it("two drainers that select the same row issue exactly one platform send", async () => {
    const db = new Database(":memory:");
    initSchema(db, 768);
    seedRow(db, "one", "single effect", "pending");
    const eventBus = createMockEventBus() as unknown as TypedEventBus;
    const queue = makeBarrierQueue(createSqliteDeliveryQueue(db, eventBus));
    const adapter: DeliveryAdapter = {
      channelId: "telegram-test",
      channelType: "telegram",
      sendMessage: vi.fn(async () => ok("platform-message")),
    };
    const deps = {
      deliveryQueue: queue,
      channelAdapters: new Map([["telegram", adapter]]),
      eventBus,
      logger: createMockLogger(),
      drainBudgetMs: 60_000,
      defaultMaxAttempts: 5,
    };

    await Promise.all([drainDeliveryQueue(deps), drainDeliveryQueue(deps)]);

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    const row = db
      .prepare("SELECT status FROM delivery_queue WHERE id = 'one'")
      .get() as { status: string };
    expect(row.status).toBe("delivered");
    db.close();
  });

  it("an ambiguous platform error is parked and cannot be drained a second time", async () => {
    const db = new Database(":memory:");
    initSchema(db, 768);
    seedRow(db, "ambiguous", "effect may exist", "pending");
    const eventBus = createMockEventBus() as unknown as TypedEventBus;
    const queue = createSqliteDeliveryQueue(db, eventBus);
    const adapter: DeliveryAdapter = {
      channelId: "telegram-test",
      channelType: "telegram",
      sendMessage: vi.fn(async () => err(new Error("network response lost"))),
    };
    const deps = {
      deliveryQueue: queue,
      channelAdapters: new Map([["telegram", adapter]]),
      eventBus,
      logger: createMockLogger(),
      drainBudgetMs: 60_000,
      defaultMaxAttempts: 5,
    };

    await drainDeliveryQueue(deps);
    await drainDeliveryQueue(deps);

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    const row = db
      .prepare("SELECT status, last_error FROM delivery_queue WHERE id = 'ambiguous'")
      .get() as { status: string; last_error: string | null };
    expect(row).toEqual({
      status: "failed",
      last_error: AMBIGUOUS_SEND_OUTCOME_ERROR,
    });
    expect(eventBus.emit).toHaveBeenCalledWith("delivery:failed", {
      entryId: "ambiguous",
      channelId: "chat-a",
      channelType: "telegram",
      error: AMBIGUOUS_SEND_OUTCOME_ERROR,
      reason: "uncertain_outcome",
      timestamp: expect.any(Number),
    });
    db.close();
  });

  it("a thrown platform promise is translated into a parked uncertain result", async () => {
    const db = new Database(":memory:");
    initSchema(db, 768);
    seedRow(db, "thrown", "effect may exist", "pending");
    const eventBus = createMockEventBus() as unknown as TypedEventBus;
    const queue = createSqliteDeliveryQueue(db, eventBus);
    const adapter: DeliveryAdapter = {
      channelId: "telegram-test",
      channelType: "telegram",
      sendMessage: vi.fn(async () => {
        throw new Error("Bearer secret-value");
      }),
    };

    await expect(drainDeliveryQueue({
      deliveryQueue: queue,
      channelAdapters: new Map([["telegram", adapter]]),
      eventBus,
      logger: createMockLogger(),
      drainBudgetMs: 60_000,
      defaultMaxAttempts: 5,
    })).resolves.toEqual({ hadEntries: true });

    const row = db
      .prepare("SELECT status, last_error FROM delivery_queue WHERE id = 'thrown'")
      .get() as { status: string; last_error: string | null };
    expect(row).toEqual({
      status: "failed",
      last_error: AMBIGUOUS_SEND_OUTCOME_ERROR,
    });
    expect(JSON.stringify(eventBus.emit.mock.calls)).not.toContain("secret-value");
    db.close();
  });

  it("an acknowledgement failure parks the row without claiming a delivered queue outcome", async () => {
    const db = new Database(":memory:");
    initSchema(db, 768);
    seedRow(db, "ack-failed", "platform accepted", "pending");
    const eventBus = createMockEventBus() as unknown as TypedEventBus;
    const realQueue = createSqliteDeliveryQueue(db, eventBus);
    const queue: DeliveryQueuePort = {
      ...realQueue,
      ack: vi.fn(async () => err(new Error("Bearer secret-value"))),
    };
    const adapter: DeliveryAdapter = {
      channelId: "telegram-test",
      channelType: "telegram",
      sendMessage: vi.fn(async () => ok("platform-receipt")),
    };

    await drainDeliveryQueue({
      deliveryQueue: queue,
      channelAdapters: new Map([["telegram", adapter]]),
      eventBus,
      logger: createMockLogger(),
      drainBudgetMs: 60_000,
      defaultMaxAttempts: 5,
    });

    const row = db
      .prepare("SELECT status, last_error FROM delivery_queue WHERE id = 'ack-failed'")
      .get() as { status: string; last_error: string | null };
    expect(row).toEqual({
      status: "failed",
      last_error: AMBIGUOUS_SEND_OUTCOME_ERROR,
    });
    expect(eventBus.emit).not.toHaveBeenCalledWith("delivery:acked", expect.anything());
    expect(eventBus.emit).toHaveBeenCalledWith("delivery:queue_drained", expect.objectContaining({
      entriesDelivered: 0,
      entriesFailed: 1,
    }));
    expect(JSON.stringify(eventBus.emit.mock.calls)).not.toContain("secret-value");
    db.close();
  });

  it("a throwing notification subscriber cannot starve a later subscriber or the drain", async () => {
    const db = new Database(":memory:");
    initSchema(db, 768);
    seedRow(db, "notification", "notify once", "pending");
    db.prepare("UPDATE delivery_queue SET options_json = ? WHERE id = 'notification'")
      .run(JSON.stringify({ origin: "notification", agentId: "agent-a" }));
    const eventBus = new TypedEventBus();
    const laterListener = vi.fn();
    eventBus.on("notification:delivered", () => {
      throw new Error("subscriber failed");
    });
    eventBus.on("notification:delivered", laterListener);
    const queue = createSqliteDeliveryQueue(db, eventBus);
    const adapter: DeliveryAdapter = {
      channelId: "telegram-test",
      channelType: "telegram",
      sendMessage: vi.fn(async () => ok("platform-receipt")),
    };

    await expect(drainDeliveryQueue({
      deliveryQueue: queue,
      channelAdapters: new Map([["telegram", adapter]]),
      eventBus,
      logger: createMockLogger(),
      drainBudgetMs: 60_000,
      defaultMaxAttempts: 5,
    })).resolves.toEqual({ hadEntries: true });

    expect(laterListener).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT status FROM delivery_queue WHERE id = 'notification'")
      .get() as { status: string };
    expect(row.status).toBe("delivered");
    db.close();
  });
});
