// SPDX-License-Identifier: Apache-2.0
/**
 * Agents-stage helpers for daemon.ts's stageAgents.
 *
 * Block-moved verbatim from daemon.ts in Phase 43 Wave 8c (FILE-SPLIT-06):
 *   - restoreApprovalState (daemon.ts:819-865)
 *   - setupMcpManager (daemon.ts:874-890)
 *   - wirePostAgentsCleanup (daemon.ts:899-930)
 *   - buildAuditBundle (daemon.ts:937-956)
 *   - buildDeferredCronWakeCallback (daemon.ts:974-989)
 *
 * Each helper is a top-level function (not a closure) — mechanical block-move
 * is safe per RESEARCH §"No-cycles invariant". Consumed by stageAgents in
 * daemon.ts.
 *
 * @module
 */

import {
  createApprovalGate,
  createAuditAggregator,
  formatSessionKey,
  safePath,
  type WrapExternalContentOptions,
} from "@comis/core";
import type { bootstrap } from "@comis/core";
import { suppressError } from "@comis/shared";
import {
  createSessionTrackerRegistry,
  wireGeminiCacheCleanup,
  wireMcpDisconnectCleanup,
  wireSessionStateCleanup,
  type GeminiCacheManager,
  type SessionTrackerRegistry,
} from "@comis/agent";
import { createFileStateTracker } from "@comis/skills";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { setupMcp, type setupLogging } from "../wiring/index.js";

/**
 * Restore approval pending requests and cache from disk at startup.
 *
 * Extracted from the original daemon.ts approval-restore block (39L) to keep
 * `stageAgents` under the DAEMON-API-06 ≤200L cap. Reads
 * `<dataDir>/restart-approvals.json` and `<dataDir>/restart-approval-cache.json`
 * (written by graceful shutdown), restores into the in-memory ApprovalGate,
 * then deletes the files. Best-effort on JSON parse failure: log warn + unlink.
 */
