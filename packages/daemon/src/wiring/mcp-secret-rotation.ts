// SPDX-License-Identifier: Apache-2.0
/**
 * Targeted MCP child lifecycle updates for referenced secret changes.
 *
 * Runtime MCP children receive resolved credential values at spawn. The raw
 * persisted config retains `${VAR}` references, so it is the authority for
 * deciding which children depend on a changed secret. Rotations reconnect only
 * those children; removals disconnect them. Both paths make the old child
 * unavailable synchronously before awaiting transport close.
 */

import { systemNowMs, type TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { McpClientManager } from "@comis/skills";
import { fromPromise, suppressError } from "@comis/shared";
import {
  findMcpServersReferencingSecret,
  resolveMcpReconnectCredentials,
} from "../api/mcp-reconnect-credentials.js";
import type { PersistToConfigDeps } from "../api/shared/persist-to-config.js";

export interface McpSecretRotationDeps {
  readonly eventBus: TypedEventBus;
  readonly mcpClientManager: McpClientManager;
  readonly persistDeps: PersistToConfigDeps;
  readonly secretManager: { get: (key: string) => string | undefined };
  readonly logger: ComisLogger;
}

type SecretChangeAction = "upserted" | "removed";
type DisconnectReason = "credential_rotation" | "credential_removed";

function emitCredentialDisconnect(
  deps: McpSecretRotationDeps,
  serverName: string,
  reason: DisconnectReason,
): void {
  deps.eventBus.emit("mcp:server:disconnected", {
    serverName,
    reason,
    timestamp: systemNowMs(),
  });
}

async function disconnectReferencedServer(
  deps: McpSecretRotationDeps,
  serverName: string,
  secretName: string,
  action: SecretChangeAction,
): Promise<void> {
  const startedMs = systemNowMs();
  emitCredentialDisconnect(
    deps,
    serverName,
    action === "removed" ? "credential_removed" : "credential_rotation",
  );
  const disconnected = await fromPromise(
    deps.mcpClientManager.disconnect(serverName),
  );
  const durationMs = systemNowMs() - startedMs;
  if (!disconnected.ok) {
    deps.logger.warn(
      {
        serverName,
        secretName,
        action,
        durationMs,
        err: disconnected.error,
        hint: `Retry MCP server "${serverName}" shutdown after correcting secret "${secretName}"`,
        errorKind: "dependency" as const,
      },
      "MCP child disconnect after secret change failed",
    );
    return;
  }
  deps.logger.info(
    { serverName, secretName, action, durationMs },
    "MCP child disconnected after referenced secret removal",
  );
}

async function reconnectReferencedServer(
  deps: McpSecretRotationDeps,
  serverName: string,
  secretName: string,
): Promise<void> {
  const refreshed = resolveMcpReconnectCredentials(
    {
      persistDeps: deps.persistDeps,
      secretManager: deps.secretManager,
      logger: deps.logger,
    },
    serverName,
  );
  if (!refreshed.ok || refreshed.value === undefined) {
    deps.logger.warn(
      {
        serverName,
        secretName,
        err: refreshed.ok ? "Persisted MCP credential refs unavailable" : refreshed.error,
        hint: `Correct the persisted env/header references for MCP server "${serverName}" and run mcp_manage reconnect`,
        errorKind: "config" as const,
      },
      "MCP credential refresh could not resolve the current secret",
    );
    await disconnectReferencedServer(
      deps,
      serverName,
      secretName,
      "upserted",
    );
    return;
  }

  const startedMs = systemNowMs();
  emitCredentialDisconnect(deps, serverName, "credential_rotation");
  const invoked = await fromPromise(
    deps.mcpClientManager.reconnect(serverName, refreshed.value),
  );
  const durationMs = systemNowMs() - startedMs;
  if (!invoked.ok) {
    deps.logger.warn(
      {
        serverName,
        secretName,
        durationMs,
        err: invoked.error,
        hint: `Verify secret "${secretName}" for MCP server "${serverName}", then run mcp_manage reconnect`,
        errorKind: "dependency" as const,
      },
      "MCP child reconnect after secret rotation failed",
    );
    return;
  }
  if (!invoked.value.ok) {
    deps.logger.warn(
      {
        serverName,
        secretName,
        durationMs,
        err: invoked.value.error,
        hint: `Verify secret "${secretName}" for MCP server "${serverName}", then run mcp_manage reconnect`,
        errorKind: "dependency" as const,
      },
      "MCP child reconnect after secret rotation failed",
    );
    return;
  }
  deps.logger.info(
    {
      serverName,
      secretName,
      durationMs,
      toolCount: invoked.value.value.tools.length,
    },
    "MCP child refreshed after referenced secret rotation",
  );
}

async function handleSecretChange(
  deps: McpSecretRotationDeps,
  name: string,
  action: SecretChangeAction,
): Promise<void> {
  const referenced = findMcpServersReferencingSecret(deps.persistDeps, name);
  if (!referenced.ok) {
    deps.logger.error(
      {
        secretName: name,
        action,
        err: referenced.error,
        hint: "Repair the active config paths; connected MCP children were disconnected to prevent stale credential use",
        errorKind: "config" as const,
      },
      "MCP secret dependency map could not be read",
    );
    const allActive = deps.mcpClientManager
      .getAllConnections()
      .filter((connection) => connection.status === "connected");
    await Promise.all(
      allActive.map((connection) =>
        disconnectReferencedServer(deps, connection.name, name, action),
      ),
    );
    return;
  }

  const activeNames = referenced.value.filter(
    (serverName) => deps.mcpClientManager.getConnection(serverName) !== undefined,
  );
  if (action === "removed") {
    await Promise.all(
      activeNames.map((serverName) =>
        disconnectReferencedServer(deps, serverName, name, action),
      ),
    );
    return;
  }
  await Promise.all(
    activeNames.map((serverName) =>
      reconnectReferencedServer(deps, serverName, name),
    ),
  );
}

export function wireMcpSecretRotation(deps: McpSecretRotationDeps): void {
  deps.eventBus.on("secret:changed", ({ name, action }) => {
    suppressError(
      handleSecretChange(deps, name, action),
      "MCP referenced-secret lifecycle refresh",
      (message) => deps.logger.error(
        {
          secretName: name,
          action,
          hint: "Inspect the active MCP config and reconnect affected servers manually",
          errorKind: "internal" as const,
        },
        message,
      ),
    );
  });
}
