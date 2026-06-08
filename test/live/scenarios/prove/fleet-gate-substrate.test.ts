// SPDX-License-Identifier: Apache-2.0
/**
 * FLEET-gate substrate (Phase 158 — PROVE & gate: fleet-triage baseline, M1 + M2).
 *
 * The keyless, always-on, DETERMINISTIC substrate — the direct twin of the
 * Stage-A/B half of `diagnosis-baseline.test.ts` (Phase 149), but with the
 * Stage-C LLM apparatus REMOVED ENTIRELY: 158 spends ZERO tokens, so there is
 * NO live-gate env flag, NO conditional skip, NO cost-governor, NO LLM judge,
 * and NO environment read of any kind (RESEARCH Anti-Pattern: cargo-culting the
 * 149 live-gate shape — this file intentionally contains none of those tokens).
 * Every assertion below is a pure function of the frozen Plan-02 corpus + a
 * SYNTHETIC measured-count map (fixed test inputs — NOT the real `~/.comis`).
 *
 * What it proves: the Plan-01 scorers (`loadCorpus` → `recordSignalRecurrence`
 * → `buildGapGateTable` → `renderGapGateMarkdown`) are correct END-TO-END over
 * the real frozen corpus, every `GateVerdict` class renders, and the rendered
 * table passes the secret sweep — keeping the gate numbers honest the same way
 * 149-03's substrate "keeps the baseline numbers honest in pnpm validate,
 * keyless". It MUST NOT spend tokens, boot a daemon, or read the real `~/.comis`.
 *
 * PLACEMENT DECISION (RESEARCH A1 / Pitfall 6): the `test/live` tree is NOT in
 * the root vitest workspace (`vitest.config.ts:10` -> projects:
 * "packages/*", "test/architecture", "scripts/contracts"), so this file does
 * NOT run in the bare `pnpm test` / root `pnpm validate` run. It runs under the
 * LIVE config (`test/live/vitest.config.ts`, whose include glob covers the live
 * tree) via `pnpm test:live`. The pure scorers
 * it exercises are ALSO RED-first unit-tested in their own
 * `fleet-recurrence-gate.test.ts` / `fleet-triage-corpus.test.ts` (Plan 01),
 * which is the placement that guarantees the verdict logic is covered keylessly;
 * this substrate adds the end-to-end "scorers over the real frozen corpus" pass
 * the live tier exercises. It is intentionally KEYLESS so it stays green under
 * the live config with no API key.
 *
 * Run (keyless, always GREEN — no env, no key):
 *   pnpm vitest run --config test/live/vitest.config.ts \
 *     test/live/scenarios/prove/fleet-gate-substrate.test.ts
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCorpus,
  type FleetSignal,
} from "../../support/fleet-triage-corpus.js";
import {
  recordSignalRecurrence,
  buildGapGateTable,
  renderGapGateMarkdown,
  RECURRENCE_THRESHOLD,
  type GapGateRow,
} from "../../support/fleet-recurrence-gate.js";
import { assertNoSecrets } from "../../cost.js";

// fileURLToPath(import.meta.url) is robust across vitest pool modes (the
// diagnosis-baseline.test.ts:62 idiom) — preferred over a bare __dirname.
const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirnameLocal, "../../fixtures/fleet-triage");

// ===========================================================================
// The frozen Plan-02 corpus loads and carries the load-bearing M1 signals.
// ===========================================================================

describe("FLEET-gate substrate — the frozen M1 corpus loads and is well-formed", () => {
  it("loadCorpus returns all 6 FleetSignal members with the by-hand reference counts", () => {
    const corpus = loadCorpus(FIXTURES_DIR);
    expect(corpus.signals.length).toBe(6);

    const byName = new Map<FleetSignal["signal"], FleetSignal>(
      corpus.signals.map((s) => [s.signal, s]),
    );

    // The milestone's FLAGSHIP signal: LCD-ingest-skipped, ×7 by hand, log-only.
    const lcd = byName.get("lcd-ingest-skipped");
    expect(lcd?.byHandCount).toBe(7);
    expect(lcd?.location).toBe("daemon.log");
    expect(lcd?.alreadyStructured).toBe(false);

    // The ALREADY-STRUCTURED contrast item: session-degradation is queryable today.
    const degradation = byName.get("session-degradation");
    expect(degradation?.alreadyStructured).toBe(true);

    // The OUT-OF-SCOPE deferred item: model-health lands on native stdout.
    const model = byName.get("model-health-deferred");
    expect(model?.location).toBe("native-stdout");
  });

  it("the manual cost-to-beat (the RE-PROVE bar) is present and well-formed", () => {
    const corpus = loadCorpus(FIXTURES_DIR);
    expect(Object.keys(corpus.manualCost.severityHistogram).length).toBeGreaterThan(0);
    expect(corpus.manualCost.groupByMessage.length).toBeGreaterThan(0);
    expect(corpus.manualCost.pm2ModelScrape.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// A SYNTHETIC measured-count map (fixed inputs — NOT real data) drives the
// scorers and renders every GateVerdict class.
// ===========================================================================

describe("FLEET-gate substrate — the scorers render every verdict class over the frozen corpus", () => {
  /**
   * Build a synthetic measured map exercising each verdict branch deterministically:
   *  - lcd-ingest-skipped: realCount >= threshold + exercised → INSTRUMENT-160
   *  - mcp-reconnect:      realCount 0 + UN-exercised        → INCONCLUSIVE
   *  - config-posture:     realCount 0 + exercised           → SKIP-NEVER-RECURS
   *  - session-degradation: alreadyStructured (corpus)        → ALREADY-STRUCTURED
   *  - model-health-deferred: out-of-scope (signal name)      → OUT-OF-SCOPE
   *  - budget-exceeded:    (absent from map → default 0/un-exercised) → INCONCLUSIVE
   * These are FIXED test inputs — the substrate never reads the real ~/.comis.
   */
  function syntheticMeasured(): Map<
    FleetSignal["signal"],
    { realCount: number; pathExercised: boolean; outOfScope?: boolean }
  > {
    return new Map([
      ["lcd-ingest-skipped", { realCount: RECURRENCE_THRESHOLD + 4, pathExercised: true }],
      ["mcp-reconnect", { realCount: 0, pathExercised: false }],
      ["config-posture", { realCount: 0, pathExercised: true }],
      // session-degradation / model-health-deferred / budget-exceeded omitted or
      // governed by the corpus flags — the scorer derives their verdicts.
      ["session-degradation", { realCount: 0, pathExercised: true }],
      ["model-health-deferred", { realCount: 0, pathExercised: false }],
    ]);
  }

  it("recordSignalRecurrence + buildGapGateTable produce the expected per-signal verdicts", () => {
    const corpus = loadCorpus(FIXTURES_DIR);
    const rows: GapGateRow[] = buildGapGateTable(
      recordSignalRecurrence(corpus.signals, syntheticMeasured()),
    );
    const verdictOf = (s: FleetSignal["signal"]) =>
      rows.find((r) => r.signal === s)?.verdict;

    expect(verdictOf("lcd-ingest-skipped")).toBe("INSTRUMENT-160");
    expect(verdictOf("mcp-reconnect")).toBe("INCONCLUSIVE");
    expect(verdictOf("config-posture")).toBe("SKIP-NEVER-RECURS");
    expect(verdictOf("session-degradation")).toBe("ALREADY-STRUCTURED");
    expect(verdictOf("model-health-deferred")).toBe("OUT-OF-SCOPE");
    // budget-exceeded was absent from the map → tolerant default (0/un-exercised).
    expect(verdictOf("budget-exceeded")).toBe("INCONCLUSIVE");
  });

  it("the rendered markdown carries the CAVEAT, the table header, every verdict class, and passes the secret sweep", () => {
    const corpus = loadCorpus(FIXTURES_DIR);
    const rows = buildGapGateTable(
      recordSignalRecurrence(corpus.signals, syntheticMeasured()),
    );
    const md = renderGapGateMarkdown(rows, {
      host: "test-host",
      date: "2026-01-01",
      sinceHours: 24,
    });

    // The data-scoped CAVEAT block (the WARNING-PARTIAL-GATE analog).
    expect(md).toContain("CAVEAT");
    expect(md.toLowerCase()).toContain("data-dependent");
    // The markdown table header.
    expect(md).toContain("| signal |");
    // Every verdict class the synthetic map produces renders in the table.
    expect(md).toContain("INSTRUMENT-160");
    expect(md).toContain("INCONCLUSIVE");
    expect(md).toContain("ALREADY-STRUCTURED");
    expect(md).toContain("SKIP-NEVER-RECURS");
    expect(md).toContain("OUT-OF-SCOPE");

    // Residency (T-158-01-01, defense-in-depth — renderGapGateMarkdown already
    // sweeps internally; this is the substrate's own second sweep point).
    expect(() => assertNoSecrets(md, "gap-gate table")).not.toThrow();
  });

  it("a FLAGSHIP signal at realCount 0 on an un-exercised path is INCONCLUSIVE, never a confident SKIP (Pitfall 4)", () => {
    // The load-bearing guard: a 0 on the milestone's flagship LCD signal — when the
    // emitting path was NOT shown to run — must NOT be a confident SKIP-NEVER-RECURS,
    // or the gate would silently gut Phase 160. This is the false-negative the whole
    // confident-SKIP-vs-INCONCLUSIVE distinction exists to prevent.
    const corpus = loadCorpus(FIXTURES_DIR);
    const measured = new Map([
      ["lcd-ingest-skipped" as const, { realCount: 0, pathExercised: false }],
    ]);
    const rows = buildGapGateTable(recordSignalRecurrence(corpus.signals, measured));
    const lcd = rows.find((r) => r.signal === "lcd-ingest-skipped");
    expect(lcd?.verdict).toBe("INCONCLUSIVE");
    expect(lcd?.verdict).not.toBe("SKIP-NEVER-RECURS");
  });
});
