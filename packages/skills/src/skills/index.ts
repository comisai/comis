// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/skills — Public surface for the `.` subpath.
 *
 * Owns the skill-discovery + eligibility + prompt + policy + bridge concerns:
 *   - Skill registry, manifest parsing, eligibility resolution
 *   - Prompt processor + content scanner
 *   - Tool bridge: assembly pipeline, metadata enforcement, credential
 *     injection, AgentTool ↔ ToolDefinition adapter, MCP tool bridge
 *   - Tool policy (TOOL_PROFILES, TOOL_GROUPS, applyToolPolicy)
 *   - MCP client manager
 *
 * Per Phase 33 RES-ARCH-1 + RES-ARCH-5, source files under `src/skills/`
 * (excluding this barrel) MUST NOT import from `../tools/` or
 * `../platform-tools/` at the per-file level (one-way invariant enforced
 * by `__tests__/architecture.test.ts`).
 *
 * This barrel additionally re-exports the SAME 45 platform-tool factories
 * + media stack + browser + builtin tools + integrations + etc. surface
 * that the pre-Phase-33 `packages/skills/src/index.ts` exposed, so that
 * consumers (daemon, agent) which already import from `@comis/skills`
 * continue to resolve. Plan 03 introduces the descriptor registry and
 * Plan 04 narrows consumer imports to the appropriate subpath; this
 * re-export shim can be dropped at that point (PUB-EXPORTS-* dead-export
 * test catches anything we accidentally re-broaden).
 *
 * @module
 */

// ===========================================================================
// `.` subpath canonical exports (skill registry, manifest, prompt, policy,
// bridge, MCP client manager). Plan 04 narrows the barrel down to this set.
// ===========================================================================

// Registry
export { createSkillRegistry } from "./registry/skill-registry.js";
export type { SkillRegistry, SkillWatcherHandle } from "./registry/skill-registry.js";

// Eligibility
export { createRuntimeEligibilityContext } from "./registry/eligibility.js";

// Bridge
export { assembleToolPipeline } from "./bridge/tool-bridge.js";
export type { PlatformToolProvider } from "./bridge/tool-bridge.js";

// Bridge -- Metadata enforcement
export { wrapWithMetadataEnforcement } from "./bridge/tool-metadata-enforcement.js";

// Bridge -- Credential injection
export { createCredentialInjector } from "./bridge/credential-injector.js";
export type { CredentialInjector } from "./bridge/credential-injector.js";

// Bridge -- AgentTool to ToolDefinition adapter
export { agentToolsToToolDefinitions } from "./bridge/tool-definition-adapter.js";

// Bridge -- MCP tool bridge
export {
  mcpToolsToAgentTools,
  jsonSchemaToTypeBox,
  sanitizeMcpToolName,
  classifyMcpErrorType,
} from "./bridge/mcp-tool-bridge.js";

// Prompt processor
export { expandSkillForInvocation } from "./prompt/processor.js";

// Content scanner (security scan before write)
export { scanSkillContent, type ContentScanResult, type ContentScanFinding } from "./prompt/content-scanner.js";

// Integrations -- MCP client manager
export { createMcpClientManager, qualifyToolName, parseQualifiedName } from "./integrations/mcp-client.js";
export type {
  McpClientManager,
  McpClientManagerDeps,
  McpServerConfig,
  McpConnection,
  McpConnectionStatus,
  McpToolDefinition,
  McpToolCallResult,
  McpToolCallContent,
} from "./integrations/mcp-client.js";

// Tool policy (profiles and groups for tool filtering)
export { applyToolPolicy, expandGroups, TOOL_PROFILES, TOOL_GROUPS } from "./policy/index.js";
export type { ToolFilterReason, ToolPolicyResult } from "./policy/index.js";

// ===========================================================================
// Transitional `./tools` re-exports (Phase 33 — kept for daemon/agent
// import compatibility; Plan 04 will retarget consumers and drop this).
// ===========================================================================

// Built-in tools (web-search, web-fetch)
export { createWebSearchTool, __clearSearchCache } from "../tools/builtin/web-search-tool.js";
export { createWebFetchTool, fetchUrlContent, __clearFetchCache } from "../tools/builtin/web-fetch-tool.js";

// Built-in tools -- Source profiles (per-tool limits and extraction config)
export {
  type ToolSourceProfile,
  DEFAULT_SOURCE_PROFILES,
  resolveSourceProfile,
  resolveAllProfiles,
} from "../tools/builtin/tool-source-profiles.js";

// Built-in tools -- safe-path types: dropped from `.` subpath (Plan 03 /
// ARCH-BASE-03). `LazyPaths` and `resolvePaths` are consumed only by
// daemon's setup-tools.ts which now imports them from
// `@comis/skills/tools` (their canonical subpath per Plan 02 RES-ARCH-1).

// Built-in tools -- file state tracking
// `createFileStateTracker` is still consumed via the `.` subpath by
// daemon.ts (sessionTrackerRegistry construction); `isDeviceFile` retained
// for symmetry. `FileStateTracker` type is now imported by daemon via
// `@comis/skills/tools` (Plan 03), so the type re-export below is dead --
// dropped per public-export-consumers test (ARCH-BASE-03 + ARCH-BASE-08).
export { createFileStateTracker, isDeviceFile } from "../tools/builtin/file/file-state-tracker.js";
export type { FileReadState } from "../tools/builtin/file/file-state-tracker.js";

