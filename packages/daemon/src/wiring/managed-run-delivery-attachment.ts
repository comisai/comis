// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { safePath } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import type { ManagedRunVerifiedDelivery } from "./managed-run-evidence-verifier.js";

export interface MaterializedManagedRunAttachment {
  readonly path: string;
  cleanup(): Result<void, Error>;
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyDirectory(directoryPath: string): Result<void, Error> {
  if (!isAbsolute(directoryPath) || normalize(directoryPath) !== directoryPath) {
    return err(new Error("managed-run delivery directory must be absolute and canonical"));
  }
  const created = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- composition owns this absolute directory and verifies its canonical type immediately below
    mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  });
  if (!created.ok) return err(created.error);
  const checked = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the same composition-owned directory is verified before child creation
    const stat = lstatSync(directoryPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonicality is checked against the same absolute directory
    return { stat, canonical: realpathSync(directoryPath) };
  });
  if (!checked.ok) return err(checked.error);
  if (
    !checked.value.stat.isDirectory()
    || checked.value.stat.isSymbolicLink()
    || checked.value.canonical !== directoryPath
  ) return err(new Error("managed-run delivery directory must be a real owner-only directory"));
  const restricted = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chmod follows type and canonical-path verification on the same directory
    chmodSync(directoryPath, 0o700);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- verifies the mode just applied to the same canonical directory
    return lstatSync(directoryPath);
  });
  return restricted.ok && (restricted.value.mode & 0o077) === 0
    ? ok(undefined)
    : err(restricted.ok
      ? new Error("managed-run delivery directory is not owner-only")
      : restricted.error);
}

function existingBody(path: string, expectedHash: string): Result<boolean, Error> {
  const opened = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is safePath-confined beneath the verified delivery directory
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- numeric descriptor is the no-follow file opened above
      const bytes = readFileSync(fd);
      return stat.isFile() && (stat.mode & 0o777) === 0o600 && digest(bytes) === expectedHash;
    } finally {
      closeSync(fd);
    }
  });
  return opened.ok ? ok(opened.value) : err(opened.error);
}

/** Materialize one verifier-checked attachment as a transient owner-only file. */
export function materializeManagedRunAttachment(
  directoryPath: string,
  claimId: string,
  delivery: Extract<ManagedRunVerifiedDelivery, { readonly kind: "attachment" }>,
): Result<MaterializedManagedRunAttachment, Error> {
  const directory = verifyDirectory(directoryPath);
  if (!directory.ok) return directory;
  if (digest(delivery.body) !== delivery.contentHash) {
    return err(new Error("managed-run delivery attachment no longer matches its verified hash"));
  }
  const filename = `${digest(JSON.stringify([claimId, delivery.evidenceRef, delivery.contentHash]))}.body`;
  const resolved = tryCatch(() => safePath(directoryPath, filename));
  if (!resolved.ok) return err(resolved.error);
  const written = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved path is safePath-confined beneath the verified delivery directory
    const fd = openSync(
      resolved.value,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- numeric descriptor is the exclusive no-follow file opened above
      writeFileSync(fd, delivery.body);
    } finally {
      closeSync(fd);
    }
  });
  if (!written.ok) {
    if ((written.error as NodeJS.ErrnoException).code !== "EEXIST") {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only a partial exact file created by the failed exclusive write
      tryCatch(() => unlinkSync(resolved.value));
      return err(written.error);
    }
    const existing = existingBody(resolved.value, delivery.contentHash);
    if (!existing.ok || !existing.value) {
      return err(existing.ok
        ? new Error("managed-run delivery attachment path is occupied by different data")
        : existing.error);
    }
  }
  return ok(Object.freeze({
    path: resolved.value,
    cleanup: (): Result<void, Error> => {
      const removed = tryCatch(() => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only the exact safePath-confined file materialized above
        unlinkSync(resolved.value);
      });
      return removed.ok || (removed.error as NodeJS.ErrnoException).code === "ENOENT"
        ? ok(undefined)
        : err(removed.error);
    },
  }));
}
