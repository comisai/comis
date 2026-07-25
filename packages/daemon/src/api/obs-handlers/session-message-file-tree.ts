// SPDX-License-Identifier: Apache-2.0
/** Safe filesystem-tree enumeration for the offline session-message reader. */

import * as fs from "node:fs";
import { safePath } from "@comis/core";
import { tryCatch } from "@comis/shared";

export interface NamedSessionPath {
  name: string;
  path: string;
}

export interface SessionWorkspaceTree {
  agentId: string;
  sessionsBase: string;
}

/** Whether a failed directory read is the normal absence of an optional tree. */
function isMissingDirectory(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** List contained child directories and reject encoded traversal names. */
export function listSafeSessionDirectories(
  dir: string,
  onUnreadable: () => void,
): NamedSessionPath[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (!isMissingDirectory(error)) onUnreadable();
    return [];
  }
  const result: NamedSessionPath[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      onUnreadable();
      continue;
    }
    if (!entry.isDirectory()) continue;
    const resolved = tryCatch(() => safePath(dir, entry.name));
    if (!resolved.ok) {
      onUnreadable();
      continue;
    }
    result.push({ name: entry.name, path: resolved.value });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** List contained child files and report unsafe names as unreadable files. */
export function listSafeSessionFiles(
  dir: string,
  onDirectoryUnreadable: () => void,
  onFileUnreadable: () => void,
): NamedSessionPath[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (!isMissingDirectory(error)) onDirectoryUnreadable();
    return [];
  }
  const result: NamedSessionPath[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      onFileUnreadable();
      continue;
    }
    if (!entry.isFile()) continue;
    const resolved = tryCatch(() => safePath(dir, entry.name));
    if (!resolved.ok) {
      onFileUnreadable();
      continue;
    }
    result.push({ name: entry.name, path: resolved.value });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Enumerate the default and named-agent workspace session roots. */
export function listSessionWorkspaceTrees(
  dataDir: string,
  onUnreadable: () => void,
): SessionWorkspaceTree[] {
  const trees: SessionWorkspaceTree[] = [];
  for (const entry of listSafeSessionDirectories(dataDir, onUnreadable)) {
    const agentId = entry.name === "workspace"
      ? "default"
      : entry.name.startsWith("workspace-")
        ? entry.name.slice("workspace-".length)
        : undefined;
    if (agentId === undefined) continue;
    const sessionsBase = tryCatch(() => safePath(entry.path, "sessions"));
    if (!sessionsBase.ok) {
      onUnreadable();
      continue;
    }
    trees.push({ agentId, sessionsBase: sessionsBase.value });
  }
  return trees.sort((a, b) =>
    a.agentId.localeCompare(b.agentId) || a.sessionsBase.localeCompare(b.sessionsBase)
  );
}
