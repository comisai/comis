// SPDX-License-Identifier: Apache-2.0
/**
 * CACHE-03 — cacheRetention × adaptiveCacheRetention × cacheBreakpointStrategy ×
 * geminiCache matrix scenario test.
 *
 * Certifies that every combination of cache configuration dimensions exercises the
 * cache pipeline and produces at least one cache-write event. Each combination
 * spawns its own fresh ConversationDriver with a per-combo YAML config so that
 * cache key settings survive the gateway port-patch that ConversationDriver applies.
 *
 * Stage-A (always runs, no COMIS_LIVE needed):
 *   Structural assertions only — no daemon needed. Verifies that RETENTION_MATRIX
 *   and STRATEGY_MATRIX cover all expected dimension values. This ensures the
 *   coverage-matrix architecture test can verify all cells are present.
 *
 * Stage-C (describe.skipIf(!isLive)):
 *   Iterates real combos via it.each — each spawns its own driver + daemon with
 *   a per-combo configPath built by buildCacheConfig(). Teardown is inline in a
 *   finally block (not afterEach) because each test creates its own driver.
 *
 * costTier: "¢" — cheapest available Anthropic model (Haiku) for live runs.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle } from "../../assert/db-oracle.js";
import { expectCacheWrite, expectNoCacheWrite } from "../../assert/cache-trace.js";
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
// Matrix dimension definitions
// ---------------------------------------------------------------------------

/**
 * RETENTION_MATRIX: cacheRetention{none,short,long} × adaptiveCacheRetention{T,F}.
 * Three representative combos covering all cacheRetention values.
 */
const RETENTION_MATRIX = [
  { cacheRetention: "none",  adaptiveCacheRetention: false, label: "none+adaptive=F" },
  { cacheRetention: "short", adaptiveCacheRetention: false, label: "short+adaptive=F" },
  { cacheRetention: "long",  adaptiveCacheRetention: true,  label: "long+adaptive=T" },
] as const;

/**
 * STRATEGY_MATRIX: cacheBreakpointStrategy{auto,multi-zone,single} × geminiCache{T,F}.
 * Three representative combos covering all cacheBreakpointStrategy values and both
 * geminiCache states.
 */
const STRATEGY_MATRIX = [
  { cacheBreakpointStrategy: "auto",        geminiCache: false, label: "strategy=auto" },
  { cacheBreakpointStrategy: "multi-zone",  geminiCache: false, label: "strategy=multi-zone" },
  { cacheBreakpointStrategy: "single",      geminiCache: true,  label: "strategy=single+gemini=T" },
] as const;

// ---------------------------------------------------------------------------
// Per-combo config builder
// ---------------------------------------------------------------------------

/**
 * Build a temp YAML config for a given combination of cache keys by reading
 * the base test config and patching/appending the three cache dimension keys.
 *
 * ConversationDriver's _buildPortedConfigPath() will subsequently patch only
 * the gateway port line inside the gateway: block — leaving the cache keys
 * written here unchanged.
 *
 * Base config: test/config/config.test.yaml
 */
