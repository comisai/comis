// SPDX-License-Identifier: Apache-2.0
/**
 * Video Generate tool: text-to-video generation via provider abstraction.
 *
 * Allows agents to generate videos from text prompts. Delegates to the
 * daemon-side video.generate RPC handler (lands Phase 188 Plan 04) which
 * resolves the agent's main provider's video backend (or explicit FAL),
 * applies a per-agent rate limit + a pre-submit worst-case cost ceiling, runs
 * the inline submit→poll→download loop through one VideoGenerationPort, and
 * delivers the generated video directly to the current channel via
 * sendAttachment (or a size-capped base64 fallback).
 *
 * @module
 */

import { Type } from "typebox";
import { registerActivityLabelSpec } from "@comis/core";
import { createRpcDispatchTool } from "../messaging-factory.js";
import type { RpcCall } from "./cron-tool.js";

// Activity label spec (§17.6). Descriptor name == emitted name.
registerActivityLabelSpec("video_generate", {
  semanticPhase: "media",
  label: "generating video",
});

const VideoGenerateToolParams = Type.Object({
  prompt: Type.String({
    description: "Text description of the video to generate.",
  }),
  duration: Type.Optional(
    Type.Number({
      description: "Clip length in seconds (provider-validated). Omit for default.",
    }),
  ),
  aspect_ratio: Type.Optional(
    Type.String({
      description: "Aspect ratio: 16:9 | 9:16 | 1:1 (provider-validated). Omit for default.",
    }),
  ),
  resolution: Type.Optional(
    Type.String({
      description: "Resolution: 720p | 1080p | 4k (provider-validated). Omit for default.",
    }),
  ),
  audio: Type.Optional(
    Type.Boolean({
      description: "Generate audio (provider-dependent). Omit for the provider default.",
    }),
  ),
  negative_prompt: Type.Optional(
    Type.String({
      description: "Text describing what to avoid in the generated video.",
    }),
  ),
  seed: Type.Optional(
    Type.Number({
      description: "Deterministic seed for reproducible generations (provider-dependent).",
    }),
  ),
  image_url: Type.Optional(
    Type.String({
      description:
        "A workspace file path, URL, or data-URI of a source image for image-to-video. SSRF-guarded and workspace-confined by the handler. Omit for text-to-video.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Override the provider's default video model/endpoint (e.g. fal-ai/veo3.1/fast). Omit to use the default.",
    }),
  ),
});

/**
 * Create the video_generate tool for text-to-video generation.
 *
 * Uses the createRpcDispatchTool factory to dispatch to the daemon-side
 * video.generate RPC handler. The RPC handler resolves the provider, applies
 * rate limiting + the pre-submit cost ceiling, and executes the inline
 * submit→poll→download loop before delivering the generated video directly to
 * the current channel.
 *
 * @param rpcCall - RPC call function for delegating to the daemon
 * @returns AgentTool that dispatches to video.generate
 */
export function createVideoGenerateTool(rpcCall: RpcCall) {
  return createRpcDispatchTool({
    name: "video_generate",
    label: "Generate Video",
    description:
      "Generate a video from a text prompt, optionally from a source image (image-to-video) and with an explicit model. The generated video is automatically delivered to the current channel.",
    parameters: VideoGenerateToolParams,
    rpcMethod: "video.generate",
  }, rpcCall);
}
