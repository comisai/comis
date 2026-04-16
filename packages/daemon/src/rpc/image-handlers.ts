/**
 * Image generation RPC handler module.
 * Provides the image.generate handler that bridges the agent tool
 * to the image generation provider. Applies rate limiting,
 * safety checking, and delivers generated images directly
 * to the channel via adapter.sendAttachment.
 * Image generation RPC dispatch.
 * @module
 */

import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { safePath } from "@comis/core";
import { suppressError } from "@comis/shared";
import type { ImageGenerationPort, ImageGenerationConfig, ChannelPort, AttachmentPayload } from "@comis/core";
import type { ImageGenRateLimiter } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";
import type { RpcHandler } from "./types.js";

/** Dependencies required by image generation RPC handlers. */
export interface ImageHandlerDeps {
  provider: ImageGenerationPort;
  rateLimiter: ImageGenRateLimiter;
  config: ImageGenerationConfig;
  logger: ComisLogger;
  /** Direct channel delivery -- resolve adapter by channel type. */
  getChannelAdapter: (channelType: string) => Pick<ChannelPort, "sendAttachment"> | undefined;
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
    "image.generate": async (params) => {
      const agentId = (params._agentId as string) ?? "default";
      const prompt = params.prompt as string;

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
        size: (params.size as string) ?? deps.config.defaultSize,
        safetyChecker: deps.config.safetyChecker,
      });

      if (!result.ok) {
        return { success: false, error: result.error.message };
      }

      // Direct channel delivery via adapter.sendAttachment
      const channelType = params._callerChannelType as string | undefined;
      const channelId = params._callerChannelId as string | undefined;

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
              return { success: true, delivered: true, mimeType: result.value.mimeType };
            }
          } finally {
            // Best-effort cleanup if not already done
            suppressError(unlink(tempPath), "cleanup temp image file");
          }
        }
      }

      // Fallback: return base64 when no channel adapter available or delivery failed
      return {
        success: true,
        imageBase64: result.value.buffer.toString("base64"),
        mimeType: result.value.mimeType,
      };
    },
  };
}
