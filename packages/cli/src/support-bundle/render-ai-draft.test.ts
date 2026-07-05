// SPDX-License-Identifier: Apache-2.0
/**
 * Render tests for the AI-fillable GitHub issue draft.
 *
 * The draft pre-fills only the facts the triage actually holds (versions,
 * status, active signals, doctor counts) and leaves two REQUIRED slots — repro
 * steps and expected-vs-actual — as literal `do not invent` instructions to the
 * downstream assistant. Two invariants are pinned: the render is a pure function
 * of the triage (same input, same output — it reads no clock and enumerates no
 * host) and it carries no ISO timestamp or date token (only the manifest stamps
 * generation time). A snapshot fixes the exact markdown so a wording drift is
 * caught in review.
 */

import { describe, it, expect } from "vitest";

import { renderAiIssueDraft } from "./render-ai-draft.js";
import { type SupportTriage } from "./types.js";

/**
 * Build a well-formed triage, merging overrides last so a case can null out an
 * optional version or empty a list on top of a rich baseline.
 */
function makeTriage(overrides: Partial<SupportTriage> = {}): SupportTriage {
  return {
    schemaVersion: 1,
    status: "degraded",
    activeSignals: ["daemon_down", "config_posture:chimeric_model"],
    host: {
      cliVersion: "1.0.45",
      daemonVersion: "1.0.45",
      nodeVersion: "v22.21.1",
      platform: "linux",
      arch: "x64",
    },
    doctorSummary: {
      checksRun: 9,
      pass: 7,
      warn: 1,
      fail: 1,
      skip: 0,
      repairable: 1,
      failing: ["config", "gateway"],
    },
    reporterNextSteps: [
      "Run `comis doctor --repair` to fix the repairable checks.",
      "Start the daemon, then generate the bundle again.",
    ],
    maintainerNextSteps: ["comis fleet --since 24"],
    evidenceFiles: [
      { path: "triage.json", description: "machine-readable verdict" },
      { path: "doctor.json", description: "full diagnostic findings" },
    ],
    privacy: {
      redaction: "platform-aware-v1",
      excludes: ["secrets", "raw-config-values"],
    },
    ...overrides,
  };
}

describe("renderAiIssueDraft", () => {
  it("renders a deterministic markdown draft from a fixed triage", () => {
    expect(renderAiIssueDraft(makeTriage())).toMatchInlineSnapshot(`
      "# Comis issue draft

      Fill the REQUIRED sections below, then file this as a GitHub issue. The environment, triage status, active signals, and doctor summary are pre-filled from the local triage.

      ## Steps to reproduce

      <REQUIRED: paste repro steps — do not invent>

      ## Expected vs. actual

      <REQUIRED: expected behavior vs. actual behavior — do not invent>

      ## Environment

      - CLI: \`1.0.45\`
      - Daemon: \`1.0.45\`
      - Node: \`v22.21.1\`
      - Platform: \`linux\` (\`x64\`)

      ## Triage status

      **Status:** \`degraded\`

      ## Active signals

      - \`daemon_down\`
      - \`config_posture:chimeric_model\`

      ## Doctor summary

      - Checks run: 9
      - Pass: 7
      - Warn: 1
      - Fail: 1
      - Skip: 0
      - Repairable: 1
      - Failing checks: \`config\`, \`gateway\`
      "
    `);
  });

  it("emits both REQUIRED placeholders, each carrying the do-not-invent instruction", () => {
    const out = renderAiIssueDraft(makeTriage());

    // The two load-bearing slots the reporter/AI must fill — never auto-filled.
    expect(out).toContain("<REQUIRED: paste repro steps");
    expect(out).toContain("expected behavior vs. actual behavior");

    // Every REQUIRED line is a literal instruction, not a fabricated fact.
    const requiredLines = out.split("\n").filter((line) => line.includes("<REQUIRED:"));
    expect(requiredLines).toHaveLength(2);
    for (const line of requiredLines) {
      expect(line).toContain("do not invent");
    }
  });

  it("pre-fills the auto-known facts (status, signals, versions, doctor counts) from the triage", () => {
    const out = renderAiIssueDraft(makeTriage());
    expect(out).toContain("degraded");
    expect(out).toContain("daemon_down");
    expect(out).toContain("config_posture:chimeric_model");
    expect(out).toContain("v22.21.1");
    expect(out).toContain("Checks run: 9");
    expect(out).toContain("Repairable: 1");
    expect(out).toContain("Failing checks: `config`, `gateway`");
  });

  it("is a pure function of the triage (same input, same output)", () => {
    const triage = makeTriage();
    expect(renderAiIssueDraft(triage)).toBe(renderAiIssueDraft(triage));
  });

  it("carries no ISO timestamp or date token", () => {
    const out = renderAiIssueDraft(makeTriage());
    expect(out).not.toMatch(/\d{4}-\d\d-\d\dT/);
    expect(out).not.toMatch(/\d{4}-\d\d-\d\d/);
  });

  it("renders stable fallbacks when signals are empty and versions absent, still emitting both REQUIRED slots", () => {
    const out = renderAiIssueDraft(
      makeTriage({
        status: "insufficient_evidence",
        activeSignals: [],
        host: { nodeVersion: "v22.21.1", platform: "linux", arch: "x64" },
        doctorSummary: {
          checksRun: 0,
          pass: 0,
          warn: 0,
          fail: 0,
          skip: 0,
          repairable: 0,
          failing: [],
        },
      }),
    );
    expect(out).toContain("insufficient_evidence");
    expect(out).not.toMatch(/\d{4}-\d\d-\d\dT/);
    // Absent optional versions render a stable token, never a clock read.
    expect(out).toContain("unknown");
    // Empty signals degrade to an explicit line, never a crash.
    expect(out).toContain("No active signals detected.");
    // No failing-checks line when nothing failed.
    expect(out).not.toContain("Failing checks:");
    // The REQUIRED slots survive every verdict.
    expect(out).toContain("<REQUIRED: paste repro steps");
    expect(out).toContain("expected behavior vs. actual behavior");
  });
});
