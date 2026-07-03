// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { IMAGE_CAPABILITY } from "./image-capability.js";

/**
 * IMAGE_CAPABILITY is the single source of truth for "which resolved
 * main provider can generate images, and via which images API + default model".
 * Keys are RESOLVED-provider ids only (never the config selection enum) — a
 * provider absent from the map is image-incapable (undefined ⇒ unsupported).
 */
describe("IMAGE_CAPABILITY", () => {
  it("resolves anthropic to undefined as an image-incapable provider", () => {
    expect(IMAGE_CAPABILITY["anthropic"]).toBeUndefined();
  });

  it("maps openai-codex to the openai-codex-images api", () => {
    expect(IMAGE_CAPABILITY["openai-codex"]?.imagesApi).toBe("openai-codex-images");
  });

  it("gives openai-codex a gpt-image-1 default model", () => {
    expect(IMAGE_CAPABILITY["openai-codex"]?.defaultModel).toBe("gpt-image-1");
  });

  it("maps openrouter to its verified images api and flux.2-pro default model", () => {
    expect(IMAGE_CAPABILITY["openrouter"]).toEqual({
      imagesApi: "openrouter-images",
      defaultModel: "black-forest-labs/flux.2-pro",
    });
  });

  it("maps both google ids to the single google-images api", () => {
    expect(IMAGE_CAPABILITY["google"]?.imagesApi).toBe("google-images");
    expect(IMAGE_CAPABILITY["google-vertex"]?.imagesApi).toBe("google-images");
  });

  it("resolves unknown and default providers to undefined, never a silent supported", () => {
    expect(IMAGE_CAPABILITY["default"]).toBeUndefined();
    expect(IMAGE_CAPABILITY["mistral"]).toBeUndefined();
  });
});
