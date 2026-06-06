// SPDX-License-Identifier: Apache-2.0
/**
 * CTX-02 — leaf summarization fires at contextThreshold + condensation depth+1.
 *
 * Stage-A (always runs — no COMIS_LIVE, no daemon):
 *   Structural: SUMMARIZATION_MATRIX covers contextThreshold{0.4,0.6}.
 *
 * Stage-C (describe.skipIf(!isLive)):
 *   Drives 20 short turns at low contextThreshold → asserts:
 *     - context:dag_compacted fires with leafSummariesCreated > 0
 *       (assertO1MetricsNonZero against driver.capturedEvents())
 *     - lcd_summaries delta >= 1 (FND-11 persistence oracle — manual >= check)
 *   lcd_messages exact delta is NOT asserted — runDbOracle enforces exact equality
 *   and a hardcoded count false-fails on tool-use/retry turns.
 *
 * costTier: "¢¢" — Anthropic Haiku, 20 turns per combo.
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
// Summarization matrix — contextThreshold profiles
//
// contextThreshold is the agent-level key (schema-agent-context.ts line 255).
// contextWindow is a PROVIDER-MODEL level key — it CANNOT be patched under
// agents.default (schema validation would reject it). Use contextThreshold
// variation (0.4, 0.6) to differentiate profiles.
// ---------------------------------------------------------------------------

const SUMMARIZATION_MATRIX = [
  { threshold: 0.4, label: "threshold-0.4" },
  { threshold: 0.6, label: "threshold-0.6" },
] as const;

// ---------------------------------------------------------------------------
// Per-combo config builder (copied from dag-invariants.test.ts)
// ---------------------------------------------------------------------------

/**
 * Build a temp YAML config patching contextEngine.version and contextThreshold
 * under agents.default. ConversationDriver's _buildPortedConfigPath() will
 * subsequently patch only the gateway port line inside the gateway: block.
 *
 * Base config: test/config/config.test.yaml
 */
function buildCtxConfig(opts: {
  version?: "pipeline" | "dag";
  contextThreshold?: number;
  label: string;
}): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const base = join(here, "../../config/config.test.yaml");
  let content = readFileSync(base, "utf-8");

  const version = opts.version ?? "dag";

  // Patch contextEngine.version inside agents.default block.
  // If a contextEngine block already exists, replace the version line.
  // Otherwise inject the contextEngine block under agents.default.
  if (/contextEngine:/.test(content)) {
    content = content.replace(/version:\s*\S+/, `version: ${version}`);
  } else {
    content = content.replace(
      /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
      `$1\n    contextEngine:\n      version: ${version}$2`,
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
    `ctx-sum-${opts.label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.yaml`,
  );
  writeFileSync(outPath, content, "utf-8");
  return outPath;
}

// ---------------------------------------------------------------------------
// Stage-A — summarization matrix structure (no COMIS_LIVE)
// ---------------------------------------------------------------------------

describe("CTX-02 Stage-A — summarization matrix structure (no COMIS_LIVE)", () => {
  it("SUMMARIZATION_MATRIX covers contextThreshold{0.4,0.6}", () => {
    expect(SUMMARIZATION_MATRIX.length).toBeGreaterThanOrEqual(2);
    const thresholds = SUMMARIZATION_MATRIX.map((m) => m.threshold);
    expect(thresholds).toContain(0.4);
    expect(thresholds).toContain(0.6);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real-LLM leaf summarization (COMIS_LIVE only)
// ---------------------------------------------------------------------------

// costTier: "¢¢" — Anthropic Haiku, 20 turns per combo, 2 combos
describe.skipIf(!isLive)("Live — CTX-02 summarization (Stage-C)", () => {
  const registry = buildCredentialRegistry();
  const canRun = registry.getSkipVerdict("LLM(anthropic)") === null;

  it.skipIf(!canRun).each(SUMMARIZATION_MATRIX)(
    "contextThreshold=$threshold label=$label",
    async ({ threshold, label }) => {
      const configPath = buildCtxConfig({ version: "dag", contextThreshold: threshold, label });
      const driver = new ConversationDriver({
        agentId: `ctx-sum-${label}`,
        provider: "anthropic",
        timeoutMs: 5 * 60_000,
        configPath,
      });
      await driver.init();

      const dbPath = join(driver.getDataDir(), "memory.db");

      // Snapshot lcd_summaries BEFORE — manual >= check (not runDbOracle exact delta).
      // We assert only the summaries table; lcd_messages is intentionally omitted
      // because runDbOracle enforces EXACT equality and the count is non-deterministic
      // across tool-use/retry turns.
      const LCD_TABLES = ["lcd_summaries", "lcd_context_items"];
      const beforeCounts = existsSync(dbPath) ? snapshotRowCounts(dbPath, LCD_TABLES) : {};

      try {
        // Drive 20 short turns — fills context to trigger leaf summarization.
        for (let i = 0; i < 20; i++) {
          await driver.sendTurn(
            `Turn ${i}: acknowledge this note and add one original thought about AI systems.`,
          );
        }
        await flushDaemonLogs(driver);

        // CTX-02: leaf summarization must have fired — assert via capturedEvents().
        // assertO1MetricsNonZero throws if no context:dag_compacted has
        // leafSummariesCreated > 0 AND no context:evicted has evictedCount > 0.
        const events = driver.capturedEvents();
        assertO1MetricsNonZero(events);

        // FND-10 log-oracle — no unexpected ERROR/FATAL in a successful live run.
        await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });

        // FND-11: persistence oracle — structural integrity checks only
        // (integrity_check, foreign_key_check, Zod row validation).
        // lcd_messages exact delta is NOT asserted — the oracle enforces exact
        // equality and tool-use/retry turns make the count non-deterministic.
        if (existsSync(dbPath)) {
          await runDbOracle(dbPath, {});
        }

        // FND-11: lcd_summaries >= 1 — manual delta check (>= semantics).
        // We need at least one leaf summary row to have been written.
        if (existsSync(dbPath) && beforeCounts["lcd_summaries"] !== undefined) {
          const afterCounts = snapshotRowCounts(dbPath, ["lcd_summaries"]);
          const summariesDelta =
            (afterCounts["lcd_summaries"] ?? 0) - (beforeCounts["lcd_summaries"] ?? 0);
          expect(
            summariesDelta,
            `lcd_summaries delta must be >= 1 after 20 turns with contextThreshold=${threshold}`,
          ).toBeGreaterThanOrEqual(1);
        } else if (existsSync(dbPath)) {
          // DB exists but lcd_summaries had no prior rows — check current count.
          const afterCounts = snapshotRowCounts(dbPath, ["lcd_summaries"]);
          const summariesCount = afterCounts["lcd_summaries"] ?? 0;
          expect(
            summariesCount,
            `lcd_summaries count must be >= 1 after 20 turns with contextThreshold=${threshold}`,
          ).toBeGreaterThanOrEqual(1);
        }
      } finally {
        await driver.close().catch(() => {
          // Swallow shutdown noise — the daemon may already have exited.
        });
        // IN-01: clean up per-combo temp config to avoid tmpdir bloat.
        try { rmSync(configPath); } catch { /* ignore if already gone */ }
      }
    },
    6 * 60_000,
  );
});
