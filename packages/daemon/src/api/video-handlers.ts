// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Video generation RPC handler module (Phase 188 / Plan 04).
 *
 * Provides the `video.generate` handler that bridges the agent `video_generate`
 * tool to the boot-selected `VideoGenerationPort`. It validates, rate-limits,
 * gates the PRE-SUBMIT worst-case cost estimate (SEC-02 / DIVERGENCE 3), resolves
 * an optional SSRF-safe `image_url` (SEC-03 — text-to-video baseline; the i2v
 * variant-select is Phase 191), runs the inline `port.execute(input, {timeoutMs,
 * pollIntervalMs})` (submit → poll → download), persists the mp4 to the agent's
 * confined `videos/` workspace (DEL-01), delivers via `adapter.sendAttachment`
 * (DEL-02, capability-gated — IRC degrades), and falls back to a SIZE-CAPPED
 * base64 response (DEL-04).
 *
 * The handler key is the computed-property name `[VideoGenerateContract.method]`
 * so the bidirectional 1:1 contract↔handler parity gate resolves it through
 * `defineContract({ method, ... })` in `packages/core/src/api-contracts/media.ts`
 * (this closes the cross-wave seam Plan 02 left transiently open).
 *
 * OBSERVABILITY SCOPE (Phase 188 = logger-only): the handler's troubleshootability
 * is structured Pino logger lines per the §2.7 matrix — an INFO completion line
 * on success + an ERROR/WARN carrying `errorKind` + `hint` on EVERY failure
 * branch (the I8 baseline). It emits NO `video.*` trajectory events and adds NO
 * synthetic `observability:token_usage` row. The eventBus→trajectory→`comis
 * explain` bridge (`video.requested`/`generated`/`failed`/`delivered`) and the
 * synthetic cost route are OBS-04 / OBS-03 — a Phase 192 requirement, explicitly
 * deferred. (See the `// OBS-04 (Phase 192): emit video.* here.` markers below.)
 *
 * RES-01 lockstep (I4): the handler resolves the agent's main provider for the
 * obs line ONLY — the provider INSTANCE was selected ONCE at boot
 * (setup-video-provider.ts). It is NEVER re-derived here (the v2.20
 * keyless-summarizer two-source firewall).
 *
 * @module
 */

