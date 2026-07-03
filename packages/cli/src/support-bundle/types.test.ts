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
import { parseSupportTriage } from "./types.js";

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
