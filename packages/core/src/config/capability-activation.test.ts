// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  V2_9_CAPABILITIES,
  ACTIVATED_CAPABILITIES,
  V1_OPT_OUT_CAPABILITIES,
  FROZEN_TRUST_PATHS,
  resolveCapabilityDefault,
  resolveAllCapabilityDefaults,
  type CapabilityId,
} from "./capability-activation.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

// ---------------------------------------------------------------------------
// The default-activation FRAMEWORK, reconciled for
// the v1 OPT-OUT posture.
//
// A capability resolves ON via EITHER the v1 opt-out posture (membership in
// V1_OPT_OUT_CAPABILITIES — the eight non-privacy capabilities whose schema
// defaults flipped false→true) OR a recorded measured-lift decision — AND, in
// both paths, the FROZEN-TRUST invariant (trust filter / trustAlpha never move)
// holds. SOCIAL stays OFF: it is NOT in the opt-out set (privacy/consent gate)
// and has no recorded measured-lift decision.
// ---------------------------------------------------------------------------

describe("capability registry", () => {
  it("enumerates each capability with a config path whose as-shipped value matches its posture (5 ON via opt-out, SOCIAL OFF)", () => {
    const cfg = PerAgentConfigSchema.parse({});
    // Each registered capability must name a real config path; we read it off a
    // parsed PerAgentConfig to prove the path is live (not a typo'd dead string).
    // The as-shipped value must match the v1 opt-out posture: opt-out members ON
    // (true), SOCIAL OFF (absent ⇒ undefined). (learnRank was deleted in Phase 224;
    // USER + REASON were deleted in Phase 225-05 with their config keys.)
    expect(V2_9_CAPABILITIES.length).toBeGreaterThanOrEqual(6);
    for (const cap of V2_9_CAPABILITIES) {
      const value = readPath(cfg as unknown as Record<string, unknown>, cap.configPath);
      const shippedOn = value === true;
      const expectedOn = V1_OPT_OUT_CAPABILITIES.has(cap.id);
      expect(
        shippedOn,
        `${cap.id} (${cap.configPath}) as-shipped default must match its posture`,
      ).toBe(expectedOn);
    }
  });

  it("the opt-out set is exactly the five non-privacy capabilities (SOCIAL deliberately absent; learnRank deleted in 224; user/reason deleted in 225)", () => {
    expect([...V1_OPT_OUT_CAPABILITIES].sort()).toEqual(
      ["dialectic", "feed", "forget", "kg", "learnIq"].sort(),
    );
    expect(V1_OPT_OUT_CAPABILITIES.has("social")).toBe(false);
  });

  it("gives every capability a unique id and a unique config path", () => {
    const ids = new Set(V2_9_CAPABILITIES.map((c) => c.id));
    const paths = new Set(V2_9_CAPABILITIES.map((c) => c.configPath));
    expect(ids.size).toBe(V2_9_CAPABILITIES.length);
    expect(paths.size).toBe(V2_9_CAPABILITIES.length);
  });

  it("includes SOCIAL with its privacy-review sign-off gate path", () => {
    const social = V2_9_CAPABILITIES.find((c) => c.id === "social");
    expect(social).toBeDefined();
    expect(social!.configPath).toBe("socialModeling.enabled");
    // SOCIAL carries an extra operator gate beyond the measured-lift gate.
    expect(social!.operatorGatePath).toBe("socialModeling.privacyReviewSignedOffBy");
  });
});

describe("measured-winner activation set", () => {
  it("is EMPTY (the measured-lift path drove nothing; the v1 opt-out posture is the active path)", () => {
    // The measured-lift path stays committed-decision-driven and is empty (the
    // measured-lift evaluation found +0.0pt). After the v1 opt-out reconciliation this empty set no longer means
    // "everything OFF" — the eight opt-out capabilities flip ON via V1_OPT_OUT_CAPABILITIES,
    // and SOCIAL (the lone non-opt-out cap) stays OFF for lack of a recorded decision.
    expect(ACTIVATED_CAPABILITIES).toEqual([]);
  });

  it("every entry that IS in the activation set must carry a recorded measured-lift decision (structural gate)", () => {
    // Even though the set is empty today, the gate is structural: an entry
    // cannot be added without a manifest reference + a measured delta. This
    // proves the type forces the recorded decision (compiles only with it).
    for (const decision of ACTIVATED_CAPABILITIES) {
      expect(decision.manifest).toMatch(/GATE-REPORT|run-provenance|capability-lift/);
      expect(decision.measuredDeltaPts).toBeGreaterThan(0);
      expect(decision.capability).toBeDefined();
    }
  });
});

