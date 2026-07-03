// SPDX-License-Identifier: Apache-2.0
/**
 * Boundary invariant tests for resolveModelProfile().
 *
 * Invariants tested:
 *  - Fail-closed: unknown/undefined model → most-locked profile (capabilityClass="nano",
 *    scaffoldLevel="max", securityLevel="locked")
 *  - capabilityClass ⊥ contextWindow: a 256K window must NOT force
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
  capabilityClassFromProvider,
  autoRepairForClass,
} from "./model-profile.js";
import type { ModelProfile, CapabilityClass } from "./model-profile.js";

// ---------------------------------------------------------------------------
// Fail-closed: unknown / undefined model → most-locked profile
// ---------------------------------------------------------------------------
describe("resolveModelProfile — capability/capacity boundary invariants", () => {
  describe("fail-closed profile for an undefined model", () => {
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
  // contextWindow is DECOUPLED from capabilityClass:
  // a 256K window must NOT force frontier or mid class
  // ---------------------------------------------------------------------------
  describe("supportsPromptCache — cache_control is Anthropic-only (codex turn-abort regression)", () => {
    // The catalog `cost.cacheRead > 0` signal must NOT imply Anthropic-style
    // cache_control breakpoints for OpenAI/Google providers — they cache
    // automatically (prompt_cache_key / cachedContent), NOT via cache_control.
    // A false-positive ran the cache_control breakpoint machinery on the
    // openai-codex (responses API) body and stripped tool `type:"function"`,
    // yielding a 400 "Unsupported tool type: None" and a silent turn abort
    // ("AI didn't produce a response") on a fresh VPS install.
    type ModelArg = Parameters<typeof resolveModelProfile>[0];
    it("openai-codex with cacheRead>0 → supportsPromptCache=false", () => {
      const profile = resolveModelProfile({
        id: "gpt-5.5",
        provider: "openai-codex",
        contextWindow: 272_000,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      } as unknown as ModelArg);
      expect(profile.supportsPromptCache).toBe(false);
    });

    it("openai (chat) with cacheRead>0 → supportsPromptCache=false", () => {
      const profile = resolveModelProfile({
        id: "gpt-5.1",
        provider: "openai",
        contextWindow: 400_000,
        reasoning: true,
        input: ["text"],
        cost: { cacheRead: 0.25 },
      } as unknown as ModelArg);
      expect(profile.supportsPromptCache).toBe(false);
    });

    it("anthropic with cacheRead>0 → supportsPromptCache=true (unchanged)", () => {
      const profile = resolveModelProfile({
        id: "claude-sonnet-4",
        provider: "anthropic",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text"],
        cost: { cacheRead: 0.3 },
      } as unknown as ModelArg);
      expect(profile.supportsPromptCache).toBe(true);
    });
  });

  describe("capabilityClass is independent of contextWindow", () => {
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
    it("resolves securityLevel='standard' for a frontier anthropic model (200K context)", () => {
      const profile = resolveModelProfile({
        id: "claude-sonnet-4",
        provider: "anthropic",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.securityLevel).toBe("standard");
    });

    it("resolves securityLevel to hardened or locked for a small/nano ollama model (256K context)", () => {
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
    it("resolves scaffoldLevel='light' when capabilityClassOverride is 'frontier'", () => {
      const profile = resolveModelProfile(
        {
          id: "any-model",
          provider: "ollama",
          contextWindow: 128_000,
          reasoning: false,
          input: ["text"],
        },
        "frontier",
      );
      expect(profile.scaffoldLevel).toBe("light");
    });

    it("resolves scaffoldLevel='standard' when capabilityClassOverride is 'mid'", () => {
      const profile = resolveModelProfile(
        {
          id: "any-model",
          provider: "ollama",
          contextWindow: 128_000,
          reasoning: false,
          input: ["text"],
        },
        "mid",
      );
      expect(profile.scaffoldLevel).toBe("standard");
    });

    it("resolves scaffoldLevel='max' when capabilityClassOverride is 'small'", () => {
      const profile = resolveModelProfile(
        {
          id: "any-model",
          provider: "ollama",
          contextWindow: 128_000,
          reasoning: false,
          input: ["text"],
        },
        "small",
      );
      expect(profile.scaffoldLevel).toBe("max");
    });

    it("resolves scaffoldLevel='max' when capabilityClassOverride is 'nano'", () => {
      const profile = resolveModelProfile(
        {
          id: "any-model",
          provider: "ollama",
          contextWindow: 128_000,
          reasoning: false,
          input: ["text"],
        },
        "nano",
      );
      expect(profile.scaffoldLevel).toBe("max");
    });
  });

  // ---------------------------------------------------------------------------
  // Provider alias classification — bedrock/vertex/azure must NOT fall
  // through to capabilityClass="small". Tests cover the security-load-bearing
  // path: amazon-bedrock (Anthropic Claude via AWS) and google-vertex
  // (Gemini via GCP Vertex) must resolve to their true capability class.
  // ---------------------------------------------------------------------------
  describe("provider alias classification — bedrock/vertex/azure map to correct family", () => {
    it("amazon-bedrock resolves capabilityClass='frontier' (NOT small)", () => {
      const profile = resolveModelProfile({
        id: "anthropic.claude-sonnet-4-5",
        provider: "amazon-bedrock",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.capabilityClass).toBe("frontier");
    });

    it("amazon-bedrock resolves securityLevel='standard' (NOT locked)", () => {
      const profile = resolveModelProfile({
        id: "anthropic.claude-sonnet-4-5",
        provider: "amazon-bedrock",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.securityLevel).toBe("standard");
    });

    it("google-vertex resolves capabilityClass='mid' (NOT small)", () => {
      const profile = resolveModelProfile({
        id: "gemini-2.5-pro",
        provider: "google-vertex",
        contextWindow: 1_000_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.capabilityClass).toBe("mid");
    });

    it("google-vertex resolves securityLevel='hardened' (NOT locked)", () => {
      const profile = resolveModelProfile({
        id: "gemini-2.5-pro",
        provider: "google-vertex",
        contextWindow: 1_000_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.securityLevel).toBe("hardened");
    });

    it("azure-openai-responses resolves capabilityClass='frontier' (NOT small)", () => {
      const profile = resolveModelProfile({
        id: "gpt-4o",
        provider: "azure-openai-responses",
        contextWindow: 128_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.capabilityClass).toBe("frontier");
    });

    it("bedrock alias resolves capabilityClass='frontier'", () => {
      const profile = resolveModelProfile({
        id: "anthropic.claude-opus-4",
        provider: "bedrock",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.capabilityClass).toBe("frontier");
    });

    it("genuinely-unknown provider (ollama) still resolves capabilityClass='small'", () => {
      const profile = resolveModelProfile({
        id: "llama3:8b",
        provider: "ollama",
        contextWindow: 8_192,
        reasoning: false,
        input: ["text"],
      });
      expect(profile.capabilityClass).toBe("small");
    });

    it("undefined model still returns FAIL_CLOSED_PROFILE (nano/locked)", () => {
      const profile = resolveModelProfile(undefined);
      expect(profile.capabilityClass).toBe("nano");
      expect(profile.securityLevel).toBe("locked");
    });
  });

  // ---------------------------------------------------------------------------
  // supportsPromptCache enriched with SDK Model.compat.cacheControlFormat
  // and Model.cost.cacheRead. Covers openai-compat providers like
  // Fireworks/OpenRouter that support Anthropic-style caching.
  // Frontier byte-identical: Anthropic/Bedrock MUST still resolve true.
  // Fail-safe direction: prefer false-negative over false-positive.
  // ---------------------------------------------------------------------------
  describe("supportsPromptCache SDK enrichment", () => {
    it("supportsPromptCache=true for anthropic (frontier byte-identical)", () => {
      const profile = resolveModelProfile({
        id: "claude-sonnet-4-5",
        provider: "anthropic",
        contextWindow: 200_000,
        maxTokens: 8_192,
        reasoning: false,
        input: ["text"],
      });
      expect(profile.supportsPromptCache).toBe(true);
    });

    it("supportsPromptCache=true for amazon-bedrock (frontier byte-identical)", () => {
      const profile = resolveModelProfile({
        id: "anthropic.claude-sonnet-4-5-20250929",
        provider: "amazon-bedrock",
        contextWindow: 200_000,
        maxTokens: 8_192,
        reasoning: false,
        input: ["text"],
      });
      expect(profile.supportsPromptCache).toBe(true);
    });

    it("supportsPromptCache=true when Model has compat.cacheControlFormat='anthropic' (openai-compat provider)", () => {
      const profile = resolveModelProfile({
        id: "accounts/fireworks/models/llama-v3p1-70b-instruct",
        provider: "fireworks",
        contextWindow: 131_072,
        maxTokens: 16_384,
        reasoning: false,
        input: ["text"],
        compat: { cacheControlFormat: "anthropic" },
      });
      expect(profile.supportsPromptCache).toBe(true);
    });

    it("supportsPromptCache=true when Model has cost.cacheRead>0 (native caching signal)", () => {
      const profile = resolveModelProfile({
        id: "accounts/fireworks/models/llama-v3p1-70b-instruct",
        provider: "fireworks",
        contextWindow: 131_072,
        maxTokens: 16_384,
        reasoning: false,
        input: ["text"],
        cost: { cacheRead: 0.2 },
      });
      expect(profile.supportsPromptCache).toBe(true);
    });

    it("supportsPromptCache=false for plain non-caching provider (no compat.cacheControlFormat, cost.cacheRead=0)", () => {
      const profile = resolveModelProfile({
        id: "gpt-4o",
        provider: "openai",
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: false,
        input: ["text", "image"],
        cost: { cacheRead: 0 },
      });
      expect(profile.supportsPromptCache).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // supportsPromptCache must reflect the REAL provider-family capability.
  // The factory/cache-detection swap reads
  //   `config.modelProfile?.supportsPromptCache ?? isAnthropicFamily(provider)`,
  // whose `??` only falls through on `undefined`. A hardcoded `false` therefore
  // silently disabled Anthropic prompt caching. supportsPromptCache must be
  // `true` for the anthropic family (anthropic, amazon-bedrock, aliases) and
  // `false` for everything else.
  // ---------------------------------------------------------------------------
  describe("supportsPromptCache reflects provider-family caching capability", () => {
    it("anthropic model resolves supportsPromptCache=true", () => {
      const profile = resolveModelProfile({
        id: "claude-sonnet-4-5",
        provider: "anthropic",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.supportsPromptCache).toBe(true);
    });

    it("amazon-bedrock (Anthropic via AWS) resolves supportsPromptCache=true", () => {
      const profile = resolveModelProfile({
        id: "anthropic.claude-sonnet-4-5",
        provider: "amazon-bedrock",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.supportsPromptCache).toBe(true);
    });

    it("bedrock alias resolves supportsPromptCache=true", () => {
      const profile = resolveModelProfile({
        id: "anthropic.claude-opus-4",
        provider: "bedrock",
        contextWindow: 200_000,
        reasoning: false,
        input: ["text"],
      });
      expect(profile.supportsPromptCache).toBe(true);
    });

    it("ollama (local) model resolves supportsPromptCache=false", () => {
      const profile = resolveModelProfile({
        id: "qwen3.6:35b",
        provider: "ollama",
        contextWindow: 262_144,
        reasoning: false,
        input: ["text"],
      });
      expect(profile.supportsPromptCache).toBe(false);
    });

    it("openai model resolves supportsPromptCache=false (no anthropic-style cache_control)", () => {
      const profile = resolveModelProfile({
        id: "gpt-4o",
        provider: "openai",
        contextWindow: 128_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.supportsPromptCache).toBe(false);
    });

    it("google model resolves supportsPromptCache=false (uses Gemini CachedContent, not cache_control)", () => {
      const profile = resolveModelProfile({
        id: "gemini-2.5-pro",
        provider: "google",
        contextWindow: 1_000_000,
        reasoning: false,
        input: ["text", "image"],
      });
      expect(profile.supportsPromptCache).toBe(false);
    });

    it("unknown/undefined model fails closed to supportsPromptCache=false", () => {
      const profile = resolveModelProfile(undefined);
      expect(profile.supportsPromptCache).toBe(false);
    });
  });

  // The standalone provider→capabilityClass heuristic that the daemon-side resolvers
  // (pipeline:authored telemetry tier, authored-model repair) fall back to when no
  // operator override is pinned. Live bug: pipeline:authored emitted capabilityClass:"unknown"
  // for an anthropic agent because the override-only resolver returned undefined.
  describe("capabilityClassFromProvider (provider-family heuristic)", () => {
    it("maps anthropic family → frontier (incl. amazon-bedrock alias)", () => {
      expect(capabilityClassFromProvider("anthropic")).toBe("frontier");
      expect(capabilityClassFromProvider("amazon-bedrock")).toBe("frontier");
    });
    it("maps openai family → frontier (incl. openai-codex / azure aliases)", () => {
      expect(capabilityClassFromProvider("openai")).toBe("frontier");
      expect(capabilityClassFromProvider("openai-codex")).toBe("frontier");
      expect(capabilityClassFromProvider("azure-openai-responses")).toBe("frontier");
    });
    it("maps google family → mid", () => {
      expect(capabilityClassFromProvider("google")).toBe("mid");
      expect(capabilityClassFromProvider("google-vertex")).toBe("mid");
    });
    it("maps all other providers → small (fail-safe)", () => {
      expect(capabilityClassFromProvider("ollama")).toBe("small");
      expect(capabilityClassFromProvider("groq")).toBe("small");
    });
    it("returns undefined for an undefined/empty provider (caller decides fail-safe)", () => {
      expect(capabilityClassFromProvider(undefined)).toBeUndefined();
      expect(capabilityClassFromProvider("")).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// AUTOREPAIR_FOR per-class policy — the pure class-gate the orchestrate runner
// consults before firing the one-shot repair seam. Auto-repair is ON for the
// weaker models (small/nano) that benefit from a corrective re-prompt and OFF
// for the stronger ones (frontier/mid), which get their scripts right the first
// time and would only burn tokens. Mirrors the SCAFFOLD_FOR/SECURITY_FOR
// sibling tables: the Record<CapabilityClass, boolean> typing is exhaustive by
// construction, so a new class member fails the build until it is classified.
// ---------------------------------------------------------------------------
describe("autoRepairForClass — per-class auto-repair policy", () => {
  it("enables auto-repair for the small class (weak model → corrective re-prompt helps)", () => {
    expect(autoRepairForClass("small")).toBe(true);
  });

  it("enables auto-repair for the nano class (weakest model → corrective re-prompt helps)", () => {
    expect(autoRepairForClass("nano")).toBe(true);
  });

  it("disables auto-repair for the frontier class (strong model → no wasteful re-prompt)", () => {
    expect(autoRepairForClass("frontier")).toBe(false);
  });

  it("disables auto-repair for the mid class (strong model → no wasteful re-prompt)", () => {
    expect(autoRepairForClass("mid")).toBe(false);
  });

  it("covers the full four-class table exactly (small/nano on, frontier/mid off)", () => {
    const table = (["frontier", "mid", "small", "nano"] as CapabilityClass[]).map(
      (cls) => [cls, autoRepairForClass(cls)] as const,
    );
    expect(table).toEqual([
      ["frontier", false],
      ["mid", false],
      ["small", true],
      ["nano", true],
    ]);
  });
});
