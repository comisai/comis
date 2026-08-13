// SPDX-License-Identifier: Apache-2.0
import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { isAbsolute, normalize, parse, relative, sep } from "node:path";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import type { ExecutionAttachmentFilesystemIdentity } from "@comis/core";

export interface ValidatedExecutionAttachmentPath {
  readonly canonicalPath: string;
  readonly filesystemType: "socket";
  readonly filesystemIdentity: ExecutionAttachmentFilesystemIdentity;
}

export interface ExecutionAttachmentPathInput {
  readonly requestedPath: string;
  readonly allowedRuntimeRoots: readonly string[];
  readonly dataDir: string;
  readonly controlSocketPaths: readonly string[];
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function inspectCanonicalPath(path: string): Result<{
  readonly stat: BigIntStats;
  readonly canonical: string;
}, Error> {
  const inspected = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- callers admit only absolute normalized paths before this filesystem boundary
    const stat = lstatSync(path, { bigint: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonical equality rejects paths that redirect outside their admitted runtime root
    const canonical = realpathSync(path);
    return { stat, canonical };
  });
  return inspected.ok ? ok(inspected.value) : err(inspected.error);
}

function canonicalDirectory(path: string): Result<string, Error> {
  const inspected = inspectCanonicalPath(path);
  if (!inspected.ok) return err(inspected.error);
  if (
    !inspected.value.stat.isDirectory()
    || inspected.value.stat.isSymbolicLink()
    || inspected.value.canonical !== path
  ) return err(new Error("execution attachment runtime root must be a real canonical directory"));
  return ok(inspected.value.canonical);
}

/** Prove one exact Unix socket without granting authority over its containing root. */
export function validateExecutionAttachmentPath(input: ExecutionAttachmentPathInput): Result<ValidatedExecutionAttachmentPath, Error> {
  if (
    input.allowedRuntimeRoots.length === 0
    || !isAbsolute(input.requestedPath)
    || normalize(input.requestedPath) !== input.requestedPath
  ) return err(new Error("execution attachment source must be an absolute normalized path under an allowed runtime root"));

  const source = inspectCanonicalPath(input.requestedPath);
  if (!source.ok) return err(source.error);
  if (
    source.value.stat.isSymbolicLink()
    || !source.value.stat.isSocket()
    || source.value.canonical !== input.requestedPath
  ) return err(new Error("execution attachment source must be a real canonical Unix socket"));

  if (
    isWithin(source.value.canonical, input.dataDir)
    || input.controlSocketPaths.includes(source.value.canonical)
  ) return err(new Error("execution attachment source cannot expose a Comis control or data socket"));

  for (const configuredRoot of input.allowedRuntimeRoots) {
    if (
      !isAbsolute(configuredRoot)
      || normalize(configuredRoot) !== configuredRoot
      || parse(configuredRoot).root === configuredRoot
      || isWithin(configuredRoot, input.dataDir)
      || isWithin(input.dataDir, configuredRoot)
    ) continue;
    const root = canonicalDirectory(configuredRoot);
    if (!root.ok || !isWithin(source.value.canonical, root.value)) continue;
    const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
    if (
      source.value.stat.dev < 0n
      || source.value.stat.dev > maximumSafeInteger
      || source.value.stat.ino < 0n
      || source.value.stat.ino > maximumSafeInteger
      || source.value.stat.birthtimeNs <= 0n
    ) return err(new Error("execution attachment filesystem identity is outside the supported range"));
    return ok({
      canonicalPath: source.value.canonical,
      filesystemType: "socket",
      filesystemIdentity: {
        device: Number(source.value.stat.dev),
        inode: Number(source.value.stat.ino),
        birthtimeNs: source.value.stat.birthtimeNs.toString(),
      },
    });
  }
  return err(new Error("execution attachment source is outside the capability-service runtime roots"));
}
