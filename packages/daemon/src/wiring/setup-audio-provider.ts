// SPDX-License-Identifier: Apache-2.0
/**
 * Audio-provider SELECTION (RES-01/02/04/05, STEER-01/02, CRED-01) — the daemon
 * selector that threads the Plan-01 pure resolvers
 * (`resolveTranscriptionProvider`/`resolveTtsProvider`) + the injected
 * `audioKeyAvailable` closure (a lookup over `SecretManager`) + the
 * `localEngineAvailable`/`edgeAvailable` seams, and returns the discriminated
 * `SttSelection`/`TtsSelection`.
 *
 * `createAudioProviderSelector(deps)` returns `{ resolveStt(), resolveTts() }`.
 * The caller (`setup-media.ts`) consults `sel.ok` BEFORE constructing any STT/TTS
 * adapter (`createSTTProvider`/`createTTSProvider`): when `sel.ok === false` it
 * constructs NO adapter (the transcriber stays `undefined`), so the empty-bearer
 * `createOpenAISttAdapter({ apiKey: secretManager.get("OPENAI_API_KEY") ?? "" })`
 * → 401 is NEVER reached for a Codex/OAuth-only (or any keyless) main. This is
 * THE headline keyless-first / OAuth-steering fix.
 *
 * Purity by injection (the RES-01 keystone): the resolver stays pure; the daemon
 * supplies `audioKeyAvailable` as a closure over `SecretManager` (NOT process.env —
 * the globals gate; setup-media/main-helpers are not sanctioned process.env roots).
 * There is NO codex branch in the predicate — `MAIN_PROVIDER_AUDIO["openai-codex"]`
 * is `undefined`, so the resolver never queries an audio key for codex.
 *
 * Placement: `@comis/daemon`. Kept in a dedicated file (NOT folded into
 * setup-media.ts) so the skills-only setup-media module gains no `@comis/core`
 * media-resolver import edge — mirroring `setup-image-provider.ts`'s rationale.
 * `localEngineAvailable` is the Phase 194 seam (the daemon passes `() => false`
 * until the local whisper engine lands); `edgeAvailable` is the keyless TTS rung
 * (the daemon passes `() => true` — Edge is the shipped keyless adapter).
 *
 * @module
 */

import {
  resolveTranscriptionProvider,
  resolveTtsProvider,
  type AppContainer,
  type SecretManager,
} from "@comis/core";
import { resolveAgentMainProvider } from "./setup-agents/setup-agents-tooling.js";
import type { ComisLogger } from "@comis/infra";

/**
 * Resolved main-provider audio-key env-var names — the SAME env names the skills
 * factories read (`stt-factory.ts` OPENAI/GROQ/DEEPGRAM, `tts-factory.ts`
 * OPENAI/ELEVENLABS). The `audioKeyAvailable(provider)` closure looks up
 * `secretManager.get(AUDIO_ENV_KEY[provider])`. There is intentionally NO entry
 * for `openai-codex` (its credential is an OAuth bearer that cannot reach
 * `/v1/audio/*`); `MAIN_PROVIDER_AUDIO["openai-codex"]` is `undefined`, so the
 * resolver never calls the predicate with `"openai-codex"`.
 */
export const AUDIO_ENV_KEY: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

/** The structural subset of the transcription config the selector reads. */
export interface AudioSttConfig {
  provider: string;
  model?: string;
  fallbackProviders?: string[];
}

/** The structural subset of the TTS config the selector reads. */
export interface AudioTtsConfig {
  provider: string;
  voice?: string;
  fallbackProviders?: string[];
}

/**
 * Build the keyless-first audio selector. Returns two pure getters that resolve
 * the STT / TTS provider on call (the daemon invokes them ONCE at boot, in
 * setup-media). The selector never constructs an adapter and never throws — it
 * returns the discriminated selection; the caller decides to construct or skip.
 */
