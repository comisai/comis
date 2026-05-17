// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/skills/tools — Public surface for the `./tools` subpath.
 *
 * Owns runtime-agnostic capability adapters:
 *   - Built-in tools (non-platform): exec, process, apply-patch, web-search,
 *     web-fetch, file/file-tools/sandbox helpers, install-detour, source
 *     profiles, file-state-tracker
 *   - Browser service
 *   - Media stack (audio converter, temp manager, semaphore, SSRF fetcher,
 *     composite resolver, persistence service)
 *   - Integrations (non-MCP-client): STT/TTS factories, link runner, vision
 *     provider registry, image generation provider/rate-limiter, document
 *     extractors (file/PDF/composite/page renderer), image sanitizer,
 *     outbound media parser, media preprocessor
 *
 * The `.` subpath skill registry / bridge / policy concerns live separately
 * under `../skills/`. The architecture invariant (skills → tools is FORBIDDEN,
 * tools → skills is allowed in limited cases) is enforced by
 * `__tests__/architecture.test.ts`.
 *
 * Public API — every export has a verified external consumer.
 *
 * @module
 */

// Built-in tools (web-search, web-fetch)
export { createWebSearchTool, __clearSearchCache } from "./builtin/web-search-tool/index.js";
export { createWebFetchTool, fetchUrlContent, __clearFetchCache } from "./builtin/web-fetch-tool.js";

// Built-in tools -- Source profiles (per-tool limits and extraction config)
export {
  type ToolSourceProfile,
  DEFAULT_SOURCE_PROFILES,
  resolveSourceProfile,
  resolveAllProfiles,
} from "./builtin/tool-source-profiles.js";

// Built-in tools -- safe-path types (lazy resolution for hot-add)
export { type LazyPaths, resolvePaths } from "./builtin/file/safe-path-wrapper.js";

// Built-in tools -- file state tracking
export { createFileStateTracker, isDeviceFile } from "./builtin/file/file-state-tracker.js";
export type { FileStateTracker, FileReadState } from "./builtin/file/file-state-tracker.js";

// Built-in tools -- apply-patch
export { createApplyPatchTool } from "./builtin/file/apply-patch-tool.js";

// Built-in tools -- Exec + Process
export { createExecTool } from "./builtin/exec-tool/index.js";
export { createProcessTool } from "./builtin/process-tool.js";
export { createProcessRegistry } from "./builtin/process-registry.js";
export type { ProcessRegistry } from "./builtin/process-registry.js";
export type { InstallDetourDecision, DetourOverlap } from "./builtin/install-detour.js";
export { parseInstallDetour } from "./builtin/install-detour.js";

// Built-in tools -- Exec sandbox types
export type { SandboxProvider, SandboxOptions, ExecSandboxConfig } from "./builtin/sandbox/types.js";

// Built-in tools -- Exec sandbox detection
export { detectSandboxProvider } from "./builtin/sandbox/detect-provider.js";
export type { DetectLogger } from "./builtin/sandbox/detect-provider.js";

// Browser -- service
export { createBrowserService } from "./browser/index.js";
export type { BrowserService, ActParams } from "./browser/index.js";

// Integrations -- STT provider factory
export { createSTTProvider, createFallbackTranscription } from "./integrations/stt-factory.js";

// Integrations -- TTS provider factory
export { createTTSProvider } from "./integrations/tts-factory.js";

// Integrations -- TTS enhancements
export { shouldAutoTts } from "./integrations/tts/tts-auto-mode.js";
export { resolveOutputFormat } from "./integrations/tts/tts-output-format.js";
export { parseTtsDirective } from "./integrations/tts/tts-directive-parser.js";

// Integrations -- Link understanding
export { createLinkRunner } from "./integrations/link/link-runner.js";
export type { LinkRunner } from "./integrations/link/link-runner.js";

// Integrations -- Vision
export { createVisionProviderRegistry, selectVisionProvider } from "./integrations/vision/vision-provider-registry.js";
export { resolveVisionScope } from "./integrations/vision/scope-resolver.js";

// Integrations -- Media preprocessor
export { preprocessMessage } from "./integrations/media-preprocessor.js";

// Media -- audio, networking, persistence, FFmpeg
export {
  detectFfmpeg,
  createAudioConverter,
  createMediaTempManager,
  createMediaSemaphore,
  createSsrfGuardedFetcher,
  createCompositeResolver,
  createMediaPersistenceService,
} from "./media/index.js";
export type {
  FfmpegCapabilities,
  AudioConverter,
  MediaTempManager,
  MediaSemaphore,
  SsrfGuardedFetcher,
  MediaPersistenceService,
  PersistedFile,
} from "./media/index.js";

// Image pipeline -- API sanitizer
export { sanitizeImageForApi } from "./integrations/image-sanitizer.js";

// Image pipeline -- Outbound media parser
export { parseOutboundMedia } from "./integrations/outbound-media-parser.js";

// Document extraction
export { createFileExtractor } from "./integrations/document/file-extractor.js";

// PDF extraction
export { createPdfExtractor } from "./integrations/document/pdf-extractor.js";

// PDF page renderer
export { createPdfPageRenderer } from "./integrations/document/pdf-page-renderer.js";
export type { PdfPageRenderer } from "./integrations/document/pdf-page-renderer.js";

// Composite file extractor
export { createCompositeFileExtractor } from "./integrations/document/composite-extractor.js";

// Image generation (provider adapters, factory, rate limiter)
export { createImageGenProvider, createImageGenRateLimiter } from "./integrations/image-gen/index.js";
export type { ImageGenRateLimiter } from "./integrations/image-gen/index.js";
