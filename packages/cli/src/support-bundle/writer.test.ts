// SPDX-License-Identifier: Apache-2.0
/**
 * Writer tests for the support bundle — the security backbone.
 *
 * These pin the write boundary where a leak or a symlink-escape would occur:
 * exactly the four allowlisted files are written; a seeded secret inside the
 * triage or doctor objects is masked by the redaction backstop before it
 * reaches disk; the manifest round-trips through its parser with the redaction
 * fingerprint, the caller's generatedAt, the privacy declaration, and the
 * warnings; a section that cannot be produced folds into a warning and the
 * other files are still written (partial output, never a crash); and the
 * bundle dir name carries a timestamp only — never a host component.
 *
 * Temp dirs ONLY — never the real ~/.comis. The 0o700/0o600 mode bits and the
 * symlink refusal are asserted in writer.linux.test.ts (Pitfall: macOS umask
 * makes cross-platform perms asserts unreliable — gate those on Linux).
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { safePath } from "@comis/core";

import { writeSupportBundle } from "./writer.js";
import {
  parseSupportBundleManifest,
  type SupportTriage,
  type SupportBundleWarning,
} from "./types.js";

/** A well-known AWS example key — a shape the value-shape backstop redacts. */
const SEEDED_SECRET = "AKIAIOSFODNN7EXAMPLE";

/** Fixed generation instant so the bundle dir name is deterministic. */
const GENERATED_AT_MS = Date.UTC(2026, 6, 3, 12, 0, 0);

const tmpDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(safePath(tmpdir(), "comis-bundle-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort teardown; a leaked temp dir must never fail the suite.
    }
  }
});

function makeTriage(overrides: Partial<SupportTriage> = {}): SupportTriage {
  return {
    schemaVersion: 1,
    status: "degraded",
    activeSignals: ["daemon_down"],
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
      failing: ["config"],
    },
    reporterNextSteps: ["Run `comis doctor --repair`."],
    maintainerNextSteps: ["comis fleet --since 24"],
    evidenceFiles: [{ path: "triage.json", description: "machine-readable verdict" }],
    privacy: {
      redaction: "platform-aware-v1",
      excludes: ["secrets", "raw-config-values"],
    },
    ...overrides,
  };
}

function makeInput(
  overrides: {
    dataDir?: string;
    triage?: SupportTriage;
    issueSummaryMd?: string;
    doctorJson?: unknown;
    warnings?: SupportBundleWarning[];
  } = {},
) {
  return {
    dataDir: overrides.dataDir ?? makeDataDir(),
    generatedAtMs: GENERATED_AT_MS,
    triage: overrides.triage ?? makeTriage(),
    issueSummaryMd: overrides.issueSummaryMd ?? "# Comis support summary\n\n- ok\n",
    doctorJson:
      overrides.doctorJson ??
      ({
        checksRun: 9,
        summary: { pass: 7, fail: 1, warn: 1, skip: 0, repairable: 1 },
        findings: [],
      } as unknown),
    ...(overrides.warnings !== undefined ? { warnings: overrides.warnings } : {}),
  };
}

/** Recompute the expected bundle dir the way the writer names it. */
function expectedBundleDir(dataDir: string): string {
  const tsIso = new Date(GENERATED_AT_MS).toISOString().replace(/[:.]/g, "-");
  return safePath(safePath(dataDir, "support-bundles"), `comis-support-${tsIso}`);
}

