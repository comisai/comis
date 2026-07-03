// SPDX-License-Identifier: Apache-2.0
/**
 * Reducer goldens for the support-bundle triage engine.
 *
 * The signal-spelling goldens are backed by REAL doctor-check runs against
 * seeded temp directories (never the real data dir) so a regression that keys
 * the reducer on the wrong finding field — the check id instead of the short
 * `category` — is caught: such a bug yields an empty signal set, and these
 * pins fail. The summary/precedence/determinism goldens use hand-built
 * `DoctorResult`s to exercise the reducer's aggregation and ordering.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FleetHealthReport } from "@comis/core";
import { runDoctorChecks } from "../doctor/check-runner.js";
import { configHealthCheck } from "../doctor/checks/config-health.js";
import { daemonHealthCheck } from "../doctor/checks/daemon-health.js";
import { gatewayHealthCheck } from "../doctor/checks/gateway-health.js";
import { resolveDoctorConfig } from "../doctor/config-resolve.js";
import type { DoctorFinding, DoctorResult } from "../doctor/types.js";
import {
  buildDoctorSummary,
  buildSupportTriage,
  deriveDoctorSignals,
  deriveFleetSignals,
  fleetHasEvidence,
} from "./triage.js";
import type { HostSnapshot } from "./types.js";
import { parseSupportTriage } from "./types.js";

// Injected secret-lookup seams keep the real resolver hermetic from the
// machine's env / ~/.comis/.env / encrypted store while still running the
// genuine config-resolution + check logic against a temp file.
const HERMETIC = { getEnv: () => undefined, getStoreSecret: () => undefined };

const createdDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "comis-triage-"));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Aggregate a hand-built finding list the way the real check runner does. */
function makeDoctorResult(findings: DoctorFinding[]): DoctorResult {
  return {
    findings,
    checksRun: findings.length,
    passCount: findings.filter((f) => f.status === "pass").length,
    failCount: findings.filter((f) => f.status === "fail").length,
    warnCount: findings.filter((f) => f.status === "warn").length,
    skipCount: findings.filter((f) => f.status === "skip").length,
    repairableCount: findings.filter((f) => f.repairable).length,
  };
}

/** Terse finding builder — the caller supplies only the load-bearing fields. */
function finding(
  over: Pick<DoctorFinding, "category" | "check" | "status"> & Partial<DoctorFinding>,
): DoctorFinding {
  return { message: "", repairable: false, ...over };
}

/**
 * Minimal valid FleetHealthReport fixture — an empty, coverage-empty window.
 * Overrides shallow-merge the base, so a test replaces only the sub-object it
 * exercises (e.g. `findings`, `sessions`, `coverage`).
 */
function makeFleet(over: Partial<FleetHealthReport> = {}): FleetHealthReport {
  return {
    schemaVersion: 1,
    windowHours: 24,
    sessions: { total: 0, degraded: 0, degradedRate: 0 },
    topErrorKinds: [],
    degradedByCause: {},
    breakerTripTotal: 0,
    toolStats: {},
    cost: { costUsd: 0, totalTokens: 0 },
    activity: {
      activeAgents: [],
      activeChannels: [],
      exitReasons: {},
      turnTotal: 0,
      tokenTotal: 0,
    },
    findings: [],
    likelyRootCause: null,
    suggestedNextSteps: [],
    truncations: [],
    coverage: {
      sessionSummary: { found: false, rows: 0 },
      sessionIndex: { daysRead: 0, daysMissing: 0 },
      billing: { present: false },
    },
    ...over,
  };
}

