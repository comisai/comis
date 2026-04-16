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