describe("writeSupportBundle", () => {
  it("writes exactly the four allowlisted files into the bundle dir", () => {
    const result = writeSupportBundle(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const files = readdirSync(result.value.bundleDir).sort();
    expect(files).toEqual([
      "doctor.json",
      "issue-summary.md",
      "manifest.json",
      "triage.json",
    ]);
  });

  it("names the bundle dir with a timestamp only, no host component", () => {
    const result = writeSupportBundle(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base = result.value.bundleDir.split("/").pop() ?? "";
    expect(base).toMatch(/^comis-support-[\dTZ.-]+$/);
  });

  it("redacts a seeded secret from the written triage.json and doctor.json", () => {
    const input = makeInput({
      triage: makeTriage({ activeSignals: [`leak ${SEEDED_SECRET}`] }),
      doctorJson: { checksRun: 1, findings: [{ note: `credential ${SEEDED_SECRET}` }] },
    });
    const result = writeSupportBundle(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const triageJson = readFileSync(safePath(result.value.bundleDir, "triage.json"), "utf8");
    const doctorJson = readFileSync(safePath(result.value.bundleDir, "doctor.json"), "utf8");
    expect(triageJson).not.toContain(SEEDED_SECRET);
    expect(doctorJson).not.toContain(SEEDED_SECRET);
    // The sentinel proves the backstop ran (not that the field silently vanished).
    expect(triageJson).toContain("<REDACTED:aws-access-key-id>");
  });

  it("writes a manifest that parses with the fingerprint, generatedAt, privacy, and warnings", () => {
    const incoming: SupportBundleWarning[] = [
      { source: "doctor", code: "doctor_run_failed", count: 1, message: "doctor could not run" },
    ];
    const input = makeInput({ warnings: incoming });
    const result = writeSupportBundle(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "manifest.json"), "utf8"),
    ) as unknown;
    const parsed = parseSupportBundleManifest(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.redaction.policy).toBe("platform-aware-v1");
    expect(parsed.value.generatedAt).toBe(new Date(GENERATED_AT_MS).toISOString());
    expect(parsed.value.privacy.redaction).toBe("platform-aware-v1");
    expect(parsed.value.warnings?.some((w) => w.code === "doctor_run_failed")).toBe(true);

    // Incoming warnings are also surfaced on the returned result.
    expect(result.value.warnings.some((w) => w.code === "doctor_run_failed")).toBe(true);
  });

  it("records a warning and still writes the other files when a section body fails", () => {
    // A BigInt is not JSON-serializable → the doctor.json body throws; the
    // writer folds it into a warning and still writes the other three files.
    const result = writeSupportBundle(makeInput({ doctorJson: { bad: 10n } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bundleDir, warnings } = result.value;
    expect(warnings.some((w) => w.source === "writer")).toBe(true);
    expect(existsSync(safePath(bundleDir, "issue-summary.md"))).toBe(true);
    expect(existsSync(safePath(bundleDir, "triage.json"))).toBe(true);
    expect(existsSync(safePath(bundleDir, "manifest.json"))).toBe(true);
    expect(existsSync(safePath(bundleDir, "doctor.json"))).toBe(false);
  });

  it("records a warning and continues when a target file path is unwritable", () => {
    const dataDir = makeDataDir();
    const bundleDir = expectedBundleDir(dataDir);
    // Plant a directory where triage.json must go → its file write fails while
    // the other sections still succeed (partial output, no crash).
    mkdirSync(safePath(bundleDir, "triage.json"), { recursive: true });

    const result = writeSupportBundle(makeInput({ dataDir }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.some((w) => w.source === "writer")).toBe(true);
    expect(existsSync(safePath(bundleDir, "issue-summary.md"))).toBe(true);
    expect(existsSync(safePath(bundleDir, "doctor.json"))).toBe(true);
    expect(existsSync(safePath(bundleDir, "manifest.json"))).toBe(true);
  });

  it("refuses a symlinked support-bundles dir and returns a hard error", () => {
    const dataDir = makeDataDir();
    const target = makeDataDir();
    // A symlink at the support-bundles slot could redirect writes outside the
    // data dir → ensureContainedDir refuses it; the bundle is unproducible.
    symlinkSync(target, safePath(dataDir, "support-bundles"));
    const result = writeSupportBundle(makeInput({ dataDir }));
    expect(result.ok).toBe(false);
    // The symlink target was never written into.
    expect(readdirSync(target)).toHaveLength(0);
  });
});