describe("deriveDoctorSignals", () => {
  it("emits config_missing from a real check against a data dir with no config", async () => {
    const dir = makeTempDir();
    const configPath = join(dir, "config.yaml"); // never created
    const resolution = resolveDoctorConfig([configPath], HERMETIC);
    const doctor = await runDoctorChecks([configHealthCheck], {
      configPaths: [configPath],
      configResolution: resolution,
      dataDir: dir,
      daemonPidFile: join(dir, "daemon.pid"),
    });

    expect(deriveDoctorSignals(doctor)).toContain("config_missing");
  });

  it("emits config_corrupt (not config_missing) from a real check on an unreadable config", async () => {
    const dir = makeTempDir();
    const configPath = join(dir, "config.yaml");
    // A top-level scalar is not a valid config object -> resolution rejects it
    // as a parse/shape failure (the "Config file parseable" check), distinct
    // from an absent file.
    writeFileSync(configPath, "not-a-valid-config-object");
    const resolution = resolveDoctorConfig([configPath], HERMETIC);
    const doctor = await runDoctorChecks([configHealthCheck], {
      configPaths: [configPath],
      configResolution: resolution,
      dataDir: dir,
      daemonPidFile: join(dir, "daemon.pid"),
    });

    const signals = deriveDoctorSignals(doctor);
    expect(signals).toContain("config_corrupt");
    expect(signals).not.toContain("config_missing");
  });

  it("emits daemon_down from a real check when no pid file or lock is present", async () => {
    const dir = makeTempDir();
    const doctor = await runDoctorChecks([daemonHealthCheck], {
      configPaths: [],
      dataDir: dir,
      daemonPidFile: join(dir, "daemon.pid"),
    });

    expect(deriveDoctorSignals(doctor)).toContain("daemon_down");
  });

  it("emits no gateway signal from a real check that skips for a missing url", async () => {
    const dir = makeTempDir();
    const doctor = await runDoctorChecks([gatewayHealthCheck], {
      configPaths: [],
      dataDir: dir,
      daemonPidFile: join(dir, "daemon.pid"),
    });

    expect(deriveDoctorSignals(doctor)).not.toContain("gateway_unreachable");
    expect(deriveDoctorSignals(doctor)).toHaveLength(0);
  });

  it("splits a config schema-validation warning into config_schema_invalid", () => {
    const doctor = makeDoctorResult([
      finding({ category: "config", check: "Config schema validation", status: "warn" }),
    ]);

    expect(deriveDoctorSignals(doctor)).toEqual(["config_schema_invalid"]);
  });

  it("keeps an unresolved-secret-reference warning out of the signal set", () => {
    const doctor = makeDoctorResult([
      finding({ category: "config", check: "Secret references", status: "warn" }),
    ]);

    expect(deriveDoctorSignals(doctor)).toHaveLength(0);
  });

  it("surfaces an uncovered fail category verbatim as its own signal", () => {
    const doctor = makeDoctorResult([
      finding({ category: "oauth", check: "Profile expiry", status: "fail" }),
      finding({ category: "version", check: "Version skew", status: "fail" }),
    ]);

    expect(deriveDoctorSignals(doctor)).toEqual(["oauth", "version"]);
  });

  it("dedupes repeated signals and preserves first-seen order", () => {
    const doctor = makeDoctorResult([
      finding({ category: "daemon", check: "PID file", status: "warn" }),
      finding({ category: "config", check: "Config file exists", status: "fail", repairable: true }),
      finding({ category: "daemon", check: "PID file", status: "warn" }),
    ]);

    expect(deriveDoctorSignals(doctor)).toEqual(["daemon_down", "config_missing"]);
  });
});

describe("buildDoctorSummary", () => {
  it("copies the aggregate counts verbatim with distinct failing categories", () => {
    const doctor = makeDoctorResult([
      finding({ category: "config", check: "Config file parseable", status: "fail", repairable: true }),
      finding({ category: "daemon", check: "Process alive", status: "fail", repairable: true }),
      finding({ category: "config", check: "Config schema validation", status: "warn" }),
      finding({ category: "gateway", check: "Gateway reachable", status: "pass" }),
    ]);

    expect(buildDoctorSummary(doctor)).toEqual({
      checksRun: 4,
      pass: 1,
      warn: 1,
      fail: 2,
      skip: 0,
      repairable: 2,
      failing: ["config", "daemon"],
    });
  });

  it("reports an empty failing list when nothing failed", () => {
    const doctor = makeDoctorResult([
      finding({ category: "config", check: "Config files", status: "pass" }),
    ]);

    expect(buildDoctorSummary(doctor).failing).toEqual([]);
  });
});

