// SPDX-License-Identifier: Apache-2.0
/**
 * Refresh credential-bearing MCP config fields for an explicit reconnect.
 *
 * The parsed runtime config contains secret values substituted at daemon boot.
 * `secrets.set` updates the live secret map without rewriting that parsed tree,
 * so reconnect must recover the raw refs from the active config layers and
 * resolve them again before replacing the child process.
 */

import {
  McpServerEntrySchema,
  deepMerge,
  findUnresolvedEnvRefs,
  formatMissingEnvRefError,
  loadConfigFile,
  substituteEnvVars,
} from "@comis/core";
import type { McpReconnectCredentials } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";
import { err, ok, type Result } from "@comis/shared";
import type { PersistToConfigDeps } from "./shared/persist-to-config.js";

interface ReconnectCredentialDeps {
  readonly persistDeps?: PersistToConfigDeps;
  readonly secretManager?: { get: (key: string) => string | undefined };
  readonly logger: ComisLogger;
}

function rawConfigPaths(deps: PersistToConfigDeps): readonly string[] {
  if (deps.configPaths.length > 0) return deps.configPaths;
  const fallback = deps.defaultConfigPaths.at(-1);
  return fallback === undefined ? [] : [fallback];
}

function readRawLayeredConfig(
  persistDeps: PersistToConfigDeps,
): Result<Record<string, unknown>, Error> {
  let merged: Record<string, unknown> = {};
  for (const configPath of rawConfigPaths(persistDeps)) {
    const loaded = loadConfigFile(configPath);
    if (!loaded.ok) {
      return err(new Error(
        `[mcp_reconnect_config_unreadable] ${loaded.error.message}`,
      ));
    }
    merged = deepMerge(merged, loaded.value);
  }
  return ok(merged);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function findRawServer(
  config: Record<string, unknown>,
  serverName: string,
): Result<ReturnType<typeof McpServerEntrySchema.parse> | undefined, Error> {
  const integrations = record(config["integrations"]);
  const mcp = record(integrations?.["mcp"]);
  const servers = mcp?.["servers"];
  if (!Array.isArray(servers)) return ok(undefined);
  const rawServer = servers.find((entry) => record(entry)?.["name"] === serverName);
  if (rawServer === undefined) return ok(undefined);

  const parsed = McpServerEntrySchema.safeParse(rawServer);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return err(new Error(
      `[mcp_reconnect_config_invalid] MCP server "${serverName}" has invalid persisted config: ${issues}`,
    ));
  }
  return ok(parsed.data);
}

export function findMcpServersReferencingSecret(
  persistDeps: PersistToConfigDeps,
  secretName: string,
): Result<readonly string[], Error> {
  const rawConfig = readRawLayeredConfig(persistDeps);
  if (!rawConfig.ok) return rawConfig;
  const integrations = record(rawConfig.value["integrations"]);
  const mcp = record(integrations?.["mcp"]);
  const servers = mcp?.["servers"];
  if (!Array.isArray(servers)) return ok([]);

  const referenced: string[] = [];
  for (const rawServer of servers) {
    const parsed = McpServerEntrySchema.safeParse(rawServer);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return err(new Error(
        `[mcp_secret_dependency_config_invalid] Invalid persisted MCP server config: ${issues}`,
      ));
    }
    if (!parsed.data.enabled) continue;
    const names = new Set(
      findUnresolvedEnvRefs(
        {
          env: parsed.data.env,
          headers: parsed.data.headers,
        },
        () => undefined,
      ).map((entry) => entry.varName),
    );
    if (names.has(secretName)) referenced.push(parsed.data.name);
  }
  return ok(referenced);
}

export function resolveMcpReconnectCredentials(
  deps: ReconnectCredentialDeps,
  serverName: string,
): Result<McpReconnectCredentials | undefined, Error> {
  if (!deps.persistDeps) return ok(undefined);

  const rawConfig = readRawLayeredConfig(deps.persistDeps);
  if (!rawConfig.ok) return rawConfig;
  const rawServer = findRawServer(rawConfig.value, serverName);
  if (!rawServer.ok) return rawServer;
  if (!rawServer.value) {
    deps.logger.debug(
      { step: "mcp-reconnect-credential-refresh", method: "mcp.reconnect", entityId: serverName },
      "No persisted MCP config found; reconnecting with stored runtime credentials",
    );
    return ok(undefined);
  }

  const credentialFields = {
    env: rawServer.value.env,
    headers: rawServer.value.headers,
  };
  const getSecret = (key: string): string | undefined => deps.secretManager?.get(key);
  const unresolved = findUnresolvedEnvRefs(credentialFields, getSecret);
  if (unresolved.length > 0) {
    return err(new Error(
      formatMissingEnvRefError(serverName, unresolved.map((entry) => entry.varName)),
    ));
  }

  const substituted = substituteEnvVars(
    credentialFields,
    getSecret,
    `mcp.reconnect credentials (${serverName})`,
  );
  if (!substituted.ok) {
    return err(new Error(substituted.error.message));
  }
  const resolved = substituted.value as {
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
  const refsResolved = [
    ...Object.values(credentialFields.env ?? {}),
    ...Object.values(credentialFields.headers ?? {}),
  ].filter((value) => /\$\{[^}]+\}/.test(value)).length;
  deps.logger.info(
    {
      method: "mcp.reconnect",
      entityId: serverName,
      envKeys: Object.keys(credentialFields.env ?? {}),
      headerKeys: Object.keys(credentialFields.headers ?? {}),
      refsResolved,
    },
    "MCP reconnect credentials refreshed from the current secret map",
  );
  return ok({
    env: resolved.env,
    headers: resolved.headers,
  });
}
