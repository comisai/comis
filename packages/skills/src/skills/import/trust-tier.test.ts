// SPDX-License-Identifier: Apache-2.0
/**
 * Spec for `deriveSkillTrustTier` (INV-V3: trust is derived, never declared).
 *
 * Pre-patch state: `./trust-tier.js` does not exist. These tests fail at
 * import resolution, which is the correct tests-first state for a new pure
 * module.
 *
 * The derivation must be a function of the CALL (source + calling identity)
 * and nothing else. It deliberately mirrors the identity comparison the
 * shared-scope authz check already performs
 * (`packages/daemon/src/api/skill-handlers.ts:210`) rather than introducing a
 * second notion of "who is privileged here".
 */
import { describe, it, expect } from "vitest";
import { deriveSkillTrustTier, type SkillTrustTier } from "./trust-tier.js";

const DEFAULT = "agent-a";

describe("deriveSkillTrustTier — local authoring", () => {
  it.each(["create", "update", "upload"] as const)(
    "%s by the default agent is operator tier",
    (source) => {
      expect(
        deriveSkillTrustTier({ source, callingAgentId: DEFAULT, defaultAgentId: DEFAULT }),
      ).toBe<SkillTrustTier>("operator");
    },
  );

  it.each(["create", "update", "upload"] as const)(
    "%s by a NON-default agent is agent-authored tier",
    (source) => {
      expect(
        deriveSkillTrustTier({ source, callingAgentId: "agent-b", defaultAgentId: DEFAULT }),
      ).toBe<SkillTrustTier>("agent-authored");
    },
  );

  it("treats an undefined defaultAgentId as 'not the default agent' (fail-closed)", () => {
    // A daemon with no resolved default agent must not silently grant the
    // stronger tier — the weaker one is the safe reading.
    expect(
      deriveSkillTrustTier({ source: "create", callingAgentId: DEFAULT, defaultAgentId: undefined }),
    ).toBe<SkillTrustTier>("agent-authored");
  });
});

describe("deriveSkillTrustTier — remote sources", () => {
  it.each(["github", "archive", "wellknown", "registry"] as const)(
    "%s is community tier even when called by the default agent",
    (source) => {
      expect(
        deriveSkillTrustTier({ source, callingAgentId: DEFAULT, defaultAgentId: DEFAULT }),
      ).toBe<SkillTrustTier>("community");
    },
  );

  it("honors an explicit operator promotion for a configured registry", () => {
    expect(
      deriveSkillTrustTier({
        source: "registry",
        callingAgentId: DEFAULT,
        defaultAgentId: DEFAULT,
        registryTrust: "operator",
      }),
    ).toBe<SkillTrustTier>("operator");
  });

  it("ignores a registryTrust promotion for a source that is not a registry", () => {
    // The promotion is a property of an operator-configured registry entry.
    // It must not leak into an arbitrary archive URL or well-known domain.
    for (const source of ["archive", "wellknown", "github"] as const) {
      expect(
        deriveSkillTrustTier({
          source,
          callingAgentId: DEFAULT,
          defaultAgentId: DEFAULT,
          registryTrust: "operator",
        }),
      ).toBe<SkillTrustTier>("community");
    }
  });

  it("never promotes past operator — 'first-party' is unreachable from any import", () => {
    const reachable = (["github", "archive", "wellknown", "registry"] as const).map((source) =>
      deriveSkillTrustTier({
        source,
        callingAgentId: DEFAULT,
        defaultAgentId: DEFAULT,
        registryTrust: "operator",
      }),
    );
    expect(reachable).not.toContain("first-party");
  });
});

describe("deriveSkillTrustTier — first-party", () => {
  it("the seed path is the ONLY route to first-party", () => {
    expect(
      deriveSkillTrustTier({ source: "seed", callingAgentId: DEFAULT, defaultAgentId: DEFAULT }),
    ).toBe<SkillTrustTier>("first-party");
  });
});

describe("deriveSkillTrustTier — purity", () => {
  it("is deterministic for identical input", () => {
    const input = { source: "wellknown" as const, callingAgentId: "x", defaultAgentId: "y" };
    expect(deriveSkillTrustTier(input)).toBe(deriveSkillTrustTier(input));
  });

  it("does not mutate its input", () => {
    const input = { source: "create" as const, callingAgentId: DEFAULT, defaultAgentId: DEFAULT };
    const snapshot = JSON.stringify(input);
    deriveSkillTrustTier(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
