// SPDX-License-Identifier: Apache-2.0
/**
 * Linux-gated filesystem-enforcement confirmation for the support-bundle writer.
 *
 * This file MUST compile on macOS (tsc passes) but the whole block SKIPS there:
 * the macOS umask makes real mode-bit assertions unreliable, so the 0o700 dir /
 * 0o600 file bits are verified only on Linux (the surface `pnpm validate:full`
 * exercises). The pure-logic behaviors — allowlist, redaction backstop,
 * partial-output, host-free dir name — are proven host-independently in
 * writer.test.ts.
 *
 * On Linux it asserts the real mode bits and that a symlinked support-bundles
 * slot is refused (`SymlinkParentRejected`) with the symlink target never
 * written into.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { safePath } from "@comis/core";
import { SymlinkParentRejected } from "@comis/observability";

import { writeSupportBundle } from "./writer.js";
import { type SupportTriage } from "./types.js";

const isLinux = process.platform === "linux";
const GENERATED_AT_MS = Date.UTC(2026, 6, 3, 12, 0, 0);

const tmpDirs: string[] = [];

function makeDataDir(): string {
  // Canonicalize the temp root so a symlinked ancestor (e.g. macOS /var →
  // /private/var) does not make a symlink INSIDE the data dir read as an
  // escape — the refusal under test must come from the dir primitive's lstat.
  const dir = mkdtempSync(safePath(realpathSync(tmpdir()), "comis-bundle-linux-"));
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
      // Best-effort teardown.
    }
  }
});

function makeTriage(): SupportTriage {
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
    maintainerNextSteps: ["comis system-health --since 24"],
    evidenceFiles: [{ path: "triage.json", description: "machine-readable verdict" }],
    privacy: {
      redaction: "platform-aware-v1",
      excludes: ["secrets", "raw-config-values"],
    },
  };
}

function makeInput(dataDir: string) {
  return {
    dataDir,
    generatedAtMs: GENERATED_AT_MS,
    triage: makeTriage(),
    issueSummaryMd: "# Comis support summary\n\n- ok\n",
    aiIssueDraftMd: "# Comis issue draft\n\n<REQUIRED: paste repro steps — do not invent>\n",
    doctorJson: {
      checksRun: 9,
      summary: { pass: 7, fail: 1, warn: 1, skip: 0, repairable: 1 },
      findings: [],
    } as unknown,
  };
}

describe.skipIf(!isLinux)("writeSupportBundle filesystem enforcement (Linux only)", () => {
  it("creates the bundle dir 0o700 and its files 0o600", () => {
    const result = writeSupportBundle(makeInput(makeDataDir()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(statSync(result.value.bundleDir).mode & 0o777).toBe(0o700);
    expect(statSync(safePath(result.value.bundleDir, "triage.json")).mode & 0o777).toBe(0o600);
    expect(statSync(safePath(result.value.bundleDir, "doctor.json")).mode & 0o777).toBe(0o600);
    expect(statSync(safePath(result.value.bundleDir, "issue-summary.md")).mode & 0o777).toBe(0o600);
    expect(statSync(safePath(result.value.bundleDir, "ai-issue-draft.md")).mode & 0o777).toBe(0o600);
    expect(statSync(safePath(result.value.bundleDir, "manifest.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked support-bundles dir and never writes into its target", () => {
    const dataDir = makeDataDir();
    // The target lives INSIDE the data dir so safePath resolves it without a
    // traversal throw — the refusal then comes from the dir primitive's lstat.
    const target = safePath(dataDir, "real-target");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, safePath(dataDir, "support-bundles"));

    const result = writeSupportBundle(makeInput(dataDir));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bundle-dir-create-failed");
    expect(result.error.reason).toBe(new SymlinkParentRejected(target).code);
    // The symlink target was never followed / written into.
    expect(readdirSync(target)).toHaveLength(0);
  });
});
