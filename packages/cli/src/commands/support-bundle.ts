// SPDX-License-Identifier: Apache-2.0
/**
 * `comis support-bundle` — assemble an offline, paste-ready support bundle.
 *
 * The command is the sanctioned throw/exit boundary for the bundle pipeline: it
 * resolves the data dir + config paths, validates the flag combination, calls
 * the offline orchestrator, and maps the `Result` to a named `ExitCode`. A
 * written bundle is a success even when the triage is degraded or the bundle is
 * partial — the degraded verdict is the content, not a failure. Only a bundle
 * that could not be produced at all is a `GeneralFailure`, and a misused flag is
 * a `UsageError`.
 *
 * In table format it prints the bundle path, the triage status, the reporter
 * next-steps, the privacy notice, and the two copy-paste lines — the `tar`
 * archive command and the `gh issue create` command. Those lines are PRINTED
 * for the operator to run; the command never runs them itself, so the bundle is
 * never transmitted or published on the operator's behalf.
 *
 * @module
 */

import type { Command } from "commander";
import * as os from "node:os";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { systemGetEnv, systemNowMs } from "@comis/core";
import { info, warn, error, json } from "../output/format.js";
import { ExitCode } from "../util/exit-codes.js";
import { resolveOfflineDataDir } from "../util/offline-obs.js";
import { generateSupportBundle } from "../support-bundle/generate.js";

/**
 * Resolve default config paths from COMIS_CONFIG_PATHS or the standard
 * locations. The environment is read via `systemGetEnv` (the sanctioned env
 * reader — never a raw env global) so the globals architecture test passes, and
 * the value is split on ":" exactly as the daemon and the doctor command split
 * it. When the variable is unset, the standard candidate files that exist on
 * disk are used.
 */
function resolveDefaultConfigPaths(): string[] {
  const envPaths = systemGetEnv("COMIS_CONFIG_PATHS");
  if (envPaths) {
    return envPaths.split(":").filter((p) => p.length > 0);
  }
  const candidates = [
    os.homedir() + "/.comis/config.yaml",
    os.homedir() + "/.comis/config.local.yaml",
    "/etc/comis/config.yaml",
    "/etc/comis/config.local.yaml",
  ];
  return candidates.filter((p) => existsSync(p));
}

/** Options parsed by Commander for the support-bundle action. */
interface SupportBundleOptions {
  since: string;
  format: string;
  config?: string[];
  session?: string;
  deep?: boolean;
}

/**
 * Register the `support-bundle` command on the program.
 *
 * Flags: `--since <hours>` (window, default 24), `--format table|json`
 * (default table), `-c/--config <paths...>`, `--session <ref>`, and `--deep`
 * (requires `--session`). `--session` focuses the bundle on one session and
 * embeds its `explain.json` digest; `--deep` additionally embeds that session's
 * redacted per-session trace bundle.
 *
 * @param program - The root Commander program
 */