describe("frozen trust invariant", () => {
  it("declares the trust filter + trustAlpha paths as FROZEN (never activatable)", () => {
    expect(FROZEN_TRUST_PATHS).toContain("rag.scoring.trustAlpha");
    expect(FROZEN_TRUST_PATHS).toContain("rag.includeTrustLevels");
  });

  it("no registered capability targets a frozen trust path", () => {
    for (const cap of V2_9_CAPABILITIES) {
      expect(
        FROZEN_TRUST_PATHS.includes(cap.configPath),
        `${cap.id} must not target a frozen trust path`,
      ).toBe(false);
    }
  });

  it("no entry in the activation set targets a frozen trust path (defense-in-depth)", () => {
    for (const decision of ACTIVATED_CAPABILITIES) {
      const cap = V2_9_CAPABILITIES.find((c) => c.id === decision.capability);
      expect(cap).toBeDefined();
      expect(FROZEN_TRUST_PATHS.includes(cap!.configPath)).toBe(false);
    }
  });

  it("the frozen trust knobs keep their as-shipped values (activation moved nothing)", () => {
    // Anchor the frozen-trust invariant to the real schema: after building the
    // activation framework, the trust filter + trustAlpha defaults are unchanged.
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.rag.scoring.trustAlpha, "trustAlpha frozen").toBe(0.1);
    expect(cfg.rag.includeTrustLevels, "trust filter frozen").toEqual(["system", "learned"]);
  });
});

