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
 * Source files under `src/skills/` (excluding this barrel) MUST NOT
 * import from `../tools/` or `../platform-tools/` at the per-file level
 * (one-way invariant enforced by `__tests__/architecture.test.ts`).
 *
 * This barrel additionally re-exports the platform-tool factories +
 * media stack + browser + builtin tools + integrations + etc. surface
 * that the previous flat `packages/skills/src/index.ts` exposed, so that
 * consumers (daemon, agent) which already import from `@comis/skills`
 * continue to resolve. As consumer imports are narrowed to the
 * appropriate subpath, this re-export shim can be dropped (the
 * dead-export gate catches anything we accidentally re-broaden).
 *
 * @module
 */

// ===========================================================================
// `.` subpath canonical exports (skill registry, manifest, prompt, policy,
// bridge, MCP client manager).
// ===========================================================================

// Registry
export { createSkillRegistry } from "./registry/skill-registry/index.js";
export type { SkillRegistry, SkillWatcherHandle } from "./registry/skill-registry/index.js";

// Manifest schema + parser
// SkillManifestSchema lives at `./manifest/schema.ts:137-164` and parseSkillManifest at
// `./manifest/parser.ts:80-95`. Re-exported here so daemon-side consumers
// can read freshly-written SKILL.md content + validate the optional mcpServers block
// WITHOUT reaching into `@comis/skills/src/skills/manifest/...` deep-paths.
export { SkillManifestSchema, type SkillManifestParsed } from "./manifest/schema.js";
export { parseSkillManifest } from "./manifest/parser.js";

// Eligibility
export { createRuntimeEligibilityContext } from "./registry/eligibility.js";

// Bridge
export { assembleToolPipeline } from "./bridge/tool-bridge.js";
export type { PlatformToolProvider } from "./bridge/tool-bridge.js";

// Bridge -- Metadata enforcement
export { wrapWithMetadataEnforcement } from "./bridge/tool-metadata-enforcement.js";

// Bridge -- AgentTool to ToolDefinition adapter
export { agentToolsToToolDefinitions } from "./bridge/tool-definition-adapter.js";

// Bridge -- MCP tool bridge
export {
  mcpToolsToAgentTools,
  extractServerToolFilters,
  jsonSchemaToTypeBox,
  sanitizeMcpToolName,
  classifyMcpErrorType,
} from "./bridge/mcp-tool-bridge.js";

// Prompt processor
export { expandSkillForInvocation } from "./prompt/processor.js";

// Content scanner (security scan before write)
export { scanSkillContent, type ContentScanResult, type ContentScanFinding } from "./prompt/content-scanner.js";

// Integrations -- MCP client manager
export { createMcpClientManager, qualifyToolName, parseQualifiedName } from "./integrations/mcp-client/index.js";
// OAuth login orchestrator + disk token-store factory.
// Consumed by the daemon RPC handler (`mcp-oauth-handlers.ts`) so it can run
// mcp.oauth_login / mcp.oauth_logout without a direct MCP SDK dependency.
export { runOauthLogin, createTokenStore, resolveDiscovery } from "./integrations/mcp-client/index.js";
export type {
  OAuthLoginResult,
  RunOauthLoginDeps,
  OAuthLoginConfig,
  OAuthLoginLogger,
  TokenStore,
  TokenStoreDeps,
} from "./integrations/mcp-client/index.js";
// The connect-time needs_oauth_login signal guard — surfaced
// so the daemon can tell the operator to run `comis mcp login <server>`.
export { isNeedsOAuthLoginError } from "./integrations/mcp-client/index.js";
// The 401 refresh-deduper. Surfaced so the full-cycle integration gate
// (test/integration/mcp-oauth-roundtrip.test.ts) can drive rotation +
// Stripe-Account + 100-concurrent dedup against the mock authorization
// server through the PUBLIC package barrel (not src internals).
export { createRefreshDeduper } from "./integrations/mcp-client/index.js";
export type {
  RefreshDeduper,
  RefreshDeduperDeps,
  RefreshResult,
  DedupedRefreshArgs,
  RefreshFn,
} from "./integrations/mcp-client/index.js";
// The deduped-refresh fetch wrapper (the production 401 path).
// Surfaced so the production-path integration test
// (test/integration/mcp-oauth-deduped-fetch.test.ts) can drive the wiring
// through the public barrel.
export { createDedupedRefreshFetch } from "./integrations/mcp-client/index.js";
export type { DedupedRefreshFetchDeps } from "./integrations/mcp-client/index.js";
// Stdio env-scrub primitives (built-in allowlist constant + pure scrub
// function). Consumed by the daemon RPC handler (`mcp-handlers.ts`) and
// the architecture / integration tests under
// `test/architecture/mcp-prespawn-allowlist.test.ts` + `test/integration/
// mcp-env-scrub.test.ts`.
export { MCP_STDIO_BUILTIN_ENV_ALLOWLIST, scrubStdioEnv } from "./integrations/mcp-client/index.js";

