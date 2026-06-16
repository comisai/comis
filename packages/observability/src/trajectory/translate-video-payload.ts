// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory bridge payload translators for the `video:*` lifecycle (OBS-04,
 * Phase 192).
 *
 * Extracted from `translate-payload.ts` (which is at the file-size cap) — the
 * main `translatePayload` switch delegates its five `video:*` cases here. No
 * behavior change vs. inlining; this is purely a file-size split (the
 * translate-payload.ts header documents the same split rationale for the bridge
 * table itself).
 *
 * CONTENT-FREE (T-192-01): each arm forwards ONLY content-free ids / labels /
 * numbers / `outcome` / `errorKind` / booleans and STRIPS the envelope
 * (agentId / sessionKey / timestamp) — NEVER the prompt, the video bytes, a
 * credential, or the Veo keyed-download-URL. `costUsd` rides `video:generated`
 * (OBS-03 Route a — the image:generated cost-carry precedent); it + model +
 * sizeBytes + durationSecs spread presence-conditionally (FAL reports no actual
 * cost — Pitfall 4 — so an absent value never appears as an `undefined` key).
 *
 * @module
 */

/** The five `video:*` EventBus event names the bridge maps. */
export type VideoBridgedEventName =
  | "video:requested"
  | "video:submitted"
  | "video:generated"
  | "video:delivered"
  | "video:failed";

/**
 * Translate a `video:*` EventBus payload into the content-free `data` of its
 * trajectory event. Mirrors the `image:*`/`media.vision:*` arms in
 * `translate-payload.ts`. The envelope keys are stripped (they ride the
 * trajectory envelope via the recorder, not `data`).
 */
export function translateVideoPayload(
  eventName: VideoBridgedEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventName) {
    case "video:requested":
      return {
        provider: payload.provider,
        mainProvider: payload.mainProvider,
      };

    case "video:submitted":
      return {
        provider: payload.provider,
        jobId: payload.jobId,
      };

    case "video:generated":
      return {
        provider: payload.provider,
        outcome: payload.outcome,
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.costUsd !== undefined ? { costUsd: payload.costUsd } : {}),
        ...(payload.sizeBytes !== undefined ? { sizeBytes: payload.sizeBytes } : {}),
        ...(payload.durationSecs !== undefined ? { durationSecs: payload.durationSecs } : {}),
      };

    case "video:delivered":
      return {
        channelType: payload.channelType,
        delivered: payload.delivered,
      };

    case "video:failed":
      return {
        errorKind: payload.errorKind,
        provider: payload.provider,
      };

    default: {
      // Exhaustiveness — the switch covers every VideoBridgedEventName.
      const _exhaustive: never = eventName;
      void _exhaustive;
      return payload;
    }
  }
}
