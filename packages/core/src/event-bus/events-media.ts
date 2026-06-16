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

/**
 * MediaVideoGenerationEvents: video-generation lifecycle events (video:*).
 *
 * OBS-04 (Phase 192, v2.24): the daemon video RPC handler (`video.generate`,
 * in-turn) AND the off-turn background poller (`setup-video-poller.ts`) record a
 * video turn's lifecycle onto the per-session trajectory so `comis explain
 * <sessionKey>` can reconstruct it — INCLUDING a job that completes in the
 * background AFTER the originating turn ended. The submit ties the later
 * completion via `traceId`/`jobId`; the persisted `session_key` job-row column is
 * how the off-turn poller resolves the recorder.
 *
 * APPEND-ONLY (Pitfall 8): a NEW event set ALONGSIDE the SemVer-frozen
 * `MediaGenerationEvents` `image:*` shape + `MediaVisionEvents` `media.vision:*`
 * shape — never a rename of an `image.*`/`media.vision.*` literal (a rename trips
 * the bridge-entry-count guard + the `IncidentReport` reconstruction + the web
 * codegen cascade).
 *
 * DIRECT-emitted by the daemon video RPC handler / poller via the per-session
 * trajectory recorder (`trajectoryRegistry.getRecorder(sessionKey).recordEvent`,
 * the image-handlers.ts:210 precedent) — the daemon RPC/poller context has NO
 * EventBus bridge subscription. Declared in `EventMap` (and mapped in the three
 * trajectory registries + a translator) for trajectory-type ARCH CLOSURE and so
 * a future bus emitter is already wired.
 *
 * CONTENT-FREE (T-192-01): every payload carries ids / labels / counts /
 * `costUsd` / `outcome` / `errorKind` / booleans ONLY — NEVER the prompt, the
 * video bytes, a credential, the Veo keyed-download-URL, or a raw provider
 * message. `costUsd` rides `video:generated` (OBS-03 Route a — FAL/Veo estimate,
 * Grok actual; optional so an absent value never appears) so the trajectory
 * reconstruction surfaces the video turn's cost. The redaction-safe detail rides
 * the structured Pino LOG, never the bus/trajectory.
 */
