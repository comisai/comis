// SPDX-License-Identifier: Apache-2.0
/**
 * Image Generate tool: text-to-image generation via provider abstraction.
 *
 * Allows agents to generate images from text prompts. Delegates to the
 * daemon-side image.generate RPC handler which applies rate limiting,
 * safety checking, and provider execution. Generated images are delivered
 * directly to the current channel via sendAttachment.
 *
 * @module
 */

import { Type } from "typebox";
import { createRpcDispatchTool } from "./messaging-factory.js";
import type { RpcCall } from "./cron-tool.js";

const ImageGenerateToolParams = Type.Object({
  prompt: Type.String({
    description: "Text description of the image to generate.",
  }),
  size: Type.Optional(
    Type.String({
      description:
        "Image size. Provider-specific: fal.ai uses presets (square_hd, landscape_16_9), OpenAI uses pixel dims (1024x1024, 1792x1024). Omit for default.",
    }),
  ),
});

/**
 * Create the image_generate tool for text-to-image generation.
 *
 * Uses the createRpcDispatchTool factory to dispatch to the daemon-side
 * image.generate RPC handler. The RPC handler applies rate limiting,
 * safety checking, and provider execution before delivering the generated
 * image directly to the current channel.
 *
 * @param rpcCall - RPC call function for delegating to the daemon
 * @returns AgentTool that dispatches to image.generate
 */
export function createImageGenerateTool(rpcCall: RpcCall) {
  return createRpcDispatchTool({
    name: "image_generate",
    label: "Generate Image",
    description:
      "Generate an image from a text prompt. The generated image is automatically delivered to the current channel.",
    parameters: ImageGenerateToolParams,
    rpcMethod: "image.generate",
  }, rpcCall);
}
