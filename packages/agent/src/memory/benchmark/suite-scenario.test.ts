// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for the deterministic constructed-scenario builders
 * -- the adversarial / contradiction / redaction /
 * learning fixtures the 4 Comis-unique harnesses consume
 * WITHOUT any external corpus.
 *
 * UNGATED, default-CI: pure deterministic literal construction (no clock, no
 * randomness, no I/O); imports `suite-scenario.ts` so it is never a 0%-coverage
 * file under the agent all:true floor.
 *
 * SECURITY: the redaction fixtures' planted "secrets" are SYNTHETIC,
 * obviously-fake literals (`sk-FAKE…`, `*.example.test`, an all-zero phone) -- a
 * leaked fixture discloses NOTHING. The tests assert that convention so a real
 * credential can never sneak into the committed fixtures.
 *
 * ARCHITECTURE: imports the in-package pure module only -- no @comis/memory
 * (architecture-graph.test.ts:133 -- the agent↛memory cut).
 */

import { describe, it, expect } from "vitest";
import {
  buildPoisoningScenarios,
  buildContradictionPairs,
  buildRedactionHaystack,
  buildLearningEpisodes,
  type HaystackDoc,
} from "./suite-scenario.js";

/** A HaystackDoc is `{ content: string; createdAt: number }` (the loaders' shape). */
function assertHaystackDoc(doc: HaystackDoc): void {
  expect(typeof doc.content).toBe("string");
  expect(doc.content.length).toBeGreaterThan(0);
  expect(typeof doc.createdAt).toBe("number");
  expect(Number.isFinite(doc.createdAt)).toBe(true);
  expect(doc.createdAt).toBeGreaterThan(0);
}

describe("buildPoisoningScenarios -- adversarial answer-hijack fixtures", () => {
  it("returns >=1 scenario, each with benign + adversarial docs, a query, gold, and an injection directive", () => {
    const scenarios = buildPoisoningScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(1);
    for (const s of scenarios) {
      expect(s.benignDocs.length).toBeGreaterThanOrEqual(1);
      expect(s.adversarialDocs.length).toBeGreaterThanOrEqual(1);
      s.benignDocs.forEach(assertHaystackDoc);
      s.adversarialDocs.forEach(assertHaystackDoc);
      expect(typeof s.query).toBe("string");
      expect(s.query.length).toBeGreaterThan(0);
      expect(typeof s.expectedAnswerSubstring).toBe("string");
      expect(s.expectedAnswerSubstring.length).toBeGreaterThan(0);
      expect(typeof s.injectionDirective).toBe("string");
      expect(s.injectionDirective.length).toBeGreaterThan(0);
      // the benign docs carry the TRUE fact (the expected answer)
      const benignText = s.benignDocs.map((d) => d.content).join(" ");
      expect(benignText).toContain(s.expectedAnswerSubstring);
      // the adversarial docs carry the injection directive (the hijack attempt)
      const adversarialText = s.adversarialDocs.map((d) => d.content).join(" ");
      expect(adversarialText).toContain(s.injectionDirective);
    }
  });

  it("is deterministic -- two calls deep-equal", () => {
    expect(buildPoisoningScenarios()).toEqual(buildPoisoningScenarios());
  });
});

