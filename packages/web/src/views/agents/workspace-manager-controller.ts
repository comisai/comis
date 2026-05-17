// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace manager controller.
 *
 * Thin RPC façade — the workspace-manager view retains @state for its
 * two-panel layout (file tree + editor + git tab) because the existing
 * DOM-coupled flow (tab switching, dirty-state tracking, confirm dialogs,
 * commit message editing, diff viewer) keeps state on the view. The
 * controller's job is to keep `rpcClient.call(...)` out of
 * `workspace-manager.ts`. Each method mirrors a source view RPC invocation
 * 1:1 (same method name, same args, same response shape). Errors propagate
 * verbatim (callers handle).
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../../api/rpc-client.js";

/* ------------------------------------------------------------------ */
/*  RPC response shapes                                                 */
/* ------------------------------------------------------------------ */

export interface WorkspaceStatusDto {
  dir: string;
  exists: boolean;
  files: Array<{ name: string; present: boolean; sizeBytes?: number }>;
  hasGitRepo: boolean;
  isBootstrapped: boolean;
  state?: {
    version: number;
    bootstrapSeededAt?: number;
    onboardingCompletedAt?: number;
  };
}

export interface WorkspaceDirEntry {
  name: string;
  type: "file" | "directory";
  sizeBytes?: number;
  modifiedAt?: number;
}

export interface GitStatusDto {
  branch: string;
  clean: boolean;
  entries: Array<{
    path: string;
    status: "modified" | "added" | "deleted" | "untracked" | "renamed" | "copied";
    staged: boolean;
  }>;
}

export interface GitCommitDto {
  sha: string;
  author: string;
  date: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface WorkspaceManagerController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Load workspace status (workspace.status). */
  getStatus(agentId: string): Promise<WorkspaceStatusDto>;
  /** Read one workspace file (workspace.readFile). */
  readFile(agentId: string, filePath: string): Promise<{ content: string }>;
  /** List entries in a workspace subdirectory (workspace.listDir). */
  listDir(
    agentId: string,
    subdir: string,
  ): Promise<{ entries: WorkspaceDirEntry[] }>;
  /** Get git status for the workspace (workspace.git.status). */
  getGitStatus(agentId: string): Promise<GitStatusDto>;
  /** Get recent git log for the workspace (workspace.git.log). */
  getGitLog(
    agentId: string,
    limit: number,
  ): Promise<{ commits: GitCommitDto[] }>;
  /** Get diff for one file (workspace.git.diff). */
  getFileDiff(agentId: string, filePath: string): Promise<{ diff: string }>;
  /** Write file contents (workspace.writeFile). */
  writeFile(agentId: string, filePath: string, content: string): Promise<void>;
  /** Reset one file back to its default (workspace.resetFile). */
  resetFile(agentId: string, fileName: string): Promise<void>;
  /** Delete one workspace file (workspace.deleteFile). */
  deleteFile(agentId: string, filePath: string): Promise<void>;
  /** Initialize a workspace (workspace.init). */
  initWorkspace(agentId: string): Promise<void>;
  /** Restore a file to HEAD (workspace.git.restore). */
  restoreFile(agentId: string, filePath: string): Promise<void>;
  /** Commit working-tree changes (workspace.git.commit). */
  commitChanges(agentId: string, message: string | undefined): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createWorkspaceManagerController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): WorkspaceManagerController {
  const controller: WorkspaceManagerController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own listeners */
    },

    getStatus(agentId: string): Promise<WorkspaceStatusDto> {
      return rpcClient.call<WorkspaceStatusDto>("workspace.status", { agentId });
    },

    readFile(
      agentId: string,
      filePath: string,
    ): Promise<{ content: string }> {
      return rpcClient.call<{ content: string }>("workspace.readFile", {
        agentId,
        filePath,
      });
    },

    listDir(
      agentId: string,
      subdir: string,
    ): Promise<{ entries: WorkspaceDirEntry[] }> {
      return rpcClient.call<{ entries: WorkspaceDirEntry[] }>(
        "workspace.listDir",
        { agentId, subdir },
      );
    },

    getGitStatus(agentId: string): Promise<GitStatusDto> {
      return rpcClient.call<GitStatusDto>("workspace.git.status", { agentId });
    },

    getGitLog(
      agentId: string,
      limit: number,
    ): Promise<{ commits: GitCommitDto[] }> {
      return rpcClient.call<{ commits: GitCommitDto[] }>("workspace.git.log", {
        agentId,
        limit,
      });
    },

    getFileDiff(
      agentId: string,
      filePath: string,
    ): Promise<{ diff: string }> {
      return rpcClient.call<{ diff: string }>("workspace.git.diff", {
        agentId,
        filePath,
      });
    },

    async writeFile(
      agentId: string,
      filePath: string,
      content: string,
    ): Promise<void> {
      await rpcClient.call("workspace.writeFile", {
        agentId,
        filePath,
        content,
      });
    },

    async resetFile(agentId: string, fileName: string): Promise<void> {
      await rpcClient.call("workspace.resetFile", { agentId, fileName });
    },

    async deleteFile(agentId: string, filePath: string): Promise<void> {
      await rpcClient.call("workspace.deleteFile", { agentId, filePath });
    },

    async initWorkspace(agentId: string): Promise<void> {
      await rpcClient.call("workspace.init", { agentId });
    },

    async restoreFile(agentId: string, filePath: string): Promise<void> {
      await rpcClient.call("workspace.git.restore", { agentId, filePath });
    },

    async commitChanges(
      agentId: string,
      message: string | undefined,
    ): Promise<void> {
      await rpcClient.call("workspace.git.commit", { agentId, message });
    },
  };

  host.addController(controller);
  return controller;
}
