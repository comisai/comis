// @comis/daemon/process - process lifecycle & signal handling

export {
  createProcessMonitor,
  type ProcessMonitor,
  type ProcessMetrics,
  type ProcessMonitorDeps,
} from "./process-monitor.js";

export {
  registerGracefulShutdown,
  type ShutdownDeps,
  type ShutdownHandle,
} from "./graceful-shutdown.js";