describe("buildContradictionPairs -- trust-first (older-high-trust vs newer-low-trust)", () => {
  it("returns >=1 pair where the older doc is higher-trust AND the correct answer is the older fact", () => {
    const pairs = buildContradictionPairs();
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    for (const p of pairs) {
      assertHaystackDoc(p.olderHighTrustDoc);
      assertHaystackDoc(p.newerLowTrustDoc);
      // trust bands: older is system|learned, newer is external
      expect(["system", "learned"]).toContain(p.olderHighTrustDoc.trustLevel);
      expect(p.newerLowTrustDoc.trustLevel).toBe("external");
      // THE TRUST-FIRST CONTRACT (the load-bearing assertion the KG gate consumes):
      // the older doc is EARLIER in time ...
      expect(p.olderHighTrustDoc.createdAt).toBeLessThan(p.newerLowTrustDoc.createdAt);
      // ... yet the CORRECT answer is the OLDER high-trust fact (trust-first, NOT
      // recency-first): a newer low-trust claim must NOT win.
      expect(typeof p.correctAnswerSubstring).toBe("string");
      expect(p.correctAnswerSubstring.length).toBeGreaterThan(0);
      expect(p.olderHighTrustDoc.content).toContain(p.correctAnswerSubstring);
      // and the newer low-trust doc must NOT carry the correct answer (it carries the wrong claim)
      expect(p.newerLowTrustDoc.content).not.toContain(p.correctAnswerSubstring);
      expect(typeof p.query).toBe("string");
      expect(p.query.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic -- two calls deep-equal", () => {
    expect(buildContradictionPairs()).toEqual(buildContradictionPairs());
  });
});

describe("buildRedactionHaystack -- planted SYNTHETIC secrets", () => {
  it("returns docs embedding the planted secrets + a query, and lists every planted secret", () => {
    const h = buildRedactionHaystack();
    expect(h.docs.length).toBeGreaterThanOrEqual(1);
    h.docs.forEach(assertHaystackDoc);
    expect(h.plantedSecrets.length).toBeGreaterThanOrEqual(1);
    expect(typeof h.query).toBe("string");
    expect(h.query.length).toBeGreaterThan(0);
    // every planted secret actually appears in at least one doc (so the harness can
    // measure whether the shipped mitigations keep it OUT of the recalled context)
    const allText = h.docs.map((d) => d.content).join("\n");
    for (const secret of h.plantedSecrets) {
      expect(allText).toContain(secret);
    }
  });

  it("SECURITY: every planted secret is SYNTHETIC, obviously-fake (never a real credential)", () => {
    const h = buildRedactionHaystack();
    // At least one realistic shape of each: an API-key-like token, an email, a phone.
    // The key-like token MUST be the obviously-fake `sk-FAKE` family; emails MUST be
    // on a `.example`/`.test` reserved domain; phones MUST be the all-zero fixture.
    const hasFakeKey = h.plantedSecrets.some((s) => s.includes("sk-FAKE"));
    const hasExampleEmail = h.plantedSecrets.some((s) => /@example\.(test|com)$/.test(s));
    const hasZeroPhone = h.plantedSecrets.some((s) => /^\+1?0{8,}$/.test(s.replace(/[^\d+]/g, "")));
    expect(hasFakeKey).toBe(true);
    expect(hasExampleEmail).toBe(true);
    expect(hasZeroPhone).toBe(true);
    // No planted secret may look like a *real* high-entropy provider token: every
    // key-shaped secret here must carry the FAKE marker so a leak is harmless.
    for (const s of h.plantedSecrets) {
      if (s.startsWith("sk-")) {
        expect(s).toContain("FAKE");
      }
    }
  });

  it("is deterministic -- two calls deep-equal", () => {
    expect(buildRedactionHaystack()).toEqual(buildRedactionHaystack());
  });
});

describe("buildLearningEpisodes -- FEED rank-lift fixture", () => {
  it("returns docs + a fixed query + the gold doc index + an episode count", () => {
    const e = buildLearningEpisodes();
    expect(e.docs.length).toBeGreaterThanOrEqual(1);
    e.docs.forEach(assertHaystackDoc);
    expect(typeof e.query).toBe("string");
    expect(e.query.length).toBeGreaterThan(0);
    // the gold doc index is in range
    expect(Number.isInteger(e.goldDocIndex)).toBe(true);
    expect(e.goldDocIndex).toBeGreaterThanOrEqual(0);
    expect(e.goldDocIndex).toBeLessThan(e.docs.length);
    // multiple episodes so a FEED loop can measure rank lift across repetitions
    expect(Number.isInteger(e.episodes)).toBe(true);
    expect(e.episodes).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic -- two calls deep-equal", () => {
    expect(buildLearningEpisodes()).toEqual(buildLearningEpisodes());
  });
});

describe("all builders -- prototype-pollution safety", () => {
  it("constructing every scenario does not pollute Object.prototype", () => {
    buildPoisoningScenarios();
    buildContradictionPairs();
    buildRedactionHaystack();
    buildLearningEpisodes();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).injectionDirective).toBeUndefined();
  });
});
