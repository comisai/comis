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
