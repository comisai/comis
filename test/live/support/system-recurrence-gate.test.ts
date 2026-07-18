// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the PURE recurrence/gate scorer — the TDD core of
 * the system-triage baseline gate.
 *
 * This is the metric-bearing analysis that GATES the downstream instrumentation (the
 * reorder/trim signal): which currently-log-only signals recur enough in the real
 * `~/.comis` to be worth instrumenting. Because the measurement is only as trustworthy
 * as this scorer, the verdict logic is proven RED→GREEN here BEFORE the script consumes
 * it — the `--selftest` discipline, mirroring diagnosis-gating-report.test.ts
 * (the EXACT analog), MINUS the LLM-judge apparatus (this gate spends zero tokens — no
 * CostGovernor, no judgeAnswer, no COMIS_LIVE gate).
 *
 * THE LOAD-BEARING CASE: a realCount of 0 is NOT automatically a
 * confident SKIP. The scorer MUST distinguish a CONFIDENT SKIP (the emitting code path
 * was exercised but the WARN never fired → SKIP-NEVER-RECURS) from INCONCLUSIVE (0
 * observed because the path was never hit on this light dev machine). A false
 * confident-SKIP on the flagship signal (LCD ×7) would silently gut the downstream
 * instrumentation — so the two cases MUST produce DIFFERENT verdicts.
 *
 * NOTE on the run command: these `support/*.test.ts` files are
 * NOT in the ROOT vitest workspace, so a bare `pnpm vitest run` resolves the root
 * config and runs NOTHING (a false-RED). Verify under the LIVE config:
 *   pnpm vitest run --config test/live/vitest.config.ts test/live/support/system-recurrence-gate.test.ts
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { SystemSignal } from "./system-triage-corpus.js";
import {
  recordSignalRecurrence,
  buildGapGateTable,
  renderGapGateMarkdown,
  RECURRENCE_THRESHOLD,
  type GapGateRow,
} from "./system-recurrence-gate.js";

/**
 * A minimal GapGateRow factory — overlay only the fields a case asserts on. The
 * `verdict` defaults to INCONCLUSIVE (the safe default for an un-exercised 0);
 * buildGapGateTable recomputes it, so cases that exercise the verdict map pass the
 * raw inputs (realCount / alreadyStructured / pathExercised) and read back the row's
 * computed verdict.
 */
function gapRow(overrides: Partial<GapGateRow>): GapGateRow {
  return {
    signal: "lcd-ingest-skipped",
    byHandCount: 7,
    realCount: 0,
    recurs: false,
    alreadyStructured: false,
    pathExercised: false,
    verdict: "INCONCLUSIVE",
    ...overrides,
  };
}

