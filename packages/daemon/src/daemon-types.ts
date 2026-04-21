// SPDX-License-Identifier: Apache-2.0
/**
 * Public types for the daemon entry point.
 * Moved from daemon.ts to reduce its size and provide a dedicated
 * single source of truth for the daemon's public interface types.
 * @module
 */

import type { DeviceIdentity } from "@comis/core";
import type { AppContainer, ChannelPort } from "@comis/core";
import type { ApprovalGate } from "@comis/core";
import type { ChannelHealthMonitor } from "@comis/channels";
import type { ComisLogger } from "@comis/infra";
import type { SessionResetScheduler } from "@comis/agent";
import type { GatewayServerHandle } from "@comis/gateway";
import type {
  HeartbeatRunner,
  CronScheduler,
} from "@comis/scheduler";
import type { BrowserService, RpcCall } from "@comis/skills";
import type { LatencyRecorder } from "./observability/latency-recorder.js";
import type { LogLevelManager } from "./observability/log-infra.js";
import type { TokenTracker } from "./observability/token-tracker.js";
import type { DiagnosticCollector } from "./observability/diagnostic-collector.js";
import type { BillingEstimator } from "./observability/billing-estimator.js";
import type { ChannelActivityTracker } from "./observability/channel-activity-tracker.js";
import type { DeliveryTracer } from "./observability/delivery-tracer.js";
import type { ShutdownHandle } from "./process/graceful-shutdown.js";
import type { ProcessMonitor } from "./process/process-monitor.js";
import type { WatchdogHandle } from "./health/watchdog.js";

import type { bootstrap } from "@comis/core";
import type { setupSecrets } from "@comis/memory";
import type { createGatewayServer } from "@comis/gateway";
import type { createTracingLogger } from "./observability/trace-logger.js";
import type { createLogLevelManager } from "./observability/log-infra.js";
import type { createTokenTracker } from "./observability/token-tracker.js";
import type { createLatencyRecorder } from "./observability/latency-recorder.js";
import type { createProcessMonitor } from "./process/process-monitor.js";
import type { registerGracefulShutdown } from "./process/graceful-shutdown.js";
import type { startWatchdog } from "./health/watchdog.js";
import type { setupMedia } from "./wiring/setup-media.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The running daemon instance with all wired services.
 */
export interface DaemonInstance {
  readonly container: AppContainer;
  readonly logger: ComisLogger;
  readonly logLevelManager: LogLevelManager;
  readonly tokenTracker: TokenTracker;
  readonly latencyRecorder: LatencyRecorder;
  readonly processMonitor: ProcessMonitor;
  readonly shutdownHandle: ShutdownHandle;
  readonly watchdogHandle: WatchdogHandle;
  readonly cronSchedulers: Map<string, CronScheduler>;
  readonly resetSchedulers: Map<string, SessionResetScheduler>;
  readonly browserServices: Map<string, BrowserService>;
  readonly heartbeatRunner?: HeartbeatRunner;
  readonly gatewayHandle?: GatewayServerHandle;
  readonly adapterRegistry: Map<string, ChannelPort>;
  readonly rpcCall: RpcCall;
  readonly deviceIdentity?: DeviceIdentity;
  readonly diagnosticCollector: DiagnosticCollector;
  readonly billingEstimator: BillingEstimator;
  readonly channelActivityTracker: ChannelActivityTracker;
  readonly deliveryTracer: DeliveryTracer;
  readonly approvalGate?: ApprovalGate;
  /** Channel health monitor for observability and auto-restart. */
  readonly channelHealthMonitor?: ChannelHealthMonitor;
  readonly sessionStoreBridge?: {
    listDetailed: (tenantId?: string) => Array<{
      sessionKey: string;
      userId: string;
      channelId: string;
      metadata: Record<string, unknown>;
      createdAt: number;
      updatedAt: number;
    }>;
    loadByFormattedKey: (sessionKey: string) => { messages: unknown[]; metadata: Record<string, unknown>; createdAt: number; updatedAt: number } | undefined;
    deleteByFormattedKey: (sessionKey: string) => boolean;
    saveByFormattedKey: (sessionKey: string, messages: unknown[], metadata?: Record<string, unknown>) => void;
  };
}

/**
 * Overrides for dependency injection during testing.
 */
export interface DaemonOverrides {
  /** Override bootstrap function. */
  bootstrap?: typeof bootstrap;
  /** Override setupSecrets for test isolation */
  setupSecrets?: typeof setupSecrets;
  /** Override createTracingLogger. */
  createTracingLogger?: typeof createTracingLogger;
  /** Override createLogLevelManager. */
  createLogLevelManager?: typeof createLogLevelManager;
  /** Override createTokenTracker. */
  createTokenTracker?: typeof createTokenTracker;
  /** Override createLatencyRecorder. */
  createLatencyRecorder?: typeof createLatencyRecorder;
  /** Override createProcessMonitor. */
  createProcessMonitor?: typeof createProcessMonitor;
  /** Override registerGracefulShutdown. */
  registerGracefulShutdown?: typeof registerGracefulShutdown;
  /** Override startWatchdog. */
  startWatchdog?: typeof startWatchdog;
  /** Override createGatewayServer. */
  createGatewayServer?: typeof createGatewayServer;
  /** Override setupMedia for test isolation (avoids ffmpeg/ffprobe spawns). */
  setupMedia?: typeof setupMedia;
  /** Override process.exit for testing. */
  exit?: (code: number) => void;
  /** Override native-dep preflight check for tests that don't need the probe. */
  preflightDoctor?: (exitFn: (code: number) => void) => Promise<void>;
}
