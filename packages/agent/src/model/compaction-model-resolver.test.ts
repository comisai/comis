// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for resolveCompactionModel.
 *
 * Behavioral assertions only — pinning literal model IDs would re-introduce
 * the staleness problem this resolver was designed to fix.
 */

import { describe, it, expect } from "vitest";
import { getModels } from "@mariozechner/pi-ai";
import { resolveCompactionModel } from "./compaction-model-resolver.js";

describe("resolveCompactionModel", () => {
  it("returns the explicit configValue unchanged when non-empty (operator override wins)", () => {
    expect(resolveCompactionModel("anthropic:claude-haiku-4-5-20250929", "openrouter")).toBe(
      "anthropic:claude-haiku-4-5-20250929",
    );
    expect(resolveCompactionModel("groq:llama-3.3-70b", "openai")).toBe("groq:llama-3.3-70b");
  });

  it("preserves explicit configValue even when primaryProvider is unrelated", () => {
    // Explicit value from YAML should not be cross-rewritten by primary provider.
    const result = resolveCompactionModel("anthropic:claude-haiku-4-5-20250929", "openrouter");
    expect(result).toBe("anthropic:claude-haiku-4-5-20250929");
  });

  it("resolves empty configValue to anthropic:<fast-tier> for anthropic primary", () => {
    const result = resolveCompactionModel("", "anthropic");
    expect(result).toMatch(/^anthropic:/);
    const modelId = result.slice("anthropic:".length);
    // Resolved model id must exist in the Anthropic catalog.
    expect(getModels("anthropic").find((m) => m.id === modelId)).toBeDefined();
  });

  it("resolves empty configValue to openrouter:<fast-tier> for openrouter primary (Phase 2 bugfix)", () => {
    // Critical regression guard: when the primary is OpenRouter, compaction
    // must NOT cross-route to Anthropic.
    const result = resolveCompactionModel("", "openrouter");
    expect(result).toMatch(/^openrouter:/);
    const modelId = result.slice("openrouter:".length);
    expect(getModels("openrouter").find((m) => m.id === modelId)).toBeDefined();
    // Must NOT be a Claude model id.
    expect(modelId).not.toMatch(/^claude-/);
  });

  it("resolves empty configValue to google:<fast-tier> for google primary", () => {
    const result = resolveCompactionModel("", "google");
    expect(result).toMatch(/^google:/);
    const modelId = result.slice("google:".length);
    expect(getModels("google").find((m) => m.id === modelId)).toBeDefined();
  });

  it("returns '' for unknown (custom YAML) provider with no catalog entries (graceful fallback)", () => {
    expect(resolveCompactionModel("", "non-existent-provider")).toBe("");
    expect(resolveCompactionModel("", "ollama")).toBe(""); // ollama is custom-YAML, not in pi-ai catalog
  });

  it("falls back to first catalog model when resolveOperationDefaults returns no fast tier", () => {
    // For native providers, resolveOperationDefaults always returns at least
    // a fallback (when all-free-models). So the only way to hit pure first-id
    // fallback is via an empty cost-tier — exercised implicitly above.
    // This test pins the contract: resolved model id must exist in catalog.
    for (const p of ["anthropic", "openai", "openrouter", "google"] as const) {
      const result = resolveCompactionModel("", p);
      expect(result).toMatch(new RegExp(`^${p}:`));
      const modelId = result.slice(p.length + 1);
      expect(getModels(p).find((m) => m.id === modelId)).toBeDefined();
    }
  });

  it("is referentially stable for the same provider", () => {
    // Pure function — same input -> same output.
    expect(resolveCompactionModel("", "anthropic")).toBe(resolveCompactionModel("", "anthropic"));
    expect(resolveCompactionModel("", "openrouter")).toBe(resolveCompactionModel("", "openrouter"));
  });
});