describe("buildGapGateTable — per-signal recurrence verdict", () => {
  it("buildGapGateTable returns INSTRUMENT for a recurring log-only signal", () => {
    // realCount >= RECURRENCE_THRESHOLD (3), not already-structured, in-scope.
    const table = buildGapGateTable([
      gapRow({ signal: "lcd-ingest-skipped", realCount: RECURRENCE_THRESHOLD, pathExercised: true }),
    ]);
    expect(table).toHaveLength(1);
    expect(table[0]!.verdict).toBe("INSTRUMENT");
    expect(table[0]!.recurs).toBe(true);
  });

  it("buildGapGateTable returns ALREADY-STRUCTURED for an already-structured signal regardless of count", () => {
    // session-degradation is queryable today (obs_diagnostics) — a contrast item,
    // never instrumented even with a high realCount.
    const table = buildGapGateTable([
      gapRow({ signal: "session-degradation", realCount: 99, alreadyStructured: true, pathExercised: true }),
    ]);
    expect(table[0]!.verdict).toBe("ALREADY-STRUCTURED");
  });

  it("buildGapGateTable returns OUT-OF-SCOPE for the deferred model-health signal regardless of count", () => {
    // model-health-deferred (native node-llama-cpp stdout) is outside this scope —
    // the gate notes it but never scores it as instrumentable, even with a count.
    const table = buildGapGateTable([
      gapRow({ signal: "model-health-deferred", realCount: 50, pathExercised: true }),
    ]);
    expect(table[0]!.verdict).toBe("OUT-OF-SCOPE");
  });

  it("buildGapGateTable distinguishes a CONFIDENT SKIP from INCONCLUSIVE on realCount=0", () => {
    // The flagship distinction: 0 observed is only a confident SKIP when the emitting
    // path was exercised. 0 + un-exercised is INCONCLUSIVE — NOT evidence it never
    // recurs (a false SKIP here would gut the downstream instrumentation). These MUST differ.
    const exercised = buildGapGateTable([
      gapRow({ signal: "budget-exceeded", realCount: 0, pathExercised: true }),
    ]);
    const unexercised = buildGapGateTable([
      gapRow({ signal: "budget-exceeded", realCount: 0, pathExercised: false }),
    ]);
    expect(exercised[0]!.verdict).toBe("SKIP-NEVER-RECURS");
    expect(unexercised[0]!.verdict).toBe("INCONCLUSIVE");
    // The whole point: the two cases produce DIFFERENT verdicts.
    expect(exercised[0]!.verdict).not.toBe(unexercised[0]!.verdict);
  });

  it("marks recurs true when realCount reaches the recurrence threshold in buildGapGateTable", () => {
    const below = buildGapGateTable([gapRow({ realCount: RECURRENCE_THRESHOLD - 1, pathExercised: true })]);
    const at = buildGapGateTable([gapRow({ realCount: RECURRENCE_THRESHOLD, pathExercised: true })]);
    expect(below[0]!.recurs).toBe(false);
    expect(at[0]!.recurs).toBe(true);
  });
});

describe("recordSignalRecurrence — maps a corpus + measured counts into GapGateRow[]", () => {
  const corpus: SystemSignal[] = [
    { signal: "lcd-ingest-skipped", byHandCount: 7, location: "daemon.log", alreadyStructured: false },
    { signal: "mcp-reconnect", byHandCount: 5, location: "trajectory.jsonl", alreadyStructured: false },
    { signal: "session-degradation", byHandCount: 9, location: "obs_diagnostics", alreadyStructured: true },
    { signal: "model-health-deferred", byHandCount: 1, location: "native-stdout", alreadyStructured: false },
  ];

  it("recordSignalRecurrence carries byHandCount from the corpus + realCount from the measurement", () => {
    const measured = new Map<SystemSignal["signal"], { realCount: number; pathExercised: boolean }>([
      ["lcd-ingest-skipped", { realCount: 4, pathExercised: true }],
      ["mcp-reconnect", { realCount: 5, pathExercised: true }],
    ]);
    const rows = recordSignalRecurrence(corpus, measured);
    expect(rows).toHaveLength(4);
    const lcd = rows.find((r) => r.signal === "lcd-ingest-skipped")!;
    expect(lcd.byHandCount).toBe(7); // from the corpus
    expect(lcd.realCount).toBe(4); // from the measurement
    expect(lcd.recurs).toBe(true); // 4 >= 3
    expect(lcd.verdict).toBe("INSTRUMENT");
  });

  it("recordSignalRecurrence treats a MISSING measured entry as INCONCLUSIVE, never a crash (tolerant-counter)", () => {
    // The measured map is untrusted — a corpus signal with no measured entry defaults
    // to realCount 0 / pathExercised false → INCONCLUSIVE (NOT a confident SKIP, NOT a
    // throw). mcp-reconnect is absent from `measured` here.
    const measured = new Map<SystemSignal["signal"], { realCount: number; pathExercised: boolean }>([
      ["lcd-ingest-skipped", { realCount: 4, pathExercised: true }],
    ]);
    const rows = recordSignalRecurrence(corpus, measured);
    const mcp = rows.find((r) => r.signal === "mcp-reconnect")!;
    expect(mcp.realCount).toBe(0);
    expect(mcp.verdict).toBe("INCONCLUSIVE");
  });

  it("recordSignalRecurrence always marks model-health-deferred OUT-OF-SCOPE even if measured", () => {
    const measured = new Map<SystemSignal["signal"], { realCount: number; pathExercised: boolean }>([
      ["model-health-deferred", { realCount: 10, pathExercised: true }],
    ]);
    const rows = recordSignalRecurrence(corpus, measured);
    const mh = rows.find((r) => r.signal === "model-health-deferred")!;
    expect(mh.verdict).toBe("OUT-OF-SCOPE");
  });

  it("recordSignalRecurrence keeps an already-structured signal as ALREADY-STRUCTURED", () => {
    const measured = new Map<SystemSignal["signal"], { realCount: number; pathExercised: boolean }>([
      ["session-degradation", { realCount: 9, pathExercised: true }],
    ]);
    const rows = recordSignalRecurrence(corpus, measured);
    const sd = rows.find((r) => r.signal === "session-degradation")!;
    expect(sd.verdict).toBe("ALREADY-STRUCTURED");
  });
});

