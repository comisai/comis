// SPDX-License-Identifier: Apache-2.0
// Media (image-generation resolution) public surface for @comis/core.
export { IMAGE_CAPABILITY } from "./image-capability.js";
export {
  IMAGE_MODELS_BY_PROVIDER,
  isValidImageModel,
  listImageModels,
} from "./image-models.js";
export { IMAGE_ERR_TO_LOG } from "./image-error.js";
export type { ImageErrorKind } from "./image-error.js";
export { resolveImageProvider } from "./resolve-image-provider.js";
export type {
  ImageProviderSelection,
  ImageGenSelectionConfig,
} from "./resolve-image-provider.js";
export { resolveVisionPath } from "./resolve-vision-path.js";
export type {
  VisionPathSelection,
  VisionPathInput,
} from "./resolve-vision-path.js";
// Video generation (v2.24 Phase 188) — the video twins of the image symbols above.
export { VIDEO_CAPABILITY } from "./video-capability.js";
export { VIDEO_ERR_TO_LOG, VideoGenError } from "./video-error.js";
export type { VideoErrorKind } from "./video-error.js";
export { resolveVideoProvider, isBlockedObjectKey } from "./resolve-video-provider.js";
export type {
  VideoProviderSelection,
  VideoGenSelectionConfig,
} from "./resolve-video-provider.js";
export { estimateVideoCostUsd, VIDEO_PRICING } from "./video-pricing.js";
// CAP-02 per-model capability matrix — export the ACCESSORS + types only; the
// raw VIDEO_MODELS const stays intra-core (public-export-consumers gate). Plan
// 02 (handler) / Plan 03 (tool) import these from @comis/core (the package-root
// barrel — there is no ./media subpath); the cross-package consumers land in
// Wave 2, so the dead-export gate goes green at the Wave-2/phase gate.
export { listVideoModelCaps, supportedModes, snapDuration } from "./video-models.js";
export type { VideoModelCaps, VideoDurations } from "./video-models.js";
// Keyless voice (v2.25 Phase 193) — the STT/TTS twins of the image/video
// symbols above. The daemon setup-audio-provider.ts (Plan 03) is the
// cross-package consumer of the resolvers + the capability map + the error bridge.
export { VOICE_KEYLESS, MAIN_PROVIDER_AUDIO } from "./voice-capability.js";
export { STT_ERR_TO_LOG } from "./voice-error.js";
export type { SttErrorKind } from "./voice-error.js";
export { resolveTranscriptionProvider } from "./resolve-transcription-provider.js";
export type {
  SttSelection,
  SttSelectionConfig,
} from "./resolve-transcription-provider.js";
export { resolveTtsProvider } from "./resolve-tts-provider.js";
export type { TtsSelection, TtsSelectionConfig } from "./resolve-tts-provider.js";