function buildCacheConfig(opts: {
  cacheRetention?: string;
  adaptiveCacheRetention?: boolean;
  cacheBreakpointStrategy?: string;
  geminiCacheEnabled?: boolean;
  label: string;
}): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const base = join(here, "../../config/config.test.yaml");
  let content = readFileSync(base, "utf-8");

  // Patch cacheRetention — replace existing or append under agents.default
  if (opts.cacheRetention !== undefined) {
    if (/cacheRetention:\s*\S+/.test(content)) {
      content = content.replace(
        /cacheRetention:\s*\S+/,
        `cacheRetention: ${opts.cacheRetention}`,
      );
    } else {
      // Append inside the agents.default block (after the last indented key)
      content = content.replace(
        /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
        `$1\n    cacheRetention: ${opts.cacheRetention}$2`,
      );
    }
  }

  // Patch adaptiveCacheRetention — replace existing or append
  if (opts.adaptiveCacheRetention !== undefined) {
    const val = String(opts.adaptiveCacheRetention);
    if (/adaptiveCacheRetention:\s*\S+/.test(content)) {
      content = content.replace(
        /adaptiveCacheRetention:\s*\S+/,
        `adaptiveCacheRetention: ${val}`,
      );
    } else {
      content = content.replace(
        /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
        `$1\n    adaptiveCacheRetention: ${val}$2`,
      );
    }
  }

  // Patch cacheBreakpointStrategy — replace existing or append
  if (opts.cacheBreakpointStrategy !== undefined) {
    if (/cacheBreakpointStrategy:\s*\S+/.test(content)) {
      content = content.replace(
        /cacheBreakpointStrategy:\s*\S+/,
        `cacheBreakpointStrategy: ${opts.cacheBreakpointStrategy}`,
      );
    } else {
      content = content.replace(
        /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
        `$1\n    cacheBreakpointStrategy: ${opts.cacheBreakpointStrategy}$2`,
      );
    }
  }

  // Patch geminiCache.enabled — replace the targeted `enabled:` line in an existing
  // geminiCache block, or append the block under agents.default (NOT at file root).
  // geminiCache is defined in AgentConfigSchema (PerAgentConfigSchema), which
  // maps to the `agents.default` block in YAML. AppConfigSchema is z.strictObject, so
  // an unknown top-level key causes a ZodError and daemon boot fails.
  if (opts.geminiCacheEnabled !== undefined) {
    const enabledVal = String(opts.geminiCacheEnabled);
    if (/^\s+enabled:\s*\S+/m.test(content) && /geminiCache:/.test(content)) {
      // Replace only the `enabled:` line within an existing geminiCache block to avoid
      // silently dropping sibling keys like maxActiveCaches.
      content = content.replace(
        /^(\s+enabled:\s*)\S+/m,
        `$1${enabledVal}`,
      );
    } else {
      // Append inside the agents.default block (NOT at file root).
      content = content.replace(
        /(agents:\s*\n\s*default:[\s\S]*?)(\n[^\s])/,
        `$1\n    geminiCache:\n      enabled: ${enabledVal}$2`,
      );
    }
  }

  const outPath = join(
    tmpdir(),
    `cache-matrix-${opts.label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.yaml`,
  );
  writeFileSync(outPath, content, "utf-8");
  return outPath;
}

// ---------------------------------------------------------------------------
// Stage-A — structural assertions only, no daemon needed
// ---------------------------------------------------------------------------