export interface MediaVideoGenerationEvents {
  /**
   * A video generation was requested (entry, after the main-provider resolve).
   * Carries the EXECUTING provider id + the resolved main provider id (labels
   * only — the lockstep/divergence signal). NO prompt.
   */
  "video:requested": {
    /** The executing video provider id (the boot-selected port — `deps.provider.id`). */
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
   * A video job was SUBMITTED to the provider (the durable opaque jobId
   * captured). The render itself completes off-turn in the background poller.
   * Carries the executing provider + the jobId label. NO prompt.
   */
  "video:submitted": {
    /** The executing video provider id. */
    provider: string;
    /** The durable opaque provider job/request id (a label, secret-free). */
    jobId: string;
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * A video was generated successfully (the off-turn poller's done branch).
   * Carries the cost + provider + model + size + duration + outcome — the OBS-03
   * cost-carry record (`costUsd`) so `comis explain` reconstructs the turn's cost
   * from the trajectory. NO video bytes, NO keyed-download-URL.
   */
  "video:generated": {
    /** The executing video provider id. */
    provider: string;
    /** The video model the provider used (e.g. "veo-3.1"). Optional. */
    model?: string;
    /** The reconciled generation cost in USD (OBS-03; FAL/Veo estimate, Grok actual). Optional. */
    costUsd?: number;
    /** The persisted video size in bytes (a size signal, not the content). Optional. */
    sizeBytes?: number;
    /** The rendered clip duration in seconds (a label, from the provider result). Optional. */
    durationSecs?: number;
    /** Closed outcome label (always "ok" on this event — failures emit video:failed). */
    outcome: "ok";
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * A generated video was delivered to a channel via `sendAttachment` (the
   * off-turn poller's delivery branch). Carries the channel TYPE (not the channel
   * id) + a delivered boolean (false on the IRC persisted-only degrade). NO bytes.
   */
  "video:delivered": {
    /** The delivery channel TYPE (e.g. "telegram") — a label, never the channel id. */
    channelType: string;
    /** Whether the channel delivery succeeded (false → persisted-only / degraded). */
    delivered: boolean;
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * A video generation failed (a classified provider error, a pre-submit quota
   * block, or an off-turn poll/timeout). Carries the typed `errorKind` + the
   * executing provider — NEVER the raw provider message (the redacted detail
   * rides the structured LOG).
   */
  "video:failed": {
    /** The classified failure kind (the log ErrorKind / VideoErrorKind label). */
    errorKind: string;
    /** The executing video provider id. */
    provider: string;
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    timestamp: number;
  };
}

/**
 * The resolved STT/TTS selection rung — the provenance `source` of the chosen
 * provider (design §17 / OBS-03). Matches `SttSelection.source` in
 * `resolve-transcription-provider.ts` / `resolve-tts-provider.ts`; kept local to
 * the EventMap so a consumer can type-narrow the rung without the resolver
 * barrel. `keyless-local` is the default; `follow-main-key` reuses the main
 * provider's audio key; `fallback` consulted the explicit chain; `explicit` is a
 * non-"auto" pin.
 */
export type VoiceSelectionSource = "explicit" | "keyless-local" | "follow-main-key" | "fallback";

/**
 * MediaSttEvents + MediaTtsEvents: voice (speech-to-text / text-to-speech)
 * lifecycle events (`media.stt:*` / `media.tts:*`).
 *
 * OBS-02/03 (Phase 196, v2.25): the daemon voice RPC handler (`media.transcribe`
 * / `tts.synthesize`) records a voice turn's lifecycle onto the per-session
 * trajectory so `comis explain <sessionKey>` reconstructs it (provider /
 * keyless? / model / durationMs / costUsd / the resolved `source` rung + the
 * `onSkip` reasons / outcome) — the SAME observability image/vision/video got in
 * Phases 186/187/192 (the `video:*` machinery is the cleanest twin: record-only,
 * because the voice handlers/pipeline already carry §2.7 logging).
 *
 * APPEND-ONLY (Pitfall 8): a NEW event set ALONGSIDE the SemVer-frozen
 * `MediaGenerationEvents` `image:*` / `MediaVisionEvents` `media.vision:*` /
 * `MediaVideoGenerationEvents` `video:*` shapes — never a rename of a frozen
 * literal (a rename trips the bridge-entry-count guard + the `IncidentReport`
 * reconstruction + the web codegen cascade).
 *
 * DIRECT-emitted by the daemon voice RPC handler via the per-session trajectory
 * recorder (`trajectoryRegistry.getRecorder(sessionKey).recordEvent`, the
 * image-handlers.ts:210 precedent) — the daemon RPC context has NO EventBus
 * bridge subscription. Declared in `EventMap` (and mapped in the trajectory
 * registries + a translator) for trajectory-type ARCH CLOSURE and so a future
 * bus emitter is already wired.
 *
 * CONTENT-FREE (T-196-04): every payload carries ids / labels / numbers /
 * booleans / closed-enum reasons ONLY — NEVER the audio bytes, the transcript
 * text, the synthesized audio, or a credential. `costUsd` rides `*:completed`
 * (OBS-05 Route a; keyless = `0` EXPLICIT so "free" is visible — never absent;
 * keyed omits it where the provider returns no per-call cost — Pitfall 4) so the
 * trajectory reconstruction surfaces the voice turn's cost. The `onSkip` reasons
 * (a closed rung-list, no free text) ride `*:requested` (OBS-03 — WHY `auto`
 * picked the rung, beyond the chosen `source`). The domain `SttErrorKind` rides
 * `*:failed.errorKind` verbatim (the redaction-safe detail + the closed log union
 * via `STT_ERR_TO_LOG` ride the structured Pino LOG, never the trajectory).
 * `agentId`/`sessionKey`/`traceId` are envelope-only (`?`-optional, stripped by
 * the translator); `onSkip` is content (kept).
 */
export interface MediaSttEvents {
  /**
   * A transcription was requested (entry, after the keyless-first resolve).
   * Carries the resolved provider + keyless flag + the selection `source` rung +
   * the `onSkip` reasons (the rungs `auto` skipped + why — OBS-03). NO audio.
   */
  "media.stt:requested": {
    /** The resolved/executing STT provider id (e.g. "local", "openai"). */
    provider: string;
    /** Whether the resolved provider is keyless (no audio key needed). */
    keyless: boolean;
    /** The resolved selection rung (OBS-03 — which rung `auto` chose). */
    source: VoiceSelectionSource;
    /** The resolver's onSkip reasons (the rungs auto SKIPPED + why — OBS-03; a
     *  closed rung-list, NOT a credential). Optional — absent on an explicit pin. */
    onSkip?: string[];
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    /** Trace correlation id (envelope correlation — stripped from trajectory data). */
    traceId?: string;
    timestamp: number;
  };

  /**
   * A transcription completed successfully. Carries provider + keyless + model +
   * durationMs + audioBytes + an OPTIONAL `costUsd` (OBS-05 Route a — keyless = 0
   * EXPLICIT, keyed omits where no per-call cost) + the selection `source`. NO
   * transcript text.
   */
  "media.stt:completed": {
    /** The executing STT provider id. */
    provider: string;
    /** Whether the executing provider was keyless. */
    keyless: boolean;
    /** The STT model used (e.g. "base", "whisper-1"). Optional — some adapters omit it. */
    model?: string;
    /** Wall-clock transcription duration in ms. Optional. */
    durationMs?: number;
    /** The inbound audio size in bytes (a size signal, not the content). Optional. */
    audioBytes?: number;
    /** The transcription cost in USD (OBS-05; keyless = 0 explicit, keyed omitted). Optional. */
    costUsd?: number;
    /** The resolved selection rung. */
    source: VoiceSelectionSource;
    /** Closed outcome label (always "ok" on this event — failures emit media.stt:failed). */
    outcome?: "ok";
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    /** Trace correlation id (envelope correlation — stripped from trajectory data). */
    traceId?: string;
    timestamp: number;
  };

  /**
   * A transcription failed (a classified provider/engine error OR an honest
   * no-keyless-engine terminal). Carries the typed `errorKind` (domain
   * `SttErrorKind`) + the executing provider + the selection `source` — NEVER the
   * raw provider message (the redacted detail + the closed log union ride the
   * structured LOG).
   */
  "media.stt:failed": {
    /** The classified failure kind (the domain SttErrorKind label). */
    errorKind: string;
    /** The executing/attempted STT provider id. */
    provider: string;
    /** The resolved selection rung. */
    source: VoiceSelectionSource;
    /** Closed outcome label (always "failed" on this event). */
    outcome?: "failed";
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    /** Trace correlation id (envelope correlation — stripped from trajectory data). */
    traceId?: string;
    timestamp: number;
  };
}

/**
 * MediaTtsEvents: text-to-speech lifecycle events (`media.tts:*`). The TTS twin
 * of {@link MediaSttEvents} — the same content-free shape, the same OBS-02/03/05
 * obligations (see the `MediaSttEvents` header). APPEND-ONLY alongside the frozen
 * media.stt:* / video:* shapes — never a rename.
 */
export interface MediaTtsEvents {
  /** A synthesis was requested (entry, after the keyless-first resolve). Carries
   *  the resolved provider + keyless flag + the selection `source` rung + the
   *  `onSkip` reasons (OBS-03). NO text. */
  "media.tts:requested": {
    /** The resolved/executing TTS provider id (e.g. "edge", "elevenlabs"). */
    provider: string;
    /** Whether the resolved provider is keyless. */
    keyless: boolean;
    /** The resolved selection rung (OBS-03). */
    source: VoiceSelectionSource;
    /** The resolver's onSkip reasons (the rungs auto SKIPPED + why — OBS-03). Optional. */
    onSkip?: string[];
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    /** Trace correlation id (envelope correlation — stripped from trajectory data). */
    traceId?: string;
    timestamp: number;
  };

  /** A synthesis completed successfully. Carries provider + keyless + model +
   *  durationMs + audioBytes + an OPTIONAL `costUsd` (keyless = 0 explicit) + the
   *  selection `source`. NO synthesized audio. */
  "media.tts:completed": {
    /** The executing TTS provider id. */
    provider: string;
    /** Whether the executing provider was keyless. */
    keyless: boolean;
    /** The TTS model/voice used. Optional — some adapters omit it. */
    model?: string;
    /** Wall-clock synthesis duration in ms. Optional. */
    durationMs?: number;
    /** The produced audio size in bytes (a size signal, not the content). Optional. */
    audioBytes?: number;
    /** The synthesis cost in USD (OBS-05; keyless = 0 explicit, keyed omitted). Optional. */
    costUsd?: number;
    /** The resolved selection rung. */
    source: VoiceSelectionSource;
    /** Closed outcome label (always "ok" on this event — failures emit media.tts:failed). */
    outcome?: "ok";
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    /** Trace correlation id (envelope correlation — stripped from trajectory data). */
    traceId?: string;
    timestamp: number;
  };

  /** A synthesis failed (a classified provider error). Carries the typed
   *  `errorKind` (domain `SttErrorKind`) + the executing provider + the selection
   *  `source` — NEVER the raw provider message. */
  "media.tts:failed": {
    /** The classified failure kind (the domain SttErrorKind label). */
    errorKind: string;
    /** The executing/attempted TTS provider id. */
    provider: string;
    /** The resolved selection rung. */
    source: VoiceSelectionSource;
    /** Closed outcome label (always "failed" on this event). */
    outcome?: "failed";
    /** Multi-tenant agent identifier (envelope correlation — stripped from trajectory data). */
    agentId?: string;
    /** Formatted session key (envelope correlation — stripped from trajectory data). */
    sessionKey?: string;
    /** Trace correlation id (envelope correlation — stripped from trajectory data). */
    traceId?: string;
    timestamp: number;
  };
}
