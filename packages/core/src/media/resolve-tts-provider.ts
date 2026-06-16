// SPDX-License-Identifier: Apache-2.0
/**
 * resolveTtsProvider — the pure, I/O-free, edge-first priority resolver for TTS
 * provider selection (RES-02/05). The TTS twin of resolveTranscriptionProvider,
 * with the same shape (injected predicates, discriminated result, no throws) and
 * one difference: the keyless rung is `edge` (the shipped keyless Edge adapter),
 * not local-whisper.
 *
 * Priority (design §5): explicit provider wins → `auto` resolves to the
 * always-keyless `edge` rung → (defensive) optional `piper`/main-key →
 * honest-unavailable. Unlike STT, the `auto` keyless rung (`edge`) is always
 * available — Edge needs no engine and no key — so `auto` resolves to `edge`
 * regardless of `edgeAvailable`; the predicate exists for parity with the STT
 * resolver and to leave the follow-main/honest-unavailable fallthrough reachable
 * if a future config disables edge.
 *
 * Purity by INJECTION: the daemon supplies `edgeAvailable` (the keyless-rung
 * predicate) and `audioKeyAvailable` (a closure over its SecretManager) + an
 * optional `onSkip`. The resolver performs no I/O, reads no env, imports no
 * secret store — trivially unit-testable. Reuses VOICE_KEYLESS /
 * MAIN_PROVIDER_AUDIO and the SttErrorKind union (design §17 / Assumption A3 —
 * the same error vocabulary serves both STT and TTS).
 *
 * @module
 */

import { VOICE_KEYLESS, MAIN_PROVIDER_AUDIO } from "./voice-capability.js";
import type { SttErrorKind } from "./voice-error.js";

/**
 * The structural subset of the TTS selection config this resolver reads.
 * Declared LOCALLY (decoupled from Plan 02's `TtsConfig` schema, edited in the
 * same wave). Reads only the fields it needs; `voice`/`fallbackProviders` are
 * read defensively for parity with the STT resolver.
 */
export type TtsSelectionConfig = {
  /** "auto" | "edge" | "openai" | "elevenlabs" | "local" | "piper" */
  provider: string;
  /** Tool/config-supplied voice; carried through opaquely (not selection-relevant). */
  voice?: string;
  /** Plan 02 lands the real field; this resolver reads it defensively. */
  fallbackProviders?: string[];
};

/**
 * Discriminated result (the same shape as `SttSelection`): a concrete selection
 * with its provenance `source` + a `keyless` flag, or an honest-unavailable.
 */
export type TtsSelection =
  | {
      ok: true;
      provider: string;
      keyless: boolean;
      source: "explicit" | "keyless-local" | "follow-main-key" | "fallback";
    }
  | { ok: false; errorKind: SttErrorKind; hint: string };

/** The exact config knob an explicit-no-key hint must name. */
const PROVIDER_KNOB = "integrations.media.tts.provider";

function keyHint(provider: string): string {
  return (
    `TTS provider "${provider}" is configured but its audio key is unavailable. ` +
    `Set the provider's API key, choose a keyless provider (edge), or change ` +
    `${PROVIDER_KNOB}.`
  );
}

/** The edge-first auto default; edge is always keyless (no engine, no key). */
const TTS_KEYLESS_DEFAULT = "edge";

function noKeylessEngineHint(): string {
  return (
    `No keyless TTS provider is available and no usable audio key is configured. ` +
    `Enable the keyless Edge provider (${PROVIDER_KNOB}: "edge"), or set the ` +
    `key for a cloud TTS provider (a Codex OAuth login cannot be used for audio).`
  );
}

export function resolveTtsProvider(
  cfg: TtsSelectionConfig,
  mainProviderId: string,
  edgeAvailable: () => boolean,
  audioKeyAvailable: (provider: string) => boolean,
  onSkip?: (reason: string) => void,
): TtsSelection {
  // 1. Explicit non-"auto" provider wins. Keyless providers (VOICE_KEYLESS:
  //    edge/piper/local) short-circuit the key gate; keyed providers need a key.
  if (cfg.provider !== "auto") {
    if (VOICE_KEYLESS.has(cfg.provider)) {
      return { ok: true, provider: cfg.provider, keyless: true, source: "explicit" };
    }
    if (audioKeyAvailable(cfg.provider)) {
      return { ok: true, provider: cfg.provider, keyless: false, source: "explicit" };
    }
    return { ok: false, errorKind: "auth_required", hint: keyHint(cfg.provider) };
  }

  // 2. "auto" → the always-keyless EDGE rung (RES-02). Edge needs no key and no
  //    engine, so it wins the auto default regardless of follow-main.
  if (edgeAvailable() || VOICE_KEYLESS.has(TTS_KEYLESS_DEFAULT)) {
    return { ok: true, provider: TTS_KEYLESS_DEFAULT, keyless: true, source: "keyless-local" };
  }

  // 3. → (defensive fallthrough, unreachable while edge is keyless) follow the
  //    main provider's audio key only if it really exists (CRED-01).
  const mainAudio = MAIN_PROVIDER_AUDIO[mainProviderId];
  if (mainAudio && audioKeyAvailable(mainAudio)) {
    return { ok: true, provider: mainAudio, keyless: false, source: "follow-main-key" };
  }

  // 4. → explicit fallback chain (each skip reported).
  onSkip?.(`edge unavailable; main "${mainProviderId}" has no usable audio key`);
  for (const p of cfg.fallbackProviders ?? []) {
    if (VOICE_KEYLESS.has(p)) {
      return { ok: true, provider: p, keyless: true, source: "fallback" };
    }
    if (audioKeyAvailable(p)) {
      return { ok: true, provider: p, keyless: false, source: "fallback" };
    }
    onSkip?.(`fallback "${p}" skipped: no key`);
  }

  // 5. honest-unavailable.
  return { ok: false, errorKind: "no_keyless_engine", hint: noKeylessEngineHint() };
}
