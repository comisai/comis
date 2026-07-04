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
// Web-fetch internals reused by the daemon-side `tool.invoke` executor: the
// DNS-pinned fetch primitive + the fetch-free readability extractor.
// The autonomous `orch:web` path is validateUrl → fetchPinned → extractReadableContent
// (undici, DNS-pinned, NO impit re-resolve), distinct from the in-process web_fetch tool.
export { fetchPinned, createPinnedAgent } from "./integrations/pinned-fetch.js";
export { extractReadableContent, type ExtractMode } from "./builtin/web-fetch-utils.js";
// The MCP result sanitizer (NFKC + invisible-char strip) reused by the
// daemon-side `case "mcp"` tool.invoke executor — a FRESH call site from the
// in-process mcp-tool-bridge, so the sanitize+wrap pair is replicated there.
export { sanitizeMcpToolResult } from "./integrations/mcp-result-sanitizer.js";

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

// Built-in tools -- Sleep: the pacing primitive the model calls to
// defer for the ~5-min prompt-cache TTL instead of polling in a token-burning
// loop. Consumed by the daemon toolset assembly (setup-tools.ts) next to the
// other always-on builtins (createExecTool/createProcessTool).
export { createSleepTool } from "./builtin/sleep-tool.js";

// Built-in tools -- Interactive terminal driver. The nine never-export
// tool factories + the daemon-side registry + the allowlist/IPC types the
// daemon wiring (setup-tools.ts, the composition root) consumes.
export {
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionListTool,
  createTerminalSessionKillTool,
  createTerminalSessionSendTextTool,
  createTerminalSessionSendKeyTool,
  createTerminalSessionWaitTool,
  createTerminalSessionStatusTool,
  createTerminalSessionResizeTool,
  createTerminalSessionRegistry,
  reapNeverTaskedDrives,
  buildProductionSpawnWorker,
  resolveWorkerMainPath,
  terminalWorkerDir,
  resolveTmuxSocketPath,
  createTerminalEgressProxy,
  prepareAgentTerminalWorkspace,
  matchAllowEntry,
  buildDirectSpawn,
  // The per-session caps factory — the daemon constructs ONE shared
  // instance per agent (from the matched entry's limits) feeding both the tool deps
  // (consume*) and the registry onCapForget (caps.forget).
  createSessionCaps,
  // The daemon woken-turn driver consumes the pure drive-state journal
  // (cross-wake memory) + the bounded digest/diff read selector + the content-free screen
  // digest line. The read tool delegates to boundedReadDigest.
  emptyJournal,
  appendAnswered,
  appendStep,
  updateJournal,
  serializeJournal,
  deserializeJournal,
  boundedReadDigest,
  screenDigestLine,
  READ_DIGEST_BYTE_CAP,
  type DriveJournal,
  type DriveReadMode,
  type ReadDigest,
  // The pure durability/endurance siblings the daemon-side wiring consumes — the
  // re-attach DECISION + the durable descriptor (de)serialize + the busy-vs-hung
  // predicate (the liveness backstop + the reaper exclusion) + the spend-ceiling
  // check + the registry's injected descriptor-store port + recover-on-boot seams.
  // Promoted to the top-level barrel here (the daemon is their first
  // `@comis/skills/tools`-level consumer).
  reattachDecision,
  serializeDescriptor,
  deserializeDescriptor,
  buildSessionDescriptor,
  busyOrHung,
  checkSpendCeiling,
  // The daemon-side has-session liveness probe builder: `tmux has-session -t
  // comis-<id>` — the re-attach + backstop probe (exit 0 ⇒ alive).
  buildTmuxHasSessionArgv,
  buildTmuxKillArgv,
  type SessionDescriptor,
  type ReattachDecision,
  type SessionDescriptorStorePort,
  type RecoveredAction,
  type DurableCreateInputs,
  type TerminalDurabilityDeps,
  type BusySignal,
  type BusyVerdict,
  type SpendBreach,
  // The pure user-facing notification kernel — the three-way wake decision + the
  // done/needs-you/failed outcome map, the drive.notify gate (needs-you always
  // fires), and the content-free heartbeat one-liner. The daemon wake-notify
  // wiring is their first `@comis/skills/tools`-level consumer (the
  // public-export-consumers arch gate).
  decideWakeAction,
  mapTerminalOutcome,
  shouldNotifyOutcome,
  heartbeatLine,
  type OutcomeInputs,
  type EscalationReason,
  type NotifyPolicy,
  // The woken-turn driver (daemon-side) consumes the safe-only auto-answer policy
  // + the normalized loop-guard — the auto-answer governance modules.
  decideAutoAnswer,
  createLoopGuard,
  // The woken-turn driver resolves a session's platform profile by allowId to feed
  // decideAutoAnswer the profile's dialogs (the safe-only policy still disposes).
  getPlatformProfile,
  type TerminalPlatformProfile,
  type PlatformDialog,
  type AutoAnswerMode,
  type AutoAnswerDecision,
  type LoopGuard,
  type LoopGuardDeps,
  type TerminalToolDeps,
  type TerminalEventBus,
  // The decoded fd3 push-channel frame the daemon's onTerminalEvent hook
  // re-publishes onto the TypedEventBus (the 3rd emit-hook site).
  type TerminalEventFrame,
  type TerminalEvictedEvent,
  type TerminalSessionRegistry,
  type TerminalSessionRegistryDeps,
  type FakeWorkerChild,
  type AllowEntryLike,
  type AllowMatch,
  type TerminalScope,
  type SessionListing,
  // The origin key scoping a session's visibility — the daemon-wiring
  // drive-scope helper (terminal-drive-scope.ts) returns it from registryOwnerFor
  // (a drive:-scoped wake owner → the stamped registry owner).
  type SessionOwner,
  // The per-session caps surface (the daemon wires caps.forget to onCapForget)
  // + the reaper eviction payload (the daemon's onEvict hook param) + the typed reason.
  type SessionCaps,
  type ReaperEvictInfo,
  type EvictReason,
} from "./builtin/terminal-driver/index.js";
export type { InstallDetourDecision, DetourOverlap } from "./builtin/install-detour.js";
export { parseInstallDetour } from "./builtin/install-detour.js";

