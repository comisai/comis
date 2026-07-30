// SPDX-License-Identifier: Apache-2.0
/**
 * Validates that local Markdown references in an imported skill resolve
 * entirely within the exact GitHub directory approved by the operator.
 */

import { err, ok, tryCatch, type Result } from "@comis/shared";
import { posix } from "node:path";

export interface ImportedSkillFile {
  path: string;
  content: string;
}

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/iu;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/u;
const INLINE_LINK_RE = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))/gu;
const REFERENCE_LINK_RE = /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gmu;
const INLINE_CODE_RE = /`+[^`\n]*`+/gu;

function withoutFencedCode(content: string): string {
  const kept: string[] = [];
  let closingMarker: string | undefined;
  for (const line of content.split("\n")) {
    const fence = line.match(FENCE_RE)?.[1];
    if (closingMarker !== undefined) {
      if (fence?.startsWith(closingMarker)) closingMarker = undefined;
      continue;
    }
    if (fence !== undefined) {
      closingMarker = fence[0];
      continue;
    }
    kept.push(line.replace(INLINE_CODE_RE, ""));
  }
  return kept.join("\n");
}

function markdownTargets(content: string): string[] {
  const targets: string[] = [];
  const scanned = withoutFencedCode(content);
  for (const match of scanned.matchAll(INLINE_LINK_RE)) {
    const target = match[1] ?? match[2];
    if (target !== undefined) targets.push(target);
  }
  for (const match of scanned.matchAll(REFERENCE_LINK_RE)) {
    const target = match[1] ?? match[2];
    if (target !== undefined) targets.push(target);
  }
  return targets;
}

function localTarget(rawTarget: string): Result<string | undefined, Error> {
  if (
    rawTarget.startsWith("#")
    || rawTarget.startsWith("//")
    || URI_SCHEME_RE.test(rawTarget)
  ) {
    return ok(undefined);
  }
  const suffixStart = [rawTarget.indexOf("?"), rawTarget.indexOf("#")]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const encodedPath = suffixStart === undefined
    ? rawTarget
    : rawTarget.slice(0, suffixStart);
  if (encodedPath.length === 0) return ok(undefined);
  const decoded = tryCatch(() => decodeURIComponent(encodedPath));
  if (!decoded.ok) {
    return err(new Error(`Skill import has an invalid encoded Markdown reference: "${rawTarget}"`));
  }
  return ok(decoded.value.replaceAll("\\", "/"));
}

export function validateImportedSkillReferences(
  files: readonly ImportedSkillFile[],
): Result<void, Error> {
  const availablePaths = new Set(files.map((file) => posix.normalize(file.path)));
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith(".md")) continue;
    for (const rawTarget of markdownTargets(file.content)) {
      const targetResult = localTarget(rawTarget);
      if (!targetResult.ok) return targetResult;
      if (targetResult.value === undefined) continue;
      const target = targetResult.value;
      const resolved = posix.normalize(`${posix.dirname(file.path)}/${target}`);
      if (
        target.startsWith("/")
        || resolved === ".."
        || resolved.startsWith("../")
      ) {
        return err(new Error(
          `Skill import is incomplete: ${file.path} references "${rawTarget}", `
          + "which is outside the approved GitHub directory. Select a self-contained "
          + "skill package or an approved directory that includes every referenced file.",
        ));
      }
      const directoryPrefix = resolved.endsWith("/") ? resolved : `${resolved}/`;
      const exists = availablePaths.has(resolved)
        || [...availablePaths].some((path) => path.startsWith(directoryPrefix));
      if (!exists) {
        return err(new Error(
          `Skill import is incomplete: ${file.path} references "${rawTarget}", `
          + "which is missing from the fetched bundle. Select a self-contained skill "
          + "package or an approved directory that includes every referenced file.",
        ));
      }
    }
  }
  return ok(undefined);
}
