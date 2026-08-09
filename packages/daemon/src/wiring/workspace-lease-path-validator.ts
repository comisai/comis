// SPDX-License-Identifier: Apache-2.0
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, parse, relative, sep } from "node:path";
import type { WorkspaceLeaseFilesystemIdentity } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

export interface ValidatedWorkspaceLeasePath {
  readonly canonicalPath: string;
  readonly filesystemIdentity: WorkspaceLeaseFilesystemIdentity;
}

export interface WorkspaceLeasePathValidationInput {
  readonly requestedPath: string;
  readonly allowedWorkspaceRoots: readonly string[];
  readonly dataDir: string;
}

function isStrictChild(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child.length > 0
    && child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
}

function inspectDirectory(path: string, label: string): Result<{
  readonly canonicalPath: string;
  readonly filesystemIdentity: WorkspaceLeaseFilesystemIdentity;
}, Error> {
  if (!isAbsolute(path) || normalize(path) !== path) {
    return err(new Error(`${label} must be absolute and normalized`));
  }
  const inspected = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied path is inspected without following its final component before authority is granted
    const stat = lstatSync(path);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonical comparison rejects every symlinked component before the path is authorized
    const canonicalPath = realpathSync(path);
    return { stat, canonicalPath };
  });
  if (!inspected.ok) return err(inspected.error);
  if (
    inspected.value.stat.isSymbolicLink()
    || !inspected.value.stat.isDirectory()
    || inspected.value.canonicalPath !== path
  ) {
    return err(new Error(`${label} must be a canonical no-follow directory`));
  }
  const device = inspected.value.stat.dev;
  const inode = inspected.value.stat.ino;
  if (
    !Number.isSafeInteger(device)
    || device < 0
    || !Number.isSafeInteger(inode)
    || inode < 0
  ) {
    return err(new Error(`${label} filesystem identity is outside the supported range`));
  }
  return ok({ canonicalPath: path, filesystemIdentity: { device, inode } });
}

/** Resolve exact workspace authority without following symlinks or broadening roots. */
export function validateWorkspaceLeasePath(
  input: WorkspaceLeasePathValidationInput,
): Result<ValidatedWorkspaceLeasePath, Error> {
  if (input.allowedWorkspaceRoots.length === 0) {
    return err(new Error("the capability-service instance grants no workspace roots"));
  }
  const requested = inspectDirectory(input.requestedPath, "requested workspace");
  if (!requested.ok) return requested;
  const dataDirectory = inspectDirectory(input.dataDir, "Comis data directory");
  if (!dataDirectory.ok) return dataDirectory;
  if (
    requested.value.canonicalPath === dataDirectory.value.canonicalPath
    || isStrictChild(dataDirectory.value.canonicalPath, requested.value.canonicalPath)
  ) {
    return err(new Error("requested workspace cannot be the Comis data directory or its child"));
  }

  const home = normalize(homedir());
  for (const configuredRoot of input.allowedWorkspaceRoots) {
    if (parse(configuredRoot).root === configuredRoot || configuredRoot === home) {
      return err(new Error("capability-service workspace roots cannot grant broad filesystem authority"));
    }
    const root = inspectDirectory(configuredRoot, "allowed workspace root");
    if (!root.ok) return root;
    if (isStrictChild(root.value.canonicalPath, requested.value.canonicalPath)) {
      return requested;
    }
  }
  return err(new Error("requested workspace is outside the capability-service instance roots"));
}
