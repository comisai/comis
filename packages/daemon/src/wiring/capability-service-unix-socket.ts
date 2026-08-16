// SPDX-License-Identifier: Apache-2.0
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, sep } from "node:path";
import { safePath } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

const MAXIMUM_UNIX_SOCKET_PATH_BYTES = 103;

export function verifyCapabilityServiceSocketRoot(root: string): Result<void, Error> {
  if (!isAbsolute(root) || normalize(root) !== root) {
    return err(new Error("capability-service socket root must be absolute and canonical"));
  }
  const checked = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the composition root supplies this absolute confined root
    const stat = lstatSync(root);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonicality is checked against the same configured root
    const canonicalRoot = realpathSync(root);
    return { stat, canonicalRoot };
  });
  if (!checked.ok) return err(checked.error);
  if (
    !checked.value.stat.isDirectory()
    || checked.value.stat.isSymbolicLink()
    || (checked.value.stat.mode & 0o077) !== 0
    || checked.value.canonicalRoot !== root
  ) {
    return err(new Error("capability-service socket root must be a real owner-only directory"));
  }
  return ok(undefined);
}

export function verifyCapabilityServiceSocketPath(root: string, socketPath: string): Result<void, Error> {
  if (!isAbsolute(socketPath) || normalize(socketPath) !== socketPath) {
    return err(new Error("capability-service socket path must be absolute and normalized"));
  }
  const relativePath = relative(root, socketPath);
  if (
    relativePath.length === 0
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    return err(new Error("capability-service socket path must remain beneath the configured root"));
  }
  const reconstructed = tryCatch(() => safePath(root, ...relativePath.split(sep)));
  if (!reconstructed.ok || reconstructed.value !== socketPath) {
    return err(new Error("capability-service socket path failed confinement"));
  }
  if (Buffer.byteLength(socketPath, "utf8") > MAXIMUM_UNIX_SOCKET_PATH_BYTES) {
    return err(new Error("capability-service socket path exceeds the platform limit"));
  }
  const parent = dirname(socketPath);
  const checked = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- parent is derived from a safePath-confined socket path
    const stat = lstatSync(parent);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonicality is checked on the safePath-confined parent
    const canonicalParent = realpathSync(parent);
    return { stat, canonicalParent };
  });
  if (!checked.ok) return err(checked.error);
  if (
    !checked.value.stat.isDirectory()
    || checked.value.stat.isSymbolicLink()
    || (checked.value.stat.mode & 0o077) !== 0
    || checked.value.canonicalParent !== parent
  ) {
    return err(new Error("capability-service socket parent must be a real owner-only directory"));
  }
  return ok(undefined);
}

export function removeStaleCapabilityServiceSocket(socketPath: string): Result<void, Error> {
  const existing = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- socketPath passed confinement and parent verification
    return lstatSync(socketPath);
  });
  if (!existing.ok) {
    return (existing.error as NodeJS.ErrnoException).code === "ENOENT"
      ? ok(undefined)
      : err(existing.error);
  }
  if (!existing.value.isSocket() || existing.value.isSymbolicLink()) {
    return err(new Error("capability-service socket path is occupied by a non-socket entry"));
  }
  const removed = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only the verified stale socket at the confined path
    unlinkSync(socketPath);
  });
  return removed.ok ? ok(undefined) : err(removed.error);
}
