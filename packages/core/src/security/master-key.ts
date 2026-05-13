// SPDX-License-Identifier: Apache-2.0
/**
 * Master-key file helpers — daemon-free `secrets init` body.
 *
 * Lifted from packages/cli/src/commands/secrets.ts:226-258 in Phase 31
 * commit 5 (MEM-CTX-PORTS-09 row "secrets init → daemon-free core helper").
 * The CLI's `secrets init` subcommand is now a thin wrapper that calls
 * `writeMasterKeyIfAbsent` (CLI rewrite lands in plan 31-10).
 *
 * Pure filesystem + crypto. No daemon required. Safe to call from any
 * context where the caller can `chmod` the user's home directory.
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
} from "node:fs";

import { safePath } from "./safe-path.js";

export interface MasterKeyWriteResult {
  readonly written: boolean;
  readonly path: string;
}

/**
 * Generate a 32-byte hex master key.
 *
 * Pure function. Identical to the inline `randomBytes(32).toString("hex")`
 * call at the start of the current `secrets init` body.
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
  appendFileSync(envPath, `\nSECRETS_MASTER_KEY=${keyHex}\n`);
  chmodSync(envPath, 0o600);
  return { written: true, path: envPath };
}