// Built-in tools -- In-session expansion loop. The three never-export,
// direct-injection, owner-scoped tool factories (ctx_search / ctx_inspect /
// ctx_expand) + the shared ContextToolDeps the daemon wiring (setup-tools.ts,
// the composition root) constructs. They read the injected core
// ContextStorePort — structurally distinct from the RPC session_search/
// memory_search recall path (no rpcCall / memory.* / @comis/memory).
export {
  createCtxSearchTool,
  createCtxInspectTool,
  createCtxExpandTool,
  type ContextToolDeps,
  type ContextToolLogger,
  // The tier→multi-hop-depth map for the daemon wiring site.
  depthForTier,
  type WalkCapabilityClass,
} from "./builtin/context-tools/index.js";

// Built-in tools -- Exec sandbox types
export type { SandboxProvider, SandboxOptions, ExecSandboxConfig } from "./builtin/sandbox/types.js";

// Built-in tools -- Exec sandbox detection
export { detectSandboxProvider } from "./builtin/sandbox/detect-provider.js";
export type { DetectLogger } from "./builtin/sandbox/detect-provider.js";
// Namespace preflight — the boot probe that PRODUCES `namespacePreflightOk` for
// the degradeAutonomy downshift. Re-exported on the barrel now that the daemon is
// the out-of-package consumer (mirrors detectSandboxProvider).
export { namespacePreflight } from "./builtin/sandbox/detect-provider.js";
export type { NamespacePreflightResult } from "./builtin/sandbox/detect-provider.js";

// Browser -- service
export { createBrowserService } from "./browser/index.js";
export type { BrowserService, ActParams } from "./browser/index.js";

// Integrations -- STT provider factory
export { createSTTProvider, createFallbackTranscription } from "./integrations/stt-factory.js";

// Integrations -- keyless local (in-process) whisper STT adapter + boot probe
export { createLocalWhisperAdapter } from "./integrations/local-stt-adapter.js";
export type { LocalWhisperConfig } from "./integrations/local-stt-adapter.js";
export { detectLocalSttEngine } from "./integrations/local-stt-probe.js";
export type { LocalSttProbeResult, LocalSttProbeDeps } from "./integrations/local-stt-probe.js";

// Integrations -- TTS provider factory
export { createTTSProvider } from "./integrations/tts-factory.js";

// Integrations -- keyless local/Piper (in-process) text-to-audio TTS adapter
export { createLocalTtsAdapter } from "./integrations/local-tts-adapter.js";
export type { LocalTtsConfig } from "./integrations/local-tts-adapter.js";

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

// Video generation (FAL queue adapter, factory, rate limiter) — consumed by the
// daemon wiring (createVideoGenProvider + createVideoGenRateLimiter +
// createFalVideoAdapter), mirroring the image route.
export {
  createVideoGenProvider,
  createVideoGenRateLimiter,
  createFalVideoAdapter,
} from "./integrations/video-gen/index.js";
export type { VideoGenRateLimiter } from "./integrations/video-gen/index.js";

// Orchestrate — the autonomy runner. The runner + its ResultRef store; consumed
// by the daemon wiring (the dormancy activation threads capSocketPath + the store
// into the runner and adds `orchestrate` to the autonomy tool set). The cap-socket runtime shim
// (invoke/wrapResultRef) is NOT surfaced here — the generated comis_tools.js
// imports it by a relative in-jail path, never through this barrel.
export {
  createOrchestrateTool,
  scrubSecretEnv,
  createResultRefStore,
  // The daemon-side executor cores (read/grep/find/ls/jq + web_search) the
  // tool.invoke executor routes to.
  createOrchestrateExecutorCores,
  // The git-worktree lifecycle for `spawn --worktree`, consumed by the daemon's
  // executeSubAgent + boot orphan-sweep (the daemon binds the real
  // execFile-backed GitExec at the composition root).
  createWorktree,
  isWorktreeCleanIfUnchanged,
  cleanIfUnchanged,
  sweepOrphans,
} from "./builtin/orchestrate/index.js";
export type {
  OrchestrateToolDeps,
  OrchestrateResultStore,
  ResultRefStore,
  ResultRefStoreDeps,
  MaterializeContext,
  GcRunContext,
  CleanupRunContext,
  OrchestrateExecutorCores,
  OrchestrateExecutorCoresDeps,
  OrchestrateFileCores,
  OrchestrateFileCore,
  OrchestrateFileCoreContext,
  OrchestrateWebSearchCore,
  // The git-worktree lifecycle types.
  GitExec,
  WorktreeEntry,
  CreateWorktreeOptions,
  CleanIfUnchangedResult,
  SweepSummary,
  SweepDeps,
} from "./builtin/orchestrate/index.js";
