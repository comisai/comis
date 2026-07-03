// SPDX-License-Identifier: Apache-2.0
/**
 * Pure diagnosis-harness scorers.
 *
 * The deterministic substrate that makes the baseline numbers trustworthy.
 * Everything here is PURE except `readFileSync` (loadFixture + the read_source impl):
 * no daemon, no network, no env reads, no key — so it runs keyless in the Stage-A
 * tier (mirroring test/live/support/mock-mcp-server.ts) and never imports a product
 * package. The metric logic is RED→GREEN unit-tested in diagnosis-harness.test.ts
 * BEFORE any live token is spent (the `--selftest` discipline).
 *
 * Exports four scorers + the contract types the fixtures and scenario layers both
 * consume:
 *   - loadFixture(dir)        — read a frozen fixture directory into a FixtureBundle
 *   - recordMetrics(turns)    — tokens + distinct tool/RPC calls + distinct source reads
 *   - compareToAnswerKey(...) — structural pre-check that an answer hits the causal MECHANISM
 *   - makeReadSourceTool(...) — a COUNTED read_source(path) tool so distinct source reads are observable
 *
 * The secret-sweep used by the DiagnosisVerdictRow serialize-and-write path lives in
 * test/live/cost.ts (`assertNoSecrets`) and is imported there — never re-implemented here.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Contract types — the fixtures and scenario layers import these.
// ---------------------------------------------------------------------------

/**
 * The gold answer for a fixture, written at causal-MECHANISM granularity (the
 * specific field/rule that misclassified), NOT symptom granularity — so today's
 * baseline correctly FAILS and a new obs surface has a real bar to beat.
 */
export interface AnswerKey {
  /** Causal mechanism at field/rule granularity (NOT the symptom). */
  rootCause: string;
  expectedDegraded: boolean;
  /** What the logs SHOW (tool failed N times, costUsd). */
  visibleSymptoms: string[];
  /** What the logs DON'T SHOW — the observability gap. */
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
 * (scripts/bench-small-model/harness.mjs) token-sum idiom.
 */
export interface AgentTurn {
  role: "assistant" | "tool" | "user" | "system";
  content?: string;
  toolCalls?: Array<{ name: string; arguments?: string }>;
  usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number };
}

/** The three metrics counted from an agent transcript. */
export interface DiagnosisMetrics {
  totalTokens: number;
  /** Count of DISTINCT tool/RPC names invoked. */
  distinctToolCalls: number;
  /** Count of DISTINCT read_source paths. */
  distinctSourceReads: number;
}

/**
 * Closed failure-class union (the as-const-union + exhaustive-default style of
 * test/live/harness/sec-config.ts) — never a bare `string` discriminator.
 */
export type DiagnosisFailureClass =
  | "503-breaker"
  | "exec-modulenotfound"
  | "budget-exhaustion"
  | "provider-timeout"
  | "historical-c53ab0f";

/**
 * One row of the gating report. Carries only counts/ids/typed verdicts —
 * no raw bodies, no answer text — so JSON.stringify(row) passes assertNoSecrets
 * before any write.
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
 * the run (the distinct-source-reads instrumentation point).
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
 * offending content) on failure — the residency rule, mirroring
 * cost.ts / the judge path-only throw.
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
 * MUST be well-formed. This is the deliberate divergence from cassette.ts,
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
  const answerKey = assertAnswerKey(parseJsonFile(dir, "answer-key.json"));

  return { events, meta, answerKey };
}

/**
 * Validate that a parsed `answer-key.json` has the load-bearing AnswerKey shape,
 * throwing PATH ONLY on violation.
 *
 * `loadFixture` already catches *parse* failures early on the principle that "a
 * committed fixture is an artifact and MUST be well-formed". But a JSON-valid
 * answer-key missing `mechanismTokens` (or with it empty / non-array) used to pass
 * `loadFixture` cleanly and then detonate downstream in `compareToAnswerKey` as an
 * opaque `Cannot read properties of undefined (reading 'filter')` with no fixture
 * path — exactly the failure mode the early-throw philosophy exists to prevent. An
 * empty `mechanismTokens` is rejected here too (it is the root of the vacuous
 * pass), so it is impossible to construct a zero-token bundle.
 */
function assertAnswerKey(parsed: unknown): AnswerKey {
  const ak = parsed as Partial<AnswerKey>;
  if (
    typeof ak.rootCause !== "string" ||
    !Array.isArray(ak.mechanismTokens) ||
    ak.mechanismTokens.length === 0 ||
    !ak.mechanismTokens.every((t) => typeof t === "string")
  ) {
    // Path only — never echo the parsed body, which could carry captured content.
    throw new Error("diagnosis-harness: malformed answer-key.json in fixture file answer-key.json");
  }
  return ak as AnswerKey;
}