describe("resolver (effective default-OFF→ON, v1 opt-out posture)", () => {
  it("resolves the opt-out capabilities ON via the v1 opt-out path (no recorded decision needed)", () => {
    for (const cap of V2_9_CAPABILITIES) {
      const resolved = resolveCapabilityDefault(cap.id);
      expect(resolved.id).toBe(cap.id);
      if (V1_OPT_OUT_CAPABILITIES.has(cap.id)) {
        expect(resolved.effectiveDefaultOn, `${cap.id} must resolve ON (v1 opt-out)`).toBe(true);
        expect(resolved.via).toBe("v1-opt-out");
        // The opt-out path carries no measured-lift decision.
        expect(resolved.decision).toBeUndefined();
      }
    }
  });

  it("resolves SOCIAL OFF (not in the opt-out set, no recorded measured-lift decision)", () => {
    const resolved = resolveCapabilityDefault("social");
    expect(resolved.effectiveDefaultOn).toBe(false);
    expect(resolved.via).toBeUndefined();
    expect(resolved.decision).toBeUndefined();
  });

  it("resolveAllCapabilityDefaults returns one entry per capability; exactly the opt-out members are ON", () => {
    const all = resolveAllCapabilityDefaults();
    expect(all.length).toBe(V2_9_CAPABILITIES.length);
    for (const r of all) {
      expect(r.effectiveDefaultOn).toBe(V1_OPT_OUT_CAPABILITIES.has(r.id));
    }
    // SOCIAL is the only OFF capability.
    expect(all.filter((r) => !r.effectiveDefaultOn).map((r) => r.id)).toEqual(["social"]);
  });

  it("errors for an unknown capability id (no silent success)", () => {
    expect(() => resolveCapabilityDefault("not-a-capability" as CapabilityId)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Framework/schema PARITY under the v1 opt-out posture. The framework's
// resolved default for every capability must MATCH its as-shipped schema default:
// the eight opt-out members resolve ON and ship ON; SOCIAL resolves OFF and ships
// OFF. This proves the framework table and the Zod schema stay in lock-step (a
// flip in one without the other trips this test).
// ---------------------------------------------------------------------------

describe("framework/schema parity (v1 opt-out posture)", () => {
  it("the framework's resolved default equals the as-shipped schema default for every capability", () => {
    const cfg = PerAgentConfigSchema.parse({}) as unknown as Record<string, unknown>;
    for (const cap of V2_9_CAPABILITIES) {
      const resolved = resolveCapabilityDefault(cap.id);
      const shipped = readPath(cfg, cap.configPath);
      const shippedOn = shipped === true; // OFF = undefined | false; ON = true
      // Lock-step: resolved default == as-shipped schema default for every capability.
      expect(resolved.effectiveDefaultOn, `${cap.id} resolved == shipped`).toBe(shippedOn);
      // And both equal the opt-out posture.
      expect(shippedOn, `${cap.id} as-shipped default`).toBe(V1_OPT_OUT_CAPABILITIES.has(cap.id));
    }
  });

  it("a bare PerAgentConfig has the opt-out capabilities ON and SOCIAL OFF", () => {
    const cfg = PerAgentConfigSchema.parse({});
    // Cost-bearing subtrees are now defaulted ON (no longer `.optional()`).
    // (memoryUserRepresentation + memoryReasoning were DELETED in Phase 225-05 with their config keys.)
    expect(cfg.dialectic?.enabled).toBe(true);
    // SOCIAL stays OFF — its subtree is still `.optional()` (privacy/consent gate).
    expect(cfg.socialModeling).toBeUndefined();
    // rag.* $0 capabilities default ON. (rag.onlineTuning was DELETED in Phase 224 — the bandit.)
    expect(cfg.rag.feedback.enabled).toBe(true);
    expect(cfg.rag.queryUnderstanding.intentReweight).toBe(true);
    expect(cfg.rag.lanes.graphSpread.enabled).toBe(true);
    expect(cfg.rag.forget.enabled).toBe(true);
  });

  it("an operator can still override a capability OFF in config (reversible + config-overridable)", () => {
    // The framework resolves the DEFAULT; config remains the operator override. An operator
    // who wants forget OFF sets it explicitly — the framework default stays ON regardless.
    const cfg = PerAgentConfigSchema.parse({ rag: { forget: { enabled: false } } });
    expect(cfg.rag.forget.enabled).toBe(false);
    // The framework default is still ON — overriding config does not change the resolved default.
    expect(resolveCapabilityDefault("forget").effectiveDefaultOn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SOCIAL enablement. SOCIAL is default-OFF behind the
// recorded `privacyReviewSignedOffBy` operator sign-off. No sign-off is
// recorded, so SOCIAL stays OFF; and the sign-off (+ enabled) IS the
// activation path. We assert the gate, never enable it.
// ---------------------------------------------------------------------------

describe("SOCIAL stays gated (no recorded sign-off)", () => {
  it("a bare config has no socialModeling subtree → SOCIAL OFF, no sign-off", () => {
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.socialModeling).toBeUndefined();
  });

  it("enabling socialModeling WITHOUT a sign-off leaves the sign-off absent (gate NOT satisfied)", () => {
    const cfg = PerAgentConfigSchema.parse({ socialModeling: { enabled: true } });
    // enabled alone is not the activation: the SOCIAL gate is
    // `enabled === true && typeof privacyReviewSignedOffBy === "string" && length > 0`.
    expect(cfg.socialModeling!.enabled).toBe(true);
    expect(cfg.socialModeling!.privacyReviewSignedOffBy).toBeUndefined();
    expect(socialGateSatisfied(cfg)).toBe(false);
  });

  it("the recorded sign-off + enabled IS the activation path (the SOCIAL gate)", () => {
    const cfg = PerAgentConfigSchema.parse({
      socialModeling: { enabled: true, privacyReviewSignedOffBy: "privacy-reviewer" },
    });
    expect(cfg.socialModeling!.privacyReviewSignedOffBy).toBe("privacy-reviewer");
    expect(socialGateSatisfied(cfg)).toBe(true);
  });

  it("rejects an empty-string sign-off (min(1)) — a blank cannot satisfy the gate", () => {
    const bad = PerAgentConfigSchema.safeParse({
      socialModeling: { enabled: true, privacyReviewSignedOffBy: "" },
    });
    expect(bad.success).toBe(false);
  });

  it("the SOCIAL descriptor's operator gate points at the sign-off field (framework wiring)", () => {
    const social = V2_9_CAPABILITIES.find((c) => c.id === "social");
    expect(social!.operatorGatePath).toBe("socialModeling.privacyReviewSignedOffBy");
  });
});

/** The SOCIAL activation gate, evaluated on a parsed PerAgentConfig. */
function socialGateSatisfied(cfg: ReturnType<typeof PerAgentConfigSchema.parse>): boolean {
  const social = cfg.socialModeling;
  return (
    social !== undefined &&
    social.enabled === true &&
    typeof social.privacyReviewSignedOffBy === "string" &&
    social.privacyReviewSignedOffBy.length > 0
  );
}

/** Read a dotted config path (e.g. "rag.forget.enabled") off a parsed config object. */
function readPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
