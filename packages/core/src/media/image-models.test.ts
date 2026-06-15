// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for IMAGE_MODELS_BY_PROVIDER + isValidImageModel + listImageModels
 * (IN-02 — the Comis-side per-provider image-model enumeration source of
 * truth). pi-ai's `getImageModels("openai")` returns `[]` (RESEARCH Pitfall 4),
 * so the openai/google validation list lives here, mirroring the sibling
 * `image-capability.ts` const-map shape (closed-map lookup → `undefined` on a
 * miss, never a crash).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  IMAGE_MODELS_BY_PROVIDER,
  isValidImageModel,
  listImageModels,
} from "./image-models.js";

describe("IMAGE_MODELS_BY_PROVIDER", () => {
  it("lists the openai gpt-image default and the google gemini default", () => {
    expect(IMAGE_MODELS_BY_PROVIDER["openai"]).toContain("gpt-image-1");
    expect(IMAGE_MODELS_BY_PROVIDER["google"]).toContain("gemini-2.5-flash-image");
  });
});

describe("isValidImageModel", () => {
  it("accepts a model that is a member of the provider's list", () => {
    expect(isValidImageModel("openai", "gpt-image-1")).toBe(true);
    expect(isValidImageModel("google", "gemini-2.5-flash-image")).toBe(true);
  });

  it("rejects a model that is not a member of the provider's list", () => {
    expect(isValidImageModel("openai", "bogus-model")).toBe(false);
  });

  it("rejects every model for an unknown provider (closed-map miss → no models → false)", () => {
    // anthropic is image-incapable: no entry → undefined → false (never a crash).
    expect(isValidImageModel("anthropic", "x")).toBe(false);
  });
});

describe("listImageModels", () => {
  it("returns the provider's list (for the IN-02 reject hint)", () => {
    expect(listImageModels("openai")).toContain("gpt-image-1");
    expect(listImageModels("google")).toContain("gemini-2.5-flash-image");
  });

  it("returns [] for an unknown provider (closed-map miss → undefined → empty, never a crash)", () => {
    expect(listImageModels("unknown")).toEqual([]);
  });
});
