/**
 * Workspace file and git management RPC handlers.
 * Provides 12 workspace methods for operator-side management:
 *   File: workspace.status, workspace.readFile, workspace.writeFile,
 *         workspace.deleteFile, workspace.listDir, workspace.resetFile,
 *         workspace.init
 *   Git:  workspace.git.status, workspace.git.log, workspace.git.diff,
 *         workspace.git.commit, workspace.git.restore
 * Write/delete/reset/init/commit/restore require admin scope. All file
 * operations use safePath for traversal prevention. All git pathspecs
 * use -- separator to prevent flag injection.
 * @module
 */

import type { ExecGitFn, PerAgentConfig } from "@comis/core";
import { safePath } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { MemoryApi, SqliteMemoryAdapter } from "@comis/memory";
import {
  getWorkspaceStatus,
  ensureWorkspace,
  DEFAULT_TEMPLATES,
  WORKSPACE_FILE_NAMES,
  WORKSPACE_SUBDIRS,
  type WorkspaceFileName,
} from "@comis/agent";
import * as fs from "node:fs/promises";
import { dirname, relative } from "node:path";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by workspace RPC handlers. */
export interface WorkspaceHandlerDeps {
  agents: Record<string, PerAgentConfig>;
  workspaceDirs: Map<string, string>;
  defaultWorkspaceDir: string;
  logger: ComisLogger;
  execGit: ExecGitFn;
  memoryApi?: MemoryApi;
  memoryAdapter?: SqliteMemoryAdapter;
  tenantId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAgentDir(deps: WorkspaceHandlerDeps, agentId: string): string {
  return deps.workspaceDirs.get(agentId) ?? deps.defaultWorkspaceDir;
}

function validateAgent(deps: WorkspaceHandlerDeps, agentId: unknown): asserts agentId is string {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("Missing required parameter: agentId");
  }
  if (!deps.agents[agentId]) {
    throw new Error(`Agent not found: ${agentId}`);
  }
}

function requireAdmin(params: Record<string, unknown>): void {
  if (params._trustLevel !== "admin") {
    throw new Error("Admin access required for workspace file writes");
  }
}

// ---------------------------------------------------------------------------
// Git constants
// ---------------------------------------------------------------------------

const STALE_LOCK_THRESHOLD_MS = 30_000;
const DEFAULT_COMMIT_MESSAGE = "Operator commit via web console";
const MAX_COMMIT_MESSAGE_LENGTH = 500;
const MAX_DIFF_BYTES = 524_288;

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Verify .git/ exists -- no auto-init. */
async function assertGitRepo(dir: string): Promise<void> {
  try {
    await fs.access(safePath(dir, ".git"));
  } catch {
    throw new Error("No git repository in workspace. Initialize with workspace.init first.");
  }
}

/** Clean stale .git/index.lock older than 30s. */
async function cleanStaleLock(dir: string, logger: ComisLogger): Promise<void> {
  const lockPath = safePath(dir, ".git", "index.lock");
  try {
    const stat = await fs.stat(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALE_LOCK_THRESHOLD_MS) {
      await fs.unlink(lockPath);
      logger.warn(
        {
          lockPath,
          ageMs,
          hint: "Stale git index.lock removed; previous git operation likely timed out",
          errorKind: "internal" as const,
        },
        "Cleaned stale git index.lock",
      );
    }
  } catch {
    // No lock file -- normal case, continue silently
  }
}

/** Parse a single line of `git status --porcelain` output. */
function parseStatusLine(line: string): { path: string; status: string; staged: boolean } | null {
  if (line.length < 4) return null;
  const x = line[0]!; // index (staged) status
  const y = line[1]!; // worktree (unstaged) status
  const filePath = line.slice(3);

  if (x === "?" && y === "?") return { path: filePath, status: "untracked", staged: false };
  if (x === "D") return { path: filePath, status: "deleted", staged: true };
  if (y === "D") return { path: filePath, status: "deleted", staged: false };
  if (x === "A") return { path: filePath, status: "added", staged: true };
  if (x === "R") return { path: filePath.split(" -> ").pop()!, status: "renamed", staged: true };
  if (x === "C") return { path: filePath, status: "copied", staged: true };
  if (x === "M") return { path: filePath, status: "modified", staged: true };
  if (y === "M") return { path: filePath, status: "modified", staged: false };
  return { path: filePath, status: "modified", staged: false };
}

