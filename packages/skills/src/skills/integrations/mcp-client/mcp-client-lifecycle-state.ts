// SPDX-License-Identifier: Apache-2.0
/**
 * Synchronous MCP connection-state transitions used before asynchronous
 * transport teardown. Removing the tool inventory at the same time prevents a
 * caller from reaching a superseded child while close() is still pending.
 */

import type {
  McpClientManagerState,
  McpConnectionStatus,
} from "./mcp-client-types.js";

export function markConnectionUnavailable(
  state: McpClientManagerState,
  name: string,
  status: Extract<McpConnectionStatus, "disconnected" | "reconnecting">,
): void {
  const connection = state.connections.get(name);
  if (!connection) return;
  const generation = (state.generations.get(name) ?? connection.generation) + 1;
  state.generations.set(name, generation);
  state.connections.set(name, {
    ...connection,
    status,
    tools: [],
    generation,
  });
}