// Pre-spawn OSV malware check + package-name extraction for stdio MCP
// commands. Consumed by `mcp-client-connect.ts` (pre-spawn invocation)
// and the integration test at `test/integration/mcp-osv-check.test.ts`.
export {
  osvMalwareCheck,
  extractMcpPackageName,
  DEFAULT_OSV_CACHE_DIR,
} from "./integrations/mcp-client/index.js";
export type { OsvCheckResult, OsvCheckOptions } from "./integrations/mcp-client/index.js";

// Custom FetchLike with cross-host redirect header scrub for SSE +
// Streamable HTTP MCP transports. Consumed by `mcp-client-discover.ts`
// (transport construction) and the integration test at
// `test/integration/mcp-redirect-scrub.test.ts`.
export { createRedirectPolicyFetch } from "./integrations/mcp-client/index.js";
export type { RedirectPolicyOptions } from "./integrations/mcp-client/index.js";
export type {
  McpClientManager,
  McpClientManagerDeps,
  McpServerConfig,
  McpConnection,
  McpConnectionStatus,
  McpToolDefinition,
  McpToolCallResult,
  McpToolCallContent,
} from "./integrations/mcp-client/index.js";

// Tool policy (profiles and groups for tool filtering)
export { applyToolPolicy, expandGroups, TOOL_PROFILES, TOOL_GROUPS } from "./policy/index.js";
export type { ToolFilterReason, ToolPolicyResult } from "./policy/index.js";

// Procedural-learning sandbox validation (SKILL-06/07, v2.26 WS2). The package `.` entry
// is THIS file (see package.json exports["."] → dist/skills/index.d.ts), so the daemon's
// `import { createSandboxSkillValidationAdapter } from "@comis/skills"` (Plan 07) resolves
// here. (The top-level src/index.ts also re-exports it, but that barrel is NOT the package
// public entry — this is the consumed path.)
export {
  createSandboxSkillValidationAdapter,
  classifyMutating,
  type SandboxSkillValidationAdapterDeps,
} from "../learning/sandbox-skill-validation-adapter.js";

// ===========================================================================
// Transitional `./tools` re-exports (kept for daemon/agent import
// compatibility until consumers retarget to the appropriate subpath).
// ===========================================================================

// Built-in tools (web-search, web-fetch)
export { createWebSearchTool, __clearSearchCache } from "../tools/builtin/web-search-tool/index.js";
export { createWebFetchTool, fetchUrlContent, __clearFetchCache } from "../tools/builtin/web-fetch-tool.js";

// Built-in tools -- Source profiles (per-tool limits and extraction config)
export {
  type ToolSourceProfile,
  DEFAULT_SOURCE_PROFILES,
  resolveSourceProfile,
  resolveAllProfiles,
} from "../tools/builtin/tool-source-profiles.js";

// Built-in tools -- safe-path types: dropped from `.` subpath.
// `LazyPaths` and `resolvePaths` are consumed only by daemon's
// setup-tools.ts which now imports them from `@comis/skills/tools`
// (their canonical subpath).

// Built-in tools -- file state tracking
// `createFileStateTracker` is still consumed via the `.` subpath by
// daemon.ts (sessionTrackerRegistry construction); `isDeviceFile` retained
// for symmetry. `FileStateTracker` type is now imported by daemon via
// `@comis/skills/tools`, so the type re-export below is dead -- dropped
// per the public-export-consumers test.
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
// dead `.` subpath re-export is dropped.
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

// Video generation (FAL queue adapter, factory, rate limiter) — Phase 188 / Plan
// 04 consumes these from the bare @comis/skills barrel exactly like the image
// route (the daemon bundle imports the factory + rate limiter; the deps type
// imports VideoGenRateLimiter).
export { createVideoGenProvider, createVideoGenRateLimiter } from "../tools/integrations/video-gen/index.js";
export type { VideoGenRateLimiter } from "../tools/integrations/video-gen/index.js";

// ===========================================================================
// The 38+ platform-tool factory re-exports that used to live here (the
// `transitional kitchen-sink` block) have been dropped. Daemon now consumes
// the platform-tool surface via the descriptor registry on the
// `./platform-tools` subpath:
//   import { createPlatformToolRegistry } from "@comis/skills/platform-tools"
// All callers should reach for the registry rather than naming individual
// factories. The factory functions themselves remain exported from the
// `./platform-tools` subpath barrel (packages/skills/src/platform-tools/
// index.ts) -- they're consumed there by registry.ts and by per-factory
// tests; daemon never names them directly.
//
// Type RpcCall is re-exported from cron-tool via ./platform-tools/index.ts;
// consumers import the bare type from "@comis/skills/platform-tools" or
// through their own factory signature.
// ===========================================================================
