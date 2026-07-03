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
// The default-activation FRAMEWORK (v1 OPT-OUT posture).
//
// A capability resolves ON via EITHER the v1 opt-out posture (membership in
// V1_OPT_OUT_CAPABILITIES) OR a recorded measured-lift decision — AND, in both
// paths, the FROZEN-TRUST invariant (trust filter / trustAlpha never move) holds.
//
// There is NO social-modeling subsystem: no SOCIAL directional-relationship
// capability, no `__SOCIAL_MODELING__` cron, no RelationshipStore port, no
// `relationship` table, no relationship-block prompt injection, no per-agent
// socialModeling config key, and no descriptor `operatorGatePath` field. The
// registry is exactly the five opt-out capabilities; every one resolves ON.
// Several tests below pin that absence so the subsystem cannot silently creep
// back in.
// ---------------------------------------------------------------------------

describe("capability registry", () => {
  it("is exactly the five opt-out capabilities, each ON as-shipped", () => {
    const cfg = PerAgentConfigSchema.parse({});
    // Each registered capability must name a real config path; we read it off a parsed
    // PerAgentConfig to prove the path is live (not a typo'd dead string). Every
    // registered capability is in the opt-out set and ships ON (true).
    expect(V2_9_CAPABILITIES.length).toBe(5);
    for (const cap of V2_9_CAPABILITIES) {
      const value = readPath(cfg as unknown as Record<string, unknown>, cap.configPath);
      const shippedOn = value === true;
      expect(V1_OPT_OUT_CAPABILITIES.has(cap.id), `${cap.id} must be an opt-out member`).toBe(true);
      expect(shippedOn, `${cap.id} (${cap.configPath}) must ship ON`).toBe(true);
    }
  });

  it("the opt-out set is exactly the five non-privacy capabilities", () => {
    expect([...V1_OPT_OUT_CAPABILITIES].sort()).toEqual(
      ["dialectic", "feed", "forget", "kg", "learnIq"].sort(),
    );
    // The opt-out set IS the full registry now (every registered capability is a member).
    expect([...V1_OPT_OUT_CAPABILITIES].sort()).toEqual(V2_9_CAPABILITIES.map((c) => c.id).sort());
  });

  it("gives every capability a unique id and a unique config path", () => {
    const ids = new Set(V2_9_CAPABILITIES.map((c) => c.id));
    const paths = new Set(V2_9_CAPABILITIES.map((c) => c.configPath));
    expect(ids.size).toBe(V2_9_CAPABILITIES.length);
    expect(paths.size).toBe(V2_9_CAPABILITIES.length);
  });

  it("the SOCIAL capability is absent from the registry (no `social` id, no socialModeling path)", () => {
    // There is no social-modeling subsystem, so no `social` capability
    // descriptor may exist and no descriptor may reference a socialModeling
    // config path.
    expect(V2_9_CAPABILITIES.find((c) => c.id === ("social" as CapabilityId))).toBeUndefined();
    expect(V2_9_CAPABILITIES.some((c) => c.configPath.startsWith("socialModeling"))).toBe(false);
    // (Resolving the deleted `social` id throws — asserted in the resolver describe block.)
  });
});

describe("measured-winner activation set", () => {
  it("is EMPTY (every registered capability is in the opt-out set; the measured-lift path is an ahead-of-need mechanism)", () => {
    // The measured-lift path stays committed-decision-driven and is empty. There
    // is no non-opt-out capability for it to govern; it remains as an
    // ahead-of-need mechanism for a future non-opt-out capability.
    expect(ACTIVATED_CAPABILITIES).toEqual([]);
  });

  it("every entry that IS in the activation set must carry a recorded measured-lift decision (structural gate)", () => {
    // Even though the set is empty today, the gate is structural: an entry cannot be
    // added without a manifest reference + a measured delta.
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
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.rag.scoring.trustAlpha, "trustAlpha frozen").toBe(0.1);
    expect(cfg.rag.includeTrustLevels, "trust filter frozen").toEqual(["system", "learned"]);
  });
});

