// SPDX-License-Identifier: Apache-2.0
/**
 * CLI <-> daemon version-skew check for `comis doctor`.
 *
 * Detects when the `comis` CLI binary running this command is out of sync with
 * the daemon it is talking to. Motivating failure mode: a stale global `comis`
 * (from `npm i -g comisai`) earlier on PATH than a freshly-built daemon
 * validates config against an OLD schema and reports PHANTOM failures
 * (a valid `agents.default.autonomy` flagged "Unrecognized key", "No OAuth
 * profiles stored"). Without this check nothing surfaces the version mismatch,
 * making that diagnosis needlessly slow. This check makes the skew explicit.
 *
 * Behaviour:
 *   - PASS when the CLI version equals the daemon's reported version.
 *   - WARN when they differ; a major.minor mismatch gets a stronger,
 *     remediation-bearing message naming the stale-global-`comis` failure mode.
 *   - SKIP (never fail, never throw) when the daemon is unreachable or does not
 *     report a version (`version` is optional on the `gateway.status` contract).
 *
 * The CLI version is threaded in via `context.cliVersion` (set by the doctor
 * command from `packages/cli/package.json`) so this check is deterministic and
 * unit-testable; it falls back to reading its own package.json when absent.
 *
 * @module
 */

import { GatewayStatusContract } from "@comis/core";
import type { DoctorCheck } from "../types.js";
import { isDaemonRunning } from "../../sync-tooling/daemon-guard.js";
import { withClient, callTyped } from "../../client/rpc-client.js";
import { readCliVersion } from "../../util/cli-version.js";

const CATEGORY = "version";
const LIVENESS_PROBE_TIMEOUT_MS = 1_000;

/** Extract "major.minor" from a semver-ish string ("2.30.1" -> "2.30"). */
function majorMinor(version: string): string {
  const parts = version.split(".");
  return `${parts[0] ?? ""}.${parts[1] ?? ""}`;
}

/**
 * Doctor check: CLI <-> daemon version skew.
 *
 * Never throws — every path returns a finding. Skips cleanly when the daemon
 * is down or does not report a version.
 */
export const versionSkewHealthCheck: DoctorCheck = {
  id: "version-skew-health",
  name: "Version",
  run: async (context) => {
    const cliVersion = context.cliVersion ?? readCliVersion();
    if (!cliVersion) {
      // Unknowable CLI version — nothing to compare against. Skip rather than
      // guess (the doctor command normally threads this in).
      return [
        {
          category: CATEGORY,
          check: "CLI/daemon version",
          status: "skip",
          message: "CLI version unavailable — cannot check version skew",
          repairable: false,
        },
      ];
    }

    // Only probe the daemon when it is actually up. A down daemon is not a
    // version-skew failure — the daemon health check owns that signal.
    const daemonUp = await isDaemonRunning(LIVENESS_PROBE_TIMEOUT_MS);
    if (!daemonUp) {
      return [
        {
          category: CATEGORY,
          check: "CLI/daemon version",
          status: "skip",
          message:
            `Daemon not reachable — version skew not checked (CLI is v${cliVersion}).`,
          repairable: false,
        },
      ];
    }

    let daemonVersion: string | undefined;
    try {
      const status = await withClient((client) =>
        callTyped(client, GatewayStatusContract, {}),
      );
      // `version` is optional on the contract: a daemon may return a status
      // payload without it, and that is a skip — not a skew verdict.
      daemonVersion =
        typeof status.version === "string" ? status.version : undefined;
    } catch (e) {
      // Auth-rejected / transport error / contract-parse failure — none of
      // which is a version-skew verdict. Skip with the reason.
      return [
        {
          category: CATEGORY,
          check: "CLI/daemon version",
          status: "skip",
          message:
            `Could not read daemon version (CLI is v${cliVersion}): ` +
            `${e instanceof Error ? e.message : String(e)}`,
          repairable: false,
        },
      ];
    }

    if (!daemonVersion) {
      return [
        {
          category: CATEGORY,
          check: "CLI/daemon version",
          status: "skip",
          message:
            `Daemon did not report a version (CLI is v${cliVersion}); ` +
            "it may be an older build predating the version field.",
          repairable: false,
        },
      ];
    }

    if (daemonVersion === cliVersion) {
      return [
        {
          category: CATEGORY,
          check: "CLI/daemon version",
          status: "pass",
          message: `CLI and daemon are both v${cliVersion}`,
          repairable: false,
        },
      ];
    }

    // Versions differ. A major.minor mismatch is the dangerous case: an old
    // global `comis` validates config against a stale schema and reports
    // phantom failures. Call it out explicitly with remediation.
    const majorMinorMismatch = majorMinor(cliVersion) !== majorMinor(daemonVersion);
    if (majorMinorMismatch) {
      return [
        {
          category: CATEGORY,
          check: "CLI/daemon version",
          status: "warn",
          message:
            `CLI v${cliVersion} vs daemon v${daemonVersion} — you may be running ` +
            "a stale global `comis`. A CLI on an OLDER major.minor validates config " +
            "with an out-of-date schema and can report PHANTOM failures (e.g. a " +
            "valid key flagged \"Unrecognized\").",
          suggestion:
            "Run doctor via the deployed build that matches the daemon " +
            "(e.g. `node packages/cli/dist/cli.js doctor`), or update/remove the " +
            "stale global install (`npm i -g comisai@latest` or `npm rm -g comisai`).",
          repairable: false,
        },
      ];
    }

    // Patch-level skew only — far less likely to cause schema phantoms, but
    // still worth surfacing so the operator knows the binaries drifted.
    return [
      {
        category: CATEGORY,
        check: "CLI/daemon version",
        status: "warn",
        message: `CLI v${cliVersion} vs daemon v${daemonVersion} — versions differ (patch-level).`,
        suggestion:
          "Rebuild/reinstall so the CLI and daemon are on the same version.",
        repairable: false,
      },
    ];
  },
};