export function registerSupportBundleCommand(program: Command): void {
  program
    .command("support-bundle")
    .description(
      "Assemble an offline, paste-ready support bundle (triage verdict, health findings, host facts) — works with a stopped daemon",
    )
    .option("--since <hours>", "Window in hours", "24")
    .option("--format <format>", 'Output format: "table" or "json"', "table")
    .option("-c, --config <paths...>", "Config file paths")
    .option(
      "--session <sessionKeyOrTraceId>",
      "Focus the bundle on one session — embeds its explain.json digest (add --deep for the full trace bundle)",
    )
    .option("--deep", "Include deep per-session evidence (requires --session)")
    .action(async (options: SupportBundleOptions) => {
      // Usage guard: --deep only means something with a --session to deepen.
      if (options.deep && !options.session) {
        error("--deep requires --session <sessionKeyOrTraceId>");
        process.exit(ExitCode.UsageError);
      }

      const startedAtMs = systemNowMs();
      const configPaths = options.config ?? resolveDefaultConfigPaths();
      const dataDir = resolveOfflineDataDir();

      // The window must be a positive number of hours. A non-numeric or
      // non-positive value would otherwise ride through as NaN/≤0 with no
      // feedback to the operator and misbehave the moment a fleet read consumes
      // it — reject it at the boundary (the fleet window is likewise constrained
      // to a positive number).
      const sinceHours = Number.parseFloat(options.since);
      if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
        error("--since must be a positive number of hours");
        process.exit(ExitCode.UsageError);
      }

      const result = await generateSupportBundle({
        dataDir,
        configPaths,
        sinceHours,
        nowMs: startedAtMs,
        ...(options.session !== undefined ? { session: options.session } : {}),
        ...(options.deep === true ? { deep: true } : {}),
      });

      // The one hard failure: the bundle directory could not be produced.
      if (!result.ok) {
        error(
          `Support bundle could not be produced (${result.error.errorKind}): ${result.error.reason}`,
        );
        error(`hint: ${result.error.hint}`);
        process.exit(ExitCode.GeneralFailure);
      }

      const { bundleDir, status, activeSignals, warnings, worstSessionKey } = result.value;

      // Machine-readable surface: exactly the triage digest, nothing else.
      if (options.format === "json") {
        json({ bundleDir, status, activeSignals });
        process.exit(ExitCode.Success);
      }

      // Human-readable surface.
      const bundleName = basename(bundleDir);
      const parentDir = dirname(bundleDir);
      const durationMs = systemNowMs() - startedAtMs;

      info(`Bundle written to: ${bundleDir}`);
      info(`Triage status: ${status}`);
      if (activeSignals.length > 0) {
        info(`Active signals: ${activeSignals.join(", ")}`);
      }
      if (warnings.length > 0) {
        warn(`${warnings.length} section(s) were partial — see manifest.json for details`);
      }

      // Reporter next-steps: what to do with the freshly-written bundle. The
      // tar and gh lines are printed for the operator to run — the command
      // never executes them, so nothing is transmitted or published here.
      info("Next steps:");
      info(`  1. Review the bundle, starting with ${bundleName}/issue-summary.md`);
      info("  2. Compress it and attach the archive to your report:");
      info(`       tar czf ${bundleName}.tar.gz -C ${parentDir} ${bundleName}`);
      info("  3. Or open an issue directly from the summary:");
      info(`       gh issue create --body-file ${bundleDir}/issue-summary.md`);

      // Worst-session tip (CLI-side stopgap): when the operator did not focus a
      // session, a best-effort local scan of the rollups may surface the most
      // degraded recent session. Name it and the focused re-run so the operator
      // can drill in — content-free (a sessionKey only), and omitted cleanly when
      // nothing ranked.
      if (worstSessionKey !== undefined) {
        info(
          `Tip: the most-degraded session in a local scan is ${worstSessionKey}. ` +
            `Re-run with --session ${worstSessionKey} --deep for a focused per-session bundle.`,
        );
      }

      // Privacy notice: the default bundle is content-free by construction, but
      // treat it as sensitive all the same. With --deep the bundle additionally
      // embeds the redacted RAW session trajectory (session content, PII-adjacent),
      // so the notice ESCALATES to the trace-bundle discipline — strictly more
      // sensitive than the digest, and never safe to post publicly.
      if (options.deep === true) {
        warn(
          "Privacy (--deep): this bundle embeds the per-session trace export — redacted " +
            "RAW session trajectory (session content, PII-adjacent) that is strictly more " +
            "sensitive than the default digest bundle. Redaction is heuristic, not a " +
            "guarantee — share it ONLY with authorized engineers over a secure channel and " +
            "DELETE it after triage.",
        );
      } else {
        warn(
          "Privacy: this bundle excludes secrets, message bodies, and raw config " +
            "values by construction, but treat it as sensitive — share it only " +
            "with authorized engineers over a secure channel and delete it after triage.",
        );
      }

      info(`Support bundle ready in ${durationMs}ms.`);
      process.exit(ExitCode.Success);
    });
}
