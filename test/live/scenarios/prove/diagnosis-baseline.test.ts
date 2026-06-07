// SPDX-License-Identifier: Apache-2.0
/**
 * DIAG-baseline (Phase 149 — PROVE: LLM-diagnosis baseline harness, M1 + M2).
 *
 * The measure-first GATE for phases 150-155. Two tiers, the established
 * Stage-A/B-vs-Stage-C split (mirrors obs-meta.test.ts:47/56/236):
 *
 *   Stage-A/B (ALWAYS-ON, KEYLESS — runs in `pnpm validate`): the deterministic
 *     substrate. Proves the Plan-01 scorers (loadFixture / recordMetrics /
 *     compareToAnswerKey) and the Plan-03 gating render are correct END-TO-END
 *     over the real frozen 5-fixture corpus (Plan 02). NO COMIS_LIVE, NO daemon,
 *     NO token — so the gate stays green with no API key (success criterion #4,
 *     RESEARCH.md Pitfall 2).
 *
 *   Stage-C (COMIS_LIVE-gated, `it.skip`, NEVER in `pnpm validate`): the actual
 *     baseline RUN — a fresh SCRIPTED ReAct agent diagnoses each fixture on
 *     today's obs surface (the 4-action obs_query tool over a fixture-backed RPC
 *     stub + a COUNTED read_source tool), recording per fixture (rootCauseReached?,
 *     totalTokens, distinctToolCalls, distinctSourceReads). Expected to FAIL the
 *     goal today (source reads > 0, multi-call, high tokens). Writes the gating
 *     report + ledger to the git-ignored benchmarks/ dir. SKIPS cleanly with no
 *     key (skip != fail). Added in Task 3.
 *
 * NO new env var: reuses COMIS_LIVE / COMIS_LIVE_BUDGET_USD / COMIS_LIVE_JUDGE_*
 * (all already in docs/reference/environment-variables.mdx). costTier: "dollar".
 *
 * Run keyless (Stage-A/B green, Stage-C skipped):
 *   pnpm vitest run --config test/live/vitest.config.ts \
 *     test/live/scenarios/prove/diagnosis-baseline.test.ts
 *
 * @module
 */

// NOTE: Stage-C (Task 3) adds the imports it needs at the anchor below
// (writeFileSync, resolve, makeReadSourceTool, CostGovernor, judgeAnswer,
// writeLedger/LiveTestReport, createObsQueryTool). Stage-A/B imports only the
// scorers + gating render + the secret sweep it exercises.
import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadFixture,
  recordMetrics,
  compareToAnswerKey,
  type AgentTurn,
  type AnswerKey,
  type DiagnosisFailureClass,
  type DiagnosisVerdictRow,
} from "../../support/diagnosis-harness.js";
import { assertNoSecrets } from "../../cost.js";
import { buildGatingTable, renderGatingMarkdown } from "../../support/diagnosis-gating-report.js";

const isLive = !!process.env["COMIS_LIVE"];

// fileURLToPath(import.meta.url) is robust across vitest pool modes (the
// document-extraction.test.ts:39 idiom) — preferred over a bare __dirname.
const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirnameLocal, "../../fixtures/diagnosis");

/** The 5 frozen diagnosis fixtures (Plan 02). */
const FIXTURE_IDS = [
  "session-678314278",
  "live-503-breaker",
  "live-exec-modulenotfound",
  "live-budget-exhaustion",
  "live-provider-timeout",
] as const;
type FixtureId = (typeof FIXTURE_IDS)[number];

/** Map each fixture id to its closed failure class (Plan 02 corpus table). */
const FAILURE_CLASS: Record<FixtureId, DiagnosisFailureClass> = {
  "session-678314278": "historical-c53ab0f",
  "live-503-breaker": "503-breaker",
  "live-exec-modulenotfound": "exec-modulenotfound",
  "live-budget-exhaustion": "budget-exhaustion",
  "live-provider-timeout": "provider-timeout",
};

// ===========================================================================
// Stage-A/B — the always-on, keyless substrate (runs in pnpm validate).
//   Proves the Plan-01 scorers + the gating render are correct over the REAL
//   frozen corpus. No COMIS_LIVE, no daemon, no live token.
// ===========================================================================

describe("DIAG-baseline substrate — every fixture loads and is well-formed", () => {
  it("loadFixture returns a well-formed bundle for all 5 diagnosis fixtures", () => {
    for (const id of FIXTURE_IDS) {
      const fx = loadFixture(join(FIXTURES_DIR, id));
      expect(fx.events.length, `${id} events`).toBeGreaterThan(0);
      expect(fx.meta.endReason, `${id} endReason`).toBeTruthy();
      expect(fx.answerKey.rootCause, `${id} rootCause`).toBeTruthy();
      expect(fx.answerKey.mechanismTokens.length, `${id} mechanismTokens`).toBeGreaterThan(0);
    }
  });

  it("the historical session fixture carries the completed_with_tool_errors degraded signal", () => {
    const fx = loadFixture(join(FIXTURES_DIR, "session-678314278"));
    expect(fx.meta.endReason).toBe("completed_with_tool_errors");
    // 534 NDJSON events extracted from daemon.1.log lines 95-628 (Plan 02).
    expect(fx.events.length).toBeGreaterThan(400);
  });
});

