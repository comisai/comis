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
import { writeFile, unlink } from "node:fs/promises";
import { ImageGenerateContract, safePath, stripInternalFields, systemGetEnv } from "@comis/core";
import { suppressError } from "@comis/shared";
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

      // Pass safetyChecker from config.
      // OpenAI enforces safety server-side; safetyChecker config only affects fal.ai's enable_safety_checker param
      const result = await deps.provider.execute({
        prompt,
        size: params.size ?? deps.config.defaultSize,
        safetyChecker: deps.config.safetyChecker,
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
      return fallbackResult;
    },
  };
}
