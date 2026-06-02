// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  V2_9_CAPABILITIES,
  ACTIVATED_CAPABILITIES,
  FROZEN_TRUST_PATHS,
  resolveCapabilityDefault,
  resolveAllCapabilityDefaults,
  type CapabilityId,
} from "./capability-activation.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

// ---------------------------------------------------------------------------
// Phase 115 (ACTIVATE) — ACT-01 the default-activation FRAMEWORK.
//
// A minimal, reversible, config-overridable mechanism that resolves each v2.9
// capability's effective default-OFF→ON state. ANY flip is gated on BOTH:
//   (a) a RECORDED measured-lift decision referencing a PROVE2 manifest, AND
//   (b) the FROZEN safety invariants (trust filter / trustAlpha never move).
//
// Phase 114 (PROVE2) measured NO winner → the activation set is EMPTY → every
// capability's effective default stays its as-shipped OFF. These cases fail on
// the pre-patch tree (the module does not exist) — RED proof.
// ---------------------------------------------------------------------------

describe("ACT-01 v2.9 capability registry", () => {
  it("enumerates each default-OFF v2.9 capability with a config path that resolves on a parsed agent config", () => {
    const cfg = PerAgentConfigSchema.parse({});
    // Each registered capability must name a real config path whose as-shipped
    // value is the default-OFF / neutral state. We read the path off a parsed
    // PerAgentConfig to prove the path is live (not a typo'd dead string).
    expect(V2_9_CAPABILITIES.length).toBeGreaterThanOrEqual(9);
    for (const cap of V2_9_CAPABILITIES) {
      const value = readPath(cfg as unknown as Record<string, unknown>, cap.configPath);
      // Cron/tool capabilities are `.optional()` (absent ⇒ undefined ⇒ OFF);
      // rag.* capabilities default to an explicit `false`. Both are "OFF".
      const isOff = value === undefined || value === false;
      expect(isOff, `${cap.id} (${cap.configPath}) must be default-OFF as shipped`).toBe(true);
    }
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

describe("ACT-01 measured-winner activation set (gated on PROVE2)", () => {
  it("is EMPTY because Phase 114 measured no winner (nothing flips on faith)", () => {
    // The keystone invariant: the activation set is committed-decision-driven.
    // PROVE2 found +0.0pt for every togglable capability → no decision → empty.
    expect(ACTIVATED_CAPABILITIES).toEqual([]);
  });

  it("every entry that IS in the activation set must carry a recorded PROVE2 decision (structural gate)", () => {
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

describe("ACT-01 frozen trust invariant", () => {
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

describe("ACT-01 resolver (effective default-OFF→ON)", () => {
  it("resolves every capability to OFF while the activation set is empty", () => {
    for (const cap of V2_9_CAPABILITIES) {
      const resolved = resolveCapabilityDefault(cap.id);
      expect(resolved.id).toBe(cap.id);
      expect(resolved.effectiveDefaultOn, `${cap.id} must resolve OFF (no winner)`).toBe(false);
      expect(resolved.decision).toBeUndefined();
    }
  });

  it("resolveAllCapabilityDefaults returns one entry per capability, all OFF", () => {
    const all = resolveAllCapabilityDefaults();
    expect(all.length).toBe(V2_9_CAPABILITIES.length);
    expect(all.every((r) => r.effectiveDefaultOn === false)).toBe(true);
  });

  it("errors for an unknown capability id (no silent success)", () => {
    expect(() => resolveCapabilityDefault("not-a-capability" as CapabilityId)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ACT-02 — flip the measured winners. There are none, so flip NOTHING and
// assert BYTE-IDENTITY preserved: the activation framework's resolved default
// for every capability matches the as-shipped schema default (all OFF). This
// proves the framework changed no shipped behavior.
// ---------------------------------------------------------------------------

describe("ACT-02 byte-identity preserved (flip nothing)", () => {
  it("the framework's resolved default equals the as-shipped schema default for every capability (all OFF)", () => {
    const cfg = PerAgentConfigSchema.parse({}) as unknown as Record<string, unknown>;
    for (const cap of V2_9_CAPABILITIES) {
      const resolved = resolveCapabilityDefault(cap.id);
      const shipped = readPath(cfg, cap.configPath);
      const shippedOn = shipped === true; // OFF = undefined | false; ON = true
      // The framework must not have flipped anything: resolved == shipped == OFF.
      expect(resolved.effectiveDefaultOn, `${cap.id} resolved default`).toBe(false);
      expect(shippedOn, `${cap.id} as-shipped default`).toBe(false);
      expect(resolved.effectiveDefaultOn).toBe(shippedOn);
    }
  });

  it("a bare PerAgentConfig leaves every v2.9 capability OFF (no winner flipped a default on)", () => {
    const cfg = PerAgentConfigSchema.parse({});
    // Cron/tool capabilities are optional → absent (undefined) on a bare config.
    expect(cfg.memoryUserRepresentation).toBeUndefined();
    expect(cfg.socialModeling).toBeUndefined();
    expect(cfg.dialectic).toBeUndefined();
    expect(cfg.memoryReasoning).toBeUndefined();
    // rag.* capabilities default to explicit false / neutral.
    expect(cfg.rag.feedback.enabled).toBe(false);
    expect(cfg.rag.onlineTuning.enabled).toBe(false);
    expect(cfg.rag.queryUnderstanding.intentReweight).toBe(false);
    expect(cfg.rag.lanes.graphSpread.enabled).toBe(false);
    expect(cfg.rag.forget.enabled).toBe(false);
  });

  it("an operator can still override a capability ON in config (reversible + config-overridable)", () => {
    // The framework resolves the DEFAULT; config remains the operator override.
    const cfg = PerAgentConfigSchema.parse({ rag: { forget: { enabled: true } } });
    expect(cfg.rag.forget.enabled).toBe(true);
    // The framework default is still OFF — overriding config does not change it.
    expect(resolveCapabilityDefault("forget").effectiveDefaultOn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ACT-03 — SOCIAL enablement. SOCIAL is default-OFF behind the SOCIAL-03
// recorded `privacyReviewSignedOffBy` operator sign-off. No sign-off is
// recorded, so SOCIAL stays OFF; and the sign-off (+ enabled) IS the
// activation path. We assert the gate, never enable it.
// ---------------------------------------------------------------------------

describe("ACT-03 SOCIAL stays gated (no recorded sign-off)", () => {
  it("a bare config has no socialModeling subtree → SOCIAL OFF, no sign-off", () => {
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.socialModeling).toBeUndefined();
  });

  it("enabling socialModeling WITHOUT a sign-off leaves the sign-off absent (gate NOT satisfied)", () => {
    const cfg = PerAgentConfigSchema.parse({ socialModeling: { enabled: true } });
    // enabled alone is not the activation: the SOCIAL-03 gate is
    // `enabled === true && typeof privacyReviewSignedOffBy === "string" && length > 0`.
    expect(cfg.socialModeling!.enabled).toBe(true);
    expect(cfg.socialModeling!.privacyReviewSignedOffBy).toBeUndefined();
    expect(socialGateSatisfied(cfg)).toBe(false);
  });

  it("the recorded sign-off + enabled IS the activation path (the SOCIAL-03 gate)", () => {
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

/** The SOCIAL-03 activation gate, evaluated on a parsed PerAgentConfig. */
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
