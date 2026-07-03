// SPDX-License-Identifier: Apache-2.0
/**
 * Verify stage of `comis config tooling-fill`.
 *
 * Composes the diff-rendered fill output into the final result: dry-run
 * short-circuit, values-confirmation prompt, restart-authorization prompt,
 * protected mutation window (stopDaemon → writeBackup → setHintFields per
 * entry → atomicWriteFile → reloadConfigFile → resolveEnvRefs →
 * validateConfig), daemon restart + liveness verification, partial-success
 * --all reporting, backup retention housekeeping, and the final success
 * summary.
 *
 * Rollback is invoked on any mid-window failure (write or validation)
 * and restores both the file (via atomicWriteFile of the captured original
 * raw YAML) and the daemon process (best-effort startDaemon).
 *
 * @module
 */
import type { Document } from "yaml";
import { loadConfigFile, systemGetEnv, validateConfig } from "@comis/core";
import {
  startDaemon,
  stopDaemon,
  waitForDaemonAlive,
  type Supervisor,
} from "../supervisor.js";
import { setHintFields } from "../apply-hint.js";
import {
  atomicWriteFile,
  isDaemonRunning,
  pruneOldBackups,
  writeBackup,
} from "../../sync-tooling/index.js";
import type {
  FilledEntry,
  OrchestratorOpts,
  OrchestratorResult,
  RollbackOutcome,
  SkippedEntry,
} from "./orchestrator-types.js";
import { TOOLFILL_9_VALIDATION_FAILED_PREFIX } from "./orchestrator-types.js";

/**
 * Top-level verify entry. Runs dry-run short-circuit + both prompts + the
 * protected mutation window + final summary composition.
 */
