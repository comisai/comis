// SPDX-License-Identifier: Apache-2.0
/**
 * Render tests for the paste-into-GitHub issue summary.
 *
 * Two invariants are pinned: the render is a pure function of the triage (same
 * input, same output — it reads no clock and enumerates no host), and it carries
 * no ISO timestamp or date token (only the manifest stamps generation time). A
 * snapshot fixes the exact markdown so a wording drift is caught in review.
 */

import { describe, it, expect } from "vitest";

import { renderIssueSummary } from "./render-issue.js";
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

describe("renderIssueSummary", () => {
  it("renders a deterministic markdown summary from a fixed triage", () => {
    expect(renderIssueSummary(makeTriage())).toMatchInlineSnapshot();
  });

  it("is a pure function of the triage (same input, same output)", () => {
    const triage = makeTriage();
    expect(renderIssueSummary(triage)).toBe(renderIssueSummary(triage));
  });

  it("carries no ISO timestamp or date token", () => {
    const out = renderIssueSummary(makeTriage());
    expect(out).not.toMatch(/\d{4}-\d\d-\d\dT/);
    expect(out).not.toMatch(/\d{4}-\d\d-\d\d/);
  });

  it("covers status, signals, versions, doctor counts, next steps, and evidence", () => {
    const out = renderIssueSummary(makeTriage());
    expect(out).toContain("degraded");
    expect(out).toContain("daemon_down");
    expect(out).toContain("config_posture:chimeric_model");
    expect(out).toContain("v22.21.1");
    expect(out).toContain("Checks run: 9");
    expect(out).toContain("Repairable: 1");
    expect(out).toContain("comis doctor --repair");
    expect(out).toContain("triage.json");
    expect(out).toContain("machine-readable verdict");
  });

  it("renders fallbacks when signals and steps are empty and versions are absent", () => {
    const out = renderIssueSummary(
      makeTriage({
        status: "insufficient_evidence",
        activeSignals: [],
        reporterNextSteps: [],
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
    // An absent optional version renders a stable token, never a clock read.
    expect(out).toContain("unknown");
    // No failing-checks line when nothing failed.
    expect(out).not.toContain("Failing checks:");
  });
});
