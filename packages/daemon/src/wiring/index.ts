// SPDX-License-Identifier: Apache-2.0
// @comis/daemon wiring — shared types and utilities for daemon decomposition
export type { DaemonContext } from "./daemon-context.js";
export {
  resolveAdapter,
  authorizeChannelAccess,
  buildCronSchedule,
  guessMimeFromExtension,
  detectMimeFromMagicBytes,
  mimeToExtension,
  resolveGatewayEnvOverrides,
} from "./daemon-utils.js";
export { setupLogging, type LoggingResult } from "./setup-logging.js";
export { setupObservability, type ObservabilityResult } from "./setup-observability.js";
export { setupHealth, type HealthResult, setupMonitoring, type MonitoringResult } from "./setup-health.js";
export { setupMemory, type MemoryResult } from "./setup-memory.js";
export { setupMedia, type MediaResult } from "./setup-media.js";
export { setupCrossSession, type CrossSessionResult } from "./setup-cross-session.js";
export { setupAgents, type AgentsResult } from "./setup-agents.js";
export { setupSchedulers, type SchedulersResult, setupTaskExtraction, type TaskExtractionResult } from "./setup-schedulers.js";
export { setupChannels, type ChannelsResult } from "./setup-channels.js";
export { setupMcp, type McpResult } from "./setup-mcp.js";
export { setupTools, type ToolsResult } from "./setup-tools.js";
export { setupHeartbeat, type HeartbeatSetupDeps, type HeartbeatSetupResult } from "./setup-heartbeat.js";
export { setupShutdown, type ShutdownResult } from "./setup-shutdown.js";
export { setupGateway, type GatewayDeps, type GatewayResult, setupRpcBridge, type RpcBridgeResult } from "./setup-gateway.js";
export { setupDeliveryQueue, type DeliveryQueueResult, setupDeliveryMirror, type DeliveryMirrorResult } from "./setup-delivery.js";
export { setupNotifications, type NotificationContext } from "./setup-notifications.js";
export { setupBackgroundTasks, type BackgroundTasksContext } from "./setup-background-tasks.js";
