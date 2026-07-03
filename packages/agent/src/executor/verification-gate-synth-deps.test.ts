// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildSyntheticCriticDeps — the post-execution hook's CriticDeps
 * constructor (extracted from verification-gate.ts for file-size budget).
 *
 * Pins the security-relevant invariants the keyless-critic contract relies on:
 *  - small/nano ⇒ scaffoldLevel "max" + securityLevel "locked" (weaker model ⇒ stricter)
 *  - frontier/mid (or undefined→nano) class mapping is deterministic
 *  - apiKey is "" by construction (keyless-only contract; gated upstream by shouldRunCritic)
 *  - passthrough fields (provider/modelId/agentId/canaryToken/minResponseChars/maxRetries) are preserved
 */
import { describe, it, expect, vi } from "vitest";
import { buildSyntheticCriticDeps } from "./verification-gate-synth-deps.js";
import type { CriticDeps } from "./verification-gate.js";

function baseParams(overrides: Partial<Parameters<typeof buildSyntheticCriticDeps>[0]> = {}) {
  return {
    capabilityClass: "small" as const,
    provider: "ollama",
    modelId: "qwen3.6:35b",
    agentId: "agentX",
    canaryToken: "CTKN_abc123",
    minResponseChars: 200,
    maxRetries: 2,
    clock: { now: () => 0, monotonicNow: () => 0 } as unknown as CriticDeps["clock"],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as CriticDeps["logger"],
    eventBus: { emit: vi.fn() } as unknown as CriticDeps["eventBus"],
    ...overrides,
  };
}

describe("buildSyntheticCriticDeps", () => {
  it("maps small/nano capabilityClass to scaffoldLevel=max + securityLevel=locked (weaker ⇒ stricter)", () => {
    for (const cc of ["small", "nano"] as const) {
      const { deps } = buildSyntheticCriticDeps(baseParams({ capabilityClass: cc }));
      expect(deps.modelProfile.scaffoldLevel).toBe("max");
      expect(deps.modelProfile.securityLevel).toBe("locked");
      expect(deps.modelProfile.capabilityClass).toBe(cc);
    }
  });

  it("maps frontier/mid capabilityClass to scaffoldLevel=light + securityLevel=standard", () => {
    for (const cc of ["frontier", "mid"] as const) {
      const { deps } = buildSyntheticCriticDeps(baseParams({ capabilityClass: cc }));
      expect(deps.modelProfile.scaffoldLevel).toBe("light");
      expect(deps.modelProfile.securityLevel).toBe("standard");
    }
  });

  it("defaults an undefined capabilityClass to nano (fail-closed to the strictest scaffold)", () => {
    const { deps } = buildSyntheticCriticDeps(baseParams({ capabilityClass: undefined }));
    expect(deps.modelProfile.capabilityClass).toBe("nano");
    expect(deps.modelProfile.securityLevel).toBe("locked");
  });

  it("constructs apiKey as the empty string (keyless-only contract; cloud gated upstream)", () => {
    const { deps } = buildSyntheticCriticDeps(baseParams({ provider: "ollama" }));
    expect(deps.apiKey).toBe("");
  });

  it("preserves passthrough identity + gate fields and returns maxRetries unchanged", () => {
    const { deps, maxRetries } = buildSyntheticCriticDeps(
      baseParams({ provider: "lm-studio", modelId: "m1", agentId: "A", canaryToken: "CTKN_z", minResponseChars: 321, maxRetries: 4 }),
    );
    expect(deps.provider).toBe("lm-studio");
    expect(deps.modelId).toBe("m1");
    expect(deps.agentId).toBe("A");
    expect(deps.canaryToken).toBe("CTKN_z");
    expect(deps.minResponseChars).toBe(321);
    expect(maxRetries).toBe(4);
  });
});
