// SPDX-License-Identifier: Apache-2.0
/**
 * Media processing module -- MIME detection, FFmpeg detection, audio
 * conversion, media temp/semaphore, SSRF-guarded fetch, composite resolver,
 * media persistence, and shared constants.
 *
 * @module
 */

// Constants
export {
  LIMIT_INPUT_PIXELS,
  DEFAULT_QUALITY,
  MAX_SIDE_DEFAULT,
  SIZE_LIMITS,
  MIME_EXTENSIONS,
} from "./constants.js";
export type { MediaKind } from "./constants.js";

// MIME detection
export {
  detectMime,
  getExtensionForMime,
  getExtensionMime,
  normalizeHeaderMime,
  isGenericMime,
} from "./mime-detection.js";

// FFmpeg detection
export { detectFfmpeg } from "./ffmpeg-detect.js";
export type { FfmpegCapabilities } from "./ffmpeg-detect.js";

// Audio converter
export { createAudioConverter } from "./audio-converter.js";
export type {
  AudioConverter,
  AudioConverterDeps,
  ConversionResult,
  WaveformResult,
} from "./audio-converter.js";

// Media temp directory
export { createMediaTempManager } from "./media-temp.js";
export type {
  MediaTempManager,
  MediaTempConfig,
  MediaTempLogger,
} from "./media-temp.js";

// Media concurrency semaphore
export { createMediaSemaphore } from "./media-semaphore.js";
export type { MediaSemaphore } from "./media-semaphore.js";

// SSRF-guarded fetch
export { createSsrfGuardedFetcher } from "./ssrf-fetcher.js";
export type {
  SsrfGuardedFetcher,
  SsrfFetcherConfig,
  FetchedMedia,
} from "./ssrf-fetcher.js";

// Composite resolver (routes to per-platform resolvers by URI scheme)
export { createCompositeResolver } from "./composite-resolver.js";
export type { CompositeResolverDeps } from "./composite-resolver.js";

// Media persistence (workspace file persistence)
export { createMediaPersistenceService } from "./media-persistence.js";
export type {
  MediaPersistenceService,
  MediaPersistenceDeps,
  PersistedFile,
  PersistOptions,
} from "./media-persistence.js";
