// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/skills - Skill system with manifest parsing, registry with
 * progressive disclosure, tool bridge, and built-in tools.
 *
 * Public API -- all exports have verified external consumers.
 *
 * @module
 */

// Built-in tools (web-search, web-fetch)
export { createWebSearchTool, __clearSearchCache } from "./builtin/web-search-tool.js";
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
export { createExecTool } from "./builtin/exec-tool.js";
export { createProcessTool } from "./builtin/process-tool.js";
export { createProcessRegistry } from "./builtin/process-registry.js";
export type { ProcessRegistry } from "./builtin/process-registry.js";

// Built-in tools -- Exec sandbox types
export type { SandboxProvider, SandboxOptions, ExecSandboxConfig } from "./builtin/sandbox/types.js";

// Built-in tools -- Exec sandbox detection
export { detectSandboxProvider } from "./builtin/sandbox/detect-provider.js";
export type { DetectLogger } from "./builtin/sandbox/detect-provider.js";

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

// Prompt processor
export { expandSkillForInvocation } from "./prompt/processor.js";

// Content scanner (security scan before write)
export { scanSkillContent, type ContentScanResult, type ContentScanFinding } from "./prompt/content-scanner.js";

// Integrations -- STT provider factory
export { createSTTProvider, createFallbackTranscription } from "./integrations/stt-factory.js";

// Integrations -- Media preprocessor
export { preprocessMessage } from "./integrations/media-preprocessor.js";

// Built-in tools -- Platform tool factories
export {
  // Memory tools
  createMemorySearchTool,
  createMemoryGetTool,
  createMemoryStoreTool,
  // Session tools
  createSessionStatusTool,
  createSessionsListTool,
  createSessionsHistoryTool,
  createSessionsSendTool,
  createSessionsSpawnTool,
  createSessionSearchTool,
  // Agent tools
  createSubagentsTool,
  createPipelineTool,
  // Messaging
  createMessageTool,
  // Scheduling
  createCronTool,
  type RpcCall,
  // Platform actions
  createDiscordActionTool,
  createTelegramActionTool,
  createSlackActionTool,
  createWhatsAppActionTool,
  // Media tools
  createImageTool,
  createTTSTool,
  createTranscribeAudioTool,
  createDescribeVideoTool,
  createExtractDocumentTool,
  // Infrastructure
  createGatewayTool,
  createBrowserTool,
  // Heartbeat management
  createHeartbeatManageTool,
  // Notifications
  createNotifyTool,
  // Image generation
  createImageGenerateTool,
  // Context DAG tools
  createCtxSearchTool,
  createCtxInspectTool,
  createCtxRecallTool,
  createCtxExpandTool,
  // Fleet management
  createAgentsManageTool,
  createObsQueryTool,
  createMemoryManageTool,
  createSessionsManageTool,
  createModelsManageTool,
  createTokensManageTool,
  createChannelsManageTool,
  createSkillsManageTool,
  createMcpManageTool,
  // Background tasks
  createBackgroundTasksTool,
  // Unified tools (action dispatch -- consolidates individual tools)
  createUnifiedSessionTool,
  createUnifiedMemoryTool,
  createUnifiedContextTool,
} from "./builtin/platform/index.js";

// Browser -- service
export { createBrowserService } from "./browser/index.js";
export type { BrowserService, ActParams } from "./browser/index.js";

// Integrations -- TTS provider factory
export { createTTSProvider } from "./integrations/tts-factory.js";

// Integrations -- TTS enhancements
export { shouldAutoTts } from "./integrations/tts/tts-auto-mode.js";
export { resolveOutputFormat } from "./integrations/tts/tts-output-format.js";
export { parseTtsDirective } from "./integrations/tts/tts-directive-parser.js";

// Integrations -- Link understanding
export { createLinkRunner } from "./integrations/link/link-runner.js";
export type { LinkRunner } from "./integrations/link/link-runner.js";

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

// Bridge -- MCP tool bridge
export { mcpToolsToAgentTools, jsonSchemaToTypeBox, sanitizeMcpToolName, extractMcpServerName, classifyMcpErrorType } from "./bridge/mcp-tool-bridge.js";

// Integrations -- Vision
export { createVisionProviderRegistry, selectVisionProvider } from "./integrations/vision/vision-provider-registry.js";
export { resolveVisionScope } from "./integrations/vision/scope-resolver.js";

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

// Tool policy (profiles and groups for tool filtering)
export { applyToolPolicy, expandGroups, TOOL_PROFILES, TOOL_GROUPS } from "./policy/index.js";
export type { ToolFilterReason, ToolPolicyResult } from "./policy/index.js";
