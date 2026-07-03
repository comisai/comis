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
 * logged — information-disclosure mitigation.
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
import { writeReadinessReport } from "./readiness.js";
import { runSweep, parseProbeFilter } from "./sweep/sweep.js";
import { writeGapReport } from "./sweep/gap-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const LIVE_ENV_PATH = join(__dirname, "live.env");
const REPORT_FILE = resolve(PROJECT_ROOT, ".test-live-report.json");
const READINESS_FILE = resolve(PROJECT_ROOT, "READINESS.md");
const SMOKE_TEST = "test/live/scenarios/smoke.test.ts";
// The dedicated live-tier config sets fileParallelism:false so daemon-booting
// scenarios do not oversubscribe the host — the gate is reliable WITHOUT the
// manual --no-file-parallelism flag.
const VITEST_CONFIG = "test/live/vitest.config.ts";
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
// live.env loading — values are injected into process.env only; never logged
// or passed to external processes as visible strings (information disclosure).
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

  // --readiness: generate the honest READINESS.md and exit. This runs BEFORE the
  // COMIS_LIVE gate — the keyless PARTIAL readiness IS the headline readiness
  // artifact (most categories PARTIAL: deterministic Stage-A/B certified, real-
  // provider Stage-C deferred to an operator run; NO faked CERTIFIED). An operator run with
  // COMIS_LIVE set generates the live readiness. Parsed from process.argv directly
  // so parseArgs's {dry,mode,profile} shape is unchanged (runner.test.ts toEqual).
  if (process.argv.slice(2).includes("--readiness")) {
    writeReadinessReport({ isLive: !!process.env["COMIS_LIVE"] }, READINESS_FILE);
    console.log(`READINESS.md written: ${READINESS_FILE}`);
    process.exit(0);
  }

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

  // (--readiness is handled in the isMain block above, before the COMIS_LIVE gate,
  // so it works on a keyless build — it never reaches runMain.)

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
    } else if (args.mode === "orch") {
      console.log("ORCH scenarios (ORCH-01..04): dag-pipeline, background-reentry, routing, isolation");
      console.log("  test/live/scenarios/orch/*.test.ts");
      console.log("  Cost tier: $0 Stage-B (deterministic/config-driven, no model); Stage-C real LLM + COMIS_LIVE");
    } else if (args.mode === "media") {
      console.log("Media scenarios (MEDIA-01..04): voice-roundtrip, fallback-chain, vision, image-gen");
      console.log("  test/live/scenarios/media/*.test.ts");
      console.log("  Cost tier: $0 Stage-A/B (ffmpeg-absent text-fallback / STT fallback-chain routing / vision capability-routing / autoMode delivery — all keyless/deterministic); Stage-C needs COMIS_LIVE + STT/TTS/vision/image-gen keys (+ ffmpeg for voice conversion)");
    } else if (args.mode === "web") {
      console.log("Web scenarios (WEB-01..03): search-providers, link-understanding, document-extraction");
      console.log("  test/live/scenarios/web/*.test.ts");
      console.log("  Cost tier: $0 Stage-B (doc extraction CSV/text + maxChars truncation + DOCX unsupported_mime / wrapWebContent taint markers + marker-sanitization / 8-provider search config-shape + key-gating + freshness — all keyless/deterministic); Stage-C needs COMIS_LIVE + search keys (judged answers) / network (link fetch + DuckDuckGo) / a vision key (PDF OCR fallback)");
    } else if (args.mode === "channels") {
      console.log("Channel scenarios (CHAN-01..03): echo-golden, delivery-modes");
      console.log("  test/live/scenarios/channels/*.test.ts");
      console.log("  Cost tier: $0 Stage-B (echo registry golden round-trip + 9-adapter credential-validation empty-input breadth + crash-safe SQLite delivery-queue resume + streaming/queue/overflow/dmScope config-shape — all in-process/keyless/deterministic); Stage-C needs COMIS_LIVE + a real channel account/network (real send→agent→reply, positive token validation, live Slack Socket Mode, live IMAP/OAuth email) — see test/live/RUNBOOK.md for the manual procedure");
    } else if (args.mode === "sec") {
      console.log("Security/failure scenarios (SEC-01..06): failure-injection, prompt-injection, memory-poisoning, secret-residency, gateway-scopes, sandbox-net");
      console.log("  test/live/scenarios/sec/*.test.ts");
      console.log("  Cost tier: $0 Stage-A/B (fault injectors + per-source wrapExternalContent neutralization + validateMemoryWrite classification + the SECRET-RESIDENCY scan [positive control + redaction-chain + report/ledger] + GatewayTokenSchema scope-disjointness + approval-gate pause/resolve + sandbox-exec exec-confinement — all in-process/keyless/deterministic); Stage-C needs COMIS_LIVE + a real provider/network (real-provider failover under a real 429/5xx, the AgentDojo/ASB injection benchmark, the real-LLM redaction-ON residency sweep, live gateway admin-RPC-denial + rate-limit-429); bwrap + net{open,broker-only} is SKIPPED(no-bwrap/linux-only) on macOS");
    } else if (args.mode === "plat") {
      console.log("Platform scenarios (PLAT-01..04): config-system, secrets-backends, scheduler, terminal-driver");
      console.log("  test/live/scenarios/plat/*.test.ts");
      console.log("  Cost tier: $0 Stage-B (config-system fail-fast/layering/${VAR}/immutable-keys + config-audit record + the 3 security.storage secrets backends resolving a canary credential + the scheduler cron-fire/auto-suspend/concurrency-cap + execution.jsonl + heartbeat ok/alert mechanics via injectable stubs + the terminal-driver auto-answer/escalate-always/loop-guard/cap arithmetic + config-shape — all in-process/keyless/deterministic, no model); Stage-C needs COMIS_LIVE + a real provider (the real-LLM-turn-from-cron, the live config.patch+restart+rollback over the gateway, the real-boot credential auth); driving a real interactive CLI is SKIPPED(no-bwrap/linux-only) on macOS");
    } else if (args.mode === "journeys") {
      console.log("E2E journey scenarios (E2E-01..05): user-story library + generic journey-runner");
      console.log("  test/live/journeys/*.test.ts");
      console.log("  Cost tier: $0 Stage-A/B (zod UserStory schema + self-registering STORY_LIBRARY + the open/closed zero-harness-change extensibility test + the generic journey-runner interpreting a story on echo+mock + requires→skip gating + coverage auto-wiring + the 8 seed-story shapes US-01..08 — all in-process/keyless/deterministic, no model); Stage-C/D needs COMIS_LIVE + a real provider + the component Stage-C certs for the real-LLM multi-turn journey execution (goal-achieved + judged task-success + one stitched traceId + obs.billing, N-run pass-rate × model grid); J7 terminal-driven is SKIPPED(no-bwrap/linux-only) on macOS");
    } else if (args.mode === "prove") {
      console.log("PROVE scenarios (PROVE-01..05): obs-meta, cold-start, soak-smoke");
      console.log("  test/live/scenarios/prove/*.test.ts");
      console.log("  Cost tier: $0 Stage-A/B (the observability meta-validation [billed=response token agreement + reconstruct-from-trace over a seeded session-index + no ERROR/WARN without hint+errorKind via runLogOracle], the tarball-smoke bundle mechanics + the doctor/health finding shape, and the short deterministic soak smoke [the runSoak harness reuses the STORY_LIBRARY as traffic + parses the daemon health line] are all deterministic and assert against the real product code); the real multi-hour Linux-VPS soak is SKIPPED(operator), the full cold-start install→configure→boot→green is SKIPPED(linux/validate:full), and the real-provider full-run meta is SKIPPED(no-live). Run `pnpm test:live --readiness` to publish READINESS.md.");
    } else if (args.mode === "all") {
      console.log("ALL modes — every scenario + journey + the PROVE pillars within the higher budget ceiling");
      console.log("  test/live/scenarios/**/*.test.ts + test/live/journeys/*.test.ts");
      console.log("  Cost tier: $$ (the full real-provider suite — operator/scheduled run within COMIS_LIVE_BUDGET_USD); keyless ⇒ the deterministic Stage-A/B layers run + the real-provider Stage-C self-skips (skip≠fail)");
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
    // sweep mode — run all probes, write gap report
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
    // core real-LLM conversation loop scenarios (LOOP-01..04)
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
    // LLM cache scenarios (CACHE-01..03)
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
    // context engine scenarios (CTX-01..05)
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
    // long-term memory scenarios (MEM-01..08)
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
    // built-in tool invocation scenarios (TOOL-01..02)
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
    // MCP transport×auth matrix + policy + trust scenarios (MCP-01..03)
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
  } else if (args.mode === "orch") {
    // subagent DAG + routing + isolation + re-entry (ORCH-01..04)
    const ORCH_TEST_GLOB = "test/live/scenarios/orch/*.test.ts";
    const orchCmd = [
      "npx vitest run",
      `"${ORCH_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(orchCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "media") {
    // voice round-trip, fallback chain, vision, image-gen (MEDIA-01..04)
    const MEDIA_TEST_GLOB = "test/live/scenarios/media/*.test.ts";
    const mediaCmd = [
      "npx vitest run",
      `"${MEDIA_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(mediaCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "web") {
    // search providers, link understanding, document extraction (WEB-01..03)
    const WEB_TEST_GLOB = "test/live/scenarios/web/*.test.ts";
    const webCmd = [
      "npx vitest run",
      `"${WEB_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(webCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "channels") {
    // echo golden + delivery modes (CHAN-01..03)
    const CHAN_TEST_GLOB = "test/live/scenarios/channels/*.test.ts";
    const chanCmd = [
      "npx vitest run",
      `"${CHAN_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(chanCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "sec") {
    // security & failure injection — SEC-01..06
    const SEC_TEST_GLOB = "test/live/scenarios/sec/*.test.ts";
    const secCmd = [
      "npx vitest run",
      `"${SEC_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(secCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "plat") {
    // platform scenarios — PLAT-01..04
    const PLAT_TEST_GLOB = "test/live/scenarios/plat/*.test.ts";
    const platCmd = [
      "npx vitest run",
      `"${PLAT_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(platCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "journeys") {
    // E2E — user-story library + generic journey-runner (E2E-01..05)
    const JOURNEYS_TEST_GLOB = "test/live/journeys/*.test.ts";
    const journeysCmd = [
      "npx vitest run",
      `"${JOURNEYS_TEST_GLOB}"`,
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(journeysCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "prove") {
    // PROVE — obs-meta + cold-start + soak-smoke (PROVE-01..05).
    // NOTE: vitest treats a positional arg as a path-SUBSTRING filter (NOT a shell
    // glob — a quoted `*.test.ts` matches nothing). Pass the directory path so the
    // live-tier config's include (test/live/**/*.test.ts) is filtered to the prove dir.
    const proveCmd = [
      "npx vitest run",
      "test/live/scenarios/prove",
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(proveCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else if (args.mode === "all") {
    // the FULL tier — every test under test/live (every scenario incl.
    // prove + the smoke, every journey, the harness unit tests), run sequentially
    // under the dedicated live-tier config (fileParallelism:false). This is the
    // scheduled release-gate run; keyless ⇒ the deterministic Stage-A/B layers run
    // + the real-provider Stage-C self-skips (skip ≠ fail). No positional filter →
    // the config's full include (test/live/**/*.test.ts) runs.
    const allCmd = [
      "npx vitest run",
      `--config ${VITEST_CONFIG}`,
    ].join(" ");

    try {
      execSync(allCmd, { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      testsFailed = true;
    }
  } else {
    // Default (unknown mode): smoke test baseline
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
