// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace-handlers contract slice.
 *
 * Mirrors `packages/daemon/src/api/workspace-handlers.ts` (12 methods).
 * Spread order in `WORKSPACE_HANDLERS_CONTRACTS` is locked in to keep
 * `contracts.generated.*` artifacts byte-identical across runs.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";

// ===========================================================================
// Shared sub-schemas (allowlist shapes only).
// ===========================================================================

/**
 * Loose-record value type. Used for response shapes whose nested
 * structure varies per call (Snapshot ref maps, WorkspaceStatus state
 * blocks, etc.) and where tight modeling would pin every sub-field's
 * wire format. Mirrors the precedent in
 * `packages/core/src/api-contracts/observability.ts`.
 */
const LooseRecord = z.record(z.string(), z.unknown());

/**
 * Workspace.listDir entry shape — directory listing row. Modeled tight
 * because the shape is fully primitive at the leaves and the handler
 * builds it explicitly.
 *
 * `type` is the discriminator (`"file" | "directory"`) — modeled via
 * `z.enum`. `sizeBytes` is present only on files (conditional spread).
 * `modifiedAt` is the mtime in epoch-milliseconds.
 */
const WorkspaceListEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "directory"]),
  sizeBytes: z.number().optional(),
  modifiedAt: z.number(),
});

/**
 * Workspace.git.status entry — file-level git status row. Modeled tight
 * (handler's `parseStatusLine`). The handler emits 7 distinct `status`
 * values:
 *   - "untracked" (both x + y are "?")
 *   - "deleted" (x or y is "D")
 *   - "added" (x is "A")
 *   - "renamed" (x is "R")
 *   - "copied" (x is "C")
 *   - "modified" (x or y is "M" or fallback)
 *
 * `staged` is true when the change is in the index (x position),
 * false when only in the worktree (y position).
 */
const WorkspaceGitStatusEntrySchema = z.object({
  path: z.string(),
  status: z.enum([
    "untracked",
    "deleted",
    "added",
    "renamed",
    "copied",
    "modified",
  ]),
  staged: z.boolean(),
});

/**
 * Workspace.git.log commit entry. Tight model — 4 string fields. All
 * fields are required because the handler always populates them from
 * parsed git-log output.
 */
const WorkspaceGitCommitSchema = z.object({
  sha: z.string(),
  author: z.string(),
  date: z.string(),
  message: z.string(),
});

// ===========================================================================
// --- workspace-handlers.ts ---
// ===========================================================================

/**
 * `workspace.status` — return the WorkspaceStatus for an agent's
 * workspace directory (existence, file presence list, git-repo flag,
 * bootstrap-state flag, optional state snapshot). RPC scope.
 *
 * Request: `{ agentId }`. The bespoke guard in the handler produces
 * "Missing required parameter: agentId" / "Agent not found".
 *
 * Response: loose record. The underlying `WorkspaceStatus` shape
 * (`@comis/core/workspace/workspace-manager.ts`) carries 6 fields
 * including a nested optional `state` block; modeling tighter would pin
 * the WorkspaceState wire format across daemon restarts.
 */
export const WorkspaceStatusContract = defineContract({
  method: "workspace.status",
  request: z.object({
    agentId: z.string().min(1),
  }),
  response: LooseRecord,
  scopes: ["rpc"] as const,
});

/**
 * `workspace.readFile` — read a file from the agent's workspace,
 * cap-enforced (1 MiB). RPC scope. The bespoke guard produces
 * "Missing required parameter: filePath"; `safePath(...)` rejects path
 * traversal.
 *
 * Response: `{ content: string, sizeBytes: number }`.
 */