// ---------------------------------------------------------------------------
// recordMetrics — tokens + distinct tool/RPC calls + distinct source reads.
// ---------------------------------------------------------------------------

/**
 * Count the three M2 metrics from an agent transcript.
 *
 * - totalTokens: sum of `usage.totalTokens` when it is a POSITIVE number,
 *   otherwise the `promptTokens + completionTokens` component sum (the bench
 *   harness idiom, scripts/bench-small-model/harness.mjs:89). A zero/absent
 *   total is treated as "no usable total" so a provider that emits
 *   `total_tokens: 0` with populated components does not under-count.
 * - distinctToolCalls: size of the set of every NON-EMPTY `toolCalls[].name`
 *   (calling obs_query twice = 1). A nameless tool call is skipped — it is not a
 *   distinct tool and must not inflate the count.
 * - distinctSourceReads: size of the set of the `path` argument of every
 *   `read_source` call. A malformed `arguments` JSON is SKIPPED, not thrown — a
 *   benchmark transcript is lightly-trusted captured data and throwing would let a
 *   bad fixture abort the whole baseline.
 */
export function recordMetrics(transcript: AgentTurn[]): DiagnosisMetrics {
  let totalTokens = 0;
  const toolNames = new Set<string>();
  const sourcePaths = new Set<string>();

  for (const turn of transcript) {
    const usage = turn.usage;
    if (usage) {
      // `??` only falls back on null/undefined, so a real `total_tokens: 0`
      // (streaming-off Ollama / some OpenAI-compatible proxies emit this while still
      // reporting prompt/completion) was kept and under-counted the token total. Treat a
      // zero/absent total as "no usable total" and prefer the component sum.
      const total = usage.totalTokens;
      totalTokens +=
        typeof total === "number" && total > 0
          ? total
          : (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    }

    for (const call of turn.toolCalls ?? []) {
      // A nameless tool call (model emitted no function.name — common with
      // small local models) must NOT join the distinct-tool set as "" and inflate
      // the distinct-tool count, which can flip a TRIM-candidate (distinctToolCalls <= 1) into a false
      // BUILD recommendation. A nameless call is not a distinct tool.
      if (!call.name) continue;
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
 * runs in a later stage; this guarantees the baseline only counts "reached" when the
 * mechanism tokens are present.
 *
 * `detail` lists the token names that were missing (token names only — no secret
 * content).
 *
 * THROWS on an empty `answerKey.mechanismTokens` — an empty list would make
 * `reached` vacuously true for every answer, which is a programmer error, not a pass.
 */
export function compareToAnswerKey(
  answer: string,
  answerKey: AnswerKey,
): { reached: boolean; detail: string } {
  // `[].filter(...)` is `[]`, so an empty mechanismTokens list would make
  // `reached` vacuously true for EVERY answer (even ""), defeating the measure-first
  // lever. A zero-token key is a programmer error in the scorer (loadFixture's
  // assertAnswerKey blocks zero-token fixtures, but this reusable contract — imported
  // by the fixtures and scenario layers — must guard independently), not a clean pass.
  if (answerKey.mechanismTokens.length === 0) {
    throw new Error("compareToAnswerKey: answerKey.mechanismTokens is empty — cannot score");
  }
  const haystack = answer.toLowerCase();
  const missing = answerKey.mechanismTokens.filter((t) => !haystack.includes(t.toLowerCase()));
  const reached = missing.length === 0;
  const detail = reached
    ? `all ${answerKey.mechanismTokens.length} mechanism tokens present`
    : `missing mechanism tokens: ${missing.join(", ")}`;
  return { reached, detail };
}

// ---------------------------------------------------------------------------
// makeReadSourceTool — a COUNTED read_source(path) tool (the distinct-source-reads metric).
// ---------------------------------------------------------------------------

/**
 * Build a COUNTED `read_source(path)` tool whose `impl` reads the file AND records
 * the repo-relative path in a live `readPaths` set (so `distinctSourceReads` is
 * observable).
 *
 * NOTE: `resolve` here is acceptable — the `safePath`/no-path.join rule is scoped to
 * product source under packages (AGENTS.md §2.2); this file is in `test/`. `read_source`
 * reads arbitrary repo-relative paths BY DESIGN (the metric IS "how many source files
 * must the agent read"); it is a test harness at operator trust, never wired into a
 * product package.
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
