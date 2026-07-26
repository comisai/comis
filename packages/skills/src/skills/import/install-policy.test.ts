// SPDX-License-Identifier: Apache-2.0
/**
 * Spec for the trust × verdict install-policy matrix.
 *
 * Pre-patch state: `./install-policy.js` does not exist.
 *
 * Replaces the fixed fail-closed policy the vetting gate shipped with. The
 * same finding set now yields different decisions depending on where the skill
 * came from: an operator's own CRITICAL is a confirmable mistake, a stranger's
 * is not.
 *
 *                 safe     caution   dangerous
 *   first-party   allow    allow     allow
 *   operator      allow    allow     confirm
 *   community     allow    confirm   block
 *   agent-authored allow   confirm   block
 *
 * `force` upgrades a `confirm` to an `allow` but NEVER overrides a `block`.
 * That asymmetry is the point: force means "I read the findings and accept
 * them", not "skip the scan".
 */
import { describe, it, expect } from "vitest";
import { decideSkillInstall, applyForceOverride } from "./install-policy.js";
import type { SkillTrustTier } from "./trust-tier.js";
import type { SkillBundleDecision, SkillBundleVerdict } from "./bundle-types.js";

const TIERS: readonly SkillTrustTier[] = ["first-party", "operator", "community", "agent-authored"];
const VERDICTS: readonly SkillBundleVerdict[] = ["safe", "caution", "dangerous"];

/** The matrix, transcribed independently of the implementation. */
const EXPECTED: Record<SkillTrustTier, Record<SkillBundleVerdict, SkillBundleDecision>> = {
  "first-party": { safe: "allow", caution: "allow", dangerous: "allow" },
  operator: { safe: "allow", caution: "allow", dangerous: "confirm" },
  community: { safe: "allow", caution: "confirm", dangerous: "block" },
  "agent-authored": { safe: "allow", caution: "confirm", dangerous: "block" },
};

describe("decideSkillInstall — the full matrix", () => {
  for (const trust of TIERS) {
    for (const verdict of VERDICTS) {
      it(`decides ${EXPECTED[trust][verdict]} for a ${verdict} bundle at ${trust} tier`, () => {
        expect(decideSkillInstall({ trust, verdict })).toBe(EXPECTED[trust][verdict]);
      });
    }
  }
});

describe("decideSkillInstall — invariants that must hold across the matrix", () => {
  it("never blocks a clean bundle at any tier", () => {
    for (const trust of TIERS) {
      expect(decideSkillInstall({ trust, verdict: "safe" })).toBe("allow");
    }
  });

  it("blocks a CRITICAL bundle for every tier that did not originate locally", () => {
    // The tiers a remote import can reach must never be able to install a
    // CRITICAL bundle outright.
    for (const trust of ["community", "agent-authored"] as const) {
      expect(decideSkillInstall({ trust, verdict: "dangerous" })).toBe("block");
    }
  });

  it("is monotonic: a worse verdict is never a softer decision at the same tier", () => {
    const rank: Record<SkillBundleDecision, number> = { allow: 0, confirm: 1, block: 2 };
    for (const trust of TIERS) {
      const [safe, caution, dangerous] = VERDICTS.map((v) => rank[decideSkillInstall({ trust, verdict: v })]);
      expect(safe).toBeLessThanOrEqual(caution!);
      expect(caution).toBeLessThanOrEqual(dangerous!);
    }
  });

  it("is monotonic: a lower-trust tier is never a softer decision for the same verdict", () => {
    const rank: Record<SkillBundleDecision, number> = { allow: 0, confirm: 1, block: 2 };
    for (const verdict of VERDICTS) {
      const ordered = TIERS.map((t) => rank[decideSkillInstall({ trust: t, verdict })]);
      for (let i = 1; i < ordered.length; i++) {
        expect(ordered[i]).toBeGreaterThanOrEqual(ordered[i - 1]!);
      }
    }
  });
});

describe("applyForceOverride", () => {
  it("upgrades a confirm to an allow", () => {
    expect(applyForceOverride("confirm", true)).toBe("allow");
  });

  it("NEVER overrides a block — force means 'I read the findings', not 'skip the scan'", () => {
    expect(applyForceOverride("block", true)).toBe("block");
  });

  it("leaves an allow alone", () => {
    expect(applyForceOverride("allow", true)).toBe("allow");
  });

  it("is a no-op when force is not set", () => {
    for (const decision of ["allow", "confirm", "block"] as const) {
      expect(applyForceOverride(decision, false)).toBe(decision);
    }
  });

  it("cannot make any community CRITICAL bundle installable, even with force", () => {
    // The single most important property of the whole policy layer.
    const decision = decideSkillInstall({ trust: "community", verdict: "dangerous" });
    expect(applyForceOverride(decision, true)).toBe("block");
  });
});

describe("install policy — purity", () => {
  it("is deterministic for identical input across repeated calls", () => {
    const input = { trust: "community" as const, verdict: "caution" as const };
    expect(decideSkillInstall(input)).toBe(decideSkillInstall(input));
  });

  it("does not mutate its input object", () => {
    const input = { trust: "operator" as const, verdict: "dangerous" as const };
    const snapshot = JSON.stringify(input);
    decideSkillInstall(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
