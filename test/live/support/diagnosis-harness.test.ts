// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the PURE diagnosis-harness scorers (Phase 149, Plan 01).
 *
 * This is the TDD core of the PROVE phase: the Plan-03 baseline RUN is only as
 * credible as these deterministic scorers, so the metric logic is proven RED→GREEN
 * here (the `--selftest` discipline, scripts/bench-small-model/run.mjs:120-182)
 * BEFORE a single live token is spent. No daemon, no COMIS_LIVE, no network, no key —
 * a Stage-A unit file mirroring the sibling test/live/support/mock-mcp-server.test.ts.
 *
 * Covers the five behaviors of test/live/support/diagnosis-harness.ts:
 *   loadFixture · recordMetrics · compareToAnswerKey · makeReadSourceTool · DiagnosisVerdictRow
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadFixture,
  recordMetrics,
  compareToAnswerKey,
  makeReadSourceTool,
  type AnswerKey,
  type AgentTurn,
  type DiagnosisVerdictRow,
} from "./diagnosis-harness.js";
import { assertNoSecrets } from "../cost.js";

// Track every tmp dir we seed so afterEach can tear them down (no ~/.comis writes).
const tmpDirs: string[] = [];
function seedDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// The gold causal-mechanism tokens for the historical session-678314278 incident:
// a status-200 body misclassified by a substring detector, cascading into the breaker.
const MECHANISM_KEY: AnswerKey = {
  rootCause:
    "detectPiApiSuccessResponse substring detector misclassified a status-200 body, cascading into the retry breaker",
  expectedDegraded: true,
  visibleSymptoms: ["web_fetch failed 14 times", "costUsd accumulating"],
  hiddenMechanism: "no transportOk/httpStatus/matchedRule/classifiedFailureBy field exists in the logs",
  surfaceCeiling: ["trajectory.jsonl", "obs_query (4 actions)", "daemon.log"],
  mechanismTokens: ["detectPiApiSuccessResponse", "status-200", "substring"],
};

describe("diagnosis-harness loadFixture — reads a frozen fixture directory into a bundle", () => {
  it("loadFixture parses trajectory.jsonl + metadata + answer-key from a seeded directory", () => {
    const dir = seedDir("diag-loadfixture-ok-");
    writeFileSync(
      join(dir, "trajectory.jsonl"),
      JSON.stringify({ type: "tool_call", name: "web_fetch", ts: "2026-06-07T20:27:00.000Z" }) + "\n",
    );
    writeFileSync(
      join(dir, "session-metadata.json"),
      JSON.stringify({ sessionId: "678314278", endReason: "completed_with_tool_errors", totalTokens: 91234 }),
    );
    writeFileSync(join(dir, "answer-key.json"), JSON.stringify(MECHANISM_KEY));

    const bundle = loadFixture(dir);
    expect(bundle.events.length).toBe(1);
    expect(bundle.meta["endReason"]).toBe("completed_with_tool_errors");
    expect(bundle.answerKey.rootCause).toBeTruthy();
    expect(bundle.answerKey.mechanismTokens).toContain("detectPiApiSuccessResponse");
  });

  it("loadFixture throws on a malformed trajectory.jsonl line so a corrupt fixture is caught", () => {
    const dir = seedDir("diag-loadfixture-bad-");
    // A committed fixture MUST be well-formed — unlike cassette.ts which SKIPS malformed lines.
    writeFileSync(join(dir, "trajectory.jsonl"), '{not json\n');
    writeFileSync(join(dir, "session-metadata.json"), JSON.stringify({ endReason: "completed_with_tool_errors" }));
    writeFileSync(join(dir, "answer-key.json"), JSON.stringify(MECHANISM_KEY));

    expect(() => loadFixture(dir)).toThrow();
  });

  it("loadFixture surfaces the offending file path (not its content) when a parse fails", () => {
    const dir = seedDir("diag-loadfixture-path-");
    writeFileSync(join(dir, "trajectory.jsonl"), '{"type":"tool_call"}\n');
    writeFileSync(join(dir, "session-metadata.json"), "this-is-not-json");
    writeFileSync(join(dir, "answer-key.json"), JSON.stringify(MECHANISM_KEY));

    // The throw cites session-metadata.json (residency rule: path only, no body echo).
    expect(() => loadFixture(dir)).toThrow(/session-metadata\.json/);
  });
});

