// SPDX-License-Identifier: Apache-2.0
/**
 * Delivery subsystem wiring (queue + mirror).
 * Combines delivery queue (crash-safe queuing with drain and prune) and
 * delivery mirror (session mirroring with hook-based recording).
 * Queue two-phase lifecycle resolves the circular dependency between the
 * queue and channel adapters:
 *   1. setupDeliveryQueue() creates the adapter immediately (before setupChannels).
 *   2. drainAndStart() parks stale in_flight rows, runs startup drain, then starts
 *      both the recurring drain timer and the prune timer AFTER
 *      setupChannels populates channelAdapters.
 * Crash-Safe Delivery Queue.
 * Session Mirroring.
 * @module setup-delivery — Delivery subsystem wiring (queue + mirror)
 */

import type { AppConfig, TypedEventBus, DeliveryQueuePort, DeliveryMirrorPort, DeliveryAdapter } from "@comis/core";
import {
  createNoOpDeliveryQueue,
  createNoOpDeliveryMirror,
  isPermanentError,
  isSafeToRetrySendError,
  AMBIGUOUS_SEND_OUTCOME_ERROR,
  EXPLICIT_SEND_REJECTION_ERROR,
  RETRY_EXHAUSTED_SEND_ERROR,
  computeQueueBackoff,
  emitObservationalEventSafely,
  toSafeErrorLogString,
  systemNowMs,
  systemSetInterval,
  systemClearInterval,
} from "@comis/core";
import { createSqliteDeliveryQueue, createSqliteDeliveryMirror } from "@comis/memory";
import type { ComisLogger } from "@comis/infra";
import { err, fromPromise, ok, suppressError } from "@comis/shared";
import { createHash } from "node:crypto";
import type { PluginRegistry } from "@comis/core";

// ===========================================================================
// Delivery Queue
// ===========================================================================