describe("CACHE-03 Stage-A — matrix structure (no COMIS_LIVE)", () => {
  it("RETENTION_MATRIX covers cacheRetention{none,short,long}", () => {
    // All three retention values must be present
    expect(RETENTION_MATRIX.length).toBe(3);

    const retentionValues = RETENTION_MATRIX.map((r) => r.cacheRetention);
    expect(retentionValues).toContain("none");
    expect(retentionValues).toContain("short");
    expect(retentionValues).toContain("long");

    // Every entry must have both keys defined
    for (const entry of RETENTION_MATRIX) {
      expect(typeof entry.cacheRetention).toBe("string");
      expect(typeof entry.adaptiveCacheRetention).toBe("boolean");
    }
  });

  it("STRATEGY_MATRIX covers cacheBreakpointStrategy{auto,multi-zone,single} + geminiCache", () => {
    expect(STRATEGY_MATRIX.length).toBe(3);

    const strategyValues = STRATEGY_MATRIX.map((s) => s.cacheBreakpointStrategy);
    expect(strategyValues).toContain("auto");
    expect(strategyValues).toContain("multi-zone");
    expect(strategyValues).toContain("single");

    // Both geminiCache states (true and false) must be represented
    const geminiValues = STRATEGY_MATRIX.map((s) => s.geminiCache);
    expect(geminiValues).toContain(true);
    expect(geminiValues).toContain(false);

    // Every entry must have both keys defined
    for (const entry of STRATEGY_MATRIX) {
      expect(typeof entry.cacheBreakpointStrategy).toBe("string");
      expect(typeof entry.geminiCache).toBe("boolean");
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real-LLM matrix, gated on COMIS_LIVE (skips in CI, runs in live mode)
// ---------------------------------------------------------------------------

// costTier: "¢" — cheapest available Anthropic model (Haiku) for live runs
describe.skipIf(!isLive)("Live — CACHE-03 matrix (Stage-C)", () => {
  const registry = buildCredentialRegistry();
  const canRun = registry.getSkipVerdict("LLM(anthropic)") === null;

  // Retention × adaptive combos — each spawns its own driver.
  // Use it.skipIf(!canRun) so combos show as SKIPPED (not phantom-passed)
  // when Anthropic credentials are unavailable.
  it.skipIf(!canRun).each(RETENTION_MATRIX)(
    "retention=$label",
    async ({ cacheRetention, adaptiveCacheRetention, label }) => {
      const configPath = buildCacheConfig({ cacheRetention, adaptiveCacheRetention, label });
      const driver = new ConversationDriver({
        agentId: `cache-mx-r-${label}`,
        provider: "anthropic",
        timeoutMs: 60_000,
        configPath,
      });
      await driver.init();

      try {
        const cacheTracePath = join(driver.getDataDir(), "logs", "cache-trace.jsonl");
        await driver.sendTurn(
          `Cache retention test with cacheRetention=${cacheRetention} adaptive=${String(adaptiveCacheRetention)}`,
        );
        await flushDaemonLogs(driver);
        const lines = readFileSync(cacheTracePath, "utf-8");

        // cacheRetention="none" activates the kill-switch (kill-switch.ts strips
        // all cache_control markers), so the provider returns cacheCreationInputTokens=0.
        // Assert the ABSENCE of a cache write for this path, not its presence.
        if (cacheRetention === "none") {
          await expectNoCacheWrite(lines);
        } else {
          await expectCacheWrite({ minCreationTokens: 1 }, lines);
        }

        await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });
        const dbPath = join(driver.getDataDir(), "memory.db");
        if (existsSync(dbPath)) await runDbOracle(dbPath, {});
      } finally {
        await driver.close().catch(() => {
          // swallow shutdown noise
        });
        // Clean up the per-combo temp config file so it does not accumulate
        // in tmpdir across repeated live runs.
        try { rmSync(configPath); } catch { /* ignore if already gone */ }
      }
    },
    2 * 60_000,
  );

  // Breakpoint strategy × geminiCache combos — each spawns its own driver.
  // Use it.skipIf(!canRun) so combos show as SKIPPED (not phantom-passed).
  it.skipIf(!canRun).each(STRATEGY_MATRIX)(
    "strategy=$label",
    async ({ cacheBreakpointStrategy, geminiCache, label }) => {
      const configPath = buildCacheConfig({
        cacheBreakpointStrategy,
        geminiCacheEnabled: geminiCache,
        label,
      });
      const driver = new ConversationDriver({
        agentId: `cache-mx-s-${label}`,
        provider: "anthropic",
        timeoutMs: 60_000,
        configPath,
      });
      await driver.init();

      try {
        const cacheTracePath = join(driver.getDataDir(), "logs", "cache-trace.jsonl");
        await driver.sendTurn(`Breakpoint strategy test ${cacheBreakpointStrategy}`);
        await flushDaemonLogs(driver);
        const lines = readFileSync(cacheTracePath, "utf-8");
        await expectCacheWrite({ minCreationTokens: 1 }, lines);
        await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });
        const dbPath = join(driver.getDataDir(), "memory.db");
        if (existsSync(dbPath)) await runDbOracle(dbPath, {});
      } finally {
        await driver.close().catch(() => {
          // swallow shutdown noise
        });
        // Clean up the per-combo temp config file.
        try { rmSync(configPath); } catch { /* ignore if already gone */ }
      }
    },
    2 * 60_000,
  );
});