describe("diagnosis-harness recordMetrics — counts tokens and DISTINCT tool/RPC calls and source reads", () => {
  it("recordMetrics counts distinct tool names not raw call count from a synthetic transcript", () => {
    const transcript: AgentTurn[] = [
      {
        role: "assistant",
        toolCalls: [{ name: "obs_query", arguments: JSON.stringify({ action: "diagnostics" }) }],
        usage: { totalTokens: 100 },
      },
      {
        role: "assistant",
        toolCalls: [{ name: "obs_query", arguments: JSON.stringify({ action: "billing" }) }],
        usage: { totalTokens: 50 },
      },
      {
        role: "assistant",
        toolCalls: [
          { name: "read_source", arguments: JSON.stringify({ path: "a.ts" }) },
          { name: "read_source", arguments: JSON.stringify({ path: "a.ts" }) },
          { name: "read_source", arguments: JSON.stringify({ path: "b.ts" }) },
        ],
        usage: { totalTokens: 200 },
      },
    ];

    const m = recordMetrics(transcript);
    // obs_query (×2 → 1) + read_source (×3 → 1) = 2 distinct tool names.
    expect(m.distinctToolCalls).toBe(2);
    // a.ts (×2 → 1) + b.ts (×1 → 1) = 2 distinct source paths.
    expect(m.distinctSourceReads).toBe(2);
    expect(m.totalTokens).toBe(350);
  });

  it("recordMetrics falls back to prompt+completion tokens when totalTokens is absent", () => {
    const transcript: AgentTurn[] = [
      { role: "assistant", usage: { promptTokens: 10, completionTokens: 5 } },
    ];
    expect(recordMetrics(transcript).totalTokens).toBe(15);
  });

  it("recordMetrics skips a read_source call with malformed arguments rather than throwing", () => {
    const transcript: AgentTurn[] = [
      {
        role: "assistant",
        toolCalls: [
          { name: "read_source", arguments: "{not json" },
          { name: "read_source", arguments: JSON.stringify({ path: "c.ts" }) },
        ],
        usage: { totalTokens: 12 },
      },
    ];
    const m = recordMetrics(transcript);
    // The malformed entry is skipped; read_source is still 1 distinct tool name; c.ts is the 1 read.
    expect(m.distinctToolCalls).toBe(1);
    expect(m.distinctSourceReads).toBe(1);
  });
});

describe("diagnosis-harness compareToAnswerKey — requires the causal mechanism not the symptom", () => {
  it("compareToAnswerKey marks a symptom-only answer as not reached", () => {
    const r = compareToAnswerKey("web_fetch failed 14 times", MECHANISM_KEY);
    expect(r.reached).toBe(false);
    expect(r.detail).toContain("detectPiApiSuccessResponse");
  });

  it("compareToAnswerKey marks a full causal-mechanism answer as reached", () => {
    const answer =
      "the detectPiApiSuccessResponse substring detector misclassified a status-200 body, cascading into the breaker";
    const r = compareToAnswerKey(answer, MECHANISM_KEY);
    expect(r.reached).toBe(true);
  });

  it("compareToAnswerKey is case-insensitive across the mechanism tokens", () => {
    const answer = "DETECTPIAPISUCCESSRESPONSE used a SUBSTRING match on a STATUS-200 reply";
    expect(compareToAnswerKey(answer, MECHANISM_KEY).reached).toBe(true);
  });
});

describe("diagnosis-harness makeReadSourceTool — a counted read_source tool for the M2c metric", () => {
  it("makeReadSourceTool records distinct paths and returns file contents", () => {
    const repoRoot = seedDir("diag-readsource-");
    mkdirSync(join(repoRoot, "nested"), { recursive: true });
    writeFileSync(join(repoRoot, "foo.txt"), "FOO-CONTENT");
    writeFileSync(join(repoRoot, "nested", "bar.txt"), "BAR-CONTENT");

    const tool = makeReadSourceTool(repoRoot);
    expect(tool.name).toBe("read_source");

    expect(tool.impl({ path: "foo.txt" })).toBe("FOO-CONTENT");
    // Second read of the SAME path must not grow the distinct-path set.
    tool.impl({ path: "foo.txt" });
    expect(tool.impl({ path: "nested/bar.txt" })).toBe("BAR-CONTENT");

    expect(tool.readPaths.size).toBe(2);
  });
});

describe("diagnosis-harness DiagnosisVerdictRow — serializes and passes the secret sweep", () => {
  it("a DiagnosisVerdictRow serializes to JSON and passes assertNoSecrets without throwing", () => {
    const row: DiagnosisVerdictRow = {
      fixtureId: "session-678314278",
      failureClass: "historical-c53ab0f",
      rootCauseReached: false,
      totalTokens: 91234,
      distinctToolCalls: 2,
      distinctSourceReads: 3,
      judgeVerdict: "skip",
      surfacesUsed: ["trajectory.jsonl", "obs_query:diagnostics", "daemon.log"],
    };
    const json = JSON.stringify(row);
    expect(() => assertNoSecrets(json, "DiagnosisVerdictRow")).not.toThrow();
    expect(json).toContain("session-678314278");
  });
});
