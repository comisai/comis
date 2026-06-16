// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { resolveTtsProvider } from "./resolve-tts-provider.js";

/**
 * resolveTtsProvider is the edge-first TTS twin of resolveTranscriptionProvider
 * (design §5): `auto`/default → `edge` (the shipped keyless adapter; the daemon
 * passes `edgeAvailable: () => true`) → (if edge is disabled) follow-main-key →
 * honest-unavailable. Pure, injected predicates, discriminated result, no throws.
 *
 * The `edgeAvailable` predicate is gated (not hardcoded) so the
 * follow-main/honest-unavailable fallthrough is reachable + unit-coverable —
 * parity with the STT resolver's localEngineAvailable rung.
 *
 * Covers RES-02 (edge-first default), the explicit keyed/keyless paths, CRED-01
 * (follow-main only with a present key, on the edge-disabled fallthrough), and
 * RES-05 (no throws).
 */
describe("resolveTtsProvider", () => {
  const EDGE_ON = (): boolean => true; // production: daemon always passes this for the shipped edge adapter
  const EDGE_OFF = (): boolean => false; // edge disabled → exercise the follow-main/honest-unavailable fallthrough
  const NO_AUDIO_KEY = (): boolean => false;
  const HAS_AUDIO_KEY = (): boolean => true;

  it("resolves explicit edge as keyless explicit, even on a codex main (RES-02)", () => {
    const sel = resolveTtsProvider({ provider: "edge" }, "openai-codex", EDGE_ON, NO_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "edge", keyless: true, source: "explicit" });
  });

  it("resolves auto to keyless edge on a codex main — the always-keyless default (RES-02, success-criterion #2)", () => {
    const sel = resolveTtsProvider({ provider: "auto" }, "openai-codex", EDGE_ON, NO_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "edge", keyless: true, source: "keyless-local" });
  });

  it("resolves auto to edge even when the main provider has an audio key (edge wins the auto default)", () => {
    const sel = resolveTtsProvider({ provider: "auto" }, "openai", EDGE_ON, HAS_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "edge", keyless: true, source: "keyless-local" });
  });

  it("resolves an explicit keyed provider with a present key as explicit", () => {
    const sel = resolveTtsProvider({ provider: "openai" }, "ollama", EDGE_ON, HAS_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "openai", keyless: false, source: "explicit" });
  });

  it("returns auth_required for an explicit keyed provider with no key", () => {
    const sel = resolveTtsProvider({ provider: "openai" }, "ollama", EDGE_ON, NO_AUDIO_KEY);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("auth_required");
      expect(sel.hint).toContain("integrations.media.tts.provider");
    }
  });

  it("resolves explicit piper as keyless explicit (the offline rung, Phase 197)", () => {
    const sel = resolveTtsProvider({ provider: "piper" }, "openai-codex", EDGE_ON, NO_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "piper", keyless: true, source: "explicit" });
  });

  it("follows the main key when edge is disabled and the key exists (CRED-01 fallthrough)", () => {
    const sel = resolveTtsProvider({ provider: "auto" }, "openai", EDGE_OFF, HAS_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "openai", keyless: false, source: "follow-main-key" });
  });

  it("NEVER follows-main for an OAuth-only codex main, even when edge is disabled (STEER-01)", () => {
    const sel = resolveTtsProvider({ provider: "auto" }, "openai-codex", EDGE_OFF, HAS_AUDIO_KEY);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("no_keyless_engine");
      expect(sel.hint).toMatch(/Codex OAuth login cannot be used for audio/i);
    }
  });

  it("consults fallback only after edge+follow-main fail, reporting each skip (RES-04 fallthrough)", () => {
    const onSkip = vi.fn();
    const sel = resolveTtsProvider(
      { provider: "auto", fallbackProviders: ["openai", "elevenlabs"] },
      "openai-codex",
      EDGE_OFF,
      (p) => p === "elevenlabs", // openai no key, elevenlabs has one
      onSkip,
    );
    expect(sel).toMatchObject({ ok: true, provider: "elevenlabs", keyless: false, source: "fallback" });
    const reasons = onSkip.mock.calls.map((c) => String(c[0]));
    expect(reasons.some((r) => r.includes("edge unavailable"))).toBe(true);
    expect(reasons.some((r) => r.includes("openai") && /no key/i.test(r))).toBe(true);
  });

  it("resolves a keyless fallback entry without a key when edge is disabled (RES-04)", () => {
    const sel = resolveTtsProvider(
      { provider: "auto", fallbackProviders: ["piper"] },
      "openai-codex",
      EDGE_OFF,
      NO_AUDIO_KEY,
    );
    expect(sel).toMatchObject({ ok: true, provider: "piper", keyless: true, source: "fallback" });
  });

  it("returns honest-unavailable when edge is disabled and nothing else resolves (RES-02 fallthrough)", () => {
    const sel = resolveTtsProvider({ provider: "auto" }, "anthropic", EDGE_OFF, NO_AUDIO_KEY);
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.errorKind).toBe("no_keyless_engine");
  });

  it("never throws on any branch (RES-05)", () => {
    expect(() => resolveTtsProvider({ provider: "auto" }, "", EDGE_ON, NO_AUDIO_KEY)).not.toThrow();
    expect(() => resolveTtsProvider({ provider: "totally-bogus" }, "ollama", EDGE_ON, NO_AUDIO_KEY)).not.toThrow();
    const sel = resolveTtsProvider({ provider: "totally-bogus" }, "ollama", EDGE_ON, NO_AUDIO_KEY);
    expect(sel.ok).toBe(false);
  });
});
