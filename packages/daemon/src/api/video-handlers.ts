// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Video generation RPC handler module.
 *
 * Provides the `video.generate` handler that bridges the agent `video_generate`
 * tool to the boot-selected `VideoGenerationPort`. It validates, rate-limits,
 * gates the PRE-SUBMIT worst-case cost estimate, and resolves an optional
 * SSRF-safe `image_url` reference image.
 *
 * ASYNC SUBMIT (never inline execute): the handler does not run a blocking
 * inline `port.execute()` + persist/deliver/base64 tail (which would hold the
 * agent turn for the full 30 s–5 min render). It `port.submit()`s, persists a
 * `pending` `VideoJobStore` row (the durable spine the background poller resumes
 * against across the turn AND a daemon restart), hands the FULL in-memory record
 * to the poller via `videoPoller.track(record)` (so the poller drives delivery
 * from in-memory routing and an insert-failure is delivered in-memory rather
 * than orphaned), and returns `{jobId, state:"submitted",
 * estimatedCostUsd}` PROMPTLY. The completion tail (poll→fetchResult→persist→
 * deliver→markDone→record(actualCost)) lives in `setup-video-poller.ts`.
 *
 * Trace stitching: the row carries a `traceId` captured HERE from the
 * in-turn ALS context (`tryGetContext()`) — the media-tool RPC producer injects
 * no `_traceId` (image-handlers.ts:470), and the off-turn poller has no ALS frame,
 * so the trace MUST be persisted at submit for the poller to stitch the later
 * completion (the row column → the poller's explicit `{ traceId }` log object).
 *
 * The handler key is the computed-property name `[VideoGenerateContract.method]`
 * so the bidirectional 1:1 contract↔handler parity gate resolves it through
 * `defineContract({ method, ... })` in `packages/core/src/api-contracts/media.ts`.
 *
 * OBSERVABILITY SCOPE: the handler's troubleshootability is structured Pino
 * logger lines per the §2.7 matrix — an INFO submit line on success + an
 * ERROR/WARN carrying `errorKind` + `hint` on EVERY failure branch. Its
 * trajectory footprint is the in-turn `video.requested`/`video.submitted`/
 * `video.failed` records via `createVideoObsEmitter`; the poller emits the
 * off-turn completion records.
 *
 * Provider lockstep: the handler resolves the agent's main provider for the
 * obs line ONLY — the provider INSTANCE was selected ONCE at boot
 * (setup-video-provider.ts). It is NEVER re-derived here (a second selection
 * source of truth could silently diverge from the wired port).
 *
 * @module
 */

import {
  VIDEO_ERR_TO_LOG,
  VideoGenerateContract,
  estimateVideoCostUsd,
  listVideoModelCaps,
  sanitizeLogString,
  snapDuration,
  stripInternalFields,
  supportedModes,
  systemNowMs,
  tryGetContext,
} from "@comis/core";
import { resolveReferenceImage } from "./media-reference-resolver.js";
import { createVideoObsEmitter } from "./video-obs-emit.js";
import type { VideoGenInput } from "@comis/core";
import type { VideoJobRecord } from "@comis/memory";
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
 * `hint`. Narrow duck-type guard (not `instanceof`)
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
      // Resolve the agent's main provider in lockstep with the completion +
      // image paths. This is OBS-only (the obs line + the lockstep proof); the
      // provider INSTANCE was selected at wiring time (setup-video-provider.ts)
      // — do NOT re-derive selection here (a second source of truth can
      // silently diverge from the wired port).
      const main = deps.resolveAgentMainProvider(agentId);
      deps.logger.debug(
        { agentId, mainProvider: main.providerId, step: "video_resolve" },
        "Video request resolved main provider",
      );
      // Construct the trajectory emitter — this fires the
      // `video.requested` entry record onto the per-session trajectory (resolved
      // by the dispatcher-injected `_callerSessionKey`). It is trajectory-only +
      // null-safe: a boot mode without a registry / no session key no-ops (the
      // §2.7 logger floor below still fires). The off-turn poller emits the
      // generated/delivered records; the OFFLINE assembler is the
      // binding reconstruction oracle. `sessionKey` is also persisted on the row
      // below so the off-turn poller can resolve the recorder for the completion.
      const callerSessionKey =
        typeof rawParams._callerSessionKey === "string" ? rawParams._callerSessionKey : undefined;
      const obs = createVideoObsEmitter({
        sessionKey: callerSessionKey,
        trajectoryRegistry: deps.trajectoryRegistry,
        agentId,
        requested: { provider: deps.provider.id, mainProvider: main.providerId },
      });

      // `main.providerId` is the CALLER's provider, resolved
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

      // Resolve the config defaults ONCE, here, so the worst-case
      // estimate and the port input AGREE on the duration/resolution/audio. If
      // the input only carried explicitly-supplied fields, the provider would
      // apply its OWN defaults (which need not match Comis's config defaults) —
      // and the estimate, computed against the config defaults, could UNDER-count
      // the actual render (e.g. config 720p but a provider default of 1080p/4k).
      // The cost-ceiling contract is a worst-case UPPER bound; aligning estimate↔request
      // restores it. `audio` stays undefined when neither param nor config sets
      // it (→ provider default; the estimate uses no audio surcharge to match).
      const resolvedDurationSecs = params.duration ?? deps.config.defaultDurationSecs;
      const resolvedResolution = params.resolution ?? deps.config.defaultResolution;
      const resolvedAspectRatio = params.aspect_ratio ?? deps.config.defaultAspectRatio;
      const resolvedAudio = params.audio ?? deps.config.generateAudio;

      // The PRE-SUBMIT worst-case cost ceiling. Compute
      // the estimate FIRST (a video clip is ALREADY rendering once submitted,
      // so the gate cannot wait for the actual cost), then gate the SUM
      // (accumulated + estimate) BEFORE port.execute. Optional: undefined when
      // `maxCostPerHourUsd` is unset → the ceiling is skipped (count-only, no
      // regression). Exceeding it blocks with quota_exceeded (logger-only WARN +
      // a hint naming the knob), and port.execute is NOT called.
      //
      // Ordering: the cost ceiling is checked BEFORE the count rate limit
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
        // Record video.failed{quota_exceeded} on the
        // trajectory BESIDE the WARN above (the emitter is trajectory-only — the
        // WARN is the single §2.7 line; no double-log).
        obs.failed({ errorKind: "quota_exceeded", provider: deps.provider.id });
        return { success: false, error: "Video generation cost ceiling exceeded", hint };
      }

      // Count rate limit — checked AFTER the cost ceiling
      // but still BEFORE the submit. tryAcquire is an atomic
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
        // Record video.failed{quota_exceeded} beside the WARN
        // (trajectory-only — the WARN is the single §2.7 line).
        obs.failed({ errorKind: "quota_exceeded", provider: deps.provider.id });
        return {
          success: false,
          error: `Rate limit exceeded: max ${deps.config.maxPerHour} videos per hour`,
        };
      }

      // image_url resolution. Resolve ONLY when
      // supplied; absence keeps the request text-only. The resolution reuses the
      // SHARED SSRF + path-traversal resolver (the image guard verbatim —
      // workspace-confined + DNS-pinned + size-capped). The resolved
      // referenceImage is threaded to the port as-is.
      let referenceImage: { data: string; mimeType: string } | undefined;
      if (params.image_url) {
        referenceImage = await resolveReferenceImage(
          params.image_url,
          { workspaceDirs: deps.workspaceDirs, defaultWorkspaceDir: deps.defaultWorkspaceDir },
          rawParams._agentId as string | undefined,
        );
      }
      // (reference_images[] multi-ref resolution is deliberately unsupported —
      // the handler resolves ONLY the singular image_url above; the tool schema
      // declares no array param either, so there is no params.reference_images to read.)

      // Capability validation (honest, BEFORE submit — mirrors image-handlers.ts:249-268):
      // validate the resolved params against the ACTIVE model's VIDEO_MODELS caps
      // and reject an unsupported value with a hint LISTING the valid set + a
      // precondition WARN, rather than letting it surface as an opaque provider 4xx.
      //
      // Multi-agent anti-pattern: validate against the EXECUTING
      // `deps.provider.id` (the boot-selected DEFAULT agent's port), NEVER the
      // caller's `main.providerId` — they can differ (the divergence WARN above);
      // validating against the caller would PASS a value the caller's main allows
      // but the executor then rejects LATE at the provider. The model passed to
      // the accessor is untrusted but prototype-pollution-guarded inside listVideoModelCaps
      // (isBlockedObjectKey precedes the index) — no raw VIDEO_MODELS index here.
      const mode = referenceImage ? "i2v" : "t2v";
      const activeModel = params.model ?? deps.config.model;
      const caps = listVideoModelCaps(deps.provider.id, mode, activeModel);
      if (!caps) {
        // The requested mode is unsupported by this backend (e.g. i2v
        // on a t2v-only model). List the supported modes; for an i2v miss, point
        // the agent at text-to-video (drop image_url).
        const modes = supportedModes(deps.provider.id);
        const hint =
          `Supported modes for ${deps.provider.id}: ${modes.join(", ") || "(none)"}.` +
          (mode === "i2v" ? " Omit image_url for text-to-video." : "");
        deps.logger.warn(
          { agentId, step: "video_mode_reject", errorKind: "precondition" as const, hint },
          "Video generation rejected: mode unsupported for the executing provider",
        );
        return { success: false, error: `${mode} is not supported by provider "${deps.provider.id}"`, hint };
      }
      // The matrix declares `maxReferenceImages` on every cell —
      // ENFORCE it. An i2v request (image present) resolving to a cell that
      // accepts no reference image (e.g. `veo-2.0-generate-001` with
      // `maxReferenceImages: 0`) returns a NON-undefined caps object, so the
      // `if (!caps)` mode-reject above does NOT fire; without this guard the image
      // ships to a model the matrix itself says cannot take one → a guaranteed
      // provider 4xx (the exact class this pre-submit validation exists to close). Reject pre-submit
      // with a hint pointing the agent at text-to-video (drop image_url).
      if (mode === "i2v" && caps.maxReferenceImages < 1) {
        const modelLabel = activeModel ? ` (${activeModel})` : "";
        const hint =
          `${deps.provider.id}${modelLabel} does not accept a reference image for ` +
          `image-to-video. Omit image_url for text-to-video, or select a model that supports it.`;
        deps.logger.warn(
          { agentId, step: "video_reference_image_reject", errorKind: "precondition" as const, hint },
          "Video generation rejected: the resolved model accepts no reference image (i2v unsupported)",
        );
        return {
          success: false,
          error: `image-to-video is not supported by the resolved model for "${deps.provider.id}"`,
          hint,
        };
      }
      if (resolvedResolution && !caps.resolutions.includes(resolvedResolution)) {
        const hint = `${deps.provider.id} supports resolutions: ${caps.resolutions.join(", ")}.`;
        deps.logger.warn(
          { agentId, step: "video_resolution_reject", errorKind: "precondition" as const, hint },
          "Video generation rejected: unsupported resolution",
        );
        return {
          success: false,
          error: `Unsupported resolution "${resolvedResolution}" for "${deps.provider.id}"`,
          hint,
        };
      }
      if (resolvedAspectRatio && caps.aspectRatios.length > 0 && !caps.aspectRatios.includes(resolvedAspectRatio)) {
        const hint = `${deps.provider.id} supports aspect ratios: ${caps.aspectRatios.join(", ")}.`;
        deps.logger.warn(
          { agentId, step: "video_aspect_reject", errorKind: "precondition" as const, hint },
          "Video generation rejected: unsupported aspect ratio",
        );
        return {
          success: false,
          error: `Unsupported aspect ratio "${resolvedAspectRatio}" for "${deps.provider.id}"`,
          hint,
        };
      }
      // Veo cross-field constraint: 1080p/4k REQUIRE duration 8 — honest reject
      // over a provider 4xx the matrix exists to prevent.
      if (
        caps.requires8sFor &&
        resolvedResolution &&
        caps.requires8sFor.includes(resolvedResolution) &&
        resolvedDurationSecs !== 8
      ) {
        // The hint states ONLY the constraint actually enforced here — the
        // resolution→8s rule keyed on `requires8sFor` (1080p/4k). Do not extend
        // it to claim a ref-image→8s rule: the validator enforces none and the
        // native Veo SDK documents none (durationSeconds is a free number for
        // i2v there) — the honest-rejection contract (§2.7) requires the hint
        // to match exactly what is enforced.
        const hint = `${deps.provider.id} requires duration 8 for ${resolvedResolution}; set duration: 8.`;
        deps.logger.warn(
          { agentId, step: "video_duration_constraint_reject", errorKind: "precondition" as const, hint },
          "Video generation rejected: resolution requires 8s",
        );
        return {
          success: false,
          error: `${resolvedResolution} requires duration 8 on "${deps.provider.id}"`,
          hint,
        };
      }
      // SNAP (enum) / CLAMP (range) the resolved duration via the matrix
      // so the wire value is in-enum (an out-of-enum raw duration reaching FAL/Veo
      // would otherwise be a provider error). Round-half-up on enum ties.
      // NOTE: the cost estimate above stays on the PRE-snap resolvedDurationSecs —
      // snapping only lowers-or-equals (never raises) the duration, so the estimate
      // remains a conservative worst-case ceiling; do NOT re-order it after the snap.
      const snappedDurationSecs =
        resolvedDurationSecs !== undefined ? snapDuration(caps, resolvedDurationSecs) : resolvedDurationSecs;

      // Build the port input with the RESOLVED duration/resolution/
      // aspectRatio (param OR config default) — the same values the estimate
      // above used — so the provider renders exactly what was priced and cannot
      // apply a higher-cost default the estimate never saw. `audio` is sent only
      // when explicitly resolved; left undefined it stays a provider default (and
      // the estimate used no audio surcharge, so estimate↔request still agree).
      const input: VideoGenInput = {
        prompt,
        durationSecs: snappedDurationSecs,
        aspectRatio: resolvedAspectRatio,
        resolution: resolvedResolution,
        ...(resolvedAudio !== undefined ? { audio: resolvedAudio } : {}),
        ...(params.negative_prompt !== undefined ? { negativePrompt: params.negative_prompt } : {}),
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        ...(referenceImage ? { referenceImage } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
      };

      // Submit, do NOT execute. `submit()` captures the durable
      // opaque jobId WITHOUT blocking the turn on the full 30 s–5 min render. The
      // completion tail (poll→fetchResult→persist→deliver→record→markDone) is the
      // background poller's job (setup-video-poller.ts) — fully
      // async; there is deliberately no inline fast-path.
      const submitted = await deps.provider.submit(input);

      if (!submitted.ok) {
        // Classified-error WARN path: the typed
        // VideoGenError carries the domain videoErrorKind; an untyped plain Error
        // has none → the untyped fallback is the domain empty_response. The closed
        // 10-member log ErrorKind rides the Pino line via VIDEO_ERR_TO_LOG. NEVER
        // log the raw provider message beyond the typed hint (the hint is
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
            // Defense-in-depth: the hint is a knob-naming carrier the
            // adapter builds to be secret-free, but a provider that wrongly echoes
            // a key/bearer/keyed-URL into it must still not leak into the log —
            // scrub the LOGGED hint (the caller-facing return keeps the contract).
            ...(hint ? { hint: sanitizeLogString(hint) } : {}),
          },
          "Video generation submit failed",
        );
        // Record video.failed{domainKind} beside the WARN
        // (trajectory-only — the WARN is the single §2.7 line; the raw provider
        // message never rides the trajectory payload, only the typed kind).
        obs.failed({ errorKind: domainKind, provider: deps.provider.id });
        return hint
          ? { success: false, error: submitted.error.message, hint }
          : { success: false, error: submitted.error.message };
      }

      const job = submitted.value;

      // Capture the trace HERE, in-turn, from the ALS
      // context, and PERSIST it on the row. The media-tool RPC producer injects no
      // `_traceId` into rawParams (setup-tools.ts:336-343 — only `_agentId` /
      // `_callerChannel*`), and the off-turn poller has NO ALS frame, so the only
      // way the poller can stitch the later completion to this turn is to read the
      // trace from the row. `tryGetContext()` is the sanctioned accessor; it is
      // `undefined` outside a request scope (a unit-test call), so the column is
      // nullable and the field is always threaded.
      const traceId = tryGetContext()?.traceId;

      // Build the durable `pending` record ONCE — it is both the
      // row persisted to the store (the spine the poller resumes against across
      // the turn AND a daemon restart) AND the in-memory record handed to
      // `track()` (the poller drives delivery from this record
      // directly, with no listPending scan). The routing comes from the
      // dispatcher-injected `_callerChannel*` fields; a NON-default agent's job is
      // recorded under its own agentId (the poller delivers only to
      // the recorded channel/agent, never a silent default).
      const nowSubmitMs = systemNowMs();
      const record: VideoJobRecord = {
        jobId: job.jobId,
        provider: deps.provider.id,
        ...(job.model ?? params.model ? { model: job.model ?? params.model } : {}),
        agentId,
        ...(typeof rawParams._callerChannelType === "string" ? { channelType: rawParams._callerChannelType } : {}),
        ...(typeof rawParams._callerChannelId === "string" ? { channelId: rawParams._callerChannelId } : {}),
        // Always thread the traceId KEY (value may be undefined outside an ALS
        // scope) so the off-turn poller's stitching contract is explicit (the
        // store maps `?? null`).
        traceId,
        // Persist the formatted session key (the
        // dispatcher-injected `_callerSessionKey`, captured in-turn at entry) so
        // the OFF-TURN poller resolves the per-session trajectory recorder
        // (getRecorder(record.sessionKey)) to stitch the background completion to
        // this turn. Threaded only when present (the column is nullable — a
        // unit-test call or a no-session context leaves it NULL → offline-only).
        ...(callerSessionKey !== undefined ? { sessionKey: callerSessionKey } : {}),
        state: "pending",
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
        // A freshly-submitted job starts at zero delivery attempts.
        deliverAttempts: 0,
        submittedAtMs: nowSubmitMs,
        updatedAtMs: nowSubmitMs,
      };
      const insertResult = await deps.videoJobStore.insert(record);
      if (!insertResult.ok) {
        // The job IS submitted (rendering) but the row could not be
        // persisted, so it will NOT survive a daemon restart — the boot-resume
        // scan has no row to find. It is NOT orphaned, though: `track(record)`
        // below drives the completion tail (poll→fetch→persist→deliver) IN-MEMORY
        // from this record, so the rendered clip is still delivered to the
        // recorded channel during this daemon's lifetime. Only the
        // restart-durability guarantee is degraded for this one job.
        deps.logger.warn(
          {
            agentId,
            jobId: job.jobId,
            err: insertResult.error,
            errorKind: "internal" as const,
            hint:
              "Video submitted but the job row could not be persisted; it will be " +
              "delivered in-memory by the poller but will NOT resume if the daemon " +
              "restarts before delivery. Check the SQLite db health (~/.comis/memory.db).",
            step: "video_persist_row",
          },
          "Video job row persistence failed (submitted, delivered in-memory, restart-durability degraded)",
        );
      }

      // Hand the FULL record to the background poller, which drives
      // the completion tail off-turn (kicks a `pollUntilDone` per job).
      // Passing the record (not the bare job) means the poller delivers
      // from in-memory routing — no listPending scan, and the insert-failure path
      // above is genuinely delivered rather than silently orphaned.
      deps.videoPoller.track(record);

      // §2.7: the submit completion line. traceId rides the Pino ALS mixin
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
      // Record video.submitted{provider, jobId} on the
      // trajectory AFTER the row persist + track() + the §2.7 INFO line above
      // (trajectory-only — the INFO is the §2.7 line). With the entry
      // video.requested (fired at construction), this is the in-turn record pair
      // the OFFLINE assembler reads to reconstruct a background-completed turn.
      obs.submitted({ provider: deps.provider.id, jobId: job.jobId });

      // The job handle validates against the loose-record
      // VideoGenerateContract.response (`z.record(z.string(), z.unknown())`).
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
