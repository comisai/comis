// SPDX-License-Identifier: Apache-2.0
// Relocated from @comis/agent in Phase 35 per WEB-CONTRACTS-02 D-01 #5.
import type { AgentConfig } from "../config/schema-agent/index.js";
import { safePath } from "../security/safe-path.js";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the workspace directory for an agent.
 *
 * Resolution order:
 * 1. Explicit `workspacePath` from agent config (resolved to absolute)
 * 2. Default agent: `~/.comis/workspace`
 * 3. Named agent: `~/.comis/workspace-{agentId}`
 *
 * Uses safePath() for agentId-derived paths as defense-in-depth
 * against traversal via agentId.
 */
export function resolveWorkspaceDir(config: AgentConfig, agentId?: string): string {
  // 1. Explicit workspace path in config takes priority
  if (config.workspacePath) {
    return path.resolve(config.workspacePath);
  }
  // 2. Default base directory: ~/.comis
  const baseDir = safePath(os.homedir(), ".comis");
  if (!agentId || agentId === "default") {
    return safePath(baseDir, "workspace");
  }
  // 3. Named agent gets suffixed workspace
  return safePath(baseDir, `workspace-${agentId}`);
}
