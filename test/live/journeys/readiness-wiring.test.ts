// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-05 — per-story determinism + lifecycle + READINESS wiring.
 *
 * - journeyResultToVerdict maps a per-story JourneyResult → a CategoryVerdict;
 * - a Record<storyId, CategoryVerdict> writes through the rig writeReadiness
 *   (per-story result in READINESS.md), secret-free;
 * - determinism.{runs,passRateThreshold} feed the rig computePassRate; a
 *   models array yields a (scenario×model) grid via buildScenarioModelGrid;
 * - activeStoriesForRun filters deprecated + __-prefixed test-only ids.
 *
 * All deterministic, no daemon, no provider. TDD: fails until lifecycle.ts exists.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journeyResultToVerdict, activeStoriesForRun } from "./lifecycle.js";
// Import from the barrel (registry.js) — it triggers the 8 seed registrations,
// so getStory("US-01…") + activeStoriesForRun see the seeds. registry-core.js
// alone would NOT register the seeds (they self-register via the barrel imports).
import { registerStory, getStory } from "./registry.js";
import { writeReadiness, type CategoryVerdict } from "../report.js";
import { computePassRate, buildScenarioModelGrid, type RunRow } from "../stats.js";
import type { JourneyResult, UserStory } from "./types.js";

// ---------------------------------------------------------------------------
// journeyResultToVerdict
// ---------------------------------------------------------------------------

describe("journeyResultToVerdict — JourneyResult → CategoryVerdict", () => {
  it("passed → CERTIFIED", () => {
    expect(journeyResultToVerdict({ storyId: "x", status: "passed" })).toBe("CERTIFIED");
  });

  it("failed → BLOCKED", () => {
    expect(journeyResultToVerdict({ storyId: "x", status: "failed" })).toBe("BLOCKED");
  });

  it("skipped → SKIPPED(<reason-tag>) derived from the reason", () => {
    const v = journeyResultToVerdict({
      storyId: "x",
      status: "skipped",
      reason: "requires platform linux — SKIPPED(linux-only)",
    });
    expect(v).toMatch(/^SKIPPED\(/);
  });

  it("skipped with a gated reason → SKIPPED(gated)", () => {
    const v = journeyResultToVerdict({
      storyId: "x",
      status: "skipped",
      reason: "gated: component Stage-C cert deferred (MEM-StageC)",
    });
    expect(v).toBe("SKIPPED(gated)");
  });
});

// ---------------------------------------------------------------------------
// per-story READINESS write-back
// ---------------------------------------------------------------------------

describe("per-story READINESS — writeReadiness round-trip", () => {
  it("writes a Record<storyId, CategoryVerdict> to READINESS.md, secret-free", () => {
    const results: JourneyResult[] = [
      { storyId: "US-01-RESEARCH-RECALL", status: "passed" },
      { storyId: "US-07-TERMINAL-DRIVEN", status: "skipped", reason: "SKIPPED(linux-only)" },
      { storyId: "US-04-MULTI-AGENT-DAG", status: "failed" },
    ];
    const record: Record<string, CategoryVerdict> = {};
    for (const r of results) record[r.storyId] = journeyResultToVerdict(r);

    const dir = mkdtempSync(join(tmpdir(), "journeys-readiness-"));
    const out = join(dir, "READINESS.md");
    expect(() => writeReadiness(record, out)).not.toThrow();

    const content = readFileSync(out, "utf-8");
    expect(content).toContain("US-01-RESEARCH-RECALL");
    expect(content).toContain("CERTIFIED");
    expect(content).toContain("US-07-TERMINAL-DRIVEN");
    expect(content).toContain("BLOCKED");
  });
});

// ---------------------------------------------------------------------------
// determinism — N-run pass-rate + (scenario × model) grid (reuse stats.ts)
// ---------------------------------------------------------------------------

describe("determinism — runs/passRateThreshold feed computePassRate; models feed the grid", () => {
  it("a seed's determinism.runs/passRateThreshold drive computePassRate", () => {
    const j1 = getStory("US-01-RESEARCH-RECALL")!;
    expect(j1.determinism.runs).toBeGreaterThan(0);
    expect(j1.determinism.passRateThreshold).toBeGreaterThan(0);
    // 4/5 pass → a PassRateResult { rate, n } (shape, not a brittle CI).
    const res = computePassRate([true, true, true, true, false]);
    expect(res.rate).toBeCloseTo(0.8, 5);
    expect(res.n).toBe(5);
  });

  it("a models array yields a multi-cell (scenario × model) grid", () => {
    const rows: RunRow[] = [
      { scenarioId: "US-01-RESEARCH-RECALL", model: "claude", passed: true },
      { scenarioId: "US-01-RESEARCH-RECALL", model: "gpt", passed: false },
    ];
    const grid = buildScenarioModelGrid(rows);
    expect(grid["US-01-RESEARCH-RECALL"]!["claude"]!.passed).toBe(1);
    expect(grid["US-01-RESEARCH-RECALL"]!["gpt"]!.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// lifecycle — activeStoriesForRun filters deprecated + __-prefixed test ids
// ---------------------------------------------------------------------------

describe("activeStoriesForRun — lifecycle filter", () => {
  it("excludes a deprecated story and a __-prefixed test-only id; includes active seeds", () => {
    // Unique ids (suffix) so a vitest retry never collides on the module-global library.
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const depId = `US-TEST-DEPRECATED-${sfx}`;
    const testOnlyId = `__test__lifecycle-skip-${sfx}`;
    const dep: UserStory = {
      id: depId,
      story: "deprecated",
      tags: ["A"],
      dimensions: [],
      requires: {},
      costTier: "$0",
      determinism: { runs: 1, passRateThreshold: 1 },
      steps: [{ verb: "send_text", text: "x" }],
      acceptance: { outcomes: [], rubric: "x" },
      status: "deprecated",
    };
    const testOnly: UserStory = { ...dep, id: testOnlyId, status: "active" };
    registerStory(dep);
    registerStory(testOnly);

    const active = activeStoriesForRun();
    const ids = active.map((s) => s.id);
    expect(ids).not.toContain(depId); // deprecated excluded
    expect(ids).not.toContain(testOnlyId); // test-only excluded
    expect(ids).toContain("US-01-RESEARCH-RECALL"); // active seed included
  });

  it("a quarantined story IS included (measured-non-blocking)", () => {
    const quarId = `US-TEST-QUARANTINED-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const quar: UserStory = {
      id: quarId,
      story: "quarantined",
      tags: ["A"],
      dimensions: [],
      requires: {},
      costTier: "$0",
      determinism: { runs: 1, passRateThreshold: 1 },
      steps: [{ verb: "send_text", text: "x" }],
      acceptance: { outcomes: [], rubric: "x" },
      status: "quarantined",
    };
    registerStory(quar);
    expect(activeStoriesForRun().map((s) => s.id)).toContain(quarId);
  });
});
