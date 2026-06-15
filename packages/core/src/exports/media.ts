// SPDX-License-Identifier: Apache-2.0
// Media (image-generation resolution) helper re-exports for the @comis/core barrel.
// Only the cross-package-consumed symbols are surfaced: the daemon pi-image
// shim imports `resolveImageProvider`/`IMAGE_ERR_TO_LOG`/`ImageErrorKind`, and
// the daemon image-handlers (IN-02, Phase 185) import `isValidImageModel` /
// `listImageModels` to validate an agent-supplied `model` arg + build the
// reject hint (the in-repo consumer that satisfies the public-export-consumers
// gate). `IMAGE_CAPABILITY` and the `ImageProviderSelection`/
// `ImageGenSelectionConfig` types are consumed only inside `@comis/core/media`
// (relative imports) today, so they stay off the public barrel until a
// cross-package consumer exists. A later phase re-exports them here if needed.
export { IMAGE_ERR_TO_LOG, resolveImageProvider } from "../media/index.js";
// IN-02 (Phase 185): only the two validators are surfaced — they are consumed
// cross-package by the daemon image-handlers. The backing `IMAGE_MODELS_BY_PROVIDER`
// const stays off the public barrel (no cross-package consumer; the validators
// encapsulate it — same policy as `IMAGE_CAPABILITY` above). It is importable
// intra-`@comis/core/media` via a relative path for the unit test.
export { isValidImageModel, listImageModels } from "../media/index.js";
export type { ImageErrorKind } from "../media/index.js";
// VIS-02/03 (Phase 187): the pure vision-path resolver is consumed CROSS-PACKAGE
// by the daemon media-handlers ladder (the two seams call `resolveVisionPath` and
// switch on the returned `path`). Surfaced here on the public barrel so the
// daemon imports it from `@comis/core` (mirrors `resolveImageProvider` above;
// 187-01 added it to ../media/index.js but only the intra-core media barrel
// re-exported it — this is the missing cross-package surface the handler needs).
// The `VisionPathSelection`/`VisionPathInput` types stay OFF the public barrel
// (the handler consumes the return STRUCTURALLY, no named type import) — the same
// policy as `ImageProviderSelection`, which stays intra-`@comis/core/media`.
export { resolveVisionPath } from "../media/index.js";
// Video generation (v2.24 Phase 188) — the video twins of the image media
// symbols above, surfaced on the public barrel so Plan 03 (the @comis/skills FAL
// adapter) and Plan 04 (the @comis/daemon video handler + selector) can import
// them. Plan 04 consumes `resolveVideoProvider` / `VIDEO_ERR_TO_LOG` /
// `VideoErrorKind` / `VideoGenError` / `estimateVideoCostUsd` / `isBlockedObjectKey`;
// Plan 03 consumes `VideoGenError` (+ the port types from exports/ports.ts).
// Those plans land in LATER waves, so until then these are documented
// planned-orphans tracked in test/support/public-api-policy.ts (the
// SessionStorePort / ContextStorePort ahead-of-consumer precedent — NOT a
// shrink-only architecture-allowlist entry). `VIDEO_CAPABILITY` and the
// `VideoProviderSelection` / `VideoGenSelectionConfig` types stay OFF the public
// barrel (intra-`@comis/core/media` only — the same policy as `IMAGE_CAPABILITY`
// / `ImageProviderSelection`); a later phase re-exports them here if a
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
