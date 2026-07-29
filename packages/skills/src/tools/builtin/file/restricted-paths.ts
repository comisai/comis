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

/** True when a candidate is a hidden root, descendant, or symlink into one. */
export function isRestrictedPath(
  candidate: string,
  hiddenPaths: readonly string[] | undefined,
): boolean {
  if (!hiddenPaths || hiddenPaths.length === 0) return false;
  const canonicalCandidate = canonicalPath(candidate);
  return hiddenPaths.some((hidden) =>
    containsPath(canonicalPath(hidden), canonicalCandidate),
  );
}

/** Refuse access without echoing the sensitive path. */
export function requireVisiblePath(
  candidate: string,
  hiddenPaths: readonly string[] | undefined,
): void {
  if (isRestrictedPath(candidate, hiddenPaths)) {
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