export function createAudioProviderSelector(deps: {
  transcriptionConfig: AudioSttConfig;
  ttsConfig: AudioTtsConfig;
  secretManager: SecretManager;
  /** Resolved at boot for the DEFAULT agent (the common case for Phase 193). */
  mainProviderId: string;
  /**
   * The Phase 194 seam: TRUE once the local whisper engine is wired. FALSE in
   * 193, so `auto` STT honest-degrades to unavailable (no engine yet).
   */
  localEngineAvailable?: () => boolean;
  /**
   * The keyless TTS rung. The daemon passes `() => true` (Edge is the shipped
   * keyless adapter); defaults to TRUE so `auto` TTS resolves to edge.
   */
  edgeAvailable?: () => boolean;
  logger: ComisLogger;
  /**
   * The injected key-presence predicate (purity keystone). When omitted the
   * selector builds the default `SecretManager`-backed closure below. There is
   * NO codex branch — codex has no audio env key (Pattern 3 / Pitfall 2).
   */
  audioKeyAvailable?: (provider: string) => boolean;
}): {
  resolveStt: () => ReturnType<typeof resolveTranscriptionProvider>;
  resolveTts: () => ReturnType<typeof resolveTtsProvider>;
} {
  const localEngineAvailable = deps.localEngineAvailable ?? (() => false);
  const edgeAvailable = deps.edgeAvailable ?? (() => true);

  // The key-presence predicate: a closure over SecretManager (NEVER process.env).
  // Mirrors setup-image-provider.ts's credsAvailable, minus the codex branch —
  // MAIN_PROVIDER_AUDIO["openai-codex"] is undefined so the resolver never calls
  // this with "openai-codex" (Pitfall 2: the maps diverge from the image one).
  const audioKeyAvailable =
    deps.audioKeyAvailable ??
    ((provider: string) => {
      const envKey = AUDIO_ENV_KEY[provider];
      if (envKey === undefined) {
        // The resolver only ever calls this for a provider it actually queries
        // (an explicit config provider, or a non-undefined MAIN_PROVIDER_AUDIO
        // value). A missing AUDIO_ENV_KEY entry here is therefore a genuine
        // map-coverage gap — a provider that was added to the config enum /
        // MAIN_PROVIDER_AUDIO but whose env-key mapping was forgotten. We stay
        // FAIL-CLOSED (an unmapped provider can never be reported keyed), but
        // emit a DEBUG breadcrumb (provider id + step only — NEVER a secret) so
        // the next "why is voice unavailable for <provider>" diagnosis is one
        // grep, not a forensic hunt (IN-02; the program's built-but-not-wired
        // history).
        deps.logger.debug({ provider, step: "audio_env_key_missing" }, "no AUDIO_ENV_KEY mapping for provider");
        return false;
      }
      return (deps.secretManager.get(envKey) ?? "") !== "";
    });

  // The once-per-resolution follow-main skip is the load-bearing "why did voice
  // go unavailable" evidence — promote it to INFO so it is visible at the default
  // log level (§2.7). Per-fallback-entry skips stay DEBUG (they only matter when
  // a chain is configured). Mirrors setup-image-provider.ts:162-169.
  const onSttSkip = (reason: string): void => {
    if (reason.startsWith("fallback ")) {
      deps.logger.debug({ reason, step: "stt_fallback_skip" }, "STT fallback entry skipped");
    } else {
      deps.logger.info({ reason, step: "stt_follow_main_skip" }, "STT follow-main resolution skipped");
    }
  };
  const onTtsSkip = (reason: string): void => {
    if (reason.startsWith("fallback ")) {
      deps.logger.debug({ reason, step: "tts_fallback_skip" }, "TTS fallback entry skipped");
    } else {
      deps.logger.info({ reason, step: "tts_follow_main_skip" }, "TTS follow-main resolution skipped");
    }
  };

  return {
    resolveStt: () =>
      resolveTranscriptionProvider(
        deps.transcriptionConfig,
        deps.mainProviderId,
        localEngineAvailable,
        audioKeyAvailable,
        onSttSkip,
      ),
    resolveTts: () =>
      resolveTtsProvider(
        deps.ttsConfig,
        deps.mainProviderId,
        edgeAvailable,
        audioKeyAvailable,
        onTtsSkip,
      ),
  };
}

/**
 * Boot-composition shim (Phase 193): build the keyless-first audio selector from
 * the boot container + the DEFAULT agent id, resolving `mainProviderId` via the
 * SAME `resolveAgentMainProvider` accessor the image/video/vision paths use (I4
 * lockstep). Extracted here (NOT inlined in daemon.ts) so the composition root
 * stays under its 3000-line cap — the daemon calls this in one line and threads
 * the result into setupMedia. `localEngineAvailable` is `() => false` (the Phase
 * 194 seam); the audio-wiring-guard pins this call into the live daemon.
 */
export function buildAudioResolverDeps(
  container: AppContainer,
  defaultAgentId: string,
  logger: ComisLogger,
): ReturnType<typeof createAudioProviderSelector> {
  const media = container.config.integrations.media;
  return createAudioProviderSelector({
    transcriptionConfig: media.transcription,
    ttsConfig: media.tts,
    secretManager: container.secretManager,
    mainProviderId: resolveAgentMainProvider(
      container.config.agents,
      container.config.models,
      defaultAgentId,
      defaultAgentId,
    ).providerId,
    localEngineAvailable: () => false,
    logger,
  });
}
