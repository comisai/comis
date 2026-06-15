// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `resolveAgentModel` in the setup-agents tooling leaf.
 *
 * Covers the resolver matrix: explicit YAML defaults vs catalog heuristic
 * vs per-agent overrides; case-insensitive `default` handling; per-provider
 * catalog-driven model selection.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { getModels, getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import {
  resolveAgentMainProvider,
  resolveAgentModel,
  resolveEffectiveRerank,
} from "./setup-agents-tooling.js";

describe("resolveAgentModel", () => {
  // Behavioral assertions: avoid pinning literal model IDs (which would
  // re-introduce per-pi-ai-release staleness). Tests assert catalog
  // membership and the priority chain (explicit YAML wins over catalog
  // heuristic; explicit per-agent value wins over both).

  it("resolves model: 'default' to models.defaultModel (explicit YAML wins)", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "anthropic" },
      { defaultModel: "claude-opus-4-20250115", defaultProvider: "" },
    );
    expect(result).toEqual({ model: "claude-opus-4-20250115", provider: "anthropic" });
  });

  it("resolves provider: 'default' to models.defaultProvider (explicit YAML wins)", () => {
    const result = resolveAgentModel(
      { model: "claude-sonnet-4-5-20250929", provider: "default" },
      { defaultModel: "", defaultProvider: "openai" },
    );
    expect(result).toEqual({ model: "claude-sonnet-4-5-20250929", provider: "openai" });
  });

  it("resolves both model and provider 'default' together via explicit YAML", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "default" },
      { defaultModel: "gpt-4o", defaultProvider: "openai" },
    );
    expect(result).toEqual({ model: "gpt-4o", provider: "openai" });
  });

  it("when both YAML defaults are empty, falls back to catalog heuristic with valid (provider, model)", () => {
    // No explicit YAML -> catalog heuristic: most-populated native provider,
    // mid-tier model. Asserts the result is a real pi-ai catalog entry.
    const result = resolveAgentModel(
      { model: "default", provider: "default" },
      { defaultModel: "", defaultProvider: "" },
    );

    // Provider must be a real pi-ai native provider.
    expect(getProviders()).toContain(result.provider as KnownProvider);
    // Model must exist in that provider's catalog.
    const catalogIds = new Set(getModels(result.provider as KnownProvider).map((m) => m.id));
    expect(catalogIds.has(result.model)).toBe(true);
  });

  it("resolves model: 'default' for known provider via catalog (catalog-driven, no hardcoded literal)", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "openai" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result.provider).toBe("openai");
    // Model must be a real OpenAI catalog entry.
    const catalogIds = new Set(getModels("openai").map((m) => m.id));
    expect(catalogIds.has(result.model)).toBe(true);
  });

  it("resolves model: 'default' for anthropic returns a Claude model from catalog", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "anthropic" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result.provider).toBe("anthropic");
    expect(result.model).toMatch(/^claude-/);
    // Must be a live catalog id.
    expect(getModels("anthropic").find((m) => m.id === result.model)).toBeDefined();
  });

  it("resolves model: 'default' for xai (catalog-driven)", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "xai" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result.provider).toBe("xai");
    const catalogIds = new Set(getModels("xai").map((m) => m.id));
    expect(catalogIds.has(result.model)).toBe(true);
  });

  it("resolves provider 'default' to models.defaultProvider, then catalog-derives model", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "default" },
      { defaultModel: "", defaultProvider: "google" },
    );
    expect(result.provider).toBe("google");
    expect(getModels("google").find((m) => m.id === result.model)).toBeDefined();
  });

  it("falls back to first catalog model id for unknown (custom YAML) provider", () => {
    // Unknown provider has no pi-ai catalog -> resolveOperationDefaults({}) returns
    // {}, getModels returns []. Throws because no candidate exists.
    expect(() =>
      resolveAgentModel(
        { model: "default", provider: "unknown-provider" },
        { defaultModel: "", defaultProvider: "" },
      ),
    ).toThrow(/No models found for provider/);
  });

  it("explicit models.defaultModel takes priority over catalog heuristic", () => {
    const result = resolveAgentModel(
      { model: "default", provider: "openai" },
      { defaultModel: "custom-model", defaultProvider: "" },
    );
    expect(result).toEqual({ model: "custom-model", provider: "openai" });
  });

  it("passes through non-'default' values unchanged (explicit per-agent wins over everything)", () => {
    const result = resolveAgentModel(
      { model: "claude-opus-4-20250115", provider: "anthropic" },
      { defaultModel: "gpt-4o", defaultProvider: "openai" },
    );
    expect(result).toEqual({ model: "claude-opus-4-20250115", provider: "anthropic" });
  });

  it("handles case-insensitive 'Default' and 'DEFAULT'", () => {
    const result = resolveAgentModel(
      { model: "Default", provider: "DEFAULT" },
      { defaultModel: "gpt-4o", defaultProvider: "openai" },
    );
    expect(result).toEqual({ model: "gpt-4o", provider: "openai" });
  });

  it("catalog heuristic with empty model defaultModel for openrouter provider returns an OpenRouter model (not Anthropic)", () => {
    // Regression guard: when an operator picks `provider: openrouter` with
    // `model: default`, the resolved model must be an OpenRouter id, not a
    // Claude id.
    const result = resolveAgentModel(
      { model: "default", provider: "openrouter" },
      { defaultModel: "", defaultProvider: "" },
    );
    expect(result.provider).toBe("openrouter");
    expect(result.model).not.toMatch(/^claude-/);
    expect(getModels("openrouter").find((m) => m.id === result.model)).toBeDefined();
  });
});