const HOST: HostSnapshot = { nodeVersion: "v22.3.0", platform: "linux", arch: "x64" };

describe("buildSupportTriage status precedence", () => {
  it("ranks a config-health failure as misconfigured over other failures", () => {
    const doctor = makeDoctorResult([
      finding({
        category: "config",
        check: "Config file exists",
        status: "fail",
        repairable: true,
        suggestion: "Run comis init to create config",
      }),
      finding({ category: "gateway", check: "Gateway reachable", status: "fail" }),
      finding({ category: "daemon", check: "PID file", status: "warn" }),
    ]);

    expect(buildSupportTriage({ host: HOST, doctor }).status).toBe("misconfigured");
  });

  it("reports degraded when the daemon is down without a config failure", () => {
    const doctor = makeDoctorResult([
      finding({ category: "daemon", check: "PID file", status: "warn" }),
      finding({ category: "config", check: "Config files", status: "pass" }),
    ]);

    expect(buildSupportTriage({ host: HOST, doctor }).status).toBe("degraded");
  });

  it("reports degraded on a non-config failure such as an unreachable gateway", () => {
    const doctor = makeDoctorResult([
      finding({ category: "gateway", check: "Gateway reachable", status: "fail" }),
      finding({ category: "config", check: "Config files", status: "pass" }),
    ]);

    expect(buildSupportTriage({ host: HOST, doctor }).status).toBe("degraded");
  });

  it("returns insufficient_evidence for an empty read rather than healthy", () => {
    const doctor = makeDoctorResult([]);

    expect(buildSupportTriage({ host: HOST, doctor }).status).toBe("insufficient_evidence");
  });

  it("reports healthy only when checks pass with no failure or daemon-down", () => {
    const doctor = makeDoctorResult([
      finding({ category: "config", check: "Config files", status: "pass" }),
      finding({ category: "daemon", check: "Process alive", status: "pass" }),
    ]);

    expect(buildSupportTriage({ host: HOST, doctor }).status).toBe("healthy");
  });
});

