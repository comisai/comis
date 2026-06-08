// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the PURE M1 fleet-triage corpus loader
 * (Phase 158 — PROVE & gate: fleet-triage baseline, requirement M1).
 *
 * The corpus loader is the M1 half of the measure-first PROVE phase: it reads the
 * frozen triage-corpus.json + manual-cost-to-beat.json (this session's v2.14-review
 * findings, encoded as structured reference data) into a typed FleetCorpus the
 * Plan-03 gate measurement consumes. Because the gate is only as trustworthy as the
 * loader, the loader is proven RED→GREEN here BEFORE the script consumes it — the
 * `--selftest` discipline, mirroring the Phase-149 diagnosis-harness.test.ts loader
 * tests (the EXACT analog).
 *
 * CRITICAL DIVERGENCE from 149 (RESEARCH Pitfall 1): M1 is an ENCODING of
 * already-written prose (FLEET_HEALTH_LENS_PHASE.md §2), NOT a reconstruction from a
 * rotating daemon.log. loadCorpus reads a STATIC frozen JSON fixture; there is no
 * trajectory.jsonl to parse and no daemon to re-run.
 *
 * NOTE on the run command (RESEARCH Pitfall 6): these `support/*.test.ts` files are
 * NOT in the ROOT vitest workspace (`projects: ["packages/*", ...]`), so a bare
 * `pnpm vitest run` resolves the root config and runs NOTHING (a false-RED). Verify
 * under the LIVE config:
 *   pnpm vitest run --config test/live/vitest.config.ts test/live/support/fleet-triage-corpus.test.ts
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCorpus,
  type FleetSignal,
  type ManualCostToBeat,
} from "./fleet-triage-corpus.js";

// Track every tmp dir we seed so afterEach can tear them down — NEVER touch ~/.comis
// (Phase-155 no-prod-datadir rule; these unit tests use mkdtempSync tmp dirs only).
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

// A well-formed M1 corpus — the §2 by-hand findings as a FleetSignal[]. The
// load-bearing fields the shape-guard asserts: signal / byHandCount / location /
// alreadyStructured. Counts + typed enums only — NEVER raw log bodies.
const SIGNALS: FleetSignal[] = [
  {
    signal: "lcd-ingest-skipped",
    byHandCount: 7,
    location: "daemon.log",
    alreadyStructured: false,
    errorKind: "precondition",
  },
  {
    signal: "config-posture",
    byHandCount: 2,
    location: "daemon.log",
    alreadyStructured: false,
    errorKind: "config",
  },
  {
    signal: "mcp-reconnect",
    byHandCount: 5,
    location: "trajectory.jsonl",
    alreadyStructured: false,
    errorKind: "mcp",
  },
  {
    signal: "session-degradation",
    byHandCount: 9,
    location: "obs_diagnostics",
    alreadyStructured: true,
  },
  {
    signal: "model-health-deferred",
    byHandCount: 1,
    location: "native-stdout",
    alreadyStructured: false,
  },
];

// The §2 "cost/effort to beat" — the RE-PROVE bar (Phase 162 P1). Counts + a
// described scrape STEP (not raw model output), PII-free by construction.
const MANUAL_COST: ManualCostToBeat = {
  severityHistogram: { warning: 7, error: 0, info: 12 },
  groupByMessage: [
    { message: "LCD ingest skipped: live/store divergence", count: 7 },
    { message: "MCP client error", count: 5 },
  ],
  pm2ModelScrape:
    "pm2 logs comis --nostream | grep tokenizer — manual model-health scrape (the step the lens must replace)",
};

describe("fleet-triage-corpus loadCorpus — reads the frozen M1 corpus into a typed bundle", () => {
  it("loadCorpus parses triage-corpus.json + manual-cost-to-beat.json from a seeded directory", () => {
    const dir = seedDir("fleet-corpus-ok-");
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify({ signals: SIGNALS }));
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    const corpus = loadCorpus(dir);
    // signals[] carry the load-bearing fields.
    expect(corpus.signals).toHaveLength(5);
    const lcd = corpus.signals.find((s) => s.signal === "lcd-ingest-skipped");
    expect(lcd).toBeDefined();
    expect(lcd!.byHandCount).toBe(7);
    expect(lcd!.location).toBe("daemon.log");
    expect(lcd!.alreadyStructured).toBe(false);
    // manualCost carries the three §2 fields.
    expect(corpus.manualCost.severityHistogram["warning"]).toBe(7);
    expect(corpus.manualCost.groupByMessage).toHaveLength(2);
    expect(corpus.manualCost.pm2ModelScrape).toContain("model-health scrape");
  });

  it("loadCorpus throws PATH-ONLY when triage-corpus.json is malformed JSON (no body echo)", () => {
    const dir = seedDir("fleet-corpus-bad-corpus-");
    // A committed fixture MUST be well-formed — a malformed corpus is a corrupt artifact.
    writeFileSync(join(dir, "triage-corpus.json"), "{not json");
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    // The throw cites the filename (residency rule: path only, never the body).
    expect(() => loadCorpus(dir)).toThrow(/triage-corpus\.json/);
    // Defense: the malformed body text must NOT appear in the thrown message.
    expect(() => loadCorpus(dir)).not.toThrow(/not json/);
  });

  it("loadCorpus throws PATH-ONLY on a JSON-valid corpus whose signals[] is empty (shape-guard)", () => {
    const dir = seedDir("fleet-corpus-empty-signals-");
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify({ signals: [] }));
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    expect(() => loadCorpus(dir)).toThrow(/triage-corpus\.json/);
  });

  it("loadCorpus throws PATH-ONLY on a corpus whose entries lack a load-bearing field (shape-guard)", () => {
    const dir = seedDir("fleet-corpus-missing-field-");
    // A JSON-valid signal missing `alreadyStructured` (and a non-number byHandCount)
    // passes parsing but is a malformed artifact — it must be caught at load time with
    // the file path, not detonate downstream in the gate scorer.
    writeFileSync(
      join(dir, "triage-corpus.json"),
      JSON.stringify({ signals: [{ signal: "lcd-ingest-skipped", byHandCount: "seven", location: "daemon.log" }] }),
    );
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    expect(() => loadCorpus(dir)).toThrow(/triage-corpus\.json/);
  });

  it("loadCorpus throws PATH-ONLY when manual-cost-to-beat.json is malformed (surfaces its filename)", () => {
    const dir = seedDir("fleet-corpus-bad-cost-");
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify({ signals: SIGNALS }));
    writeFileSync(join(dir, "manual-cost-to-beat.json"), "this-is-not-json");

    // The throw cites manual-cost-to-beat.json (path only).
    expect(() => loadCorpus(dir)).toThrow(/manual-cost-to-beat\.json/);
  });

  it("loadCorpus throws PATH-ONLY on a manual-cost whose load-bearing fields are missing/mis-typed", () => {
    const dir = seedDir("fleet-corpus-cost-shape-");
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify({ signals: SIGNALS }));
    // severityHistogram present but groupByMessage missing + pm2ModelScrape wrong-typed.
    writeFileSync(
      join(dir, "manual-cost-to-beat.json"),
      JSON.stringify({ severityHistogram: { warning: 7 }, pm2ModelScrape: 42 }),
    );

    expect(() => loadCorpus(dir)).toThrow(/manual-cost-to-beat\.json/);
  });
});
