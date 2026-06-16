// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the keyless-first audio-provider selector (setup-audio-provider.ts).
 *
 * The selector threads the Plan-01 pure resolvers (resolveTranscriptionProvider /
 * resolveTtsProvider) + the daemon-supplied `audioKeyAvailable` closure (a lookup
 * over SecretManager) + the `localEngineAvailable`/`edgeAvailable` seams, and
 * returns the discriminated SttSelection / TtsSelection. The daemon (setup-media.ts)
 * consumes `sel.ok` BEFORE constructing any STT/TTS adapter — so when a Codex/
 * OAuth-only (or any keyless) main has no audio key, `resolveStt()` returns
 * {ok:false} and the empty-bearer createOpenAISttAdapter is NEVER reached (no 401,
 * STEER-01). Uses a mock SecretManager; never the network.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { SecretManager } from "@comis/core";
import { createAudioProviderSelector, AUDIO_ENV_KEY } from "./setup-audio-provider.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

/** A SecretManager exposing only the supplied keys (the audioKeyAvailable seam). */
function mockSecretManager(keys: Record<string, string>): SecretManager {
  return {
    get: (k: string) => keys[k],
    has: (k: string) => keys[k] !== undefined,
    require: (k: string) => {
      const v = keys[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
    keys: () => Object.keys(keys),
  };
}

/** A minimal transcription selection config with an overridable provider. */
function sttConfig(provider: string, fallbackProviders: string[] = []) {
  return { provider, model: undefined, fallbackProviders };
}

/** A minimal TTS selection config with an overridable provider. */
function ttsConfig(provider: string, fallbackProviders: string[] = []) {
  return { provider, voice: undefined, fallbackProviders };
}

describe("createAudioProviderSelector — resolveStt", () => {
  it("steers a Codex-only agent (main openai-codex, no OPENAI_API_KEY, local off) to honest-unavailable, never a keyed openai selection (STEER-01/02)", () => {
    // The headline: today's setup-media path constructs
    // createOpenAISttAdapter({ apiKey: secretManager.get("OPENAI_API_KEY") ?? "" })
    // (empty bearer → 401). The resolver must return {ok:false} so the daemon
    // constructs NO adapter.
    const audioKeyAvailable = vi.fn(
      (provider: string) =>
        (mockSecretManager({}).get(AUDIO_ENV_KEY[provider] ?? "") ?? "") !== "",
    );
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("auto"),
      ttsConfig: ttsConfig("edge"),
      secretManager: mockSecretManager({}), // NO audio key of any kind
      mainProviderId: "openai-codex",
      localEngineAvailable: () => false,
      logger: createMockLogger() as never,
      audioKeyAvailable,
    });

    const sel = selector.resolveStt();
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.errorKind).toBe("no_keyless_engine");
      expect(sel.hint).toMatch(/Codex OAuth login cannot be used for audio/i);
      expect(sel.hint).toMatch(/GROQ_API_KEY|OPENAI_API_KEY/);
    }
    // STEER-01 defensive: the audioKeyAvailable closure is NEVER called with
    // "openai" on the codex path — MAIN_PROVIDER_AUDIO["openai-codex"] is
    // undefined, so the resolver short-circuits before any key lookup.
    expect(audioKeyAvailable).not.toHaveBeenCalledWith("openai");
  });

  it("follows the main provider's audio key when it genuinely exists (CRED-01, source follow-main-key)", () => {
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("auto"),
      ttsConfig: ttsConfig("edge"),
      secretManager: mockSecretManager({ OPENAI_API_KEY: "sk-test" }),
      mainProviderId: "openai",
      localEngineAvailable: () => false,
      logger: createMockLogger() as never,
    });

    const sel = selector.resolveStt();
    expect(sel).toMatchObject({
      ok: true,
      provider: "openai",
      keyless: false,
      source: "follow-main-key",
    });
  });

  it("resolves an explicit keyed provider with a present key as source explicit (success-criterion #4)", () => {
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("openai"),
      ttsConfig: ttsConfig("edge"),
      // The explicit provider wins even over a keyless-capable main (ollama).
      secretManager: mockSecretManager({ OPENAI_API_KEY: "sk-test" }),
      mainProviderId: "ollama",
      localEngineAvailable: () => false,
      logger: createMockLogger() as never,
    });

    const sel = selector.resolveStt();
    expect(sel).toMatchObject({ ok: true, provider: "openai", source: "explicit" });
  });

  it("returns honest-unavailable for an explicit keyed provider whose key is absent (auth_required)", () => {
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("groq"),
      ttsConfig: ttsConfig("edge"),
      secretManager: mockSecretManager({}), // no GROQ_API_KEY
      mainProviderId: "ollama",
      localEngineAvailable: () => false,
      logger: createMockLogger() as never,
    });

    const sel = selector.resolveStt();
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.errorKind).toBe("auth_required");
  });

  it("builds the AUDIO_ENV_KEY-backed predicate with NO codex branch (the default closure reads SecretManager)", () => {
    // When audioKeyAvailable is NOT injected, the selector builds its own closure
    // over secretManager — proving a follow-main openai key reuse works end-to-end
    // through the default predicate (CRED-01), and that it is the SecretManager
    // lookup (not a codex/OAuth gate).
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("auto"),
      ttsConfig: ttsConfig("edge"),
      secretManager: mockSecretManager({ GROQ_API_KEY: "gsk-test" }),
      mainProviderId: "groq",
      localEngineAvailable: () => false,
      logger: createMockLogger() as never,
    });

    const sel = selector.resolveStt();
    expect(sel).toMatchObject({ ok: true, provider: "groq", source: "follow-main-key" });
  });

  it("logs the once-per-resolution follow-main skip at INFO (default-level evidence) and per-fallback skips at DEBUG", () => {
    const logger = createMockLogger();
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("auto", ["openai"]), // a fallback that can't serve (no key)
      ttsConfig: ttsConfig("edge"),
      secretManager: mockSecretManager({}), // no keys anywhere
      mainProviderId: "anthropic", // no reusable audio key
      localEngineAvailable: () => false,
      logger: logger as never,
    });

    selector.resolveStt();
    // The follow-main skip narrative is visible WITHOUT logLevel:debug.
    const infoFollowMain = (logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      ([payload]) =>
        typeof (payload as { reason?: string })?.reason === "string" &&
        (payload as { reason: string }).reason.includes("keyless-local unavailable"),
    );
    expect(infoFollowMain).toBe(true);
    // … but a per-fallback-entry skip stays DEBUG.
    const debugFallback = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.some(
      ([payload]) =>
        typeof (payload as { reason?: string })?.reason === "string" &&
        (payload as { reason: string }).reason.includes('fallback "openai" skipped'),
    );
    expect(debugFallback).toBe(true);
  });
});

