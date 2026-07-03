// SPDX-License-Identifier: Apache-2.0
/**
 * The `tool:executed` audit-log subscription (a skills concern) — extracted from
 * `setup-tools.ts` to keep that composition-root file under the 800-line architecture cap
 * (the established house extraction discipline, e.g. `terminal-status-view.ts`).
 *
 * Subscribes the daemon event bus and emits a DEBUG audit line per tool execution: the
 * tool name + `durationMs` + success + the origin (userId/agentId/sessionKey) + a truncated,
 * log-sanitized params preview. The raw params are run through `sanitizeLogString` and
 * length-capped before logging (never a verbatim dump). No module-global state — the bus +
 * logger are injected.
 *
 * @module
 */

import { sanitizeLogString, type TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/** Truncate + log-sanitize a params bag for the audit preview (never a verbatim dump). */
function truncateParams(params: Record<string, unknown>, maxLen = 1500): { text: string; truncated: boolean } {
  const raw = JSON.stringify(params);
  const sanitized = sanitizeLogString(raw);
  const truncated = sanitized.length > maxLen;
  return { text: truncated ? sanitized.slice(0, maxLen) + "..." : sanitized, truncated };
}

/**
 * Wire the `tool:executed` audit DEBUG line. Call once at tool-setup; the subscription
 * lives for the daemon's lifetime (tools are a skills concern, per AGENTS §2.4).
 */
export function setupToolAuditLogging(eventBus: TypedEventBus, skillsLogger: ComisLogger): void {
  eventBus.on("tool:executed", (event) => {
    const paramResult = event.params ? truncateParams(event.params) : undefined;
    // Include params preview (1000 chars) in the message string for formatted log output visibility
    const paramsPreview = paramResult
      ? ` — ${paramResult.text.length > 1000 ? paramResult.text.slice(0, 1000) + "…" : paramResult.text}`
      : "";
    skillsLogger.debug(
      {
        toolName: event.toolName,
        durationMs: Math.round(event.durationMs),
        success: event.success,
        userId: event.userId,
        agentId: event.agentId,
        sessionKey: event.sessionKey,
        ...(event.description && { description: event.description }),
        ...(paramResult && { params: paramResult.text }),
        ...(paramResult?.truncated && { paramsTruncated: true }),
      },
      `Tool audit: ${event.toolName}${event.description ? ` (${event.description})` : ""} ${event.success ? "succeeded" : "failed"} (${Math.round(event.durationMs)}ms)${paramsPreview}`,
    );
  });
}
