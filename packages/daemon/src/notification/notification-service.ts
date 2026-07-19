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
import type {
  ChannelEndpoint,
  DeliveryAuthority,
  DeliveryQueueEnqueueInput,
  DeliveryQueuePort,
  NotificationConfig,
  TypedEventBus,
} from "@comis/core";
import { createConversationRef } from "@comis/core";
import { resolveInternalTurnIdentity } from "@comis/orchestrator";
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
  /** Explicit authority minted by the originating turn or internal boundary. */
  authority?: DeliveryAuthority;
  /** Exact immutable outbound destination. */
  destinationEndpoint?: ChannelEndpoint;
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
  /** The tenant every minted notification authority is bound to. */
  tenantId: string;
  /**
   * Resolve a channel type to its registered adapter's instance id
   * (`ChannelPort.channelId`) — the same identity ingress stamps as
   * `channelInstanceId`, so an outbound destination endpoint stays injective and
   * consistent with the inbound turn. Returns undefined when no adapter is
   * registered for the type (the mint falls back to the resolved channel id).
   */
  resolveChannelInstanceId: (channelType: string) => string | undefined;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  nowMs?: () => number;
}

/** A minted notification destination: the authority triple + the exact endpoint. */
export interface NotificationDestination {
  authority: DeliveryAuthority;
  destinationEndpoint: ChannelEndpoint;
}

/** The dependency slice {@link resolveNotificationDestination} needs. */
export interface NotificationDestinationDeps {
  channelResolverDeps: ChannelResolverDeps;
  notificationConfigs: ReadonlyMap<string, NotificationConfig>;
  defaultConfig: NotificationConfig;
  resolveChannelInstanceId: (channelType: string) => string | undefined;
}

/** Selector for {@link resolveNotificationDestination}. */
export interface NotificationDestinationOpts {
  tenantId: string;
  agentId: string;
  channelType?: string;
  channelId?: string;
}

/** The notification service interface returned by the factory. */
export interface NotificationService {
  notifyUser(opts: NotifyUserOptions): Promise<Result<string, Error>>;
  /**
   * Mint the {@link DeliveryAuthority} + destination endpoint an internal
   * boundary (RPC handler, background task) must pass into {@link notifyUser}.
   * Runs the SAME channel-resolution chain notifyUser cross-checks at send
   * time, so the minted claim always matches the live resolution.
   */
  resolveDestination(opts: { agentId: string; channelType?: string; channelId?: string }): Result<NotificationDestination, Error>;
}

/**
 * Mint a notification destination (authority + endpoint) for a context-less
 * caller. Runs the explicit → platform-match → primaryChannel → recent-session
 * resolution chain (via {@link resolveNotificationChannel}) exactly as
 * `notifyUser` does, then:
 *
 *   - destinationEndpoint carries the REAL destination: the resolved
 *     (channelType, channelId) with the resolved adapter's instance id as
 *     `channelInstanceId` — the same identity ingress stamps — so outbound and
 *     inbound stay injective/consistent.
 *   - authority is minted through the CANONICAL internal-boundary mechanism
 *     ({@link resolveInternalTurnIdentity}, `originKind: "control-plane"`) the
 *     schedulers/heartbeat/durable-resume paths use. It is deliberately NOT the
 *     user's ingress conversation: the delivery row is authorized by the daemon's
 *     notification boundary, while destinationEndpoint names where it goes. It is
 *     deterministic per (tenant, agent, destination).
 *
 * Returns the resolver's err (no channel) unchanged so the caller can surface it
 * verbatim. `notifyUser` re-runs the resolution and cross-checks the minted
 * endpoint at send time, so config drift between mint and send surfaces there.
 */
