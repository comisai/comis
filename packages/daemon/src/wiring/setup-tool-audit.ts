// SPDX-License-Identifier: Apache-2.0
/**
 * The `tool:executed` audit-log subscription (a skills concern) — extracted from
 * `setup-tools.ts` to keep that composition-root file under the 800-line architecture cap
 * (the established house extraction discipline, e.g. `terminal-status-view.ts`).
 *
 * Subscribes the daemon event bus and emits a DEBUG audit line per tool execution: the
 * tool name + `durationMs` + success + the origin (userId/agentId/sessionKey) + the parameter
 * count. Parameter values and free-text descriptions stay on the private event/trajectory path;
 * they never enter daemon logs. No module-global state — the bus + logger are injected.
 *
 * @module
 */

import type { TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/**
 * Wire the `tool:executed` audit DEBUG line. Call once at tool-setup; the subscription
 * lives for the daemon's lifetime (tools are a skills concern, per AGENTS §2.4).
 */
export function setupToolAuditLogging(eventBus: TypedEventBus, skillsLogger: ComisLogger): void {
  eventBus.on("tool:executed", (event) => {
    skillsLogger.debug(
      {
        toolName: event.toolName,
        durationMs: Math.round(event.durationMs),
        success: event.success,
        parameterCount: event.params === undefined ? 0 : Object.keys(event.params).length,
        userId: event.userId,
        agentId: event.agentId,
        sessionKey: event.sessionKey,
      },
      "Tool execution audited",
    );
  });
}
