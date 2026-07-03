// SPDX-License-Identifier: Apache-2.0
/**
 * VOICE_KEYLESS + MAIN_PROVIDER_AUDIO — the single source of truth for
 * keyless-first voice provider selection. Mirrors the const-map shape of
 * `IMAGE_CAPABILITY` (image-capability.ts:38-48).
 *
 * TWO VOCABULARIES (do not conflate):
 *   - The config selection enum (`integrations.media.transcription.provider` /
 *     `.tts.provider`) is what an OPERATOR configures: "auto" | "local" |
 *     "openai" | "groq" | "deepgram" (STT) and "edge" | "openai" | "elevenlabs"
 *     | "local" (TTS). `auto` is a selection MODE (it triggers the keyless-first
 *     + follow-main lookup); `local`/`edge`/`piper` are KEYLESS providers.
 *   - The keys of MAIN_PROVIDER_AUDIO are RESOLVED main-provider ids only — the
 *     concrete provider the completion path resolves an agent to. A provider
 *     absent from this map has no reusable audio key (the lookup is `undefined`,
 *     which the resolver turns into an honest "no_keyless_engine" rather than a
 *     silent empty-bearer call). So `auto` and `local`/`edge` MUST NOT appear as
 *     keys here.
 *
 * @module
 */

/**
 * Providers that need NO credential. STT keyless rung is "local" (the in-process
 * whisper engine); TTS keyless rung is "edge" plus
 * "piper" (the offline rung). Membership short-circuits the
 * `audioKeyAvailable` gate in the resolvers.
 */
export const VOICE_KEYLESS: ReadonlySet<string> = new Set(["local", "edge", "piper"]);

/**
 * Resolved main-provider id -> the audio provider whose key it ALSO supplies.
 * OAuth-only mains are absent (`undefined`): an `openai-codex` OAuth
 * bearer CANNOT reach `api.openai.com/v1/audio/*`, so it must never be reused
 * for a keyed audio call. This DIVERGES from IMAGE_CAPABILITY (where
 * `openai-codex` IS image-capable, via the Responses image_generation tool) —
 * the divergence is deliberate; copying the image entry would
 * re-introduce the empty-bearer 401.
 */
export const MAIN_PROVIDER_AUDIO: Record<string, string | undefined> = {
  openai: "openai", // sk- key reaches /v1/audio/*
  groq: "groq", // GROQ_API_KEY reaches Groq whisper
  "openai-codex": undefined, // OAuth bearer CANNOT reach /v1/audio/* (DIVERGES from IMAGE_CAPABILITY)
  // anthropic / google / google-vertex / ollama / lm-studio / default → undefined (no reusable audio key).
};
