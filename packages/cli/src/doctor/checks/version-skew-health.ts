// SPDX-License-Identifier: Apache-2.0
/**
 * CLI <-> daemon version-skew check for `comis doctor`.
 *
 * Detects when the `comis` CLI binary running this command is out of sync with
 * the daemon it is talking to. Major/minor skew can make CLI-side schema
 * diagnostics disagree with the daemon's active contract.
 *
 * Behaviour:
 *   - PASS when the CLI version equals the daemon's reported version.
 *   - WARN when they differ; a major.minor mismatch gets stronger remediation.
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
const MAX_VERSION_LENGTH = 128;

/** Extract "major.minor" from a semver-ish string ("2.30.1" -> "2.30"). */
function majorMinor(version: string): string {
  const parts = version.split(".");
  return `${parts[0] ?? ""}.${parts[1] ?? ""}`;
}

function isSemanticVersion(version: string): boolean {
  if (version.length === 0 || version.length > MAX_VERSION_LENGTH) return false;
  for (const char of version) {
    const code = char.charCodeAt(0);
    const allowed =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      char === "." ||
      char === "-" ||
      char === "+";
    if (!allowed) return false;
  }

  const plusIndex = version.indexOf("+");
  if (plusIndex !== version.lastIndexOf("+")) return false;
  const hyphenIndex = version.indexOf("-");
  const separatorIndexes = [hyphenIndex, plusIndex].filter((index) => index >= 0);
  const coreEnd = separatorIndexes.length === 0 ? version.length : Math.min(...separatorIndexes);
  const parts = version.slice(0, coreEnd).split(".");
  if (parts.length !== 3 || !parts.every(isNumericVersionPart)) return false;

  if (hyphenIndex === coreEnd) {
    const prereleaseEnd = plusIndex > hyphenIndex ? plusIndex : version.length;
    if (!hasNonEmptyIdentifiers(version.slice(hyphenIndex + 1, prereleaseEnd))) return false;
  }
  return plusIndex < 0 || hasNonEmptyIdentifiers(version.slice(plusIndex + 1));
}

function isNumericVersionPart(part: string): boolean {
  if (part.length === 0 || (part.length > 1 && part.startsWith("0"))) return false;
  for (const char of part) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function hasNonEmptyIdentifiers(value: string): boolean {
  return value.length > 0 && value.split(".").every((identifier) => identifier.length > 0);
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
    if (!cliVersion || !isSemanticVersion(cliVersion)) {
      // Unknowable CLI version — nothing to compare against. Skip rather than
      // guess (the doctor command normally threads this in).
      return [
        {
          category: CATEGORY,
          check: "CLI/daemon version",
          status: "skip",
          message: "CLI did not provide a valid semantic version; version skew was not checked",
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
    } catch {
      // Auth-rejected / transport error / contract-parse failure — none of
      // which is a version-skew verdict. Skip with the reason.
      return [
        {
          category: CATEGORY,
          check: "CLI/daemon version",
          status: "skip",
          message: `Could not read daemon version (CLI is v${cliVersion}).`,
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
          message: `Daemon did not report a version (CLI is v${cliVersion}).`,
          repairable: false,
        },
      ];
    }

    if (!isSemanticVersion(daemonVersion)) {
      return [
        {
          category: CATEGORY,
          check: "CLI/daemon version",
          status: "skip",
          message:
            "Daemon did not provide a valid semantic version; version skew was not checked",
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

    // Major/minor skew can make the two processes apply different schemas.
    const majorMinorMismatch = majorMinor(cliVersion) !== majorMinor(daemonVersion);
    if (majorMinorMismatch) {
      return [
        {
          category: CATEGORY,
          check: "CLI/daemon version",
          status: "warn",
          message:
            `CLI v${cliVersion} vs daemon v${daemonVersion} — major/minor versions ` +
            "differ, so CLI-side schema diagnostics may be unreliable.",
          suggestion:
            "Run doctor from the deployed build that matches the daemon, or install " +
            "the matching CLI release.",
          repairable: false,
        },
      ];
    }

    // Patch-level skew is still worth surfacing so the operator knows the
    // binaries differ.
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
