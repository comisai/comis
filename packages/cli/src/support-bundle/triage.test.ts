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
import { runDoctorChecks } from "../doctor/check-runner.js";
import { configHealthCheck } from "../doctor/checks/config-health.js";
import { daemonHealthCheck } from "../doctor/checks/daemon-health.js";
import { gatewayHealthCheck } from "../doctor/checks/gateway-health.js";
import { resolveDoctorConfig } from "../doctor/config-resolve.js";
import type { DoctorFinding, DoctorResult } from "../doctor/types.js";
import { buildDoctorSummary, deriveDoctorSignals } from "./triage.js";

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
