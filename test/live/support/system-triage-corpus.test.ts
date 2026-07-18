// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the PURE system-triage corpus loader.
 *
 * The corpus loader is the by-hand-corpus half of the measure-first baseline: it reads the
 * frozen triage-corpus.json + manual-cost-to-beat.json (the by-hand system-health-review
 * findings, encoded as structured reference data) into a typed SystemCorpus the
 * gate measurement consumes. Because the gate is only as trustworthy as the
 * loader, the loader is proven RED→GREEN here BEFORE the script consumes it — the
 * `--selftest` discipline, mirroring the diagnosis-harness.test.ts loader
 * tests (the EXACT analog).
 *
 * CRITICAL DIVERGENCE: the corpus is an ENCODING of the already-written by-hand
 * system-health review, NOT a reconstruction from a rotating daemon.log. loadCorpus
 * reads a STATIC frozen JSON fixture; there is no trajectory.jsonl to parse and no
 * daemon to re-run.
 *
 * NOTE on the run command: these `support/*.test.ts` files are
 * NOT in the ROOT vitest workspace (`projects: ["packages/*", ...]`), so a bare
 * `pnpm vitest run` resolves the root config and runs NOTHING (a false-RED). Verify
 * under the LIVE config:
 *   pnpm vitest run --config test/live/vitest.config.ts test/live/support/system-triage-corpus.test.ts
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCorpus,
  type SystemSignal,
  type ManualCostToBeat,
} from "./system-triage-corpus.js";

// Track every tmp dir we seed so afterEach can tear them down — NEVER touch ~/.comis
// (no-prod-datadir rule; these unit tests use mkdtempSync tmp dirs only).
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

// A well-formed corpus — the by-hand findings as a SystemSignal[]. The
// load-bearing fields the shape-guard asserts: signal / byHandCount / location /
// alreadyStructured. Counts + typed enums only — NEVER raw log bodies.
const SIGNALS: SystemSignal[] = [
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

// The "cost/effort to beat" verification bar. Counts + a
// described scrape STEP (not raw model output), PII-free by construction.
const MANUAL_COST: ManualCostToBeat = {
  severityHistogram: { warn: 7, error: 0, info: 12 },
  groupByMessage: [
    { message: "LCD ingest skipped: live/store divergence", count: 7 },
    { message: "MCP client error", count: 5 },
  ],
  pm2ModelScrape:
    "pm2 logs comis --nostream | grep tokenizer — manual model-health scrape (the step the lens must replace)",
};

describe("system-triage-corpus loadCorpus — reads the frozen corpus into a typed bundle", () => {
  it("loadCorpus parses triage-corpus.json + manual-cost-to-beat.json from a seeded directory", () => {
    const dir = seedDir("system-corpus-ok-");
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
    // manualCost carries the three cost-to-beat fields (Pino's canonical "warn" level key,
    // matching the committed manual-cost-to-beat.json — Pino never emits "warning").
    expect(corpus.manualCost.severityHistogram["warn"]).toBe(7);
    expect(corpus.manualCost.groupByMessage).toHaveLength(2);
    expect(corpus.manualCost.pm2ModelScrape).toContain("model-health scrape");
  });

  it("loadCorpus throws PATH-ONLY when triage-corpus.json is malformed JSON (no body echo)", () => {
    const dir = seedDir("system-corpus-bad-corpus-");
    // A committed fixture MUST be well-formed — a malformed corpus is a corrupt artifact.
    writeFileSync(join(dir, "triage-corpus.json"), "{not json");
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    // The throw cites the filename (residency rule: path only, never the body).
    expect(() => loadCorpus(dir)).toThrow(/triage-corpus\.json/);
    // Defense: the malformed body text must NOT appear in the thrown message.
    expect(() => loadCorpus(dir)).not.toThrow(/not json/);
  });

  it("loadCorpus throws PATH-ONLY on a JSON-valid corpus whose signals[] is empty (shape-guard)", () => {
    const dir = seedDir("system-corpus-empty-signals-");
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify({ signals: [] }));
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    expect(() => loadCorpus(dir)).toThrow(/triage-corpus\.json/);
  });

  it("loadCorpus throws PATH-ONLY on a corpus whose entries lack a load-bearing field (shape-guard)", () => {
    const dir = seedDir("system-corpus-missing-field-");
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
    const dir = seedDir("system-corpus-bad-cost-");
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify({ signals: SIGNALS }));
    writeFileSync(join(dir, "manual-cost-to-beat.json"), "this-is-not-json");

    // The throw cites manual-cost-to-beat.json (path only).
    expect(() => loadCorpus(dir)).toThrow(/manual-cost-to-beat\.json/);
  });

  it("loadCorpus throws PATH-ONLY on a manual-cost whose load-bearing fields are missing/mis-typed", () => {
    const dir = seedDir("system-corpus-cost-shape-");
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify({ signals: SIGNALS }));
    // severityHistogram present but groupByMessage missing + pm2ModelScrape wrong-typed.
    writeFileSync(
      join(dir, "manual-cost-to-beat.json"),
      JSON.stringify({ severityHistogram: { warn: 7 }, pm2ModelScrape: 42 }),
    );

    expect(() => loadCorpus(dir)).toThrow(/manual-cost-to-beat\.json/);
  });
});

