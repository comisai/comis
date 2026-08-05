// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveToolChoiceEnforcement } from "./tool-choice-policy.js";

describe("resolveToolChoiceEnforcement", () => {
  it("declares the constraint on a provider that enforces a tool-choice field", () => {
    expect(resolveToolChoiceEnforcement("anthropic")).toBe("declared");
  });

  it("falls back to shipping no tools on a provider that does not enforce one", () => {
    // The cache saving is worth having, the containment is not worth risking. An
    // unlisted provider gets the structural guarantee, so a capability-free turn
    // can never end up holding callable tools.
    for (const provider of ["openai", "openai-codex", "google", "bedrock", "mistral", "ollama"]) {
      expect(resolveToolChoiceEnforcement(provider), provider).toBe("structural");
    }
  });

  it("falls back to shipping no tools when the provider is unknown", () => {
    // Covers both an unresolved model and any provider added after this code —
    // new providers must opt IN to the declared path, never inherit it.
    expect(resolveToolChoiceEnforcement(undefined)).toBe("structural");
    expect(resolveToolChoiceEnforcement("a-provider-that-does-not-exist-yet")).toBe("structural");
  });
});