export const WorkspaceReadFileContract = defineContract({
  method: "workspace.readFile",
  request: z.object({
    agentId: z.string().min(1),
    filePath: z.string().min(1),
  }),
  response: z.object({
    content: z.string(),
    sizeBytes: z.number(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `workspace.writeFile` — write a file within the agent's workspace,
 * cap-enforced (512 KiB). ADMIN scope. The bespoke guards produce
 * operator-friendly errors; `safePath(...)` rejects path traversal.
 *
 * Response: `{ written: true, sizeBytes: number }`.
 */
export const WorkspaceWriteFileContract = defineContract({
  method: "workspace.writeFile",
  request: z.object({
    agentId: z.string().min(1),
    filePath: z.string().min(1),
    content: z.string(),
  }),
  response: z.object({
    written: z.literal(true),
    sizeBytes: z.number(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `workspace.deleteFile` — delete a file from the workspace. Triggers
 * a best-effort memory cleanup pass to remove stale entries that
 * referenced the deleted file. ADMIN scope.
 *
 * Response: `{ deleted: true }`.
 */
export const WorkspaceDeleteFileContract = defineContract({
  method: "workspace.deleteFile",
  request: z.object({
    agentId: z.string().min(1),
    filePath: z.string().min(1),
  }),
  response: z.object({
    deleted: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

/**
 * `workspace.listDir` — list entries within the workspace root OR a
 * named subdirectory (allowlisted via WORKSPACE_SUBDIRS). RPC scope.
 *
 * Request: `{ agentId, subdir? }`. When `subdir` is absent or empty
 * the handler lists the root workspace dir.
 *
 * Response: `{ entries: WorkspaceListEntry[] }`.
 */
export const WorkspaceListDirContract = defineContract({
  method: "workspace.listDir",
  request: z.object({
    agentId: z.string().min(1),
    subdir: z.string().optional(),
  }),
  response: z.object({
    entries: z.array(WorkspaceListEntrySchema),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `workspace.resetFile` — restore a workspace template file to its
 * default content. ADMIN scope. `fileName` must be in
 * `WORKSPACE_FILE_NAMES` (BOOTSTRAP.md, CLAUDE.md, etc.).
 *
 * Response: `{ reset: true, fileName }`.
 */
export const WorkspaceResetFileContract = defineContract({
  method: "workspace.resetFile",
  request: z.object({
    agentId: z.string().min(1),
    fileName: z.string().min(1),
  }),
  response: z.object({
    reset: z.literal(true),
    fileName: z.string(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `workspace.init` — ensure the workspace directory tree exists and
 * is populated with default templates. ADMIN scope. Idempotent
 * (write-if-missing semantics).
 *
 * Response: `{ initialized: true, dir }`.
 */
export const WorkspaceInitContract = defineContract({
  method: "workspace.init",
  request: z.object({
    agentId: z.string().min(1),
  }),
  response: z.object({
    initialized: z.literal(true),
    dir: z.string(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `workspace.git.status` — branch + porcelain status list for the
 * workspace's git repo. RPC scope. Requires `.git/` to exist
 * (assertGitRepo guard in the handler).
 *
 * Response: `{ branch, clean, entries[] }`. `branch` is the current
 * branch name OR `"HEAD (detached)"` when not on a branch.
 */
export const WorkspaceGitStatusContract = defineContract({
  method: "workspace.git.status",
  request: z.object({
    agentId: z.string().min(1),
  }),
  response: z.object({
    branch: z.string(),
    clean: z.boolean(),
    entries: z.array(WorkspaceGitStatusEntrySchema),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `workspace.git.log` — git log of the workspace repo, capped at 200
 * commits, default 50. RPC scope. Returns `{ commits: [] }` when the
 * repo has no commits (graceful).
 *
 * Response: `{ commits: WorkspaceGitCommit[] }`.
 */
export const WorkspaceGitLogContract = defineContract({
  method: "workspace.git.log",
  request: z.object({
    agentId: z.string().min(1),
    limit: z.number().optional(),
  }),
  response: z.object({
    commits: z.array(WorkspaceGitCommitSchema),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `workspace.git.diff` — git diff of the workspace working tree
 * (optionally scoped to a file path). Output capped at 512 KiB; a
 * truncation banner is appended when the diff exceeds the cap. RPC
 * scope.
 *
 * Response: `{ diff: string }`.
 */
export const WorkspaceGitDiffContract = defineContract({
  method: "workspace.git.diff",
  request: z.object({
    agentId: z.string().min(1),
    filePath: z.string().optional(),
  }),
  response: z.object({
    diff: z.string(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `workspace.git.commit` — stage + commit changes in the workspace
 * repo. ADMIN scope. `message` is sanitized (control chars stripped,
 * truncated to 500 chars). When `paths` is omitted, stages everything
 * with `git add -A`. Throws "Nothing to commit" when the working tree
 * is clean.
 *
 * Response: `{ sha, author, date, message }`.
 */
export const WorkspaceGitCommitContract = defineContract({
  method: "workspace.git.commit",
  request: z.object({
    agentId: z.string().min(1),
    message: z.string().optional(),
    paths: z.array(z.string()).optional(),
  }),
  response: WorkspaceGitCommitSchema,
  scopes: ["admin"] as const,
});

/**
 * `workspace.git.restore` — restore a file to its HEAD-committed
 * version. ADMIN scope. Throws "File has no committed version" when
 * the file is not tracked.
 *
 * Response: `{ restored: true }`.
 */
export const WorkspaceGitRestoreContract = defineContract({
  method: "workspace.git.restore",
  request: z.object({
    agentId: z.string().min(1),
    filePath: z.string().min(1),
  }),
  response: z.object({
    restored: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

/**
 * workspace-handlers slice (12 contracts). Spread order is
 * determinism-critical for codegen output stability.
 */
export const WORKSPACE_HANDLERS_CONTRACTS = [
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
] as const;
