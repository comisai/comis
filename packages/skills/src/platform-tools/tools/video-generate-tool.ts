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
import { listVideoModelCaps, registerActivityLabelSpec } from "@comis/core";
import type { VideoDurations, VideoGenerationPort } from "@comis/core";
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
 * The shipped static description, used when no backend is resolved at build
 * (the defensive path — e.g. the parity STUB_CTX with no videoGenProvider). It
 * carries NO config value, key, or env — only the generic capability prose
 * (T-191-08: the description must not leak config/secrets).
 */
const STATIC_FALLBACK =
  "Generate a video from a text prompt, optionally from a source image (image-to-video) and with an explicit model. The generated video is automatically delivered to the current channel.";

/** Human-readable duration set for the description: enum `4/6/8s`, range `1-15s`. */
function formatDurations(d: VideoDurations): string {
  return d.kind === "enum" ? `${d.values.join("/")}s` : `${d.min}-${d.max}s`;
}

/**
 * IN-03: build the `video_generate` description at registration time from the
 * ACTIVE backend's VIDEO_MODELS capability matrix, so the agent sees the active
 * provider's REAL options (durations/resolutions/aspect/i2v) — not a static
 * superset (Hermes `_build_dynamic_video_schema`, hardened with structured
 * enums). Built ONLY from the matrix's capability data + the backend id
 * (fal/veo/grok — not a secret): NO config value, key, or env is interpolated
 * (T-191-08). An unknown/blocked backend (the SEC-04 `isBlockedObjectKey` guard
 * in `listVideoModelCaps` returns `undefined`, T-191-09) or a backend with no
 * t2v entry falls back to STATIC_FALLBACK — never throws.
 *
 * Registration-time / default-agent-scoped: `AgentTool.description` is a static
 * string fixed at `build`, so changing the active `provider` needs a daemon
 * restart for the description to refresh (the shipped boot-bound provider
 * selection contract; the handler already WARNs on `video_provider_divergence`).
 */
function buildVideoDescription(backend: string | undefined): string {
  if (!backend) return STATIC_FALLBACK;
  const t2v = listVideoModelCaps(backend, "t2v"); // SEC-04 guarded; undefined if blocked/unknown
  if (!t2v) return STATIC_FALLBACK;
  const i2v = listVideoModelCaps(backend, "i2v");
  return (
    `Generate a video via ${backend}. ` +
    `Durations: ${formatDurations(t2v.durations)}. ` +
    `Resolutions: ${t2v.resolutions.join("/")}. ` +
    `Aspect ratios: ${t2v.aspectRatios.join("/")}. ` +
    (i2v
      ? "Supports image-to-video (set image_url with a source image). "
      : "Text-to-video only. ") +
    "The generated video is automatically delivered to the current channel."
  );
}

/**
 * Create the video_generate tool for text-to-video (and image-to-video)
 * generation.
 *
 * Uses the createRpcDispatchTool factory to dispatch to the daemon-side
 * video.generate RPC handler. The RPC handler resolves the provider, applies
 * rate limiting + the pre-submit cost ceiling, validates the params against the
 * active backend's capability matrix (IN-02), and executes the submit→poll→
 * download loop before delivering the generated video to the current channel.
 *
 * IN-03: when `provider` is supplied (the registry threads the boot-selected
 * `ctx.videoGenProvider`), the tool description is built at registration from
 * that backend's real capability matrix. With no provider it keeps the shipped
 * STATIC_FALLBACK string (defensive — the parity STUB_CTX path).
 *
 * @param rpcCall - RPC call function for delegating to the daemon
 * @param provider - the boot-selected video backend (only `.id` is read); when
 *   absent the description falls back to the static string
 * @returns AgentTool that dispatches to video.generate
 */
export function createVideoGenerateTool(
  rpcCall: RpcCall,
  provider?: Pick<VideoGenerationPort, "id">,
) {
  return createRpcDispatchTool({
    name: "video_generate",
    label: "Generate Video",
    description: buildVideoDescription(provider?.id),
    parameters: VideoGenerateToolParams,
    rpcMethod: "video.generate",
  }, rpcCall);
}
