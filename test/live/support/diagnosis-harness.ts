// SPDX-License-Identifier: Apache-2.0
/**
 * Pure diagnosis-harness scorers (Phase 149 — PROVE: LLM-diagnosis baseline).
 *
 * The deterministic substrate that makes the Plan-03 baseline numbers trustworthy.
 * Everything here is PURE except `readFileSync` (loadFixture + the read_source impl):
 * no daemon, no network, no env reads, no key — so it runs keyless in the Stage-A
 * tier (mirroring test/live/support/mock-mcp-server.ts) and never imports a product
 * package. The metric logic is RED→GREEN unit-tested in diagnosis-harness.test.ts
 * BEFORE any live token is spent (the `--selftest` discipline,
 * scripts/bench-small-model/run.mjs:120-182).
 *
 * Exports four scorers + the contract types Plan 02 (fixtures) and Plan 03 (scenario)
 * both consume:
 *   - loadFixture(dir)        — read a frozen fixture directory into a FixtureBundle
 *   - recordMetrics(turns)    — M2: tokens + distinct tool/RPC calls + distinct source reads
 *   - compareToAnswerKey(...) — structural pre-check that an answer hits the causal MECHANISM
 *   - makeReadSourceTool(...) — a COUNTED read_source(path) tool so metric M2c is observable
 *
 * The secret-sweep used by the DiagnosisVerdictRow serialize-and-write path lives in
 * test/live/cost.ts (`assertNoSecrets`) and is imported there — never re-implemented here.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Contract types — Plan 02 (fixtures) + Plan 03 (scenario) import these.
// ---------------------------------------------------------------------------

/**
 * The gold answer for a fixture, written at causal-MECHANISM granularity (the
 * specific field/rule that misclassified), NOT symptom granularity — so today's
 * baseline correctly FAILS and Phase 156/G1 has a real bar to beat (RESEARCH.md
 * Pitfall 4).
 */
export interface AnswerKey {
  /** Causal mechanism at field/rule granularity (NOT the symptom). */
  rootCause: string;
  expectedDegraded: boolean;
  /** What the logs SHOW (tool failed N times, costUsd). */
  visibleSymptoms: string[];
  /** What the logs DON'T SHOW — the GA1/GA2 gap. */
  hiddenMechanism: string;
  /** Surfaces an agent can reach today (no obs.explain). */
  surfaceCeiling: string[];
  /** The specific field/rule tokens an answer MUST contain to be "reached". */
  mechanismTokens: string[];
}

/**
 * One turn of an agent transcript. Distinct `toolCalls[].name` values feed
 * `distinctToolCalls`; distinct `read_source` path arguments feed
 * `distinctSourceReads`. The usage shape mirrors the bench harness
 * (scripts/bench-small-model/harness.mjs:89) token-sum idiom.
 */
export interface AgentTurn {
  role: "assistant" | "tool" | "user" | "system";
  content?: string;
  toolCalls?: Array<{ name: string; arguments?: string }>;
  usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number };
}

/** The three M2 metrics counted from an agent transcript. */
export interface DiagnosisMetrics {
  totalTokens: number;
  /** M2b — count of DISTINCT tool/RPC names invoked. */
  distinctToolCalls: number;
  /** M2c — count of DISTINCT read_source paths. */
  distinctSourceReads: number;
}

/**
 * Closed failure-class union (the as-const-union + exhaustive-default style of
 * test/live/harness/sec-config.ts:122) — never a bare `string` discriminator.
 */
export type DiagnosisFailureClass =
  | "503-breaker"
  | "exec-modulenotfound"
  | "budget-exhaustion"
  | "provider-timeout"
  | "historical-c53ab0f";

/**
 * One row of the Plan-03 gating report. Carries only counts/ids/typed verdicts —
 * no raw bodies, no answer text — so JSON.stringify(row) passes assertNoSecrets
 * before any write (T-149-01-02).
 */
export interface DiagnosisVerdictRow {
  fixtureId: string;
  failureClass: DiagnosisFailureClass;
  /** "skip" when the judge is absent (skip ≠ fail). */
  rootCauseReached: boolean | "skip";
  totalTokens: number;
  distinctToolCalls: number;
  distinctSourceReads: number;
  judgeVerdict: "pass" | "fail" | "skip";
  /** obs.* RPC / trajectory / daemon.log the agent touched. */
  surfacesUsed: string[];
}

/** A frozen fixture directory parsed into events + metadata + answer-key. */
export interface FixtureBundle {
  events: Array<Record<string, unknown>>;
  meta: Record<string, unknown>;
  answerKey: AnswerKey;
}

/**
 * A COUNTED read_source tool. `impl({path})` reads the file AND records the path;
 * `readPaths` is the live distinct-path set the scenario reads `.size` from after
 * the run (the M2c instrumentation point, RESEARCH.md OQ2).
 */
