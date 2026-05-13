// SPDX-License-Identifier: Apache-2.0
/**
 * Delivery subsystem wiring (queue + mirror).
 * Combines delivery queue (crash-safe queuing with drain and prune) and
 * delivery mirror (session mirroring with hook-based recording).
 * Queue two-phase lifecycle resolves the circular dependency between the
 * queue and channel adapters:
 *   1. setupDeliveryQueue() creates the adapter immediately (before setupChannels).
 *   2. drainAndStart() recovers in_flight rows, runs startup drain, then starts
 *      both the recurring drain timer and the prune timer AFTER
 *      setupChannels populates channelAdapters.
 * Crash-Safe Delivery Queue.
 * Session Mirroring.
 * @module setup-delivery — Delivery subsystem wiring (queue + mirror)
 */

import type { AppConfig, TypedEventBus, DeliveryQueuePort, DeliveryMirrorPort, DeliveryAdapter } from "@comis/core";
import { createNoOpDeliveryQueue, createNoOpDeliveryMirror, isPermanentError, computeQueueBackoff } from "@comis/core";
import { createSqliteDeliveryQueue, createSqliteDeliveryMirror } from "@comis/memory";
import type { ComisLogger } from "@comis/infra";
import { ok, suppressError } from "@comis/shared";
import { createHash } from "node:crypto";
import type { PluginRegistry } from "@comis/core";

