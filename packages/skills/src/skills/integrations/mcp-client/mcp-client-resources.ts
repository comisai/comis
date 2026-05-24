// SPDX-License-Identifier: Apache-2.0
/**
 * Capability-gated resources/prompts utility tools (Phase 65 OPUX-10).
 *
 * Provides 4 RPC adapters around the MCP SDK's resources/prompts methods.
 * Each adapter looks up the per-server SDK Client via the manager's
 * `getConnection(server)` accessor and delegates to
 * `client.listResources/readResource/listPrompts/getPrompt`. The result is
 * mapped to a Comis-owned plain shape (so the platform-tool layer never
 * leaks the SDK's wider response type) and wrapped in a `Result`.
 *
 * Capability gating: a server contributes to the tool registry ONLY IF
 *   - `capabilities.resources` is truthy (any shape — bool, object, etc.)
 *     AND `config.enableResources !== false`
 *   - or `capabilities.prompts` is truthy AND `config.enablePrompts !== false`
 *
 * Per the gate helpers, an UNDEFINED config flag means auto-register (the
 * operator did not opt out); an explicit `false` suppresses the tools even
 * when the capability is present (mitigates Cursor's 40-tool ceiling on
 * resources-noisy servers).
 *
 * Tool surface: 4 GLOBAL platform tools that take `server: string` as a
 * required parameter (see platform-tools/tools/mcp-resources-tool.ts +
 * mcp-prompts-tool.ts). Global (not per-server) keeps the descriptor count
 * fixed at 4 regardless of how many MCP servers are connected.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { McpClientManager } from "./mcp-client-types.js";

// ---------------------------------------------------------------------------
// Result shapes (Comis-owned; do not leak the SDK response types)
// ---------------------------------------------------------------------------

/** A single resource entry from `client.listResources()`. */
export interface ResourceListEntry {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/** A single content item from `client.readResource()`. */
export interface ResourceContents {
  readonly uri: string;
  readonly text?: string;
  readonly blob?: string;
  readonly mimeType?: string;
}

/** A single prompt entry from `client.listPrompts()`. */
export interface PromptListEntry {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: ReadonlyArray<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** The result of `client.getPrompt()`. */
export interface PromptGetResult {
  readonly description?: string;
  readonly messages: ReadonlyArray<{ role: string; content: unknown }>;
}

// ---------------------------------------------------------------------------
// RPC adapters
// ---------------------------------------------------------------------------

/**
 * List the resources advertised by a connected MCP server.
 *
 * Returns `err` when the server is unknown or not in the `connected` state;
 * any SDK throw is caught and translated to `err` (never bubbles).
 */
export async function listResourcesForServer(
  manager: McpClientManager,
  server: string,
): Promise<Result<ResourceListEntry[], Error>> {
  const conn = manager.getConnection(server);
  if (!conn || conn.status !== "connected") {
    return err(new Error(`MCP server "${server}" not connected`));
  }
  try {
    const result = await conn.client.listResources();
    return ok(
      result.resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        ...(r.description !== undefined && { description: r.description }),
        ...(r.mimeType !== undefined && { mimeType: r.mimeType }),
      })),
    );
  } catch (error: unknown) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Read the contents of a single resource (by URI) from a connected server.
 */
export async function readResourceFromServer(
  manager: McpClientManager,
  server: string,
  uri: string,
): Promise<Result<ResourceContents[], Error>> {
  const conn = manager.getConnection(server);
  if (!conn || conn.status !== "connected") {
    return err(new Error(`MCP server "${server}" not connected`));
  }
  try {
    const result = await conn.client.readResource({ uri });
    return ok(
      result.contents.map((c) => ({
        uri: c.uri,
        ...("text" in c && c.text !== undefined && { text: c.text as string }),
        ...("blob" in c && c.blob !== undefined && { blob: c.blob as string }),
        ...(c.mimeType !== undefined && { mimeType: c.mimeType as string }),
      })),
    );
  } catch (error: unknown) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * List the prompts advertised by a connected MCP server.
 */
export async function listPromptsForServer(
  manager: McpClientManager,
  server: string,
): Promise<Result<PromptListEntry[], Error>> {
  const conn = manager.getConnection(server);
  if (!conn || conn.status !== "connected") {
    return err(new Error(`MCP server "${server}" not connected`));
  }
  try {
    const result = await conn.client.listPrompts();
    return ok(
      result.prompts.map((p) => ({
        name: p.name,
        ...(p.description !== undefined && { description: p.description }),
        ...(p.arguments !== undefined && { arguments: p.arguments }),
      })),
    );
  } catch (error: unknown) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Fetch a single prompt (by name, with optional template arguments) from a
 * connected server.
 */
export async function getPromptFromServer(
  manager: McpClientManager,
  server: string,
  name: string,
  args?: Record<string, unknown>,
): Promise<Result<PromptGetResult, Error>> {
  const conn = manager.getConnection(server);
  if (!conn || conn.status !== "connected") {
    return err(new Error(`MCP server "${server}" not connected`));
  }
  try {
    const result = await conn.client.getPrompt({
      name,
      ...(args !== undefined && { arguments: args as Record<string, string> }),
    });
    return ok({
      ...(result.description !== undefined && { description: result.description }),
      messages: result.messages.map((m) => ({ role: m.role, content: m.content })),
    });
  } catch (error: unknown) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// ---------------------------------------------------------------------------
// Capability-gate helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a server's capabilities + per-server opt-out flag combine
 * to advertise RESOURCES support to the platform-tool layer.
 *
 * Capabilities are read from `McpConnection.capabilities` (populated from
 * `extractServerMetadata(client).capabilities` at connect). The capability is
 * considered "advertised" when `capabilities.resources` is truthy (boolean
 * `true`, a non-empty object, etc.). An explicit `enableResources === false`
 * opts out; `undefined` means auto-register.
 */
export function serverAdvertisesResources(
  capabilities: Record<string, unknown> | undefined,
  enableResources: boolean | undefined,
): boolean {
  if (enableResources === false) return false;
  return capabilities?.resources != null && capabilities.resources !== false;
}

/**
 * Symmetric to {@link serverAdvertisesResources} for PROMPTS support
 * (`capabilities.prompts` + `enablePrompts`).
 */
export function serverAdvertisesPrompts(
  capabilities: Record<string, unknown> | undefined,
  enablePrompts: boolean | undefined,
): boolean {
  if (enablePrompts === false) return false;
  return capabilities?.prompts != null && capabilities.prompts !== false;
}
