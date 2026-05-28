// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal keepalive ticker stop helper — extracted from mcp-client-keepalive.ts
 * so mcp-client-reconnect.ts can import it without creating a mutual import cycle.
 *
 * Dependency direction: this file imports from @comis/core and mcp-client-types.ts only.
 * Neither mcp-client-reconnect.ts nor mcp-client-keepalive.ts is imported here.
 *
 * @module
 */

import { systemClearInterval } from "@comis/core";
import type { McpClientManagerState } from "./mcp-client-types.js";

/**
 * Stop the keepalive ticker for a named server. Called from both
 * disconnectServer (via re-export in mcp-client-keepalive.ts) and
 * reconnectionLoop before creating a new transport (mcp-client-reconnect.ts).
 *
 * Must be called BEFORE client.close() in reconnectionLoop so the old ticker
 * cannot fire one last `queue.add` against a queue we are about to abandon.
 */
export function stopKeepaliveTicker(state: McpClientManagerState, serverName: string): void {
  const handle = state.keepaliveTickers.get(serverName);
  if (handle !== undefined) {
    systemClearInterval(handle);
    state.keepaliveTickers.delete(serverName);
  }
}
