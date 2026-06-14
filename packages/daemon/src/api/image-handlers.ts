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

import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile, unlink, readFile } from "node:fs/promises";
import {
  ImageGenerateContract,
  isValidImageModel,
  listImageModels,
  safePath,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import { suppressError } from "@comis/shared";
import { guessMimeFromExtension, detectMimeFromMagicBytes } from "../wiring/daemon-utils.js";
import { fetchImageBytesSsrfSafe } from "./ssrf-image-fetch.js";
import type { AttachmentPayload } from "@comis/core";
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
          return {
            success: false,
            error: `Unknown model "${params.model}" for provider "${executingProvider}"`,
            hint: `Valid models for ${executingProvider}: ${known.join(", ")}`,
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

      // Direct channel delivery via adapter.sendAttachment
      const channelType = rawParams._callerChannelType as string | undefined;
      const channelId = rawParams._callerChannelId as string | undefined;

      if (channelType && channelId) {
        const adapter = deps.getChannelAdapter(channelType);
        // sendAttachment is now optional on ChannelPort. When the
        // adapter omits it (e.g., IRC), skip direct delivery and fall through
        // to the base64 fallback. This is a Class B call site (no capability
        // gate runs before image-handlers reaches the adapter).
        if (adapter && typeof adapter.sendAttachment === "function") {
          const sendAttachment = adapter.sendAttachment.bind(adapter);
          // Write buffer to temp file for sendAttachment (which takes a URL/path)
          const ext = result.value.mimeType === "image/png" ? ".png" : ".jpg";
          const tempPath = safePath(tmpdir(), `comis-img-${randomUUID()}${ext}`);
          // fs-safe-allowed: ephemeral OS-tmpdir file for channel-adapter attachment plumbing; not under ~/.comis/
          await writeFile(tempPath, result.value.buffer);

          const attachment: AttachmentPayload = {
            type: "image",
            url: tempPath,
            mimeType: result.value.mimeType,
            fileName: `generated-image${ext}`,
          };

          try {
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
              // Cleanup temp file after successful send
              suppressError(unlink(tempPath), "cleanup temp image file");
              const deliveredResult = { success: true, delivered: true, mimeType: result.value.mimeType };
              if (systemGetEnv("NODE_ENV") !== "production") {
                ImageGenerateContract.response.parse(deliveredResult);
              }
              // WR-03 (§2.7): INFO completion line on the channel-delivered path.
              deps.logger.info(
                {
                  agentId,
                  mainProvider: main.providerId,
                  delivered: true,
                  mimeType: result.value.mimeType,
                  durationMs: systemNowMs() - startMs,
                  step: "image_complete",
                },
                "Image generation completed",
              );
              return deliveredResult;
            }
          } finally {
            // Best-effort cleanup if not already done
            suppressError(unlink(tempPath), "cleanup temp image file");
          }
        }
      }

      // Fallback: return base64 when no channel adapter available or delivery failed
      const fallbackResult = {
        success: true,
        imageBase64: result.value.buffer.toString("base64"),
        mimeType: result.value.mimeType,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        ImageGenerateContract.response.parse(fallbackResult);
      }
      // WR-03 (§2.7): INFO completion line on the base64-fallback path
      // (no channel adapter, or delivery failed and fell through).
      deps.logger.info(
        {
          agentId,
          mainProvider: main.providerId,
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