export async function verifyFill(
  opts: OrchestratorOpts,
  rawYaml: string,
  doc: Document,
  supervisor: Supervisor,
  filled: readonly FilledEntry[],
  skipped: readonly SkippedEntry[],
  diffString: string,
): Promise<OrchestratorResult> {
  // ---- Dry-run short-circuit ------------------------------------------
  if (opts.dryRun) {
    return {
      exitCode: 0,
      summary: `[dry-run] Would fill ${filled.length} hint(s):\n${diffString}`,
    };
  }

  // ---- Confirmation prompt (values) -----------------------------------
  if (!opts.yes) {
    if (!opts.isTty) {
      return {
        exitCode: 1,
        summary: "--yes required for non-interactive runs",
      };
    }
    const okValues = await opts.prompts.confirmValues(diffString);
    if (!okValues) {
      return { exitCode: 0, summary: "aborted by operator" };
    }
  }

  // ---- Restart authorization prompt -----------------------------------
  let willRestart: boolean;
  if (opts.restart === false) {
    // --no-restart explicit: write file but skip stop+start.
    willRestart = false;
  } else if (opts.restart === true) {
    willRestart = true;
  } else {
    // restart === undefined → must prompt or fail (non-TTY).
    if (!opts.isTty) {
      return {
        exitCode: 1,
        summary: "--restart required for non-interactive runs",
      };
    }
    const okRestart = await opts.prompts.confirmRestart(supervisor);
    if (!okRestart) {
      // Operator-driven aborts exit 0 (matches values-decline). Shell
      // scripts that distinguish "user said no" from "command failed"
      // expect a clean exit on either prompt.
      return { exitCode: 0, summary: "operator declined daemon restart" };
    }
    willRestart = true;
  }

  // ---- Protected mutation window --------------------------------------
  // Stop the daemon so no live process reads the config mid-mutation.
  if (willRestart) {
    const stopRes = await stopDaemon(supervisor);
    if (!stopRes.ok) {
      return {
        exitCode: 1,
        summary: `Failed to stop daemon: ${stopRes.error.message}`,
      };
    }
  }

  // Back up the config before any mutation (backup-fail-fast).
  const backupRes = writeBackup(opts.configPath, opts.homeDir, "tooling-fill");
  if (!backupRes.ok) {
    // Best-effort restart, then exit 2.
    if (willRestart) {
      await startDaemon(supervisor);
    }
    return {
      exitCode: 2,
      summary: `Backup failed (${backupRes.error.code}): ${backupRes.error.path} — ${backupRes.error.cause}`,
    };
  }
  const backupPath = backupRes.value.backupPath;

  // setHintFields per entry — accumulate into doc.
  for (const entry of filled) {
    const applyRes = setHintFields(doc, entry.kind, entry.name, {
      description: entry.description,
      replacesPackages: entry.replacesPackages,
    });
    if (!applyRes.ok) {
      // Restore from backup + restart.
      const rb = await rollback(opts.configPath, rawYaml, willRestart, supervisor);
      return {
        exitCode: rb.writeOk && rb.startOk ? 1 : 2,
        summary: `setHintFields failed for ${entry.name}: ${applyRes.error.kind} (${applyRes.error.path}). ${rolledBackSuffix(backupPath, opts.configPath, rb)}`,
      };
    }
  }

  // Atomically write the mutated doc over the config.
  const writeRes = atomicWriteFile(opts.configPath, doc.toString());
  if (!writeRes.ok) {
    const rb = await rollback(opts.configPath, rawYaml, willRestart, supervisor);
    return {
      exitCode: 2,
      summary: `Atomic write failed (${writeRes.error.code}): ${writeRes.error.cause}. ${rolledBackSuffix(backupPath, opts.configPath, rb)}`,
    };
  }

  // validateConfig — re-load + validate the freshly written file.
  // Env-substitute `${VAR}` references before validation, mirroring
  // `comis config validate` (commands/config.ts:131-133). Without this, any
  // config using the documented `${COMIS_GATEWAY_TOKEN}` pattern would fail
  // Zod's `z.string().min(32)` on the literal `${...}` (22 chars) and trigger
  // a false-positive rollback on every successful run.
  const reloaded = loadConfigFile(opts.configPath);
  if (!reloaded.ok) {
    const rb = await rollback(opts.configPath, rawYaml, willRestart, supervisor);
    return {
      exitCode: rb.writeOk && rb.startOk ? 1 : 2,
      summary: rolledBackSummary(
        backupPath,
        opts.configPath,
        rb,
        `Reload error: ${reloaded.error.message}`,
      ),
    };
  }
  resolveEnvRefs(reloaded.value);
  const validation = validateConfig(reloaded.value);
  if (!validation.ok) {
    const rb = await rollback(opts.configPath, rawYaml, willRestart, supervisor);
    return {
      exitCode: rb.writeOk && rb.startOk ? 1 : 2,
      summary: rolledBackSummary(backupPath, opts.configPath, rb, undefined),
    };
  }

  // ---- startDaemon + verify-alive --------------------------------------
  // `systemctl start` exits 0 once the unit is queued, not once the daemon
  // has finished booting. If the daemon then crashes during boot (e.g.
  // misowned config, invalid YAML), the orchestrator was previously a
  // false-positive on success. Poll isDaemonRunning() for up to 15s after
  // the start command; if the daemon doesn't come up, restore the backup
  // and try again — never leave the operator with a dead daemon and a
  // "success" message.
  if (willRestart) {
    const startRes = await startDaemon(supervisor);
    if (!startRes.ok) {
      const filledNames = filled.map((f) => f.name).join(", ");
      const droppedReport = renderDroppedReport(filled);
      const skippedReport = renderSkippedReport(skipped);
      return {
        exitCode: 0,
        summary: `Filled ${filled.length} hint(s): ${filledNames}.${droppedReport}${skippedReport} Backup: ${backupPath}. WARNING: daemon failed to restart: ${startRes.error.message}`,
      };
    }
    // Liveness verification: poll until the gateway answers /api/system.ping
    // or we hit the timeout.
    const aliveRes = await waitForDaemonAlive(isDaemonRunning);
    if (!aliveRes.ok) {
      // Daemon didn't come up. Try to restore the backup and restart.
      // Whether or not that succeeds, we exit non-zero.
      const rb = await rollback(opts.configPath, rawYaml, willRestart, supervisor);
      const filledNames = filled.map((f) => f.name).join(", ");
      return {
        exitCode: 2,
        summary: `Daemon failed to come up after start (${aliveRes.error.message}). Filled hints (${filledNames}) were rolled back to ${backupPath}. ${rolledBackSuffix(backupPath, opts.configPath, rb)}`,
      };
    }
  }

  // ---- Partial success on --all -----------------------------------------
  if (skipped.length > 0) {
    const filledNames = filled.map((f) => f.name).join(", ");
    const skippedReport = skipped
      .map((s) => `${s.name} (${s.reason})`)
      .join(", ");
    const droppedReport = renderDroppedReport(filled);
    return {
      exitCode: 1,
      summary: `Filled: ${filledNames}.${droppedReport} Skipped: ${skippedReport}. Backup: ${backupPath}.`,
    };
  }

  // ---- Backup retention --------------------------------------------------
  // Keep the 5 most recent tooling-fill backups, drop older. Best-effort —
  // never failing the success path on a housekeeping miss.
  const pruneRes = pruneOldBackups(opts.homeDir, "tooling-fill", 5);
  const pruneSuffix = pruneRes.deleted > 0 ? ` (pruned ${pruneRes.deleted} older backup(s))` : "";

  // ---- Success exit ------------------------------------------------------
  const filledNames = filled.map((f) => f.name).join(", ");
  const droppedReport = renderDroppedReport(filled);
  return {
    exitCode: 0,
    summary: `Filled ${filled.length} hint(s): ${filledNames}.${droppedReport} Backup: ${backupPath}.${pruneSuffix}`,
  };
}

