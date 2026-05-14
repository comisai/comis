// SPDX-License-Identifier: Apache-2.0
/**
 * Image generation RPC handler module.
 * Provides the image.generate handler that bridges the agent tool
 * to the image generation provider. Applies rate limiting,
 * safety checking, and delivers generated images directly
 * to the channel via adapter.sendAttachment.
 * Image generation RPC dispatch.
 *
 * Phase 35 Wave C (Plan 35-15): refactored to use the `@comis/core`
 * contract registry. The handler key is a computed-property name
 * (`[ImageGenerateContract.method]:`) so the bidirectional 1:1
 * architecture test resolves it through `defineContract({ method, ... })`
 * in `packages/core/src/api-contracts/media.ts`. The
 * dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)` (D-04
 * Pitfall 6). The `_agentId` / `_callerChannelType` / `_callerChannelId`
 * reads happen on the un-stripped `rawParams` BEFORE the strip step (the
 * internal fields flow into the handler through `rawParams`).
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
 * cluster slice in api/types.ts (Plan 34-08a; alias retarget in Plan 34-08c).
 * Single source of truth: `MediaApiDeps["imageHandlerDeps"]` (NonNullable —
 * the dispatcher constructs this handler only inside the
 * `deps.imageHandlerDeps ? ...` truthy branch). The cluster slice's nested
 * shape is structurally identical to the legacy ImageHandlerDeps. DAEMON-API-03
 * sub-shape alias — handler body unchanged.
 *
 * Note: unlike the other 8 retargets in 34-08c, image-handlers does NOT
 * receive the full MediaApiDeps cluster slice at runtime. The dispatcher
 * passes `deps.imageHandlerDeps` (the nested object) to `createImageHandlers`,
 * which is why the alias points at the sub-shape rather than the slice itself.
 * Plan 34-09 (api/shared/) is expected to lift this nested shape into a
 * sibling module both api/types.ts and image-handlers can import from.
 */
export type ImageHandlerDeps = NonNullable<MediaApiDeps["imageHandlerDeps"]>;

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
        return { success: false, error: result.error.message };
      }

      // Direct channel delivery via adapter.sendAttachment
      const channelType = rawParams._callerChannelType as string | undefined;
      const channelId = rawParams._callerChannelId as string | undefined;

      if (channelType && channelId) {
        const adapter = deps.getChannelAdapter(channelType);
        if (adapter) {
          // Write buffer to temp file for sendAttachment (which takes a URL/path)
          const ext = result.value.mimeType === "image/png" ? ".png" : ".jpg";
          const tempPath = safePath(tmpdir(), `comis-img-${randomUUID()}${ext}`);
          await writeFile(tempPath, result.value.buffer);

          const attachment: AttachmentPayload = {
            type: "image",
            url: tempPath,
            mimeType: result.value.mimeType,
            fileName: `generated-image${ext}`,
          };

          try {
            const sendResult = await adapter.sendAttachment(channelId, attachment);
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
