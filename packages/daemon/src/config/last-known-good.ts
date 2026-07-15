// SPDX-License-Identifier: Apache-2.0
/**
 * Last-known-good config snapshot — saves a working config copy on
 * successful daemon startup and suggests rollback on startup failure.
 * Snapshot on success, suggest on failure, restore via CLI flag.
 *
 * Each save / restore call writes a config-audit record to
 * `~/.comis/logs/config-audit.jsonl` via `withAuditHookSync` from
 * `./audit-hook.ts` — the shared single-call wrapper that owns the
 * sanctioned trust-boundary process.* reads + sync `appendConfigAuditRecordSync`
 * (sync because last-known-good runs during shutdown when async
 * appends may not flush).
 *
 * The audit hook is best-effort: a failure to write the JSONL line
 * does NOT abort the LKG save / restore. The JSONL log is a
 * forensics aid; the LKG file itself is the load-bearing artifact.
 *
 * @module
 */

import { existsSync, readFileSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { safePath, scanForSecrets } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import { parse as parseYaml } from "yaml";
import { withAuditHookSync } from "./audit-hook.js";

/** Suffix appended to the config filename for the last-known-good snapshot. */
const LKG_SUFFIX = ".last-good.yaml";

/**
 * Derive the last-known-good path from a config path.
 * e.g. `/home/user/.comis/config.yaml` → `/home/user/.comis/config.last-good.yaml`
 */
export function lastKnownGoodPath(configPath: string): string {
  const dir = dirname(configPath);
  const base = basename(configPath, ".yaml");
  return safePath(dir, `${base}${LKG_SUFFIX}`);
}

/**
 * Save a copy of the current config as the last-known-good snapshot.
 * Called after successful daemon startup.
 *
 * `auditEnabled` honors `diagnostics.configAudit.enabled`. Default
 * `true` for callers that don't pass the parameter. When `false`, the
 * audit JSONL append is skipped but the LKG copy itself still runs —
 * the audit log is a forensics aid, not a correctness gate.
 *
 * `logger` is optional. When provided, a WARN is emitted if the snapshot
 * is intentionally skipped (secret found in source config, or malformed YAML),
 * so operators know the LKG was NOT updated and why. Without a logger the
 * skip is still correct (security behavior unchanged) but silent.
 *
 * The audit-record `configPath` field reflects the WRITE TARGET (the
 * `.last-good.yaml` file), not the source `config.yaml` — the record
 * describes state changes to the LKG file.
 */
export function saveLastKnownGood(
  configPath: string,
  auditEnabled: boolean = true,
  logger?: ComisLogger,
): { saved: boolean; path: string } {
  const lkgPath = lastKnownGoodPath(configPath);
  if (!existsSync(configPath)) {
    return { saved: false, path: lkgPath };
  }

  // Refuse to snapshot a config that contains a plaintext secret.
  // Parse the source file first; any scan finding means the LKG would
  // capture a credential that could be re-introduced via
  // `cp config.last-good.yaml config.yaml`.
  try {
    const sourceObj = parseYaml(readFileSync(configPath, "utf-8")) ?? {};
    if (scanForSecrets(sourceObj).length > 0) {
      // Emit WARN so operators know the LKG snapshot was skipped and why.
      // The secret path is included as context but the VALUE is never logged.
      logger?.warn(
        {
          hint: "Remove plaintext secrets from config.yaml (use secrets_manage) so the LKG snapshot can be updated",
          errorKind: "config" as const,
          configPath,
        },
        "LKG snapshot skipped: source config contains a plaintext secret — snapshot NOT updated",
      );
      return { saved: false, path: lkgPath };
    }
  } catch {
    // Unreadable / malformed YAML — fail-safe: skip the snapshot.
    // Emit WARN so the operator knows the snapshot is stale.
    logger?.warn(
      {
        hint: "Fix the malformed config.yaml so the LKG snapshot can be updated; current snapshot (if any) is stale",
        errorKind: "config" as const,
        configPath,
      },
      "LKG snapshot skipped: source config YAML is malformed or unreadable — snapshot NOT updated",
    );
    return { saved: false, path: lkgPath };
  }

  const audit = withAuditHookSync({
    source: "last-known-good-save",
    auditConfigPath: lkgPath,
    // fileURLToPath(import.meta.url) resolves to last-known-good.ts —
    // the correct entry-script attribution for this call site (not
    // the shared audit-hook.ts module where the helper is defined).
    entryScript: fileURLToPath(import.meta.url),
    auditEnabled,
    write: () => {
      copyFileSync(configPath, lkgPath);
      chmodSync(lkgPath, 0o600);
    },
  });
  return { saved: audit.ok, path: lkgPath };
}

/**
 * Restore config from the last-known-good snapshot.
 * Used by `--restore-last-good` CLI flag.
 * Returns the path restored from, or null if no snapshot exists.
 *
 * `auditEnabled` honors `diagnostics.configAudit.enabled`. Default
 * `true` for callers that don't pass the parameter; when `false`, the
 * audit JSONL append is skipped but the restore copy itself still runs.
 */
export function restoreLastKnownGood(
  configPath: string,
  auditEnabled: boolean = true,
): { restored: boolean; lkgPath: string } {
  const lkgPath = lastKnownGoodPath(configPath);
  if (!existsSync(lkgPath)) {
    return { restored: false, lkgPath };
  }
  const audit = withAuditHookSync({
    source: "last-known-good-restore",
    auditConfigPath: configPath,
    entryScript: fileURLToPath(import.meta.url),
    auditEnabled,
    write: () => {
      copyFileSync(lkgPath, configPath);
      chmodSync(configPath, 0o600);
    },
  });
  return { restored: audit.ok, lkgPath };
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
      `To restore it, run: node daemon-entrypoint.js --restore-last-good\n` +
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
 *
 * `auditEnabled` defaults to `true`. The `--restore-last-good` flag
 * runs BEFORE the daemon loads its config (it's an emergency-recovery
 * path), so the daemon.ts caller has no cfg in scope and uses the
 * default. Programmatic callers that DO have cfg can pass the gate
 * explicitly.
 */
export function handleRestoreFlag(
  configPaths: string[],
  exitFn: (code: number) => void,
  auditEnabled: boolean = true,
): void {
  if (configPaths.length === 0) {
    process.stderr.write("ERROR: No config paths configured. Cannot restore.\n");
    exitFn(1);
    return;
  }

  const configPath = configPaths[configPaths.length - 1]!;
  const { restored, lkgPath } = restoreLastKnownGood(configPath, auditEnabled);

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
