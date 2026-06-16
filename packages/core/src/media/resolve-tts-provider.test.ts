// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveTtsProvider } from "./resolve-tts-provider.js";

/**
 * resolveTtsProvider is the edge-first TTS twin of resolveTranscriptionProvider
 * (design §5): `auto`/default → `edge` (always keyless, the shipped adapter) →
 * optional `piper` (keyless, honest-unavailable until Phase 197) → main-key →
 * honest-unavailable. Pure, injected predicates, discriminated result, no throws.
 *
 * Covers RES-02 (edge-first default), the explicit keyed/keyless paths, CRED-01
 * (follow-main only with a present key — though edge wins the auto default), and
 * RES-05 (no throws).
 */
describe("resolveTtsProvider", () => {
  const EDGE_OFF = (): boolean => false;
  const NO_AUDIO_KEY = (): boolean => false;
  const HAS_AUDIO_KEY = (): boolean => true;

  it("resolves explicit edge as keyless explicit, even on a codex main (RES-02)", () => {
    const sel = resolveTtsProvider({ provider: "edge" }, "openai-codex", EDGE_OFF, NO_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "edge", keyless: true, source: "explicit" });
  });

  it("resolves auto to keyless edge on a codex main — the always-keyless default (RES-02, success-criterion #2)", () => {
    const sel = resolveTtsProvider({ provider: "auto" }, "openai-codex", EDGE_OFF, NO_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "edge", keyless: true, source: "keyless-local" });
  });

  it("resolves auto to edge even when the main provider has an audio key (edge wins the auto default)", () => {
    const sel = resolveTtsProvider({ provider: "auto" }, "openai", EDGE_OFF, HAS_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "edge", keyless: true, source: "keyless-local" });
  });

  it("resolves an explicit keyed provider with a present key as explicit", () => {
    const sel = resolveTtsProvider({ provider: "openai" }, "ollama", EDGE_OFF, HAS_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "openai", keyless: false, source: "explicit" });
  });

  it("returns auth_required for an explicit keyed provider with no key", () => {
    const sel = resolveTtsProvider({ provider: "openai" }, "ollama", EDGE_OFF, NO_AUDIO_KEY);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("auth_required");
      expect(sel.hint).toContain("integrations.media.tts.provider");
    }
  });

  it("resolves explicit piper as keyless explicit (the offline rung, Phase 197)", () => {
    const sel = resolveTtsProvider({ provider: "piper" }, "openai-codex", EDGE_OFF, NO_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "piper", keyless: true, source: "explicit" });
  });

  it("never throws on any branch (RES-05)", () => {
    expect(() => resolveTtsProvider({ provider: "auto" }, "", EDGE_OFF, NO_AUDIO_KEY)).not.toThrow();
    expect(() => resolveTtsProvider({ provider: "totally-bogus" }, "ollama", EDGE_OFF, NO_AUDIO_KEY)).not.toThrow();
    const sel = resolveTtsProvider({ provider: "totally-bogus" }, "ollama", EDGE_OFF, NO_AUDIO_KEY);
    expect(sel.ok).toBe(false);
  });
});
