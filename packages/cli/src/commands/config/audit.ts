// SPDX-License-Identifier: Apache-2.0
/**
 * `comis config audit show|scrub` subcommands (Plan 45-05 task 12).
 *
 * Two subcommands surface the daemon-wide
 * `~/.comis/logs/config-audit.jsonl` log via the
 * `config.audit.list` + `config.audit.scrub` RPC contracts:
 *
 *   - `comis config audit show [--since 1h] [--suspicious-only]
 *      [--pid <n>] [--tail <n>] [--format table|json]` — list recent
 *      records with caller provenance, hash diff, suspicious flags.
 *
 *   - `comis config audit scrub [--dry-run]` — re-run the redactor
 *      pipeline over the historical log; dry-run computes counters
 *      without rewriting.
 *
 * Both methods call through `callTyped` with the typed RPC contracts
 * from `@comis/core/api-contracts/config.ts`.
 *
 * @module
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  ConfigAuditListContract,
  ConfigAuditScrubContract,
} from "@comis/core";
import {
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  appendConfigAuditRecordSync,
  resolveConfigAuditLogPath,
  getDefaultConfigAuditConfinedBase,
  type ConfigWriteAuditRecordBase,
} from "@comis/observability";
import type { Result } from "@comis/shared";

import { callTyped, withClient } from "../../client/rpc-client.js";
import { error, info, json, success, warn } from "../../output/format.js";

// ---------------------------------------------------------------------------
// CLI sync-tooling audit helpers (Plan 45-05 task 9 -- extracted from
// config.ts to keep that file under the 800-line cap).
// ---------------------------------------------------------------------------

/** Build the pre-write audit base for the CLI sync-tooling write site. */
export function buildCliSyncToolingAuditBase(
  configPath: string,
): ConfigWriteAuditRecordBase | undefined {
  try {
    return createConfigWriteAuditRecordBase({
      source: "cli-sync-tooling",
      configPath,
      // eslint-disable-next-line no-restricted-syntax -- CLI trust-boundary read of process.* for audit-log provenance
      pid: process.pid,
      // eslint-disable-next-line no-restricted-syntax -- CLI trust-boundary read of process.* for audit-log provenance
      ppid: process.ppid,
      // eslint-disable-next-line no-restricted-syntax -- CLI trust-boundary read of process.* for audit-log provenance
      argv: process.argv,
      // eslint-disable-next-line no-restricted-syntax -- CLI trust-boundary read of process.* for audit-log provenance
      cwd: process.cwd(),
      // eslint-disable-next-line no-restricted-syntax -- CLI trust-boundary read of process.* for audit-log provenance
      execArgv: process.execArgv,
      watchMode: false,
    });
  } catch {
    return undefined;
  }
}

/**
 * Finalize + sync-append the audit record for the CLI sync-tooling
 * write site. Failures swallowed (audit is a forensics aid).
 */
export function appendCliSyncToolingAudit(
  base: ConfigWriteAuditRecordBase | undefined,
  written: Result<unknown, { code?: string; cause?: string }>,
): void {
  if (base === undefined) return;
  try {
    const finalize = written.ok
      ? ({ result: "rename" as const })
      : {
          result: "failed" as const,
          ...(written.error.code !== undefined && { errorCode: written.error.code }),
          ...(written.error.cause !== undefined && { errorMessage: written.error.cause }),
        };
    const record = finalizeConfigWriteAuditRecord(base, finalize);
    const auditLogPath = resolveConfigAuditLogPath();
    const auditConfinedBase = getDefaultConfigAuditConfinedBase(auditLogPath);
    appendConfigAuditRecordSync({
      filePath: auditLogPath,
      record,
      // TRAJ-FIX-01: confine the audit-log write to ~/.comis/ when the
      // default log path applies; skip confinement when the operator
      // set COMIS_CONFIG_AUDIT_LOG to a custom location.
      ...(auditConfinedBase !== undefined && {
        confinedBaseDir: auditConfinedBase,
      }),
    });
  } catch {
    // Audit failures swallowed.
  }
}

/**
 * Register the `audit` subcommand group on the parent `config`
 * command. The parent is expected to be created by
 * `registerConfigCommand` in `../config.ts`; this helper only adds
 * the `audit` subgroup.
 */
