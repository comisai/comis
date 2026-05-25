// SPDX-License-Identifier: Apache-2.0
/**
 * Capability-gated resources/prompts utility tools.
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
 * The registry's conditional predicate gates at tool-REGISTRATION time, but a
 * capability can disappear on a reconnect (generation bump) while the
 * descriptor stays registered until the next agent assembly. Each adapter
 * therefore RE-ENFORCES the same gate (serverAdvertisesResources/Prompts) on
 * the LIVE connection before delegating to the SDK, and readResourceFromServer
 * additionally rejects SSRF-prone URI schemes (http/https/file) since the uri
 * is caller-controlled.
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
// SSRF-prone resource URI schemes
// ---------------------------------------------------------------------------
//
// The `uri` passed to readResourceFromServer is caller-controlled (the LLM
// supplies it via the read_resource platform tool) and flows verbatim to
// `client.readResource({ uri })`, where the MCP server resolves it. A remote
// (http/sse) MCP server could be coerced into fetching internal network or
// local-filesystem targets. We reject the network/local-fetch schemes at the
// adapter boundary — MCP resource URIs are otherwise the server's own opaque
// namespace (custom schemes like screen://, git://, postgres://), which the
// server validates itself, so anything else is allowed through.
const BLOCKED_RESOURCE_SCHEMES = new Set(["http:", "https:", "file:"]);

/**
 * Extract the lowercased `scheme:` prefix from a URI, or undefined if the
 * string has no RFC-3986 scheme. Scheme grammar: ALPHA *( ALPHA / DIGIT /
 * "+" / "-" / "." ) followed by ":".
 */
function uriScheme(uri: string): string | undefined {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
  return match ? `${match[1]!.toLowerCase()}:` : undefined;
}

// ---------------------------------------------------------------------------
// RPC adapters
// ---------------------------------------------------------------------------

/**
 * List the resources advertised by a connected MCP server.
 *
 * Returns `err` when the server is unknown, not in the `connected` state, or
 * does not advertise the resources capability on the LIVE connection / has
 * opted out via enableResources:false. The registry's conditional predicate
 * filters at tool-registration time, but a capability can disappear on
 * reconnect while the descriptor is still registered — so the gate is
 * re-enforced here at the RPC adapter layer. Any SDK throw is caught and
 * translated to `err` (never bubbles).
 */
export async function listResourcesForServer(
  manager: McpClientManager,
  server: string,
): Promise<Result<ResourceListEntry[], Error>> {
  const conn = manager.getConnection(server);
  if (!conn || conn.status !== "connected") {
    return err(new Error(`MCP server "${server}" not connected`));
  }
  if (!serverAdvertisesResources(conn.capabilities, conn.enableResources)) {
    return err(new Error(`MCP server "${server}" does not advertise resources capability`));
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
 *
 * Enforces the resources capability gate on the live connection AND rejects
 * SSRF-prone URI schemes (http/https/file) before delegating — the `uri` is
 * caller-controlled and a remote server could otherwise be driven to fetch
 * internal targets.
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
  if (!serverAdvertisesResources(conn.capabilities, conn.enableResources)) {
    return err(new Error(`MCP server "${server}" does not advertise resources capability`));
  }
  const scheme = uriScheme(uri);
  if (scheme !== undefined && BLOCKED_RESOURCE_SCHEMES.has(scheme)) {
    return err(
      new Error(
        `Resource URI scheme "${scheme}" is not allowed (http/https/file are blocked to prevent SSRF)`,
      ),
    );
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
 *
 * Re-enforces the prompts capability gate on the live connection
 * (see listResourcesForServer for the rationale).
 */
export async function listPromptsForServer(
  manager: McpClientManager,
  server: string,
): Promise<Result<PromptListEntry[], Error>> {
  const conn = manager.getConnection(server);
  if (!conn || conn.status !== "connected") {
    return err(new Error(`MCP server "${server}" not connected`));
  }
  if (!serverAdvertisesPrompts(conn.capabilities, conn.enablePrompts)) {
    return err(new Error(`MCP server "${server}" does not advertise prompts capability`));
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
  if (!serverAdvertisesPrompts(conn.capabilities, conn.enablePrompts)) {
    return err(new Error(`MCP server "${server}" does not advertise prompts capability`));
  }
  try {
    // The MCP SDK's getPrompt expects `arguments: Record<string,string>`,
    // but `args` arrives as Record<string, unknown> (the get_prompt platform
    // tool types its arguments as Type.Record(Type.String(), Type.Unknown())).
    // A blind `as Record<string, string>` cast would ship non-string values
    // (e.g. { count: 5 }) straight into the SDK, corrupting the call. Coerce
    // every value to string at the adapter boundary instead.
    const stringArgs =
      args !== undefined
        ? Object.fromEntries(
            Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]),
          )
        : undefined;
    const result = await conn.client.getPrompt({
      name,
      ...(stringArgs !== undefined && { arguments: stringArgs }),
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