// Built-in tools -- install-detour parser (still consumed from `.` subpath
// by daemon's detour-status RPC handler).
export type { InstallDetourDecision, DetourOverlap } from "../tools/builtin/install-detour.js";
export { parseInstallDetour } from "../tools/builtin/install-detour.js";

// Built-in tools -- Exec sandbox types
// `SandboxOptions` retained for daemon's setup-docker-sandbox flow;
// `SandboxProvider` is still consumed via `.` subpath by daemon.ts
// (detectSandboxProvider call); `ExecSandboxConfig` was used only by
// setup-tools.ts which now imports it from `@comis/skills/tools` -- the
// dead `.` subpath re-export is dropped (Plan 03 / ARCH-BASE-03).
export type { SandboxProvider, SandboxOptions } from "../tools/builtin/sandbox/types.js";

// Built-in tools -- Exec sandbox detection
export { detectSandboxProvider } from "../tools/builtin/sandbox/detect-provider.js";
export type { DetectLogger } from "../tools/builtin/sandbox/detect-provider.js";

// Browser -- service
export { createBrowserService } from "../tools/browser/index.js";
export type { BrowserService, ActParams } from "../tools/browser/index.js";

// Integrations -- STT provider factory
export { createSTTProvider, createFallbackTranscription } from "../tools/integrations/stt-factory.js";

// Integrations -- Media preprocessor
export { preprocessMessage } from "../tools/integrations/media-preprocessor.js";

// Integrations -- TTS provider factory
export { createTTSProvider } from "../tools/integrations/tts-factory.js";

// Integrations -- TTS enhancements
export { shouldAutoTts } from "../tools/integrations/tts/tts-auto-mode.js";
export { resolveOutputFormat } from "../tools/integrations/tts/tts-output-format.js";
export { parseTtsDirective } from "../tools/integrations/tts/tts-directive-parser.js";

// Integrations -- Link understanding
export { createLinkRunner } from "../tools/integrations/link/link-runner.js";
export type { LinkRunner } from "../tools/integrations/link/link-runner.js";

// Integrations -- Vision
export { createVisionProviderRegistry, selectVisionProvider } from "../tools/integrations/vision/vision-provider-registry.js";
export { resolveVisionScope } from "../tools/integrations/vision/scope-resolver.js";

// Media -- audio, networking, persistence, FFmpeg
export {
  detectFfmpeg,
  createAudioConverter,
  createMediaTempManager,
  createMediaSemaphore,
  createSsrfGuardedFetcher,
  createCompositeResolver,
  createMediaPersistenceService,
} from "../tools/media/index.js";
export type {
  FfmpegCapabilities,
  AudioConverter,
  MediaTempManager,
  MediaSemaphore,
  SsrfGuardedFetcher,
  MediaPersistenceService,
  PersistedFile,
} from "../tools/media/index.js";

// Image pipeline -- API sanitizer
export { sanitizeImageForApi } from "../tools/integrations/image-sanitizer.js";

// Image pipeline -- Outbound media parser
export { parseOutboundMedia } from "../tools/integrations/outbound-media-parser.js";

// Document extraction
export { createFileExtractor } from "../tools/integrations/document/file-extractor.js";

// PDF extraction
export { createPdfExtractor } from "../tools/integrations/document/pdf-extractor.js";

// PDF page renderer
export { createPdfPageRenderer } from "../tools/integrations/document/pdf-page-renderer.js";
export type { PdfPageRenderer } from "../tools/integrations/document/pdf-page-renderer.js";

// Composite file extractor
export { createCompositeFileExtractor } from "../tools/integrations/document/composite-extractor.js";

// Image generation (provider adapters, factory, rate limiter)
export { createImageGenProvider, createImageGenRateLimiter } from "../tools/integrations/image-gen/index.js";
export type { ImageGenRateLimiter } from "../tools/integrations/image-gen/index.js";

// ===========================================================================
// Phase 33 SKILLS-SPLIT-08: the 38+ platform-tool factory re-exports that
// used to live here (the `transitional kitchen-sink` block) have been
// dropped. Daemon now consumes the platform-tool surface via the descriptor
// registry on the `./platform-tools` subpath:
//   import { createPlatformToolRegistry } from "@comis/skills/platform-tools"
// All callers should reach for the registry rather than naming individual
// factories. The factory functions themselves remain exported from the
// `./platform-tools` subpath barrel (packages/skills/src/platform-tools/
// index.ts) -- they're consumed there by registry.ts and by per-factory
// tests; daemon never names them directly.
//
// Type RpcCall is still re-exported from cron-tool via ./platform-tools/
// index.ts; consumers that need the bare type import from
// "@comis/skills/platform-tools" or import it through their own factory
// signature.
// ===========================================================================

// Re-export RpcCall on the `.` subpath for daemon-internal type compatibility
// (BrowserService deps, RpcDispatchPort signatures, etc. -- all in daemon's
// daemon-types.ts and rpc-dispatch.ts). Plan 04 will narrow this when daemon
// imports RpcCall from `@comis/skills/platform-tools` directly.
export type { RpcCall } from "../platform-tools/index.js";
