// SPDX-License-Identifier: Apache-2.0
/**
 * Live-fire test runner — tsx-driven orchestrator.
 *
 * Usage:
 *   pnpm test:live [mode] [--dry] [--profile <name>]
 *   pnpm test:live --dry          # dry run: print plan + cost estimate, no real calls
 *   pnpm test:live core           # run core-loop scenarios (requires COMIS_LIVE=1)
 *   pnpm test:live all            # run all available scenarios
 *
 * Master gate: COMIS_LIVE env var. When unset, exits 0 immediately with a
 * "Live tier skipped" message. No provider call, no network, no cost.
 *
 * live.env loading: if test/live/live.env exists it is read and injected
 * into process.env before the COMIS_LIVE gate check. Values are never
 * logged — T-134-18 (Information Disclosure) mitigation.
 *
 * parseArgs is a named export so runner.test.ts can unit-test it without
 * triggering any side effects (process.exit, env reads, execSync).
 * All side effects live inside runMain() which is guarded by isMain.
 *
 * @module
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CostGovernor } from "./cost.js";
import { buildCredentialRegistry } from "./credentials.js";
import { writeReport, type LiveTestReport } from "./report.js";
import { runSweep, parseProbeFilter } from "./sweep/sweep.js";
import { writeGapReport } from "./sweep/gap-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const LIVE_ENV_PATH = join(__dirname, "live.env");
const REPORT_FILE = resolve(PROJECT_ROOT, ".test-live-report.json");
const SMOKE_TEST = "test/live/scenarios/smoke.test.ts";
const VITEST_CONFIG = "test/vitest.config.ts";
const BENCHMARKS_DIR = resolve(PROJECT_ROOT, "benchmarks");

// ---------------------------------------------------------------------------
// parseArgs — exported named export, no side effects.
// Unit tests import only this symbol; main script execution is guarded below.
// ---------------------------------------------------------------------------

/**
 * Parse the live-fire runner's CLI arguments.
 *
 * @param argv - Array of argument strings (e.g. process.argv.slice(2))
 * @returns Parsed options: dry flag, mode string, and optional profile name
 */
export function parseArgs(argv: string[]): { dry: boolean; mode: string; profile?: string } {
  const dry = argv.includes("--dry");
  // Parse --profile <name> flag
  const profileIdx = argv.indexOf("--profile");
  const profile = profileIdx !== -1 && profileIdx + 1 < argv.length
    ? argv[profileIdx + 1]
    : undefined;
  // Mode is the first non-flag argument (flags start with '--');
  // skip the value that follows --profile since it is not a positional mode arg.
  const mode =
    argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--profile") ?? "all";
  return { dry, mode, profile };
}

// ---------------------------------------------------------------------------
// live.env loading — T-134-18: values are injected into process.env only;
// never logged or passed to external processes as visible strings.
// ---------------------------------------------------------------------------