describe("DIAG-baseline substrate — recordMetrics counts tokens, distinct calls, source reads", () => {
  it("recordMetrics counts distinct tool calls and source reads from a synthetic diagnosis transcript", () => {
    // A synthetic transcript: obs_query x2 (1 distinct tool) + read_source(a),
    // read_source(b), read_source(a) (2 distinct paths), usage on assistant turns.
    const transcript: AgentTurn[] = [
      {
        role: "assistant",
        toolCalls: [{ name: "obs_query", arguments: JSON.stringify({ action: "diagnostics" }) }],
        usage: { totalTokens: 1200 },
      },
      {
        role: "assistant",
        toolCalls: [{ name: "obs_query", arguments: JSON.stringify({ action: "billing" }) }],
        usage: { promptTokens: 800, completionTokens: 200 },
      },
      {
        role: "assistant",
        toolCalls: [
          { name: "read_source", arguments: JSON.stringify({ path: "packages/agent/src/bridge/pi-event-bridge.ts" }) },
          { name: "read_source", arguments: JSON.stringify({ path: "packages/agent/src/tool-retry-breaker.ts" }) },
          { name: "read_source", arguments: JSON.stringify({ path: "packages/agent/src/bridge/pi-event-bridge.ts" }) },
        ],
        usage: { totalTokens: 3000 },
      },
    ];
    const m = recordMetrics(transcript);
    // obs_query + read_source = 2 distinct tool names.
    expect(m.distinctToolCalls).toBe(2);
    // pi-event-bridge.ts + tool-retry-breaker.ts = 2 distinct source paths.
    expect(m.distinctSourceReads).toBe(2);
    // 1200 + (800+200) + 3000 = 5200.
    expect(m.totalTokens).toBe(5200);
  });
});

describe("DIAG-baseline substrate — compareToAnswerKey requires the causal mechanism", () => {
  it("a symptom-only answer does not reach the historical root cause but the mechanism answer does", () => {
    const fx = loadFixture(join(FIXTURES_DIR, "session-678314278"));
    const ak: AnswerKey = fx.answerKey;
    // Symptom-only — does NOT contain the mechanism tokens (substring/403/status/breaker).
    expect(compareToAnswerKey("web_fetch failed many times", ak).reached).toBe(false);
    // Build the positive answer by joining the frozen mechanism tokens so this
    // test stays in lockstep with the answer-key (no hard-coded mechanism prose).
    const mechanismAnswer = `the root cause: ${ak.mechanismTokens.join(" ")} cascade`;
    expect(compareToAnswerKey(mechanismAnswer, ak).reached).toBe(true);
  });

  it("each gold rootCause reaches its own answer-key while a bare symptom string does not, for every fixture", () => {
    // The measure-first lever across the WHOLE corpus (RESEARCH.md Pitfall 4):
    // the frozen gold rootCause must satisfy its own mechanism tokens, and a
    // mechanism-free symptom string must NOT — guaranteeing the Stage-C baseline
    // only scores "reached" when the causal mechanism is present.
    for (const id of FIXTURE_IDS) {
      const ak = loadFixture(join(FIXTURES_DIR, id)).answerKey;
      expect(compareToAnswerKey(ak.rootCause, ak).reached, `${id} gold reaches own key`).toBe(true);
      // A symptom-free placeholder cannot contain the mechanism tokens.
      expect(compareToAnswerKey("the session was degraded", ak).reached, `${id} symptom-only`).toBe(
        false,
      );
    }
  });
});

describe("DIAG-baseline substrate — the verdict row + gating table serialize and pass the secret sweep", () => {
  it("a DiagnosisVerdictRow set and the rendered gating table pass assertNoSecrets", () => {
    // One row per class, mixed reached/skip — the shape the Stage-C run builds.
    const rows: DiagnosisVerdictRow[] = FIXTURE_IDS.map((id, i) => ({
      fixtureId: id,
      failureClass: FAILURE_CLASS[id],
      rootCauseReached: i === 0 ? ("skip" as const) : i % 2 === 0,
      totalTokens: 1000 * (i + 1),
      distinctToolCalls: i,
      distinctSourceReads: i === 0 ? 0 : i,
      judgeVerdict: i === 0 ? ("skip" as const) : i % 2 === 0 ? ("pass" as const) : ("fail" as const),
      surfacesUsed: i === 0 ? [] : ["obs.diagnostics", `packages/agent/src/file-${i}.ts`],
    }));
    expect(() => assertNoSecrets(JSON.stringify(rows), "rows")).not.toThrow();

    const md = renderGatingMarkdown(buildGatingTable(rows));
    expect(md).toMatch(/TRIM|BUILD|INCONCLUSIVE/);
    expect(() => assertNoSecrets(md, "gating table")).not.toThrow();
  });
});

// =========================================================================
// === Stage-C added in Task 3 ===
// =========================================================================