/** Append "(dropped N invalid package name(s): …)" to summary if any. */
function renderDroppedReport(filled: readonly FilledEntry[]): string {
  const total = filled.reduce((acc, f) => acc + f.dropped.length, 0);
  if (total === 0) return "";
  const allDropped = filled.flatMap((f) => f.dropped);
  return ` (dropped ${total} invalid package name(s): ${allDropped.join(", ")})`;
}

/** Append "Skipped: name (reason), …" to summary if any. */
function renderSkippedReport(skipped: readonly SkippedEntry[]): string {
  if (skipped.length === 0) return "";
  const report = skipped.map((s) => `${s.name} (${s.reason})`).join(", ");
  return ` Skipped: ${report}.`;
}

/**
 * Restore the backup (atomically write the original raw YAML back) and
 * restart the daemon best-effort. Returns separate flags for write + start
 * so the caller can warn about partial-rollback states.
 */
async function rollback(
  configPath: string,
  originalRawYaml: string,
  willRestart: boolean,
  supervisor: Supervisor,
): Promise<RollbackOutcome> {
  const writeRes = atomicWriteFile(configPath, originalRawYaml);
  let startOk = true;
  let startError: string | undefined;
  if (willRestart) {
    const startRes = await startDaemon(supervisor);
    startOk = startRes.ok;
    if (!startRes.ok) startError = startRes.error.message;
  }
  return {
    writeOk: writeRes.ok,
    startOk,
    writeError: writeRes.ok ? undefined : writeRes.error.cause,
    startError,
  };
}

/** Compose the standard `Validation failed; rolled back …` summary, honestly
 * reflecting any partial-rollback failure. */
function rolledBackSummary(
  backupPath: string,
  configPath: string,
  rb: RollbackOutcome,
  extra: string | undefined,
): string {
  if (!rb.writeOk) {
    return `${TOOLFILL_9_VALIDATION_FAILED_PREFIX} to ${backupPath}. ROLLBACK FAILED: could not restore (${rb.writeError ?? "unknown"}). Manual recovery required: cp ${backupPath} ${configPath}.${extra ? ` ${extra}` : ""}`;
  }
  if (!rb.startOk) {
    return `${TOOLFILL_9_VALIDATION_FAILED_PREFIX} to ${backupPath}. File restored but daemon FAILED TO RESTART (${rb.startError ?? "unknown"}). Restart manually.${extra ? ` ${extra}` : ""}`;
  }
  return `${TOOLFILL_9_VALIDATION_FAILED_PREFIX} to ${backupPath}. Original daemon state restored.${extra ? ` ${extra}` : ""}`;
}

/** Compact rollback-state suffix appended to non-validation error summaries. */
function rolledBackSuffix(
  backupPath: string,
  configPath: string,
  rb: RollbackOutcome,
): string {
  if (!rb.writeOk) {
    return `ROLLBACK FAILED — manual recovery: cp ${backupPath} ${configPath}.`;
  }
  if (!rb.startOk) {
    return `Rolled back to ${backupPath} but daemon FAILED TO RESTART (${rb.startError ?? "unknown"}). Restart manually.`;
  }
  return `Rolled back to ${backupPath}. Original daemon state restored.`;
}

/** Pattern matching `${VAR_NAME}` env var references — mirrors the same
 * pattern in commands/config.ts:resolveEnvRefs. */
const ENV_REF_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Deep-walk an object and resolve `${VAR}` references using process.env.
 * Mutates in place. Mirrors `commands/config.ts:resolveEnvRefs` so the
 * post-write `validateConfig` call sees the same substituted shape that
 * `comis config validate` would. Without this, configs using the documented
 * `${COMIS_GATEWAY_TOKEN}` pattern fail Zod's min(32) check on the literal
 * `${...}` (22 chars) and trigger a false-positive rollback.
 */
function resolveEnvRefs(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.includes("${")) {
      obj[key] = value.replace(ENV_REF_RE, (match, varName: string) => {
        return systemGetEnv(varName) ?? match;
      });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      resolveEnvRefs(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") {
          resolveEnvRefs(item as Record<string, unknown>);
        }
      }
    }
  }
}
