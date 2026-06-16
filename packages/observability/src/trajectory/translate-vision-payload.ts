// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory bridge payload translators for the vision-analysis
 * (`media.vision:*`) lifecycle (VIS-04, Phase 187).
 *
 * Extracted from `translate-payload.ts` (which is at the file-size cap) — the
 * main `translatePayload` switch delegates its three `media.vision:*` cases here.
 * BEHAVIOR-NEUTRAL move (Phase 196 file-size split): the returned shapes are
 * byte-identical to the previously-inline arms, pinned by the existing
 * `media.vision:*` arm tests in `translate-payload.test.ts` + the `never`
 * exhaustiveness check below. This is the EXACT precedent that produced
 * `translate-video-payload.ts`.
 *
 * CONTENT-FREE (T-187-12): each arm forwards ONLY content-free ids / labels /
 * the `path` / numbers / `outcome` / `errorKind` and STRIPS the envelope
 * (`agentId` / `sessionKey` / `timestamp`) — NEVER the image bytes, the analysis
 * prompt, the model's answer, or a credential. `costUsd` rides
 * `media.vision:completed` (VIS-04 Route a — the image:generated cost-carry
 * precedent); it + `model` spread presence-conditionally (the registry/
 * gemini-video tiers return no cost — Pitfall 4 — so an absent value never
 * appears as an `undefined` key).
 *
 * @module
 */

/** The three `media.vision:*` EventBus event names the bridge maps. */
export type VisionBridgedEventName =
  | "media.vision:requested"
  | "media.vision:completed"
  | "media.vision:failed";

/**
 * Translate a `media.vision:*` EventBus payload into the content-free `data` of
 * its trajectory event. Mirrors the `image:*` / `video:*` arms. The envelope keys
 * are stripped (they ride the trajectory envelope via the recorder, not `data`).
 */
export function translateVisionPayload(
  eventName: VisionBridgedEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventName) {
    case "media.vision:requested":
      return {
        provider: payload.provider,
        mainProvider: payload.mainProvider,
      };

    case "media.vision:completed":
      return {
        provider: payload.provider,
        mainProvider: payload.mainProvider,
        path: payload.path,
        outcome: payload.outcome,
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.costUsd !== undefined ? { costUsd: payload.costUsd } : {}),
      };

    case "media.vision:failed":
      return {
        errorKind: payload.errorKind,
        path: payload.path,
        ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
        ...(payload.mainProvider !== undefined ? { mainProvider: payload.mainProvider } : {}),
      };

    default: {
      // Exhaustiveness — the switch covers every VisionBridgedEventName.
      const _exhaustive: never = eventName;
      void _exhaustive;
      return payload;
    }
  }
}
