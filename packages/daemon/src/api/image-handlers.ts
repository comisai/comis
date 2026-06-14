// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Image generation RPC handler module.
 *
 * Provides the image.generate handler that bridges the agent tool to the
 * image generation provider. Applies rate limiting, safety checking, and
 * delivers generated images directly to the channel via
 * adapter.sendAttachment.
 *
 * Uses the `@comis/core` contract registry. The handler key is a
 * computed-property name (`[ImageGenerateContract.method]:`) so the
 * bidirectional 1:1 architecture test resolves it through
 * `defineContract({ method, ... })` in
 * `packages/core/src/api-contracts/media.ts`. The dispatcher-injected
 * `_X` internal fields are stripped via `stripInternalFields` BEFORE
 * `contract.request.parse(...)`. The `_agentId` / `_callerChannelType` /
 * `_callerChannelId` reads happen on the un-stripped `rawParams` BEFORE
 * the strip step (the internal fields flow into the handler through
 * `rawParams`).
 *
 * The bespoke prompt-presence + rate-limit checks are intentionally
 * retained for user-friendly `{ success: false, error }` responses
 * matching the existing image-handlers.test.ts assertions.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import {
  IMAGE_ERR_TO_LOG,
  ImageGenerateContract,
  isValidImageModel,
  listImageModels,
  safePath,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import { guessMimeFromExtension, detectMimeFromMagicBytes } from "../wiring/daemon-utils.js";
import { fetchImageBytesSsrfSafe } from "./ssrf-image-fetch.js";
import type { AttachmentPayload } from "@comis/core";
import type { TrajectoryEventType } from "@comis/observability";
import type { MediaApiDeps, RpcHandler } from "./types.js";

/** Dependencies required by image generation RPC handlers.
 *
 * Re-aliased from the nested `imageHandlerDeps` sub-shape of the MediaApiDeps
 * cluster slice in api/types.ts. Single source of truth:
 * `MediaApiDeps["imageHandlerDeps"]` (NonNullable — the dispatcher constructs
 * this handler only inside the `deps.imageHandlerDeps ? ...` truthy branch).
 *
 * Note: unlike the other retargets in the same refactor, image-handlers does
 * NOT receive the full MediaApiDeps cluster slice at runtime. The dispatcher
 * passes `deps.imageHandlerDeps` (the nested object) to `createImageHandlers`,
 * which is why the alias points at the sub-shape rather than the slice itself.
 */
export type ImageHandlerDeps = NonNullable<MediaApiDeps["imageHandlerDeps"]>;

/**
 * Read an operator-facing `hint` off a provider error if it carries one.
 *
 * The pi-image-adapter surfaces failures as a typed `ImageGenError` carrying a
 * knob-naming `hint` (the RES-03 honest-unavailable carrier — see
 * `pi-image-adapter.ts`). This is a narrow duck-type guard (not an `instanceof`)
 * so the handler does not import the adapter module — it only forwards a
 * `string` hint when present. A plain `Error` has no `hint`, so the legacy
 * `{ success: false, error }` shape is preserved for those paths.
 */
function extractImageHint(error: Error): string | undefined {
  const hint = (error as { hint?: unknown }).hint;
  return typeof hint === "string" && hint.length > 0 ? hint : undefined;
}

/** Max bytes for a resolved reference-image (DoS cap — T-185-13). Enforced on
 *  ALL three source branches (URL download, data-uri decode, workspace-file
 *  read) so the bound is uniform regardless of how the agent supplies it. */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

/**
 * Strip an attacker-influenced/declared mime down to its bare media type and
 * reject obviously-dangerous types for generation INPUT. SVG is an XSS/script
 * vector (it can carry `<script>`), so it is refused here with an honest hint
 * rather than forwarded to a provider that might render it (WR-03 / IN-03).
 */
function assertSafeReferenceMime(mediaType: string): void {
  const bare = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  if (bare === "image/svg+xml" || bare === "image/svg") {
    throw new Error(
      "SVG reference images are not supported (script/XSS vector); supply a raster image (PNG/JPEG/WebP).",
    );
  }
}

/**
 * Resolve an agent-supplied `reference_image` (IN-01) to `{ data(base64),
 * mimeType }` for edit/img2img. Adapts the SSRF + path-traversal guards from
 * `media-handlers.ts` — the T-185-09/T-185-10 security floor — and applies the
 * SAME `MAX_REFERENCE_BYTES` cap to EVERY branch (this resolver is genuinely
 * new code with a data-uri branch media-handlers lacks; it is NOT a verbatim
 * mirror):
 *   - data-uri (`data:<mime>[;params][;base64],<payload>`) → decode base64 only
 *     when the `;base64` flag is present, else URL-decode per RFC 2397 (WR-03);
 *     size-capped after decode (WR-01);
 *   - `http(s)://` URL → the shared DNS-pinned SSRF fetcher (CR-01:
 *     `fetchImageBytesSsrfSafe` validates → pins DNS to the validated IP →
 *     refuses redirects → bounded download — closing the rebinding TOCTOU gap a
 *     bare `fetch` left open);
 *   - workspace file path → `safePath(agentDir, source)` confinement + readFile,
 *     size-capped after read (WR-02).
 *
 * Throws on any failure (SSRF block, oversized, unsafe mime, fetch error) —
 * caught by the RPC handler's `@allow-throw` boundary (→ JSON-RPC error).
 */
async function resolveReferenceImage(
  source: string,
  deps: { workspaceDirs: Map<string, string>; defaultWorkspaceDir: string },
  callerAgentId: string | undefined,
): Promise<{ data: string; mimeType: string }> {
  // data-uri (data:<mediatype>[;params][;base64],<payload>). The mediatype may
  // carry parameters (e.g. `;charset=utf-8`) BEFORE the optional `;base64` flag
  // — `[^,]*?` (lazy, up to the comma) tolerates them; `(;base64)?` then matches
  // the flag if present (WR-03 fix vs the old `[^;,]+` which missed params).
  const dataUri = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(source);
  if (dataUri) {
    const mediaType = dataUri[1] || "image/png";
    assertSafeReferenceMime(mediaType);
    const mimeType = (mediaType.split(";")[0] || "image/png").trim(); // strip charset/params
    const payload = dataUri[3] ?? "";
    // RFC 2397: base64 ONLY when the `;base64` token is present; otherwise the
    // payload is URL-encoded text (WR-03 — do NOT base64-decode it to garbage).
    const buffer = dataUri[2]
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf-8");
    if (buffer.byteLength > MAX_REFERENCE_BYTES) {
      throw new Error("Reference image exceeds the size limit");
    }
    return { data: buffer.toString("base64"), mimeType };
  }
  // http(s) URL — route through the shared DNS-pinned SSRF fetcher (CR-01): it
  // SSRF-validates BEFORE connecting, pins DNS to the validated IP (no rebind
  // window), refuses redirects, and bounds the download to MAX_REFERENCE_BYTES.
  if (/^https?:\/\//i.test(source)) {
    const fetched = await fetchImageBytesSsrfSafe(source, MAX_REFERENCE_BYTES);
    const mediaType = fetched.mimeType ?? detectMimeFromMagicBytes(fetched.buffer) ?? "image/png";
    assertSafeReferenceMime(mediaType);
    const mimeType = (mediaType.split(";")[0] || "image/png").trim();
    return { data: fetched.buffer.toString("base64"), mimeType };
  }
  // Workspace file path — safePath confines it under the agent workspace dir
  // (T-185-09 path-traversal floor). agentDir resolves from the caller's
  // workspace, falling back to the default workspace dir. Size-capped after
  // read (WR-02) — an agent can write a large file into its own workspace.
  const agentDir = (callerAgentId && deps.workspaceDirs.get(callerAgentId)) ?? deps.defaultWorkspaceDir;
  const filePath = safePath(agentDir, source);
  const buffer = await readFile(filePath);
  if (buffer.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error("Reference image exceeds the size limit");
  }
  return { data: buffer.toString("base64"), mimeType: guessMimeFromExtension(filePath) };
}

/**
 * Create image generation RPC handlers.
 * @param deps - Image generation service dependencies
 * @returns Record mapping "image.generate" to its handler function
 */
export function createImageHandlers(
  deps: ImageHandlerDeps,
): Record<string, RpcHandler> {
  return {
    [ImageGenerateContract.method]: async (rawParams) => {
      // WR-03 (§2.7): capture entry time for the success-path durationMs.
      // systemNowMs (not Date.now() — the globals gate forbids it).
      const startMs = systemNowMs();
      const agentId = (rawParams._agentId as string) ?? "default";
      // RES-01 keystone — the handler is no longer provider-blind. Resolve the
      // agent's main provider in lockstep with the completion path (I4). This
      // is informational here (obs + lockstep proof); the provider INSTANCE was
      // already selected at wiring time (setup-image-provider.ts) — do NOT
      // re-derive selection here (a second source of truth is the v2.20
      // keyless-summarizer failure class).
      const main = deps.resolveAgentMainProvider(agentId);
      deps.logger.debug(
        { agentId, mainProvider: main.providerId, step: "image_resolve" },
        "Image request resolved main provider",
      );

      // OBS-04 (§2.7): direct-emit the image.* lifecycle to the per-session
      // trajectory recorder (the daemon RPC context has NO eventBus bridge — the
      // comis-session-manager.ts:298 precedent). Resolve the recorder by the
      // dispatcher-injected `_callerSessionKey`. `getRecorder?.()` no-ops to a
      // non-crash when the registry is absent (a boot mode without one) or
      // returns null/undefined (env-disabled session) — A1: the recorder is OPEN
      // during the tool call (the executor turn is awaiting this result). `emit`
      // records ONLY when a non-null recorder resolved. Payloads are content-free
      // (ids/labels/costUsd/sizeBytes/outcome/errorKind — never the prompt, the
      // image bytes, a key, or a raw provider message; T-186-08).
      const sessionKey = rawParams._callerSessionKey as string | undefined;
      const recorder =
        sessionKey && deps.trajectoryRegistry
          ? deps.trajectoryRegistry.getRecorder?.(sessionKey)
          : undefined;
      const emit = (type: TrajectoryEventType, data: Record<string, unknown>): void => {
        if (recorder != null) recorder.recordEvent(type, data);
      };
      emit("image.requested", { provider: deps.provider.id, mainProvider: main.providerId });
      // WR-05 (184-REVIEW): `main.providerId` is the CALLER's provider, resolved
      // PER-REQUEST for obs/lockstep only. But `deps.provider` is a SINGLE
      // boot-time-selected port built from the DEFAULT agent's OAuth manager +
      // profiles (main-helpers.ts buildImageGenBundle <- daemon.ts
      // oauthManagers.get(defaultAgentId)). So a NON-default agent whose main
      // provider DIFFERS runs the DEFAULT agent's port/credentials — a known,
      // DOCUMENTED scope boundary (per-agent re-selection + live rotation is the
      // Phase 186 / multi-agent refinement; see main-helpers.ts IN-01 +
      // setup-image-provider.ts). Until 186 closes it, make the divergence
      // OBSERVABLE rather than silent: the per-request obs line names the
      // caller's provider while execution uses the default's port, which would
      // otherwise mislead triage. Agents that share the default's provider
      // (matching ids) are unaffected — the common multi-agent case still works.
      if (
        main.providerId !== deps.provider.id &&
        // "auto"/"unavailable" are selector sentinels, not real provider ids —
        // a mismatch against them is not a credential misroute.
        deps.provider.id !== "unavailable" &&
        main.providerId !== "auto" &&
        main.providerId.length > 0
      ) {
        deps.logger.warn(
          {
            agentId,
            callerProvider: main.providerId,
            executedProvider: deps.provider.id,
            step: "image_provider_divergence",
            errorKind: "precondition" as const,
            hint:
              "This non-default agent's image request runs the DEFAULT agent's " +
              "boot-selected provider/credentials. Per-agent re-selection lands " +
              "in Phase 186; until then set integrations.media.imageGeneration." +
              "provider explicitly, or run the image-capable agent as the default.",
          },
          "Image request provider diverges from the boot-selected port (multi-agent misroute risk)",
        );
      }
      const userParams = stripInternalFields(rawParams);
      const params = ImageGenerateContract.request.parse(userParams);
      const prompt = params.prompt;

      // Validate required parameter
      if (!prompt) {
        return { success: false, error: "Missing required parameter: prompt" };
      }

      // Rate limit check
      if (!deps.rateLimiter.tryAcquire(agentId)) {
        return {
          success: false,
          error: `Rate limit exceeded: max ${deps.config.maxPerHour} images per hour`,
        };
      }

      // SEC-02 cost-ceiling PRE-check — placed AFTER the count limit (which is
      // RETAINED), BEFORE provider.execute (the cost is only known after, so the
      // gate is a pre-check on the ALREADY-accumulated spend + a post-hoc
      // record below). Optional: undefined when `maxCostPerHourUsd` is unset →
      // the ceiling is skipped (count-only, no regression). Exceeding the
      // ceiling blocks with quota_exceeded (OBS-02: a WARN + hint naming the
      // knob; OBS-04: image.failed{quota_exceeded} so the blocked turn is
      // diagnosable via `comis explain`), and provider.execute is NOT called.
      if (deps.costLimiter && !deps.costLimiter.canSpend(agentId)) {
        const hint =
          "Image generation cost ceiling reached for this hour; raise " +
          "integrations.media.imageGeneration.maxCostPerHourUsd or wait for the " +
          "hour window to reset.";
        // The Pino `errorKind` LOG field is the CLOSED 10-member union (the
        // log-payload arch gate enforces it) — the domain `quota_exceeded` maps
        // to `resource` via IMAGE_ERR_TO_LOG (the single vocabularies-meet point,
        // mirroring pi-image-adapter.ts:153). The domain kind rides the separate
        // `imageErrorKind` field. The trajectory image.failed below uses the
        // domain kind directly (it is a content-free event payload, not a log).
        deps.logger.warn(
          {
            agentId,
            step: "image_cost_ceiling",
            errorKind: IMAGE_ERR_TO_LOG.quota_exceeded,
            imageErrorKind: "quota_exceeded" as const,
            hint,
          },
          "Image generation blocked: per-hour cost ceiling reached",
        );
        emit("image.failed", { errorKind: "quota_exceeded", provider: deps.provider.id });
        return { success: false, error: "Image generation cost ceiling exceeded", hint };
      }

      // IN-02 model validation (BEFORE any reference resolution / outbound
      // call — T-185-11): reject an unknown `model` for the EXECUTING provider
      // with a hint LISTING the valid models. Strict validation runs ONLY for
      // providers WITH a non-empty Comis-side list (IMAGE_MODELS_BY_PROVIDER) —
      // a provider with no list (e.g. openrouter, whose catalog is pi-ai's, not
      // Comis's) does NOT reject every model (it would otherwise reject valid
      // openrouter ids). The agent-supplied model then flows to the provider,
      // which decides. pi-ai's getImageModels is openrouter-only (Pitfall 4),
      // so the openai/google native lists are the IN-02 source of truth.
      //
      // WR-05 (185-REVIEW): validate against `deps.provider.id` — the provider
      // that will ACTUALLY execute (the boot-selected DEFAULT agent's port) —
      // NOT the per-request caller's `main.providerId`. In a multi-agent daemon
      // they can differ (the documented Phase-186 divergence the WARN above
      // surfaces); validating against the caller would PASS a model valid for
      // the caller but then fail LATE at the executing SDK (a confusing
      // late error). Validating against the executor makes the early reject's
      // reason match reality. Sentinels ("unavailable") + listless providers
      // (openrouter) have an empty list → no strict reject (Test 8 unchanged).
      if (params.model) {
        const executingProvider = deps.provider.id;
        const known = listImageModels(executingProvider);
        if (known.length > 0 && !isValidImageModel(executingProvider, params.model)) {
          const hint = `Valid models for ${executingProvider}: ${known.join(", ")}`;
          // OBS-02 (§2.7): no classified failure returns without a logged
          // errorKind + hint. The model-reject is a caller-precondition failure;
          // WARN it (with the listing hint) so the rejected turn is diagnosable
          // via `comis explain`. The raw model echo stays out of the payload
          // (only the safe `error`/`hint` strings carry it back to the caller).
          deps.logger.warn(
            { agentId, errorKind: "precondition" as const, step: "image_model_reject", hint },
            "Image generation rejected: unknown model for the executing provider",
          );
          return {
            success: false,
            error: `Unknown model "${params.model}" for provider "${executingProvider}"`,
            hint,
          };
        }
      }

      // IN-01 reference-image resolution (edit/img2img). Resolve ONLY when a
      // `reference_image` is supplied; absence keeps the request text-only (no
      // `referenceImage` field → no openrouter/codex regression). The resolution
      // reuses the media-handlers SSRF + path-traversal guards (T-185-09/10).
      let referenceImage: { data: string; mimeType: string } | undefined;
      if (params.reference_image) {
        referenceImage = await resolveReferenceImage(
          params.reference_image,
          { workspaceDirs: deps.workspaceDirs, defaultWorkspaceDir: deps.defaultWorkspaceDir },
          rawParams._agentId as string | undefined,
        );
      }

      // Pass safetyChecker from config.
      // OpenAI enforces safety server-side; safetyChecker config only affects fal.ai's enable_safety_checker param.
      // IN-01/IN-02: forward the resolved reference image + the validated model
      // when present (absence → omitted, so the text-only path is unchanged).
      const result = await deps.provider.execute({
        prompt,
        size: params.size ?? deps.config.defaultSize,
        safetyChecker: deps.config.safetyChecker,
        ...(referenceImage ? { referenceImage } : {}),
        ...(params.model ? { model: params.model } : {}),
      });

      if (!result.ok) {
        // OBS-04: record the provider-error failure (errorKind + provider only —
        // NEVER the raw provider message; T-186-08). The typed ImageGenError
        // carries `imageErrorKind`; a plain Error has none → "error" fallback.
        const imageErrorKind =
          (result.error as { imageErrorKind?: unknown }).imageErrorKind;
        emit("image.failed", {
          errorKind: typeof imageErrorKind === "string" ? imageErrorKind : "error",
          provider: deps.provider.id,
        });
        // RES-03 honest-unavailable: forward the typed error's knob-naming hint
        // when present (e.g. an image-incapable main provider). The provider
        // selector (setup-image-provider.ts) returns a port whose execute()
        // yields an ImageGenError carrying { imageErrorKind, hint } — surface
        // the hint so the agent gets a remedy, not silence.
        const hint = extractImageHint(result.error);
        return hint
          ? { success: false, error: result.error.message, hint }
          : { success: false, error: result.error.message };
      }

      // SEC-02: accumulate the actual cost into the per-agent/hour bucket on a
      // successful generation (the pre-check above gates the NEXT request). This
      // fires exactly once per success — placed after the `!result.ok` guard and
      // before the persist/delivery branches so EVERY success path (delivered,
      // base64-after-persist, persist-failure base64) accounts the cost the same.
      // An undefined costUsd records 0 (the limiter clamps it; no crash) — legacy
      // adapters without the widened ImageGenOutput simply contribute nothing.
      deps.costLimiter?.record(agentId, result.value.costUsd ?? 0);

      // WR-02 (186-REVIEW) / OBS-03: emit the synthetic `observability:token_usage`
      // billing event HERE — after the cost is charged to the limiter, BEFORE the
      // persist branch — so it fires on EVERY charged generation regardless of
      // persist outcome (delivered, persist-ok, OR persist-failure base64). It
      // previously lived inside the persisted-ok `else`, so a persist failure
      // charged the limiter but UNDER-BILLED (cost-limiter, billing, and the obs
      // outcome disagreed for the same turn). Tokens are all 0 (no LLM tokens for
      // an image RPC); every token_usage subscriber SUMS cost.total / tokens.total
      // (token-tracker.ts:191 guards `> 0`), so a 0-token event is safe (A3 /
      // T-186-10). Emitted only on a non-zero costUsd.
      if (deps.eventBus && (result.value.costUsd ?? 0) > 0) {
        deps.eventBus.emit("observability:token_usage", {
          timestamp: systemNowMs(),
          traceId: sessionKey ?? "",
          agentId,
          channelId: (rawParams._callerChannelId as string | undefined) ?? "",
          executionId: "",
          provider: result.value.provider ?? deps.provider.id,
          model: result.value.model ?? "",
          tokens: { prompt: 0, completion: 0, total: 0 },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.value.costUsd ?? 0 },
          latencyMs: systemNowMs() - startMs,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          sessionKey: sessionKey ?? "",
          savedVsUncached: 0,
          cacheEligible: false,
          warmupTurn: false,
          pendingCacheInvestmentUsd: 0,
        });
      }

      // DEL-01: persist the generated image to the agent's confined workspace
      // (`~/.comis/workspace/media/photos/`) via MediaPersistenceService BEFORE
      // any delivery decision — replacing the ephemeral OS temp-file plumbing. The
      // service detects the MIME, assigns a UUID filename, routes to `photos/`,
      // enforces the size cap, and confines the path with safePath internally;
      // the handler hands it only a buffer + mediaKind (T-186-01 — it never
      // builds a raw path). `persist` NEVER throws — on a failure (e.g. over the
      // size cap, disk full) it returns `err`, and the handler WARNs and falls
      // through to the bounded base64 RPC fallback (it does NOT crash and does
      // NOT attempt channel delivery with a missing file).
      const persisted = await deps.persist(agentId, result.value.buffer, {
        mediaKind: "image",
        mimeType: result.value.mimeType,
      });
      if (!persisted.ok) {
        deps.logger.warn(
          {
            agentId,
            err: persisted.error,
            errorKind: "resource" as const,
            hint: "Image generated but persistence failed; returning base64 fallback",
            step: "image_persist",
          },
          "Image persistence failed",
        );
        // WR-02 (186-REVIEW): a persist failure here is a DEGRADED DELIVERY, not a
        // generation failure. The generation SUCCEEDED, the cost was charged (and
        // billed above), and the agent IS delivered the image as base64 below — so
        // the terminal trajectory record is image.generated{outcome:"ok"} carrying
        // costUsd (OBS-03 Route a), NOT image.failed (which would mis-report a
        // charged, delivered image as failed and reconstruct the turn as failed in
        // `comis explain`). `persisted:false` surfaces the missing durable artifact
        // as a content-free degradation signal. sizeBytes is the raw buffer length
        // (no PersistedFile). image.failed stays reserved for `!result.ok`.
        emit("image.generated", {
          provider: deps.provider.id,
          outcome: "ok",
          persisted: false,
          ...(result.value.model !== undefined ? { model: result.value.model } : {}),
          ...(result.value.costUsd !== undefined ? { costUsd: result.value.costUsd } : {}),
          sizeBytes: result.value.buffer.byteLength,
        });
        // Fall through to the base64 fallback below (delivered as base64).
      } else {
        // OBS-04: the image was generated AND durably persisted — record
        // image.generated carrying costUsd (OBS-03 Route a — the binding cost the
        // comis-explain reconstruction reads), model, the durable sizeBytes, and
        // the ok outcome. `persisted:true` distinguishes it from the WR-02
        // degraded-delivery branch above. Optional fields ride the widened
        // ImageGenOutput (186-02) and are omitted when absent (no undefined keys).
        emit("image.generated", {
          provider: deps.provider.id,
          outcome: "ok",
          persisted: true,
          ...(result.value.model !== undefined ? { model: result.value.model } : {}),
          ...(result.value.costUsd !== undefined ? { costUsd: result.value.costUsd } : {}),
          sizeBytes: persisted.value.sizeBytes,
        });
        // Direct channel delivery via adapter.sendAttachment, using the PERSISTED
        // durable path (DEL-01 — no OS temp-file write, no delete, no cleanup).
        const channelType = rawParams._callerChannelType as string | undefined;
        const channelId = rawParams._callerChannelId as string | undefined;

        if (channelType && channelId) {
          const adapter = deps.getChannelAdapter(channelType);
          // DEL-02 (capability-driven, NEVER a channel-name list): sendAttachment
          // is optional on ChannelPort. When the adapter omits it (today only
          // IRC), skip direct delivery and fall through to the base64 fallback —
          // never call an undefined method. This is a Class B call site (no
          // capability gate runs before image-handlers reaches the adapter).
          if (adapter && typeof adapter.sendAttachment === "function") {
            const sendAttachment = adapter.sendAttachment.bind(adapter);
            const ext = result.value.mimeType === "image/png" ? ".png" : ".jpg";
            const attachment: AttachmentPayload = {
              type: "image",
              url: persisted.value.filePath,
              mimeType: result.value.mimeType,
              fileName: `generated-image${ext}`,
            };

            const sendResult = await sendAttachment(channelId, attachment);
            if (!sendResult.ok) {
              deps.logger.warn(
                {
                  channelType,
                  channelId,
                  err: sendResult.error,
                  hint: "Image generated but delivery failed; returning base64 fallback",
                  errorKind: "network" as const,
                },
                "Image channel delivery failed",
              );
              // Fall through to base64 fallback
            } else {
              const deliveredResult = { success: true, delivered: true, mimeType: result.value.mimeType };
              if (systemGetEnv("NODE_ENV") !== "production") {
                ImageGenerateContract.response.parse(deliveredResult);
              }
              // OBS-04: the image reached the channel — record image.delivered
              // (channel TYPE + delivered boolean only, never the channel id).
              emit("image.delivered", { channelType, delivered: true });
              // OBS-01 (§2.7): the FULL completion field set on the
              // channel-delivered path. imageProvider = the EXECUTING port
              // (deps.provider.id); model/costUsd ride the widened ImageGenOutput
              // (OBS-03, Task 1); sizeBytes is the durable PersistedFile size
              // (DEL-01). traceId is NOT a payload field — it rides the Pino ALS
              // mixin (CLAUDE.md); the RPC producer injects no _traceId.
              deps.logger.info(
                {
                  agentId,
                  imageProvider: deps.provider.id,
                  mainProvider: main.providerId,
                  model: result.value.model,
                  costUsd: result.value.costUsd,
                  sizeBytes: persisted.value.sizeBytes,
                  delivered: true,
                  mimeType: result.value.mimeType,
                  durationMs: systemNowMs() - startMs,
                  step: "image_complete",
                },
                "Image generation completed",
              );
              return deliveredResult;
            }
          }
        }
      }

      // Fallback: return base64 when persistence failed, no channel adapter is
      // available, the adapter cannot attach (DEL-02), or delivery failed.
      const fallbackResult = {
        success: true,
        imageBase64: result.value.buffer.toString("base64"),
        mimeType: result.value.mimeType,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ImageGenerateContract.response.parse(fallbackResult);
      }
      // OBS-01 (§2.7): the FULL completion field set on the base64-fallback path
      // (persist failed, no channel adapter, the adapter cannot attach, or
      // delivery failed and fell through). No PersistedFile here, so sizeBytes is
      // the raw buffer length. traceId rides the ALS mixin (NOT a payload field).
      deps.logger.info(
        {
          agentId,
          imageProvider: deps.provider.id,
          mainProvider: main.providerId,
          model: result.value.model,
          costUsd: result.value.costUsd,
          sizeBytes: result.value.buffer.byteLength,
          delivered: false,
          mimeType: result.value.mimeType,
          durationMs: systemNowMs() - startMs,
          step: "image_complete",
        },
        "Image generation completed",
      );
      return fallbackResult;
    },
  };
}
