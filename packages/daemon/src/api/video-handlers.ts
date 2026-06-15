// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Video generation RPC handler module (Phase 188 baseline → Phase 189 async switch).
 *
 * Provides the `video.generate` handler that bridges the agent `video_generate`
 * tool to the boot-selected `VideoGenerationPort`. It validates, rate-limits,
 * gates the PRE-SUBMIT worst-case cost estimate (SEC-02 / DIVERGENCE 3), and
 * resolves an optional SSRF-safe `image_url` (SEC-03 — text-to-video baseline;
 * the i2v variant-select is Phase 191).
 *
 * PHASE 189 (JOB-04 / JOB-02 — inline→submit): the handler no longer runs the
 * blocking inline `port.execute()` + persist/deliver/base64 tail (which held the
 * agent turn for the full 30 s–5 min render). It now `port.submit()`s, persists a
 * `pending` `VideoJobStore` row (the durable spine the background poller resumes
 * against across the turn AND a daemon restart), hands the job to the poller via
 * `videoPoller.track(job)`, and returns `{jobId, state:"submitted",
 * estimatedCostUsd}` PROMPTLY. The completion tail (poll→fetchResult→persist→
 * deliver→record(actualCost)→markDone) lives in `setup-video-poller.ts`.
 *
 * WARNING-3 / I8 (Pitfall 5): the row carries a `traceId` captured HERE from the
 * in-turn ALS context (`tryGetContext()`) — the media-tool RPC producer injects
 * no `_traceId` (image-handlers.ts:470), and the off-turn poller has no ALS frame,
 * so the trace MUST be persisted at submit for the poller to stitch the later
 * completion (the row column → the poller's explicit `{ traceId }` log object).
 *
 * The handler key is the computed-property name `[VideoGenerateContract.method]`
 * so the bidirectional 1:1 contract↔handler parity gate resolves it through
 * `defineContract({ method, ... })` in `packages/core/src/api-contracts/media.ts`.
 *
 * OBSERVABILITY SCOPE (logger-only): the handler's troubleshootability is
 * structured Pino logger lines per the §2.7 matrix — an INFO submit line on
 * success + an ERROR/WARN carrying `errorKind` + `hint` on EVERY failure branch
 * (the I8 baseline). It emits NO `video.*` trajectory events; that bridge is
 * OBS-04 / Phase 192 (the poller emits the off-turn completion lines).
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
  systemNowMs,
  tryGetContext,
} from "@comis/core";
import { resolveReferenceImage } from "./media-reference-resolver.js";
import type { VideoGenInput } from "@comis/core";
import type { MediaApiDeps, RpcHandler } from "./types.js";

/** Dependencies required by the video generation RPC handler.
 *
 * Re-aliased from the nested `videoHandlerDeps` sub-shape of the MediaApiDeps
 * cluster slice in api/types.ts (single source of truth; NonNullable — the
 * dispatcher constructs this handler only inside the `deps.videoHandlerDeps ?
 * ...` truthy branch). */