describe("buildSupportTriage assembly", () => {
  it("produces a deeply identical verdict for the same input", () => {
    const doctor = makeDoctorResult([
      finding({ category: "gateway", check: "Gateway reachable", status: "fail" }),
      finding({ category: "config", check: "Config files", status: "pass" }),
    ]);

    const first = buildSupportTriage({ host: HOST, doctor });
    const second = buildSupportTriage({ host: HOST, doctor });

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("reuses finding suggestions and known commands for reporter next steps", () => {
    const doctor = makeDoctorResult([
      finding({
        category: "config",
        check: "Config file exists",
        status: "fail",
        repairable: true,
        suggestion: "Run comis init to create config",
      }),
      finding({
        category: "daemon",
        check: "PID file",
        status: "warn",
        suggestion: "Start the daemon: comis daemon start",
      }),
    ]);

    const steps = buildSupportTriage({ host: HOST, doctor }).reporterNextSteps;

    expect(steps).toContain("Run comis init to create config");
    expect(steps).toContain("Start the daemon: comis daemon start");
    expect(steps).toContain("comis doctor --repair");
    expect(steps).toContain("comis init");
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps.length).toBeLessThanOrEqual(8);
  });

  it("dedupes and caps reporter next steps at the ceiling", () => {
    const findings: DoctorFinding[] = [];
    for (let i = 0; i < 12; i += 1) {
      findings.push(
        finding({
          category: "channels",
          check: `channel ${i}`,
          status: "fail",
          suggestion: `reconnect channel ${i}`,
        }),
      );
    }
    findings.push(
      finding({
        category: "channels",
        check: "duplicate",
        status: "fail",
        suggestion: "reconnect channel 0",
      }),
    );

    const steps = buildSupportTriage({ host: HOST, doctor: makeDoctorResult(findings) }).reporterNextSteps;

    expect(steps.length).toBeLessThanOrEqual(8);
    expect(new Set(steps).size).toBe(steps.length);
  });

  it("offers content-free maintainer commands that name no host detail", () => {
    const triage = buildSupportTriage({ host: HOST, doctor: makeDoctorResult([]) });

    expect(triage.maintainerNextSteps.length).toBeGreaterThan(0);
    for (const step of triage.maintainerNextSteps) {
      expect(step.startsWith("comis ")).toBe(true);
    }
  });

  it("declares the privacy exclusion set the writer must honor", () => {
    const triage = buildSupportTriage({ host: HOST, doctor: makeDoctorResult([]) });

    expect(triage.privacy.redaction).toBe("platform-aware-v1");
    for (const excluded of ["secrets", "raw-config-values", "message-bodies", "file-contents", ".env"]) {
      expect(triage.privacy.excludes).toContain(excluded);
    }
  });

  it("lists every written bundle file as evidence, in writer order, with descriptions", () => {
    const triage = buildSupportTriage({ host: HOST, doctor: makeDoctorResult([]) });

    const paths = triage.evidenceFiles.map((file) => file.path);
    // The evidence manifest must equal the exact set the writer emits (its
    // FILE_PLAN order), so a file the bundle writes cannot silently drop out of
    // the index — ai-issue-draft.md is written on every run.
    expect(paths).toEqual([
      "issue-summary.md",
      "ai-issue-draft.md",
      "triage.json",
      "doctor.json",
      "fleet.json",
      "config-posture.json",
      "manifest.json",
    ]);
    for (const entry of triage.evidenceFiles) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("round-trips the built verdict through the strict schema parser", () => {
    const doctor = makeDoctorResult([
      finding({
        category: "config",
        check: "Config file exists",
        status: "fail",
        repairable: true,
        suggestion: "Run comis init to create config",
      }),
    ]);

    const triage = buildSupportTriage({ host: HOST, doctor });

    expect(triage.schemaVersion).toBe(1);
    const parsed = parseSupportTriage(triage);
    expect(parsed.ok).toBe(true);
  });
});

describe("deriveFleetSignals", () => {
  it("surfaces every fleet finding code plus the likely-root-cause code verbatim", () => {
    const fleet = makeFleet({
      findings: [
        { code: "config_posture", detail: "", count: 1, hint: "" },
        { code: "model_health:embedder_not_multilingual", detail: "", count: 1, hint: "" },
        { code: "health_signal:mcp_churn", detail: "", count: 1, hint: "" },
      ],
      likelyRootCause: { code: "fleet_high_degraded_rate", detail: "", suggestedNextSteps: [] },
    });

    expect(deriveFleetSignals(fleet)).toEqual([
      "config_posture",
      "model_health:embedder_not_multilingual",
      "health_signal:mcp_churn",
      "fleet_high_degraded_rate",
    ]);
  });

  it("omits the likely-root-cause code when the fleet root cause is null", () => {
    const fleet = makeFleet({
      findings: [{ code: "config_posture", detail: "", count: 1, hint: "" }],
      likelyRootCause: null,
    });

    const signals = deriveFleetSignals(fleet);
    expect(signals).toEqual(["config_posture"]);
    expect(signals).not.toContain("fleet_high_degraded_rate");
  });

  it("surfaces an unnamed finding code proving no curated allow-list filters it out", () => {
    const fleet = makeFleet({
      findings: [{ code: "voice_health", detail: "", count: 1, hint: "" }],
    });

    expect(deriveFleetSignals(fleet)).toContain("voice_health");
  });
});

describe("fleetHasEvidence", () => {
  it("treats an absent fleet report as carrying no evidence", () => {
    expect(fleetHasEvidence(undefined)).toBe(false);
  });

  it("treats a zero-session empty-coverage fleet as carrying no evidence", () => {
    expect(fleetHasEvidence(makeFleet())).toBe(false);
  });

  it("counts a fleet with at least one session as carrying evidence", () => {
    const fleet = makeFleet({ sessions: { total: 1, degraded: 0, degradedRate: 0 } });
    expect(fleetHasEvidence(fleet)).toBe(true);
  });

  it("counts a fleet with at least one finding as carrying evidence", () => {
    const fleet = makeFleet({ findings: [{ code: "voice_health", detail: "", count: 1, hint: "" }] });
    expect(fleetHasEvidence(fleet)).toBe(true);
  });

  it("does not treat a coverage-found flag as evidence when no real session or finding is present", () => {
    // coverage.sessionSummary.found is synthetic-INCLUSIVE (it mirrors rows > 0
    // over the pre-exclusion row set), whereas sessions.total is
    // synthetic-EXCLUDED. A window holding only synthetic/test rows sets found
    // true yet carries zero operator evidence, so it must not be admitted —
    // otherwise a thrown doctor run falls through to a false healthy.
    const fleet = makeFleet({
      coverage: {
        sessionSummary: { found: true, rows: 2 },
        sessionIndex: { daysRead: 1, daysMissing: 0 },
        billing: { present: false },
      },
    });
    expect(fleetHasEvidence(fleet)).toBe(false);
  });
});

describe("buildSupportTriage fleet enrichment", () => {
  it("dedupes a fleet code that repeats a doctor signal, keeping the doctor entry first", () => {
    const doctor = makeDoctorResult([
      finding({ category: "channels", check: "Channel reachable", status: "fail" }),
      finding({ category: "config", check: "Config files", status: "pass" }),
    ]);
    const fleet = makeFleet({
      findings: [
        { code: "channels", detail: "", count: 1, hint: "" },
        { code: "config_posture", detail: "", count: 1, hint: "" },
      ],
    });

    expect(buildSupportTriage({ host: HOST, doctor, fleet }).activeSignals).toEqual([
      "channels",
      "config_posture",
    ]);
  });

  it("maps the fleet summary field-for-field from the fleet report", () => {
    const fleet = makeFleet({
      sessions: { total: 10, degraded: 4, degradedRate: 0.4 },
      topErrorKinds: [{ kind: "context_exhausted", count: 3 }],
      breakerTripTotal: 2,
      findings: [
        { code: "config_posture", detail: "", count: 1, hint: "" },
        { code: "model_health", detail: "", count: 1, hint: "" },
      ],
      likelyRootCause: { code: "fleet_high_degraded_rate", detail: "", suggestedNextSteps: [] },
    });

    const summary = buildSupportTriage({ host: HOST, doctor: makeDoctorResult([]), fleet }).fleetSummary;

    expect(summary).toEqual({
      degradedRate: 0.4,
      topErrorKinds: [{ kind: "context_exhausted", count: 3 }],
      breakerTripTotal: 2,
      findingCodes: ["config_posture", "model_health"],
      likelyRootCause: "fleet_high_degraded_rate",
    });
  });

  it("maps a null fleet root cause to a null summary likely-root-cause", () => {
    const fleet = makeFleet({ findings: [], likelyRootCause: null });

    const summary = buildSupportTriage({ host: HOST, doctor: makeDoctorResult([]), fleet }).fleetSummary;

    expect(summary?.likelyRootCause).toBeNull();
    expect(summary?.findingCodes).toEqual([]);
  });

  it("omits the fleet summary entirely when no fleet report is provided", () => {
    const triage = buildSupportTriage({ host: HOST, doctor: makeDoctorResult([]) });

    expect(triage.fleetSummary).toBeUndefined();
  });

  it("reports degraded when the fleet supplies a non-null likely root cause", () => {
    const doctor = makeDoctorResult([
      finding({ category: "config", check: "Config files", status: "pass" }),
      finding({ category: "daemon", check: "Process alive", status: "pass" }),
    ]);
    const fleet = makeFleet({
      sessions: { total: 5, degraded: 3, degradedRate: 0.6 },
      coverage: {
        sessionSummary: { found: true, rows: 5 },
        sessionIndex: { daysRead: 1, daysMissing: 0 },
        billing: { present: true },
      },
      likelyRootCause: { code: "fleet_high_degraded_rate", detail: "", suggestedNextSteps: [] },
    });

    expect(buildSupportTriage({ host: HOST, doctor, fleet }).status).toBe("degraded");
  });

  it("ranks a coverage-empty fleet as insufficient_evidence rather than healthy", () => {
    const doctor = makeDoctorResult([]);
    const fleet = makeFleet({
      sessions: { total: 0, degraded: 0, degradedRate: 0 },
      findings: [],
      likelyRootCause: null,
      coverage: {
        sessionSummary: { found: false, rows: 0 },
        sessionIndex: { daysRead: 0, daysMissing: 0 },
        billing: { present: false },
      },
    });

    expect(buildSupportTriage({ host: HOST, doctor, fleet }).status).toBe("insufficient_evidence");
  });

  it("ranks a synthetic-only fleet window with a thrown doctor as insufficient_evidence, not healthy", () => {
    // A window whose only rows are synthetic sets coverage.sessionSummary.found
    // true (found is synthetic-INCLUSIVE) while sessions.total stays 0
    // (synthetic-EXCLUDED) and no findings fire. Paired with a doctor run that
    // itself produced zero passes, there is no operator evidence anywhere, so
    // the verdict must be insufficient_evidence — an empty read is never
    // healthy.
    const doctor = makeDoctorResult([]);
    const fleet = makeFleet({
      sessions: { total: 0, degraded: 0, degradedRate: 0 },
      findings: [],
      likelyRootCause: null,
      coverage: {
        sessionSummary: { found: true, rows: 3 },
        sessionIndex: { daysRead: 1, daysMissing: 0 },
        billing: { present: false },
      },
    });

    expect(buildSupportTriage({ host: HOST, doctor, fleet }).status).toBe("insufficient_evidence");
  });

  it("reports healthy when a passing doctor pairs with a fleet that has evidence and no root cause", () => {
    const doctor = makeDoctorResult([
      finding({ category: "config", check: "Config files", status: "pass" }),
    ]);
    const fleet = makeFleet({
      sessions: { total: 3, degraded: 0, degradedRate: 0 },
      coverage: {
        sessionSummary: { found: true, rows: 3 },
        sessionIndex: { daysRead: 1, daysMissing: 0 },
        billing: { present: true },
      },
      likelyRootCause: null,
    });

    expect(buildSupportTriage({ host: HOST, doctor, fleet }).status).toBe("healthy");
  });

  it("produces a deeply identical verdict for the same fleet-enriched input", () => {
    const doctor = makeDoctorResult([
      finding({ category: "config", check: "Config files", status: "pass" }),
    ]);
    const fleet = makeFleet({
      findings: [{ code: "config_posture", detail: "", count: 1, hint: "" }],
      likelyRootCause: { code: "fleet_config_posture", detail: "", suggestedNextSteps: [] },
    });

    const first = buildSupportTriage({ host: HOST, doctor, fleet });
    const second = buildSupportTriage({ host: HOST, doctor, fleet });

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("round-trips a fleet-enriched verdict through the strict schema parser", () => {
    const fleet = makeFleet({
      sessions: { total: 4, degraded: 1, degradedRate: 0.25 },
      topErrorKinds: [{ kind: "context_exhausted", count: 2 }],
      breakerTripTotal: 1,
      findings: [{ code: "config_posture", detail: "", count: 1, hint: "" }],
      likelyRootCause: { code: "fleet_config_posture", detail: "", suggestedNextSteps: [] },
    });

    const triage = buildSupportTriage({ host: HOST, doctor: makeDoctorResult([]), fleet });

    expect(parseSupportTriage(triage).ok).toBe(true);
  });

  it("lists the fleet and config-posture outputs among the evidence files", () => {
    const triage = buildSupportTriage({ host: HOST, doctor: makeDoctorResult([]) });

    const paths = triage.evidenceFiles.map((file) => file.path);
    expect(paths).toContain("fleet.json");
    expect(paths).toContain("config-posture.json");
    for (const entry of triage.evidenceFiles) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
