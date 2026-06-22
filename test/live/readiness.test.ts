// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for readiness.ts — the honest READINESS generator (PROVE-04/05 + the
 * §16 DoD headline artifact).
 *
 * The keyless sandbox build (isLive:false, no real keys) must be HONEST: every
 * category A..V has a verdict, NO category is faked CERTIFIED, Cat T + Linux-only
 * are SKIPPED(linux/bwrap), the Cat A/J session-index path is PARTIAL noting the
 * pi-event-bridge product bug, and the written file is secret-free.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReadinessRecord, writeReadinessReport } from "./readiness.js";

const ALL_CATEGORIES = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K",
  "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V",
] as const;

describe("buildReadinessRecord — keyless sandbox build (honest)", () => {
  it("has a verdict for EVERY category A..V", () => {
    const { categories } = buildReadinessRecord({ isLive: false });
    for (const cat of ALL_CATEGORIES) {
      expect(categories, `category ${cat} must have a verdict`).toHaveProperty(cat);
      expect(typeof categories[cat]).toBe("string");
    }
  });

  it("NO category is CERTIFIED in the keyless build (the honesty gate)", () => {
    const { categories } = buildReadinessRecord({ isLive: false });
    for (const [cat, verdict] of Object.entries(categories)) {
      expect(verdict, `category ${cat} must not be faked CERTIFIED in the keyless build`).not.toBe("CERTIFIED");
    }
  });

  it("most categories are PARTIAL (deterministic Stage-A/B certified; real-provider Stage-C deferred)", () => {
    const { categories } = buildReadinessRecord({ isLive: false });
    const partials = Object.values(categories).filter((v) => v === "PARTIAL");
    expect(partials.length).toBeGreaterThan(0);
  });

  it("Cat T (terminal driver, Linux+bwrap) is SKIPPED(linux/bwrap)", () => {
    const { categories } = buildReadinessRecord({ isLive: false });
    expect(categories["T"]).toMatch(/^SKIPPED\(/);
    expect(categories["T"]).toMatch(/linux|bwrap/i);
  });

  it("the Cat A/J session-index path records the pi-event-bridge product-bug reason", () => {
    const { categories, reasons } = buildReadinessRecord({ isLive: false });
    // A + J stay PARTIAL (not faked), and a reason names the deferred product bug.
    expect(categories["A"]).toBe("PARTIAL");
    expect(categories["J"]).toBe("PARTIAL");
    const joined = (reasons["A"] ?? "") + (reasons["J"] ?? "");
    expect(joined).toMatch(/pi-event-bridge|COMIS_DATA_DIR|session-index/i);
  });
});

describe("buildReadinessRecord — Cat K (Channels) reports an honest Stage-B-certified verdict (DOC-01)", () => {
  it("Cat K carries the Stage-B-certified reason — the HONEST middle, distinct from the generic PARTIAL reason", () => {
    const { categories, reasons } = buildReadinessRecord({ isLive: false });
    // The channel surface is Stage-B certified (the v2.28 milestone): Cat K's REASON
    // says so explicitly. RED-first (Pitfall 2): before the Cat-K wiring, Cat K gets
    // the generic PARTIAL reason and this `Stage-B certified` match FAILS — flip to
    // green by assigning CHANNELS_STAGE_B_REASON. The reason names the deterministic
    // surfaces that are green and the operator-gated Stage-C legs.
    expect(reasons["K"], "Cat K reason must certify the channel surface Stage-B").toMatch(/Stage-B certified/);
    expect(reasons["K"]).toMatch(/group\/forum|fallback|classification|reconfigure/);
    expect(reasons["K"], "Stage-C must stay operator-gated, not claimed").toMatch(/Stage-C|operator-gated|COMIS_LIVE/);
    // It is a DISTINCT reason — NOT the generic "Stage-C deferred to an operator live
    // run" partial reason every other deferred category carries.
    expect(reasons["K"]).not.toBe(
      "deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux, §20)",
    );
  });

  it("Cat K's VERDICT stays a non-CERTIFIED honest middle (the !isLive honesty gate is intact)", () => {
    const { categories } = buildReadinessRecord({ isLive: false });
    // Stage-B certified is carried by the REASON; the VERDICT must NOT be a faked
    // CERTIFIED in the keyless build (green-by-omission is forbidden — T-208-21).
    expect(categories["K"], "Cat K must not be faked CERTIFIED in the keyless build").not.toBe("CERTIFIED");
    expect(categories["K"]).toBe("PARTIAL");
  });
});

describe("writeReadinessReport — writes an honest, secret-free READINESS.md", () => {
  it("writes every category + per-story verdicts; no CERTIFIED; secret-free", () => {
    const dir = mkdtempSync(join(tmpdir(), "readiness-test-"));
    const out = join(dir, "READINESS.md");
    expect(() => writeReadinessReport({ isLive: false }, out)).not.toThrow();

    const content = readFileSync(out, "utf-8");
    // every category letter present
    for (const cat of ALL_CATEGORIES) {
      expect(content).toContain(`| ${cat} `);
    }
    // a PARTIAL verdict present (the honest sandbox state)
    expect(content).toContain("PARTIAL");
    // at least one per-story US- id present
    expect(content).toMatch(/US-0[1-8]/);
    // NO faked CERTIFIED VERDICT in the keyless build (the honesty gate is about
    // verdict cells `| CERTIFIED |`, not the word appearing in explanatory prose —
    // the Reasons section legitimately says "no category is faked CERTIFIED").
    expect(content).not.toMatch(/\|\s*CERTIFIED\s*\|/);
    // secret-free — no api-key / Bearer shapes (writeReadiness runs assertNoSecrets,
    // but re-confirm structurally)
    expect(content).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(content).not.toMatch(/Bearer [A-Za-z0-9._-]+/);
  });
});
