// SPDX-License-Identifier: Apache-2.0
/**
 * Approval boot wiring: build the gate from operator config, then restore what
 * the previous process left pending.
 *
 * Kept together and out of the shared helper module because both halves read
 * the same `approvals` config and the same on-disk restart files, and a boot
 * failure in either is diagnosed by looking at the other.
 *
 * @module
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createApprovalGate, safePath } from "@comis/core";
import type { AppConfig, ClockPort, TimerPort, TypedEventBus } from "@comis/core";
import type { LoggingResult } from "./setup-logging.js";

/**
 * Build the approval gate from operator config.
 *
 * Every getter reads through `container.config` on each call so a config
 * reload is observed; `approvals` is fully defaulted by its schema, so no
 * call-site fallback is needed or wanted — a literal here could only drift
 * from the schema it is meant to mirror.
 */
export function createConfiguredApprovalGate(deps: {
  eventBus: TypedEventBus;
  getApprovals: () => AppConfig["approvals"];
  clock: ClockPort;
  timers: TimerPort;
  fingerprintSecret: string;
  daemonLogger: LoggingResult["daemonLogger"];
}): ReturnType<typeof createApprovalGate> {
  return createApprovalGate({
    eventBus: deps.eventBus,
    getTimeoutMs: () => deps.getApprovals().defaultTimeoutMs,
    getDenialCacheTtlMs: () => deps.getApprovals().denialCacheTtlMs,
    getBatchApprovalTtlMs: () => deps.getApprovals().batchApprovalTtlMs,
    getPolicy: deps.getApprovals,
    clock: deps.clock,
    timers: deps.timers,
    fingerprintSecret: deps.fingerprintSecret,
    logger: deps.daemonLogger,
  });
}

export function restoreApprovalState(deps: {
  approvalGate: ReturnType<typeof createApprovalGate>;
  dataDir: string;
  containerDataDir: string | undefined;
  daemonLogger: LoggingResult["daemonLogger"];
}): void {
  const { approvalGate, dataDir, containerDataDir, daemonLogger } = deps;
  // Pending approvals the previous process serialized on shutdown.
  const approvalRestorePath = safePath(containerDataDir || dataDir, "restart-approvals.json");
  if (existsSync(approvalRestorePath)) {
    try {
      const raw = readFileSync(approvalRestorePath, "utf-8");
      const records = JSON.parse(raw);
      unlinkSync(approvalRestorePath);
      const restored = approvalGate.restorePending(records);
      if (restored > 0) {
        daemonLogger.info({ count: restored, total: records.length }, "Pending approvals restored from previous session");
      }
    } catch (restoreErr) {
      daemonLogger.warn(
        { err: restoreErr, hint: "Could not restore pending approvals; operators may need to re-approve", errorKind: "internal" as const },
        "Failed to restore pending approvals",
      );
      try { unlinkSync(approvalRestorePath); } catch { /* ignore */ }
    }
  }

  // The approval cache, so a batch approved before restart is not re-prompted.
  const approvalCacheRestorePath = safePath(containerDataDir || dataDir, "restart-approval-cache.json");
  if (existsSync(approvalCacheRestorePath)) {
    try {
      const raw = readFileSync(approvalCacheRestorePath, "utf-8");
      unlinkSync(approvalCacheRestorePath); // Consume immediately
      const entries = JSON.parse(raw);
      const restored = approvalGate.restoreApprovalCache(entries);
      if (restored > 0) {
        daemonLogger.info({ count: restored, total: entries.length }, "Approval cache restored from previous session");
      }
    } catch (restoreErr) {
      daemonLogger.warn(
        { err: restoreErr, hint: "Could not restore approval cache; users may need to re-approve", errorKind: "internal" as const },
        "Failed to restore approval cache",
      );
      try { unlinkSync(approvalCacheRestorePath); } catch { /* ignore */ }
    }
  }
}
