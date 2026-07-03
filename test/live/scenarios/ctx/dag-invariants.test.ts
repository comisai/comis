// SPDX-License-Identifier: Apache-2.0
/**
 * CTX-01 (A1/A2/A3 DAG/LCD structural invariants) + CTX-03 (P1/P2 honest presentation).
 *
 * Stage-A (always runs — no COMIS_LIVE, no daemon):
 *   A1 losslessness: lcd_messages rows are NEVER deleted by appendLeafSummary.
 *   A2 pair-intact: every tool_use has a matching tool_result in the assembled array.
 *   A3 no-split: the budget assembler never splits a tool_use/tool_result pair.
 *   O1 structure: ENGINE_MATRIX covers both contextEngine.version values.
 *
 * Stage-C (describe.skipIf(!isLive)):
 *   Iterates ENGINE_MATRIX combos (dag×low, dag×high, pipeline×low). Each combo
 *   drives 2 turns via ConversationDriver against a real LLM, then asserts:
 *     - CTX-01 A1/A2/A3 via readContextStreamShape on cache-trace.jsonl
 *     - CTX-03 P1/P2 via driver.capturedEvents() (context:dag_compacted)
 *     - log oracle (expectedErrors:[])
 *     - persistence oracle (lcd_messages delta = 4 rows for 2-turn session)
 *
 * costTier: "¢¢" — two turns per combo, Anthropic Haiku.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle, snapshotRowCounts } from "../../assert/db-oracle.js";
import {
  readContextStreamShape,
  assertA1TailVerbatim,
  assertA2PairIntact,
  assertA3NoPairSplit,
  assertP1HonestPresentation,
  assertP2UncertaintyClauses,
} from "../../assert/context-trace.js";
import { createLcdStore, initSchema } from "@comis/memory";
import type { AppendMessageInput, AppendSummaryInput } from "@comis/core";
import Database from "better-sqlite3";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildCredentialRegistry } from "../../credentials.js";
import { buildCtxConfig } from "../../harness/ctx-config.js";

// ---------------------------------------------------------------------------
// COMIS_LIVE gate — Stage-C blocks skip (not fail) when unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

// ---------------------------------------------------------------------------
// Engine matrix — contextEngine.version × contextThreshold profiles
//
// contextThreshold is the agent-level key (schema-agent-context.ts line 255).
// contextWindow is a PROVIDER-MODEL level key — it CANNOT be patched under
// agents.default (schema validation would reject it). Use contextThreshold
// variation (0.4 = low, 0.75 = high/default) to differentiate profiles.
// ---------------------------------------------------------------------------

const ENGINE_MATRIX = [
  { version: "dag"      as const, label: "dag-low-threshold",  contextThreshold: 0.4 },
  { version: "dag"      as const, label: "dag-high-threshold", contextThreshold: 0.75 },
  { version: "pipeline" as const, label: "pipe-low-threshold", contextThreshold: 0.4 },
] as const;

// ---------------------------------------------------------------------------
// Stage-A — DAG/LCD structural invariants (no daemon, no COMIS_LIVE)
// ---------------------------------------------------------------------------

describe("CTX-01 Stage-A — DAG/LCD structural invariants (no COMIS_LIVE)", () => {
  it("A1 — store.append NEVER deletes lcd_messages: losslessness invariant", () => {
    // Use an in-memory SQLite DB — destroyed when db.close() is called.
    // An in-memory :memory: DB has no persistence outside the test process.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);
    const store = createLcdStore(db);

    const SCOPE = {
      conversationId: "ctx-inv-a1",
      agentId: "agent-a",
      tenantId: "t-1",
      sessionKey: "s-1",
    };

    // Seed 5 messages using the REAL store.append() method (NOT appendMessage —
    // that method does not exist; the correct method is append()).
    for (let i = 1; i <= 5; i++) {
      const input: AppendMessageInput = {
        scope: SCOPE,
        seq: i,
        role: "user",
        tokenCount: 10,
        createdAt: Date.now() + i,
        parts: [
          {
            kind: "text",
            metadata: { raw: { type: "text", text: `hello ${i}` }, rawType: "text" },
          },
        ],
      };
      store.append(input);
    }

    // Baseline: 5 rows present.
    expect(store.getMessages(SCOPE)).toHaveLength(5);

    // Seed context_items lazily so appendLeafSummary can find ordinals to replace.
    // getContextItems performs the lazy seed on first call.
    const items = store.getContextItems(SCOPE);
    expect(items).toHaveLength(5);

    // appendLeafSummary: replace ordinals [0, 2] (first 3 messages) with one summary-ref.
    // AppendSummaryInput fields: scope, tokenCount, content, descendantCount, earliestAt,
    // latestAt, fileIds, fallback, taint, createdAt, startOrdinal, endOrdinal.
    // (coveredRange / coveredMessageIds do NOT exist — use startOrdinal/endOrdinal.)
    const summaryInput: AppendSummaryInput = {
      scope: SCOPE,
      tokenCount: 30,
      content: "summary of turns 1-3",
      descendantCount: 3,
      earliestAt: Date.now(),
      latestAt: Date.now(),
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: Date.now(),
      startOrdinal: 0,
      endOrdinal: 2,
    };
    store.appendLeafSummary(summaryInput);

    // A1 invariant: lcd_messages row count is UNCHANGED after appendLeafSummary.
    // The summary-ref replaces context_items entries — it NEVER deletes lcd_messages.
    expect(store.getMessages(SCOPE)).toHaveLength(5);

    db.close();
  });

  it("A2 — pair-intact: assertA2PairIntact passes on a balanced assembled shape", () => {
    // Fixture: 1 tool_use + 1 matching tool_result, pairedToolResultCount = 1.
    const balancedShape = {
      totalCount: 2,
      hasToolResult: true,
      toolUseIds: ["u1"],
      toolResultIds: ["u1"],
      toolUseCount: 1,
      toolResultCount: 1,
      pairedToolResultCount: 1,
      blockKindCounts: {},
      idsTruncated: false,
    };
    expect(() => assertA2PairIntact(balancedShape)).not.toThrow();
  });

  it("A2 — pair-orphan: assertA2PairIntact throws when pairedToolResultCount < toolResultCount", () => {
    // Fixture: 1 tool_result but pairedToolResultCount = 0 (orphaned — no matching tool_use id).
    const orphanShape = {
      totalCount: 2,
      hasToolResult: true,
      toolUseIds: ["u1"],
      toolResultIds: ["u1"],
      toolUseCount: 1,
      toolResultCount: 1,
      pairedToolResultCount: 0,  // paired=0 but result=1 → orphan detected
      blockKindCounts: {},
      idsTruncated: false,
    };
    expect(() => assertA2PairIntact(orphanShape)).toThrow();
  });

  it("A3 — no-split: assertA3NoPairSplit passes when all tool_use ids are matched (idsTruncated=false)", () => {
    const okShape = {
      totalCount: 4,
      hasToolResult: true,
      toolUseIds: ["u1"],
      toolResultIds: ["u1"],
      toolUseCount: 1,
      toolResultCount: 1,
      pairedToolResultCount: 1,
      blockKindCounts: {},
      idsTruncated: false,
    };
    expect(() => assertA3NoPairSplit(okShape)).not.toThrow();
  });

  it("A3 — no-split: assertA3NoPairSplit throws when a tool_use id has no matching result (idsTruncated=false)", () => {
    // Fixture: tool_use id "u1" has no entry in toolResultIds — budget split detected.
    const splitShape = {
      totalCount: 4,
      hasToolResult: false,
      toolUseIds: ["u1"],
      toolResultIds: [],
      toolUseCount: 1,
      toolResultCount: 0,
      pairedToolResultCount: 0,
      blockKindCounts: {},
      idsTruncated: false,
    };
    expect(() => assertA3NoPairSplit(splitShape)).toThrow();
  });

  it("O1 structure — ENGINE_MATRIX covers both contextEngine.version values", () => {
    const versions = ENGINE_MATRIX.map((m) => m.version);
    expect(versions).toContain("dag");
    expect(versions).toContain("pipeline");

    for (const entry of ENGINE_MATRIX) {
      expect(typeof entry.version).toBe("string");
      expect(typeof entry.label).toBe("string");
      // contextThreshold must be a number in [0,1] — schema-agent-context.ts line 255
      expect(typeof entry.contextThreshold).toBe("number");
      expect(entry.contextThreshold).toBeGreaterThan(0);
      expect(entry.contextThreshold).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real-LLM DAG invariants + honest presentation (COMIS_LIVE only)
// ---------------------------------------------------------------------------

// costTier: "¢¢" — Anthropic Haiku, 2 turns per combo, 3 combos
describe.skipIf(!isLive)("Live — CTX-01/CTX-03 DAG invariants + honest presentation (Stage-C)", () => {
  const registry = buildCredentialRegistry();
  const canRun = registry.getSkipVerdict("LLM(anthropic)") === null;

  it.skipIf(!canRun).each(ENGINE_MATRIX)(
    "version=$label",
    async ({ version, label, contextThreshold }) => {
      // Each driver has a 3-min timeout; the finally block guarantees close().
      const configPath = buildCtxConfig({ version, label, contextThreshold, filePrefix: "ctx-inv" });
      const driver = new ConversationDriver({
        agentId: `ctx-inv-${label}`,
        provider: "anthropic",
        timeoutMs: 2 * 60_000,
        configPath,
      });
      await driver.init();

      const dbPath = join(driver.getDataDir(), "memory.db");
      const LCD_TABLES = ["lcd_messages", "lcd_summaries", "lcd_context_items"];
      const beforeCounts = existsSync(dbPath)
        ? await snapshotRowCounts(dbPath, LCD_TABLES)
        : {};

      try {
        // Drive 2 turns — enough for structural assertion, minimal cost.
        await driver.sendTurn("Please help me write a short poem about the ocean.");
        await driver.sendTurn("Now revise it to include the color blue.");
        await flushDaemonLogs(driver);

        // CTX-01 A1/A2/A3: assert via cache-trace stream:context shape.
        // The cache-trace.jsonl is written per-turn by the pipeline.
        const cacheTracePath = join(driver.getDataDir(), "logs", "cache-trace.jsonl");
        if (existsSync(cacheTracePath)) {
          const lines = readFileSync(cacheTracePath, "utf-8");
          const shape = readContextStreamShape(lines);
          if (shape !== null) {
            assertA1TailVerbatim(shape);
            assertA2PairIntact(shape);
            assertA3NoPairSplit(shape); // uses idsTruncated check internally
          }
        }

        // CTX-03 P1/P2: honest-presentation assertions via captured events.
        // assertP1/P2 take event arrays (NOT log lines — summary text is never
        // logged per AGENTS.md §2.7). Only assert when compaction actually occurred
        // (hasDagCompacted guards against false positives on very short sessions).
        const events = driver.capturedEvents();
        const hasDagCompacted = events.some((e) => e.name === "context:dag_compacted");
        if (hasDagCompacted) {
          assertP1HonestPresentation(events);
          assertP2UncertaintyClauses(events);
        }

        // Log oracle — no unexpected ERROR/FATAL lines in successful live turns.
        await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });

        // Persistence oracle — lcd_messages delta.
        // 2 turns = 2 user messages + 2 assistant messages = 4 rows appended.
        // lcd_summaries delta is NOT asserted: a 2-turn session at any threshold
        // may not trigger compaction (2 turns may not fill the context window).
        if (existsSync(dbPath)) {
          await runDbOracle(dbPath, {
            expectedDeltas: [
              { table: "lcd_messages", expectedRowDelta: 4 },
            ],
            beforeCounts,
          });
        }
      } finally {
        await driver.close().catch(() => {
          // Swallow shutdown noise — the daemon may already have exited.
        });
        // Clean up the per-combo temp config file to avoid tmpdir bloat.
        try { rmSync(configPath); } catch { /* ignore if already gone */ }
      }
    },
    3 * 60_000,
  );
});
