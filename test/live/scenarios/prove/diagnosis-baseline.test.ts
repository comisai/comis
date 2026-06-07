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

import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadFixture,
  recordMetrics,
  compareToAnswerKey,
  makeReadSourceTool,
  type AgentTurn,
  type AnswerKey,
  type DiagnosisFailureClass,
  type DiagnosisVerdictRow,
} from "../../support/diagnosis-harness.js";
import { CostGovernor, assertNoSecrets } from "../../cost.js";
import { judgeAnswer } from "../../judge.js";
import { writeLedger, type LiveTestReport } from "../../report.js";
import { buildGatingTable, renderGatingMarkdown } from "../../support/diagnosis-gating-report.js";
import { createObsQueryTool, type RpcCall } from "@comis/skills/platform-tools";

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
//   The actual baseline RUN — gated behind COMIS_LIVE, NEVER in `pnpm validate`,
//   NEVER needs a CI key. A fresh SCRIPTED ReAct agent diagnoses each fixture on
//   today's obs surface and records the 4 M2 dimensions per fixture.
// =========================================================================

// ---------------------------------------------------------------------------
// Stage-C helpers (only reached under COMIS_LIVE; pure/total otherwise).
// ---------------------------------------------------------------------------

/** The terminal assistant answer = the last assistant turn's text content. */
function lastAssistantText(transcript: AgentTurn[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i]!;
    if (t.role === "assistant" && typeof t.content === "string" && t.content.length > 0) {
      return t.content;
    }
  }
  return "";
}

/**
 * A FIXTURE-BACKED obs_query RPC stub (the documented wiring choice — see the
 * @module JSDoc). The scripted agent's obs_query calls resolve against the loaded
 * fixture's frozen events, so the RUN measures "can the model reach root cause
 * from today's obs surface" without booting a daemon — only a live MODEL is
 * needed. The stub returns the SAME shape the real obs.* handlers would: a thin
 * projection of the fixture events for the requested action. It is intentionally
 * SHALLOW (today's surface is shallow) — that shallowness is exactly what forces
 * the agent to fall back to read_source, which is the cost we measure.
 */
function makeFixtureBackedRpc(fixtureEvents: Array<Record<string, unknown>>): RpcCall {
  return async (method: string, _params: Record<string, unknown>): Promise<unknown> => {
    // obs_query delegates to obs.* methods; return a fixture projection. The
    // surface carries WHAT failed (counts/categories) but never WHY (the GA1/GA2
    // gap the answer-keys encode) — so a correct mechanism answer is unreachable
    // from this alone, by design.
    const toolFailures = fixtureEvents.filter(
      (e) => typeof e["msg"] === "string" && (e["msg"] as string).includes("Tool execution failed"),
    ).length;
    return {
      method,
      eventCount: fixtureEvents.length,
      toolFailures,
      note: "fixture-backed obs surface projection — records THAT a tool failed, never WHY",
    };
  };
}

/**
 * One scripted ReAct diagnosis loop over ONE fixture, adapting the
 * scripts/bench-small-model/harness.mjs:67-116 token-sum + tool-dispatch idiom.
 * Drives a real model (Ollama/OpenAI-compatible /v1/chat/completions) handed the
 * obs_query 4-action tool + the COUNTED read_source tool; loops model -> tool
 * calls -> feed results -> repeat until the model stops calling tools or maxSteps.
 * Captures the transcript as AgentTurn[] (the recordMetrics input).
 *
 * The model client config is passed in (resolved by the caller from documented
 * env only); this helper introduces NO env read of its own.
 */
async function runDiagnosisLoop(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fixtureEvents: Array<Record<string, unknown>>;
  readSourceImpl: (args: { path: string }) => string;
  maxSteps?: number;
}): Promise<AgentTurn[]> {
  const { baseUrl, apiKey, model, fixtureEvents, readSourceImpl, maxSteps = 8 } = opts;
  const transcript: AgentTurn[] = [];
  const obsRpc = makeFixtureBackedRpc(fixtureEvents);
  const obsTool = createObsQueryTool(obsRpc);

  const systemPrompt =
    "You are diagnosing a degraded Comis session. The session transcript is provided " +
    "as JSONL. Find the ROOT CAUSE (the causal MECHANISM — which field/rule misclassified " +
    "and the cascade — not just the symptom). You may call obs_query (actions: diagnostics, " +
    "billing, delivery, channels) and read_source(path) to read Comis source files. When " +
    "done, state the root cause in plain text.";

  // OpenAI-compatible tool manifest for the 2 tools the agent has today.
  const tools = [
    {
      type: "function",
      function: {
        name: "obs_query",
        description: obsTool.description,
        parameters: {
          type: "object",
          properties: { action: { type: "string", enum: ["diagnostics", "billing", "delivery", "channels"] } },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_source",
        description: "Read a Comis source file by repo-relative path",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ];

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content:
        "Session transcript (JSONL):\n" +
        fixtureEvents.map((e) => JSON.stringify(e)).join("\n").slice(0, 12_000) +
        "\n\nWhat is the root cause of this degraded session?",
    },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0, max_tokens: 1024, stream: false }),
    });
    if (!res.ok) break;
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = json.choices?.[0]?.message ?? {};
    const usage = json.usage ?? {};

    // Record the assistant turn verbatim (so recordMetrics sees toolCalls + usage).
    transcript.push({
      role: "assistant",
      content: msg.content ?? "",
      toolCalls: (msg.tool_calls ?? []).map((tc) => ({
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments,
      })),
      usage: {
        totalTokens: usage.total_tokens,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
      },
    });
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });

    if (!msg.tool_calls || msg.tool_calls.length === 0) break; // turn complete

    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      let resultContent: string;
      if (tc.function?.name === "read_source" && typeof args["path"] === "string") {
        try {
          resultContent = readSourceImpl({ path: args["path"] }).slice(0, 8_000);
        } catch (err) {
          resultContent = `read_source error: ${err instanceof Error ? err.name : "error"}`;
        }
      } else if (tc.function?.name === "obs_query") {
        resultContent = JSON.stringify(await obsRpc(`obs.${String(args["action"] ?? "diagnostics")}`, args));
      } else {
        resultContent = "(unknown tool)";
      }
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function?.name, content: resultContent });
    }
  }
  return transcript;
}

