// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createModelAllowlist } from "./model-allowlist.js";

// ---------------------------------------------------------------------------
// isAllowed
// ---------------------------------------------------------------------------

describe("createModelAllowlist", () => {
  describe("isAllowed", () => {
    it("allows any model when allowlist is empty", () => {
      const allowlist = createModelAllowlist([]);

      expect(allowlist.isAllowed("anthropic", "claude-sonnet-4-5-20250929")).toBe(true);
      expect(allowlist.isAllowed("openai", "gpt-4o")).toBe(true);
      expect(allowlist.isAllowed("google", "gemini-flash")).toBe(true);
    });

    it("blocks unlisted models when allowlist is non-empty", () => {
      const allowlist = createModelAllowlist(["anthropic/claude-sonnet-4-5-20250929"]);

      expect(allowlist.isAllowed("openai", "gpt-4o")).toBe(false);
      expect(allowlist.isAllowed("google", "gemini-flash")).toBe(false);
    });

    it("matches exact provider/modelId format", () => {
      const allowlist = createModelAllowlist(["anthropic/claude-sonnet-4-5-20250929"]);

      expect(allowlist.isAllowed("anthropic", "claude-sonnet-4-5-20250929")).toBe(true);
      expect(allowlist.isAllowed("openai", "claude-sonnet-4-5-20250929")).toBe(false);
    });

    it("matches provider-agnostic modelId format", () => {
      const allowlist = createModelAllowlist(["gpt-4o"]);

      expect(allowlist.isAllowed("openai", "gpt-4o")).toBe(true);
      expect(allowlist.isAllowed("azure", "gpt-4o")).toBe(true);
      expect(allowlist.isAllowed("openai", "gpt-3.5-turbo")).toBe(false);
    });

    it("supports mixed formats in the same allowlist", () => {
      const allowlist = createModelAllowlist([
        "anthropic/claude-sonnet-4-5-20250929",
        "gpt-4o",
      ]);

      expect(allowlist.isAllowed("anthropic", "claude-sonnet-4-5-20250929")).toBe(true);
      expect(allowlist.isAllowed("openai", "gpt-4o")).toBe(true);
      expect(allowlist.isAllowed("openai", "claude-sonnet-4-5-20250929")).toBe(false);
      expect(allowlist.isAllowed("google", "gemini-flash")).toBe(false);
    });

    it("is case-sensitive (no accidental case folding)", () => {
      const allowlist = createModelAllowlist(["openai/GPT-4o"]);

      expect(allowlist.isAllowed("openai", "GPT-4o")).toBe(true);
      expect(allowlist.isAllowed("openai", "gpt-4o")).toBe(false);
      expect(allowlist.isAllowed("OpenAI", "GPT-4o")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // filter
  // ---------------------------------------------------------------------------

  describe("filter", () => {
    const candidates = [
      { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "google", modelId: "gemini-flash" },
    ];

    it("returns all models when allowlist is empty", () => {
      const allowlist = createModelAllowlist([]);

      expect(allowlist.filter(candidates)).toEqual(candidates);
    });

    it("returns only allowed models", () => {
      const allowlist = createModelAllowlist([
        "anthropic/claude-sonnet-4-5-20250929",
        "gpt-4o",
      ]);

      const result = allowlist.filter(candidates);

      expect(result).toHaveLength(2);
      expect(result[0]!.modelId).toBe("claude-sonnet-4-5-20250929");
      expect(result[1]!.modelId).toBe("gpt-4o");
    });

    it("returns empty array when no candidates match", () => {
      const allowlist = createModelAllowlist(["deepseek/deepseek-r1"]);

      expect(allowlist.filter(candidates)).toEqual([]);
    });

    it("preserves extra properties on filtered models", () => {
      const richCandidates = [
        { provider: "openai", modelId: "gpt-4o", input: ["text", "image"] },
        { provider: "google", modelId: "gemini-flash", input: ["text"] },
      ];
      const allowlist = createModelAllowlist(["gpt-4o"]);

      const result = allowlist.filter(richCandidates);

      expect(result).toHaveLength(1);
      expect(result[0]!.input).toEqual(["text", "image"]);
    });
  });

  // ---------------------------------------------------------------------------
  // isActive
  // ---------------------------------------------------------------------------

  describe("isActive", () => {
    it("returns false for empty allowlist", () => {
      expect(createModelAllowlist([]).isActive()).toBe(false);
    });

    it("returns true for non-empty allowlist", () => {
      expect(createModelAllowlist(["gpt-4o"]).isActive()).toBe(true);
    });

    it("returns true for single-entry allowlist", () => {
      expect(createModelAllowlist(["anthropic/claude-sonnet-4-5-20250929"]).isActive()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getRejectionMessage
  // ---------------------------------------------------------------------------

  describe("getRejectionMessage", () => {
    it("returns empty string when allowlist is inactive (empty)", () => {
      const allowlist = createModelAllowlist([]);

      expect(allowlist.getRejectionMessage("openai", "gpt-4o")).toBe("");
    });

    it("returns empty string for an allowed model", () => {
      const allowlist = createModelAllowlist(["openai/gpt-4o", "anthropic/claude-sonnet-4-5-20250929"]);

      expect(allowlist.getRejectionMessage("openai", "gpt-4o")).toBe("");
    });

    it("returns message listing all permitted models for disallowed model", () => {
      const allowlist = createModelAllowlist(["openai/gpt-4o", "anthropic/claude-sonnet-4-5-20250929"]);

      const message = allowlist.getRejectionMessage("google", "gemini-flash");

      expect(message).toContain("google/gemini-flash");
      expect(message).toContain("not allowed");
      expect(message).toContain("openai/gpt-4o");
      expect(message).toContain("anthropic/claude-sonnet-4-5-20250929");
    });

    it("message format includes rejected model name and full permitted list", () => {
      const allowlist = createModelAllowlist(["gpt-4o"]);

      const message = allowlist.getRejectionMessage("openai", "gpt-3.5-turbo");

      expect(message).toBe(
        "Model 'openai/gpt-3.5-turbo' is not allowed. Permitted models: gpt-4o",
      );
    });
  });
});
