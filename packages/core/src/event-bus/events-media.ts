// SPDX-License-Identifier: Apache-2.0
/**
 * MediaGenerationEvents: image-generation lifecycle events (image:*).
 *
 * OBS-04 (Phase 186, v2.23): the daemon image RPC handler records an image
 * turn's lifecycle onto the per-session trajectory so `comis explain
 * <sessionKey>` can reconstruct it (provider / model / costUsd / outcome).
 *
 * These events are DIRECT-emitted by the daemon image RPC handler via the
 * per-session trajectory recorder (`trajectoryRegistry.getRecorder(sessionKey)
 * .recordEvent(...)`, the comis-session-manager.ts:298 precedent) — the daemon
 * RPC context has NO EventBus bridge subscription, so a bus emit would not be
 * captured. They are declared HERE in `EventMap` (and mapped in
 * `TRAJECTORY_BRIDGE_MAPPING` + `TRAJECTORY_EVENT_TYPES` + a translator)
 * nonetheless, for trajectory-type ARCH CLOSURE (the arch test enumerates the
 * mapping) and so a future bus emitter is already wired.
 *
 * CONTENT-FREE (T-186-08): every payload carries ids / labels / counts /
 * `costUsd` / booleans ONLY — NEVER the prompt text, the generated image bytes,
 * a credential, or a raw provider error message. `costUsd` rides
 * `image:generated` so the trajectory reconstruction surfaces the image turn's
 * cost (OBS-03 Route a — the binding bar). The redaction-safe detail (if any)
 * rides the structured Pino LOG, never the bus/trajectory.
 */
export interface MediaGenerationEvents {
  /**
   * An image generation was requested (entry, after the main-provider
   * resolve). Carries the EXECUTING provider id + the resolved main provider
   * id (labels only — the lockstep/divergence signal). NO prompt.
   */
  "image:requested": {
    /** The executing image provider id (the boot-selected port — `deps.provider.id`). */
    provider: string;
    /** The caller agent's resolved main provider id (RES-01 lockstep label). */
    mainProvider: string;
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * An image was generated successfully. Carries the cost + provider + model +
   * size + outcome — the OBS-03 cost-carry record (`costUsd`) so `comis
   * explain` reconstructs the turn's cost from the trajectory. NO image bytes.
   */
  "image:generated": {
    /** The executing image provider id. */
    provider: string;
    /** The image model the provider used (e.g. "gpt-image-1"). Optional — some adapters omit it. */
    model?: string;
    /** The image generation cost in USD (from the widened ImageGenOutput — OBS-03). Optional. */
    costUsd?: number;
    /** The persisted/encoded image size in bytes (a size signal, not the content). Optional. */
    sizeBytes?: number;
    /** Closed outcome label (always "ok" on this event — failures emit image:failed). */
    outcome: "ok";
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * A generated image was delivered to a channel via `sendAttachment`. Carries
   * the channel TYPE (not the channel id) + a delivered boolean. NO image bytes.
   */
  "image:delivered": {
    /** The delivery channel TYPE (e.g. "telegram") — a label, never the channel id. */
    channelType: string;
    /** Whether the channel delivery succeeded. */
    delivered: boolean;
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * An image generation failed (a classified provider error OR a persist
   * failure). Carries the typed `errorKind` + the executing provider — NEVER
   * the raw provider message (the redacted detail rides the structured LOG).
   */
  "image:failed": {
    /** The classified failure kind (the log ErrorKind / ImageErrorKind label). */
    errorKind: string;
    /** The executing image provider id. */
    provider: string;
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };
}