function loadLiveEnv(): void {
  if (!existsSync(LIVE_ENV_PATH)) return;
  let content: string;
  try {
    content = readFileSync(LIVE_ENV_PATH, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding single or double quotes (standard .env convention).
    // e.g. KEY="sk-ant-api03-..." or KEY='sk-ant-...' → strip outer quotes.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // Only set if not already present in the environment.
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Main orchestration — guarded so unit tests can import parseArgs without
// triggering process.exit or any side effects.
// ---------------------------------------------------------------------------

// ESM main-script detection: tsx sets process.argv[1] to the resolved file path.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/runner.ts") ||
    process.argv[1].endsWith("/runner.js") ||
    process.argv[1] === __filename);

if (isMain) {
  // Load live.env BEFORE the COMIS_LIVE gate check so the env file can set it.
  loadLiveEnv();

  // COMIS_LIVE gate — exit 0 immediately when unset.
  if (!process.env["COMIS_LIVE"]) {
    console.log(
      "Live tier skipped (COMIS_LIVE not set). " +
        "Set COMIS_LIVE=1 in test/live/live.env to run live tests.",
    );
    process.exit(0);
  }

  runMain().catch((err: unknown) => {
    console.error("Live runner fatal error:", err);
    process.exit(1);
  });
}

async function runMain(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const governor = new CostGovernor();
  const credentialRegistry = buildCredentialRegistry();

  // Banner
  console.log("");
  console.log("=".repeat(60));
  console.log("  Comis Live-Fire Test Runner");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log("=".repeat(60));
  console.log("");

  // --dry mode: print plan + cost estimate and exit 0
  if (args.dry) {
    console.log("=== Live-fire dry run === " + new Date().toISOString());
    console.log("");
    console.log(
      `Budget: $${governor.tally().toFixed(2)} (ceiling: COMIS_LIVE_BUDGET_USD)`,
    );
    console.log("");

    const unlockedCategories = credentialRegistry.getUnlockedCategories();
    if (unlockedCategories.length > 0) {
      console.log("Available categories: " + unlockedCategories.join(", "));
    } else {
      console.log(
        "Available categories: (none — no API keys found in env)",
      );
    }

    // List skipped categories (sampling the most common ones)
    const commonCategories = [
      "LLM(anthropic)",
      "LLM(openai)",
      "LLM(google)",
    ];
    const skippedCategories = commonCategories.filter(
      (cat) => credentialRegistry.getSkipVerdict(cat) !== null,
    );
    if (skippedCategories.length > 0) {
      console.log(
        "SKIPPED categories: " +
          skippedCategories
            .map(
              (cat) =>
                `${cat} (${credentialRegistry.getSkipVerdict(cat) ?? "ok"})`,
            )
            .join(", "),
      );
    }

    console.log("");
    console.log(`Mode: ${args.mode}`);
    console.log("");

    if (args.mode === "sweep") {
      const probeIds = parseProbeFilter();
      const result = await runSweep(credentialRegistry, governor, { dry: true, probeIds });
      console.log(`Sweep probes (${result.verdicts.length}): ${result.verdicts.map(v => v.id).join(", ")}`);
      console.log("(dry run — no real calls, no report written)");
    } else if (args.mode === "core" || args.mode === "loop") {
      console.log("Loop scenarios (LOOP-01..04): multi-turn, tool-call, restart, streaming");
      console.log("  test/live/scenarios/loop/*.test.ts");
      console.log("  Cost tier: ¢ (real LLM; cheapest available model per provider)");
    } else if (args.mode === "cache") {
      console.log("Cache scenarios (CACHE-01..03): Anthropic write/hit/invalidate, Gemini CachedContent, retention×adaptive×strategy matrix");
      console.log("  test/live/scenarios/cache/*.test.ts");
      console.log("  Cost tier: ¢ (real LLM; cheapest available model per provider)");
    } else if (args.mode === "ctx") {
      console.log("Context engine scenarios (CTX-01..05): dag-invariants, summarization, expansion, pipeline");
      console.log("  test/live/scenarios/ctx/*.test.ts");
      console.log("  Cost tier: ¢–$ (Stage-A free; Stage-C real LLM; cheapest available model)");
    } else if (args.mode === "memory") {
      console.log("Memory scenarios (MEM-01..08): recall-golden, embedding-matrix, recall-lanes, trust-safety, consolidation, cost-features, budget-interaction");
      console.log("  test/live/scenarios/memory/*.test.ts");
      console.log("  Cost tier: $0 for Stage-B (local embeddings); Stage-C needs COMIS_LIVE + keys");
    } else if (args.mode === "tools") {
      console.log("Tools scenarios (TOOL-01..02): builtin-invoke, modes (deferred/cluster/lifecycle/detour)");
      console.log("  test/live/scenarios/tools/*.test.ts");
      console.log("  Cost tier: $0 Stage-A (no daemon); $0 Stage-B (config-driven, LLM-free); Stage-C needs COMIS_LIVE + LLM keys (¢)");
    } else if (args.mode === "mcp") {
      console.log("MCP scenarios (MCP-01..03): transport-auth, policy-ratelimit, trust-sandbox");
      console.log("  test/live/scenarios/mcp/*.test.ts");
      console.log("  Cost tier: $0 Stage-A (structural); $0 Stage-B (local mock server, LLM-free); Stage-C needs COMIS_LIVE + provider");
    } else {
      console.log(
        "Estimated scenarios for mode: (TBD — populated by each phase as scenarios are added)",
      );
    }
    console.log("");
    process.exit(0);
  }

  // Live mode: dispatch to scenario runner
  console.log(`Mode: ${args.mode}`);
  console.log("");

  let testsFailed = false;

  if (args.mode === "sweep") {
    // Phase 135: sweep mode — run all probes, write gap report
    const probeIds = parseProbeFilter();
    const result = await runSweep(credentialRegistry, governor, { dry: args.dry, probeIds });

    if (!args.dry) {
      try {
        const ledgerDir = writeGapReport(result, BENCHMARKS_DIR);
        console.log(`Gap report written: ${ledgerDir}/gap-report.json`);
      } catch (err) {
        console.error("Gap report write failed:", err);
        // Secret leak in report — still counts as a failure
        testsFailed = true;
      }
    }

    // Print sweep summary
    console.log("");
    console.log("=== Sweep Summary ===");
    console.log(`  Green: ${result.verdicts.filter(v => v.status === "green").length}`);
    console.log(`  Red:   ${result.verdicts.filter(v => v.status === "red").length}`);
    console.log(`  Skip:  ${result.verdicts.filter(v => v.status === "skip").length}`);
    const redProbes = result.verdicts.filter(v => v.status === "red");
    if (redProbes.length > 0) {
      console.log("");
      console.log("Red probes:");
      for (const v of redProbes) {
        console.log(`  [RED] ${v.id} (${v.category}): ${v.reason ?? "unknown error"}`);
      }
      testsFailed = true;
    }
    console.log("");

  } else if (args.mode === "core" || args.mode === "loop") {
    // Phase 136: core real-LLM conversation loop scenarios (LOOP-01..04)
    const LOOP_TEST_GLOB = "test/live/scenarios/loop/*.test.ts";
    const loopCmd = [
      "npx vitest run",
      `"${LOOP_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(loopCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "cache") {
    // Phase 137: LLM cache scenarios (CACHE-01..03)
    const CACHE_TEST_GLOB = "test/live/scenarios/cache/*.test.ts";
    const cacheCmd = [
      "npx vitest run",
      `"${CACHE_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(cacheCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "ctx") {
    // Phase 138: context engine scenarios (CTX-01..05)
    const CTX_TEST_GLOB = "test/live/scenarios/ctx/*.test.ts";
    const ctxCmd = [
      "npx vitest run",
      `"${CTX_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(ctxCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "memory") {
    // Phase 139: long-term memory scenarios (MEM-01..08)
    const MEM_TEST_GLOB = "test/live/scenarios/memory/*.test.ts";
    const memCmd = [
      "npx vitest run",
      `"${MEM_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(memCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "tools") {
    // Phase 140: TOOL+MCP — built-in tool invocation scenarios (TOOL-01..02)
    const TOOLS_TEST_GLOB = "test/live/scenarios/tools/*.test.ts";
    const toolsCmd = [
      "npx vitest run",
      `"${TOOLS_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(toolsCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "mcp") {
    // Phase 140: TOOL+MCP — MCP transport×auth matrix + policy + trust scenarios (MCP-01..03)
    const MCP_TEST_GLOB = "test/live/scenarios/mcp/*.test.ts";
    const mcpCmd = [
      "npx vitest run",
      `"${MCP_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(mcpCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else {
    // Default: smoke test (Phase 134 baseline)
    const smokeCmd = [
      "npx vitest run",
      SMOKE_TEST,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(smokeCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  }

  // Write report
  const report: LiveTestReport = {
    runId: `live-${Date.now()}`,
    ts: new Date().toISOString(),
    git_sha: (() => {
      try {
        return execSync("git rev-parse --short HEAD", {
          stdio: ["pipe", "pipe", "pipe"],
        })
          .toString()
          .trim();
      } catch {
        return "unknown";
      }
    })(),
    mode: args.mode,
    budget_usd: governor.tally(),
    total_cost_usd: 0,
    verdicts: [],
  };

  try {
    writeReport(report, REPORT_FILE);
    console.log(`Report written: ${REPORT_FILE}`);
  } catch (err) {
    console.error("Report write failed:", err);
  }

  process.exit(testsFailed ? 1 : 0);
}