export type VideoHandlerDeps = NonNullable<MediaApiDeps["videoHandlerDeps"]>;

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

      // WR-02: build the port input with the RESOLVED duration/resolution/
      // aspectRatio (param OR config default) — the same values the estimate
      // above used — so the provider renders exactly what was priced and cannot
      // apply a higher-cost default the estimate never saw. `audio` is sent only
      // when explicitly resolved; left undefined it stays a provider default (and
      // the estimate used no audio surcharge, so estimate↔request still agree).
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

      // JOB-04 (189) — submit, do NOT execute. `submit()` captures the durable
      // opaque jobId WITHOUT blocking the turn on the full 30 s–5 min render. The
      // completion tail (poll→fetchResult→persist→deliver→record→markDone) is the
      // background poller's job (setup-video-poller.ts) — see Q3/O2 LOCKED (fully
      // async; no inline fast-path).
      const submitted = await deps.provider.submit(input);

      if (!submitted.ok) {
        // SAME classified-error WARN path as the 188 !result.ok branch: the typed
        // VideoGenError carries the domain videoErrorKind; an untyped plain Error
        // has none → the untyped fallback is the domain empty_response. The closed
        // 10-member log ErrorKind rides the Pino line via VIDEO_ERR_TO_LOG. NEVER
        // log the raw provider message beyond the typed hint (SEC-03 — the hint is
        // the knob-naming carrier, never a key).
        const videoErrorKind = (submitted.error as { videoErrorKind?: unknown }).videoErrorKind;
        const domainKind =
          typeof videoErrorKind === "string" ? (videoErrorKind as keyof typeof VIDEO_ERR_TO_LOG) : "empty_response";
        const hint = extractVideoHint(submitted.error);
        deps.logger.warn(
          {
            agentId,
            videoProvider: deps.provider.id,
            mainProvider: main.providerId,
            step: "video_submit",
            errorKind: VIDEO_ERR_TO_LOG[domainKind] ?? "dependency",
            videoErrorKind: domainKind,
            ...(hint ? { hint } : {}),
          },
          "Video generation submit failed",
        );
        // OBS-04 (Phase 192): emit video.failed{domainKind} here.
        return hint
          ? { success: false, error: submitted.error.message, hint }
          : { success: false, error: submitted.error.message };
      }

      const job = submitted.value;

      // WARNING-3 / I8 (Pitfall 5): capture the trace HERE, in-turn, from the ALS
      // context, and PERSIST it on the row. The media-tool RPC producer injects no
      // `_traceId` into rawParams (setup-tools.ts:336-343 — only `_agentId` /
      // `_callerChannel*`), and the off-turn poller has NO ALS frame, so the only
      // way the poller can stitch the later completion to this turn is to read the
      // trace from the row. `tryGetContext()` is the sanctioned accessor; it is
      // `undefined` outside a request scope (a unit-test call), so the column is
      // nullable and the field is always threaded.
      const traceId = tryGetContext()?.traceId;

      // JOB-01 (189): persist the `pending` row — the durable spine the poller
      // resumes against across the turn AND a daemon restart. The routing is the
      // SAME source the 188 deliver path read (`_callerChannel*`); a NON-default
      // agent's job is recorded under its own agentId (T-189-06 — the poller
      // delivers only to the recorded channel/agent, never a silent default).
      const insertResult = await deps.videoJobStore.insert({
        jobId: job.jobId,
        provider: deps.provider.id,
        ...(job.model ?? params.model ? { model: job.model ?? params.model } : {}),
        agentId,
        ...(typeof rawParams._callerChannelType === "string" ? { channelType: rawParams._callerChannelType } : {}),
        ...(typeof rawParams._callerChannelId === "string" ? { channelId: rawParams._callerChannelId } : {}),
        // Always thread the traceId KEY (value may be undefined outside an ALS
        // scope) so the off-turn poller's stitching contract is explicit (the
        // store maps `?? null`). WARNING-3 / I8 / Pitfall 5.
        traceId,
        state: "pending",
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
        submittedAtMs: systemNowMs(),
        updatedAtMs: systemNowMs(),
      });
      if (!insertResult.ok) {
        // The job IS submitted (rendering) but we could not persist the row — it
        // will NOT survive a restart and the poller will not resume it. Surface
        // honestly (the render still completes in-process via track below, but the
        // durability guarantee is degraded for this one job).
        deps.logger.warn(
          {
            agentId,
            jobId: job.jobId,
            err: insertResult.error,
            errorKind: "internal" as const,
            hint: "Video submitted but the job row could not be persisted; it will not survive a daemon restart",
            step: "video_persist_row",
          },
          "Video job row persistence failed (submitted, restart-durability degraded)",
        );
      }

      // JOB-02 (189): hand the job to the background poller, which drives the
      // completion tail off-turn (kicks a `pollUntilDone` per job).
      deps.videoPoller.track(job);

      // §2.7 I8: the submit completion line. traceId rides the Pino ALS mixin
      // in-turn (it is also persisted above for the off-turn poller).
      deps.logger.info(
        {
          agentId,
          jobId: job.jobId,
          videoProvider: deps.provider.id,
          mainProvider: main.providerId,
          estimatedCostUsd,
          durationMs: systemNowMs() - startMs,
          step: "video_submitted",
        },
        "Video generation submitted (async)",
      );
      // OBS-04 (Phase 192): emit video.requested here.

      // The job handle. A3: validates against the EXISTING loose-record
      // VideoGenerateContract.response (`z.record(z.string(), z.unknown())`) — no
      // contract change for video.generate (only video.status is new, Plan 03).
      const handle: Record<string, unknown> = {
        success: true,
        jobId: job.jobId,
        state: "submitted",
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
      };
      VideoGenerateContract.response.parse(handle);
      return handle;
    },
  };
}
