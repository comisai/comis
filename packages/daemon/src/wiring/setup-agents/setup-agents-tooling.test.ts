// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 43 wave 8 split (FILE-SPLIT-08): setup-agents.ts → setup-agents/
 * subdirectory. The tooling leaf hosts `resolveAgentModel` + pure helpers;
 * this test file mirrors the resolver matrix that used to live in
 * setup-agents.test.ts §"resolveAgentModel" (lines 70-203 pre-split).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";
import { resolveAgentModel } from "./setup-agents-tooling.js";

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
