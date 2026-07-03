// SPDX-License-Identifier: Apache-2.0
/**
 * Master-key file helpers — daemon-free `secrets init` body.
 *
 * Pure filesystem + crypto. No daemon required. Safe to call from any
 * context where the caller can `chmod` the user's home directory. The
 * CLI's `secrets init` subcommand is a thin wrapper that calls
 * `writeMasterKeyIfAbsent`.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  chmodSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";

import { safePath } from "./safe-path.js";

export interface MasterKeyWriteResult {
  readonly written: boolean;
  readonly path: string;
  /**
   * The freshly-generated master key in 64-char hex encoding.
   * Defined iff `written === true` (first-time write only).
   * Absent (undefined) when `written === false` (key already present).
   * NEVER log this value.
   */
  readonly keyHex?: string;
}

/**
 * Generate a 32-byte hex master key.
 *
 * @returns 64-character hex string (32 bytes encoded)
 */
export function generateMasterKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Idempotent master-key writer. If `SECRETS_MASTER_KEY=` already appears at
 * the start of any line in `<dataDir>/.env`, returns `{ written: false }`
 * and leaves the file alone. Otherwise generates a fresh 32-byte hex key,
 * appends it as a single `SECRETS_MASTER_KEY=<hex>` line, and chmods the
 * file to 0o600.
 *
 * Creates `<dataDir>` (recursively, mode 0o700) if it does not exist.
 *
 * @param dataDir - Absolute path to a writable data directory (typically `~/.comis`).
 * @returns `{ written, path }` where `path` is the resolved `<dataDir>/.env` path.
 */
export function writeMasterKeyIfAbsent(dataDir: string): MasterKeyWriteResult {
  const envPath = safePath(dataDir, ".env");

  if (existsSync(envPath)) {
    const existing = readFileSync(envPath, "utf-8");
    if (/^SECRETS_MASTER_KEY=/m.test(existing)) {
      return { written: false, path: envPath };
    }
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyHex = generateMasterKey();
  // Create the file with mode 0o600 atomically. openSync with flag "a"
  // only applies the mode on file CREATION (O_CREAT path) — if the file already
  // exists (append mode), the mode argument is ignored and the existing
  // permissions are preserved. This eliminates the brief window where a newly
  // created file is visible at umask-default permissions before chmodSync narrows it.
  if (!existsSync(envPath)) {
    const fd = openSync(envPath, "a", 0o600);
    try {
      writeSync(fd, `\nSECRETS_MASTER_KEY=${keyHex}\n`);
    } finally {
      closeSync(fd);
    }
  } else {
    appendFileSync(envPath, `\nSECRETS_MASTER_KEY=${keyHex}\n`);
  }
  // Defensive chmod: narrows any pre-existing file that was created at broader mode.
  chmodSync(envPath, 0o600);
  return { written: true, path: envPath, keyHex };
}
