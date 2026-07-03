// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for buildMediaConfig (MEDIA infrastructure).
 *
 * Verifies the per-combo media config builder writes a temp YAML with the REAL
 * integrations.media.* schema keys for any tts/stt/vision/imageGen combo:
 *   - transcription.provider + transcription.fallbackProviders (NOT "fallback" —
 *     the strict config schema would reject that key at daemon boot)
 *   - tts.provider + tts.autoMode
 *   - vision.providers
 *   - imageGeneration.provider
 *
 * Mirrors orch-config.test.ts / mcp-config.test.ts structure. Always runs (no
 * COMIS_LIVE needed — pure file-writer assertions).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { buildMediaConfig } from "./media-config.js";

describe("buildMediaConfig", () => {
  it("writes a tts block with provider + autoMode when ttsProvider/ttsAutoMode set", () => {
    const p = buildMediaConfig({ ttsProvider: "edge", ttsAutoMode: "always", label: "t1" });
    try {
      expect(existsSync(p)).toBe(true);
      const yaml = readFileSync(p, "utf-8");
      expect(yaml).toContain("integrations:");
      expect(yaml).toContain("media:");
      expect(yaml).toContain("tts:");
      expect(yaml).toContain("provider: edge");
      expect(yaml).toContain("autoMode: always");
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("writes a transcription block with the REAL fallbackProviders key (not 'fallback') when sttFallback set", () => {
    const p = buildMediaConfig({ sttProvider: "openai", sttFallback: true, label: "t2" });
    try {
      const yaml = readFileSync(p, "utf-8");
      expect(yaml).toContain("transcription:");
      expect(yaml).toContain("provider: openai");
      // The REAL TranscriptionConfigSchema key is `fallbackProviders` (array of
      // openai|groq|deepgram). Emitting `fallback:` would be rejected by the
      // daemon's z.strictObject at boot.
      expect(yaml).toMatch(/fallbackProviders:/);
      expect(yaml).toMatch(/-\s*groq/);
      // Must NOT emit a bare `fallback:` key.
      expect(yaml).not.toMatch(/^\s*fallback:\s*$/m);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("writes a vision block with the providers list when visionProviders set", () => {
    const p = buildMediaConfig({ visionProviders: ["openai", "anthropic"], label: "t3" });
    try {
      const yaml = readFileSync(p, "utf-8");
      expect(yaml).toContain("vision:");
      expect(yaml).toContain("providers:");
      expect(yaml).toMatch(/-\s*openai/);
      expect(yaml).toMatch(/-\s*anthropic/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("writes an imageGeneration block with provider when imageGenProvider set", () => {
    const p = buildMediaConfig({ imageGenProvider: "fal", label: "t4" });
    try {
      const yaml = readFileSync(p, "utf-8");
      expect(yaml).toContain("imageGeneration:");
      expect(yaml).toContain("provider: fal");
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("returns an existing file and omits optional blocks when no media opts given", () => {
    const p = buildMediaConfig({ label: "t5" });
    try {
      expect(existsSync(p)).toBe(true);
      const yaml = readFileSync(p, "utf-8");
      // No media sub-blocks were requested → none should be emitted.
      expect(yaml).not.toContain("imageGeneration:");
      expect(yaml).not.toContain("autoMode:");
      expect(yaml).not.toContain("fallbackProviders:");
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("combines tts + transcription + vision + imageGeneration into one media block", () => {
    const p = buildMediaConfig({
      ttsProvider: "edge",
      ttsAutoMode: "inbound",
      sttProvider: "openai",
      sttFallback: true,
      visionProviders: ["openai", "anthropic"],
      imageGenProvider: "fal",
      label: "t6",
    });
    try {
      const yaml = readFileSync(p, "utf-8");
      // Exactly one integrations: and one media: header.
      expect((yaml.match(/^integrations:/gm) ?? []).length).toBe(1);
      expect((yaml.match(/^\s*media:/gm) ?? []).length).toBe(1);
      expect(yaml).toContain("provider: edge");
      expect(yaml).toContain("autoMode: inbound");
      expect(yaml).toContain("fallbackProviders:");
      expect(yaml).toContain("imageGeneration:");
    } finally {
      rmSync(p, { force: true });
    }
  });
});
