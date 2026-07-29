// SPDX-License-Identifier: Apache-2.0
import { rm } from "node:fs/promises";
import { resolveWorkspaceDir } from "@comis/core";
import { fromPromise, ok, type Result } from "@comis/shared";

export interface AgentWorkspaceCleanupResult {
  readonly disposition: "removed" | "preserved_external";
}

/**
 * Remove only the daemon-managed workspace assigned to a deleted named agent.
 *
 * An operator-supplied workspace can point anywhere on the host and is never a
 * safe recursive-delete target. Runtime-created agents cannot set
 * `workspacePath`, so their resolved path is exactly
 * `<dataDir>/workspace-<agentId>` and can be removed after destructive-action
 * approval and config persistence have succeeded.
 */
export async function removeManagedAgentWorkspace(input: {
  readonly agentId: string;
  readonly workspaceDir: string;
  readonly dataDir: string;
}): Promise<Result<AgentWorkspaceCleanupResult, Error>> {
  const managedWorkspaceDir = resolveWorkspaceDir(
    {} as Parameters<typeof resolveWorkspaceDir>[0],
    input.agentId,
    input.dataDir,
  );
  if (input.workspaceDir !== managedWorkspaceDir) {
    return ok({ disposition: "preserved_external" });
  }

  const removed = await fromPromise(
    rm(managedWorkspaceDir, { recursive: true, force: true }),
  );
  if (!removed.ok) return removed;
  return ok({ disposition: "removed" });
}
