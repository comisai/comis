// SPDX-License-Identifier: Apache-2.0
/**
 * resolveTranscriptionProvider — the pure, I/O-free, keyless-first priority
 * resolver for STT provider selection (RES-01/04/05, STEER-01/02, CRED-01).
 *
 * Mirrors `resolveImageProvider` (resolve-image-provider.ts) exactly — a single
 * function, explicit numbered priority, a single discriminated return type, no
 * throws — with two STT-specific divergences (design §5a):
 *   1. a KEYLESS-LOCAL rung that runs BEFORE follow-main (the default; OAuth-safe
 *      and Hermes-parity), and
 *   2. a SECOND injected predicate (`localEngineAvailable`) the image resolver
 *      has no analog for.
 *
 * Purity is preserved by INJECTION: the daemon supplies `localEngineAvailable`
 * (FALSE until Phase 194 wires a real engine) and `audioKeyAvailable` (a closure
 * over its SecretManager; FALSE for OAuth-only mains) plus an optional `onSkip`
 * reporter. This resolver never performs I/O, never reads the environment, and
 * never imports a secret store — so it is trivially unit-testable with no daemon
 * and no network.
 *
 * Honest-capability invariant (STEER-01/02): an OAuth-only main (whose
 * MAIN_PROVIDER_AUDIO entry is `undefined`) or an absent audio key yields
 * `{ ok: false, errorKind, hint }` naming the ACTUAL remedy — NEVER a silent
 * empty-bearer call to a keyed provider. `fallbackProviders` is consulted ONLY
 * after the keyless-local + follow-main paths fail, and each skip is reported.
 *
 * @module
 */

import { VOICE_KEYLESS, MAIN_PROVIDER_AUDIO } from "./voice-capability.js";
import type { SttErrorKind } from "./voice-error.js";

/**
 * The structural subset of the transcription selection config this resolver
 * reads. Declared LOCALLY (not imported from the runtime `TranscriptionConfig`
 * in schema-integrations.ts) so this Wave-1 plan stays decoupled from Plan 02,
 * which edits that schema in the same wave. Note: STT uses `fallbackProviders`
 * (the existing schema field name), where the image resolver uses `fallbackChain`.
 */
export type SttSelectionConfig = {
  /** "auto" | "local" | "openai" | "groq" | "deepgram" */
  provider: string;
  /** Tool/config-supplied model that overrides the per-provider default. */
  model?: string;
  /** Plan 02 lands the real field; this resolver reads it defensively. */
  fallbackProviders?: string[];
};

/**
 * Discriminated result: a concrete selection (with its provenance `source` and
 * a `keyless` flag) or an honest-unavailable carrying a domain `errorKind` + a
 * remedy-naming `hint`.
 */
export type SttSelection =
  | {
      ok: true;
      provider: string;
      keyless: boolean;
      model?: string;
      source: "explicit" | "keyless-local" | "follow-main-key" | "fallback";
    }
  | { ok: false; errorKind: SttErrorKind; hint: string };

/** The exact config knob an explicit-no-key hint must name. */
const PROVIDER_KNOB = "integrations.media.transcription.provider";

function keyHint(provider: string): string {
  return (
    `STT provider "${provider}" is configured but its audio key is unavailable. ` +
    `Set the provider's API key, choose a keyless provider (local), or change ` +
    `${PROVIDER_KNOB}.`
  );
}

/**
 * The STEER-02 verbatim honest-unavailable hint (success-criterion #1): names
 * the local engine, the local.baseUrl escape hatch, AND the keyed-provider env
 * vars — and states explicitly that a Codex OAuth login cannot drive audio.
 */
function noKeylessEngineHint(): string {
  return (
    `No keyless STT engine is available and no usable audio key is configured. ` +
    `Install/enable the local whisper engine, point ` +
    `integrations.media.transcription.local.baseUrl at a local whisper server, ` +
    `or set GROQ_API_KEY / OPENAI_API_KEY (a Codex OAuth login cannot be used ` +
    `for audio).`
  );
}

export function resolveTranscriptionProvider(
  cfg: SttSelectionConfig,
  mainProviderId: string,
  localEngineAvailable: () => boolean,
  audioKeyAvailable: (provider: string) => boolean,
  onSkip?: (reason: string) => void,
): SttSelection {
  // 1. Explicit non-"auto" provider wins. Keyless providers (VOICE_KEYLESS)
  //    short-circuit the key gate; keyed providers are validated for a key.
  if (cfg.provider !== "auto") {
    if (VOICE_KEYLESS.has(cfg.provider)) {
      return { ok: true, provider: cfg.provider, keyless: true, model: cfg.model, source: "explicit" };
    }
    if (audioKeyAvailable(cfg.provider)) {
      return { ok: true, provider: cfg.provider, keyless: false, model: cfg.model, source: "explicit" };
    }
    return { ok: false, errorKind: "auth_required", hint: keyHint(cfg.provider) };
  }

  // 2. "auto" → KEYLESS LOCAL FIRST (the default; OAuth-safe, Hermes parity).
  if (localEngineAvailable()) {
    return { ok: true, provider: "local", keyless: true, model: cfg.model, source: "keyless-local" };
  }

  // 3. → follow the main provider's audio key ONLY IF it really exists (CRED-01).
  //    An OAuth-only main (openai-codex) maps to `undefined` here, so it is never
  //    queried for a key — STEER-01.
  const mainAudio = MAIN_PROVIDER_AUDIO[mainProviderId];
  if (mainAudio && audioKeyAvailable(mainAudio)) {
    return { ok: true, provider: mainAudio, keyless: false, model: cfg.model, source: "follow-main-key" };
  }

  // 4. → explicit fallback chain (consulted only now; each skip reported).
  onSkip?.(`keyless-local unavailable; main "${mainProviderId}" has no usable audio key`);
  for (const p of cfg.fallbackProviders ?? []) {
    if (VOICE_KEYLESS.has(p)) {
      return { ok: true, provider: p, keyless: true, model: cfg.model, source: "fallback" };
    }
    if (audioKeyAvailable(p)) {
      return { ok: true, provider: p, keyless: false, model: cfg.model, source: "fallback" };
    }
    onSkip?.(`fallback "${p}" skipped: no key`);
  }

  // 5. honest-unavailable — names the ACTUAL remedy (STEER-02).
  return { ok: false, errorKind: "no_keyless_engine", hint: noKeylessEngineHint() };
}
