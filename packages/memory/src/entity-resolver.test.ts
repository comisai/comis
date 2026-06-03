// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { normalizeEntityKey, nameSimilarity } from "./entity-resolver.js";

// =====================================================================
// normalizeEntityKey — Unicode-correct canonical-key folding
//
// The criterion's exact examples. SQLite lower() is ASCII-only, so dedup is
// done against this TS-computed key. These assertions pin the
// Turkish-İ / accent / Cyrillic / CJK behavior a reviewer questions.
// =====================================================================

describe("normalizeEntityKey — Unicode canonical-key folding", () => {
  it("folds the Turkish-İ ISTANBUL variants to one canonical key 'istanbul'", () => {
    // The headline case: dotted-İ (Turkish) and ASCII I must collapse
    // to the SAME key, so "İSTANBUL" and "istanbul" are one entity, not two.
    expect(normalizeEntityKey("İSTANBUL")).toBe("istanbul");
    expect(normalizeEntityKey("İstanbul")).toBe("istanbul");
    expect(normalizeEntityKey("ISTANBUL")).toBe("istanbul");
    expect(normalizeEntityKey("istanbul")).toBe("istanbul");
    expect(normalizeEntityKey("  Istanbul  ")).toBe("istanbul");
  });

  it("folds accented café / CAFÉ / Cafe variants to one ASCII key 'cafe'", () => {
    expect(normalizeEntityKey("CAFÉ")).toBe("cafe");
    expect(normalizeEntityKey("café")).toBe("cafe");
    expect(normalizeEntityKey("Cafe")).toBe("cafe");
  });

  it("folds Cyrillic ПРИВЕТ / привет case-variants to one non-empty key", () => {
    const upper = normalizeEntityKey("ПРИВЕТ");
    const lower = normalizeEntityKey("привет");
    expect(upper).toBe(lower);
    expect(upper.length).toBeGreaterThan(0);
  });

  it("returns a stable non-empty key for a CJK string, idempotent under re-apply", () => {
    const once = normalizeEntityKey("東京");
    expect(once.length).toBeGreaterThan(0);
    // Re-applying the normalizer to its own output must not change it.
    expect(normalizeEntityKey(once)).toBe(once);
  });

  it("returns the empty string for empty / whitespace-only input", () => {
    expect(normalizeEntityKey("")).toBe("");
    expect(normalizeEntityKey("   ")).toBe("");
  });

  it("is idempotent for the ASCII case (re-apply yields the same key)", () => {
    const key = normalizeEntityKey("  Globex Corp  ");
    expect(normalizeEntityKey(key)).toBe(key);
  });

  it("folds two coreference-resolved name variants onto ONE canonical key (dedup fold)", () => {
    // Coreference supplies cleaner entities[].name strings ("she"/"my boss" -> "Alice").
    // Even if the model emits slightly different surface forms before settling on a canonical
    // spelling, they must fold to the SAME (tenant, agent, canonical_key) row — the exact-key
    // reuse short-circuit at sqlite-memory-entity-store.ts:165-172. No downstream change makes
    // this happen; it is purely the canonical-key transform the resolver already keys on.
    const canonical = normalizeEntityKey("Alice");
    expect(normalizeEntityKey("alice")).toBe(canonical);
    expect(normalizeEntityKey("  Alice  ")).toBe(canonical);
    expect(normalizeEntityKey("ALICE")).toBe(canonical);
    expect(normalizeEntityKey("Alíce")).toBe(canonical); // accented variant -> same NFKD key
    expect(canonical).toBe("alice");
    expect(canonical.length).toBeGreaterThan(0); // a real name, never the empty-key guard (:144-151)
  });
});

// =====================================================================
// nameSimilarity — deterministic Dice-bigram fuzzy scorer
//
// Used by the resolver at threshold 0.6 to reuse an existing entity
// for a near-duplicate (typo) mention. Identical normalized keys short-circuit
// to 1.0. The scorer is pure + deterministic (no Math.random / Date.now).
// =====================================================================

describe("nameSimilarity — Dice-bigram fuzzy scorer", () => {
  it("scores an identical name as exactly 1 (normalized-key short-circuit)", () => {
    expect(nameSimilarity("istanbul", "istanbul")).toBe(1);
  });

  it("scores case/script variants as exactly 1 because it normalizes BEFORE scoring", () => {
    // İSTANBUL and istanbul normalize to the same key → short-circuit 1.0.
    expect(nameSimilarity("İSTANBUL", "istanbul")).toBe(1);
    expect(nameSimilarity("CAFÉ", "cafe")).toBe(1);
  });

  it("scores a single-character typo of an 8+ char name at or above the 0.6 threshold", () => {
    // "Globex Corp" vs "Globx Corp" — one dropped char. Must clear 0.6 so the
    // resolver reuses the existing entity instead of minting a duplicate.
    expect(nameSimilarity("Globex Corp", "Globx Corp")).toBeGreaterThanOrEqual(0.6);
  });

  it("scores two unrelated names below the 0.6 threshold", () => {
    expect(nameSimilarity("Acme", "Lisbon")).toBeLessThan(0.6);
  });

  it("is symmetric: nameSimilarity(a,b) === nameSimilarity(b,a)", () => {
    const ab = nameSimilarity("Globex Corp", "Globx Corp");
    const ba = nameSimilarity("Globx Corp", "Globex Corp");
    expect(ab).toBe(ba);
  });

  it("is deterministic: repeated calls with the same inputs return the same score", () => {
    const first = nameSimilarity("Initech Industries", "Initech Industrees");
    const second = nameSimilarity("Initech Industries", "Initech Industrees");
    expect(first).toBe(second);
  });

  it("returns 0 when both normalized keys are too short to form any bigram", () => {
    // Single-character names produce no bigrams; the denominator guard returns 0
    // (and they are not equal, so the short-circuit does not apply).
    expect(nameSimilarity("a", "b")).toBe(0);
  });
});