const DELIVERY_ADAPTER_UNAVAILABLE_ERROR = "delivery adapter unavailable";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface DeliveryQueueResult {
  /** The delivery queue adapter (real or no-op), available immediately. */
  deliveryQueue: DeliveryQueuePort;
  /** Parks stale in_flight rows, runs startup drain, then starts the recurring drain + prune timers. Call AFTER setupChannels. */
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
  /**
   * Verified Learning: OPTIONAL outbound-message → trajectory
   * capture, threaded into every drain pass. `undefined` when learning-outcome is
   * disabled for all agents → the drain does ZERO extra work (byte-identity).
   */
  recordOutboundMessage?: (
    messageId: string,
    scope: { traceId: string; tenantId: string; agentId: string; sessionId: string; participantId?: string },
  ) => void;
}): Promise<DeliveryQueueResult> {
  const { db, config, eventBus, logger, channelAdapters, recordOutboundMessage } = deps;
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
  // Transition-gate state for the empty-drain log.
  // Without the gate, every recurring tick on an empty queue would emit
  // "Delivery queue drain: no pending entries" — dominating debug logs at
  // one line per drainIntervalMs (5–10s). The gate logs ONCE when the
  // queue transitions to empty; subsequent empty ticks are silent. Start
  // `true` so the first empty-after-startup tick still produces a line.
  let lastDrainHadPending = true;

  // Inner helper: one drain pass. Reused by startup drain AND each recurring tick.
  const runOneDrainPass = async (): Promise<void> => {
    const passResult = await drainDeliveryQueue({
      deliveryQueue,
      channelAdapters,
      eventBus,
      logger,
      drainBudgetMs: queueConfig.drainBudgetMs,
      defaultMaxAttempts: queueConfig.defaultMaxAttempts,
      recordOutboundMessage,
    });
    if (passResult.hadEntries) {
      lastDrainHadPending = true;
    } else if (lastDrainHadPending) {
      logger.debug("Delivery queue drain: transitioned to empty");
      lastDrainHadPending = false;
    }
  };

  // 2. Startup drain + recurring drain timer + prune timer (deferred until channelAdapters populated)
  const drainAndStart = async (): Promise<void> => {
    // A stale in-flight row may already exist on the platform. Park it before
    // any startup drain instead of converting uncertainty into a duplicate.
    const recoverResult = await deliveryQueue.recoverInFlight();
    if (!recoverResult.ok) {
      logger.warn(
        { hint: "Restore delivery queue storage and verify all in-flight platform effects manually before restarting", errorKind: "internal" as const },
        "Delivery queue: recoverInFlight failed",
      );
    } else if (recoverResult.value > 0) {
      logger.warn(
        {
          parked: recoverResult.value,
          hint: "Verify the parked platform effects manually; do not re-enqueue them without authoritative receipts",
          errorKind: "precondition" as const,
        },
        "Delivery queue parked interrupted in-flight rows",
      );
    }

    // --- Step 2: Startup drain (existing behavior, unchanged). ---
    if (queueConfig.drainOnStartup) {
      await runOneDrainPass();
    }

    // --- Step 3: Recurring drain timer. ---
    drainInterval = systemSetInterval(() => {
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
    pruneInterval = systemSetInterval(async () => {
      const startMs = systemNowMs();
      const result = await deliveryQueue.pruneExpired();
      if (result.ok && result.value > 0) {
        logger.debug(
          {
            pruned: result.value,
            class: "delivery_queue",
            durationMs: systemNowMs() - startMs,
          },
          "Delivery queue pruned",
        );
      }
    }, queueConfig.pruneIntervalMs);
    pruneInterval.unref();
  };

  const shutdown = (): void => {
    if (drainInterval) {
      systemClearInterval(drainInterval);
      drainInterval = undefined;
    }
    if (pruneInterval) {
      systemClearInterval(pruneInterval);
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
  /**
   * Verified Learning: capture (platform messageId →
   * trajectory scope) for an agent-authored OUTBOUND message so an inbound
   * reaction can resolve its trajectory. OPTIONAL — `undefined` when learning-
   * outcome is disabled for every agent (the byte-identity default → the drain
   * does ZERO extra work). Called ONLY on a successful ack with a non-null traceId.
   */
  recordOutboundMessage?: (
    messageId: string,
    scope: { traceId: string; tenantId: string; agentId: string; sessionId: string; participantId?: string },
  ) => void;
}): Promise<{ hadEntries: boolean }> {
  const { deliveryQueue, channelAdapters, eventBus, logger, drainBudgetMs, defaultMaxAttempts, recordOutboundMessage } = deps;
  const drainStart = systemNowMs();
  const deadline = drainStart + drainBudgetMs;

  const pendingResult = await deliveryQueue.pendingEntries();
  if (!pendingResult.ok) {
    logger.warn(
      { err: toSafeErrorLogString(pendingResult.error), hint: "Could not fetch pending entries for drain cycle", errorKind: "internal" as const },
      "Delivery queue drain: failed to fetch pending entries",
    );
    // Treat as "no entries observed" — runOneDrainPass uses this to gate
    // the transition log; a fetch failure does NOT count as "had pending".
    return { hadEntries: false };
  }

  const entries = pendingResult.value;
  if (entries.length === 0) {
    // The noisy "no pending entries" log lives in runOneDrainPass as a
    // transition-gated emit. Direct callers (the row-selection-invariant
    // unit test) just observe the return value.
    return { hadEntries: false };
  }

  let attempted = 0;
  let delivered = 0;
  let failed = 0;

  for (const entry of entries) {
    // Budget exhaustion check
    if (systemNowMs() > deadline) {
      logger.info(
        { budgetMs: drainBudgetMs, attempted, remaining: entries.length - attempted },
        "Delivery queue drain: budget exhausted",
      );
      break;
    }

    // pendingEntries() is only a snapshot. Compare-and-swap ownership before
    // touching the platform so concurrent drainers cannot send the same row.
    const claimResult = await deliveryQueue.claim(entry.id);
    if (!claimResult.ok) {
      logger.warn(
        {
          entryId: entry.id,
          channelType: entry.channelType,
          hint: "Restore delivery queue storage; the unclaimed row was not sent and remains pending",
          errorKind: "internal" as const,
        },
        "Delivery queue drain could not claim a pending row",
      );
      continue;
    }
    if (!claimResult.value) continue;

    attempted++;

    const adapter = channelAdapters.get(entry.channelType);
    if (!adapter) {
      const error = DELIVERY_ADAPTER_UNAVAILABLE_ERROR;
      const failResult = await deliveryQueue.fail(entry.id, error);
      if (failResult.ok) {
        emitObservationalEventSafely({ eventBus, logger }, "delivery:failed", {
          entryId: entry.id,
          channelId: entry.channelId,
          channelType: entry.channelType,
          error,
          reason: "permanent_error",
          timestamp: systemNowMs(),
        });
      }
      failed++;
      continue;
    }

    let options: Record<string, unknown> = {};
    try {
      options = JSON.parse(entry.optionsJson) as Record<string, unknown>;
    } catch {
      // Invalid JSON -- send without options
    }

    // Promise.resolve().then(...) captures both a synchronous SDK throw and a
    // rejected send promise at the platform boundary.
    const sendBoundary = await fromPromise(
      Promise.resolve().then(() => adapter.sendMessage(entry.channelId, entry.text, options)),
    );
    const sendResult = sendBoundary.ok ? sendBoundary.value : err(sendBoundary.error);

    if (sendResult.ok) {
      const ackResult = await deliveryQueue.ack(entry.id, sendResult.value);
      if (!ackResult.ok) {
        const parkResult = await deliveryQueue.fail(entry.id, AMBIGUOUS_SEND_OUTCOME_ERROR);
        if (parkResult.ok) {
          emitObservationalEventSafely({ eventBus, logger }, "delivery:failed", {
            entryId: entry.id,
            channelId: entry.channelId,
            channelType: entry.channelType,
            error: AMBIGUOUS_SEND_OUTCOME_ERROR,
            reason: "uncertain_outcome",
            timestamp: systemNowMs(),
          });
        }
        emitObservationalEventSafely({ eventBus, logger }, "delivery:queue_transition_failed", {
          deliveryId: entry.id,
          transition: "ack",
          errorKind: "dependency",
          channelId: entry.channelId,
          channelType: entry.channelType,
          timestamp: systemNowMs(),
        });
        logger.warn(
          {
            entryId: entry.id,
            channelType: entry.channelType,
            err: toSafeErrorLogString(ackResult.error),
            hint: "Verify the platform receipt manually; the queue parked this row and will not replay it",
            errorKind: "dependency" as const,
          },
          "Delivery queue could not persist a platform acknowledgement",
        );
        failed++;
        continue;
      }

      emitObservationalEventSafely({ eventBus, logger }, "delivery:acked", {
          entryId: entry.id,
          channelId: entry.channelId,
          channelType: entry.channelType,
          messageId: sendResult.value,
          durationMs: systemNowMs() - drainStart,
          timestamp: systemNowMs(),
      });
      delivered++;

      // Capture (platform messageId → trajectory scope) for
      // inbound-reaction resolution. Agent-authored OUTBOUND only (the delivery
      // queue is outbound); entry.traceId === trajectoryId and entry.agentId are
      // both persisted from the resolved delivery authority at enqueue. The
      // agentId is the load-bearing (tenant, agent) isolation partition the
      // reaction observe()s under — it must be the REAL agent, NEVER the tenantId.
      // A null traceId (no trajectory) OR an absent agentId (a pre-executor /
      // non-agent send) is a FAIL-CLOSED skip: mis-attributing a reaction to the
      // tenantId would corrupt cross-agent isolation, so we record
      // nothing rather than fall back. The callback is undefined when
      // learning-outcome is disabled for all agents → zero extra work (byte-identity).
      if (entry.traceId !== null && recordOutboundMessage !== undefined) {
        // Carry the conversation participant (the inbound sender) persisted
        // into optionsJson at enqueue (delivery-service.ts) so a reaction resolved
        // via this drain path is participant-aware — an unmapped group bystander
        // resolves to "external" (inert) and cannot spoof reaction-learning. Absent
        // on rows whose enqueue did not thread a participant → undefined → the trust
        // resolution fails safe to the defaultTrustLevel-for-unmapped behavior.
        const recordParticipantId = typeof options.participantId === "string" ? options.participantId : undefined;
        recordOutboundMessage(sendResult.value, {
          traceId: entry.traceId,
          tenantId: entry.tenantId,
          agentId: entry.agentId,
          sessionId: entry.traceId, // session identity falls back to the trajectory id (scope-consistent)
          participantId: recordParticipantId,
        });
      }

      // Emit notification:delivered for notification-origin entries
      if (options.origin === "notification") {
        emitObservationalEventSafely({ eventBus, logger }, "notification:delivered", {
          agentId: entry.agentId,
          channelType: entry.channelType,
          channelId: entry.channelId,
          messageId: sendResult.value,
          durationMs: 0, // Per-entry duration not tracked in drain; 0 is sentinel
          timestamp: systemNowMs(),
        });
      }
    } else {
      const maxAttempts = entry.maxAttempts || defaultMaxAttempts;
      if (isPermanentError(sendResult.error.message)) {
        const error = EXPLICIT_SEND_REJECTION_ERROR;
        const failResult = await deliveryQueue.fail(entry.id, error);
        if (failResult.ok) {
          emitObservationalEventSafely({ eventBus, logger }, "delivery:failed", {
            entryId: entry.id,
            channelId: entry.channelId,
            channelType: entry.channelType,
            error,
            reason: "permanent_error",
            timestamp: systemNowMs(),
          });
        }
        failed++;
      } else if (!isSafeToRetrySendError(sendResult.error)) {
        const failResult = await deliveryQueue.fail(entry.id, AMBIGUOUS_SEND_OUTCOME_ERROR);
        if (failResult.ok) {
          emitObservationalEventSafely({ eventBus, logger }, "delivery:failed", {
            entryId: entry.id,
            channelId: entry.channelId,
            channelType: entry.channelType,
            error: AMBIGUOUS_SEND_OUTCOME_ERROR,
            reason: "uncertain_outcome",
            timestamp: systemNowMs(),
          });
        }
        logger.warn(
          {
            entryId: entry.id,
            channelType: entry.channelType,
            hint: "Verify the platform effect manually; the queue parked this row and will not replay it",
            errorKind: "platform" as const,
          },
          "Delivery queue parked a send with an uncertain platform outcome",
        );
        failed++;
      } else if (entry.attemptCount + 1 >= maxAttempts) {
        const error = RETRY_EXHAUSTED_SEND_ERROR;
        const failResult = await deliveryQueue.fail(entry.id, error);
        if (failResult.ok) {
          emitObservationalEventSafely({ eventBus, logger }, "delivery:failed", {
            entryId: entry.id,
            channelId: entry.channelId,
            channelType: entry.channelType,
            error,
            reason: "retries_exhausted",
            timestamp: systemNowMs(),
          });
        }
        failed++;
      } else {
        const nextRetryAt = systemNowMs() + computeQueueBackoff(entry.attemptCount);
        const error = EXPLICIT_SEND_REJECTION_ERROR;
        const nackResult = await deliveryQueue.nack(entry.id, error, nextRetryAt);
        if (nackResult.ok) {
          emitObservationalEventSafely({ eventBus, logger }, "delivery:nacked", {
            entryId: entry.id,
            channelId: entry.channelId,
            channelType: entry.channelType,
            error,
            attemptCount: entry.attemptCount + 1,
            nextRetryAt,
            timestamp: systemNowMs(),
          });
        }
        failed++;
      }
    }
  }

  const durationMs = systemNowMs() - drainStart;

  emitObservationalEventSafely({ eventBus, logger }, "delivery:queue_drained", {
    entriesAttempted: attempted,
    entriesDelivered: delivered,
    entriesFailed: failed,
    durationMs,
    timestamp: systemNowMs(),
  });

  logger.info(
    { entriesAttempted: attempted, entriesDelivered: delivered, entriesFailed: failed, durationMs },
    "Delivery queue drained",
  );

  return { hadEntries: true };
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
        if (ctx.deliveryAuthority === undefined || ctx.destinationEndpoint === undefined) {
          logger.warn(
            {
              channelType: event.channelType,
              hint: "Ensure every delivery originates from a resolved turn or an explicit internal authority boundary",
              errorKind: "precondition" as const,
            },
            "Delivery mirror record omitted because authority is unavailable",
          );
          return;
        }
        const now = systemNowMs();
        const idempotencyKey = computeIdempotencyKey(
          ctx.deliveryAuthority.conversationRef,
          event.text,
          now,
        );
        const result = await deliveryMirror.record({
          tenantId: ctx.deliveryAuthority.tenantId,
          agentId: ctx.deliveryAuthority.agentId,
          conversationRef: ctx.deliveryAuthority.conversationRef,
          destinationEndpoint: ctx.destinationEndpoint,
          text: event.text,
          mediaUrls: [],  // HookAfterDeliveryEvent has no mediaUrls field; media URL mirroring deferred
          channelType: event.channelType,
          channelId: event.channelId,
          origin: event.origin,
          idempotencyKey,
        });
        if (result.ok) {
          logger.debug({
            conversationRef: ctx.deliveryAuthority.conversationRef,
            channelType: event.channelType,
            idempotencyKey,
          }, "Mirror entry recorded");
        }
        // Recording failures are silently tolerated (fire-and-forget hook)
      });
      return ok(undefined);
    },
  });

  // 3. Prune timer
  let pruneInterval: ReturnType<typeof setInterval> | undefined;
  const startPrune = (): void => {
    pruneInterval = systemSetInterval(async () => {
      const result = await deliveryMirror.pruneOld(mirrorConfig.retentionMs);
      if (result.ok && result.value > 0) {
        logger.debug({ pruned: result.value }, "Delivery mirror pruned");
      }
    }, mirrorConfig.pruneIntervalMs);
    pruneInterval.unref();
  };
  const shutdown = (): void => {
    if (pruneInterval) {
      systemClearInterval(pruneInterval);
      pruneInterval = undefined;
    }
  };

  return { deliveryMirror, startPrune, shutdown };
}