describe("resolver (effective default-OFF→ON, v1 opt-out posture)", () => {
  it("resolves EVERY registered capability ON via the v1 opt-out path (no recorded decision needed)", () => {
    for (const cap of V2_9_CAPABILITIES) {
      const resolved = resolveCapabilityDefault(cap.id);
      expect(resolved.id).toBe(cap.id);
      expect(resolved.effectiveDefaultOn, `${cap.id} must resolve ON (v1 opt-out)`).toBe(true);
      expect(resolved.via).toBe("v1-opt-out");
      // The opt-out path carries no measured-lift decision.
      expect(resolved.decision).toBeUndefined();
    }
  });

  it("resolveAllCapabilityDefaults returns one ON entry per capability (no capability resolves OFF)", () => {
    const all = resolveAllCapabilityDefaults();
    expect(all.length).toBe(V2_9_CAPABILITIES.length);
    for (const r of all) {
      expect(r.effectiveDefaultOn, `${r.id} resolves ON`).toBe(true);
    }
    // No OFF capability exists.
    expect(all.filter((r) => !r.effectiveDefaultOn)).toEqual([]);
  });

  it("errors for an unknown capability id (no silent success) — including the unregistered `social` id", () => {
    expect(() => resolveCapabilityDefault("not-a-capability" as CapabilityId)).toThrow();
    // `social` is not a registered id → the closed-union guard throws.
    expect(() => resolveCapabilityDefault("social" as CapabilityId)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Framework/schema PARITY under the v1 opt-out posture. The framework's resolved
// default for every capability must MATCH its as-shipped schema default: every
// registered (opt-out) capability resolves ON and ships ON. A flip in one without the
// other trips this test.
// ---------------------------------------------------------------------------

describe("framework/schema parity (v1 opt-out posture)", () => {
  it("the framework's resolved default equals the as-shipped schema default for every capability", () => {
    const cfg = PerAgentConfigSchema.parse({}) as unknown as Record<string, unknown>;
    for (const cap of V2_9_CAPABILITIES) {
      const resolved = resolveCapabilityDefault(cap.id);
      const shipped = readPath(cfg, cap.configPath);
      const shippedOn = shipped === true; // OFF = undefined | false; ON = true
      expect(resolved.effectiveDefaultOn, `${cap.id} resolved == shipped`).toBe(shippedOn);
      // Every registered capability ships ON (the opt-out posture).
      expect(shippedOn, `${cap.id} as-shipped default`).toBe(true);
    }
  });

  it("a bare PerAgentConfig has the opt-out capabilities ON", () => {
    const cfg = PerAgentConfigSchema.parse({});
    // Cost-bearing subtrees are defaulted ON (not `.optional()`).
    expect(cfg.dialectic?.enabled).toBe(true);
    // rag.* $0 capabilities default ON.
    expect(cfg.rag.feedback.enabled).toBe(true);
    expect(cfg.rag.queryUnderstanding.intentReweight).toBe(true);
    expect(cfg.rag.lanes.graphSpread.enabled).toBe(true);
    expect(cfg.rag.forget.enabled).toBe(true);
  });

  it("an operator can still override a capability OFF in config (reversible + config-overridable)", () => {
    const cfg = PerAgentConfigSchema.parse({ rag: { forget: { enabled: false } } });
    expect(cfg.rag.forget.enabled).toBe(false);
    // The framework default is still ON — overriding config does not change the resolved default.
    expect(resolveCapabilityDefault("forget").effectiveDefaultOn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The per-agent socialModeling config key does not exist. PerAgentConfig is a
// `z.strictObject`, so a config carrying that key is REJECTED at parse (the
// operator-update path) — there is no socialModeling subtree to read.
// ---------------------------------------------------------------------------

describe("social-modeling config key does not exist", () => {
  it("a bare config has no socialModeling subtree", () => {
    const cfg = PerAgentConfigSchema.parse({}) as unknown as Record<string, unknown>;
    expect(cfg.socialModeling).toBeUndefined();
  });

  it("a config carrying a socialModeling key is REJECTED at parse (z.strictObject)", () => {
    const bad = PerAgentConfigSchema.safeParse({
      name: "Agent 1",
      socialModeling: { enabled: true, privacyReviewSignedOffBy: "privacy-reviewer" },
    });
    expect(bad.success, "an unknown socialModeling key must be rejected by the strict object").toBe(false);
  });
});

/** Read a dotted config path (e.g. "rag.forget.enabled") off a parsed config object. */
function readPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
