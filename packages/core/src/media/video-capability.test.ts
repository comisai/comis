// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { VIDEO_CAPABILITY } from "./video-capability.js";

/**
 * CAP-01: VIDEO_CAPABILITY is the single source of truth for "which resolved
 * main provider has a video API, via which backend + default video model".
 * Keys are RESOLVED-provider ids only (never the config selection enum) — a
 * provider absent from the map is video-incapable (undefined ⇒ honest-unavailable).
 *
 * Provider-following for video is WEAKER than images: only Google (Veo) and
 * xAI (Grok Imagine) have a native video API. openai/anthropic/codex/groq are
 * video-incapable. `auto` is a selection MODE and `fal` is an explicit-only
 * backend — NEITHER is a follow-main capability, so neither may be a key.
 */
describe("VIDEO_CAPABILITY", () => {
  it("maps both google ids to the veo backend with the verified fast default model", () => {
    expect(VIDEO_CAPABILITY["google"]).toEqual({
      videoApi: "veo",
      defaultModel: "veo-3.0-fast-generate-001",
    });
    expect(VIDEO_CAPABILITY["google-vertex"]).toEqual({
      videoApi: "veo",
      defaultModel: "veo-3.0-fast-generate-001",
    });
  });

  it("maps xai to the grok backend with the grok-imagine-video default model", () => {
    expect(VIDEO_CAPABILITY["xai"]).toEqual({
      videoApi: "grok",
      defaultModel: "grok-imagine-video",
    });
  });

  it("resolves openai and anthropic to undefined as video-incapable providers (CAP-01)", () => {
    expect(VIDEO_CAPABILITY["openai"]).toBeUndefined();
    expect(VIDEO_CAPABILITY["anthropic"]).toBeUndefined();
  });

  it("resolves openai-codex and groq to undefined as video-incapable providers (CAP-01)", () => {
    expect(VIDEO_CAPABILITY["openai-codex"]).toBeUndefined();
    expect(VIDEO_CAPABILITY["groq"]).toBeUndefined();
  });

  it("never lists auto as a key — auto is a selection mode, not a capability", () => {
    expect(VIDEO_CAPABILITY["auto"]).toBeUndefined();
  });

  it("never lists fal as a key — fal is an explicit-only backend, not a follow-main capability", () => {
    expect(VIDEO_CAPABILITY["fal"]).toBeUndefined();
  });

  it("resolves unknown and default providers to undefined, never a silent supported", () => {
    expect(VIDEO_CAPABILITY["default"]).toBeUndefined();
    expect(VIDEO_CAPABILITY["mistral"]).toBeUndefined();
  });
});
