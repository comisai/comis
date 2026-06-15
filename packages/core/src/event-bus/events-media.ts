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

/**
 * The `path` a vision turn took — VIS-03's "which path" signal (the locked
 * ladder order). `unavailable` is failure-only (no tier served).
 */
export type VisionPath = "main-vision" | "registry" | "gemini-video" | "unavailable";

/**
 * MediaVisionEvents: vision-analysis lifecycle events (media.vision:*).
 *
 * VIS-04 (Phase 187, v2.23): the daemon vision RPC handler
 * (`image.analyze` / `media.describe_video`) records a vision turn's lifecycle
 * onto the per-session trajectory so `comis explain <sessionKey>` can
 * reconstruct it (provider / mainProvider / model / path / costUsd / outcome) —
 * the SAME observability image generation got in Phase 186 (the `image.*`
 * machinery is the template).
 *
 * APPEND-ONLY (Pitfall 5): this is a NEW event set ALONGSIDE the SemVer-frozen
 * `MediaGenerationEvents` `image:*` shape — never a rename of an `image.*`
 * literal (a rename trips the bridge-entry-count guard + the
 * `IncidentReport.image` reconstruction + the web codegen cascade).
 *
 * DIRECT-emitted by the daemon vision RPC handler via the per-session
 * trajectory recorder (`trajectoryRegistry.getRecorder(sessionKey).recordEvent`,
 * the image-handlers.ts:210 precedent) — the daemon RPC context has NO EventBus
 * bridge subscription. Declared in `EventMap` (and mapped in the three
 * trajectory registries + a translator) for trajectory-type ARCH CLOSURE and so
 * a future bus emitter is already wired.
 *
 * CONTENT-FREE (T-187-12): every payload carries ids / labels / the `path` /
 * `costUsd` / `outcome` / `errorKind` ONLY — NEVER the image bytes, the analysis
 * prompt, the model's answer, or a credential. `costUsd` rides
 * `media.vision:completed` (= `AssistantMessage.usage.cost.total`, optional —
 * absent on the registry/gemini-video tiers which return no cost; Pitfall 4) so
 * the trajectory reconstruction surfaces the vision turn's cost (Route a).
 */
export interface MediaVisionEvents {
  /**
   * A vision analysis was requested (entry, after the main-provider resolve).
   * Carries the EXECUTING provider id (= the resolved main provider here) + the
   * caller's main provider id (labels only — the lockstep signal). NO prompt.
   */
  "media.vision:requested": {
    /** The executing/attempted vision provider id (the main provider at entry). */
    provider: string;
    /** The caller agent's resolved main provider id (lockstep label). */
    mainProvider: string;
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * A vision analysis completed successfully on some tier. Carries the
   * executing provider + the resolved main provider + model + the `path` label +
   * an OPTIONAL `costUsd` — the VIS-04 cost-carry record (Route a) so `comis
   * explain` reconstructs the turn's cost. `costUsd` is present only on the
   * main-vision tier (the bridge returns it); the registry/gemini-video tiers
   * return no cost (Pitfall 4). NO model answer text.
   */
  "media.vision:completed": {
    /** The executing vision provider id (e.g. "anthropic" on main-vision, "gemini" on the registry tier). */
    provider: string;
    /** The caller agent's resolved main provider id (lockstep label). */
    mainProvider: string;
    /** The vision model used (e.g. "claude-sonnet-4-5"). Optional — some adapters omit it. */
    model?: string;
    /** The analysis cost in USD (from AssistantMessage.usage.cost.total — VIS-04). Optional (absent on registry/gemini-video). */
    costUsd?: number;
    /** Which ladder tier served the turn (VIS-03's "which path" signal). */
    path: VisionPath;
    /** Closed outcome label (always "ok" on this event — failures emit media.vision:failed). */
    outcome: "ok";
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * A vision analysis failed on a tier (a classified bridge/registry error OR an
   * honest no-tier-available). Carries the typed `errorKind` + the `path`
   * attempted — NEVER the raw provider message (the redacted detail rides the
   * structured LOG).
   */
  "media.vision:failed": {
    /** The classified failure kind (the log ErrorKind / ImageErrorKind label). */
    errorKind: string;
    /** Which tier failed (e.g. "main-vision" on a bridge runtime failure, "unavailable" when no tier served). */
    path: VisionPath;
    /** The executing/attempted vision provider id. Optional. */
    provider?: string;
    /** The caller agent's resolved main provider id (lockstep label). Optional. */
    mainProvider?: string;
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };
}
