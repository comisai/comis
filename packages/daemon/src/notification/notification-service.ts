// SPDX-License-Identifier: Apache-2.0
/**
 * Notification service: central notifyUser() with full guard pipeline.
 * Guard order: config check -> channel resolve -> quiet hours -> rate limit -> dedup -> enqueue.
 * Both the agent tool and internal callers (heartbeat, background tasks)
 * route through this service. All spam protection and delivery logic lives here.
 * @module
 */
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { TypedEventBus, DeliveryQueuePort, DeliveryQueueEnqueueInput, NotificationConfig } from "@comis/core";
import { isInQuietHours, parseTimeToMinutes, getCurrentMinutesInTimezone, createDuplicateDetector } from "@comis/scheduler";
import type { QuietHoursConfig } from "@comis/scheduler";
import { createRateLimiter } from "./rate-limiter.js";
import type { RateLimiter } from "./rate-limiter.js";
import { resolveNotificationChannel } from "./channel-resolver.js";
import type { ChannelResolverDeps } from "./channel-resolver.js";

/** Options for a single notification call. */
export interface NotifyUserOptions {
  agentId: string;
  message: string;
  priority?: "low" | "normal" | "high" | "critical";
  channelType?: string;
  channelId?: string;
  origin?: string;
}

/** Dependencies injected into the notification service factory. */
export interface NotificationServiceDeps {
  eventBus: Pick<TypedEventBus, "emit">;
  deliveryQueue: DeliveryQueuePort;
  quietHoursConfig: QuietHoursConfig;
  criticalBypass: boolean;
  notificationConfigs: ReadonlyMap<string, NotificationConfig>;
  defaultConfig: NotificationConfig;
  channelResolverDeps: ChannelResolverDeps;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  nowMs?: () => number;
  tenantId: string;
}

/** The notification service interface returned by the factory. */
export interface NotificationService {
  notifyUser(opts: NotifyUserOptions): Promise<Result<string, Error>>;
}

/** One hour in milliseconds, used for notification expiry TTL. */
const HOUR_MS = 3_600_000;

/**
 * Compute the next occurrence of quiet hours end time as epoch ms.
 * If the current time is within quiet hours, this calculates when quiet hours
 * end (either later today or tomorrow, depending on overnight wrap).
 */
function computeQuietHoursEndMs(config: QuietHoursConfig, nowMs: number): number {
  const endMinutes = parseTimeToMinutes(config.end);
  const currentMinutes = getCurrentMinutesInTimezone(nowMs, config.timezone);

  // How many minutes until quiet hours end
  let minutesUntilEnd: number;
  if (currentMinutes < endMinutes) {
    // End time is later today
    minutesUntilEnd = endMinutes - currentMinutes;
  } else {
    // End time is tomorrow (overnight window or we're past end today)
    minutesUntilEnd = (24 * 60 - currentMinutes) + endMinutes;
  }

  return nowMs + minutesUntilEnd * 60_000;
}

/**
 * Create a notification service with the full guard pipeline.
 * Internally creates a RateLimiter and DuplicateDetector using the default config.
 * Per-agent configs are looked up at call time for the enabled/maxChainDepth checks.
 * @param deps - Service dependencies (event bus, delivery queue, configs, etc.)
 * @returns NotificationService with a single `notifyUser()` method
 */
