// SPDX-License-Identifier: Apache-2.0
/**
 * Render the AI-fillable GitHub issue draft from a `SupportTriage`.
 *
 * The draft pre-fills the auto-known facts the triage already carries — host
 * versions, the triage status, the active signals, and the doctor counts — and
 * leaves two REQUIRED slots (repro steps and expected-vs-actual) as literal
 * `do not invent` instructions, so a downstream assistant files a faithful issue
 * without fabricating the facts it cannot know.
 *
 * Like the issue summary, the render is a pure, deterministic function of the
 * triage: it reads no clock, performs no I/O, and enumerates no host beyond the
 * version facts the triage already carries. Generation time lives only on the
 * manifest, so the draft stays byte-identical for a given verdict — a snapshot
 * can pin it.
 *
 * @module
 */

import { type SupportTriage } from "./types.js";

/** Stable placeholder for an optional version the host snapshot could not read. */
const UNKNOWN_VERSION = "unknown";

/** The repro-steps slot the reporter/AI fills — never auto-populated. */
const REQUIRED_REPRO = "<REQUIRED: paste repro steps — do not invent>";

/** The expected-vs-actual slot the reporter/AI fills — never auto-populated. */
const REQUIRED_EXPECTED_VS_ACTUAL =
  "<REQUIRED: expected behavior vs. actual behavior — do not invent>";

/**
 * Compose the AI-fillable issue draft: the two REQUIRED slots the reporter must
 * fill, then the auto-known facts pre-filled from the triage — host versions,
 * the triage status, the active signals, and the doctor counts.
 *
 * Empty lists degrade to an explicit "none" line so the section structure is
 * stable across every verdict. The REQUIRED slots are literal instructions and
 * are never interpolated with invented facts; only triage fields the reducer
 * actually holds are pre-filled. Values are rendered in the order the triage
 * carries them (the reducer produces a deterministic order); nothing here sorts
 * or re-derives, keeping the output a pure function of the input.
 *
 * @param triage - The deterministic triage verdict.
 * @returns Markdown suitable for filing as a GitHub issue once the REQUIRED
 *   slots are filled.
 */
export function renderAiIssueDraft(triage: SupportTriage): string {
  const lines: string[] = [];

  lines.push("# Comis issue draft");
  lines.push("");
  lines.push(
    "Fill the REQUIRED sections below, then file this as a GitHub issue. The " +
      "environment, triage status, active signals, and doctor summary are " +
      "pre-filled from the local triage.",
  );
  lines.push("");

  lines.push("## Steps to reproduce");
  lines.push("");
  lines.push(REQUIRED_REPRO);
  lines.push("");

  lines.push("## Expected vs. actual");
  lines.push("");
  lines.push(REQUIRED_EXPECTED_VS_ACTUAL);
  lines.push("");

  const host = triage.host;
  lines.push("## Environment");
  lines.push("");
  lines.push(`- CLI: \`${host.cliVersion ?? UNKNOWN_VERSION}\``);
  lines.push(`- Daemon: \`${host.daemonVersion ?? UNKNOWN_VERSION}\``);
  lines.push(`- Node: \`${host.nodeVersion}\``);
  lines.push(`- Platform: \`${host.platform}\` (\`${host.arch}\`)`);
  lines.push("");

  lines.push("## Triage status");
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

  return lines.join("\n");
}