export function resolveNotificationDestination(
  deps: NotificationDestinationDeps,
  opts: NotificationDestinationOpts,
): Result<NotificationDestination, Error> {
  const config = deps.notificationConfigs.get(opts.agentId) ?? deps.defaultConfig;
  const channelResult = resolveNotificationChannel(deps.channelResolverDeps, {
    agentId: opts.agentId,
    channelType: opts.channelType,
    channelId: opts.channelId,
    primaryChannel: config.primaryChannel,
  });
  if (!channelResult.ok) {
    return err(
      new Error(
        `No channel resolved for notification delivery (tried: ${channelResult.error.attempted.join(" -> ")}). ` +
          "Pass channel_type + channel_id explicitly, set the agent's notification.primaryChannel in config, " +
          "or notify after the agent has a recent channel session.",
      ),
    );
  }
  const { channelType, channelId } = channelResult.value;
  const destinationEndpoint: ChannelEndpoint = {
    channelType,
    // The resolved adapter's instance identity (matches ingress); fall back to
    // the resolved channel id when no adapter is registered for the type.
    channelInstanceId: deps.resolveChannelInstanceId(channelType) ?? channelId,
    conversationId: channelId,
    conversationKind: "direct",
  };
  const identity = resolveInternalTurnIdentity({
    tenantId: opts.tenantId,
    agentId: opts.agentId,
    originKind: "control-plane",
    instanceId: "notification",
    conversationId: `${channelType}:${channelId}`,
    principalId: `notification-${opts.agentId}`,
  });
  if (!identity.ok) {
    return err(new Error(`Notification authority mint failed: ${identity.error.message}`));
  }
  const reference = createConversationRef(identity.value.turnScope.conversation);
  if (!reference.ok) {
    return err(new Error("Notification authority conversation reference generation failed"));
  }
  return ok({
    authority: { tenantId: opts.tenantId, agentId: opts.agentId, conversationRef: reference.value },
    destinationEndpoint,
  });
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
    // Resolve the ceiling PER-AGENT from the agent's own notification config
    // (schema-notification `maxPerHour`), falling back to the default. The
    // limiter is keyed per-agent (tryAcquire(agentId)), so the ceiling MUST be
    // resolved per-agent here — baking in only defaultConfig.maxPerHour would
    // silently ignore a configured per-agent ceiling.
    maxPerHour: (agentId) =>
      (deps.notificationConfigs.get(agentId) ?? deps.defaultConfig).maxPerHour,
    nowMs: deps.nowMs,
  });

  const dedupDetector = createDuplicateDetector({
    ttlMs: deps.defaultConfig.dedupeWindowMs,
    nowMs: deps.nowMs,
  });

  return {
    resolveDestination(opts: { agentId: string; channelType?: string; channelId?: string }): Result<NotificationDestination, Error> {
      return resolveNotificationDestination(
        {
          channelResolverDeps: deps.channelResolverDeps,
          notificationConfigs: deps.notificationConfigs,
          defaultConfig: deps.defaultConfig,
          resolveChannelInstanceId: deps.resolveChannelInstanceId,
        },
        { tenantId: deps.tenantId, agentId: opts.agentId, channelType: opts.channelType, channelId: opts.channelId },
      );
    },
    async notifyUser(opts: NotifyUserOptions): Promise<Result<string, Error>> {
      const now = getNow();
      const priority = opts.priority ?? "normal";
      const origin = opts.origin ?? "notification";
      if (
        opts.authority === undefined
        || opts.destinationEndpoint === undefined
        || opts.authority.agentId !== opts.agentId
      ) {
        return err(new Error("Notification delivery requires explicit matching authority and destination endpoint"));
      }

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
        return err(
          new Error(
            `No channel resolved for notification delivery (tried: ${channelResult.error.attempted.join(" -> ")}). ` +
              "Pass channel_type + channel_id explicitly, set agents." +
              `${opts.agentId}.notification.primaryChannel in config, ` +
              "or notify after the agent has a recent channel session.",
          ),
        );
      }

      const { channelType, channelId } = channelResult.value;
      if (
        opts.destinationEndpoint.channelType !== channelType
        || opts.destinationEndpoint.conversationId !== channelId
      ) {
        deps.logger.warn({
          agentId: opts.agentId,
          channelType,
          errorKind: "precondition" as const,
          hint: "Resolve the notification destination from the same authority-bound endpoint before retrying",
        }, "Notification destination did not match resolved channel");
        return err(new Error("Notification destination does not match the resolved channel"));
      }

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
        tenantId: opts.authority.tenantId,
        agentId: opts.authority.agentId,
        conversationRef: opts.authority.conversationRef,
        destinationEndpoint: opts.destinationEndpoint,
        origin,
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