describe("system-triage-corpus loadCorpus — null/non-object roots & entries throw the documented Error, not a raw TypeError", () => {
  // The module's stated contract (JSDoc): replace the "opaque TypeError … with no fixture
  // path" with a controlled, PATH-ONLY throw. A `null` JSON root or a `[null]` entry is a
  // JSON-valid-but-mis-shaped corpus and MUST hit the documented Error (which names the
  // fixture file), NEVER the raw engine `TypeError: Cannot read properties of null`.

  it("loadCorpus throws the documented path-named Error (not a raw TypeError) on a null triage-corpus root", () => {
    const dir = seedDir("system-corpus-null-root-");
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify(null));
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    // The controlled throw names the fixture file ...
    expect(() => loadCorpus(dir)).toThrow(/triage-corpus\.json/);
    // ... and is NOT the opaque engine TypeError the guard exists to replace.
    expect(() => loadCorpus(dir)).not.toThrow(/Cannot read properties of null/);
  });

  it("loadCorpus throws the documented path-named Error (not a raw TypeError) on a [null] signal entry", () => {
    const dir = seedDir("system-corpus-null-entry-");
    // A JSON-valid, non-empty array whose only entry is `null` — dereferencing
    // entry.signal on the pre-patch loader throws the raw TypeError.
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify({ signals: [null] }));
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    expect(() => loadCorpus(dir)).toThrow(/triage-corpus\.json/);
    expect(() => loadCorpus(dir)).not.toThrow(/Cannot read properties of null/);
  });

  it("loadCorpus throws the documented path-named Error on a non-object (primitive) signal entry", () => {
    const dir = seedDir("system-corpus-primitive-entry-");
    // A bare string entry is JSON-valid but not a SystemSignal object.
    writeFileSync(
      join(dir, "triage-corpus.json"),
      JSON.stringify({ signals: ["lcd-ingest-skipped"] }),
    );
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    expect(() => loadCorpus(dir)).toThrow(/triage-corpus\.json/);
  });

  it("loadCorpus throws the documented path-named Error (not a raw TypeError) on a null manual-cost root", () => {
    const dir = seedDir("system-corpus-null-cost-");
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify({ signals: SIGNALS }));
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(null));

    expect(() => loadCorpus(dir)).toThrow(/manual-cost-to-beat\.json/);
    expect(() => loadCorpus(dir)).not.toThrow(/Cannot read properties of null/);
  });
});

describe("system-triage-corpus loadCorpus — out-of-enum signal/location values are rejected by the shape-guard", () => {
  // The README + the SystemSignal JSDoc advertise `signal`/`location` as CLOSED string
  // unions ("never a bare string"; "an out-of-enum value fails the loader's shape-guard").
  // The pre-patch guard only checks `typeof === "string"`, so a typo'd / stale signal name
  // is silently accepted and produces a spurious gate row. These tests make behavior match
  // the documented closed-union contract. The expected enum members are the source of
  // truth in system-triage-corpus.ts (SystemSignal.signal / SystemSignal.location).

  it("loadCorpus rejects a signal whose `signal` value is outside the closed SystemSignal union", () => {
    const dir = seedDir("system-corpus-bad-signal-");
    writeFileSync(
      join(dir, "triage-corpus.json"),
      JSON.stringify({
        signals: [
          {
            // a string, but NOT one of the six closed-union members
            signal: "totally-not-a-real-signal",
            byHandCount: 99,
            location: "daemon.log",
            alreadyStructured: false,
          },
        ],
      }),
    );
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    expect(() => loadCorpus(dir)).toThrow(/triage-corpus\.json/);
  });

  it("loadCorpus rejects a signal whose `location` value is outside the closed location union", () => {
    const dir = seedDir("system-corpus-bad-location-");
    writeFileSync(
      join(dir, "triage-corpus.json"),
      JSON.stringify({
        signals: [
          {
            signal: "lcd-ingest-skipped",
            byHandCount: 7,
            // a string, but NOT one of the four closed-union location members
            location: "mars.log",
            alreadyStructured: false,
          },
        ],
      }),
    );
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    expect(() => loadCorpus(dir)).toThrow(/triage-corpus\.json/);
  });

  it("loadCorpus still accepts every in-enum signal/location member (guard does not over-reject)", () => {
    const dir = seedDir("system-corpus-all-enum-ok-");
    // Exercise all six signal members and all four location members so the new union
    // guard cannot regress into rejecting a legitimate corpus.
    const allEnum: SystemSignal[] = [
      { signal: "lcd-ingest-skipped", byHandCount: 7, location: "daemon.log", alreadyStructured: false },
      { signal: "config-posture", byHandCount: 3, location: "daemon.log", alreadyStructured: false },
      { signal: "mcp-reconnect", byHandCount: 3, location: "trajectory.jsonl", alreadyStructured: false },
      { signal: "budget-exceeded", byHandCount: 0, location: "trajectory.jsonl", alreadyStructured: false },
      { signal: "session-degradation", byHandCount: 0, location: "obs_diagnostics", alreadyStructured: true },
      { signal: "model-health-deferred", byHandCount: 1, location: "native-stdout", alreadyStructured: false },
    ];
    writeFileSync(join(dir, "triage-corpus.json"), JSON.stringify({ signals: allEnum }));
    writeFileSync(join(dir, "manual-cost-to-beat.json"), JSON.stringify(MANUAL_COST));

    const corpus = loadCorpus(dir);
    expect(corpus.signals).toHaveLength(6);
  });
});
