// SPDX-License-Identifier: Apache-2.0
import { resolveWorkspaceDir, type AppConfig } from "@comis/core";

/**
 * Build the `resolveWorkspaceDir` closure for the filesystem workspace-policy
 * adapter.
 *
 * The closure MUST read the LIVE daemon config on every call, never a config
 * object captured at construction. Two runtime rewrites replace the config the
 * daemon actually runs on after the adapter is built:
 *   1. Boot resolves `${secret}` refs by `structuredClone`-ing the whole config
 *      (secret-ref-resolver), so the object handed to the bootstrap factory is
 *      orphaned — a different `agents` map than `container.config.agents`.
 *   2. `agents.create` / `agents.update` hot-add and replace entries in the
 *      live `container.config.agents` map without a restart.
 * A closure that captured the bootstrap config misses both: a hot-added agent
 * resolves to `undefined`, the adapter returns `agent_not_found`, and the
 * executor fails the turn with a false "Workspace policy snapshot load failed"
 * error. Reading the live config mirrors the OAuth-profile closure in
 * setup-agents-oauth.ts.
 */
export function createWorkspacePolicyResolveDir(
  getConfig: () => AppConfig,
): (agentId: string) => string | undefined {
  return (agentId) => {
    const config = getConfig();
    const agentConfig = config.agents[agentId];
    return agentConfig === undefined
      ? undefined
      : resolveWorkspaceDir(agentConfig, agentId, config.dataDir || undefined);
  };
}