export function restoreApprovalState(deps: {
  approvalGate: ReturnType<typeof createApprovalGate>;
  dataDir: string;
  containerDataDir: string | undefined;
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
}): void {
  const { approvalGate, dataDir, containerDataDir, daemonLogger } = deps;
  // 6.6.8.6.1. Restore pending approvals from previous restart
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

  // 6.6.8.6.2. Restore approval cache from previous session
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

/**
 * Construct the daemon-global MCP client manager. Hoisted to its own helper
 * to fit stageAgents under DAEMON-API-06 ≤200L. The manager is a pure
 * in-memory state holder (no I/O), so construction is safe before any
 * server-connect attempts and BEFORE setupAgents (per-agent
 * ToolCapabilityPort adapter construction closes over the manager).
 */
export async function setupMcpManager(deps: {
  container: Awaited<ReturnType<typeof bootstrap>> extends import("@comis/shared").Result<infer C, unknown> ? C : never;
  skillsLogger: ReturnType<typeof setupLogging>["skillsLogger"];
  defaultWorkspaceDir: string;
}): Promise<Awaited<ReturnType<typeof setupMcp>>["mcpClientManager"]> {
  const { container, skillsLogger, defaultWorkspaceDir } = deps;
  const { mcpClientManager } = await setupMcp({
    servers: container.config.integrations.mcp.servers,
    logger: skillsLogger,
    callToolTimeoutMs: container.config.integrations.mcp.callToolTimeoutMs,
    defaultCwd: defaultWorkspaceDir,
    eventBus: container.eventBus,
    stdioDefaultConcurrency: container.config.integrations.mcp.stdioDefaultConcurrency,
    httpDefaultConcurrency: container.config.integrations.mcp.httpDefaultConcurrency,
  });
  return mcpClientManager;
}

/**
 * Wire post-setupAgents cleanup listeners: session:expired releases
 * sessionTrackerRegistry, Gemini cache disposal, and MCP disconnect cleanup.
 * Schedules an orphan-cache cleanup pass for any stale comis:* caches.
 *
 * Extracted from stageAgents to fit the DAEMON-API-06 ≤200L cap.
 */
export function wirePostAgentsCleanup(deps: {
  eventBus: Awaited<ReturnType<typeof bootstrap>> extends import("@comis/shared").Result<infer C, unknown> ? C extends { eventBus: infer EB } ? EB : never : never;
  geminiCacheManager: GeminiCacheManager;
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
}): SessionTrackerRegistry<ReturnType<typeof createFileStateTracker>> {
  const { eventBus, geminiCacheManager, daemonLogger } = deps;
  // Clean up all session-scoped state on session expiry
  wireSessionStateCleanup(eventBus);
  // Per-session FileStateTracker pool -- keeps the LLM's file read state alive
  // across turns. Registered trackers are released on session:expired.
  const sessionTrackerRegistry = createSessionTrackerRegistry(createFileStateTracker);
  eventBus.on("session:expired", (payload) => {
    sessionTrackerRegistry.release(formatSessionKey(payload.sessionKey));
  });
  // Dispose Gemini cache on session expiry (fire-and-forget)
  wireGeminiCacheCleanup(eventBus, geminiCacheManager);
  // Clean up orphaned comis:* caches from previous daemon runs
  suppressError(
    geminiCacheManager.cleanupOrphaned().then((result) => {
      if (result.ok && (result.value.deleted > 0 || result.value.skipped > 0)) {
        daemonLogger.info(
          { deleted: result.value.deleted, skipped: result.value.skipped },
          "Gemini cache: orphan cleanup complete",
        );
      }
    }),
    "gemini-cache-orphan-cleanup",
  );
  // Clean up discovery state when MCP servers disconnect or remove tools
  wireMcpDisconnectCleanup(eventBus);
  return sessionTrackerRegistry;
}

/**
 * Build the audit aggregator + onSuspiciousContent reporter pair used by
 * stageAgents and threaded into setupMedia. Extracted to keep stageAgents
 * under the DAEMON-API-06 ≤200L cap.
 */
export function buildAuditBundle(deps: {
  eventBus: Awaited<ReturnType<typeof bootstrap>> extends import("@comis/shared").Result<infer C, unknown> ? C extends { eventBus: infer EB } ? EB : never : never;
  skillsLogger: ReturnType<typeof setupLogging>["skillsLogger"];
  clock: import("@comis/core").ClockPort;
  timers: import("@comis/core").TimerPort;
}): {
  auditAggregator: ReturnType<typeof createAuditAggregator>;
  onSuspiciousContent: WrapExternalContentOptions["onSuspiciousContent"];
} {
  const auditAggregator = createAuditAggregator(
    deps.eventBus,
    { clock: deps.clock, timers: deps.timers },
    undefined,
    deps.skillsLogger,
  );
  const onSuspiciousContent: WrapExternalContentOptions["onSuspiciousContent"] = (info) => {
    auditAggregator.record({ source: "external_content", patterns: info.patterns });
  };
  return { auditAggregator, onSuspiciousContent };
}

/**
 * Build the onCronWake callback handed to setupSchedulers. Reads
 * `cronWakeCallbackRef.ref` at INVOCATION time (deferred), so the live
 * wakeCoalescer wired up later in stageChannels is what actually receives
 * the wake. If a cron fires in the gap between stageAgents returning and
 * stageChannels populating the ref (typically milliseconds, but a heavy
 * startup may stretch it to seconds), surface the drop with a debug log
 * line so the silent miss is visible (WR-07).
 *
 * Observability-only: we intentionally do NOT buffer-then-drain (the
 * precedent set by channelPluginsRef / bgNotifyRef etc.). Cron wakes are
 * timer-driven; replaying a backlog could cause a wake storm if N timers
 * fired during a slow startup.
 *
 * Extracted from stageAgents to keep it under the DAEMON-API-06 ≤200L cap.
 */
export function buildDeferredCronWakeCallback(
  cronWakeCallbackRef: { ref?: (reason: string) => void },
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"],
): (reason: string) => void {
  return (reason: string) => {
    const callback = cronWakeCallbackRef.ref;
    if (callback) {
      callback(reason);
    } else {
      daemonLogger.debug(
        { reason, hint: "wakeCoalescer not yet constructed; cron wake dropped" },
        "Cron wake dropped during stage handoff",
      );
    }
  };
}
