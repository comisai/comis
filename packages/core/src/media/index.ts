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
// Video generation — the video twins of the image symbols above.
export { VIDEO_CAPABILITY } from "./video-capability.js";
export { VIDEO_ERR_TO_LOG, VideoGenError } from "./video-error.js";
export type { VideoErrorKind } from "./video-error.js";
export { resolveVideoProvider, isBlockedObjectKey } from "./resolve-video-provider.js";
export type {
  VideoProviderSelection,
  VideoGenSelectionConfig,
} from "./resolve-video-provider.js";
export { estimateVideoCostUsd, VIDEO_PRICING } from "./video-pricing.js";
// Per-model video-capability matrix — export the ACCESSORS + types only; the
// raw VIDEO_MODELS const stays intra-core (public-export-consumers gate). The
// daemon video handler and the video-generate tool import these from
// @comis/core (the package-root barrel — there is no ./media subpath).
export { listVideoModelCaps, supportedModes, snapDuration } from "./video-models.js";
export type { VideoModelCaps, VideoDurations } from "./video-models.js";
// Keyless voice — the STT/TTS twins of the image/video symbols above. The
// daemon setup-audio-provider.ts is the cross-package consumer of the
// resolvers + the capability map + the error bridge.
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
