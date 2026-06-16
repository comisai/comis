// SPDX-License-Identifier: Apache-2.0
/**
 * WR-03 (Phase 196 review): `wireVoiceForHandler` honest fallback rung.
 *
 * On the selector-less boot path (`deps.voiceSelection` absent — a boot mode
 * without the audio selector / a pre-193 harness) the shim derives the OBS-03
 * `source`/`keyless` from the config provider. It must NOT fabricate
 * `source:"explicit"` for an UNPINNED provider (`auto` / the `?? "configured"`
 * placeholder) — that is a dishonest selection rung on exactly the degraded boot
 * mode where diagnosis matters most. A concrete config provider IS an explicit
 * pin and keeps `"explicit"`. These tests fail on the pre-fix code (which always
 * hardcoded `"explicit"`).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { wireVoiceForHandler } from "./voice-handler-wiring.js";
import type { ComisLogger } from "@comis/core";

/** A no-op logger — wireVoiceForHandler's §2.7 lines only fire on completed/failed. */
const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  child: () => noopLogger,
} as unknown as ComisLogger;

/** Build the minimal VoiceWiringDeps slice wireVoiceForHandler reads, with NO
 *  voiceSelection (forces the config-derived fallback path) and a given config
 *  provider for both stt + tts. */
function depsWithConfigProvider(provider: string | undefined) {
  return {
    mediaConfig: {
      transcription: provider !== undefined ? { provider } : {},
      tts: provider !== undefined ? { provider } : {},
    },
    trajectoryRegistry: undefined,
    logger: noopLogger,
    defaultAgentId: "default",
    resolveAgentMainProvider: () => ({ providerId: "openai" }),
    voiceSelection: undefined,
  } as unknown as Parameters<typeof wireVoiceForHandler>[1];
}

describe("wireVoiceForHandler — WR-03 honest fallback rung (no voiceSelection)", () => {
  it("labels an UNPINNED `auto` config provider source:'fallback' (not 'explicit')", () => {
    const wired = wireVoiceForHandler({}, depsWithConfigProvider("auto"), "stt");
    expect(wired.provider).toBe("auto");
    expect(wired.source).toBe("fallback"); // pre-fix: "explicit" (dishonest)
    expect(wired.keyless).toBe(false); // best-effort: auto isn't in the keyless set
  });

  it("labels the `?? 'configured'` placeholder (no config provider) source:'fallback'", () => {
    const wired = wireVoiceForHandler({}, depsWithConfigProvider(undefined), "tts");
    expect(wired.provider).toBe("configured");
    expect(wired.source).toBe("fallback");
  });

  it("keeps source:'explicit' for a CONCRETE config provider (a genuine verbatim pin)", () => {
    const wired = wireVoiceForHandler({}, depsWithConfigProvider("openai"), "stt");
    expect(wired.provider).toBe("openai");
    expect(wired.source).toBe("explicit");
    expect(wired.keyless).toBe(false);
  });

  it("a concrete keyless config provider (`local`) is explicit + keyless on the fallback path", () => {
    const wired = wireVoiceForHandler({}, depsWithConfigProvider("local"), "stt");
    expect(wired.provider).toBe("local");
    expect(wired.source).toBe("explicit");
    expect(wired.keyless).toBe(true);
  });
});
