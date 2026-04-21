// SPDX-License-Identifier: Apache-2.0
/**
 * Last-known-good config snapshot — saves a working config copy on
 * successful daemon startup and suggests rollback on startup failure.
 * Snapshot on success, suggest on failure, restore via CLI flag.
 * @module
 */

import { existsSync, readFileSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, basename, join } from "node:path";

/** Suffix appended to the config filename for the last-known-good snapshot. */
const LKG_SUFFIX = ".last-good.yaml";

/**
 * Derive the last-known-good path from a config path.
 * e.g. `/home/user/.comis/config.yaml` → `/home/user/.comis/config.last-good.yaml`
 */
export function lastKnownGoodPath(configPath: string): string {
  const dir = dirname(configPath);
  const base = basename(configPath, ".yaml");
  return join(dir, `${base}${LKG_SUFFIX}`);
}

/**
 * Save a copy of the current config as the last-known-good snapshot.
 * Called after successful daemon startup.
 */
export function saveLastKnownGood(configPath: string): { saved: boolean; path: string } {
  const lkgPath = lastKnownGoodPath(configPath);
  try {
    if (!existsSync(configPath)) {
      return { saved: false, path: lkgPath };
    }
    copyFileSync(configPath, lkgPath);
    chmodSync(lkgPath, 0o600);
    return { saved: true, path: lkgPath };
  } catch {
    return { saved: false, path: lkgPath };
  }
}

/**
 * Restore config from the last-known-good snapshot.
 * Used by `--restore-last-good` CLI flag.
 * Returns the path restored from, or null if no snapshot exists.
 */
export function restoreLastKnownGood(configPath: string): { restored: boolean; lkgPath: string } {
  const lkgPath = lastKnownGoodPath(configPath);
  if (!existsSync(lkgPath)) {
    return { restored: false, lkgPath };
  }
  try {
    copyFileSync(lkgPath, configPath);
    chmodSync(configPath, 0o600);
    return { restored: true, lkgPath };
  } catch {
    return { restored: false, lkgPath };
  }
}

function getDiff(configPath: string, lkgPath: string): string | null {
  try {
    const current = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
    const lastGood = readFileSync(lkgPath, "utf-8");
    if (current === lastGood) {
      return "(no differences — failure may not be config-related)";
    }
    return buildSimpleDiff(lastGood, current);
  } catch {
    return "(unable to read config files for comparison)";
  }
}

/**
 * Build a rollback suggestion message for startup failure.
 * Compares current config vs last-known-good and returns actionable guidance.
 * Returns null if no last-known-good snapshot exists.
 */
export function buildRollbackSuggestion(configPath: string): {
  hint: string;
  lkgPath: string;
  diff: string | null;
} | null {
  const lkgPath = lastKnownGoodPath(configPath);
  if (!existsSync(lkgPath)) return null;

  const diff = getDiff(configPath, lkgPath);

  return {
    hint:
      `A last-known-good config exists from a previous successful startup. ` +
      `To restore it, run: node daemon.js --restore-last-good\n` +
      `Or manually: cp "${lkgPath}" "${configPath}"`,
    lkgPath,
    diff,
  };
}

/** Simple line-by-line diff for logging (no external deps). */
function buildSimpleDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const output: string[] = [];
  const maxLines = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined && newLine === undefined) {
      output.push(`- ${oldLine}`);
    } else if (oldLine === undefined && newLine !== undefined) {
      output.push(`+ ${newLine}`);
    } else if (oldLine !== newLine) {
      output.push(`- ${oldLine}`);
      output.push(`+ ${newLine}`);
    }
  }

  if (output.length === 0) return "(no differences)";
  if (output.length > 30) {
    return output.slice(0, 30).join("\n") + `\n... (${output.length - 30} more lines)`;
  }
  return output.join("\n");
}

/**
 * Handle `--restore-last-good` CLI flag.
 * Writes to stderr (logger not yet initialized) and exits.
 */
export function handleRestoreFlag(configPaths: string[], exitFn: (code: number) => void): void {
  if (configPaths.length === 0) {
    process.stderr.write("ERROR: No config paths configured. Cannot restore.\n");
    exitFn(1);
    return;
  }

  const configPath = configPaths[configPaths.length - 1]!;
  const { restored, lkgPath } = restoreLastKnownGood(configPath);

  if (restored) {
    process.stderr.write(`Restored last-known-good config from ${lkgPath}\n`);
    process.stderr.write(`Config written to: ${configPath}\n`);
    process.stderr.write("Restart the daemon to apply.\n");
    exitFn(0);
  } else {
    process.stderr.write(`ERROR: No last-known-good snapshot found at ${lkgPath}\n`);
    process.stderr.write("The daemon must complete at least one successful startup to create a snapshot.\n");
    exitFn(1);
  }
}