/** Sanitize operator commit messages -- strip control chars, truncate to 500. */
function sanitizeCommitMessage(raw: string | undefined): string {
  if (!raw || typeof raw !== "string") return DEFAULT_COMMIT_MESSAGE;

  let msg = raw
    // eslint-disable-next-line no-control-regex -- intentional: strip control chars except \n (0x0a)
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
    .trim();

  if (msg.length === 0) return DEFAULT_COMMIT_MESSAGE;
  if (msg.length > MAX_COMMIT_MESSAGE_LENGTH) msg = msg.slice(0, MAX_COMMIT_MESSAGE_LENGTH);

  return msg;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create workspace file RPC handlers.
 * @param deps - Injected dependencies
 * @returns Record mapping method names to handler functions
 */
export function createWorkspaceHandlers(deps: WorkspaceHandlerDeps): Record<string, RpcHandler> {
  return {
    "workspace.status": async (params) => {
      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);
      const dir = resolveAgentDir(deps, agentId);
      return getWorkspaceStatus(dir);
    },

    "workspace.readFile": async (params) => {
      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);

      const filePath = params.filePath as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        throw new Error("Missing required parameter: filePath");
      }

      const dir = resolveAgentDir(deps, agentId);
      const resolvedPath = safePath(dir, filePath);
      const content = await fs.readFile(resolvedPath, "utf-8");
      const sizeBytes = Buffer.byteLength(content, "utf-8");

      if (sizeBytes > 1_048_576) {
        throw new Error("File exceeds 1MB read limit");
      }

      return { content, sizeBytes };
    },

    "workspace.writeFile": async (params) => {
      requireAdmin(params);

      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);

      const filePath = params.filePath as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        throw new Error("Missing required parameter: filePath");
      }

      const content = params.content as string | undefined;
      if (content === undefined || content === null || typeof content !== "string") {
        throw new Error("Missing required parameter: content");
      }

      const sizeBytes = Buffer.byteLength(content, "utf-8");
      if (sizeBytes > 524_288) {
        throw new Error("Content exceeds 512KB write limit");
      }

      const dir = resolveAgentDir(deps, agentId);
      const resolvedPath = safePath(dir, filePath);
      await fs.mkdir(dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, "utf-8");

      return { written: true, sizeBytes };
    },

    "workspace.deleteFile": async (params) => {
      requireAdmin(params);

      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);

      const filePath = params.filePath as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        throw new Error("Missing required parameter: filePath");
      }

      const dir = resolveAgentDir(deps, agentId);
      const resolvedPath = safePath(dir, filePath);
      await fs.unlink(resolvedPath);

      // Best-effort memory cleanup: remove stale entries referencing the deleted file
      if (deps.memoryApi && deps.memoryAdapter && deps.tenantId) {
        try {
          const results = await deps.memoryApi.search(filePath, {
            tenantId: deps.tenantId,
            agentId,
            limit: 50,
          });
          const stale = results.filter((r) => r.entry.content.includes(filePath));
          for (const r of stale) {
            await deps.memoryAdapter.delete(r.entry.id, deps.tenantId);
          }
        } catch (cleanupErr: unknown) {
          deps.logger.warn(
            {
              agentId,
              filePath,
              err: cleanupErr,
              hint: "File deleted but memory cleanup failed; stale entries may remain",
              errorKind: "internal" as const,
            },
            "Workspace deleteFile memory cleanup failed",
          );
        }
      }

      return { deleted: true };
    },

    "workspace.listDir": async (params) => {
      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);

      const subdir = params.subdir as string | undefined;
      const dir = resolveAgentDir(deps, agentId);
      let targetPath: string;

      if (subdir && subdir.length > 0) {
        if (!(WORKSPACE_SUBDIRS as readonly string[]).includes(subdir)) {
          throw new Error(`Directory not in allowlist: ${subdir}`);
        }
        targetPath = safePath(dir, subdir);
      } else {
        targetPath = dir;
      }

      const dirents = await fs.readdir(targetPath, { withFileTypes: true });
      const entries: Array<{
        name: string;
        type: "file" | "directory";
        sizeBytes?: number;
        modifiedAt: number;
      }> = [];

      for (const dirent of dirents) {
        const entryPath = safePath(targetPath, dirent.name);
        const stat = await fs.stat(entryPath);
        entries.push({
          name: dirent.name,
          type: dirent.isDirectory() ? "directory" : "file",
          ...(dirent.isFile() ? { sizeBytes: stat.size } : {}),
          modifiedAt: stat.mtimeMs,
        });
      }

      return { entries };
    },

    "workspace.resetFile": async (params) => {
      requireAdmin(params);

      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);

      const fileName = params.fileName as string | undefined;
      if (!fileName || typeof fileName !== "string") {
        throw new Error("Missing required parameter: fileName");
      }

      if (!(WORKSPACE_FILE_NAMES as readonly string[]).includes(fileName)) {
        throw new Error(`Not a template file: ${fileName}`);
      }

      const defaultContent = DEFAULT_TEMPLATES[fileName as WorkspaceFileName];
      const dir = resolveAgentDir(deps, agentId);
      const resolvedPath = safePath(dir, fileName);
      await fs.writeFile(resolvedPath, defaultContent, "utf-8");

      return { reset: true, fileName };
    },

    "workspace.init": async (params) => {
      requireAdmin(params);

      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);

      const dir = resolveAgentDir(deps, agentId);
      await ensureWorkspace({ dir });

      return { initialized: true, dir };
    },

    // -----------------------------------------------------------------
    // Git handlers
    // -----------------------------------------------------------------

    "workspace.git.status": async (params) => {
      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);
      const dir = resolveAgentDir(deps, agentId);
      await assertGitRepo(dir);
      await cleanStaleLock(dir, deps.logger);

      // Branch name (detached HEAD fallback)
      const branchResult = await deps.execGit(["branch", "--show-current"], dir);
      const branch =
        branchResult.ok && branchResult.value.trim()
          ? branchResult.value.trim()
          : "HEAD (detached)";

      // Working tree status
      const statusResult = await deps.execGit(["status", "--porcelain"], dir);
      if (!statusResult.ok) throw new Error(`Git status failed: ${statusResult.error}`);

      const entries = statusResult.value
        .split("\n")
        .filter(Boolean)
        .map(parseStatusLine)
        .filter((e): e is NonNullable<typeof e> => e !== null);

      return { branch, clean: entries.length === 0, entries };
    },

    "workspace.git.log": async (params) => {
      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);
      const dir = resolveAgentDir(deps, agentId);
      await assertGitRepo(dir);
      await cleanStaleLock(dir, deps.logger);

      const rawLimit = params.limit as number | undefined;
      const limit = Math.min(Math.max(rawLimit ?? 50, 1), 200);

      const result = await deps.execGit(
        ["log", "--format=%H%n%an%n%aI%n%s", "-n", String(limit)],
        dir,
      );

      if (!result.ok) {
        if (result.error.includes("does not have any commits")) {
          return { commits: [] };
        }
        throw new Error(`Git log failed: ${result.error}`);
      }

      if (!result.value.trim()) return { commits: [] };

      // Parse 4-line groups: sha, author, date, message
      const lines = result.value.trim().split("\n");
      const commits: Array<{ sha: string; author: string; date: string; message: string }> = [];
      for (let i = 0; i + 3 < lines.length; i += 4) {
        commits.push({
          sha: lines[i]!,
          author: lines[i + 1]!,
          date: lines[i + 2]!,
          message: lines[i + 3]!,
        });
      }

      return { commits };
    },

    "workspace.git.diff": async (params) => {
      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);
      const dir = resolveAgentDir(deps, agentId);
      await assertGitRepo(dir);
      await cleanStaleLock(dir, deps.logger);

      const filePath = params.filePath as string | undefined;
      let args: string[];

      if (filePath && typeof filePath === "string") {
        // Per-file diff -- use -- separator to isolate path from options
        const safeDiffPath = safePath(dir, filePath);
        const relPath = relative(dir, safeDiffPath);
        args = ["diff", "--", relPath];
      } else {
        // Full working tree diff
        args = ["diff"];
      }

      const result = await deps.execGit(args, dir);
      if (!result.ok) throw new Error(`Git diff failed: ${result.error}`);

      let diff = result.value;
      // cap at 512KB
      if (Buffer.byteLength(diff, "utf-8") > MAX_DIFF_BYTES) {
        diff = diff.slice(0, MAX_DIFF_BYTES) + "\n\n[Diff truncated at 512KB]";
      }

      return { diff };
    },

    "workspace.git.commit": async (params) => {
      requireAdmin(params);
      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);
      const dir = resolveAgentDir(deps, agentId);
      await assertGitRepo(dir);
      await cleanStaleLock(dir, deps.logger);

      // Check for changes first
      const statusResult = await deps.execGit(["status", "--porcelain"], dir);
      if (!statusResult.ok) throw new Error(`Git status failed: ${statusResult.error}`);
      if (!statusResult.value.trim()) throw new Error("Nothing to commit");

      // Sanitize message
      const message = sanitizeCommitMessage(params.message as string | undefined);

      // Stage -- selective paths use -- separator to isolate paths from options
      const paths = params.paths as string[] | undefined;
      if (paths && Array.isArray(paths) && paths.length > 0) {
        for (const p of paths) {
          const safeP = safePath(dir, p);
          const relP = relative(dir, safeP);
          const addResult = await deps.execGit(["add", "--", relP], dir);
          if (!addResult.ok) throw new Error(`Git add failed for ${relP}: ${addResult.error}`);
        }
      } else {
        const addResult = await deps.execGit(["add", "-A"], dir);
        if (!addResult.ok) throw new Error(`Git add failed: ${addResult.error}`);
      }

      // Commit
      const commitResult = await deps.execGit(["commit", "-m", message], dir);
      if (!commitResult.ok) {
        if (commitResult.error.includes("nothing to commit")) {
          throw new Error("Nothing to commit");
        }
        throw new Error(`Git commit failed: ${commitResult.error}`);
      }

      // Get new commit info
      const logResult = await deps.execGit(
        ["log", "--format=%H%n%an%n%aI%n%s", "-n", "1"],
        dir,
      );
      if (!logResult.ok) {
        return {
          sha: "unknown",
          author: "unknown",
          date: new Date().toISOString(),
          message,
        };
      }

      const logLines = logResult.value.trim().split("\n");
      return {
        sha: logLines[0] ?? "unknown",
        author: logLines[1] ?? "unknown",
        date: logLines[2] ?? new Date().toISOString(),
        message: logLines[3] ?? message,
      };
    },

    "workspace.git.restore": async (params) => {
      requireAdmin(params);
      const agentId = params.agentId as string | undefined;
      validateAgent(deps, agentId);

      const filePath = params.filePath as string | undefined;
      if (!filePath || typeof filePath !== "string") {
        throw new Error("Missing required parameter: filePath");
      }

      const dir = resolveAgentDir(deps, agentId);
      await assertGitRepo(dir);
      await cleanStaleLock(dir, deps.logger);

      // Validate path -- use -- separator to isolate path from options
      const safeRestorePath = safePath(dir, filePath);
      const relPath = relative(dir, safeRestorePath);

      const result = await deps.execGit(["checkout", "HEAD", "--", relPath], dir);
      if (!result.ok) {
        if (result.error.includes("pathspec") && result.error.includes("did not match")) {
          throw new Error("File has no committed version");
        }
        throw new Error(`Git restore failed: ${result.error}`);
      }

      return { restored: true };
    },
  };
}
