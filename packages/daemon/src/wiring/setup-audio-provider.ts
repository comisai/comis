// SPDX-License-Identifier: Apache-2.0
/**
 * Audio-provider SELECTION — the daemon
 * selector that threads the pure resolvers
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
 * Purity by injection is the keystone: the resolver stays pure; the daemon
 * supplies `audioKeyAvailable` as a closure over `SecretManager` (NOT process.env —
 * the globals gate; setup-media/main-helpers are not sanctioned process.env roots).
 * There is NO codex branch in the predicate — `MAIN_PROVIDER_AUDIO["openai-codex"]`
 * is `undefined`, so the resolver never queries an audio key for codex.
 *
 * Placement: `@comis/daemon`. Kept in a dedicated file (NOT folded into
 * setup-media.ts) so the skills-only setup-media module gains no `@comis/core`
 * media-resolver import edge — mirroring `setup-image-provider.ts`'s rationale.
 * `localEngineAvailable` is the local-engine seam — `buildAudioResolverDeps` runs
 * the one-shot `detectLocalSttEngine` boot probe and passes the captured boolean
 * (a reachable `transcription.local.baseUrl` OR the importable in-process whisper
 * engine + ffmpeg). `edgeAvailable` is the keyless TTS rung (the daemon passes
 * `() => true` — Edge is the shipped keyless adapter).
 *
 * @module
 */

import {
  resolveTranscriptionProvider,
  resolveTtsProvider,
  validateLocalServerUrl,
  type AppContainer,
  type SecretManager,
} from "@comis/core";
import { detectFfmpeg, detectLocalSttEngine } from "@comis/skills/tools";
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
  /** Resolved at boot for the DEFAULT agent (the common case). */
  mainProviderId: string;
  /**
   * The local-engine seam: TRUE once the local whisper engine is wired. When
   * FALSE, `auto` STT honest-degrades to unavailable (no engine yet).
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
   * NO codex branch — codex has no audio env key.
   */
  audioKeyAvailable?: (provider: string) => boolean;
}): {
  resolveStt: () => ReturnType<typeof resolveTranscriptionProvider>;
  resolveTts: () => ReturnType<typeof resolveTtsProvider>;
  /** The skip reasons collected during the LAST `resolveStt()` /
   *  `resolveTts()` call (the same closed rung-list the logging closures emit).
   *  The boot caller (`setupMedia`) reads these AFTER resolving and threads them
   *  onto the handler's `media.stt.requested`/`media.tts.requested` trajectory
   *  record so `comis explain` shows WHY `auto` picked the rung — beyond the chosen
   *  `source`. Content (a closed rung-list), never free text or a secret. */
  sttSkips: () => string[];
  ttsSkips: () => string[];
} {
  const localEngineAvailable = deps.localEngineAvailable ?? (() => false);
  const edgeAvailable = deps.edgeAvailable ?? (() => true);
  // Accumulate the skip reasons emitted during resolution so the
  // boot caller can thread them onto the handler emit (the producer already rides
  // them on *:requested — this captures them at the daemon resolution site). Reset
  // at the head of each resolve so a re-resolution does not accrue stale reasons.
  let sttSkipReasons: string[] = [];
  let ttsSkipReasons: string[] = [];

  // The key-presence predicate: a closure over SecretManager (NEVER process.env).
  // Mirrors setup-image-provider.ts's credsAvailable, minus the codex branch —
  // MAIN_PROVIDER_AUDIO["openai-codex"] is undefined so the resolver never calls
  // this with "openai-codex" (the audio maps diverge from the image one).
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
        // grep, not a forensic hunt.
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
    sttSkipReasons.push(reason);
    if (reason.startsWith("fallback ")) {
      deps.logger.debug({ reason, step: "stt_fallback_skip" }, "STT fallback entry skipped");
    } else {
      deps.logger.info({ reason, step: "stt_follow_main_skip" }, "STT follow-main resolution skipped");
    }
  };
  const onTtsSkip = (reason: string): void => {
    ttsSkipReasons.push(reason);
    if (reason.startsWith("fallback ")) {
      deps.logger.debug({ reason, step: "tts_fallback_skip" }, "TTS fallback entry skipped");
    } else {
      deps.logger.info({ reason, step: "tts_follow_main_skip" }, "TTS follow-main resolution skipped");
    }
  };

  return {
    resolveStt: () => {
      sttSkipReasons = [];
      return resolveTranscriptionProvider(
        deps.transcriptionConfig,
        deps.mainProviderId,
        localEngineAvailable,
        audioKeyAvailable,
        onSttSkip,
      );
    },
    resolveTts: () => {
      ttsSkipReasons = [];
      return resolveTtsProvider(
        deps.ttsConfig,
        deps.mainProviderId,
        edgeAvailable,
        audioKeyAvailable,
        onTtsSkip,
      );
    },
    sttSkips: () => [...sttSkipReasons],
    ttsSkips: () => [...ttsSkipReasons],
  };
}

