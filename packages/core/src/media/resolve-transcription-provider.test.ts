// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { resolveTranscriptionProvider } from "./resolve-transcription-provider.js";

/**
 * resolveTranscriptionProvider is a PURE keyless-first priority resolver (no
 * I/O) for STT provider selection. Purity is preserved by injecting two boolean
 * predicates the daemon supplies (`localEngineAvailable` — FALSE until Phase 194
 * wires an engine; `audioKeyAvailable` — a SecretManager lookup, FALSE for
 * OAuth-only mains) and an optional `onSkip` callback. The resolver never
 * touches SecretManager, OAuthTokenManager, process.env, or the network.
 *
 * Covers RES-01 (numbered keyless-first priority + discriminated result),
 * RES-04 (fallbackProviders only after keyless+follow-main, each skip reported),
 * RES-05 (no throws), STEER-01/02 (Codex steered to honest-unavailable, never a
 * keyed openai adapter; hint names the real remedy), and CRED-01 (follow-main
 * only when the key genuinely exists).
 */
describe("resolveTranscriptionProvider", () => {
  const LOCAL_OFF = (): boolean => false;
  const LOCAL_ON = (): boolean => true;
  const NO_AUDIO_KEY = (): boolean => false;
  const HAS_AUDIO_KEY = (): boolean => true;

  it("steers an OAuth-only codex main to honest-unavailable, never a keyed openai adapter (STEER-01/02)", () => {
    const sel = resolveTranscriptionProvider({ provider: "auto" }, "openai-codex", LOCAL_OFF, NO_AUDIO_KEY);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("no_keyless_engine");
      // The hint names the ACTUAL remedy, not "set provider: openai".
      expect(sel.hint).toMatch(/Codex OAuth login cannot be used for audio/i);
      expect(sel.hint).toMatch(/GROQ_API_KEY|OPENAI_API_KEY/);
      expect(sel.hint).toContain("integrations.media.transcription.local.baseUrl");
    }
  });

  it("resolves keyless-local FIRST when the engine is available, even if the main has no key (RES-01)", () => {
    const sel = resolveTranscriptionProvider({ provider: "auto" }, "openai", LOCAL_ON, NO_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "local", keyless: true, source: "keyless-local" });
  });

  it("keyless-local wins over a present main key (the default ordering, Hermes parity)", () => {
    const sel = resolveTranscriptionProvider({ provider: "auto" }, "openai", LOCAL_ON, HAS_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "local", keyless: true, source: "keyless-local" });
  });

  it("follows the main key only when it genuinely exists (CRED-01/RES-01)", () => {
    const sel = resolveTranscriptionProvider({ provider: "auto" }, "openai", LOCAL_OFF, HAS_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "openai", keyless: false, source: "follow-main-key" });
  });

  it("NEVER follows-main when the audio key is absent — the codex case proves no phantom reuse (STEER-01)", () => {
    // openai main, but audioKeyAvailable false → must NOT resolve to a keyed openai adapter.
    const sel = resolveTranscriptionProvider({ provider: "auto" }, "openai", LOCAL_OFF, NO_AUDIO_KEY);
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.errorKind).toBe("no_keyless_engine");
  });

  it("resolves an explicit keyed provider with a present key as explicit (success-criterion #4)", () => {
    const sel = resolveTranscriptionProvider({ provider: "openai" }, "ollama", LOCAL_OFF, HAS_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "openai", keyless: false, source: "explicit" });
  });

  it("returns auth_required for an explicit keyed provider with no key", () => {
    const sel = resolveTranscriptionProvider({ provider: "openai" }, "ollama", LOCAL_OFF, NO_AUDIO_KEY);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("auth_required");
      expect(sel.hint).toContain("integrations.media.transcription.provider");
    }
  });

  it("short-circuits the key gate for an explicit keyless provider (local) even on a codex main", () => {
    const sel = resolveTranscriptionProvider({ provider: "local" }, "openai-codex", LOCAL_OFF, NO_AUDIO_KEY);
    expect(sel).toMatchObject({ ok: true, provider: "local", keyless: true, source: "explicit" });
  });

  it("consults fallback only after keyless+follow-main fail, reporting follow-main FIRST (RES-04)", () => {
    const onSkip = vi.fn();
    // main codex (no audio key), local off, audio key present only for "groq".
    const sel = resolveTranscriptionProvider(
      { provider: "auto", fallbackProviders: ["groq"] },
      "openai-codex",
      LOCAL_OFF,
      (p) => p === "groq",
      onSkip,
    );
    expect(sel).toMatchObject({ ok: true, provider: "groq", keyless: false, source: "fallback" });
    // follow-main must have been reported BEFORE any fallback decision.
    expect(onSkip).toHaveBeenCalled();
    expect(onSkip.mock.calls[0]?.[0]).toMatch(/keyless-local unavailable|follow-main|no usable audio key/i);
  });

  it("reports a fallback entry with no key as skipped, never silently falling through (RES-04)", () => {
    const onSkip = vi.fn();
    const sel = resolveTranscriptionProvider(
      { provider: "auto", fallbackProviders: ["openai", "groq"] },
      "openai-codex",
      LOCAL_OFF,
      (p) => p === "groq", // openai has no key, groq does
      onSkip,
    );
    expect(sel).toMatchObject({ ok: true, provider: "groq", source: "fallback" });
    const reasons = onSkip.mock.calls.map((c) => String(c[0]));
    expect(reasons.some((r) => r.includes("openai") && /no key/i.test(r))).toBe(true);
  });

  it("resolves a keyless fallback entry without a key (VOICE_KEYLESS short-circuit, RES-04)", () => {
    const sel = resolveTranscriptionProvider(
      { provider: "auto", fallbackProviders: ["local"] },
      "openai-codex",
      LOCAL_OFF,
      NO_AUDIO_KEY,
    );
    expect(sel).toMatchObject({ ok: true, provider: "local", keyless: true, source: "fallback" });
  });

  it("never throws for an empty/unknown/exhausted config (RES-05)", () => {
    expect(() => resolveTranscriptionProvider({ provider: "auto" }, "", LOCAL_OFF, NO_AUDIO_KEY)).not.toThrow();
    expect(() =>
      resolveTranscriptionProvider({ provider: "totally-bogus" }, "ollama", LOCAL_OFF, NO_AUDIO_KEY),
    ).not.toThrow();
    expect(() =>
      resolveTranscriptionProvider({ provider: "auto", fallbackProviders: [] }, "anthropic", LOCAL_OFF, NO_AUDIO_KEY),
    ).not.toThrow();
    // an unknown explicit provider with no key resolves to honest auth_required, not a crash.
    const sel = resolveTranscriptionProvider({ provider: "totally-bogus" }, "ollama", LOCAL_OFF, NO_AUDIO_KEY);
    expect(sel.ok).toBe(false);
  });
});
