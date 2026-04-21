// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createModelAliasResolver } from "./model-alias-resolver.js";
import { createModelCatalog } from "./model-catalog.js";

// ---------------------------------------------------------------------------
// createModelAliasResolver
// ---------------------------------------------------------------------------

describe("createModelAliasResolver", () => {
  const aliases = [
    { alias: "claude", provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
    { alias: "gpt4", provider: "openai", modelId: "gpt-4o" },
    { alias: "gemini", provider: "google", modelId: "gemini-2.0-flash" },
  ];

  // -------------------------------------------------------------------------
  // Alias resolution
  // -------------------------------------------------------------------------

  describe("alias resolution", () => {
    it("resolves alias 'claude' to configured provider/model pair", () => {
      const resolver = createModelAliasResolver({ aliases });

      const result = resolver.resolve("claude");

      expect(result).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" });
    });

    it("resolves alias matching case-insensitively ('Claude' and 'CLAUDE' both work)", () => {
      const resolver = createModelAliasResolver({ aliases });

      expect(resolver.resolve("Claude")).toEqual({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5-20250929",
      });
      expect(resolver.resolve("CLAUDE")).toEqual({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5-20250929",
      });
      expect(resolver.resolve("GPT4")).toEqual({
        provider: "openai",
        modelId: "gpt-4o",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Slash-separated input
  // -------------------------------------------------------------------------

  describe("slash-separated input", () => {
    it("splits 'anthropic/claude-sonnet-4' on first '/'", () => {
      const resolver = createModelAliasResolver({ aliases });

      const result = resolver.resolve("anthropic/claude-sonnet-4");

      expect(result).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4" });
    });

    it("handles provider/modelId with multiple slashes (splits on first only)", () => {
      const resolver = createModelAliasResolver({ aliases });

      const result = resolver.resolve("azure/openai/gpt-4o");

      expect(result).toEqual({ provider: "azure", modelId: "openai/gpt-4o" });
    });
  });

  // -------------------------------------------------------------------------
  // Catalog fallback
  // -------------------------------------------------------------------------

  describe("catalog fallback", () => {
    it("falls through to catalog lookup for unknown alias", () => {
      const catalog = createModelCatalog();
      // Manually add one entry for testing without loading full pi-ai registry
      catalog.mergeScanned([
        {
          provider: "anthropic",
          modelId: "claude-haiku-3",
          displayName: "Claude 3 Haiku",
          contextWindow: 200000,
          maxTokens: 4096,
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          validated: true,
          validatedAt: Date.now(),
        },
      ]);

      const resolver = createModelAliasResolver({
        aliases,
        catalog,
        defaultProvider: "anthropic",
      });

      const result = resolver.resolve("claude-haiku-3");

      expect(result).toEqual({ provider: "anthropic", modelId: "claude-haiku-3" });
    });

    it("returns { provider: defaultProvider, modelId: input } when no catalog match and defaultProvider set", () => {
      const resolver = createModelAliasResolver({
        aliases,
        defaultProvider: "anthropic",
      });

      const result = resolver.resolve("some-unknown-model");

      expect(result).toEqual({ provider: "anthropic", modelId: "some-unknown-model" });
    });
  });

  // -------------------------------------------------------------------------
  // No match
  // -------------------------------------------------------------------------

  describe("no match", () => {
    it("returns undefined when no alias, no slash, no catalog, no defaultProvider", () => {
      const resolver = createModelAliasResolver({ aliases: [] });

      const result = resolver.resolve("some-unknown-model");

      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getAliases
  // -------------------------------------------------------------------------

  describe("getAliases", () => {
    it("returns all configured aliases", () => {
      const resolver = createModelAliasResolver({ aliases });

      const result = resolver.getAliases();

      expect(result).toEqual(aliases);
    });

    it("returns empty array when no aliases configured", () => {
      const resolver = createModelAliasResolver({ aliases: [] });

      expect(resolver.getAliases()).toEqual([]);
    });
  });
});
