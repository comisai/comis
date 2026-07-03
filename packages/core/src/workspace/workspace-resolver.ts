// SPDX-License-Identifier: Apache-2.0
import type { AgentConfig } from "../config/schema-agent/index.js";
import { safePath } from "../security/safe-path.js";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the workspace directory for an agent.
 *
 * Resolution order:
 * 1. Explicit `workspacePath` from agent config (resolved to absolute)
 * 2. Default agent: `<baseDataDir>/workspace`
 * 3. Named agent: `<baseDataDir>/workspace-{agentId}`
 *
 * `baseDataDir` is the daemon's RESOLVED data dir (config.dataDir /
 * COMIS_DATA_DIR); absent/empty falls back to `~/.comis`. Threading the
 * resolved base (never hardcoding `~/.comis`) is load-bearing: a hardcoded
 * base would let isolated test daemons create `workspace-<agentId>` dirs
 * inside the production `~/.comis`, and a path shared across daemon
 * instances means a later run silently RESUMES an earlier run's degraded
 * session JSONL.
 *
 * Uses safePath() for agentId-derived paths as defense-in-depth
 * against traversal via agentId.
 */
export function resolveWorkspaceDir(
  config: AgentConfig,
  agentId?: string,
  baseDataDir?: string,
): string {
  // 1. Explicit workspace path in config takes priority
  if (config.workspacePath) {
    return path.resolve(config.workspacePath);
  }
  // 2. Base directory: resolved data dir, else ~/.comis
  const baseDir =
    baseDataDir && baseDataDir.length > 0
      ? baseDataDir
      : safePath(os.homedir(), ".comis");
  if (!agentId || agentId === "default") {
    return safePath(baseDir, "workspace");
  }
  // 3. Named agent gets suffixed workspace
  return safePath(baseDir, `workspace-${agentId}`);
}
