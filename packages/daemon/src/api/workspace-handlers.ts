// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
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
 *
 * Uses the `@comis/core` contract registry. Method keys are computed-property
 * names (`[WorkspaceStatusContract.method]:`) so the bidirectional 1:1
 * architecture test resolves them through `defineContract({ method, ... })`
 * declarations in `packages/core/src/api-contracts/workspace.ts`. The
 * dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)` (never
 * model internals in the contract schema). Each handler's admin trust
 * check reads `rawParams._trustLevel` BEFORE the strip step (the gate
 * stays separate from the contract schema). The bespoke pre-Zod
 * validation (admin gate, agentId / agent existence guard, filePath
 * presence guard, allowlist guards for subdir + fileName, file-size
 * guards) is intentionally retained for user-friendly error UX. The
 * contract parse runs AFTER and serves to (a) narrow params types for
 * the rest of the handler body and (b) provide a defense-in-depth gate
 * against future drift. The dev-mode `Contract.response.parse(...)`
 * gate before each return doubles as a shape-regression canary.
 *
 * @module
 */

import { AuthorizationError } from "./errors.js";
import {
  safePath,
  // Workspace helpers from @comis/core.
  getWorkspaceStatus,
  ensureWorkspace,
  DEFAULT_TEMPLATES,
  WORKSPACE_FILE_NAMES,
  WORKSPACE_SUBDIRS,
  type WorkspaceFileName,
  // Contract registry for the workspace umbrella (12 workspace.* + 13
  // browser.* + approval/skill/notification). The handler uses
  // computed-property method keys so the bidirectional 1:1 architecture
  // test sees the contract↔handler pairing.
  WorkspaceStatusContract,
  WorkspaceReadFileContract,
  WorkspaceWriteFileContract,
  WorkspaceDeleteFileContract,
  WorkspaceListDirContract,
  WorkspaceResetFileContract,
  WorkspaceInitContract,
  WorkspaceGitStatusContract,
  WorkspaceGitLogContract,
  WorkspaceGitDiffContract,
  WorkspaceGitCommitContract,
  WorkspaceGitRestoreContract,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
  systemNowDate,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import * as fs from "node:fs/promises";
import { dirname, relative } from "node:path";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: WorkspaceApiDeps (shared with browser, approval,
// mcp, skill, notification handlers).
import type { WorkspaceApiDeps as WorkspaceHandlerDeps } from "./types.js";
export type { WorkspaceHandlerDeps };

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse. Mirrors the gate pattern
 * used in auth-handlers / secrets-handlers / config-handlers / obs-handlers.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

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
    throw new AuthorizationError("Admin access required for workspace file writes");
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
    const ageMs = systemNowMs() - stat.mtimeMs;
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
    [WorkspaceStatusContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: agent presence + lookup (operator-friendly errors).
      validateAgent(deps, rawParams.agentId);
      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceStatusContract.request.parse(userParams);
      const dir = resolveAgentDir(deps, params.agentId);
      const result = await getWorkspaceStatus(dir);
      if (IS_DEV) WorkspaceStatusContract.response.parse(result);
      return result;
    },

    [WorkspaceReadFileContract.method]: async (rawParams) => {
      validateAgent(deps, rawParams.agentId);
      // Bespoke pre-Zod for filePath operator-friendly error.
      if (!rawParams.filePath || typeof rawParams.filePath !== "string") {
        throw new Error("Missing required parameter: filePath");
      }

      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceReadFileContract.request.parse(userParams);

      const dir = resolveAgentDir(deps, params.agentId);
      const resolvedPath = safePath(dir, params.filePath);
      const content = await fs.readFile(resolvedPath, "utf-8");
      const sizeBytes = Buffer.byteLength(content, "utf-8");

      if (sizeBytes > 1_048_576) {
        throw new Error("File exceeds 1MB read limit");
      }

      const result = { content, sizeBytes };
      if (IS_DEV) WorkspaceReadFileContract.response.parse(result);
      return result;
    },

    [WorkspaceWriteFileContract.method]: async (rawParams) => {
      requireAdmin(rawParams);

      validateAgent(deps, rawParams.agentId);

      if (!rawParams.filePath || typeof rawParams.filePath !== "string") {
        throw new Error("Missing required parameter: filePath");
      }

      if (
        rawParams.content === undefined ||
        rawParams.content === null ||
        typeof rawParams.content !== "string"
      ) {
        throw new Error("Missing required parameter: content");
      }

      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceWriteFileContract.request.parse(userParams);

      const sizeBytes = Buffer.byteLength(params.content, "utf-8");
      if (sizeBytes > 524_288) {
        throw new Error("Content exceeds 512KB write limit");
      }

      const dir = resolveAgentDir(deps, params.agentId);
      const resolvedPath = safePath(dir, params.filePath);
      // fs-safe-allowed: per-agent workspace dir is operator-configured (resolveAgentDir); not ~/.comis/ directly
      await fs.mkdir(dirname(resolvedPath), { recursive: true });
      // fs-safe-allowed: per-agent workspace dir; user content via workspace.writeFile RPC
      await fs.writeFile(resolvedPath, params.content, "utf-8");

      const result = { written: true as const, sizeBytes };
      if (IS_DEV) WorkspaceWriteFileContract.response.parse(result);
      return result;
    },

    [WorkspaceDeleteFileContract.method]: async (rawParams) => {
      requireAdmin(rawParams);

      validateAgent(deps, rawParams.agentId);

      if (!rawParams.filePath || typeof rawParams.filePath !== "string") {
        throw new Error("Missing required parameter: filePath");
      }

      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceDeleteFileContract.request.parse(userParams);

      const dir = resolveAgentDir(deps, params.agentId);
      const resolvedPath = safePath(dir, params.filePath);
      await fs.unlink(resolvedPath);

      // Best-effort memory cleanup: remove stale entries referencing the deleted file
      if (deps.memoryApi && deps.memoryAdapter && deps.tenantId) {
        try {
          const results = deps.memoryApi.inspect({
            tenantId: deps.tenantId,
            agentId: params.agentId,
            limit: 50,
          }).map((entry) => ({ entry }));
          const stale = results.filter((r) => r.entry.content.includes(params.filePath));
          for (const r of stale) {
            await deps.memoryAdapter.delete(r.entry.id, {
              tenantId: deps.tenantId,
              agentId: params.agentId,
            });
          }
        } catch (cleanupErr: unknown) {
          deps.logger.warn(
            {
              agentId: params.agentId,
              filePath: params.filePath,
              err: cleanupErr,
              hint: "File deleted but memory cleanup failed; stale entries may remain",
              errorKind: "internal" as const,
            },
            "Workspace deleteFile memory cleanup failed",
          );
        }
      }

      const result = { deleted: true as const };
      if (IS_DEV) WorkspaceDeleteFileContract.response.parse(result);
      return result;
    },

    [WorkspaceListDirContract.method]: async (rawParams) => {
      validateAgent(deps, rawParams.agentId);

      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceListDirContract.request.parse(userParams);

      const dir = resolveAgentDir(deps, params.agentId);
      let targetPath: string;

      if (params.subdir && params.subdir.length > 0) {
        if (!(WORKSPACE_SUBDIRS as readonly string[]).includes(params.subdir)) {
          throw new Error(`Directory not in allowlist: ${params.subdir}`);
        }
        targetPath = safePath(dir, params.subdir);
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

      const result = { entries };
      if (IS_DEV) WorkspaceListDirContract.response.parse(result);
      return result;
    },

    [WorkspaceResetFileContract.method]: async (rawParams) => {
      requireAdmin(rawParams);

      validateAgent(deps, rawParams.agentId);

      if (!rawParams.fileName || typeof rawParams.fileName !== "string") {
        throw new Error("Missing required parameter: fileName");
      }

      if (!(WORKSPACE_FILE_NAMES as readonly string[]).includes(rawParams.fileName)) {
        throw new Error(`Not a template file: ${rawParams.fileName}`);
      }

      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceResetFileContract.request.parse(userParams);

      const defaultContent = DEFAULT_TEMPLATES[params.fileName as WorkspaceFileName];
      const dir = resolveAgentDir(deps, params.agentId);
      const resolvedPath = safePath(dir, params.fileName);
      // fs-safe-allowed: per-agent workspace dir is operator-configured (resolveAgentDir); not ~/.comis/ directly
      await fs.writeFile(resolvedPath, defaultContent, "utf-8");

      const result = { reset: true as const, fileName: params.fileName };
      if (IS_DEV) WorkspaceResetFileContract.response.parse(result);
      return result;
    },

    [WorkspaceInitContract.method]: async (rawParams) => {
      requireAdmin(rawParams);

      validateAgent(deps, rawParams.agentId);

      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceInitContract.request.parse(userParams);

      const dir = resolveAgentDir(deps, params.agentId);
      await ensureWorkspace({ dir });

      const result = { initialized: true as const, dir };
      if (IS_DEV) WorkspaceInitContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------
    // Git handlers
    // -----------------------------------------------------------------

    [WorkspaceGitStatusContract.method]: async (rawParams) => {
      validateAgent(deps, rawParams.agentId);
      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceGitStatusContract.request.parse(userParams);
      const dir = resolveAgentDir(deps, params.agentId);
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

      const result = { branch, clean: entries.length === 0, entries };
      if (IS_DEV) WorkspaceGitStatusContract.response.parse(result);
      return result;
    },

    [WorkspaceGitLogContract.method]: async (rawParams) => {
      validateAgent(deps, rawParams.agentId);
      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceGitLogContract.request.parse(userParams);
      const dir = resolveAgentDir(deps, params.agentId);
      await assertGitRepo(dir);
      await cleanStaleLock(dir, deps.logger);

      const rawLimit = params.limit;
      const limit = Math.min(Math.max(rawLimit ?? 50, 1), 200);

      const gitResult = await deps.execGit(
        ["log", "--format=%H%n%an%n%aI%n%s", "-n", String(limit)],
        dir,
      );

      if (!gitResult.ok) {
        if (gitResult.error.includes("does not have any commits")) {
          const result = { commits: [] };
          if (IS_DEV) WorkspaceGitLogContract.response.parse(result);
          return result;
        }
        throw new Error(`Git log failed: ${gitResult.error}`);
      }

      if (!gitResult.value.trim()) {
        const result = { commits: [] };
        if (IS_DEV) WorkspaceGitLogContract.response.parse(result);
        return result;
      }

      // Parse 4-line groups: sha, author, date, message
      const lines = gitResult.value.trim().split("\n");
      const commits: Array<{ sha: string; author: string; date: string; message: string }> = [];
      for (let i = 0; i + 3 < lines.length; i += 4) {
        commits.push({
          sha: lines[i]!,
          author: lines[i + 1]!,
          date: lines[i + 2]!,
          message: lines[i + 3]!,
        });
      }

      const result = { commits };
      if (IS_DEV) WorkspaceGitLogContract.response.parse(result);
      return result;
    },

    [WorkspaceGitDiffContract.method]: async (rawParams) => {
      validateAgent(deps, rawParams.agentId);
      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceGitDiffContract.request.parse(userParams);
      const dir = resolveAgentDir(deps, params.agentId);
      await assertGitRepo(dir);
      await cleanStaleLock(dir, deps.logger);

      let args: string[];

      if (params.filePath && typeof params.filePath === "string") {
        // Per-file diff -- use -- separator to isolate path from options
        const safeDiffPath = safePath(dir, params.filePath);
        const relPath = relative(dir, safeDiffPath);
        args = ["diff", "--", relPath];
      } else {
        // Full working tree diff
        args = ["diff"];
      }

      const gitResult = await deps.execGit(args, dir);
      if (!gitResult.ok) throw new Error(`Git diff failed: ${gitResult.error}`);

      let diff = gitResult.value;
      // cap at 512KB
      if (Buffer.byteLength(diff, "utf-8") > MAX_DIFF_BYTES) {
        diff = diff.slice(0, MAX_DIFF_BYTES) + "\n\n[Diff truncated at 512KB]";
      }

      const result = { diff };
      if (IS_DEV) WorkspaceGitDiffContract.response.parse(result);
      return result;
    },

    [WorkspaceGitCommitContract.method]: async (rawParams) => {
      requireAdmin(rawParams);
      validateAgent(deps, rawParams.agentId);
      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceGitCommitContract.request.parse(userParams);
      const dir = resolveAgentDir(deps, params.agentId);
      await assertGitRepo(dir);
      await cleanStaleLock(dir, deps.logger);

      // Check for changes first
      const statusResult = await deps.execGit(["status", "--porcelain"], dir);
      if (!statusResult.ok) throw new Error(`Git status failed: ${statusResult.error}`);
      if (!statusResult.value.trim()) throw new Error("Nothing to commit");

      // Sanitize message
      const message = sanitizeCommitMessage(params.message);

      // Stage -- selective paths use -- separator to isolate paths from options
      const paths = params.paths;
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
        const fallback = {
          sha: "unknown",
          author: "unknown",
          date: systemNowDate().toISOString(),
          message,
        };
        if (IS_DEV) WorkspaceGitCommitContract.response.parse(fallback);
        return fallback;
      }

      const logLines = logResult.value.trim().split("\n");
      const result = {
        sha: logLines[0] ?? "unknown",
        author: logLines[1] ?? "unknown",
        date: logLines[2] ?? systemNowDate().toISOString(),
        message: logLines[3] ?? message,
      };
      if (IS_DEV) WorkspaceGitCommitContract.response.parse(result);
      return result;
    },

    [WorkspaceGitRestoreContract.method]: async (rawParams) => {
      requireAdmin(rawParams);
      validateAgent(deps, rawParams.agentId);

      if (!rawParams.filePath || typeof rawParams.filePath !== "string") {
        throw new Error("Missing required parameter: filePath");
      }

      const userParams = stripInternalFields(rawParams);
      const params = WorkspaceGitRestoreContract.request.parse(userParams);

      const dir = resolveAgentDir(deps, params.agentId);
      await assertGitRepo(dir);
      await cleanStaleLock(dir, deps.logger);

      // Validate path -- use -- separator to isolate path from options
      const safeRestorePath = safePath(dir, params.filePath);
      const relPath = relative(dir, safeRestorePath);

      const gitResult = await deps.execGit(["checkout", "HEAD", "--", relPath], dir);
      if (!gitResult.ok) {
        if (gitResult.error.includes("pathspec") && gitResult.error.includes("did not match")) {
          throw new Error("File has no committed version");
        }
        throw new Error(`Git restore failed: ${gitResult.error}`);
      }

      const result = { restored: true as const };
      if (IS_DEV) WorkspaceGitRestoreContract.response.parse(result);
      return result;
    },
  };
}
