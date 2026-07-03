// SPDX-License-Identifier: Apache-2.0
/**
 * Data-directory permission hardening, extracted from `wiring/main-helpers.ts`.
 *
 * `hardenDataDirPermissions` scans `~/.comis/` and fixes permissions on the data
 * directory and known sensitive files (config.yaml, .env, secrets.db, …),
 * returning the list of corrections for deferred logging (the result is logged
 * after the structured logger is up at startup). It is self-contained — a
 * `dataDir` string in, a `PermissionCorrection[]` out, only `node:fs` sync I/O.
 *
 * It was moved out of `main-helpers.ts` (a behavior-neutral function extraction,
 * no logic change) to keep that file under the 800-line architecture cap it
 * would otherwise exceed — a shrink-only split, NOT an allowlist add
 * (allowlists are shrink-only per AGENTS.md §2.8). The single caller (daemon.ts,
 * which invokes `hardenDataDirPermissions(dataDir)` at startup) imports it from
 * this path.
 *
 * @module
 */

import { mkdirSync, statSync, chmodSync } from "node:fs";
import type { PermissionCorrection } from "../daemon-types.js";

/**
 * Scan ~/.comis/ and fix permissions on the data directory and known sensitive
 * files. Returns an array of corrections for deferred logging. Self-contained —
 * a `dataDir` string in, a `PermissionCorrection[]` out, only node:fs sync I/O
 * (runs at startup; the result is logged after the logger is up).
 */
export function hardenDataDirPermissions(dataDir: string): PermissionCorrection[] {
  const corrections: PermissionCorrection[] = [];

  // Ensure data dir exists with 0o700
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch { /* may already exist */ }

  // Fix data directory permissions
  try {
    const stat = statSync(dataDir);
    const currentMode = stat.mode & 0o777;
    if (currentMode !== 0o700) {
      chmodSync(dataDir, 0o700);
      corrections.push({ file: dataDir, oldMode: currentMode, newMode: 0o700 });
    }
  } catch { /* best-effort */ }

  // Fix known sensitive files
  const sensitiveFiles = ["config.yaml", "config.local.yaml", ".env", "secrets.db", "secrets.json"];
  for (const filename of sensitiveFiles) {
    try {
      const filePath = `${dataDir}/${filename}`;
      const stat = statSync(filePath);
      const currentMode = stat.mode & 0o777;
      if (currentMode !== 0o600) {
        chmodSync(filePath, 0o600);
        corrections.push({ file: filePath, oldMode: currentMode, newMode: 0o600 });
      }
    } catch { /* file may not exist; best-effort */ }
  }

  return corrections;
}
