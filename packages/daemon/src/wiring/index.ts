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
} from "./daemon-utils.js";
export { setupLogging, type LoggingResult } from "./setup-logging.js";
export { setupObservability, rehydrateSpendFromStore, type ObservabilityResult } from "./setup-observability.js";
export { setupHealth, type HealthResult, setupMonitoring, type MonitoringResult } from "./setup-health.js";
export { setupMemory, type MemoryResult } from "./setup-memory.js";
export { setupMedia, createImageGenGetter, type MediaResult } from "./setup-media.js";
export { createImageProviderSelector, makeUnavailableImagePort } from "./setup-image-provider.js";
export { setupCrossSession, type CrossSessionResult } from "./setup-cross-session/index.js";
export { setupAgents, type AgentsResult } from "./setup-agents/index.js";
export { setupSchedulers, type SchedulersResult } from "./setup-schedulers.js";
export { emitMemoryCostFeatureNotice, type MemoryCostFeatureNoticeDeps } from "./setup-memory-cost-notice.js";
export { setupChannels, type ChannelsResult } from "./setup-channels/index.js";
export {
  resolveInteractiveCallbackSigningSecret,
  bindSignCallbackData,
  createInteractiveCallbackWiring,
  type InteractiveCallbackWiring,
} from "./setup-interactive-callback.js";
export { setupMcp, type McpResult } from "./setup-mcp.js";
export { selectMcpTokenStore, type SelectMcpTokenStoreInput } from "./select-mcp-token-store.js";
// Boot-path skill-bundle re-merge orchestrator + the thin discovery-only
// registry pre-pass it consumes. Wired in daemon.ts BEFORE setupMcp so the
// merged servers array is in place when the manager connects.
export {
  setupSkillBundles,
  buildSkillRegistriesForBundles,
  type SetupSkillBundlesDeps,
} from "./setup-skill-bundles.js";
export { setupTools, type ToolsResult } from "./setup-tools.js";
export { setupHeartbeat, type HeartbeatSetupDeps, type HeartbeatSetupResult } from "./setup-heartbeat.js";
export { setupShutdown, type ShutdownResult } from "./setup-shutdown.js";
export { setupGateway, type GatewayDeps, type GatewayResult, setupRpcBridge, type RpcBridgeResult } from "./setup-gateway/index.js";
export {
  createGatewayAttachmentPersister,
  type GatewayAttachmentPersister,
} from "./gateway-attachment-persistence.js";
export { setupDeliveryQueue, type DeliveryQueueResult, setupDeliveryMirror, type DeliveryMirrorResult } from "./setup-delivery.js";
// The durable-run + resume engine wiring (stores + boot recovery +
// watchdog + shutdown) + the daemon composition helpers. Gated behind
// autonomy.durability.enabled.
export {
  setupDurableResume,
  buildDurableStores,
  buildDurableResume,
  buildOrchestrateResumeWiring,
  type DurableResumeResult,
  type DurableResumeConfig,
  type SetupDurableResumeDeps,
  type DurableStoresResult,
  type DurableResumeWiring,
} from "./setup-durable-resume.js";
export {
  createWorktreeRegistry,
  toLifecycleGitExec,
  setupWorktreeSweep,
  discoverWorktreeOrphans,
  type WorktreeRegistry,
  type RegisterWorktreeInput,
  type SetupWorktreeSweepDeps,
  type WorktreeSweepHandle,
  type DiscoverWorktreeOrphansDeps,
} from "./setup-worktree-sweep.js";
export { setupNotifications, type NotificationContext } from "./setup-notifications.js";
export { setupBackgroundTasks, type BackgroundTasksContext } from "./setup-background-tasks.js";
export { setupBackgroundCompletionRunner } from "./setup-background-completion-runner.js";
export { setupTerminalWake, type SetupTerminalWakeDeps, type TerminalWakeContext } from "./setup-terminal-wake.js";
export type {
  BackgroundCompletionRunnerContext,
  SetupBackgroundCompletionRunnerDeps,
} from "./setup-background-completion-runner.js";
export {
  setupOutputRetention,
} from "./setup-output-retention.js";
export type {
  SetupOutputRetentionDeps,
  SetupOutputRetentionHandle,
} from "./setup-output-retention.js";
export { setupBroker } from "./setup-broker.js";
export type { BrokerHandle, SetupBrokerDeps } from "./setup-broker.js";
export { acquireDataDirLock, releaseDataDirLock } from "./data-dir-lock.js";