describe("resolveAgentMainProvider", () => {
  // WR-01 (183-REVIEW): the handler-side accessor that proves the RES-01 I4
  // lockstep — it must resolve the SAME provider the completion path
  // (resolveAgentModel) resolves, INCLUDING the default-agent fallback. The
  // bug was a literal `"default"` fallback that breaks any deployment whose
  // default agent is renamed (CLAUDE.md documents real `mldag` / `head_trader`
  // agents); the fallback must key off the operator-configurable
  // `defaultAgentId`, not the literal string.

  const models = { defaultModel: "", defaultProvider: "" };

  it("resolves the named agent's provider when the agentId is present in the map", () => {
    const agents = {
      mldag: { model: "default", provider: "openrouter" },
      default: { model: "default", provider: "anthropic" },
    };
    expect(resolveAgentMainProvider(agents, models, "mldag", "mldag")).toEqual({
      providerId: "openrouter",
    });
  });

  it("falls back to defaultAgentId (NOT the literal \"default\") for an unmatched agentId on a renamed-default deployment", () => {
    // The deployment's default agent is named "mldag"; there is NO literal
    // "default" entry. An image.generate with no _agentId resolves to "" →
    // must fall back to agents[defaultAgentId="mldag"], NOT agents["default"].
    const agents = {
      mldag: { model: "default", provider: "openrouter" },
    };
    // Pre-fix: `agents["default"]` is undefined → resolveAgentModel(undefined,…)
    // throws "Cannot read properties of undefined" → handler aborts before
    // execute. Post-fix: resolves via defaultAgentId.
    expect(resolveAgentMainProvider(agents, models, "", "mldag")).toEqual({
      providerId: "openrouter",
    });
  });

  it("uses the literal \"default\" agent only when it IS the configured defaultAgentId", () => {
    const agents = {
      default: { model: "default", provider: "anthropic" },
    };
    expect(resolveAgentMainProvider(agents, models, "ghost", "default")).toEqual({
      providerId: "anthropic",
    });
  });

  it("yields an honest non-throwing sentinel when neither the agentId nor the defaultAgentId is in the map", () => {
    // WR-01 extra guard: a misconfigured map (no matching agent, no default
    // entry) must NOT throw resolveAgentModel(undefined,…) — it returns a
    // sentinel providerId with no IMAGE_CAPABILITY entry, driving the honest
    // unavailable path rather than crashing the handler.
    const agents = {
      other: { model: "default", provider: "openrouter" },
    };
    const result = resolveAgentMainProvider(agents, models, "ghost", "missing-default");
    expect(result.providerId).toBeDefined();
    // The sentinel must not be a real image-capable provider id.
    expect(result.providerId).not.toBe("openrouter");
  });
});

describe("resolveEffectiveRerank", () => {
  // The full 2x3 truth table for the pure
  // precedence fn: the explicit operator value (true | false | undefined-if-unset)
  // crossed with the model-present probe result. Explicit ALWAYS wins both
  // directions; unset (undefined) falls through to the presence signal.

  it.each([
    // [explicit, present, expected, why]
    [true, true, true, "explicit true wins when model present"],
    [true, false, true, "explicit true wins even when model absent (opt-in download case)"],
    [false, true, false, "explicit false wins even when model present (operator force-off)"],
    [false, false, false, "explicit false wins when model absent"],
    [undefined, true, true, "unset -> auto-on iff model present"],
    [undefined, false, false, "unset + absent -> off (fresh-install posture)"],
  ] as const)(
    "resolveEffectiveRerank(%s, %s) === %s — %s",
    (explicit, present, expected) => {
      expect(resolveEffectiveRerank(explicit, present)).toBe(expected);
    },
  );

  it("explicit true returns true regardless of presence (explicit wins, on-direction)", () => {
    expect(resolveEffectiveRerank(true, true)).toBe(true);
    expect(resolveEffectiveRerank(true, false)).toBe(true);
  });

  it("explicit false returns false regardless of presence (explicit wins, off-direction)", () => {
    expect(resolveEffectiveRerank(false, true)).toBe(false);
    expect(resolveEffectiveRerank(false, false)).toBe(false);
  });

  it("unset (undefined) mirrors the model-present signal exactly (auto-on gate)", () => {
    expect(resolveEffectiveRerank(undefined, true)).toBe(true);
    expect(resolveEffectiveRerank(undefined, false)).toBe(false);
  });
});
