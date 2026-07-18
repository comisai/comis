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
import {
  parseSupportTriage,
  parseSupportBundleManifest,
  parseConfigPosture,
  parseAuditSummary,
} from "./types.js";

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

  it("returns ok when the optional system and explain summaries are omitted", () => {
    const result = parseSupportTriage(makeValidTriage());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.systemSummary).toBeUndefined();
      expect(result.value.explainSummary).toBeUndefined();
    }
  });

  it("returns ok when the optional system and explain summaries are present", () => {
    const result = parseSupportTriage(
      makeValidTriage({
        systemSummary: {
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
      expect(result.value.systemSummary?.degradedRate).toBe(0.25);
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

  it("accepts a warning sourced from the system section", () => {
    const result = parseSupportBundleManifest(
      makeValidManifest({
        warnings: [
          {
            source: "system",
            code: "system_read_failed",
            count: 1,
            message: "the system report could not be assembled",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings?.[0]?.source).toBe("system");
    }
  });

  it("accepts a warning sourced from the config-posture section", () => {
    const result = parseSupportBundleManifest(
      makeValidManifest({
        warnings: [
          {
            source: "config-posture",
            code: "config_unreadable",
            count: 1,
            message: "the config could not be read for the posture digest",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings?.[0]?.source).toBe("config-posture");
    }
  });

  it("accepts warnings sourced from the explain, audit, and trace-export sections", () => {
    const result = parseSupportBundleManifest(
      makeValidManifest({
        warnings: [
          {
            source: "explain",
            code: "explain_assemble_failed",
            count: 1,
            message: "the incident report could not be assembled",
          },
          {
            source: "audit",
            code: "audit_store_unreadable",
            count: 1,
            message: "the audit store could not be opened",
          },
          {
            source: "trace-export",
            code: "trace_export_failed",
            count: 1,
            message: "the trace bundle could not be written",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings?.map((w) => w.source)).toEqual(["explain", "audit", "trace-export"]);
    }
  });

  it("rejects a warning carrying a source outside the closed set", () => {
    const result = parseSupportBundleManifest(
      makeValidManifest({
        warnings: [{ source: "telemetry", code: "x", count: 1, message: "m" }],
      }),
    );
    expect(result.ok).toBe(false);
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

/**
 * Build a well-formed config-posture digest, merging overrides last so a test
 * can inject an unknown key, a drifted schema version, or a malformed posture
 * finding over a valid baseline.
 */
function makeValidConfigPosture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sections: ["gateway", "channels"],
    configPosture: {
      detail: "1 config-posture signal(s) — flagged: gateway.tls (off)",
      count: 1,
      hint: "reconcile the flagged config knobs",
    },
    ...overrides,
  };
}

describe("parseConfigPosture", () => {
  it("returns ok for a well-formed config-posture digest with the data intact", () => {
    const result = parseConfigPosture(makeValidConfigPosture());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.sections).toContain("gateway");
      expect(result.value.configPosture?.count).toBe(1);
    }
  });

  it("returns ok when the posture finding is null because no signal fired", () => {
    const result = parseConfigPosture(makeValidConfigPosture({ configPosture: null }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.configPosture).toBeNull();
    }
  });

  it("rejects a config-posture digest carrying an unknown top-level key", () => {
    const result = parseConfigPosture(makeValidConfigPosture({ bogusKey: 1 }));
    expect(result.ok).toBe(false);
  });

  it("rejects a config-posture digest with a schemaVersion other than the literal one", () => {
    const result = parseConfigPosture(makeValidConfigPosture({ schemaVersion: 2 }));
    expect(result.ok).toBe(false);
  });

  it("rejects a posture finding carrying an unknown nested key", () => {
    const result = parseConfigPosture(
      makeValidConfigPosture({
        configPosture: { detail: "d", count: 1, hint: "h", bogusNested: true },
      }),
    );
    expect(result.ok).toBe(false);
  });
});

/**
 * Build a well-formed audit-summary digest, merging overrides last so a test
 * can inject an unknown key, a drifted schema version, or a malformed byKind
 * value over a valid baseline.
 */
function makeValidAuditSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    total: 3,
    byKind: { secret_access: 2, command_blocked: 1 },
    ...overrides,
  };
}

describe("parseAuditSummary", () => {
  it("returns ok for a well-formed audit summary with the counts intact", () => {
    const result = parseAuditSummary(makeValidAuditSummary());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.total).toBe(3);
      expect(result.value.byKind.secret_access).toBe(2);
      expect(result.value.capped).toBeUndefined();
    }
  });

  it("returns ok when the optional capped flag marks a ceiling-hit window read", () => {
    const result = parseAuditSummary(makeValidAuditSummary({ capped: true }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.capped).toBe(true);
    }
  });

  it("rejects an audit summary carrying an unknown top-level key", () => {
    const result = parseAuditSummary(makeValidAuditSummary({ bogusKey: 1 }));
    expect(result.ok).toBe(false);
  });

  it("rejects an audit summary with a schemaVersion other than the literal one", () => {
    const result = parseAuditSummary(makeValidAuditSummary({ schemaVersion: 2 }));
    expect(result.ok).toBe(false);
  });

  it("rejects a byKind entry whose value is not a number", () => {
    const result = parseAuditSummary(makeValidAuditSummary({ byKind: { secret_access: "two" } }));
    expect(result.ok).toBe(false);
  });
});
