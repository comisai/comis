// SPDX-License-Identifier: Apache-2.0
// Media (image-generation resolution) helper re-exports for the @comis/core barrel.
// Only the cross-package-consumed symbols are surfaced: the daemon pi-image
// shim imports `resolveImageProvider`/`IMAGE_ERR_TO_LOG`/`ImageErrorKind`, and
// the daemon image-handlers import `isValidImageModel` / `listImageModels` to
// validate an agent-supplied `model` arg + build the reject hint (the in-repo
// consumer that satisfies the public-export-consumers gate). `IMAGE_CAPABILITY`
// and the `ImageProviderSelection`/`ImageGenSelectionConfig` types are consumed
// only inside `@comis/core/media` (relative imports) today, so they stay off
// the public barrel until a cross-package consumer exists.
export { IMAGE_ERR_TO_LOG, resolveImageProvider } from "../media/index.js";
// Only the two validators are surfaced — they are consumed cross-package by the
// daemon image-handlers. The backing `IMAGE_MODELS_BY_PROVIDER` const stays off
// the public barrel (no cross-package consumer; the validators encapsulate it —
// same policy as `IMAGE_CAPABILITY` above). It is importable
// intra-`@comis/core/media` via a relative path for the unit test.
export { isValidImageModel, listImageModels } from "../media/index.js";
export type { ImageErrorKind } from "../media/index.js";
// The pure vision-path resolver is consumed CROSS-PACKAGE by the daemon
// media-handlers ladder (the two seams call `resolveVisionPath` and switch on
// the returned `path`). Surfaced here on the public barrel so the daemon
// imports it from `@comis/core` (mirrors `resolveImageProvider` above; the
// intra-core media barrel alone is not a cross-package surface).
// The `VisionPathSelection`/`VisionPathInput` types stay OFF the public barrel
// (the handler consumes the return STRUCTURALLY, no named type import) — the same
// policy as `ImageProviderSelection`, which stays intra-`@comis/core/media`.
export { resolveVisionPath } from "../media/index.js";
// Video generation — the video twins of the image media symbols above, surfaced
// on the public barrel for the @comis/skills FAL adapter and the @comis/daemon
// video handler + selector. The daemon consumes `resolveVideoProvider` /
// `VIDEO_ERR_TO_LOG` / `VideoErrorKind` / `VideoGenError` / `estimateVideoCostUsd`
// / `isBlockedObjectKey`; the skills adapter consumes `VideoGenError` (+ the
// port types from exports/ports.ts). `VIDEO_CAPABILITY` and the
// `VideoProviderSelection` / `VideoGenSelectionConfig` types stay OFF the public
// barrel (intra-`@comis/core/media` only — the same policy as `IMAGE_CAPABILITY`
// / `ImageProviderSelection`); they get re-exported here only if a
// cross-package consumer ever needs them.
export {
  VIDEO_ERR_TO_LOG,
  VideoGenError,
  resolveVideoProvider,
  isBlockedObjectKey,
  estimateVideoCostUsd,
  VIDEO_PRICING,
} from "../media/index.js";
export type { VideoErrorKind } from "../media/index.js";
// Per-model capability matrix accessors. Surfaced on the public @comis/core
// barrel — the SINGLE public surface (there is no ./media subpath) — so the
// @comis/daemon video-handlers validator (listVideoModelCaps + supportedModes +
// snapDuration) and the @comis/skills video-generate tool's dynamic description
// (listVideoModelCaps) can import them from @comis/core. The VideoModelCaps /
// VideoDurations types are consumed structurally (inferred off the accessors'
// return types, no named import), so they are tracked in
// test/support/public-api-policy.ts. The raw VIDEO_MODELS const stays
// OFF the public barrel (intra-`@comis/core/media` only — the IMAGE_CAPABILITY
// / IMAGE_MODELS_BY_PROVIDER policy: the accessors encapsulate it).
export { listVideoModelCaps, supportedModes, snapDuration } from "../media/index.js";
export type { VideoModelCaps, VideoDurations } from "../media/index.js";
// Keyless voice — the daemon setup-audio-provider.ts consumes
// resolveTranscriptionProvider / resolveTtsProvider / VOICE_KEYLESS /
// MAIN_PROVIDER_AUDIO / STT_ERR_TO_LOG / SttErrorKind cross-package (the
// predicate-injection wiring + the honest-unavailable branch). Surfaced on the
// public @comis/core barrel (the single public surface — there is no ./media
// subpath) so the daemon imports them from @comis/core, mirroring
// resolveImageProvider / resolveVideoProvider above. The SttSelection /
// TtsSelection / *SelectionConfig TYPES stay OFF the public barrel (consumed
// structurally by the daemon, the same policy as ImageProviderSelection /
// VideoProviderSelection above).
export {
  VOICE_KEYLESS,
  MAIN_PROVIDER_AUDIO,
  STT_ERR_TO_LOG,
  resolveTranscriptionProvider,
  resolveTtsProvider,
} from "../media/index.js";
export type { SttErrorKind } from "../media/index.js";
