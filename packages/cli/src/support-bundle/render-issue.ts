// SPDX-License-Identifier: Apache-2.0
/**
 * Render the paste-into-GitHub issue summary from a `SupportTriage`.
 *
 * The render is a pure, deterministic function of the triage: it reads no
 * clock, performs no I/O, and enumerates no host beyond the version facts the
 * triage already carries. Generation time lives only on the manifest, so the
 * summary stays byte-identical for a given verdict — a snapshot can pin it.
 *
 * @module
 */

import { type SupportTriage } from "./types.js";

/** Stable placeholder for an optional version the host snapshot could not read. */
const UNKNOWN_VERSION = "unknown";

/**
 * Compose the reporter-facing markdown: status, active signals, host versions,
 * the doctor counts, the suggested next steps, and the evidence-file index.
 *
 * Empty lists degrade to an explicit "none" line so the section structure is
 * stable across every verdict. Values are rendered in the order the triage
 * carries them (the reducer produces a deterministic order); nothing here sorts
 * or re-derives, keeping the output a pure function of the input.
 *
 * @param triage - The deterministic triage verdict.
 * @returns Markdown suitable for pasting into a GitHub issue.
 */
export function renderIssueSummary(triage: SupportTriage): string {
  const lines: string[] = [];

  lines.push("# Comis support summary");
  lines.push("");
  lines.push(`**Status:** \`${triage.status}\``);
  lines.push("");

  lines.push("## Active signals");
  lines.push("");
  if (triage.activeSignals.length > 0) {
    for (const signal of triage.activeSignals) {
      lines.push(`- \`${signal}\``);
    }
  } else {
    lines.push("No active signals detected.");
  }
  lines.push("");

  const host = triage.host;
  lines.push("## Versions");
  lines.push("");
  lines.push(`- CLI: \`${host.cliVersion ?? UNKNOWN_VERSION}\``);
  lines.push(`- Daemon: \`${host.daemonVersion ?? UNKNOWN_VERSION}\``);
  lines.push(`- Node: \`${host.nodeVersion}\``);
  lines.push(`- Platform: \`${host.platform}\` (\`${host.arch}\`)`);
  lines.push("");

  const doctor = triage.doctorSummary;
  lines.push("## Doctor summary");
  lines.push("");
  lines.push(`- Checks run: ${doctor.checksRun}`);
  lines.push(`- Pass: ${doctor.pass}`);
  lines.push(`- Warn: ${doctor.warn}`);
  lines.push(`- Fail: ${doctor.fail}`);
  lines.push(`- Skip: ${doctor.skip}`);
  lines.push(`- Repairable: ${doctor.repairable}`);
  if (doctor.failing.length > 0) {
    const failing = doctor.failing.map((check) => `\`${check}\``).join(", ");
    lines.push(`- Failing checks: ${failing}`);
  }
  lines.push("");

  lines.push("## Suggested next steps");
  lines.push("");
  if (triage.reporterNextSteps.length > 0) {
    triage.reporterNextSteps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
  } else {
    lines.push("No suggested next steps.");
  }
  lines.push("");

  lines.push("## Evidence files");
  lines.push("");
  if (triage.evidenceFiles.length > 0) {
    for (const file of triage.evidenceFiles) {
      lines.push(`- \`${file.path}\` — ${file.description}`);
    }
  } else {
    lines.push("No evidence files.");
  }
  lines.push("");

  return lines.join("\n");
}