export interface ReadSourceTool {
  name: "read_source";
  description: string;
  parameters: { type: "object"; properties: { path: { type: "string" } }; required: string[] };
  impl: (args: { path: string }) => string;
  readPaths: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// loadFixture — read a frozen fixture directory into a bundle.
// ---------------------------------------------------------------------------

/**
 * Parse a `{file}` under `dir` as JSON, rethrowing with the PATH ONLY (never the
 * offending content) on failure — the residency rule (T-149-01-01), mirroring
 * cost.ts:64 / the judge path-only throw.
 */
function parseJsonFile(dir: string, file: string): unknown {
  const full = resolve(dir, file);
  const raw = readFileSync(full, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    // Path only — never echo `raw`, which could carry sensitive captured content.
    throw new Error(`diagnosis-harness: malformed JSON in fixture file ${file}`);
  }
}

/**
 * Read a frozen fixture directory (`trajectory.jsonl` + `session-metadata.json` +
 * `answer-key.json`) into a {@link FixtureBundle}.
 *
 * A malformed `trajectory.jsonl` line THROWS — a fixture is a committed artifact and
 * MUST be well-formed. This is the deliberate divergence from cassette.ts:121-133,
 * which SKIPS malformed lines because a cassette is a replay log, not a frozen corpus.
 */
export function loadFixture(dir: string): FixtureBundle {
  const trajectoryPath = resolve(dir, "trajectory.jsonl");
  const lines = readFileSync(trajectoryPath, "utf-8").split("\n").filter(Boolean);
  const events: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Path only — a committed fixture must parse cleanly; a bad line is a corrupt artifact.
      throw new Error(`diagnosis-harness: malformed JSONL line in fixture file trajectory.jsonl`);
    }
  }

  const meta = parseJsonFile(dir, "session-metadata.json") as Record<string, unknown>;
  const answerKey = parseJsonFile(dir, "answer-key.json") as AnswerKey;

  return { events, meta, answerKey };
}

// ---------------------------------------------------------------------------
// recordMetrics — tokens + distinct tool/RPC calls + distinct source reads.
// ---------------------------------------------------------------------------

/**
 * Count the three M2 metrics from an agent transcript.
 *
 * - totalTokens: sum of `usage.totalTokens`, falling back to
 *   `promptTokens + completionTokens` (the bench harness idiom,
 *   scripts/bench-small-model/harness.mjs:89).
 * - distinctToolCalls (M2b): size of the set of every `toolCalls[].name`
 *   (calling obs_query twice = 1).
 * - distinctSourceReads (M2c): size of the set of the `path` argument of every
 *   `read_source` call. A malformed `arguments` JSON is SKIPPED, not thrown — a
 *   benchmark transcript is lightly-trusted captured data and throwing would let a
 *   bad fixture abort the whole baseline (T-149-01-03).
 */
export function recordMetrics(transcript: AgentTurn[]): DiagnosisMetrics {
  let totalTokens = 0;
  const toolNames = new Set<string>();
  const sourcePaths = new Set<string>();

  for (const turn of transcript) {
    const usage = turn.usage;
    if (usage) {
      totalTokens += usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    }

    for (const call of turn.toolCalls ?? []) {
      toolNames.add(call.name);
      if (call.name === "read_source" && call.arguments !== undefined) {
        try {
          const parsed = JSON.parse(call.arguments) as { path?: unknown };
          if (typeof parsed.path === "string") sourcePaths.add(parsed.path);
        } catch {
          // Skip a malformed arguments blob — a mis-counted entry is non-security.
        }
      }
    }
  }

  return {
    totalTokens,
    distinctToolCalls: toolNames.size,
    distinctSourceReads: sourcePaths.size,
  };
}

// ---------------------------------------------------------------------------
// compareToAnswerKey — structural causal-mechanism pre-check.
// ---------------------------------------------------------------------------

/**
 * Structural pre-check that an answer hits the causal MECHANISM, not just the
 * symptom: `reached` is true ONLY if the answer (case-insensitively) contains
 * EVERY token in `answerKey.mechanismTokens`. The semantic judge (judgeAnswer)
 * runs in Plan 03; this guarantees the baseline only counts "reached" when the
 * mechanism tokens are present (RESEARCH.md Pitfall 4).
 *
 * `detail` lists the token names that were missing (token names only — no secret
 * content).
 */
export function compareToAnswerKey(
  answer: string,
  answerKey: AnswerKey,
): { reached: boolean; detail: string } {
  const haystack = answer.toLowerCase();
  const missing = answerKey.mechanismTokens.filter((t) => !haystack.includes(t.toLowerCase()));
  const reached = missing.length === 0;
  const detail = reached
    ? `all ${answerKey.mechanismTokens.length} mechanism tokens present`
    : `missing mechanism tokens: ${missing.join(", ")}`;
  return { reached, detail };
}

// ---------------------------------------------------------------------------
// makeReadSourceTool — a COUNTED read_source(path) tool (metric M2c).
// ---------------------------------------------------------------------------

/**
 * Build a COUNTED `read_source(path)` tool whose `impl` reads the file AND records
 * the repo-relative path in a live `readPaths` set (so `distinctSourceReads` is
 * observable, RESEARCH.md OQ2).
 *
 * NOTE: `resolve` here is acceptable — the `safePath`/no-path.join rule is scoped to
 * product source under packages (AGENTS.md §2.2); this file is in `test/`. `read_source`
 * reads arbitrary repo-relative paths BY DESIGN (the metric IS "how many source files
 * must the agent read"); it is a test harness at operator trust, never wired into a
 * product package (T-149-01-04).
 */
export function makeReadSourceTool(repoRoot: string): ReadSourceTool {
  const readPaths = new Set<string>();
  return {
    name: "read_source",
    description: "Read a Comis source file by repo-relative path",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    impl: ({ path }: { path: string }): string => {
      readPaths.add(path);
      return readFileSync(resolve(repoRoot, path), "utf-8");
    },
    readPaths,
  };
}
