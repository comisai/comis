// SPDX-License-Identifier: Apache-2.0
/**
 * K2 boundary invariant tests for resolveModelProfile().
 *
 * RED state: model-profile.ts does not exist yet — all tests will fail with
 * "Cannot find module './model-profile.js'" until Plan 02 creates the
 * implementation. This failing state is committed intentionally per
 * CLAUDE.md Tests-First.
 *
 * Invariants tested:
 *  - Fail-closed: unknown/undefined model → most-locked profile (capabilityClass="nano",
 *    scaffoldLevel="max", securityLevel="locked") [T-151-failclosed]
 *  - capabilityClass ⊥ contextWindow (K2): a 256K window must NOT force
 *    frontier/mid class; qwen3.6:27b (ollama) → "small" or "nano"
 *  - securityLevel tightens inversely as capabilityClass drops
 *  - capabilityClassOverride in config wins over heuristic
 *  - supportsVision derives from resolvedModel.input (not model ID)
 *  - reasoningStyle derives from resolvedModel.reasoning flag
 *  - scaffoldLevel derived from capabilityClass
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  resolveModelProfile,
} from "./model-profile.js";
import type { ModelProfile, CapabilityClass } from "./model-profile.js";

// ---------------------------------------------------------------------------
// T-151-failclosed: unknown / undefined model → most-locked profile
// ---------------------------------------------------------------------------
describe("resolveModelProfile — K2 boundary invariants", () => {
  describe("T-151-failclosed: fail-closed for undefined model", () => {
    it("resolveModelProfile(undefined) returns capabilityClass='nano'", () => {
      const profile: ModelProfile = resolveModelProfile(undefined);
      expect(profile.capabilityClass).toBe("nano");
    });

    it("resolveModelProfile(undefined) returns scaffoldLevel='max'", () => {
      const profile = resolveModelProfile(undefined);
      expect(profile.scaffoldLevel).toBe("max");
    });

    it("resolveModelProfile(undefined) returns securityLevel='locked'", () => {
      const profile = resolveModelProfile(undefined);
      expect(profile.securityLevel).toBe("locked");
    });

    it("resolveModelProfile(undefined) returns supportsVision=false", () => {
      const profile = resolveModelProfile(undefined);
      expect(profile.supportsVision).toBe(false);
    });

    it("resolveModelProfile(undefined) returns supportsStructuredOutput=false", () => {
      const profile = resolveModelProfile(undefined);
      expect(profile.supportsStructuredOutput).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // K2 invariant: contextWindow is DECOUPLED from capabilityClass
  // A 256K window must NOT force frontier or mid class
  // ---------------------------------------------------------------------------
  describe("K2 invariant: capabilityClass is independent of contextWindow", () => {
    it("qwen3.6:27b (ollama, 256K) resolves capabilityClass to small or nano — NOT frontier or mid", () => {
      const profile = resolveModelProfile({
        id: "qwen3.6:27b",
        provider: "ollama",
        contextWindow: 262_144,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(
        ["small", "nano"] as CapabilityClass[],
        `Expected capabilityClass in ["small","nano"] but got "${profile.capabilityClass}"`,
      ).toContain(profile.capabilityClass);
    });

    it("qwen3.6:27b (ollama, 256K) preserves contextWindow=262144 independently on the capacity axis", () => {
      const profile = resolveModelProfile({
        id: "qwen3.6:27b",
        provider: "ollama",
        contextWindow: 262_144,
        reasoning: false,
        input: ["text"],
      });
      expect(profile.contextWindow).toBe(262_144);
    });

    it("frontier anthropic model (200K) resolves capabilityClass='frontier' — distinct from 256K ollama model", () => {
      const frontier = resolveModelProfile({
        id: "claude-sonnet-4",
        provider: "anthropic",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text", "image"],
      });
      const small = resolveModelProfile({
        id: "qwen3.6:27b",
        provider: "ollama",
        contextWindow: 262_144,
        reasoning: false,
        input: ["text"],
      });
      // Two models with similar contextWindow but different capability yield different capabilityClass
      expect(frontier.capabilityClass).toBe("frontier");
      expect(["small", "nano"] as CapabilityClass[]).toContain(small.capabilityClass);
      expect(frontier.capabilityClass).not.toBe(small.capabilityClass);
    });
  });

  // ---------------------------------------------------------------------------
  // securityLevel tightens inversely as capabilityClass drops
  // ---------------------------------------------------------------------------
  describe("securityLevel inverse of capabilityClass", () => {
    it("frontier model (anthropic, 200K) → securityLevel='standard'", () => {
      const profile = resolveModelProfile({
        id: "claude-sonnet-4",
        provider: "anthropic",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.securityLevel).toBe("standard");
    });

    it("small/nano model (ollama, 256K) → securityLevel in ['hardened','locked']", () => {
      const profile = resolveModelProfile({
        id: "qwen3.6:27b",
        provider: "ollama",
        contextWindow: 262_144,
        reasoning: false,
        input: ["text"],
      });
      expect(["hardened", "locked"]).toContain(profile.securityLevel);
    });

    it("small/nano model has strictly tighter securityLevel than frontier model", () => {
      const frontier = resolveModelProfile({
        id: "claude-sonnet-4",
        provider: "anthropic",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text", "image"],
      });
      const small = resolveModelProfile({
        id: "qwen3.6:27b",
        provider: "ollama",
        contextWindow: 262_144,
        reasoning: false,
        input: ["text"],
      });
      // frontier is always "standard"; small/nano must be "hardened" or "locked" (stricter)
      expect(frontier.securityLevel).toBe("standard");
      expect(small.securityLevel).not.toBe("standard");
    });
  });

  // ---------------------------------------------------------------------------
  // capabilityClassOverride takes priority over provider heuristic
  // ---------------------------------------------------------------------------
  describe("capabilityClassOverride takes priority over heuristic", () => {
    it("capabilityClassOverride='frontier' on an ollama model forces capabilityClass='frontier'", () => {
      const profile = resolveModelProfile(
        {
          id: "qwen3.6:27b",
          provider: "ollama",
          contextWindow: 262_144,
          reasoning: false,
          input: ["text"],
        },
        undefined,
        "frontier",
      );
      expect(profile.capabilityClass).toBe("frontier");
    });

    it("capabilityClassOverride='frontier' on an ollama model sets securityLevel='standard'", () => {
      const profile = resolveModelProfile(
        {
          id: "qwen3.6:27b",
          provider: "ollama",
          contextWindow: 262_144,
          reasoning: false,
          input: ["text"],
        },
        undefined,
        "frontier",
      );
      expect(profile.securityLevel).toBe("standard");
    });
  });

  // ---------------------------------------------------------------------------
  // Vision flag: derived from resolvedModel.input
  // ---------------------------------------------------------------------------
  describe("supportsVision flag", () => {
    it("input includes 'image' → supportsVision=true", () => {
      const profile = resolveModelProfile({
        id: "qwen3.6:27b",
        provider: "ollama",
        contextWindow: 262_144,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.supportsVision).toBe(true);
    });

    it("input is text-only → supportsVision=false", () => {
      const profile = resolveModelProfile({
        id: "qwen3.6:27b-mlx",
        provider: "ollama",
        contextWindow: 262_144,
        reasoning: false,
        input: ["text"],
      });
      expect(profile.supportsVision).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Reasoning flag: derived from resolvedModel.reasoning
  // ---------------------------------------------------------------------------
  describe("reasoningStyle flag", () => {
    it("resolvedModel.reasoning=true → reasoningStyle='native'", () => {
      const profile = resolveModelProfile({
        id: "deepseek-r1:32b",
        provider: "ollama",
        contextWindow: 128_000,
        reasoning: true,
        input: ["text"],
      });
      expect(profile.reasoningStyle).toBe("native");
    });

    it("resolvedModel.reasoning=false → reasoningStyle='none'", () => {
      const profile = resolveModelProfile({
        id: "qwen3.6:27b",
        provider: "ollama",
        contextWindow: 262_144,
        reasoning: false,
        input: ["text"],
      });
      expect(profile.reasoningStyle).toBe("none");
    });
  });

  // ---------------------------------------------------------------------------
  // scaffoldLevel derivation from capabilityClass
  // (tested via capabilityClassOverride to be independent of provider heuristic)
  // ---------------------------------------------------------------------------
  describe("scaffoldLevel derived from capabilityClass", () => {
    it("capabilityClassOverride='frontier' → scaffoldLevel='light'", () => {
      const profile = resolveModelProfile(
        {
          id: "any-model",
          provider: "ollama",
          contextWindow: 128_000,
          reasoning: false,
          input: ["text"],
        },
        undefined,
        "frontier",
      );
      expect(profile.scaffoldLevel).toBe("light");
    });

    it("capabilityClassOverride='mid' → scaffoldLevel='standard'", () => {
      const profile = resolveModelProfile(
        {
          id: "any-model",
          provider: "ollama",
          contextWindow: 128_000,
          reasoning: false,
          input: ["text"],
        },
        undefined,
        "mid",
      );
      expect(profile.scaffoldLevel).toBe("standard");
    });

    it("capabilityClassOverride='small' → scaffoldLevel='max'", () => {
      const profile = resolveModelProfile(
        {
          id: "any-model",
          provider: "ollama",
          contextWindow: 128_000,
          reasoning: false,
          input: ["text"],
        },
        undefined,
        "small",
      );
      expect(profile.scaffoldLevel).toBe("max");
    });

    it("capabilityClassOverride='nano' → scaffoldLevel='max'", () => {
      const profile = resolveModelProfile(
        {
          id: "any-model",
          provider: "ollama",
          contextWindow: 128_000,
          reasoning: false,
          input: ["text"],
        },
        undefined,
        "nano",
      );
      expect(profile.scaffoldLevel).toBe("max");
    });
  });
});