import {
  VIDEO_ERR_TO_LOG,
  VideoGenerateContract,
  estimateVideoCostUsd,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import { resolveReferenceImage } from "./media-reference-resolver.js";
import type { AttachmentPayload, VideoGenInput } from "@comis/core";
import type { MediaApiDeps, RpcHandler } from "./types.js";

/** Dependencies required by the video generation RPC handler.
 *
 * Re-aliased from the nested `videoHandlerDeps` sub-shape of the MediaApiDeps
 * cluster slice in api/types.ts (single source of truth; NonNullable — the
 * dispatcher constructs this handler only inside the `deps.videoHandlerDeps ?
 * ...` truthy branch). */
export type VideoHandlerDeps = NonNullable<MediaApiDeps["videoHandlerDeps"]>;

/**
 * DEL-04: the inline-base64 size ceiling. Video base64 is large (a 30 s clip can
 * be tens of MB); inlining it into the JSON-RPC response is wasteful and can blow
 * the transport frame. Above this cap the handler prefers the durable persisted
 * path over a huge base64 blob. 8 MB is a conservative ceiling well below the
 * ~50 MB media-persistence default while still allowing short clips inline.
 */
const VIDEO_BASE64_MAX = 8 * 1024 * 1024;

/**
 * Read an operator-facing `hint` off a provider error if it carries one. The FAL
 * adapter surfaces failures as a typed `VideoGenError` carrying a knob-naming
 * `hint` (the RES-03/FAL-02 carrier). Narrow duck-type guard (not `instanceof`)
 * so the handler does not import the adapter module — mirrors `extractImageHint`.
 */
function extractVideoHint(error: Error): string | undefined {
  const hint = (error as { hint?: unknown }).hint;
  return typeof hint === "string" && hint.length > 0 ? hint : undefined;
}

/** A `.mp4` extension default; the buffer is the durable artifact regardless. */
function extForMime(mimeType: string): string {
  if (mimeType === "video/webm") return ".webm";
  if (mimeType === "video/quicktime") return ".mov";
  return ".mp4";
}

/**
 * Create the video generation RPC handler.
 * @param deps - Video generation service dependencies
 * @returns Record mapping "video.generate" to its handler function
 */
export function createVideoHandlers(
  deps: VideoHandlerDeps,
): Record<string, RpcHandler> {
  return {
    [VideoGenerateContract.method]: async (rawParams) => {
      // §2.7: capture entry time for the success-path durationMs. systemNowMs
      // (not Date.now() — the globals gate forbids it).
      const startMs = systemNowMs();
      const agentId = (rawParams._agentId as string) ?? "default";
      // RES-01 keystone (I4 lockstep): resolve the agent's main provider in
      // lockstep with the completion + image paths. This is OBS-only (the obs
      // line + the lockstep proof); the provider INSTANCE was selected at wiring
      // time (setup-video-provider.ts) — do NOT re-derive selection here (a
      // second source of truth is the v2.20 keyless-summarizer failure class).
      const main = deps.resolveAgentMainProvider(agentId);
      deps.logger.debug(
        { agentId, mainProvider: main.providerId, step: "video_resolve" },
        "Video request resolved main provider",
      );
      // OBS-04 (Phase 192): emit video.requested here.

      // WR-05 precedent: `main.providerId` is the CALLER's provider, resolved
      // per-request for obs/lockstep only; `deps.provider` is the boot-selected
      // port (the DEFAULT agent's selection). A NON-default agent whose main
      // provider DIFFERS runs the default's port — a documented scope boundary
      // (per-agent re-selection is a deferred multi-agent refinement). Make the
      // divergence OBSERVABLE rather than silent.
      if (
        main.providerId !== deps.provider.id &&
        deps.provider.id !== "unavailable" &&
        main.providerId !== "auto" &&
        main.providerId.length > 0
      ) {
        deps.logger.warn(
          {
            agentId,
            callerProvider: main.providerId,
            executedProvider: deps.provider.id,
            step: "video_provider_divergence",
            errorKind: "precondition" as const,
            hint:
              "This non-default agent's video request runs the DEFAULT agent's " +
              "boot-selected provider. Per-agent re-selection is a deferred " +
              "multi-agent refinement; until then set integrations.media." +
              "videoGeneration.provider explicitly, or run the video-capable agent as the default.",
          },
          "Video request provider diverges from the boot-selected port (multi-agent misroute risk)",
        );
      }

      const userParams = stripInternalFields(rawParams);
      const params = VideoGenerateContract.request.parse(userParams);
      const prompt = params.prompt;

      // Validate required parameter.
      if (!prompt) {
        return { success: false, error: "Missing required parameter: prompt" };
      }

      // WR-02: resolve the config defaults ONCE, here, so the worst-case
      // estimate and the port input AGREE on the duration/resolution/audio. If
      // the input only carried explicitly-supplied fields, the provider would
      // apply its OWN defaults (which need not match Comis's config defaults) —
      // and the estimate, computed against the config defaults, could UNDER-count
      // the actual render (e.g. config 720p but a provider default of 1080p/4k).
      // SEC-02's contract is a worst-case UPPER bound; aligning estimate↔request
      // restores it. `audio` stays undefined when neither param nor config sets
      // it (→ provider default; the estimate uses no audio surcharge to match).
      const resolvedDurationSecs = params.duration ?? deps.config.defaultDurationSecs;
      const resolvedResolution = params.resolution ?? deps.config.defaultResolution;
      const resolvedAspectRatio = params.aspect_ratio ?? deps.config.defaultAspectRatio;
      const resolvedAudio = params.audio ?? deps.config.generateAudio;

      // SEC-02 / DIVERGENCE 3 — the PRE-SUBMIT worst-case cost ceiling. Compute
      // the estimate FIRST (a video clip is ALREADY rendering once submitted, I6,
      // so the gate cannot wait for the actual cost), then gate the SUM
      // (accumulated + estimate) BEFORE port.execute. Optional: undefined when
      // `maxCostPerHourUsd` is unset → the ceiling is skipped (count-only, no
      // regression). Exceeding it blocks with quota_exceeded (logger-only WARN +
      // a hint naming the knob), and port.execute is NOT called.
      //
      // WR-03 ordering: the cost ceiling is checked BEFORE the count rate limit
      // (tryAcquire) so a cost-blocked request does NOT burn a count slot for a
      // render that never happened (which would exhaust maxPerHour without ever
      // rendering, and surface the less-actionable count error). The count limit
      // still gates the actual submit below and still bounds the soft cost cap's
      // blast radius — it just no longer charges for cost-rejected requests.
      const estimatedCostUsd = estimateVideoCostUsd(
        deps.provider.id,
        params.model ?? deps.config.model,
        {
          durationSecs: resolvedDurationSecs,
          resolution: resolvedResolution,
          audio: resolvedAudio,
        },
      );
      if (deps.costLimiter && !deps.costLimiter.canSpend(agentId, estimatedCostUsd)) {
        const hint =
          "Video generation cost ceiling reached for this hour; raise " +
          "integrations.media.videoGeneration.maxCostPerHourUsd or wait for the " +
          "hour window to reset.";
        deps.logger.warn(
          {
            agentId,
            step: "video_cost_ceiling",
            errorKind: VIDEO_ERR_TO_LOG.quota_exceeded,
            videoErrorKind: "quota_exceeded" as const,
            estimatedCostUsd,
            hint,
          },
          "Video generation blocked: per-hour cost ceiling reached",
        );
        // OBS-04 (Phase 192): emit video.failed{quota_exceeded} here.
        return { success: false, error: "Video generation cost ceiling exceeded", hint };
      }

      // Count rate limit (SEC-02, RETAINED) — checked AFTER the cost ceiling
      // (WR-03) but still BEFORE the submit. tryAcquire is an atomic
      // check-and-increment (cannot be raced), so it bounds the blast radius for
      // the soft cost ceiling above. A block is a quota-style guard: WARN with
      // the closed-union log errorKind + the domain videoErrorKind + a hint
      // naming maxPerHour (§2.7), logger-only (no trajectory emit).
      if (!deps.rateLimiter.tryAcquire(agentId)) {
        const hint =
          `Video generation rate limit reached (max ${deps.config.maxPerHour} ` +
          "per hour); raise integrations.media.videoGeneration.maxPerHour or wait " +
          "for the hour window to reset.";
        deps.logger.warn(
          {
            agentId,
            step: "video_rate_limit",
            errorKind: VIDEO_ERR_TO_LOG.quota_exceeded,
            videoErrorKind: "quota_exceeded" as const,
            hint,
          },
          "Video generation blocked: per-hour count rate limit reached",
        );
        // OBS-04 (Phase 192): emit video.failed{quota_exceeded} here.
        return {
          success: false,
          error: `Rate limit exceeded: max ${deps.config.maxPerHour} videos per hour`,
        };
      }

      // SEC-03 image_url resolution (text-to-video baseline). Resolve ONLY when
      // supplied; absence keeps the request text-only. The resolution reuses the
      // SHARED SSRF + path-traversal resolver (the image guard verbatim —
      // workspace-confined + DNS-pinned + size-capped). The full i2v
      // variant-select is Phase 191 — here the resolved referenceImage is just
      // threaded to the port.
      let referenceImage: { data: string; mimeType: string } | undefined;
      if (params.image_url) {
        referenceImage = await resolveReferenceImage(
          params.image_url,
          { workspaceDirs: deps.workspaceDirs, defaultWorkspaceDir: deps.defaultWorkspaceDir },
          rawParams._agentId as string | undefined,
        );
      }

      // DEL-01: the inline submit → bounded poll-loop → download. The port runs
      // the loop within timeoutMs; a deadline overrun surfaces as job_timeout.
      //
      // WR-02: send the RESOLVED duration/resolution/aspectRatio (param OR config
      // default) — the same values the estimate above used — so the provider
      // renders exactly what was priced and cannot apply a higher-cost default
      // the estimate never saw. `audio` is sent only when explicitly resolved
      // (param or config); left undefined it stays a provider default (and the
      // estimate used no audio surcharge, so estimate↔request still agree).
      const input: VideoGenInput = {
        prompt,
        durationSecs: resolvedDurationSecs,
        aspectRatio: resolvedAspectRatio,
        resolution: resolvedResolution,
        ...(resolvedAudio !== undefined ? { audio: resolvedAudio } : {}),
        ...(params.negative_prompt !== undefined ? { negativePrompt: params.negative_prompt } : {}),
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        ...(referenceImage ? { referenceImage } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
      };
      const result = await deps.provider.execute(input, {
        timeoutMs: deps.config.timeoutMs,
        pollIntervalMs: deps.config.pollIntervalMs,
      });

      if (!result.ok) {
        // The typed VideoGenError carries the domain videoErrorKind; an untyped
        // plain Error has none → the untyped fallback is the domain
        // empty_response. The closed 10-member log ErrorKind rides the Pino line
        // via VIDEO_ERR_TO_LOG. NEVER log the raw provider message beyond the
        // typed hint (SEC-03 — the hint is the knob-naming carrier, never a key).
        const videoErrorKind = (result.error as { videoErrorKind?: unknown }).videoErrorKind;
        const domainKind =
          typeof videoErrorKind === "string" ? (videoErrorKind as keyof typeof VIDEO_ERR_TO_LOG) : "empty_response";
        const hint = extractVideoHint(result.error);
        deps.logger.warn(
          {
            agentId,
            videoProvider: deps.provider.id,
            mainProvider: main.providerId,
            step: "video_execute",
            errorKind: VIDEO_ERR_TO_LOG[domainKind] ?? "dependency",
            videoErrorKind: domainKind,
            ...(hint ? { hint } : {}),
          },
          "Video generation failed",
        );
        // OBS-04 (Phase 192): emit video.failed{domainKind} here.
        return hint
          ? { success: false, error: result.error.message, hint }
          : { success: false, error: result.error.message };
      }

      // SEC-02: reconcile the per-agent/hour bucket to the ACTUAL cost on success
      // (the pre-check above gated the NEXT request against the estimate). Records
      // the provider's reported cost when present, else the worst-case estimate
      // (never under-account). The limiter clamps NaN/negative.
      deps.costLimiter?.record(agentId, result.value.costUsd ?? estimatedCostUsd);

      const mimeType = result.value.mimeType;
      const ext = extForMime(mimeType);

      // DEL-01: persist the mp4 to the agent's confined workspace
      // (`~/.comis/workspace/media/videos/`) via MediaPersistenceService (raised
      // maxBytes, wired in the bundle) BEFORE any delivery decision — the fetch
      // already happened inside execute(), so an expiring provider URL cannot
      // orphan the artifact. `persist` never throws — on failure it returns err
      // and the handler WARNs + falls through to the size-capped base64.
      const persisted = await deps.persist(agentId, result.value.buffer, {
        mediaKind: "video",
        mimeType,
      });

      if (!persisted.ok) {
        deps.logger.warn(
          {
            agentId,
            err: persisted.error,
            errorKind: "resource" as const,
            hint: "Video generated but persistence failed; returning size-capped base64 fallback",
            step: "video_persist",
          },
          "Video persistence failed",
        );
        // OBS-04 (Phase 192): emit video.generated{persisted:false} here.
        // Fall through to the size-capped base64 fallback below.
      } else {
        // DEL-02: direct channel delivery via adapter.sendAttachment, using the
        // PERSISTED durable path. Capability-driven (NEVER a channel-name list):
        // sendAttachment is optional on ChannelPort — when the adapter omits it
        // (today only IRC), skip direct delivery and fall through to the base64
        // fallback (never call an undefined method).
        const channelType = rawParams._callerChannelType as string | undefined;
        const channelId = rawParams._callerChannelId as string | undefined;
        if (channelType && channelId) {
          const adapter = deps.getChannelAdapter(channelType);
          if (adapter && typeof adapter.sendAttachment === "function") {
            const sendAttachment = adapter.sendAttachment.bind(adapter);
            const attachment: AttachmentPayload = {
              type: "video",
              url: persisted.value.filePath,
              mimeType,
              fileName: `generated-video${ext}`,
              ...(result.value.durationSecs !== undefined ? { durationSecs: result.value.durationSecs } : {}),
            };
            const sendResult = await sendAttachment(channelId, attachment);
            if (!sendResult.ok) {
              deps.logger.warn(
                {
                  channelType,
                  channelId,
                  err: sendResult.error,
                  hint: "Video generated but delivery failed; returning size-capped fallback",
                  errorKind: "network" as const,
                },
                "Video channel delivery failed",
              );
              // Fall through to the fallback below.
            } else {
              const deliveredResult = { success: true, delivered: true, mimeType };
              if (systemGetEnv("NODE_ENV") !== "production") {
                VideoGenerateContract.response.parse(deliveredResult);
              }
              // OBS-04 (Phase 192): emit video.delivered + video.generated here.
              // §2.7 I8 baseline: the FULL completion field set on the
              // channel-delivered path. videoProvider = the EXECUTING port; the
              // model/costUsd/durationSecs ride the optional VideoGenOutput; the
              // sizeBytes is the durable PersistedFile size (DEL-01). traceId
              // rides the Pino ALS mixin (NOT a payload field).
              deps.logger.info(
                {
                  agentId,
                  videoProvider: deps.provider.id,
                  mainProvider: main.providerId,
                  model: result.value.model,
                  estimatedCostUsd,
                  costUsd: result.value.costUsd,
                  sizeBytes: persisted.value.sizeBytes,
                  delivered: true,
                  mimeType,
                  durationMs: systemNowMs() - startMs,
                  step: "video_complete",
                },
                "Video generation completed",
              );
              return deliveredResult;
            }
          }
        }
      }

      // DEL-04 fallback: persistence failed, no channel adapter, the adapter
      // cannot attach (IRC), or delivery failed. Video base64 is large, so the
      // fallback is SIZE-CAPPED: above VIDEO_BASE64_MAX prefer the durable
      // persisted path over a huge inline blob; otherwise inline base64 (and
      // surface the durable path too when it exists).
      const persistedPath = persisted.ok ? persisted.value.filePath : undefined;
      const tooLargeForInline = result.value.buffer.byteLength > VIDEO_BASE64_MAX;
      const fallbackResult: Record<string, unknown> =
        tooLargeForInline
          ? {
              success: true,
              ...(persistedPath ? { mediaPath: persistedPath } : {}),
              mimeType,
              note: persistedPath
                ? "Video too large for inline base64; saved to the agent workspace."
                : "Video too large for inline base64 and persistence failed.",
            }
          : {
              success: true,
              videoBase64: result.value.buffer.toString("base64"),
              mimeType,
              ...(persistedPath ? { mediaPath: persistedPath } : {}),
            };

      if (systemGetEnv("NODE_ENV") !== "production") {
        VideoGenerateContract.response.parse(fallbackResult);
      }
      // OBS-04 (Phase 192): emit video.generated{persisted} here.
      deps.logger.info(
        {
          agentId,
          videoProvider: deps.provider.id,
          mainProvider: main.providerId,
          model: result.value.model,
          estimatedCostUsd,
          costUsd: result.value.costUsd,
          sizeBytes: result.value.buffer.byteLength,
          delivered: false,
          mimeType,
          durationMs: systemNowMs() - startMs,
          step: "video_complete",
        },
        "Video generation completed",
      );
      return fallbackResult;
    },
  };
}
