// SPDX-License-Identifier: Apache-2.0
/**
 * CTX-04 — ctx_search/ctx_inspect/ctx_expand expansion loop.
 *
 * Stage-A (always runs — no COMIS_LIVE, no daemon):
 *   Structural: EXPANSION_TOOL_MATRIX covers ctx_search, ctx_inspect, ctx_expand.
 *
 * Stage-C (describe.skipIf(!isLive)):
 *   Phase 1: drives enough turns to trigger compaction (contextThreshold=0.4).
 *   Phase 2: sends a follow-up turn asking the model to use the expansion tool.
 *   Asserts:
 *     - context:dag_expanded event fires with tool in {ctx_search, ctx_inspect, ctx_expand}
 *       and recoveredCount > 0 — via driver.capturedEvents()
 *     - lcd_summaries delta >= 1 (FND-11 — compaction pre-condition happened)
 *   lcd_messages exact delta is NOT asserted — runDbOracle enforces exact equality
 *   and a hardcoded count false-fails on tool-use/retry turns.
 *
 * costTier: "¢¢" — Anthropic Haiku, 15+1 turns per combo.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle, snapshotRowCounts } from "../../assert/db-oracle.js";
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
// Expansion tool matrix — covers ctx_search, ctx_inspect, ctx_expand
// ---------------------------------------------------------------------------

const EXPANSION_TOOL_MATRIX = [
  { tool: "ctx_search",  label: "ctx-search" },
  { tool: "ctx_inspect", label: "ctx-inspect" },
  { tool: "ctx_expand",  label: "ctx-expand" },
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
    `ctx-exp-${opts.label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.yaml`,
  );
  writeFileSync(outPath, content, "utf-8");
  return outPath;
}

// ---------------------------------------------------------------------------
// Stage-A — expansion matrix structure (no COMIS_LIVE)
// ---------------------------------------------------------------------------

describe("CTX-04 Stage-A — expansion matrix structure (no COMIS_LIVE)", () => {
  it("EXPANSION_TOOL_MATRIX covers ctx_search, ctx_inspect, ctx_expand", () => {
    const tools = EXPANSION_TOOL_MATRIX.map((m) => m.tool);
    expect(tools).toContain("ctx_search");
    expect(tools).toContain("ctx_inspect");
    expect(tools).toContain("ctx_expand");
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real-LLM expansion loop (COMIS_LIVE only)
// ---------------------------------------------------------------------------

// costTier: "¢¢" — Anthropic Haiku, 15+1 turns per combo, 3 combos
describe.skipIf(!isLive)("Live — CTX-04 expansion loop (Stage-C)", () => {
  const registry = buildCredentialRegistry();
  const canRun = registry.getSkipVerdict("LLM(anthropic)") === null;

  it.skipIf(!canRun).each(EXPANSION_TOOL_MATRIX)(
    "expansion tool=$label",
    async ({ tool, label }) => {
      // Low contextThreshold to force quick compaction (15 turns at 0.4 threshold).
      const configPath = buildCtxConfig({ version: "dag", contextThreshold: 0.4, label: `exp-${label}` });
      const driver = new ConversationDriver({
        agentId: `ctx-exp-${label}`,
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
      const beforeCounts = existsSync(dbPath) ? snapshotRowCounts(dbPath, ["lcd_summaries"]) : {};

      try {
        // Phase 1: fill context to trigger compaction.
        for (let i = 0; i < 15; i++) {
          await driver.sendTurn(
            `Note ${i}: remember that we discussed topic-${i} about advanced AI reasoning.`,
          );
        }

        // Phase 2: ask model to use the expansion tool to recover earlier context.
        // The expansion tools (ctx_search/ctx_inspect/ctx_expand) are registered in
        // DAG mode by the context engine and surfaced to the model as callable tools.
        const reply = await driver.sendTurn(
          `Please use the ${tool} tool to recover details from our early conversation about topic-0.`,
        );
        expect(reply.length).toBeGreaterThan(0);

        await flushDaemonLogs(driver);

        // CTX-04: context:dag_expanded must have fired — read from capturedEvents().
        // The event payload carries: tool, recoveredCount, durationMs, timestamp.
        // T-138-03-03: ctx_expand has an internal loop-guard + hop cap per context-engine.ts
        // so this assertion should never hang.
        const events = driver.capturedEvents();
        const expandEvent = events.find(
          (e) =>
            e.name === "context:dag_expanded" &&
            ["ctx_search", "ctx_inspect", "ctx_expand"].includes(
              (e.payload as { tool?: string })?.tool ?? "",
            ),
        );

        expect(
          expandEvent,
          "context:dag_expanded event must fire when expansion tool is invoked",
        ).toBeDefined();

        const recoveredCount = (expandEvent!.payload as { recoveredCount: number }).recoveredCount;
        expect(recoveredCount, "recoveredCount must be > 0").toBeGreaterThan(0);

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
        // Phase 1 compaction must have written at least one leaf summary row.
        if (existsSync(dbPath) && beforeCounts["lcd_summaries"] !== undefined) {
          const afterCounts = snapshotRowCounts(dbPath, ["lcd_summaries"]);
          const summariesDelta =
            (afterCounts["lcd_summaries"] ?? 0) - (beforeCounts["lcd_summaries"] ?? 0);
          expect(
            summariesDelta,
            `lcd_summaries delta must be >= 1 after Phase 1 compaction with contextThreshold=0.4`,
          ).toBeGreaterThanOrEqual(1);
        } else if (existsSync(dbPath)) {
          // DB exists but lcd_summaries had no prior rows — check current count.
          const afterCounts = snapshotRowCounts(dbPath, ["lcd_summaries"]);
          const summariesCount = afterCounts["lcd_summaries"] ?? 0;
          expect(
            summariesCount,
            `lcd_summaries count must be >= 1 after Phase 1 compaction with contextThreshold=0.4`,
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
    7 * 60_000,
  );
});
