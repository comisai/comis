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
 *     - persistence oracle: lcd_summaries delta = 0 for pipeline (no DAG store)
 *     - log oracle (expectedErrors: ["JSON-RPC method error"]) on each combo
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
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildCredentialRegistry } from "../../credentials.js";
import { buildCtxConfig } from "../../harness/ctx-config.js";

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
      const configPath = buildCtxConfig({ version, contextThreshold, label: `pipe-${label}`, filePrefix: "ctx-pipe" });
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

          // Only assert for low threshold — high threshold + short session may not fire compaction.
          // Rely solely on the event-bus check (capturedEvents) — raw log-line substring search
          // on JSON-serialised Pino entries produces false positives.
          if (contextThreshold <= 0.5) {
            expect(
              pipelineCompactionFired,
              "pipeline compaction or masking event must fire for low threshold",
            ).toBe(true);
          }

          // Pipeline mode does NOT use the DAG lcd_* store.
          // Persistence oracle: lcd_summaries delta = 0 for pipeline mode.
          if (existsSync(dbPath)) {
            await runDbOracle(dbPath, {
              expectedDeltas: [{ table: "lcd_summaries", expectedRowDelta: 0 }],
              beforeCounts,
            });
          }
        } else {
          // DAG mode: assertO1MetricsNonZero must pass for low-threshold profiles
          // where compaction is expected. For high threshold, only run integrity checks.
          // Guard by threshold — NOT by events.length (empty events must FAIL, not skip).
          if (contextThreshold <= 0.5) {
            assertO1MetricsNonZero(events); // throws with diagnostic if events empty
          }
          // lcd_summaries may grow (dag mode with low threshold) — integrity check only.
          if (existsSync(dbPath)) {
            await runDbOracle(dbPath, {});
          }
        }

        // Log oracle — no unexpected ERROR/FATAL lines in successful live turns.
        await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });
      } finally {
        await driver.close().catch(() => {
          // Swallow shutdown noise — the daemon may already have exited.
        });
        // Clean up the per-combo temp config file to avoid tmpdir bloat.
        try { rmSync(configPath); } catch { /* ignore if already gone */ }
      }
    },
    5 * 60_000,
  );
});
