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
import type { AppContainer, SecretManager } from "@comis/core";
import type { detectLocalSttEngine } from "@comis/skills/tools";
import {
  buildAudioResolverDeps,
  createAudioProviderSelector,
  AUDIO_ENV_KEY,
} from "./setup-audio-provider.js";
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

// =============================================================================
// IN-02 (Phase 193 code review): the default audioKeyAvailable closure must
// surface an AUDIO_ENV_KEY map-coverage gap.
//
// When a provider the resolver actually queries has no AUDIO_ENV_KEY entry
// (e.g. a future provider added to the config enum / MAIN_PROVIDER_AUDIO but
// whose env-key mapping was forgotten), the `?? ""` lookup makes
// secretManager.get("") return undefined → the predicate is false
// (honest-unavailable, the SAFE direction). That is correct-by-design, but it
// silently swallows the map gap forever. A once-per-call DEBUG breadcrumb (no
// secret — provider id + step only) shortens the next "why is voice
// unavailable for <provider>" diagnosis, per the program's built-but-not-wired
// history. The fail-closed behavior MUST be preserved.
// =============================================================================

describe("createAudioProviderSelector — default closure surfaces an AUDIO_ENV_KEY map gap (IN-02)", () => {
  it("emits a DEBUG breadcrumb (provider + step only, no secret) when a queried provider has no AUDIO_ENV_KEY mapping, and stays fail-closed", () => {
    const logger = createMockLogger();
    // "mystery" is not in AUDIO_ENV_KEY and not in VOICE_KEYLESS, so the resolver
    // queries the default closure for it (explicit keyed provider path). NO
    // audioKeyAvailable injected → the production closure runs.
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("mystery"),
      ttsConfig: ttsConfig("edge"),
      // A key value is present but bound to a DIFFERENT env var — proving the
      // breadcrumb fires on the missing MAPPING, not on a missing key value, and
      // that the secret value never reaches the log.
      secretManager: mockSecretManager({ OPENAI_API_KEY: "sk-secret-should-never-log" }),
      mainProviderId: "ollama",
      localEngineAvailable: () => false,
      logger: logger as never,
    });

    const sel = selector.resolveStt();

    // Fail-closed preserved: an unmapped provider can never be reported keyed.
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.errorKind).toBe("auth_required");

    // The breadcrumb fired with ONLY provider id + step (no key, no secret value).
    const breadcrumb = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.find(
      ([payload]) => (payload as { step?: string })?.step === "audio_env_key_missing",
    );
    expect(breadcrumb).toBeDefined();
    expect(breadcrumb![0]).toEqual({ provider: "mystery", step: "audio_env_key_missing" });
    // The secret value must NEVER appear in the payload.
    expect(JSON.stringify(breadcrumb![0])).not.toContain("sk-secret-should-never-log");
  });

  it("does NOT emit the breadcrumb for a provider that HAS an AUDIO_ENV_KEY mapping (openai)", () => {
    const logger = createMockLogger();
    const selector = createAudioProviderSelector({
      transcriptionConfig: sttConfig("openai"),
      ttsConfig: ttsConfig("edge"),
      secretManager: mockSecretManager({ OPENAI_API_KEY: "sk-test" }),
      mainProviderId: "ollama",
      localEngineAvailable: () => false,
      logger: logger as never,
    });

    selector.resolveStt();

    const breadcrumb = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.find(
      ([payload]) => (payload as { step?: string })?.step === "audio_env_key_missing",
    );
    expect(breadcrumb).toBeUndefined();
  });
});

// =============================================================================
// Phase 194 (LOCAL-02 / LOCAL-03): buildAudioResolverDeps runs the one-shot
// detectLocalSttEngine boot probe and threads its captured boolean as the
// SYNCHRONOUS localEngineAvailable predicate — replacing the Phase-193
// hardcoded () => false. The probe runs ONCE at boot (mirror detectFfmpeg),
// logs availability exactly once at INFO (step: stt_local_probe), and the
// resolver predicate is a captured boolean (Pitfall 4: no per-resolution I/O,
// no boot-time model download). When available → an auto/local STT with no main
// key resolves to the `local` rung; when unavailable → honest-degrade (the
// Phase-193 fallthrough, no regression). A reachable local.baseUrl makes the
// probe true WITHOUT the in-process engine (mode "baseUrl").
// =============================================================================

/**
 * A minimal AppContainer for buildAudioResolverDeps: only the fields the builder
 * reads (integrations.media.transcription/.tts, secretManager, agents/models for
 * resolveAgentMainProvider). `agents.default.provider` is taken literally by
 * resolveAgentModel when it is not "default", so the main resolves deterministically
 * to openai-codex with no pi-ai catalog dependency.
 */
