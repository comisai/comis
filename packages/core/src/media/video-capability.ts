// SPDX-License-Identifier: Apache-2.0
/**
 * VIDEO_CAPABILITY — the single source of truth for "which resolved
 * main provider can generate video, via which backend, and with what default
 * video model".
 *
 * TWO VOCABULARIES (do not conflate — mirrors image-capability.ts):
 *   - The config selection enum (`integrations.media.videoGeneration.provider`)
 *     is what an OPERATOR may configure: "auto" | "fal" | "google" | "xai".
 *     `auto` is a selection MODE (it triggers the follow-main lookup), and `fal`
 *     is an explicit-only backend routed through the FAL queue adapter (it has
 *     no main-provider equivalent and is NOT a follow-main capability).
 *   - The keys of THIS map are RESOLVED main-provider ids only — the concrete
 *     provider the completion path resolves an agent to. A provider absent from
 *     this map is video-incapable: the lookup returns `undefined`, which the
 *     resolver turns into an honest "unsupported_provider" (never a silent
 *     fall-through to a different paid provider). So `auto` and `fal` MUST NOT
 *     appear as keys here.
 *
 * Provider-following is WEAKER for video than for images: only Google (Veo) and
 * xAI (Grok Imagine) expose a native video API. OpenAI Sora is not broadly
 * API-available; Anthropic / openai-codex / Groq have none → they resolve to
 * `undefined` (honest-unavailable, or explicit FAL).
 *
 * Model-id provenance (verified against the live provider docs, 2026-06-15):
 * `veo-3.0-fast-generate-001` is the GA Veo recommended default;
 * `grok-imagine-video` is the public xAI Grok Imagine video model
 * (public REST API since 2026-01-28). Both remain overridable by
 * config/tool model. Per-second pricing and preview model ids drift ~monthly —
 * re-verify when touching the live adapters.
 *
 * @module
 */

export const VIDEO_CAPABILITY: Record<
  string,
  { videoApi: string; defaultModel: string } | undefined
> = {
  "google": { videoApi: "veo", defaultModel: "veo-3.0-fast-generate-001" },
  "google-vertex": { videoApi: "veo", defaultModel: "veo-3.0-fast-generate-001" },
  "xai": { videoApi: "grok", defaultModel: "grok-imagine-video" },
  // openai / openai-codex / anthropic / amazon-bedrock / groq / mistral /
  // deepseek / default → undefined (no native video API).
  // auto / fal are NOT keys (selection-mode + explicit-only, not follow-main
  // capabilities).
};
