// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory bridge payload translators for the image-generation (`image:*`)
 * lifecycle (OBS-04, Phase 186).
 *
 * Extracted from `translate-payload.ts` (which is at the file-size cap) — the
 * main `translatePayload` switch delegates its four `image:*` cases here.
 * BEHAVIOR-NEUTRAL move (ORCH-OBS file-size split): the returned shapes are
 * byte-identical to the previously-inline arms, pinned by the existing `image:*`
 * arm tests in `translate-payload.test.ts` + the `never` exhaustiveness check
 * below. This is the EXACT precedent that produced `translate-vision-payload.ts`
 * / `translate-video-payload.ts` / `translate-voice-payload.ts` — image was the
 * last media lifecycle still inline.
 *
 * CONTENT-FREE (T-186-08): ids/labels/numbers/booleans ONLY — never the prompt,
 * image bytes, a credential, or a raw provider message. `costUsd` rides
 * `image:generated` so `comis explain` reconstructs the cost (OBS-03 Route a).
 * agentId/sessionKey/timestamp are envelope-only + stripped; optional fields
 * spread presence-conditionally.
 *
 * @module
 */

/** The four `image:*` EventBus event names the bridge maps. */
export type ImageBridgedEventName =
  | "image:requested"
  | "image:generated"
  | "image:delivered"
  | "image:failed";

/**
 * Translate an `image:*` EventBus payload into the content-free `data` of its
 * trajectory event. Mirrors the `media.vision:*` / `video:*` / `media.*` arms.
 * The envelope keys are stripped (they ride the trajectory envelope via the
 * recorder, not `data`).
 */
export function translateImagePayload(
  eventName: ImageBridgedEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventName) {
    case "image:requested":
      return {
        provider: payload.provider,
        mainProvider: payload.mainProvider,
      };

    case "image:generated":
      return {
        provider: payload.provider,
        outcome: payload.outcome,
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.costUsd !== undefined ? { costUsd: payload.costUsd } : {}),
        ...(payload.sizeBytes !== undefined ? { sizeBytes: payload.sizeBytes } : {}),
      };

    case "image:delivered":
      return {
        channelType: payload.channelType,
        delivered: payload.delivered,
      };

    case "image:failed":
      return {
        errorKind: payload.errorKind,
        provider: payload.provider,
      };

    default: {
      // Exhaustiveness — the switch covers every ImageBridgedEventName.
      const _exhaustive: never = eventName;
      void _exhaustive;
      return payload;
    }
  }
}
