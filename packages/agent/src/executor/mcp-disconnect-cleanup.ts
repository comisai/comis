/**
 * MCP disconnect cleanup: wires mcp:server:disconnected and
 * mcp:server:tools_changed events to discovery tracker cleanup.
 *
 * Separate from session-snapshot-cleanup.ts to maintain single responsibility
 * Kept separate to maintain single responsibility.
 *
 * @module
 */

import { cleanupServerFromAllTrackers, cleanupToolsFromAllTrackers } from "./discovery-tracker.js";

/**
 * Subscribe to MCP server lifecycle events and clean up discovery tracker
 * state when servers disconnect or remove tools.
 *
 * Uses a narrow structural type for `eventBus` to avoid coupling this
 * module to the full TypedEventBus generic (same pattern as
 * {@link ./session-snapshot-cleanup.ts}).
 *
 * @param eventBus - Event bus with mcp:server:disconnected and mcp:server:tools_changed support
 * @param logger - Optional structured logger for DEBUG-level cleanup messages
 */
export function wireMcpDisconnectCleanup(
  eventBus: {
    on(
      event: "mcp:server:disconnected",
      handler: (payload: {
        serverName: string;
        reason: string;
        timestamp: number;
      }) => void,
    ): void;
    on(
      event: "mcp:server:tools_changed",
      handler: (payload: {
        serverName: string;
        removedTools: string[];
        addedTools: string[];
        previousToolCount: number;
        currentToolCount: number;
      }) => void,
    ): void;
  },
  logger?: { debug(obj: Record<string, unknown>, msg: string): void },
): void {
  eventBus.on("mcp:server:disconnected", (payload) => {
    const removedCount = cleanupServerFromAllTrackers(payload.serverName);
    if (removedCount > 0 && logger) {
      logger.debug(
        { serverName: payload.serverName, removedCount },
        "Cleaned up discovery state for disconnected MCP server",
      );
    }
  });

  eventBus.on("mcp:server:tools_changed", (payload) => {
    if (payload.removedTools.length === 0) return;

    const qualifiedNames = payload.removedTools.map(
      (tool) => `mcp:${payload.serverName}/${tool}`,
    );
    const removedCount = cleanupToolsFromAllTrackers(qualifiedNames);
    if (removedCount > 0 && logger) {
      logger.debug(
        {
          serverName: payload.serverName,
          removedCount,
          removedTools: payload.removedTools,
        },
        "Cleaned up discovery state for removed MCP tools",
      );
    }
  });
}
