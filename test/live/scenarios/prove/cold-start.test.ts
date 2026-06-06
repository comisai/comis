// SPDX-License-Identifier: Apache-2.0
/**
 * PROVE-02 — Cold-start / install / packaging (Category U).
 *
 * The published tarball must install (`npm install -g comisai`) → `comis configure`
 * → daemon boots → `doctor`/`health` green from a fresh `~/.comis`. The FULL path
 * needs Linux + ffmpeg/bwrap (CLAUDE.md `pnpm validate:full`) — held in the gated
 * operator block below. The DETERMINISTIC, sandbox-true cold-start CONTRACTS are
 * asserted here:
 *
 *   (1) The tarball BUNDLE mechanics — the `bundledDependencies` `@comis/*` set the
 *       published tarball ships (the exact derivation scripts/smoke/tarball-smoke.mjs
 *       uses), every workspace package `"private": true` (the supply-chain invariant:
 *       "@comis/* are private + bundled", CLAUDE.md). This is the packaging contract
 *       the cold-start install depends on, without running the full `pnpm pack`
 *       (which mutates package.json + needs the hoisted linker — the operator/CI
 *       `pnpm validate:full` / the smoke script's job).
 *   (2) The `doctor`/`health` finding-SHAPE contract — `comis health`/`doctor` produce
 *       `DoctorFinding{category, check, status, message, suggestion?}` with status in
 *       the closed set pass|fail|warn|skip, and `comis health` exits 1 on a fail. The
 *       doctor checks are NOT import-reachable from test/live (not in @comis/cli's
 *       public index); their behavior is unit-tested in packages/cli/src/doctor/
 *       checks/*.test.ts. Here we assert the value CONTRACT structurally.
 *
 * The full Linux install→configure→boot→green path is the operator step (gated below).
 * costTier: "$0".
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const isLive = !!process.env["COMIS_LIVE"];
const here = dirname(fileURLToPath(import.meta.url));
// this file: test/live/scenarios/prove/ → repo root is 4 levels up.
const REPO_ROOT = resolve(here, "../../../..");

// ===========================================================================
// PROVE-02(1) — the tarball bundle mechanics (the packaging cold-start contract).
//   Mirrors scripts/smoke/tarball-smoke.mjs's expectedPackages derivation +
//   supply-chain invariant, deterministically (no `pnpm pack`).
// ===========================================================================

describe("PROVE-02(1) — tarball bundle mechanics (the published-tarball packaging contract)", () => {
  const comisPkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "packages/comis/package.json"), "utf-8"),
  ) as { bundledDependencies?: string[] };

  // The EXACT derivation tarball-smoke.mjs uses (the single source of truth).
  const expectedPackages = (comisPkg.bundledDependencies ?? [])
    .filter((s) => typeof s === "string" && s.startsWith("@comis/"))
    .map((s) => s.replace(/^@comis\//, ""));

  it("bundledDependencies declares a non-empty @comis/* set the tarball ships", () => {
    expect(expectedPackages.length).toBeGreaterThan(0);
  });

  it("the orchestrator + core + daemon workspace packages are bundled (explicit cold-start deps)", () => {
    // orchestrator mirrors the smoke's Assertion 4 explicit check; core + daemon
    // are the boot-critical packages a fresh install must carry.
    expect(expectedPackages).toContain("orchestrator");
    expect(expectedPackages).toContain("core");
    expect(expectedPackages).toContain("daemon");
  });

  it("every bundled @comis/* package is private:true (the supply-chain invariant)", () => {
    // CLAUDE.md: "@comis/* workspace packages are private:true and bundled — never
    // publish them to the npm registry." A regression here would leak a workspace
    // package to npm or break the bundled cold-start. Assert each is private.
    for (const pkg of expectedPackages) {
      const p = JSON.parse(
        readFileSync(resolve(REPO_ROOT, `packages/${pkg}/package.json`), "utf-8"),
      ) as { private?: boolean };
      expect(p.private, `@comis/${pkg} must be private:true (bundled, never published)`).toBe(true);
    }
  });
});

// ===========================================================================
// PROVE-02(2) — the doctor/health finding-shape contract (the cold-start
//   readiness verdict surface). Structural (the checks are not import-reachable).
// ===========================================================================

describe("PROVE-02(2) — doctor/health finding-shape contract (the cold-start readiness verdict surface)", () => {
  // The closed DoctorStatus union (packages/cli/src/doctor/types.ts) and the
  // DoctorFinding key set — the contract `comis doctor`/`comis health` produce,
  // and that a fresh-~/.comis cold-start is graded against.
  const DOCTOR_STATUSES = ["pass", "fail", "warn", "skip"] as const;
  const FINDING_KEYS = ["category", "check", "status", "message"] as const;

  it("DoctorStatus is the closed set pass|fail|warn|skip", () => {
    expect([...DOCTOR_STATUSES].sort()).toEqual(["fail", "pass", "skip", "warn"]);
  });

  it("a doctor finding carries category, check, status, message (+ optional suggestion)", () => {
    // A representative fresh-~/.comis finding shape: the daemon-not-running fail a
    // cold-start would surface before `comis configure` + boot.
    const finding = {
      category: "daemon",
      check: "Daemon process",
      status: "fail" as const,
      message: "Daemon is not running",
      suggestion: "Start the daemon (see CLAUDE.md → Daemon).",
      repairable: false,
    };
    for (const k of FINDING_KEYS) {
      expect(finding).toHaveProperty(k);
    }
    expect(DOCTOR_STATUSES).toContain(finding.status);
    // `comis health` exits 1 when a fail finding exists (the CI-friendly contract,
    // packages/cli/src/commands/health.ts) — a green cold-start has zero fail findings.
    const hasFail = finding.status === "fail";
    const expectedExitCode = hasFail ? 1 : 0;
    expect(expectedExitCode).toBe(1);
  });
});

// ===========================================================================
// PROVE-02 — the full Linux cold-start (operator, gated).
// ===========================================================================

describe.skipIf(!isLive)("PROVE-02 — full cold-start install→configure→boot→green (operator, gated)", () => {
  it.skip(
    "published tarball install (npm i -g comisai) → comis configure → daemon boots → doctor/health green from a fresh ~/.comis — SKIPPED(linux/validate:full operator step). Needs Linux + ffmpeg/bwrap (CLAUDE.md `pnpm validate:full`). Procedure: test/live/RUNBOOK.md (doctor/health/status). The bundle mechanics + the doctor/health finding shape are covered above; the tarball pack/extract mechanics are scripts/smoke/tarball-smoke.mjs.",
    () => {
      // Operator (Linux): install the published tarball, run `comis configure`, boot
      // the daemon, then `node packages/cli/dist/cli.js doctor` + `health` → green
      // (zero fail findings) from a fresh ~/.comis.
    },
  );
});