// ===========================================================================
// Delivery Queue
// ===========================================================================

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface DeliveryQueueResult {
  /** The delivery queue adapter (real or no-op), available immediately. */
  deliveryQueue: DeliveryQueuePort;
  /** Recovers in_flight rows, runs startup drain, then starts the recurring drain + prune timers. Call AFTER setupChannels. */
  drainAndStart: () => Promise<void>;
  /** Clears the recurring drain interval AND the prune interval (call on shutdown). */
  shutdown: () => void;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

export async function setupDeliveryQueue(deps: {
  /** Raw better-sqlite3 database handle (typed as unknown to avoid cross-package type dep). */
  db: unknown;
  config: AppConfig;
  eventBus: TypedEventBus;
  logger: ComisLogger;
  channelAdapters: Map<string, DeliveryAdapter>;
}): Promise<DeliveryQueueResult> {
  const { db, config, eventBus, logger, channelAdapters } = deps;
  const queueConfig = config.deliveryQueue;

  // 1. Adapter creation: no-op when disabled
  if (!queueConfig.enabled) {
    logger.debug("Delivery queue disabled by config");
    return {
      deliveryQueue: createNoOpDeliveryQueue(),
      drainAndStart: async () => {},
      shutdown: () => {},
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- db is better-sqlite3 Database; typed as unknown to avoid cross-package type dependency
  const deliveryQueue = createSqliteDeliveryQueue(db as any, eventBus);
  logger.info(
    { maxQueueDepth: queueConfig.maxQueueDepth, defaultMaxAttempts: queueConfig.defaultMaxAttempts },
    "Delivery queue enabled",
  );

  let pruneInterval: ReturnType<typeof setInterval> | undefined;
  let drainInterval: ReturnType<typeof setInterval> | undefined;
  // Single-tick gate: in-flight Promise prevents overlapping ticks.
  let draining: Promise<void> | null = null;

  // Inner helper: one drain pass. Reused by startup drain AND each recurring tick.
  const runOneDrainPass = async (): Promise<void> => {
    await drainDeliveryQueue({
      deliveryQueue,
      channelAdapters,
      eventBus,
      logger,
      drainBudgetMs: queueConfig.drainBudgetMs,
      defaultMaxAttempts: queueConfig.defaultMaxAttempts,
    });
  };

  // 2. Startup drain + recurring drain timer + prune timer (deferred until channelAdapters populated)
  const drainAndStart = async (): Promise<void> => {
    // --- Step 1: Recover in_flight rows. ---
    // Runs UNCONDITIONALLY -- independent of drainOnStartup policy. An 'in_flight'
    // row from a prior crash is a correctness bug regardless of the drain policy.
    const recoverResult = await deliveryQueue.recoverInFlight();
    if (!recoverResult.ok) {
      logger.warn(
        { err: recoverResult.error, hint: "Could not recover in_flight rows on startup; messages may stall until next restart", errorKind: "internal" as const },
        "Delivery queue: recoverInFlight failed",
      );
    } else if (recoverResult.value > 0) {
      logger.info({ recovered: recoverResult.value }, "Delivery queue: recovered in_flight rows to pending");
    }

    // --- Step 2: Startup drain (existing behavior, unchanged). ---
    if (queueConfig.drainOnStartup) {
      await runOneDrainPass();
    }

    // --- Step 3: Recurring drain timer. ---
    drainInterval = setInterval(() => {
      if (draining) return;                          // single-tick gate
      draining = runOneDrainPass().finally(() => { draining = null; });
      // Fire-and-forget: failures inside drainDeliveryQueue are already logged
      // and do not propagate (it never throws). suppressError satisfies the
      // no-floating-promise lint without altering semantics.
      suppressError(draining, "delivery queue recurring drain tick");
    }, queueConfig.drainIntervalMs);
    drainInterval.unref();

    // --- Step 4: Prune timer. ---
    // Emit a per-class drain log line with structured fields
    // (`pruned`, `class`, `durationMs`) so operators can correlate prune
    // activity by retention class across subsystems (delivery_queue,
    // delivery_mirror, output retention housekeeper, etc.). The `class`
    // field is a placeholder until the underlying pruneExpired() is
    // extended with per-class breakdown. Canonical Pino object-first;
    // durationMs is the canonical name (CLAUDE.md logging conventions).
    pruneInterval = setInterval(async () => {
      const startMs = Date.now();
      const result = await deliveryQueue.pruneExpired();
      if (result.ok && result.value > 0) {
        logger.debug(
          {
            pruned: result.value,
            class: "delivery_queue",
            durationMs: Date.now() - startMs,
          },
          "Delivery queue pruned",
        );
      }
    }, queueConfig.pruneIntervalMs);
    pruneInterval.unref();
  };

  const shutdown = (): void => {
    if (drainInterval) {
      clearInterval(drainInterval);
      drainInterval = undefined;
    }
    if (pruneInterval) {
      clearInterval(pruneInterval);
      pruneInterval = undefined;
    }
  };

  return { deliveryQueue, drainAndStart, shutdown };
}

// ---------------------------------------------------------------------------
// Drain implementation
// ---------------------------------------------------------------------------

export async function drainDeliveryQueue(deps: {
  deliveryQueue: DeliveryQueuePort;
  channelAdapters: Map<string, DeliveryAdapter>;
  eventBus: TypedEventBus;
  logger: ComisLogger;
  drainBudgetMs: number;
  defaultMaxAttempts: number;
}): Promise<void> {
  const { deliveryQueue, channelAdapters, eventBus, logger, drainBudgetMs, defaultMaxAttempts } = deps;
  const drainStart = Date.now();
  const deadline = drainStart + drainBudgetMs;

  const pendingResult = await deliveryQueue.pendingEntries();
  if (!pendingResult.ok) {
    logger.warn(
      { err: pendingResult.error, hint: "Could not fetch pending entries for drain cycle", errorKind: "internal" as const },
      "Delivery queue drain: failed to fetch pending entries",
    );
    return;
  }

  const entries = pendingResult.value;
  if (entries.length === 0) {
    logger.debug("Delivery queue drain: no pending entries");
    return;
  }

  let attempted = 0;
  let delivered = 0;
  let failed = 0;

  for (const entry of entries) {
    // Budget exhaustion check
    if (Date.now() > deadline) {
      logger.info(
        { budgetMs: drainBudgetMs, attempted, remaining: entries.length - attempted },
        "Delivery queue drain: budget exhausted",
      );
      break;
    }

    attempted++;

    const adapter = channelAdapters.get(entry.channelType);
    if (!adapter) {
      await deliveryQueue.fail(entry.id, `No adapter for channel type: ${entry.channelType}`);
      failed++;
      continue;
    }

    let options: Record<string, unknown> = {};
    try {
      options = JSON.parse(entry.optionsJson) as Record<string, unknown>;
    } catch {
      // Invalid JSON -- send without options
    }

    const sendResult = await adapter.sendMessage(entry.channelId, entry.text, options);

    if (sendResult.ok) {
      await deliveryQueue.ack(entry.id, sendResult.value);
      delivered++;

      // Emit notification:delivered for notification-origin entries
      if (options.origin === "notification") {
        eventBus.emit("notification:delivered", {
          agentId: (options.agentId as string) ?? entry.tenantId ?? "unknown",
          channelType: entry.channelType,
          channelId: entry.channelId,
          messageId: sendResult.value,
          durationMs: 0, // Per-entry duration not tracked in drain; 0 is sentinel
          timestamp: Date.now(),
        });
      }
    } else {
      const errorMsg = sendResult.error.message;

      if (isPermanentError(errorMsg) || entry.attemptCount >= (entry.maxAttempts || defaultMaxAttempts)) {
        await deliveryQueue.fail(entry.id, errorMsg);
        failed++;
      } else {
        const nextRetryAt = Date.now() + computeQueueBackoff(entry.attemptCount);
        await deliveryQueue.nack(entry.id, errorMsg, nextRetryAt);
        failed++;
      }
    }
  }

  const durationMs = Date.now() - drainStart;

  eventBus.emit("delivery:queue_drained", {
    entriesAttempted: attempted,
    entriesDelivered: delivered,
    entriesFailed: failed,
    durationMs,
    timestamp: Date.now(),
  });

  logger.info(
    { entriesAttempted: attempted, entriesDelivered: delivered, entriesFailed: failed, durationMs },
    "Delivery queue drained",
  );
}

// ===========================================================================
// Delivery Mirror
// ===========================================================================

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface DeliveryMirrorResult {
  /** The delivery mirror adapter (real or no-op), available immediately. */
  deliveryMirror: DeliveryMirrorPort;
  /** Starts the periodic prune timer. Call AFTER setupChannels. */
  startPrune: () => void;
  /** Clears the prune interval timer (call on shutdown). */
  shutdown: () => void;
}

// ---------------------------------------------------------------------------
// Idempotency key computation
// ---------------------------------------------------------------------------

/**
 * Compute an idempotency key for a mirror entry.
 * Uses session key + text hash + 1-second time bucket to deduplicate
 * repeated deliveries of the same text within the same second.
 */
function computeIdempotencyKey(sessionKey: string, text: string, timestamp: number): string {
  const textHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const bucket = Math.floor(timestamp / 1000);
  return `${sessionKey}:${textHash}:${bucket}`;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

export async function setupDeliveryMirror(deps: {
  /** Raw better-sqlite3 database handle (typed as unknown to avoid cross-package type dep). */
  db: unknown;
  config: AppConfig;
  pluginRegistry: PluginRegistry;
  logger: ComisLogger;
}): Promise<DeliveryMirrorResult> {
  const { db, config, pluginRegistry, logger } = deps;
  const mirrorConfig = config.deliveryMirror;

  // 1. No-op when disabled
  if (!mirrorConfig?.enabled) {
    logger.debug("Delivery mirror disabled by config");
    return {
      deliveryMirror: createNoOpDeliveryMirror(),
      startPrune: () => {},
      shutdown: () => {},
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- db is better-sqlite3 Database; typed as unknown to avoid cross-package type dependency
  const deliveryMirror = createSqliteDeliveryMirror(db as any);
  logger.info(
    { retentionMs: mirrorConfig.retentionMs, maxEntriesPerInjection: mirrorConfig.maxEntriesPerInjection, maxCharsPerInjection: mirrorConfig.maxCharsPerInjection },
    "Delivery mirror enabled",
  );

  // 2. Hook registration: record delivered text via after_delivery hook
  pluginRegistry.register({
    id: "comis:delivery-mirror",
    name: "Delivery Mirror",
    version: "1.0.0",
    register(api) {
      api.registerHook("after_delivery", async (event, ctx) => {
        if (!ctx.sessionKey) return; // No session context -- skip
        const now = Date.now();
        const idempotencyKey = computeIdempotencyKey(ctx.sessionKey, event.text, now);
        const result = await deliveryMirror.record({
          sessionKey: ctx.sessionKey,
          text: event.text,
          mediaUrls: [],  // HookAfterDeliveryEvent has no mediaUrls field; media URL mirroring deferred
          channelType: event.channelType,
          channelId: event.channelId,
          origin: event.origin,
          idempotencyKey,
        });
        if (result.ok) {
          logger.debug({ sessionKey: ctx.sessionKey, channelType: event.channelType, idempotencyKey }, "Mirror entry recorded");
        }
        // Recording failures are silently tolerated (fire-and-forget hook)
      });
      return ok(undefined);
    },
  });

  // 3. Prune timer
  let pruneInterval: ReturnType<typeof setInterval> | undefined;
  const startPrune = (): void => {
    pruneInterval = setInterval(async () => {
      const result = await deliveryMirror.pruneOld(mirrorConfig.retentionMs);
      if (result.ok && result.value > 0) {
        logger.debug({ pruned: result.value }, "Delivery mirror pruned");
      }
    }, mirrorConfig.pruneIntervalMs);
    pruneInterval.unref();
  };
  const shutdown = (): void => {
    if (pruneInterval) {
      clearInterval(pruneInterval);
      pruneInterval = undefined;
    }
  };

  return { deliveryMirror, startPrune, shutdown };
}