describe.skipIf(!isLive)("DIAG-baseline RUN — fresh scripted agent on today's surface (gated)", () => {
  it.skip(
    "records (rootCauseReached?, tokens, #calls, #reads) per fixture + writes the gating report — " +
      "SKIPPED(no-live): needs COMIS_LIVE + a model/judge key; run `COMIS_LIVE=1 pnpm test:live prove`",
    async () => {
      const gov = new CostGovernor(); // reads COMIS_LIVE_BUDGET_USD (default $2.00)
      const rows: DiagnosisVerdictRow[] = [];
      const repoRoot = resolve(__dirnameLocal, "../../../..");

      // Agent model config — reuse the DOCUMENTED judge provider/model/key as the
      // agent model (avoids introducing a new env var; the operator already sets
      // COMIS_LIVE_JUDGE_* for the judge). The base URL defaults to the provider's
      // OpenAI-compatible endpoint convention.
      const agentApiKey = process.env["COMIS_LIVE_JUDGE_API_KEY"] ?? "";
      const agentModel = process.env["COMIS_LIVE_JUDGE_MODEL"] ?? "gpt-4o-mini";
      const agentBaseUrl = process.env["COMIS_LIVE_JUDGE_PROVIDER"] === "openai"
        ? "https://api.openai.com"
        : "https://api.openai.com"; // operator may point at any OpenAI-compatible endpoint

      for (const id of FIXTURE_IDS) {
        gov.declare("dollar", `diag-${id}`);
        if (gov.check()) break; // SKIPPED(budget-exceeded)

        const fx = loadFixture(join(FIXTURES_DIR, id));
        const readSource = makeReadSourceTool(repoRoot);

        const transcript = await runDiagnosisLoop({
          baseUrl: agentBaseUrl,
          apiKey: agentApiKey,
          model: agentModel,
          fixtureEvents: fx.events,
          readSourceImpl: readSource.impl,
        });

        const metrics = recordMetrics(transcript);
        const finalAnswer = lastAssistantText(transcript);
        // Structural pre-check (mechanism tokens present?), then the semantic judge.
        const pre = compareToAnswerKey(finalAnswer, fx.answerKey);
        const v = await judgeAnswer({
          question: "What is the root cause of this degraded session?",
          context: fx.answerKey.rootCause,
          answer: finalAnswer,
          rubric:
            "correct=true ONLY if the answer identifies the causal MECHANISM (which field/rule " +
            "misclassified and the cascade), not just the symptom.",
        });

        rows.push({
          fixtureId: id,
          failureClass: FAILURE_CLASS[id],
          totalTokens: metrics.totalTokens,
          distinctToolCalls: metrics.distinctToolCalls,
          // distinctSourceReads from the COUNTED read_source tool (metric M2c).
          distinctSourceReads: readSource.readPaths.size,
          judgeVerdict: v.verdict,
          // skip != fail: an absent judge key → "skip" (excluded from the denominator).
          rootCauseReached: v.verdict === "skip" ? "skip" : v.verdict === "pass",
          surfacesUsed: ["obs_query", ...Array.from(readSource.readPaths)],
        });

        // pre is the structural lens (logged via the row's tokens/reads); the judge
        // verdict is authoritative for rootCauseReached.
        void pre;
      }

      // --- persist: the gating report IS the deliverable (success criterion #3) ---
      const table = buildGatingTable(rows);
      const md = renderGatingMarkdown(table); // assertNoSecrets inside the renderer
      const report: LiveTestReport = {
        runId: `diag-baseline-${Date.now()}`,
        ts: new Date().toISOString(),
        git_sha: "unknown",
        mode: "prove-diagnosis",
        budget_usd: gov.tally(),
        total_cost_usd: gov.tally(),
        verdicts: rows.map((r) => ({
          scenarioId: r.fixtureId,
          status: r.rootCauseReached === "skip" ? ("skipped" as const) : r.rootCauseReached ? ("passed" as const) : ("failed" as const),
          reason: r.failureClass,
          costUsd: 0,
        })),
      };
      const ledgerDir = writeLedger(report, resolve(repoRoot, "benchmarks")); // assertNoSecrets inside
      writeFileSync(join(ledgerDir, "gating-table.md"), md, "utf-8"); // the reorder/trim table
      // belt-and-suspenders sweep over rows + the rendered table (T-149-03-01).
      assertNoSecrets(JSON.stringify(rows) + md, "diagnosis baseline run");
      expect(rows.length).toBeGreaterThan(0);
    },
  );
});