/**
 * Boot-composition shim: build the keyless-first audio selector
 * from the boot container + the DEFAULT agent id, resolving `mainProviderId` via
 * the SAME `resolveAgentMainProvider` accessor the image/video/vision paths use
 * (lockstep). Extracted here (NOT inlined in daemon.ts) so the composition root
 * stays under its 3000-line cap — the daemon `await`s this once at boot and threads
 * the result into setupMedia.
 *
 * This runs the one-shot `detectLocalSttEngine` boot probe
 * ONCE (mirroring `detectFfmpeg` — never throws, never downloads a model), logs
 * availability exactly once at INFO (`step: stt_local_probe`), and CAPTURES the
 * boolean as the synchronous `localEngineAvailable: () => probe.available` predicate
 * the pure resolver consumes (Pitfall 4 — NO per-resolution I/O). The probe is true
 * when a configured `transcription.local.baseUrl` server is reachable OR the
 * in-process whisper engine is importable AND ffmpeg is present; otherwise the
 * `auto`/`local` STT rung honest-degrades to unavailable.
 * A local server that comes up AFTER boot needs a daemon restart to be picked up
 * (the boolean is captured once — acceptable). The
 * audio-wiring-guard pins the real probe + the absence of the hardcoded `() => false`.
 *
 * `detectEngine` is an injected test seam (defaults to the real
 * `detectLocalSttEngine`) so unit tests stub the probe without touching the
 * engine import or the network.
 */
export async function buildAudioResolverDeps(
  container: AppContainer,
  defaultAgentId: string,
  logger: ComisLogger,
  detectEngine: typeof detectLocalSttEngine = detectLocalSttEngine,
): Promise<ReturnType<typeof createAudioProviderSelector>> {
  const media = container.config.integrations.media;
  // SEC-02 (Surface A boot capture): validate the configured local.baseUrl with
  // the inverse SSRF guard (ALLOW loopback + explicit allowlist, DENY public/
  // private egress, keep the cloud-metadata deny) BEFORE threading it into the
  // probe. A rejected URL is dropped (the probe receives `undefined` so it does
  // NOT treat a bad/unconfigured URL as a reachable server); the rejection is
  // logged host/step-only — NEVER the URL (it may carry creds). This
  // is the same guard the probe runs at the fetch site — applying it here too
  // keeps a bad URL from even reaching the probe.
  const configuredBaseUrl = media.transcription.local?.baseUrl;
  let guardedBaseUrl: string | undefined;
  if (configuredBaseUrl !== undefined) {
    const guard = await validateLocalServerUrl(configuredBaseUrl);
    if (guard.ok) {
      guardedBaseUrl = configuredBaseUrl;
    } else {
      // Host/step-only breadcrumb — the rejected URL is NEVER logged.
      logger.warn(
        { step: "stt_local_baseurl_rejected" },
        "configured transcription.local.baseUrl rejected by the SSRF guard (not a loopback or explicitly-allowed local host) — ignoring it",
      );
    }
  }
  // One-shot boot probe (never throws). ffmpeg is the in-process decode gate; a
  // reachable local.baseUrl short-circuits it inside detectLocalSttEngine.
  const ffmpegCaps = await detectFfmpeg();
  const probe = await detectEngine({
    baseUrl: guardedBaseUrl,
    ffmpegAvailable: ffmpegCaps.ffmpegAvailable,
  });
  // Availability is the load-bearing "why is keyless STT (un)available"
  // evidence — log it ONCE at INFO at the default level. `mode` is the mechanism
  // (baseUrl/in-process/none), NEVER the URL or a secret.
  logger.info(
    { available: probe.available, mode: probe.mode, step: "stt_local_probe" },
    "local STT engine availability",
  );
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
    localEngineAvailable: () => probe.available,
    logger,
  });
}
