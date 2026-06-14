// SPDX-License-Identifier: Apache-2.0
// Media (image-generation resolution) helper re-exports for the @comis/core barrel.
// Only the cross-package-consumed symbols are surfaced: the daemon pi-image
// shim imports `resolveImageProvider`/`IMAGE_ERR_TO_LOG`/`ImageErrorKind`.
// `IMAGE_CAPABILITY` and the `ImageProviderSelection`/`ImageGenSelectionConfig`
// types are consumed only inside `@comis/core/media` (relative imports) today,
// so they stay off the public barrel until a cross-package consumer exists
// (public-export-consumers gate). A later phase re-exports them here if needed.
export { IMAGE_ERR_TO_LOG, resolveImageProvider } from "../media/index.js";
export type { ImageErrorKind } from "../media/index.js";
