// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for the support-bundle schema module.
 *
 * These pin the strict-schema teeth: the parser accepts a well-formed value
 * and rejects any object carrying an unknown key, a closed-enum violation, or
 * a drifted schema version. A later reader parses a possibly-corrupt artifact
 * back into a typed object, so unknown-key rejection is the input-validation
 * floor every downstream consumer relies on.
 */

import { describe, it, expect } from "vitest";
import { parseSupportTriage, parseSupportBundleManifest } from "./types.js";

/**
 * Build a well-formed triage object, merging any overrides last so a test can
 * inject an unknown key or an out-of-set value on top of a valid baseline.
 */
function makeValidTriage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    status: "healthy",
    activeSignals: [],
    host: {
      nodeVersion: "v22.0.0",
      platform: "linux",
      arch: "x64",
    },
    doctorSummary: {
      checksRun: 9,
      pass: 9,
      warn: 0,
      fail: 0,
      skip: 0,
      repairable: 0,
      failing: [],
    },
    reporterNextSteps: [],
    maintainerNextSteps: [],
    evidenceFiles: [{ path: "triage.json", description: "machine-readable verdict" }],
    privacy: { redaction: "platform-aware-v1", excludes: ["secrets", "raw-config-values"] },
    ...overrides,
  };
}

describe("parseSupportTriage", () => {
  it("returns ok for a well-formed triage with the data intact", () => {
    const result = parseSupportTriage(makeValidTriage());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.status).toBe("healthy");
      expect(result.value.host.nodeVersion).toBe("v22.0.0");
      expect(result.value.doctorSummary.checksRun).toBe(9);
      expect(result.value.privacy.redaction).toBe("platform-aware-v1");
    }
  });

  it("rejects an object carrying an unknown top-level key", () => {
    const result = parseSupportTriage(makeValidTriage({ bogusKey: 1 }));
    expect(result.ok).toBe(false);
  });

  it("rejects a doctorSummary carrying an unknown nested key", () => {
    const result = parseSupportTriage(
      makeValidTriage({
        doctorSummary: {
          checksRun: 9,
          pass: 9,
          warn: 0,
          fail: 0,
          skip: 0,
          repairable: 0,
          failing: [],
          bogusNested: true,
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a status value outside the closed enum set", () => {
    const result = parseSupportTriage(makeValidTriage({ status: "unknown" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a schemaVersion other than the literal one", () => {
    const result = parseSupportTriage(makeValidTriage({ schemaVersion: 2 }));
    expect(result.ok).toBe(false);
  });

  it("returns ok when the optional fleet and explain summaries are omitted", () => {
    const result = parseSupportTriage(makeValidTriage());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fleetSummary).toBeUndefined();
      expect(result.value.explainSummary).toBeUndefined();
    }
  });

  it("returns ok when the optional fleet and explain summaries are present", () => {
    const result = parseSupportTriage(
      makeValidTriage({
        fleetSummary: {
          degradedRate: 0.25,
          topErrorKinds: [{ kind: "timeout", count: 3 }],
          breakerTripTotal: 1,
          findingCodes: ["config_posture"],
          likelyRootCause: null,
        },
        explainSummary: {
          degraded: true,
          endReason: "spend_exceeded",
          likelyRootCause: "budget ceiling reached",
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fleetSummary?.degradedRate).toBe(0.25);
      expect(result.value.explainSummary?.endReason).toBe("spend_exceeded");
    }
  });

  it("rejects a status of degraded that is missing the required host block", () => {
    const invalid = makeValidTriage({ status: "degraded" });
    delete invalid.host;
    const result = parseSupportTriage(invalid);
    expect(result.ok).toBe(false);
  });
});

/**
 * Build a well-formed bundle manifest, merging overrides last so a test can
 * inject an unknown key or a drifted redaction policy over a valid baseline.
 */
function makeValidManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    bundle: "comis-support",
    generatedAt: "2026-07-03T12:00:00.000Z",
    redaction: { policy: "platform-aware-v1" },
    privacy: { redaction: "platform-aware-v1", excludes: ["secrets", "raw-config-values"] },
    ...overrides,
  };
}

describe("parseSupportBundleManifest", () => {
  it("returns ok for a well-formed bundle manifest", () => {
    const result = parseSupportBundleManifest(makeValidManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.redaction.policy).toBe("platform-aware-v1");
      expect(result.value.warnings).toBeUndefined();
    }
  });

  it("rejects a manifest carrying an unknown top-level key", () => {
    const result = parseSupportBundleManifest(makeValidManifest({ bogus: 1 }));
    expect(result.ok).toBe(false);
  });

  it("returns ok when the optional warnings array is omitted", () => {
    const result = parseSupportBundleManifest(makeValidManifest());
    expect(result.ok).toBe(true);
  });

  it("returns ok when a warnings array of valid entries is present", () => {
    const result = parseSupportBundleManifest(
      makeValidManifest({
        warnings: [
          { source: "doctor", code: "doctor_run_failed", count: 1, message: "doctor checks could not run" },
          {
            source: "writer",
            code: "section_write_failed",
            count: 2,
            rows: [0, 1],
            message: "two files were not written",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings).toHaveLength(2);
    }
  });

  it("rejects a redaction policy other than the pinned literal", () => {
    const result = parseSupportBundleManifest(makeValidManifest({ redaction: { policy: "some-other-policy" } }));
    expect(result.ok).toBe(false);
  });

  it("rejects a warning entry that carries an unknown key", () => {
    const result = parseSupportBundleManifest(
      makeValidManifest({
        warnings: [{ source: "host", code: "x", count: 1, message: "m", bogus: true }],
      }),
    );
    expect(result.ok).toBe(false);
  });
});