export function createNotificationService(deps: NotificationServiceDeps): NotificationService {
  const getNow = deps.nowMs ?? Date.now;

  const rateLimiter: RateLimiter = createRateLimiter({
    maxPerHour: deps.defaultConfig.maxPerHour,
    nowMs: deps.nowMs,
  });

  const dedupDetector = createDuplicateDetector({
    ttlMs: deps.defaultConfig.dedupeWindowMs,
    nowMs: deps.nowMs,
  });

  return {
    async notifyUser(opts: NotifyUserOptions): Promise<Result<string, Error>> {
      const now = getNow();
      const priority = opts.priority ?? "normal";
      const origin = opts.origin ?? "notification";

      // Step 1: Get agent's notification config
      const config = deps.notificationConfigs.get(opts.agentId) ?? deps.defaultConfig;

      // Step 2: Check enabled
      if (!config.enabled) {
        return err(new Error("Notifications disabled for agent"));
      }

      // Step 3: Resolve channel
      const channelResult = resolveNotificationChannel(deps.channelResolverDeps, {
        agentId: opts.agentId,
        channelType: opts.channelType,
        channelId: opts.channelId,
        primaryChannel: config.primaryChannel,
      });

      if (!channelResult.ok) {
        deps.eventBus.emit("notification:suppressed", {
          agentId: opts.agentId,
          reason: "no_channel",
          priority,
          timestamp: now,
        });
        deps.logger.warn(
          { agentId: opts.agentId, attempted: channelResult.error.attempted },
          "Notification suppressed: no channel resolved",
        );
        return err(new Error("No channel resolved for notification delivery"));
      }

      const { channelType, channelId } = channelResult.value;

      // Step 4: Check quiet hours
      let scheduledAt = now;
      const inQuietHours = isInQuietHours(deps.quietHoursConfig, now);

      if (inQuietHours) {
        const isCriticalBypass = priority === "critical" && deps.criticalBypass;

        if (!isCriticalBypass) {
          // Defer delivery to quiet hours end
          scheduledAt = computeQuietHoursEndMs(deps.quietHoursConfig, now);
          deps.eventBus.emit("notification:suppressed", {
            agentId: opts.agentId,
            reason: "quiet_hours",
            priority,
            timestamp: now,
          });
          deps.logger.info(
            { agentId: opts.agentId, scheduledAt, channelType },
            "Notification deferred to quiet hours end",
          );
        }
      }

      // Step 5: Rate limiting (skip for deferred -- they'll be rate-checked at delivery)
      if (scheduledAt === now) {
        if (!rateLimiter.tryAcquire(opts.agentId)) {
          deps.eventBus.emit("notification:suppressed", {
            agentId: opts.agentId,
            reason: "rate_limited",
            priority,
            timestamp: now,
          });
          deps.logger.warn(
            { agentId: opts.agentId },
            "Notification suppressed: rate limit exceeded",
          );
          return err(new Error("Rate limit exceeded for agent notifications"));
        }
      }

      // Step 6: Deduplication
      const dedupKey = `${opts.agentId}\0${channelType}\0${channelId}`;
      if (dedupDetector.isDuplicate(dedupKey, opts.message)) {
        deps.eventBus.emit("notification:suppressed", {
          agentId: opts.agentId,
          reason: "duplicate",
          priority,
          timestamp: now,
        });
        deps.logger.info(
          { agentId: opts.agentId, channelType, channelId },
          "Notification suppressed: duplicate message within dedup window",
        );
        return err(new Error("Duplicate notification suppressed"));
      }

      // Step 7: Emit enqueued event (only for non-deferred, or if we still want to track deferred)
      if (scheduledAt === now) {
        deps.eventBus.emit("notification:enqueued", {
          agentId: opts.agentId,
          priority,
          channelType,
          channelId,
          origin,
          timestamp: now,
        });
      }

      // Step 8: Enqueue to delivery queue
      const entry: DeliveryQueueEnqueueInput = {
        text: opts.message,
        channelType,
        channelId,
        tenantId: deps.tenantId,
        origin,
        formatApplied: false,
        chunkingApplied: false,
        maxAttempts: 3,
        createdAt: now,
        scheduledAt,
        expireAt: now + HOUR_MS,
        optionsJson: JSON.stringify({ origin: "notification", chainDepth: config.maxChainDepth }),
        traceId: null,
      };

      const enqueueResult = await deps.deliveryQueue.enqueue(entry);
      if (!enqueueResult.ok) {
        return err(enqueueResult.error);
      }

      // Step 9: Return entry ID
      return ok(enqueueResult.value);
    },
  };
}
