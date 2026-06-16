// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory bridge payload translators for the voice (`media.stt:*` /
 * `media.tts:*`) lifecycle (OBS-02/03, Phase 196).
 *
 * Extracted from `translate-payload.ts` (which is at the file-size cap) — the
 * main `translatePayload` switch delegates its six voice cases here. No behavior
 * change vs. inlining; this is purely a file-size split (the exact precedent that
 * produced `translate-video-payload.ts`).
 *
 * CONTENT-FREE (T-196-04): each arm forwards ONLY content-free ids / labels /
 * numbers / booleans / closed-enum reasons (`provider` / `keyless` / `model` /
 * `durationMs` / `audioBytes` / `costUsd` / `outcome` / `errorKind` / `source` /
 * `onSkip`) and STRIPS the envelope (`agentId` / `sessionKey` / `traceId` /
 * `timestamp`) — NEVER the audio bytes, the transcript text, the synthesized
 * audio, or a credential. `costUsd` rides `*:completed` (OBS-05 Route a — the
 * image:generated cost-carry precedent); it + `model` + `durationMs` + `audioBytes`
 * spread presence-conditionally, so an absent value never appears as an
 * `undefined` key AND keyless `costUsd: 0` (passed explicitly by the emitter) IS
 * forwarded (FLAG 4 — "$0" is load-bearing visibility, never stripped). The
 * `onSkip` reasons (a closed rung-list, no free text — the OBS-03 selection
 * observability) ride `*:requested` so `comis explain` can show WHY `auto` picked
 * the rung, beyond the chosen `source`.
 *
 * @module
 */

/** The six voice (`media.stt:*` / `media.tts:*`) EventBus event names the bridge maps. */
export type VoiceBridgedEventName =
  | "media.stt:requested"
  | "media.stt:completed"
  | "media.stt:failed"
  | "media.tts:requested"
  | "media.tts:completed"
  | "media.tts:failed";

/**
 * Translate a voice (`media.stt:*` / `media.tts:*`) EventBus payload into the
 * content-free `data` of its trajectory event. Mirrors the `image:*` /
 * `media.vision:*` / `video:*` arms. The envelope keys are stripped (they ride
 * the trajectory envelope via the recorder, not `data`).
 */
export function translateVoicePayload(
  eventName: VoiceBridgedEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventName) {
    // *:requested → the resolved rung + the OBS-03 onSkip reasons (WHY auto
    // skipped the other rungs). onSkip spreads presence-conditionally (absent on
    // an explicit pin → no undefined key).
    case "media.stt:requested":
    case "media.tts:requested":
      return {
        provider: payload.provider,
        ...(payload.keyless !== undefined ? { keyless: payload.keyless } : {}),
        source: payload.source,
        ...(payload.onSkip !== undefined ? { onSkip: payload.onSkip } : {}),
      };

    // *:completed → outcome:"ok" + the cost-carry (keyless costUsd:0 PRESENT —
    // the emitter passes it explicitly; keyed-no-cost omits the key — FLAG 4).
    case "media.stt:completed":
    case "media.tts:completed":
      return {
        provider: payload.provider,
        keyless: payload.keyless,
        outcome: "ok",
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
        ...(payload.audioBytes !== undefined ? { audioBytes: payload.audioBytes } : {}),
        ...(payload.costUsd !== undefined ? { costUsd: payload.costUsd } : {}),
        source: payload.source,
      };

    // *:failed → outcome:"failed" + the domain SttErrorKind verbatim (the
    // redaction-safe detail + the closed log union ride the structured LOG).
    case "media.stt:failed":
    case "media.tts:failed":
      return {
        provider: payload.provider,
        outcome: "failed",
        errorKind: payload.errorKind,
        source: payload.source,
      };

    default: {
      // Exhaustiveness — the switch covers every VoiceBridgedEventName.
      const _exhaustive: never = eventName;
      void _exhaustive;
      return payload;
    }
  }
}
