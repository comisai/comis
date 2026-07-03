// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-03 — coverage auto-wiring + requires→skip gating.
 *
 * (a) Every seed story's tags (Cat A–V) auto-contribute to the story-coverage
 *     view (tags + dimensions contribute to the coverage matrix via a
 *     VIEW — NOT new COVERAGE_DIMENSIONS rows).
 * (b) requires→skip-with-reason, never fail — the universal skip ≠ fail invariant,
 *     with a positive control over EVERY seed.
 * (c) the no-pollution lock: COVERAGE_DIMENSIONS gains no journey/Cat rows.
 *
 * All deterministic, no daemon, no provider. TDD: locks the invariants.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { getStories, storyCoverageContributions } from "./registry.js";
import { runJourney } from "./journey-runner.js";
import { buildCredentialRegistry } from "../credentials.js";
import {
  COVERAGE_DIMENSIONS,
  storyCoverageContributions as matrixStoryCoverage,
} from "../coverage-matrix.js";

const creds = buildCredentialRegistry();

// ---------------------------------------------------------------------------
// (a) tags auto-contribute to the coverage view
// ---------------------------------------------------------------------------

describe("coverage auto-wiring — story tags flow into the story-coverage view", () => {
  it("every registered story contributes one entry with its tags + dimensions", () => {
    const cov = storyCoverageContributions();
    const stories = getStories();
    expect(cov.length).toBe(stories.length);
    for (const s of stories) {
      const entry = cov.find((c) => c.storyId === s.id)!;
      expect(entry.tags).toEqual([...s.tags]);
      expect(entry.dimensions).toEqual([...s.dimensions]);
    }
  });

  it("the union of contributed tags spans the journeys' subsystems (incl. T from J7, N from J1)", () => {
    const allTags = new Set(storyCoverageContributions().flatMap((c) => c.tags));
    // J7 terminal-driver (T), J1 search/web (N), media (L/M), multi-agent (H/I).
    for (const tag of ["T", "N", "L", "M", "H", "I"]) {
      expect(allTags.has(tag as never), `tag ${tag} should be contributed by a seed`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) requires→skip gating (never fails) — over real seeds
// ---------------------------------------------------------------------------

describe("requires→skip-with-reason, never fail (the universal invariant)", () => {
  it("J7 (US-07, platform:linux) → skipped(linux) on macOS, NEVER throws", async () => {
    const j7 = getStories().find((s) => s.id === "US-07-TERMINAL-DRIVEN")!;
    const r = await runJourney(j7, { creds, isLive: false });
    // On macOS this skips linux-only; on a Linux host it would gate on provider/
    // component instead. Either way it must skip-with-reason and never throw.
    expect(r.status).toBe("skipped");
    expect(r.reason).toBeTruthy();
  });

  it("a component-cert seed (e.g. US-01 components:[WEB-StageC,MEM-StageC]) → skipped(gated) without isLive", async () => {
    const j1 = getStories().find((s) => s.id === "US-01-RESEARCH-RECALL")!;
    const r = await runJourney(j1, { creds, isLive: false });
    expect(r.status).toBe("skipped");
    // In the keyless sandbox the FIRST unmet gate is the provider (no key); on a
    // keyed host it would be the component cert. Either reason is a valid skip.
    expect(r.reason).toMatch(/no-creds|gated|component|cert|capabilit/i);
  });

  it("POSITIVE CONTROL: EVERY seed story resolves (never rejects) and skips with a non-empty reason in the keyless sandbox", async () => {
    for (const s of getStories()) {
      const r = await runJourney(s, { creds, isLive: false });
      // No keys + no certs + (macOS) → every seed's requires gate is unmet → skipped.
      expect(r.status, `seed ${s.id} should skip in the keyless sandbox`).toBe("skipped");
      expect(r.reason, `seed ${s.id} should carry a non-empty skip reason`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) no-pollution lock — journeys add NO COVERAGE_DIMENSIONS rows
// ---------------------------------------------------------------------------

describe("no-pollution lock — journeys do not add COVERAGE_DIMENSIONS rows", () => {
  it("COVERAGE_DIMENSIONS contains no single-letter Cat tag (A..V) and no journey/e2e dimension", () => {
    const dims = COVERAGE_DIMENSIONS as readonly string[];
    // No single-letter Cat tag leaked in as a dimension.
    for (const d of dims) {
      expect(/^[A-V]$/.test(d)).toBe(false);
    }
    // No journey-/e2e-/US- prefixed dimension.
    expect(dims.some((d) => /^(journey\.|e2e\.|US-)/i.test(d))).toBe(false);
  });

  it("the story-coverage view is reachable from coverage-matrix.ts (one source of truth) and matches the registry view", () => {
    // E2E-03: the matrix module re-exports the auto-wiring view so the runner /
    // architecture gate / soak read it from one place.
    expect(matrixStoryCoverage().length).toBeGreaterThanOrEqual(8);
    expect(matrixStoryCoverage().length).toBe(storyCoverageContributions().length);
  });
});
