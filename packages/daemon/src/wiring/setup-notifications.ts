/**
 * Notification system wiring for daemon startup.
 * Creates the NotificationService, SessionTracker, and ChannelResolverDeps
 * from daemon-level dependencies. Returns a NotificationContext object
 * that is threaded into RPC dispatch and message handler pipelines.
 * Full notification system wiring.
 * @module
 */

import type { DeliveryQueuePort, NotificationConfig, PerAgentConfig } from "@comis/core";
import type { TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { createNotificationService, type NotificationService } from "../notification/notification-service.js";
import { createSessionTracker, type SessionTracker } from "../notification/session-tracker.js";
import type { ChannelResolverDeps } from "../notification/channel-resolver.js";

/** Result of setupNotifications -- threaded into RPC dispatch and message pipelines. */
export interface NotificationContext {
  notificationService: NotificationService;
  sessionTracker: SessionTracker;
}

/** Dependencies for notification system setup. */
export interface SetupNotificationDeps {
  eventBus: Pick<TypedEventBus, "emit">;
  deliveryQueue: DeliveryQueuePort;
  agents: Record<string, PerAgentConfig>;
  quietHoursConfig: { enabled: boolean; start: string; end: string; timezone: string };
  criticalBypass: boolean;
  activeAdapterTypes: ReadonlySet<string>;
  logger: ComisLogger;
  tenantId: string;
}

/**
 * Wire the notification subsystem from daemon-level dependencies.
 * Creates a SessionTracker (ephemeral, in-memory), builds per-agent
 * NotificationConfig map from PerAgentConfig, and assembles the
 * NotificationService with the full guard pipeline.
 * @param deps - Daemon-level dependencies
 * @returns NotificationContext with service and tracker instances
 */
export function setupNotifications(deps: SetupNotificationDeps): NotificationContext {
  const sessionTracker = createSessionTracker();

  // Build notification config map from per-agent configs
  const notificationConfigs = new Map<string, NotificationConfig>();
  for (const [agentId, agentConfig] of Object.entries(deps.agents)) {
    if (agentConfig.notification) {
      notificationConfigs.set(agentId, agentConfig.notification);
    }
  }

  // Default config for agents without explicit notification config
  const defaultConfig: NotificationConfig = {
    enabled: true,
    maxPerHour: 30,
    dedupeWindowMs: 300_000,
    maxChainDepth: 0,
  };

  const channelResolverDeps: ChannelResolverDeps = {
    activeAdapterTypes: deps.activeAdapterTypes,
    getRecentSessionChannel: (agentId, channelType) =>
      sessionTracker.getRecentForPlatform(agentId, channelType),
    getMostRecentSession: (agentId) =>
      sessionTracker.getMostRecent(agentId),
  };

  const notificationService = createNotificationService({
    eventBus: deps.eventBus,
    deliveryQueue: deps.deliveryQueue,
    quietHoursConfig: deps.quietHoursConfig,
    criticalBypass: deps.criticalBypass,
    notificationConfigs,
    defaultConfig,
    channelResolverDeps,
    logger: deps.logger,
    tenantId: deps.tenantId,
  });

  return { notificationService, sessionTracker };
}
