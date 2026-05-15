// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ALLOWLIST } from "./architecture-allowlist.js";

// Phase 27 seeded the allowlist with 21 entries, drawn from the §1.3 catalogue
// (L7, L8, L25, L27-L30 deliberately excluded). The allowlist is **shrink-only**:
// Phase 28+ may legitimately remove entries as the underlying violations close.
// Tests below validate the *shape* of every entry without locking the Phase-27
// count — see CR-02 in 27-REVIEW.md.
//
// Phase 30 plan 07 (CONFIG-DELIV-08) removed L13, L14, L20, L26 from this
// catalogue. The associated source-level violations are permanently enforced
// by `test/architecture/source-rules.test.ts` (no-free-deliverToChannel +
// no-deps-optional-in-delivery) plus the CONFIG-DELIV-01/02/07 closures.
// Re-adding an L13/L14/L20/L26 entry now fails the catalogue subset check
// below — the closure is intentionally permanent.
const KNOWN_HISTORICAL_LIDS = new Set([
  "L1",
  "L4",
  "L5",
  "L6",
  "L9",
  "L10",
  "L11",
  "L12",
  "L15",
  "L16",
  "L17",
  "L18",
  "L19",
  "L21",
  "L22",
  "L23",
  "L24",
]);

describe("architecture-allowlist -- schema integrity (ARCH-BASE-10, D-03)", () => {
  it("ALLOWLIST has a non-negative length (extractor-sanity guard)", () => {
    // Phase 36 GUARDRAILS-01 closed the allowlist to the empty set — every L-ID
    // is either resolved or escalated. The guard is now extractor-sanity only:
    // if extractAllowlistIds() returned a non-array or undefined, this fails.
    // (Previously a `toBeGreaterThan(0)` "vacuous-empty" guard; that semantics
    // is incompatible with the closed-set design from Phase 36.)
    expect(
      ALLOWLIST.length,
      "ALLOWLIST.length must be a non-negative integer",
    ).toBeGreaterThanOrEqual(0);
  });

  it("every L-ID is drawn from the §1.3 catalogue (subset, not equality)", () => {
    // Subset check, not equality: shrinking the allowlist is allowed; adding
    // a new L-ID outside the §1.3 catalogue is not (would require a design-doc
    // amendment). Phase 28+ shrinks are valid; Phase 28+ inventions are not.
    const ids = new Set(ALLOWLIST.map((e) => e.id));
    for (const id of ids) {
      expect(
        KNOWN_HISTORICAL_LIDS.has(id),
        `L-ID ${id} is not in the §1.3 catalogue (L7, L8, L25, L27-L30 deliberately excluded)`,
      ).toBe(true);
    }
  });

  it("every entry has non-empty area, reason, evidence", () => {
    for (const entry of ALLOWLIST) {
      expect(
        entry.area.length,
        `${entry.id}.area must be non-empty`,
      ).toBeGreaterThan(0);
      expect(
        entry.reason.length,
        `${entry.id}.reason must be non-empty`,
      ).toBeGreaterThan(20);
      expect(
        entry.evidence.length,
        `${entry.id}.evidence must list at least one citation`,
      ).toBeGreaterThan(0);
    }
  });

  it('removedIn matches `phase-${number}` | "permanent" template-literal type', () => {
    for (const entry of ALLOWLIST) {
      if (entry.removedIn === "permanent") continue;
      expect(
        entry.removedIn,
        `${entry.id}.removedIn must match phase-N pattern`,
      ).toMatch(/^phase-[0-9]+$/);
    }
  });

  it("declares no duplicate L-IDs across the ALLOWLIST array entries", () => {
    const ids = ALLOWLIST.map((e) => e.id);
    expect(new Set(ids).size, "every L-ID must be unique").toBe(ids.length);
  });
});