describe("renderGapGateMarkdown — the gate artifact (markdown table + caveat + summary)", () => {
  const sampleRows = (): GapGateRow[] =>
    buildGapGateTable([
      gapRow({ signal: "lcd-ingest-skipped", realCount: 4, pathExercised: true }),
      gapRow({ signal: "budget-exceeded", realCount: 0, pathExercised: false }),
      gapRow({ signal: "session-degradation", realCount: 9, alreadyStructured: true, pathExercised: true }),
    ]);

  it("renderGapGateMarkdown emits a markdown table, a data-scoped CAVEAT, and an INSTRUMENT summary", () => {
    const md = renderGapGateMarkdown(sampleRows(), {
      host: "test-host",
      date: "2026-06-08",
      sinceHours: 24,
    });
    // markdown table header
    expect(md).toContain("| signal |");
    // each signal appears as a row
    expect(md).toContain("lcd-ingest-skipped");
    expect(md).toContain("budget-exceeded");
    // the data-scoped CAVEAT carries host + date + window (data-dependence honesty)
    expect(md).toMatch(/CAVEAT/);
    expect(md).toContain("test-host");
    expect(md).toContain("2026-06-08");
    expect(md).toContain("24");
    // The summary count must be load-bearing: assert the LITERAL phrase so a regression
    // rendering "2 …" or "0 …" fails (the bare /1/ matched any digit 1 anywhere —
    // byHandCount, a realCount, the window note — and proved nothing). Of the 3 sample
    // signals exactly 1 (lcd-ingest-skipped, realCount 4 >= 3) is INSTRUMENT;
    // budget-exceeded is INCONCLUSIVE, session-degradation is ALREADY-STRUCTURED.
    expect(md).toMatch(/1 INSTRUMENT verdict\(s\) of 3 signal\(s\)/);
    // And exactly one INSTRUMENT token across the whole render (the table row + the
    // summary would each carry it, so count occurrences rather than trusting a single match).
    expect(md.match(/INSTRUMENT/g) ?? []).toHaveLength(2);
  });

  it("renderGapGateMarkdown output passes the secret sweep (defense-in-depth)", () => {
    const md = renderGapGateMarkdown(sampleRows(), {
      host: "test-host",
      date: "2026-06-08",
      sinceHours: 24,
    });
    // The render runs assertNoSecrets internally before returning — re-asserting here
    // proves the table carries only counts/signal-names/typed-verdicts, never bodies.
    // (import dynamically to mirror the secret-sweep test idiom.)
    return import("../cost.js").then(({ assertNoSecrets }) => {
      expect(() => assertNoSecrets(md, "gap-gate table")).not.toThrow();
    });
  });
});
