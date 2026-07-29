// SPDX-License-Identifier: Apache-2.0
// @allow-throw: file-tool validation guard; agent execution converts the error to a tool result.
/** Canonical hidden-subtree checks shared by file and patch tools. */

import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { tryCatch } from "@comis/shared";

function canonicalPath(candidate: string): string {
  const absolute = resolve(candidate);
  let existing = absolute;
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  const resolvedExisting = tryCatch(() => realpathSync(existing));
  return resolve(
    resolvedExisting.ok ? resolvedExisting.value : existing,
    ...missingSegments,
  );
}

function containsPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === ""
    || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function strictlyContainsPath(root: string, candidate: string): boolean {
  return root !== candidate && containsPath(root, candidate);
}

/**
 * Canonical read-only exceptions that are strict descendants of a hidden root.
 *
 * An exception is rejected if it equals a hidden root, sits outside every
 * hidden root, or would cover another hidden root. This keeps a narrowly
 * readable child artifact from reopening a broader or nested isolation
 * boundary.
 */
export function resolveHiddenReadAllowPaths(
  hiddenPaths: readonly string[] | undefined,
  hiddenReadAllowPaths: readonly string[] | undefined,
): string[] {
  if (
    !hiddenPaths
    || hiddenPaths.length === 0
    || !hiddenReadAllowPaths
    || hiddenReadAllowPaths.length === 0
  ) {
    return [];
  }
  const canonicalHidden = hiddenPaths.map(canonicalPath);
  const resolved = new Set<string>();
  for (const requested of hiddenReadAllowPaths) {
    const allowed = canonicalPath(requested);
    const hasHiddenAncestor = canonicalHidden.some((hidden) =>
      strictlyContainsPath(hidden, allowed));
    const coversHiddenBoundary = canonicalHidden.some((hidden) =>
      containsPath(allowed, hidden));
    if (hasHiddenAncestor && !coversHiddenBoundary) {
      resolved.add(allowed);
    }
  }
  return [...resolved];
}

/** True when a candidate is a hidden root, descendant, or symlink into one. */
export function isRestrictedPath(
  candidate: string,
  hiddenPaths: readonly string[] | undefined,
  hiddenReadAllowPaths?: readonly string[],
): boolean {
  if (!hiddenPaths || hiddenPaths.length === 0) return false;
  const canonicalCandidate = canonicalPath(candidate);
  const restricted = hiddenPaths.some((hidden) =>
    containsPath(canonicalPath(hidden), canonicalCandidate),
  );
  if (!restricted) return false;
  const allowed = resolveHiddenReadAllowPaths(
    hiddenPaths,
    hiddenReadAllowPaths,
  );
  return !allowed.some((root) => containsPath(root, canonicalCandidate));
}

/** Refuse access without echoing the sensitive path. */
export function requireVisiblePath(
  candidate: string,
  hiddenPaths: readonly string[] | undefined,
  hiddenReadAllowPaths?: readonly string[],
): void {
  if (isRestrictedPath(candidate, hiddenPaths, hiddenReadAllowPaths)) {
    throw new Error(
      "[restricted_path] Access to this internal workspace path is denied.",
    );
  }
}

/** Hidden descendants expressed relative to a search root for tool exclusions. */
export function hiddenDescendants(
  searchRoot: string,
  hiddenPaths: readonly string[] | undefined,
): string[] {
  if (!hiddenPaths) return [];
  const canonicalRoot = canonicalPath(searchRoot);
  return hiddenPaths.flatMap((hidden) => {
    const canonicalHidden = canonicalPath(hidden);
    if (!containsPath(canonicalRoot, canonicalHidden)) return [];
    const rel = relative(canonicalRoot, canonicalHidden);
    return rel === "" ? ["."] : [rel.split(sep).join("/")];
  });
}
