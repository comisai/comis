// SPDX-License-Identifier: Apache-2.0
/**
 * Comis E2E Test Orchestration Script.
 *
 * Runs all integration test suites via Vitest CLI with JSON and default
 * reporters, parses the JSON results, and produces a summary report.
 *
 * Usage:
 *   npx tsx test/orchestrate.ts
 *   pnpm test:orchestrate
 *
 * Exit codes:
 *   0 - All tests passed
 *   1 - One or more tests failed, or results could not be parsed
 *
 * @module
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const RESULTS_FILE = resolve(__dirname, ".test-results.json");
const VITEST_CONFIG = resolve(__dirname, "vitest.config.ts");

// ---------------------------------------------------------------------------
// Types (Vitest JSON reporter output)
// ---------------------------------------------------------------------------

interface VitestAssertionResult {
  fullName: string;
  status: string;
  duration: number;
}

interface VitestTestResult {
  name: string;
  status: string;
  assertionResults: VitestAssertionResult[];
}

interface VitestJsonOutput {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  success: boolean;
  testResults: VitestTestResult[];
}

// ---------------------------------------------------------------------------
// --check-matrix flag (COV-14)
//
// Inspect test/e2e/flow-matrix.ts and exit non-zero if any cell is unsettled.
// Skips the integration-test run. Mirrors the invariants enforced by
// test/architecture/e2e-matrix.test.ts (COV-13) — the two enforcement paths
// are redundant by design (threat-model T-40-08-03): even if a contributor
// removes this flag handling, the architecture test still catches drift.
//
// Branch placement: TOP of the script (before the banner) so the matrix
// check is a fast-path that never spawns vitest. Argument parsing uses
// `process.argv.includes("--check-matrix")` for simplicity — order- and
// position-independent, mirroring how pnpm/npm forward CLI args.
// ---------------------------------------------------------------------------

interface MatrixCell {
  channel: string;
  flow: string;
  status: "covered" | "skipped";
  reference: string;
}

if (process.argv.includes("--check-matrix")) {
  console.log("");
  console.log("=".repeat(60));
  console.log("  Comis E2E Flow Matrix Check");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log("=".repeat(60));
  console.log("");

  const matrixModulePath = resolve(__dirname, "e2e/flow-matrix.ts");
  if (!existsSync(matrixModulePath)) {
    console.error(
      `ERROR: test/e2e/flow-matrix.ts not found at ${matrixModulePath}`,
    );
    process.exit(1);
  }

  // Top-level await — tsx + Node 22 ESM. Same .js-extension convention as the
  // architecture gate test (`../e2e/flow-matrix.js`) so the two import paths
  // are consistent.
  const matrixModule = (await import("./e2e/flow-matrix.js")) as {
    flowMatrix: ReadonlyArray<MatrixCell>;
  };
  const cells = matrixModule.flowMatrix;

  // Same blocklist regex as test/architecture/e2e-matrix.test.ts — kept in
  // sync by convention; both files document the regex inline.
  const SKIP_REASON_BLOCKLIST = /^(TODO|later|tbd)/i;
  const violations: string[] = [];

  for (const cell of cells) {
    if (cell.status === "covered") {
      const refPath = resolve(PROJECT_ROOT, cell.reference);
      if (!existsSync(refPath)) {
        violations.push(
          `covered cell ${cell.channel}×${cell.flow} references missing file: ${cell.reference}`,
        );
      }
    } else if (cell.status === "skipped") {
      const reason = cell.reference;
      if (!reason || reason.trim().length === 0) {
        violations.push(
          `skipped cell ${cell.channel}×${cell.flow} has empty reason`,
        );
      } else if (SKIP_REASON_BLOCKLIST.test(reason.trim())) {
        violations.push(
          `skipped cell ${cell.channel}×${cell.flow} reason is blocklisted: "${reason}"`,
        );
      }
    } else {
      violations.push(
        `cell ${cell.channel}×${cell.flow} has invalid status: ${String((cell as MatrixCell).status)}`,
      );
    }
  }

  if (violations.length === 0) {
    console.log(`OK: all ${cells.length} flow-matrix cells are settled`);
    console.log("");
    process.exit(0);
  } else {
    console.error(
      `FAIL: ${violations.length} unsettled cell(s) in test/e2e/flow-matrix.ts:`,
    );
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    console.error("");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

console.log("");
console.log("=".repeat(60));
console.log("  Comis E2E Test Orchestration");
console.log(`  Started: ${new Date().toISOString()}`);
console.log("=".repeat(60));
console.log("");

// ---------------------------------------------------------------------------
// Build and execute vitest command
// ---------------------------------------------------------------------------

const cmd = [
  "npx vitest run",
  `--config ${VITEST_CONFIG}`,
  "--reporter=json --reporter=default",
  `--outputFile.json=${RESULTS_FILE}`,
].join(" ");

let testsFailed = false;

try {
  execSync(cmd, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    timeout: 1_200_000,
  });
} catch {
  // Non-zero exit code means test failures -- continue to parse results
  testsFailed = true;
}

// ---------------------------------------------------------------------------
// Parse JSON results
// ---------------------------------------------------------------------------

console.log("");
console.log("-".repeat(60));
console.log("  Test Results Summary");
console.log("-".repeat(60));
console.log("");

if (!existsSync(RESULTS_FILE)) {
  if (testsFailed) {
    console.log("ERROR: Tests failed and no JSON results file was produced.");
    console.log(`Expected results at: ${RESULTS_FILE}`);
    process.exitCode = 1;
  } else {
    console.log("WARNING: No JSON results file found, but tests appeared to pass.");
  }
} else {
  const raw = readFileSync(RESULTS_FILE, "utf-8");
  const results: VitestJsonOutput = JSON.parse(raw) as VitestJsonOutput;

  const {
    numTotalTestSuites,
    numPassedTests,
    numTotalTests,
    numFailedTests,
  } = results;

  console.log(
    `${numPassedTests}/${numTotalTests} tests passed across ${numTotalTestSuites} suites`,
  );
  console.log("");

  if (numFailedTests > 0) {
    console.log(`Failed tests (${numFailedTests}):`);

    for (const suite of results.testResults) {
      for (const assertion of suite.assertionResults) {
        if (assertion.status !== "passed") {
          console.log(`  - ${assertion.fullName}`);
        }
      }
    }

    console.log("");
    process.exitCode = 1;
  } else {
    console.log(
      `All ${numTotalTests} tests passed. No flaky tests detected.`,
    );
  }

  // Clean up results file (leave for debugging if tests failed)
  if (!testsFailed) {
    try {
      unlinkSync(RESULTS_FILE);
    } catch {
      // Ignore cleanup errors
    }
  }
}

console.log("");
console.log("=".repeat(60));
console.log(`  Finished: ${new Date().toISOString()}`);
console.log("=".repeat(60));