describe("createAudioProviderSelector — resolveTts", () => {
  it("resolves a Codex-only (or any) auto TTS to the keyless edge adapter (RES-02)", () => {
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("auto"),
      ttsConfig: ttsConfig("auto"),
      secretManager: mockSecretManager({}), // no key — edge needs none
      mainProviderId: "openai-codex",
      localEngineAvailable: () => false,
      logger: createMockLogger() as never,
    });

    const sel = selector.resolveTts();
    expect(sel).toMatchObject({ ok: true, provider: "edge", keyless: true });
  });

  it("resolves an explicit edge TTS to keyless edge regardless of SecretManager contents", () => {
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("auto"),
      ttsConfig: ttsConfig("edge"),
      secretManager: mockSecretManager({ OPENAI_API_KEY: "sk-test" }),
      mainProviderId: "openai",
      localEngineAvailable: () => false,
      logger: createMockLogger() as never,
    });

    const sel = selector.resolveTts();
    expect(sel).toMatchObject({ ok: true, provider: "edge", keyless: true });
  });

  it("resolves an explicit keyed TTS provider with a present key as explicit (openai)", () => {
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("auto"),
      ttsConfig: ttsConfig("openai"),
      secretManager: mockSecretManager({ OPENAI_API_KEY: "sk-test" }),
      mainProviderId: "ollama",
      localEngineAvailable: () => false,
      logger: createMockLogger() as never,
    });

    const sel = selector.resolveTts();
    expect(sel).toMatchObject({ ok: true, provider: "openai", source: "explicit" });
  });
});