export function registerConfigAuditCommand(configCmd: Command): void {
  const audit = configCmd
    .command("audit")
    .description("Inspect / maintain the daemon-wide config-audit log");

  // ---------------------------------------------------------------------------
  // config audit show
  // ---------------------------------------------------------------------------

  audit
    .command("show")
    .description("List recent config-audit records")
    .option(
      "--since <window>",
      "Time window: '1h', '24h', or ISO-8601 timestamp",
    )
    .option("--until <window>", "Upper-bound time window")
    .option(
      "--suspicious-only",
      "Show only records with non-empty suspicious[] flags",
    )
    .option("--pid <n>", "Filter to caller pid", (v) => parseInt(v, 10))
    .option("--tail <n>", "Cap at most N records", (v) => parseInt(v, 10))
    .option("--format <format>", "Output format (table|json)", "table")
    .action(
      async (options: {
        since?: string;
        until?: string;
        suspiciousOnly?: boolean;
        pid?: number;
        tail?: number;
        format: string;
      }) => {
        try {
          const result = await withClient(async (client) => {
            const params: {
              since?: string;
              until?: string;
              suspiciousOnly?: boolean;
              pid?: number;
              tail?: number;
            } = {};
            if (options.since !== undefined) params.since = options.since;
            if (options.until !== undefined) params.until = options.until;
            if (options.suspiciousOnly === true) params.suspiciousOnly = true;
            if (options.pid !== undefined) params.pid = options.pid;
            if (options.tail !== undefined) params.tail = options.tail;
            return await callTyped(client, ConfigAuditListContract, params);
          });

          const records = result.records;
          if (options.format === "json") {
            json(records);
            return;
          }

          if (records.length === 0) {
            info("No config-audit records match the filter.");
            return;
          }

          for (const r of records) {
            renderConfigAuditRecord(r as Record<string, unknown>);
          }
          info(`${records.length} record${records.length !== 1 ? "s" : ""}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to list config-audit records: ${msg}`);
          process.exit(1);
        }
      },
    );

  // ---------------------------------------------------------------------------
  // config audit scrub
  // ---------------------------------------------------------------------------

  audit
    .command("scrub")
    .description("Retroactively re-run the redactor over the audit log")
    .option(
      "--dry-run",
      "Compute counters without rewriting the file",
    )
    .action(async (options: { dryRun?: boolean }) => {
      try {
        const result = await withClient(async (client) =>
          callTyped(client, ConfigAuditScrubContract, {
            dryRun: options.dryRun === true,
          }),
        );

        if (result.aborted) {
          warn(
            "Scrub aborted: file grew during the rewrite (concurrent append). The audit log was left intact; retry when the daemon is quiet.",
          );
          return;
        }

        if (options.dryRun === true) {
          info(
            `Would rewrite ${result.rewrittenRecords} record${result.rewrittenRecords !== 1 ? "s" : ""} (${result.skippedMalformed} malformed line${result.skippedMalformed !== 1 ? "s" : ""} would be preserved verbatim).`,
          );
        } else {
          success(
            `Rewrote ${result.rewrittenRecords} record${result.rewrittenRecords !== 1 ? "s" : ""}, skipped ${result.skippedMalformed} malformed line${result.skippedMalformed !== 1 ? "s" : ""}.`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to scrub config-audit log: ${msg}`);
        process.exit(1);
      }
    });
}

/**
 * Pretty-print one config-audit record per design §9.7.
 */
function renderConfigAuditRecord(r: Record<string, unknown>): void {
  const ts = typeof r.ts === "string" ? r.ts : "(no-ts)";
  const source = typeof r.source === "string" ? r.source : "?";
  const result = typeof r.result === "string" ? r.result : "?";
  const pid = typeof r.pid === "number" ? r.pid : "?";
  const ppid = typeof r.ppid === "number" ? r.ppid : "?";
  const configPath =
    typeof r.configPath === "string" ? r.configPath : "(no-path)";
  const prevHash = typeof r.previousHash === "string" ? r.previousHash : "-";
  const nextHash = typeof r.nextHash === "string" ? r.nextHash : "-";
  const suspicious = Array.isArray(r.suspicious) ? r.suspicious : [];
  const argv = Array.isArray(r.argv) ? r.argv : [];

  const header = chalk.bold(`${ts}  ${source}  ${result}`);
  console.log(header);
  console.log(
    `  pid=${pid} ppid=${ppid} configPath=${configPath}`,
  );
  if (prevHash !== "-" || nextHash !== "-") {
    console.log(
      `  hash: ${chalk.dim(typeof prevHash === "string" ? prevHash.slice(0, 12) : prevHash)} → ${chalk.dim(
        typeof nextHash === "string" ? nextHash.slice(0, 12) : nextHash,
      )}`,
    );
  }
  if (suspicious.length > 0) {
    console.log(
      `  ${chalk.yellow("suspicious:")} ${suspicious.join(", ")}`,
    );
  }
  if (argv.length > 0) {
    console.log(`  argv: ${argv.map((a) => String(a)).join(" ")}`);
  }
  if (typeof r.errorMessage === "string" && r.errorMessage.length > 0) {
    console.log(`  ${chalk.red("error:")} ${r.errorMessage}`);
  }
  console.log("");
}
