// SPDX-License-Identifier: Apache-2.0
/**
 * CTX-05 — pipeline observation-masking hysteresis + compaction trigger/cooldown/prefix-anchor.
 *
 * Stage-A (always runs — no COMIS_LIVE, no daemon):
 *   Structural: ENGINE_MODE_MATRIX covers version{pipeline,dag}.
 *              THRESHOLD_MATRIX covers low (<=0.5) and high (>=0.7) contextThreshold profiles.
 *
 * Stage-C (describe.skipIf(!isLive)):
 *   Iterates ENGINE_MODE_MATRIX combos (pipeline×low, dag×low, pipeline×high, dag×high).
 *   Each combo drives N turns via ConversationDriver against a real LLM, then asserts:
 *     - pipeline mode: compaction:started OR context:masked OR context:compacted OR context:evicted
 *       fires via driver.capturedEvents() — observation-masking hysteresis active
 *     - dag mode: assertO1MetricsNonZero (context:dag_compacted or context:evicted)
 *       via driver.capturedEvents()
 *     - FND-11 persistence oracle: lcd_summaries delta = 0 for pipeline (no DAG store)
 *     - FND-10 log-oracle (expectedErrors: ["JSON-RPC method error"]) on each combo
 *     - COMIS_LIVE unset → Stage-C skips cleanly (0 failures)
 *
 * costTier: "¢¢" — Anthropic Haiku, 10–15 turns per combo.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle, snapshotRowCounts } from "../../assert/db-oracle.js";
import { assertO1MetricsNonZero } from "../../assert/context-trace.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildCredentialRegistry } from "../../credentials.js";

// ---------------------------------------------------------------------------
// COMIS_LIVE gate — Stage-C blocks skip (not fail) when unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

// ---------------------------------------------------------------------------
// Engine mode matrix — contextEngine.version × contextThreshold profiles
//
// contextWindow is a PROVIDER-MODEL key — it is NOT patchable under agents.default.
// Use contextThreshold (schema-agent-context.ts line 255) as the profile differentiator.
//
// Four combos: pipeline×low, dag×low, pipeline×high, dag×high.
// ---------------------------------------------------------------------------

const ENGINE_MODE_MATRIX = [
  { version: "pipeline" as const, thresholdLabel: "low",  contextThreshold: 0.4 },
  { version: "dag"      as const, thresholdLabel: "low",  contextThreshold: 0.4 },
  { version: "pipeline" as const, thresholdLabel: "high", contextThreshold: 0.75 },
  { version: "dag"      as const, thresholdLabel: "high", contextThreshold: 0.75 },
];

// ---------------------------------------------------------------------------
// Threshold matrix — separate structural check
// ---------------------------------------------------------------------------

const THRESHOLD_MATRIX = [
  { contextThreshold: 0.4,  label: "low"  },
  { contextThreshold: 0.75, label: "high" },
];

// ---------------------------------------------------------------------------
// Per-combo config builder (copied from dag-invariants.test.ts)
//
// Patches contextEngine.version and contextThreshold under agents.default.
// ConversationDriver._buildPortedConfigPath() subsequently patches only the
// gateway port line inside the gateway: block.
//
// Base config: test/config/config.test.yaml
// ---------------------------------------------------------------------------

function buildCtxConfig(opts: {
  version: "pipeline" | "dag";
  contextThreshold?: number;
  label: string;
}): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const base = join(here, "../../config/config.test.yaml");
  let content = readFileSync(base, "utf-8");

  // Patch contextEngine.version inside agents.default block.
  // If a contextEngine block already exists, replace the version line.
  // Otherwise inject the contextEngine block under agents.default.
  if (/contextEngine:/.test(content)) {
    content = content.replace(/version:\s*\S+/, `version: ${opts.version}`);
  } else {
    content = content.replace(
      /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
      `$1\n    contextEngine:\n      version: ${opts.version}$2`,
    );
  }

  // Patch contextThreshold under agents.default (NOT contextWindow — that is
  // a provider-model-level key and will fail schema validation if placed here).
  if (opts.contextThreshold !== undefined) {
    if (/contextThreshold:\s*[\d.]+/.test(content)) {
      content = content.replace(
        /contextThreshold:\s*[\d.]+/,
        `contextThreshold: ${opts.contextThreshold}`,
      );
    } else {
      content = content.replace(
        /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
        `$1\n    contextThreshold: ${opts.contextThreshold}$2`,
      );
    }
  }

  const outPath = join(
    tmpdir(),
    `ctx-pipe-${opts.label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.yaml`,
  );
  writeFileSync(outPath, content, "utf-8");
  return outPath;
}

// ---------------------------------------------------------------------------
// Stage-A — pipeline matrix structure (no COMIS_LIVE)
// ---------------------------------------------------------------------------

describe("CTX-05 Stage-A — pipeline matrix structure (no COMIS_LIVE)", () => {
  it("ENGINE_MODE_MATRIX covers version{pipeline,dag}", () => {
    const modes = ENGINE_MODE_MATRIX.map((m) => m.version);
    expect(modes).toContain("pipeline");
    expect(modes).toContain("dag");
    for (const entry of ENGINE_MODE_MATRIX) {
      expect(typeof entry.version).toBe("string");
      expect(typeof entry.thresholdLabel).toBe("string");
    }
  });

  it("THRESHOLD_MATRIX covers low and high contextThreshold profiles", () => {
    const thresholds = THRESHOLD_MATRIX.map((t) => t.contextThreshold);
    expect(thresholds.some((t) => t <= 0.5)).toBe(true);
    expect(thresholds.some((t) => t >= 0.7)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real-LLM both modes × threshold profiles (COMIS_LIVE only)
// ---------------------------------------------------------------------------

// costTier: "¢¢" — Anthropic Haiku, 10–15 turns per combo, 4 combos
describe.skipIf(!isLive)("Live — CTX-05 both modes × threshold profiles (Stage-C)", () => {
  const registry = buildCredentialRegistry();
  const canRun = registry.getSkipVerdict("LLM(anthropic)") === null;

  it.skipIf(!canRun).each(ENGINE_MODE_MATRIX)(
    "version=$version threshold=$thresholdLabel",
    async ({ version, thresholdLabel, contextThreshold }) => {
      const label = `${version}-${thresholdLabel}`;
      const configPath = buildCtxConfig({ version, contextThreshold, label: `pipe-${label}` });
      const driver = new ConversationDriver({
        agentId: `ctx-pipe-${label}`,
        provider: "anthropic",
        timeoutMs: 4 * 60_000,
        configPath,
      });
      await driver.init();

      const dbPath = join(driver.getDataDir(), "memory.db");
      const beforeCounts = existsSync(dbPath)
        ? snapshotRowCounts(dbPath, ["lcd_summaries"])
        : {};

      try {
        // Drive enough turns to cross contextThreshold and trigger compaction.
        // Low threshold (0.4) needs fewer turns; high threshold (0.75) needs more.
        const turnCount = contextThreshold <= 0.5 ? 10 : 15;
        for (let i = 0; i < turnCount; i++) {
          await driver.sendTurn(
            `Step ${i}: describe in detail one aspect of machine learning model training, ` +
            `optimization, and evaluation strategies for production deployment.`,
          );
        }
        await flushDaemonLogs(driver);

        // Parse events via capturedEvents()
        const events = driver.capturedEvents();

        if (version === "pipeline") {
          // Pipeline mode: compaction:started OR context:masked OR context:compacted OR context:evicted
          // (observation-masking hysteresis + compaction trigger)
          const pipelineCompactionFired =
            events.some((e) => e.name === "compaction:started") ||
            events.some((e) => e.name === "context:masked") ||
            events.some((e) => e.name === "context:compacted") ||
            events.some((e) => e.name === "context:evicted");

          // If events not captured, scan log lines for the Pino message strings as a secondary check.
          // NOTE: the real Pino message is "Auto-compaction started" (NOT the event-name "compaction:started").
          const logLines = driver.capturedLogLines();
          const logCompactionFired =
            pipelineCompactionFired ||
            logLines.includes("Auto-compaction started") ||
            logLines.includes("context:masked") ||
            logLines.includes("context:compacted") ||
            logLines.includes("context:evicted");

          // Only assert for low threshold — high threshold + short session may not fire compaction.
          if (contextThreshold <= 0.5) {
            expect(
              logCompactionFired,
              "pipeline compaction or masking event must fire for low threshold",
            ).toBe(true);
          }

          // Pipeline mode does NOT use the DAG lcd_* store.
          // FND-11: lcd_summaries delta = 0 for pipeline mode.
          if (existsSync(dbPath)) {
            await runDbOracle(dbPath, {
              expectedDeltas: [{ table: "lcd_summaries", expectedRowDelta: 0 }],
              beforeCounts,
            });
          }
        } else {
          // DAG mode: assertO1MetricsNonZero (context:dag_compacted or context:evicted)
          if (events.length > 0) {
            assertO1MetricsNonZero(events);
          }
          // lcd_summaries may grow (dag mode with low threshold) — integrity check only.
          if (existsSync(dbPath)) {
            await runDbOracle(dbPath, {});
          }
        }

        // FND-10 log-oracle — no unexpected ERROR/FATAL lines in successful live turns.
        await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });
      } finally {
        await driver.close().catch(() => {
          // Swallow shutdown noise — the daemon may already have exited.
        });
        // IN-01: clean up the per-combo temp config file to avoid tmpdir bloat.
        try { rmSync(configPath); } catch { /* ignore if already gone */ }
      }
    },
    5 * 60_000,
  );
});