function probeContainer(opts: {
  sttProvider?: string;
  baseUrl?: string;
  keys?: Record<string, string>;
  mainProvider?: string;
}): AppContainer {
  const transcription = {
    provider: opts.sttProvider ?? "auto",
    maxFileSizeMb: 25,
    timeoutMs: 60_000,
    autoTranscribe: true,
    preflight: true,
    fallbackProviders: [] as string[],
    local: { model: "base", baseUrl: opts.baseUrl },
  };
  const tts = { provider: "edge", fallbackProviders: [] as string[] };
  const keys = opts.keys ?? {};
  return {
    config: {
      integrations: { media: { transcription, tts } },
      agents: { default: { model: "gpt-5-codex", provider: opts.mainProvider ?? "openai-codex" } },
      models: { defaultModel: "", defaultProvider: "" },
    },
    secretManager: mockSecretManager(keys),
  } as unknown as AppContainer;
}

describe("buildAudioResolverDeps — the real localEngineAvailable boot probe (Phase 194)", () => {
  it("runs the in-process probe and resolves an auto/no-key STT to the local rung when the engine is available (LOCAL-02)", async () => {
    const detectEngine = vi.fn(
      async () => ({ available: true, mode: "in-process" }) as const,
    ) as unknown as typeof detectLocalSttEngine;

    const selector = await buildAudioResolverDeps(
      probeContainer({ sttProvider: "auto", mainProvider: "openai-codex", keys: {} }),
      "default",
      createMockLogger() as never,
      detectEngine,
    );

    const sel = selector.resolveStt();
    // Engine available → keyless-local rung wins even though the codex main has
    // no audio key (the Phase-193 fallthrough is now activated).
    expect(sel).toMatchObject({ ok: true, provider: "local", keyless: true, source: "keyless-local" });
    expect(detectEngine).toHaveBeenCalledTimes(1);
  });

  it("honest-degrades an auto/no-key STT to unavailable when the probe says unavailable (no Phase-193 regression)", async () => {
    const detectEngine = vi.fn(
      async () => ({ available: false, mode: "none" }) as const,
    ) as unknown as typeof detectLocalSttEngine;

    const selector = await buildAudioResolverDeps(
      probeContainer({ sttProvider: "auto", mainProvider: "openai-codex", keys: {} }),
      "default",
      createMockLogger() as never,
      detectEngine,
    );

    const sel = selector.resolveStt();
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.errorKind).toBe("no_keyless_engine");
  });

  it("makes localEngineAvailable true via a reachable local.baseUrl WITHOUT the in-process engine (LOCAL-03)", async () => {
    const baseUrl = "http://127.0.0.1:9000/v1";
    const detectEngine = vi.fn(
      async () => ({ available: true, mode: "baseUrl" }) as const,
    ) as unknown as typeof detectLocalSttEngine;

    const selector = await buildAudioResolverDeps(
      probeContainer({ sttProvider: "auto", mainProvider: "openai-codex", baseUrl, keys: {} }),
      "default",
      createMockLogger() as never,
      detectEngine,
    );

    const sel = selector.resolveStt();
    expect(sel).toMatchObject({ ok: true, provider: "local", keyless: true });
    // The probe was consulted with the configured baseUrl (LOCAL-03 seam).
    expect((detectEngine as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      baseUrl,
    });
  });

  it("logs availability exactly once at INFO with step stt_local_probe and the boolean (LOCAL-02)", async () => {
    const logger = createMockLogger();
    const detectEngine = vi.fn(
      async () => ({ available: true, mode: "in-process" }) as const,
    ) as unknown as typeof detectLocalSttEngine;

    await buildAudioResolverDeps(
      probeContainer({ sttProvider: "auto", mainProvider: "openai-codex", keys: {} }),
      "default",
      logger as never,
      detectEngine,
    );

    const probeLogs = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([payload]) => (payload as { step?: string })?.step === "stt_local_probe",
    );
    expect(probeLogs).toHaveLength(1);
    expect(probeLogs[0]![0]).toMatchObject({ step: "stt_local_probe", available: true });
  });

  it("captures the probe boolean at boot — resolveStt() twice does NOT re-run detectEngine (Pitfall 4: synchronous predicate)", async () => {
    const detectEngine = vi.fn(
      async () => ({ available: true, mode: "in-process" }) as const,
    ) as unknown as typeof detectLocalSttEngine;

    const selector = await buildAudioResolverDeps(
      probeContainer({ sttProvider: "auto", mainProvider: "openai-codex", keys: {} }),
      "default",
      createMockLogger() as never,
      detectEngine,
    );

    selector.resolveStt();
    selector.resolveStt();
    // The probe ran ONCE at boot; the predicate is a captured boolean, not per-call I/O.
    expect(detectEngine).toHaveBeenCalledTimes(1);
  });
});
