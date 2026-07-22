// SPDX-License-Identifier: Apache-2.0
/**
 * Data-directory permission hardening, extracted from `wiring/main-helpers.ts`.
 *
 * `hardenDataDirPermissions` scans `~/.comis/` and fixes permissions on the data
 * directory, known sensitive files (config.yaml, .env, secrets.db, …), and
 * every regular file and directory in the production session tree. It returns
 * corrections for deferred logging after the structured logger is available.
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

import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { safePath } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import type { PermissionCorrection } from "../daemon-types.js";

function hardenSessionTree(
  currentPath: string,
  corrections: PermissionCorrection[],
): Result<void, Error> {
  const statResult = tryCatch(() => lstatSync(currentPath));
  if (!statResult.ok) return err(statResult.error);
  if (statResult.value.isSymbolicLink()) return ok(undefined);

  const expectedMode = statResult.value.isDirectory()
    ? 0o700
    : statResult.value.isFile()
      ? 0o600
      : undefined;
  if (expectedMode === undefined) return ok(undefined);
  const currentMode = statResult.value.mode & 0o777;
  if (currentMode !== expectedMode) {
    const chmodResult = tryCatch(() => chmodSync(currentPath, expectedMode));
    if (!chmodResult.ok) return err(chmodResult.error);
    corrections.push({ file: currentPath, oldMode: currentMode, newMode: expectedMode });
  }

  if (!statResult.value.isDirectory()) return ok(undefined);
  const entriesResult = tryCatch(() => readdirSync(currentPath, { withFileTypes: true }));
  if (!entriesResult.ok) return err(entriesResult.error);
  for (const entry of entriesResult.value) {
    const pathResult = tryCatch(() => safePath(currentPath, entry.name));
    if (!pathResult.ok) continue;
    const childResult = hardenSessionTree(pathResult.value, corrections);
    if (!childResult.ok) continue;
  }
  return ok(undefined);
}

/**
 * Scan ~/.comis/ and fix permissions on the data directory, known sensitive
 * files, and the nested session artifact tree. Returns corrections for deferred
 * logging after the logger is available.
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

  const sessionRootResult = tryCatch(() => safePath(dataDir, "workspace", "sessions"));
  if (sessionRootResult.ok) {
    hardenSessionTree(sessionRootResult.value, corrections);
  }

  return corrections;
}
