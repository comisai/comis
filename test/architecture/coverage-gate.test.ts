// SPDX-License-Identifier: Apache-2.0
/**
 * Coverage-gate architecture test — file-neighbor invariant.
 *
 * Asserts every production .ts file in the 5 enforced directories has a
 * `<file>.test.ts` neighbor OR a coverageWaiver entry with a permanent
 * test-impractical reason.
 *
 * Enforced scopes:
 *   - packages/agent/src/executor/         (recursive)
 *   - packages/agent/src/session/          (recursive)
 *   - packages/daemon/src/wiring/setup-*.ts (basename narrow)
 *   - packages/gateway/src/{,/{web,discovery,responses,acp,openai}/}index.ts
 *   - packages/comis/src/*.ts              (direct children only)
 *
 * `coverageWaiver` should remain empty — any future addition is a
 * tampering signal flagged by the separate waiver-audit test.
 *
 * Walker is a verbatim clone of `test/architecture/file-size.test.ts:45-80`
 * (same excluded-directories + excluded-suffix list).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageWaiver } from "../support/architecture-allowlist.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

// 5 enforced directories with narrow scopes
const AGENT_EXECUTOR_DIR = resolve(REPO_ROOT, "packages/agent/src/executor");
const AGENT_SESSION_DIR = resolve(REPO_ROOT, "packages/agent/src/session");
const DAEMON_WIRING_DIR = resolve(REPO_ROOT, "packages/daemon/src/wiring");
const GATEWAY_SRC_DIR = resolve(REPO_ROOT, "packages/gateway/src");
const COMIS_SRC_DIR = resolve(REPO_ROOT, "packages/comis/src");

// Daemon wiring: ONLY setup-*.ts files
const DAEMON_WIRING_PATTERN = /^setup-[a-z][a-z0-9-]*\.ts$/;

// Gateway: ONLY public index.ts (root + web/discovery/responses/acp/openai subdirs — 6 total)
function isGatewayPublicIndex(absPath: string): boolean {
  const rel = absPath.slice(REPO_ROOT.length + 1);
  return (
    rel === "packages/gateway/src/index.ts" ||
    /^packages\/gateway\/src\/(web|discovery|responses|acp|openai)\/index\.ts$/.test(rel)
  );
}

/**
 * Walk a directory tree and collect production `.ts` files. Mirrors
 * `test/architecture/file-size.test.ts:45-80` verbatim — same excluded-
 * directories list (`__tests__`, `__snapshots__`, `dist`, `node_modules`,
 * `__test-helpers`, `fixtures`) and same excluded basename suffixes
 * (`.test.ts`, `.generated.ts`, `.d.ts`). Symlinks are skipped to avoid
 * loops.
 */
function walkProductionFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (
        [
          "__tests__",
          "__snapshots__",
          "dist",
          "node_modules",
          "__test-helpers",
          "fixtures",
        ].includes(entry.name)
      ) {
        continue;
      }
      walkProductionFiles(full, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".generated.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

function hasNeighborTest(absPath: string): boolean {
  const testPath = absPath.replace(/\.ts$/, ".test.ts");
  try {
    return statSync(testPath).isFile();
  } catch {
    return false;
  }
}

const SUGGESTED_FIX =
  "Add <file>.test.ts beside the production file with use-case-named tests; " +
  "OR add a CoverageWaiverEntry to coverageWaiver in test/support/architecture-allowlist.ts " +
  "with a permanent reason explaining why the file is genuinely test-impractical. " +
  "Waivers are NOT for legacy filename drift — rename the existing test instead.";

const ALLOWLIST_REF = "coverageWaiver (test/support/architecture-allowlist.ts)";

describe("coverage-gate — file-neighbor invariant", () => {
  const waiverSet = new Set(coverageWaiver.map((w) => w.file));

  it("every production .ts file under packages/agent/src/executor has a neighbor test or a coverageWaiver entry", () => {
    const files: string[] = [];
    walkProductionFiles(AGENT_EXECUTOR_DIR, files);
    const violations = files.filter(
      (f) => !hasNeighborTest(f) && !waiverSet.has(repoRelative(f)),
    );
    expect(
      violations.map(repoRelative),
      formatViolations({
        description:
          "Every production .ts file in packages/agent/src/executor/ must have a <file>.test.ts neighbor or a coverageWaiver entry.",
        violations: violations.map((v) => ({
          file: repoRelative(v),
          line: 0,
          snippet: "no <file>.test.ts neighbor and no coverageWaiver entry",
        })),
        suggestedFix: SUGGESTED_FIX,
        designRef: "coverage-gate file-neighbor invariant",
        allowlistRef: ALLOWLIST_REF,
      }),
    ).toEqual([]);
  });

  it("every production .ts file under packages/agent/src/session has a neighbor test or a coverageWaiver entry", () => {
    const files: string[] = [];
    walkProductionFiles(AGENT_SESSION_DIR, files);
    const violations = files.filter(
      (f) => !hasNeighborTest(f) && !waiverSet.has(repoRelative(f)),
    );
    expect(
      violations.map(repoRelative),
      formatViolations({
        description:
          "Every production .ts file in packages/agent/src/session/ must have a <file>.test.ts neighbor or a coverageWaiver entry.",
        violations: violations.map((v) => ({
          file: repoRelative(v),
          line: 0,
          snippet: "no <file>.test.ts neighbor and no coverageWaiver entry",
        })),
        suggestedFix: SUGGESTED_FIX,
        designRef: "coverage-gate file-neighbor invariant",
        allowlistRef: ALLOWLIST_REF,
      }),
    ).toEqual([]);
  });

  it("every production setup-*.ts file in packages/daemon/src/wiring has a neighbor test or a coverageWaiver entry", () => {
    const files: string[] = [];
    walkProductionFiles(DAEMON_WIRING_DIR, files);
    const inScope = files.filter((f) => DAEMON_WIRING_PATTERN.test(basename(f)));
    const violations = inScope.filter(
      (f) => !hasNeighborTest(f) && !waiverSet.has(repoRelative(f)),
    );
    expect(
      violations.map(repoRelative),
      formatViolations({
        description:
          "Every production setup-*.ts file in packages/daemon/src/wiring/ must have a <file>.test.ts neighbor or a coverageWaiver entry.",
        violations: violations.map((v) => ({
          file: repoRelative(v),
          line: 0,
          snippet: "no <file>.test.ts neighbor and no coverageWaiver entry",
        })),
        suggestedFix: SUGGESTED_FIX,
        designRef: "coverage-gate file-neighbor invariant",
        allowlistRef: ALLOWLIST_REF,
      }),
    ).toEqual([]);
  });

  it("every public gateway barrel index.ts (root + 5 sub-barrels) has a neighbor test or a coverageWaiver entry", () => {
    const files: string[] = [];
    walkProductionFiles(GATEWAY_SRC_DIR, files);
    const inScope = files.filter(isGatewayPublicIndex);
    const violations = inScope.filter(
      (f) => !hasNeighborTest(f) && !waiverSet.has(repoRelative(f)),
    );
    expect(
      violations.map(repoRelative),
      formatViolations({
        description:
          "Every public gateway barrel index.ts (packages/gateway/src/{,/{web,discovery,responses,acp,openai}/}index.ts) must have a <file>.test.ts neighbor or a coverageWaiver entry.",
        violations: violations.map((v) => ({
          file: repoRelative(v),
          line: 0,
          snippet: "no <file>.test.ts neighbor and no coverageWaiver entry",
        })),
        suggestedFix: SUGGESTED_FIX,
        designRef: "coverage-gate file-neighbor invariant",
        allowlistRef: ALLOWLIST_REF,
      }),
    ).toEqual([]);
  });

  it("every direct-child .ts file under packages/comis/src has a neighbor test or a coverageWaiver entry", () => {
    const files: string[] = [];
    walkProductionFiles(COMIS_SRC_DIR, files);
    // ONLY direct children of packages/comis/src/ (no recursion);
    // path depth must be exactly 4: ["packages", "comis", "src", "<file>"].
    const inScope = files.filter((f) => {
      const rel = repoRelative(f);
      const parts = rel.split("/");
      return (
        parts.length === 4 &&
        parts[0] === "packages" &&
        parts[1] === "comis" &&
        parts[2] === "src"
      );
    });
    const violations = inScope.filter(
      (f) => !hasNeighborTest(f) && !waiverSet.has(repoRelative(f)),
    );
    expect(
      violations.map(repoRelative),
      formatViolations({
        description:
          "Every direct-child .ts file in packages/comis/src/ must have a <file>.test.ts neighbor or a coverageWaiver entry.",
        violations: violations.map((v) => ({
          file: repoRelative(v),
          line: 0,
          snippet: "no <file>.test.ts neighbor and no coverageWaiver entry",
        })),
        suggestedFix: SUGGESTED_FIX,
        designRef: "coverage-gate file-neighbor invariant",
        allowlistRef: ALLOWLIST_REF,
      }),
    ).toEqual([]);
  });
});
