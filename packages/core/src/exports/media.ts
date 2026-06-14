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
export {
  IMAGE_MODELS_BY_PROVIDER,
  isValidImageModel,
  listImageModels,
} from "../media/index.js";
export type { ImageErrorKind } from "../media/index.js";
