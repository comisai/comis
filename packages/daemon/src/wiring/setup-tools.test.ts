// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolsDeps } from "./setup-tools.js";
import type { CapabilitySourceRef } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mock factories -- shared across vi.mock calls
// ---------------------------------------------------------------------------

const mockAssembleToolPipeline = vi.hoisted(() => vi.fn(async () => []));
const mockCreateCronTool = vi.hoisted(() => vi.fn(() => ({ name: "cron" })));
const mockCreateMessageTool = vi.hoisted(() => vi.fn(() => ({ name: "message" })));
const mockCreateDiscordActionTool = vi.hoisted(() => vi.fn(() => ({ name: "discord_action" })));
const mockCreateTelegramActionTool = vi.hoisted(() => vi.fn(() => ({ name: "telegram_action" })));
const mockCreateSlackActionTool = vi.hoisted(() => vi.fn(() => ({ name: "slack_action" })));
const mockCreateWhatsAppActionTool = vi.hoisted(() => vi.fn(() => ({ name: "whatsapp_action" })));
const mockCreateSessionsSendTool = vi.hoisted(() => vi.fn(() => ({ name: "sessions_send" })));
const mockCreateSessionsSpawnTool = vi.hoisted(() => vi.fn(() => ({ name: "sessions_spawn" })));
const mockCreateSubagentsTool = vi.hoisted(() => vi.fn(() => ({ name: "subagents" })));
const mockCreatePipelineTool = vi.hoisted(() => vi.fn(() => ({ name: "pipeline" })));
const mockCreateImageTool = vi.hoisted(() => vi.fn(() => ({ name: "image" })));
const mockCreateTTSTool = vi.hoisted(() => vi.fn(() => ({ name: "tts" })));
const mockCreateTranscribeAudioTool = vi.hoisted(() => vi.fn(() => ({ name: "transcribe_audio" })));
const mockCreateDescribeVideoTool = vi.hoisted(() => vi.fn(() => ({ name: "describe_video" })));
const mockCreateExtractDocumentTool = vi.hoisted(() => vi.fn(() => ({ name: "extract_document" })));
const mockCreateGatewayTool = vi.hoisted(() => vi.fn(() => ({ name: "gateway" })));
const mockCreateBrowserTool = vi.hoisted(() => vi.fn(() => ({ name: "browser" })));
const mockCreateAgentsManageTool = vi.hoisted(() => vi.fn(() => ({ name: "agents_manage" })));
const mockCreateBackgroundTasksTool = vi.hoisted(() => vi.fn(() => ({ name: "background_tasks" })));
const mockCreateObsQueryTool = vi.hoisted(() => vi.fn(() => ({ name: "obs_query" })));
const mockCreateSessionsManageTool = vi.hoisted(() => vi.fn(() => ({ name: "sessions_manage" })));
const mockCreateModelsManageTool = vi.hoisted(() => vi.fn(() => ({ name: "models_manage" })));
const mockCreateTokensManageTool = vi.hoisted(() => vi.fn(() => ({ name: "tokens_manage" })));
const mockCreateChannelsManageTool = vi.hoisted(() => vi.fn(() => ({ name: "channels_manage" })));
const mockCreateSkillsManageTool = vi.hoisted(() => vi.fn(() => ({ name: "skills_manage" })));
const mockCreateMcpManageTool = vi.hoisted(() => vi.fn(() => ({ name: "mcp_manage" })));
const mockCreateMcpLoginTool = vi.hoisted(() => vi.fn(() => ({ name: "mcp_login" })));
const mockCreateExecTool = vi.hoisted(() => vi.fn(() => ({ name: "exec" })));
const mockCreateProcessTool = vi.hoisted(() => vi.fn(() => ({ name: "process" })));
const mockCreateApplyPatchTool = vi.hoisted(() => vi.fn(() => ({ name: "apply_patch" })));
const mockCreateHeartbeatManageTool = vi.hoisted(() => vi.fn(() => ({ name: "heartbeat_manage" })));
const mockCreateProvidersManageTool = vi.hoisted(() => vi.fn(() => ({ name: "providers_manage" })));
const mockCreateNotifyTool = vi.hoisted(() => vi.fn(() => ({ name: "notify_user" })));
const mockCreateImageGenerateTool = vi.hoisted(() => vi.fn(() => ({ name: "image_generate" })));
const mockCreateProcessRegistry = vi.hoisted(() => vi.fn(() => ({
  add: vi.fn(),
  get: vi.fn(),
  list: vi.fn(() => []),
  cleanup: vi.fn(async () => 0),
})));
const mockCreateMediaPersistenceService = vi.hoisted(() => vi.fn(() => ({
  persist: vi.fn(),
})));
const mockMcpToolsToAgentTools = vi.hoisted(() => vi.fn(() => [{ name: "mcp:server/tool" }]));
const mockSanitizeImageForApi = vi.hoisted(() => vi.fn());
const mockCreateFileStateTracker = vi.hoisted(() => vi.fn(() => ({
  recordRead: vi.fn(),
  shouldReturnStub: vi.fn(() => false),
  hasBeenRead: vi.fn(() => false),
  getReadState: vi.fn(() => undefined),
  checkStaleness: vi.fn(() => ({ stale: false })),
  clone: vi.fn(),
})));
const mockSanitizeLogString = vi.hoisted(() => vi.fn((s: string) => s));
const mockTryGetContext = vi.hoisted(() => vi.fn(() => undefined));
const mockParseFormattedSessionKey = vi.hoisted(() => vi.fn(() => undefined));
const mockSessionKeyToPath = vi.hoisted(() => vi.fn((_key: unknown, baseDir: string) => baseDir + "/tenant/channel/user.jsonl"));
const mockSkillsConfigSchemaParse = vi.hoisted(() => vi.fn(() => ({
  builtinTools: { browser: false, exec: false, process: false },
  toolPolicy: { profile: "default" },
  discoveryPaths: [],
  promptSkills: {},
  runtimeEligibility: {},
  watchDebounceMs: 400,
  execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
})));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Daemon imports from THREE @comis/skills subpaths.
// - "." subpath: policy, pipeline, MCP bridge (no longer includes the 38+
//   platform-tool factories -- those live in the registry).
// - "./tools" subpath: exec/process/apply-patch + helpers (media-persistence,
//   image sanitizer, file-state tracker).
// - "./platform-tools" subpath: createPlatformToolRegistry -- the descriptor
//   list daemon iterates.
//
// We mock all three so the unit tests don't load the real factories (which
// would pull in @comis/core symbols we deliberately don't stub).

vi.mock("@comis/skills", () => ({
  assembleToolPipeline: mockAssembleToolPipeline,
  mcpToolsToAgentTools: mockMcpToolsToAgentTools,
  TOOL_PROFILES: {
    minimal: ["exec", "read", "write"],
    coding: ["read", "edit", "write", "grep", "find", "ls", "apply_patch", "exec", "process"],
    messaging: ["message", "session_status"],
    supervisor: ["agents_manage", "obs_query", "sessions_manage", "memory_manage", "channels_manage", "tokens_manage", "models_manage"],
    // COORD-01 (218-01): the lean-coordinator orchestration surface. Mirrors the
    // real entry's shape (orchestration + orch:read drill-in + obs_query, NO
    // exec/edit/write/browser) so the assembly-narrowing test can observe a
    // role:coordinator lead stripped to it. The real profile is unit-tested in
    // packages/skills/src/skills/policy/tool-policy.test.ts.
    coordinator: ["sessions_spawn", "pipeline", "session_status", "cron", "message", "read", "obs_query"],
    full: [],
  },
  TOOL_GROUPS: {
    "group:coding": ["read", "edit", "write", "grep", "find", "ls", "apply_patch", "exec", "process"],
  },
}));

vi.mock("@comis/skills/tools", () => ({
  createExecTool: mockCreateExecTool,
  createProcessTool: mockCreateProcessTool,
  createProcessRegistry: mockCreateProcessRegistry,
  createApplyPatchTool: mockCreateApplyPatchTool,
  createFileStateTracker: mockCreateFileStateTracker,
  sanitizeImageForApi: mockSanitizeImageForApi,
  createMediaPersistenceService: mockCreateMediaPersistenceService,
  // Terminal-driver wiring deps consumed by setup-terminal-tools.ts.
  createTerminalSessionRegistry: vi.fn(() => ({
    create: vi.fn(),
    read: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => []),
    kill: vi.fn(),
    size: vi.fn(() => 0),
    cleanup: vi.fn(),
  })),
  buildProductionSpawnWorker: vi.fn(() => vi.fn()),
  resolveWorkerMainPath: vi.fn(() => "/tmp/terminal-worker-main.js"),
  terminalWorkerDir: (dataDir: string) => `${dataDir}/terminal-worker`,
  resolveTmuxSocketPath: (dir: string) => `${dir}/tmux.sock`,
  createTerminalEgressProxy: vi.fn(() => ({ materialize: vi.fn(async () => ({ socketPath: "/tmp/egress.sock", dispose: vi.fn() })) })),
  detectSandboxProvider: vi.fn(() => ({})),
  createTerminalSessionCreateTool: vi.fn(() => ({ name: "terminal_session_create", execute: vi.fn() })),
  createTerminalSessionReadTool: vi.fn(() => ({ name: "terminal_session_read", execute: vi.fn() })),
  createTerminalSessionListTool: vi.fn(() => ({ name: "terminal_session_list", execute: vi.fn() })),
  createTerminalSessionKillTool: vi.fn(() => ({ name: "terminal_session_kill", execute: vi.fn() })),
  createTerminalSessionSendTextTool: vi.fn(() => ({ name: "terminal_session_send_text", execute: vi.fn() })),
  createTerminalSessionSendKeyTool: vi.fn(() => ({ name: "terminal_session_send_key", execute: vi.fn() })),
  createTerminalSessionWaitTool: vi.fn(() => ({ name: "terminal_session_wait", execute: vi.fn() })),
  createTerminalSessionStatusTool: vi.fn(() => ({ name: "terminal_session_status", execute: vi.fn() })),
  createTerminalSessionResizeTool: vi.fn(() => ({ name: "terminal_session_resize", execute: vi.fn() })),
  // The per-session caps factory the terminal wiring constructs ONCE per
  // agent (buildTerminalSharedDeps). Returns a SessionCaps-shaped no-op double here.
  createSessionCaps: vi.fn(() => ({
    startSession: vi.fn(),
    consumeRequest: vi.fn(() => undefined),
    consumeInteraction: vi.fn(() => undefined),
    checkWallClock: vi.fn(() => undefined),
    forget: vi.fn(),
  })),
  // In-session expansion-loop ctx_* factories (Phase 131, E1/E2). The real
  // wireContextTools (imported relatively from ./setup-context-tools.js — NOT
  // mocked) resolves these from @comis/skills/tools, so the dag-gated wiring
  // pushes named tools the gate test can assert on.
  createCtxSearchTool: vi.fn(() => ({ name: "ctx_search", execute: vi.fn() })),
  createCtxInspectTool: vi.fn(() => ({ name: "ctx_inspect", execute: vi.fn() })),
  createCtxExpandTool: vi.fn(() => ({ name: "ctx_expand", execute: vi.fn() })),
  // DEPTH-02: the tier→multi-hop-depth map consumed by resolveCtxExpandDepth at the
  // ctx_expand wiring site. A pure map (nano1/small2/mid3/frontier4) — the gate test
  // only needs it to return a number; the real mapping is unit-tested in skills.
  depthForTier: vi.fn((c: string) => ({ nano: 1, small: 2, mid: 3, frontier: 4 })[c] ?? 1),
  // Phase 212 Gap 3: the orchestrate runner + its ResultRef store the dormancy
  // activation assembles for an autonomy-bearing agent. Named-tool doubles so the
  // assembly gate test can assert `orchestrate` is present/absent.
  createOrchestrateTool: vi.fn(() => ({ name: "orchestrate", execute: vi.fn() })),
  createResultRefStore: vi.fn(() => ({ materialize: vi.fn(), gcRun: vi.fn(), cleanupRun: vi.fn() })),
}));

// `createPlatformToolRegistry` mock returns descriptors that delegate back
// to the existing hoisted mock factories. Each descriptor's `build(ctx)`
// invokes the corresponding mock so existing `mockCreate*Tool.toHaveBeenCalled`
// expectations still fire when daemon iterates the registry. The 3 truly-
// conditional descriptors (background_tasks, image_generate, browser) carry the
// same `conditional` predicates that the real registry uses -- daemon filters
// on those before invoking `build`.
vi.mock("@comis/skills/platform-tools", () => ({
  createPlatformToolRegistry: vi.fn(() => [
    { name: "agents_manage", category: "agent", build: (ctx: any) => mockCreateAgentsManageTool(ctx.rpcCall, ctx.skillsLogger, ctx.approvalGate, { onMutationStart: ctx.onConfigMutationStart, onMutationEnd: ctx.onConfigMutationEnd, onAgentCreated: ctx.onAgentCreated }) },
    { name: "pipeline", category: "agent", build: (ctx: any) => mockCreatePipelineTool(ctx.rpcCall, ctx.skillsLogger, ctx.approvalGate) },
    { name: "subagents", category: "agent", build: (ctx: any) => mockCreateSubagentsTool(ctx.rpcCall, ctx.skillsLogger) },
    { name: "background_tasks", category: "background", conditional: (ctx: any) => ctx.backgroundTaskManager !== undefined, build: (ctx: any) => mockCreateBackgroundTasksTool({ manager: ctx.backgroundTaskManager, agentId: ctx.agentId }) },
    { name: "browser", category: "browser", conditional: (ctx: any) => ctx.builtinToolsBrowserEnabled === true, build: (ctx: any) => mockCreateBrowserTool({ rpcCall: ctx.rpcCall, sanitizeImage: ctx.browserSanitizeImage, persistMedia: ctx.browserPersistMedia, workspaceDir: ctx.browserWorkspaceDir }) },
    { name: "gateway", category: "gateway", build: (ctx: any) => mockCreateGatewayTool(ctx.rpcCall, ctx.skillsLogger) },
    { name: "obs_query", category: "observability", build: (ctx: any) => mockCreateObsQueryTool(ctx.rpcCall) },
    { name: "heartbeat_manage", category: "heartbeat", build: (ctx: any) => mockCreateHeartbeatManageTool(ctx.rpcCall) },
    { name: "mcp_manage", category: "mcp", build: (ctx: any) => mockCreateMcpManageTool(ctx.rpcCall, ctx.approvalGate) },
    { name: "mcp_login", category: "mcp", build: (ctx: any) => mockCreateMcpLoginTool(ctx.rpcCall) },
    { name: "describe_video", category: "media", build: (ctx: any) => mockCreateDescribeVideoTool(ctx.rpcCall) },
    { name: "extract_document", category: "media", build: (ctx: any) => mockCreateExtractDocumentTool(ctx.rpcCall) },
    { name: "image", category: "media", build: (ctx: any) => mockCreateImageTool(ctx.rpcCall) },
    { name: "image_generate", category: "media", conditional: (ctx: any) => ctx.imageGenProvider !== undefined, build: (ctx: any) => mockCreateImageGenerateTool(ctx.rpcCall) },
    { name: "transcribe_audio", category: "media", build: (ctx: any) => mockCreateTranscribeAudioTool(ctx.rpcCall) },
    { name: "tts", category: "media", build: (ctx: any) => mockCreateTTSTool(ctx.rpcCall) },
    { name: "memory_get", category: "memory", build: (_ctx: any) => ({ name: "memory_get" }) },
    { name: "memory_manage", category: "memory", build: (_ctx: any) => ({ name: "memory_manage" }) },
    { name: "memory_search", category: "memory", build: (_ctx: any) => ({ name: "memory_search" }) },
    { name: "memory_store", category: "memory", build: (_ctx: any) => ({ name: "memory_store" }) },
    { name: "discord_action", category: "messaging", build: (ctx: any) => mockCreateDiscordActionTool(ctx.rpcCall, ctx.skillsLogger) },
    { name: "message", category: "messaging", build: (ctx: any) => mockCreateMessageTool(ctx.rpcCall) },
    { name: "notify", category: "messaging", build: (ctx: any) => mockCreateNotifyTool(ctx.rpcCall) },
    { name: "slack_action", category: "messaging", build: (ctx: any) => mockCreateSlackActionTool(ctx.rpcCall) },
    { name: "telegram_action", category: "messaging", build: (ctx: any) => mockCreateTelegramActionTool(ctx.rpcCall) },
    { name: "whatsapp_action", category: "messaging", build: (ctx: any) => mockCreateWhatsAppActionTool(ctx.rpcCall) },
    { name: "channels_manage", category: "platform-admin", build: (ctx: any) => mockCreateChannelsManageTool(ctx.rpcCall, ctx.approvalGate) },
    { name: "models_manage", category: "platform-admin", build: (ctx: any) => mockCreateModelsManageTool(ctx.rpcCall) },
    { name: "providers_manage", category: "platform-admin", build: (ctx: any) => mockCreateProvidersManageTool(ctx.rpcCall, ctx.approvalGate, { onMutationStart: ctx.onConfigMutationStart, onMutationEnd: ctx.onConfigMutationEnd }) },
    { name: "skills_manage", category: "platform-admin", build: (ctx: any) => mockCreateSkillsManageTool(ctx.rpcCall, ctx.approvalGate) },
    { name: "tokens_manage", category: "platform-admin", build: (ctx: any) => mockCreateTokensManageTool(ctx.rpcCall, ctx.approvalGate) },
    { name: "cron", category: "scheduling", build: (ctx: any) => mockCreateCronTool(ctx.rpcCall) },
    { name: "session_search", category: "session", build: (_ctx: any) => ({ name: "session_search" }) },
    { name: "session_status", category: "session", build: (_ctx: any) => ({ name: "session_status" }) },
    { name: "sessions_history", category: "session", build: (_ctx: any) => ({ name: "sessions_history" }) },
    { name: "sessions_list", category: "session", build: (_ctx: any) => ({ name: "sessions_list" }) },
    { name: "sessions_manage", category: "session", build: (ctx: any) => mockCreateSessionsManageTool(ctx.rpcCall, ctx.approvalGate) },
    { name: "sessions_send", category: "session", build: (ctx: any) => mockCreateSessionsSendTool(ctx.rpcCall) },
    { name: "sessions_spawn", category: "session", build: (ctx: any) => mockCreateSessionsSpawnTool(ctx.rpcCall) },
  ]),
}));

vi.mock("@comis/core", () => ({
  SkillsConfigSchema: { parse: mockSkillsConfigSchemaParse },
  tryGetContext: mockTryGetContext,
  parseFormattedSessionKey: mockParseFormattedSessionKey,
  sanitizeLogString: mockSanitizeLogString,
  // getMcpTools stamps the truncation event timestamp via systemNowMs.
  // Deterministic stub so the emit closure has a numeric clock under test.
  systemNowMs: () => 1_700_000_000_000,
  safePath: (...segments: string[]) => segments.join("/"),
  // Trivial stub for session-lifetime tracker resolution path. Real impl lives
  // in @comis/core/session-key; this test only needs a deterministic string.
  formatSessionKey: (k: { tenantId: string; channelId: string; userId: string }) =>
    `${k.tenantId}:${k.channelId}:${k.userId}`,
  // Workspace helpers live in @comis/core; setup-tools.ts imports them
  // via @comis/core, so tests must mock them on the @comis/core surface.
  // Consumed by setup-tools at assembleToolsForAgent time to pre-register
  // the agent's own workspace files in the per-turn tracker. Tests don't
  // exercise real workspace files, so a no-op stub is sufficient.
  registerWorkspaceFilesInTracker: vi.fn(async () => {}),
  // CAP-03: createAgentRpcCall resolves the agent's held caps via
  // resolveAutonomy(agents[agentId]?.autonomy).capabilities. The mock returns
  // the `standard` floor set (the zero-config default) so the injection test
  // can assert _capabilities carries orch:spawn. The resolver itself is unit-
  // tested against the real schema in schema-agent-autonomy.test.ts.
  //
  // COORD-01 (218-01): the mock honors the input `role` exactly as the real
  // resolver does — `coordinator` expands into `coordinatorToolGroups:
  // ["coordinator"]`, `worker` (the default) omits it. The cap set is
  // role-invariant (narrows-only), so the same caps are returned either way.
  resolveAutonomy: vi.fn((cfg?: { role?: "worker" | "coordinator" }) => {
    const role: "worker" | "coordinator" = cfg?.role ?? "worker";
    return {
      profile: "standard",
      role,
      ...(role === "coordinator" ? { coordinatorToolGroups: ["coordinator"] } : {}),
      enabled: true,
      capabilities: ["orch:spawn", "orch:graph", "orch:cron", "orch:skill", "orch:read", "orch:web", "orch:analyze", "orch:write"],
      resolvedCapabilities: [],
      mode: "accept-reversible",
      aggregateBudgetUsd: 2.0,
      maxConcurrentSelfAgents: 4,
      maxSelfSpawnRatePerMin: 30,
      cronSelfMax: 8,
      message: { channels: ["origin"], maxPerHour: 20 },
    };
  }),
  // PROFILE-05/JAIL-03: buildAutonomyToolWiring degrades the resolved posture via
  // degradeAutonomy(resolved, {namespacePreflightOk}) before gating the orchestrate
  // surface. These tests don't pass namespacePreflightOk (→ defaults to true →
  // preflight OK), so the faithful mock is a no-op pass-through here; it still
  // downshifts to assistant on an explicit false (mirroring the real shipped fn,
  // unit-tested in schema-agent-autonomy.test.ts). The pass-through preserves the
  // full resolved posture (incl. role + coordinatorToolGroups) for the COORD-01 path.
  degradeAutonomy: vi.fn((resolved: { profile?: string }, preflight?: { namespacePreflightOk?: boolean }) =>
    preflight?.namespacePreflightOk === false && resolved?.profile !== "assistant"
      ? { resolved: { ...resolved, profile: "assistant", enabled: false, capabilities: [] }, downshift: { downshiftedFrom: resolved?.profile, downshiftedTo: "assistant", reason: "namespace_preflight_failed" } }
      : { resolved },
  ),
  // Consumed by the agents_manage onAgentCreated callback for seed-tracker
  // registration of newly-created agents. Not exercised by these tests but
  // imported at module load, so they must exist on the mock.
  WORKSPACE_FILE_NAMES: [] as string[],
  DEFAULT_TEMPLATES: {} as Record<string, string>,
}));

vi.mock("@comis/agent", () => ({
  sessionKeyToPath: mockSessionKeyToPath,
  // DEPTH-02: the ctx_expand wiring resolves a tier-gated multi-hop depth via
  // resolveModelProfile(...).capabilityClass (through resolveCtxExpandDepth). The
  // mock returns a minimal profile so the dag-gated wiring path runs; the depth
  // value itself is asserted in setup-context-tools.test.ts against the real resolver.
  resolveModelProfile: () => ({ capabilityClass: "small" }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal event bus mock with on/emit for tool:executed and system:shutdown. */
function createMockEventBus() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();

  return {
    on(event: string, handler: (...args: any[]) => any) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return this;
    },
    off: vi.fn(),
    once: vi.fn(),
    emit(event: string, data: unknown) {
      const list = handlers.get(event) ?? [];
      for (const h of list) h(data);
      return true;
    },
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    _handlers: handlers,
  };
}

/**
 * Mock session tracker registry -- a fresh tracker per get(), never reused.
 * Tests in this file do not exercise the session-persistence path (no tests
 * call assembleToolsForAgent with a sessionKey), so this mock never allocates.
 */
function createMockSessionTrackerRegistry() {
  return {
    get: vi.fn(() => mockCreateFileStateTracker()),
    release: vi.fn(),
    size: vi.fn(() => 0),
  };
}

/**
 * Default mock MCP manager that reports zero tools and no-ops on shutdown.
 * Used by `createMinimalDeps` so tests that don't exercise MCP wiring still
 * satisfy the now-required `ToolsDeps.mcpClientManager` type.
 */
function createDefaultMockMcpClientManager() {
  return {
    getTools: vi.fn(() => []),
    callTool: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(async () => {}),
    getConnection: vi.fn(),
    getAllConnections: vi.fn(() => []),
    reconnect: vi.fn(),
  };
}

function createMinimalDeps(overrides: Partial<ToolsDeps> = {}): ToolsDeps {
  // Per-agent ToolCapabilityPort resolver stub.
  // Hoisted ABOVE the return so every call to deps.getCapabilityPortForAgent
  // returns the SAME port instance, mirroring production wiring (which
  // resolves through a Map<agentId, port>). assembleToolsForAgent calls
  // deps.getCapabilityPortForAgent twice (once for exec, once for process)
  // per invocation; a fresh object per call would mask reference-equality
  // regressions and would also block
  // `expect(deps.getCapabilityPortForAgent).toHaveReturnedWith(portStub)`.
  //
  // getPackageAliasMap is `ReadonlyMap<string, CapabilitySourceRef>` per
  // the ToolCapabilityPort contract -- using `Map<string, string>` here
  // would silently pass through the outer `as any` cast and bury a
  // value-shape mismatch (consumers reading `ref.type === "mcp"` would
  // observe `undefined`).
  const portStub = {
    isCapabilityIndexEnabled: () => true,
    getInstallDetourMode: () => "advise" as const,
    getBuiltinCluster: () => undefined,
    getClusterConfig: () => undefined,
    getMcpServerHint: () => undefined,
    getSkillHint: () => undefined,
    getPackageAliasMap: () => new Map<string, CapabilitySourceRef>(),
    getConnectedMcpServers: () => [],
    getPromptSkillCapabilities: () => [],
  };
  return {
    rpcCall: vi.fn(async () => ({})),
    agents: {
      "agent-1": {
        skills: {
          builtinTools: { browser: false, exec: false, process: false },
          toolPolicy: { profile: "default" },
          discoveryPaths: [],
          promptSkills: {},
          runtimeEligibility: {},
          watchDebounceMs: 400,
          execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
        },
      } as any,
    },
    defaultAgentId: "agent-1",
    workspaceDirs: new Map([["agent-1", "/workspace/agent-1"]]),
    defaultWorkspaceDir: "/workspace/default",
    dataDir: "/test/data",
    secretManager: { get: vi.fn(), has: vi.fn() } as any,
    platformSecretNames: new Set<string>(),
    eventBus: createMockEventBus() as any,
    skillsLogger: createMockLogger() as any,
    linkRunner: {
      processMessage: vi.fn(async (text: string) => ({
        enrichedText: `enriched:${text}`,
        linksProcessed: 0,
        errors: [],
      })),
    } as any,
    mcpClientManager: createDefaultMockMcpClientManager() as any,
    sessionTrackerRegistry: createMockSessionTrackerRegistry() as any,
    getCapabilityPortForAgent: vi.fn(() => portStub) as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default returns
    mockSkillsConfigSchemaParse.mockReturnValue({
      builtinTools: { browser: false, exec: false, process: false },
      toolPolicy: { profile: "default" },
      discoveryPaths: [],
      promptSkills: {},
      runtimeEligibility: {},
      watchDebounceMs: 400,
      execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
    });
  });

  async function getSetupTools() {
    const mod = await import("./setup-tools.js");
    return mod.setupTools;
  }

  // -------------------------------------------------------------------------
  // 1. Returns assembleToolsForAgent and preprocessMessageText
  // -------------------------------------------------------------------------

  it("returns assembleToolsForAgent and preprocessMessageText functions", async () => {
    const deps = createMinimalDeps();
    const setupTools = await getSetupTools();

    const result = setupTools(deps);

    expect(typeof result.assembleToolsForAgent).toBe("function");
    expect(typeof result.preprocessMessageText).toBe("function");
  });

  // -------------------------------------------------------------------------
  // 2. assembleToolsForAgent creates base tools
  // -------------------------------------------------------------------------

  it("calls assembleToolPipeline with platformTools function returning base tool set", async () => {
    const deps = createMinimalDeps();
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);

    await assembleToolsForAgent("agent-1");

    expect(mockAssembleToolPipeline).toHaveBeenCalledOnce();

    // Extract and invoke the platformTools function passed to assembleToolPipeline
    const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
    expect(pipelineArgs.platformTools).toBeDefined();

    const tools = pipelineArgs.platformTools();

    // Verify base tools are created (26 base tools + apply_patch = 27 without conditional ones)
    expect(mockCreateCronTool).toHaveBeenCalled();
    expect(mockCreateMessageTool).toHaveBeenCalled();
    expect(mockCreateApplyPatchTool).toHaveBeenCalled();

    // Tools should include all base platform tools
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("cron");
    expect(toolNames).toContain("apply_patch");
    expect(toolNames).toContain("gateway");
    expect(toolNames).toContain("skills_manage");
    expect(toolNames).toContain("providers_manage");
  });

  // -------------------------------------------------------------------------
  // 2b. FileStateTracker auto-creation and threading
  // -------------------------------------------------------------------------

  it("creates a FileStateTracker and passes it to assembleToolPipeline", async () => {
    const deps = createMinimalDeps();
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    expect(mockAssembleToolPipeline).toHaveBeenCalledOnce();
    const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
    expect(pipelineArgs.fileStateTracker).toBeDefined();
    // Verify it's a real FileStateTracker (has recordRead method)
    expect(typeof pipelineArgs.fileStateTracker.recordRead).toBe("function");
  });

  // -------------------------------------------------------------------------
  // 3. Browser tool conditional inclusion
  // -------------------------------------------------------------------------

  it("includes browser tool when builtinTools.browser is true", async () => {
    const deps = createMinimalDeps({
      agents: {
        "agent-1": {
          skills: {
            builtinTools: { browser: true, exec: false, process: false },
            toolPolicy: { profile: "default" },
            discoveryPaths: [],
            execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
          },
        } as any,
      },
    });

    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);

    await assembleToolsForAgent("agent-1");

    const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("browser");
    expect(mockCreateBrowserTool).toHaveBeenCalled();
  });

  it("excludes browser tool when builtinTools.browser is false", async () => {
    const deps = createMinimalDeps();
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);

    await assembleToolsForAgent("agent-1");

    const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("browser");
  });

  // -------------------------------------------------------------------------
  // 3c. COORD-01 (218-01): autonomy.role: coordinator narrows the lead's tool
  // surface to the coordinator TOOL_PROFILE via resolveAutonomy().coordinatorToolGroups.
  // assembleToolsForAgent selects effectiveGroups = coordinatorToolGroups when
  // role:coordinator AND no explicit tool_groups; an explicit tool_groups (or
  // "full") still wins (operator intent, T-218-04).
  // -------------------------------------------------------------------------

  it("narrows a role:coordinator lead (no explicit tool_groups) to the coordinator orchestration surface, excluding heavy-work tools", async () => {
    const deps = createMinimalDeps({
      agents: {
        "agent-1": {
          autonomy: { role: "coordinator" },
          skills: {
            builtinTools: { browser: true, exec: true, process: true },
            toolPolicy: { profile: "default" },
            discoveryPaths: [],
            execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
          },
        } as any,
      },
    });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);

    await assembleToolsForAgent("agent-1");

    const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
    const toolNames = tools.map((t: any) => t.name);
    // Orchestration + drill-in survive the narrowing.
    expect(toolNames).toContain("sessions_spawn");
    expect(toolNames).toContain("pipeline");
    expect(toolNames).toContain("message");
    expect(toolNames).toContain("obs_query");
    // Heavy-work tools are stripped even though builtinTools enabled them —
    // the coordinator profile has nowhere for inline heavy work to run (COORD-02).
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("browser");
    expect(toolNames).not.toContain("gateway");
  });

  it("does NOT narrow a default role:worker lead (byte-identical to today — heavy-work tools remain)", async () => {
    const deps = createMinimalDeps({
      agents: {
        "agent-1": {
          // No autonomy.role → resolves to worker; no narrowing.
          skills: {
            builtinTools: { browser: true, exec: true, process: true },
            toolPolicy: { profile: "default" },
            discoveryPaths: [],
            execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
          },
        } as any,
      },
    });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);

    await assembleToolsForAgent("agent-1");

    const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
    const toolNames = tools.map((t: any) => t.name);
    // No narrowing — the full platform surface is present (incl. heavy-work).
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("browser");
    expect(toolNames).toContain("gateway");
  });

  it("an explicit tool_groups wins over the coordinator role default (operator intent — T-218-04)", async () => {
    const deps = createMinimalDeps({
      agents: {
        "agent-1": {
          autonomy: { role: "coordinator" },
          skills: {
            builtinTools: { browser: false, exec: true, process: false },
            toolPolicy: { profile: "default" },
            discoveryPaths: [],
            execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
          },
        } as any,
      },
    });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);

    // The operator explicitly requested the coding surface — it must win over
    // the coordinator role narrowing (no surprise override of explicit intent).
    await assembleToolsForAgent("agent-1", { toolGroups: ["coding"] });

    const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
    const toolNames = tools.map((t: any) => t.name);
    // coding includes exec — the explicit group wins, so exec survives.
    expect(toolNames).toContain("exec");
    // sessions_spawn is NOT in the coding profile — the coordinator default did
    // not apply, proving the explicit tool_groups took precedence.
    expect(toolNames).not.toContain("sessions_spawn");
  });

  // -------------------------------------------------------------------------
  // 4. Exec/process tool conditional inclusion
  // -------------------------------------------------------------------------

  it("includes exec tool when builtinTools.exec is true", async () => {
    const deps = createMinimalDeps({
      agents: {
        "agent-1": {
          skills: {
            builtinTools: { browser: false, exec: true, process: false },
            toolPolicy: { profile: "default" },
            discoveryPaths: [],
            execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
          },
        } as any,
      },
    });

    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("exec");
    expect(mockCreateExecTool).toHaveBeenCalled();
  });

  it("excludes exec tool from platformTools when builtinTools.exec is false", async () => {
    const deps = createMinimalDeps();
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    // Invoke platformTools to trigger lazy tool creation
    const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
    // exec is always instantiated now, but ceiling filter removes it from output
    expect(mockCreateExecTool).toHaveBeenCalled();
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("exec");
  });

  it("includes process tool when builtinTools.process is true", async () => {
    const deps = createMinimalDeps({
      agents: {
        "agent-1": {
          skills: {
            builtinTools: { browser: false, exec: false, process: true },
            toolPolicy: { profile: "default" },
            discoveryPaths: [],
            execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
          },
        } as any,
      },
    });

    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("process");
    expect(mockCreateProcessTool).toHaveBeenCalled();
  });

  it("excludes process tool from platformTools when builtinTools.process is false", async () => {
    const deps = createMinimalDeps();
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    // Invoke platformTools to trigger lazy tool creation
    const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
    // process is always instantiated now, but ceiling filter removes it from output
    expect(mockCreateProcessTool).toHaveBeenCalled();
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("process");
  });

  // -------------------------------------------------------------------------
  // 5. MCP tools included when manager present
  // -------------------------------------------------------------------------

  it("includes MCP tools when mcpClientManager is present", async () => {
    const mcpClientManager = {
      getTools: vi.fn(() => [{ name: "mcp-tool-1", inputSchema: {} }]),
      callTool: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      disconnectAll: vi.fn(),
      getConnection: vi.fn(),
      getAllConnections: vi.fn(),
    };

    const deps = createMinimalDeps({ mcpClientManager: mcpClientManager as any });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("mcp:server/tool");
    expect(mockMcpToolsToAgentTools).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. MCP tools skipped when manager reports zero tools
  // -------------------------------------------------------------------------

  it("skips MCP tool wrapping when manager reports zero tools", async () => {
    // Manager always defined now (setupMcp guarantees). The short-circuit lives
    // inside getMcpTools: if getTools() is empty, skip the mcpToolsToAgentTools
    // wrapper entirely. The default mock from createMinimalDeps already returns
    // an empty tool list, so we just exercise the default path.
    const deps = createMinimalDeps();
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    // Invoke platformTools
    mockAssembleToolPipeline.mock.calls[0][0].platformTools();

    expect(mockMcpToolsToAgentTools).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6b. getMcpTools wires an onResultTruncated closure that emits the
  //     typed mcp:server:result_truncated event with a timestamp.
  // -------------------------------------------------------------------------

  it("getMcpTools passes an onResultTruncated closure that emits mcp:server:result_truncated with timestamp", async () => {
    const mcpClientManager = {
      getTools: vi.fn(() => [{ name: "mcp-tool-1", inputSchema: {} }]),
      callTool: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      disconnectAll: vi.fn(),
      getConnection: vi.fn(),
      getAllConnections: vi.fn(),
    };
    const eventBus = createMockEventBus();
    const emitSpy = vi.spyOn(eventBus, "emit");

    const deps = createMinimalDeps({
      mcpClientManager: mcpClientManager as any,
      eventBus: eventBus as any,
    });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    // Drive getMcpTools (invoked lazily inside platformTools()).
    mockAssembleToolPipeline.mock.calls[0][0].platformTools();

    expect(mockMcpToolsToAgentTools).toHaveBeenCalled();
    // The onResultTruncated closure is the 7th positional arg (index 6),
    // appended after the serverFiltersFn closure (index 5).
    const call = mockMcpToolsToAgentTools.mock.calls.at(-1)!;
    const onResultTruncated = call[6] as
      | ((e: {
          server: string;
          tool: string;
          originalSize: number;
          truncatedSize: number;
          traceId: string;
        }) => void)
      | undefined;
    expect(typeof onResultTruncated).toBe("function");

    onResultTruncated!({
      server: "db-server",
      tool: "search",
      originalSize: 60_000,
      truncatedSize: 50_000,
      traceId: "trace-xyz",
    });

    expect(emitSpy).toHaveBeenCalledWith(
      "mcp:server:result_truncated",
      expect.objectContaining({
        server: "db-server",
        tool: "search",
        originalSize: 60_000,
        truncatedSize: 50_000,
        traceId: "trace-xyz",
        timestamp: expect.any(Number),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 7. preprocessMessageText delegates to linkRunner
  // -------------------------------------------------------------------------

  it("preprocessMessageText delegates to linkRunner.processMessage", async () => {
    const deps = createMinimalDeps();
    const setupTools = await getSetupTools();
    const { preprocessMessageText } = setupTools(deps);

    const result = await preprocessMessageText("hello world");

    expect(deps.linkRunner.processMessage).toHaveBeenCalledWith("hello world");
    expect(result).toBe("enriched:hello world");
  });

  it("preprocessMessageText logs when links are processed", async () => {
    const linkRunner = {
      processMessage: vi.fn(async () => ({
        enrichedText: "enriched text with links",
        linksProcessed: 2,
        errors: [],
      })),
    } as any;

    const deps = createMinimalDeps({ linkRunner });
    const setupTools = await getSetupTools();
    const { preprocessMessageText } = setupTools(deps);

    await preprocessMessageText("text with urls");

    expect(deps.skillsLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ linksProcessed: 2, errors: 0 }),
      "Link understanding processed",
    );
  });

  // -------------------------------------------------------------------------
  // 10. tool:executed event logging
  // -------------------------------------------------------------------------

  it("logs tool:executed events via skillsLogger", async () => {
    const eventBus = createMockEventBus();
    const deps = createMinimalDeps({ eventBus: eventBus as any });
    const setupTools = await getSetupTools();
    setupTools(deps);

    // Emit a tool:executed event
    eventBus.emit("tool:executed", {
      toolName: "memory_search",
      durationMs: 42.567,
      success: true,
      timestamp: Date.now(),
      userId: "user-1",
      agentId: "agent-1",
      sessionKey: "discord:chan:user:tenant",
      params: { query: "test" },
    });

    expect(deps.skillsLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "memory_search",
        durationMs: 43,  // Math.round(42.567)
        success: true,
        userId: "user-1",
        agentId: "agent-1",
      }),
      expect.stringContaining("Tool audit: memory_search succeeded"),
    );
  });

  // -------------------------------------------------------------------------
  // 11. shutdownBackgroundProcesses drains per-agent process registries
  //
  // setupTools used to subscribe to eventBus.on("system:shutdown", ...)
  // for cleanup; that subscriber silently no-op'd in production because no
  // production code emits the event. ToolsResult.shutdownBackgroundProcesses
  // now exposes the same cleanup as a directly-invoked function called
  // from setupShutdown.
  // -------------------------------------------------------------------------

  it("shutdownBackgroundProcesses drains per-agent process registries when invoked", async () => {
    const eventBus = createMockEventBus();
    const deps = createMinimalDeps({
      eventBus: eventBus as any,
      agents: {
        "agent-1": {
          skills: {
            builtinTools: { browser: false, exec: true, process: false },
            toolPolicy: { profile: "default" },
            discoveryPaths: [],
            execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
          },
        } as any,
      },
    });

    const setupTools = await getSetupTools();
    const { assembleToolsForAgent, shutdownBackgroundProcesses } = setupTools(deps);

    // Assemble tools to create a process registry
    await assembleToolsForAgent("agent-1");
    // Invoke platformTools to trigger registry creation
    mockAssembleToolPipeline.mock.calls[0][0].platformTools();

    // Make registry.cleanup return a count
    const registryMock = mockCreateProcessRegistry.mock.results[0]?.value;
    if (registryMock) {
      registryMock.cleanup.mockResolvedValue(2);
    }

    // Trigger the cleanup directly (replaces the deleted event-bus subscriber).
    await shutdownBackgroundProcesses();

    if (registryMock) {
      expect(registryMock.cleanup).toHaveBeenCalled();
    }
  });

  // -------------------------------------------------------------------------
  // 12. MCP servers disconnect at composition root, not via event bus
  //
  // The old eventBus.on("system:shutdown", ...) subscriber bundled
  // mcpClientManager.disconnectAll into the same closure as the per-agent
  // process-registry drain. That single closure is now split into two
  // ShutdownDeps fields: setupTools.shutdownBackgroundProcesses (drain
  // registries) and the composition root binding mcpClientManagerDisconnectAll
  // directly off the mcpClientManager handle (daemon.ts wires
  // mcpClientManager.disconnectAll.bind into ShutdownDeps).
  //
  // setupTools NO LONGER calls disconnectAll itself; the responsibility
  // moved to daemon.ts. This test asserts the boundary: setupTools does
  // NOT invoke mcpClientManager.disconnectAll at any point during its own
  // lifecycle (including the new shutdownBackgroundProcesses path).
  // -------------------------------------------------------------------------

  it("setupTools does not invoke mcpClientManager.disconnectAll itself (boundary owned by daemon.ts composition root)", async () => {
    const eventBus = createMockEventBus();
    const mcpClientManager = {
      getTools: vi.fn(() => []),
      callTool: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      disconnectAll: vi.fn(async () => {}),
      getConnection: vi.fn(),
      getAllConnections: vi.fn(),
    };

    const deps = createMinimalDeps({
      eventBus: eventBus as any,
      mcpClientManager: mcpClientManager as any,
    });

    const setupTools = await getSetupTools();
    const { shutdownBackgroundProcesses } = setupTools(deps);
    await shutdownBackgroundProcesses();

    // The composition root (daemon.ts) — not setupTools — is responsible
    // for binding mcpClientManager.disconnectAll into ShutdownDeps.
    expect(mcpClientManager.disconnectAll).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 13. Agent-scoped rpcCall injects _agentId
  // -------------------------------------------------------------------------

  it("injects _agentId into rpcCall params for agent-scoped tools", async () => {
    const rpcCall = vi.fn(async () => ({}));
    const deps = createMinimalDeps({ rpcCall: rpcCall as any });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);

    await assembleToolsForAgent("agent-1");

    // Tool factories are invoked lazily inside platformTools closure.
    // We need to invoke platformTools to trigger the factory calls.
    const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
    pipelineArgs.platformTools();

    // Now get the rpcCall passed to createCronTool
    const agentRpc = mockCreateCronTool.mock.calls[0][0];
    expect(agentRpc).toBeDefined();

    // Call the agentRpc and verify _agentId is injected
    await agentRpc("cron.add", { schedule: "* * * * *" });

    expect(rpcCall).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({
        _agentId: "agent-1",
        schedule: "* * * * *",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 13b. Agent-scoped rpcCall injects _capabilities (CAP-03)
  //
  // createAgentRpcCall resolves the agent's held capability set via
  // resolveAutonomy(agents[agentId]?.autonomy).capabilities and injects it as
  // the internal _capabilities field alongside _agentId. A zero-config agent
  // resolves to `standard`, whose floor set includes orch:spawn — so the gated
  // orchestration handlers downstream see the caps the agent legitimately holds.
  // (RED on pre-patch: createAgentRpcCall does not inject _capabilities yet.)
  // -------------------------------------------------------------------------

  it("injects _capabilities (resolved from the agent autonomy config) into rpcCall params", async () => {
    const rpcCall = vi.fn(async () => ({}));
    const deps = createMinimalDeps({ rpcCall: rpcCall as any });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);

    await assembleToolsForAgent("agent-1");

    const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
    pipelineArgs.platformTools();

    const agentRpc = mockCreateCronTool.mock.calls[0][0];
    await agentRpc("session.spawn", { task: "do a thing" });

    const [, forwarded] = rpcCall.mock.calls.at(-1)!;
    expect(Array.isArray((forwarded as Record<string, unknown>)._capabilities)).toBe(true);
    // The standard (zero-config) floor set includes the orchestration caps the
    // gated handlers require — orch:spawn proves the held set reaches the gate.
    expect((forwarded as Record<string, unknown>)._capabilities).toContain("orch:spawn");
    expect((forwarded as Record<string, unknown>)._capabilities).toContain("orch:graph");
    expect((forwarded as Record<string, unknown>)._capabilities).toContain("orch:cron");
  });

  // -------------------------------------------------------------------------
  // 14. Falls back to SkillsConfigSchema.parse({}) for missing skills config
  // -------------------------------------------------------------------------

  it("uses SkillsConfigSchema.parse({}) when agent has no skills config", async () => {
    const deps = createMinimalDeps({
      agents: {
        "agent-1": {} as any,
      },
    });

    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    expect(mockSkillsConfigSchemaParse).toHaveBeenCalledWith({});
  });

  // -------------------------------------------------------------------------
  // 15. assembleToolsForAgent with includePlatformTools: false (options object)
  // -------------------------------------------------------------------------

  it("passes undefined platformTools when includePlatformTools is false", async () => {
    const deps = createMinimalDeps();
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);

    await assembleToolsForAgent("agent-1", { includePlatformTools: false });

    const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
    expect(pipelineArgs.platformTools).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 16. Tool group filtering
  // -------------------------------------------------------------------------

  describe("tool group filtering", () => {
    it("options object with includePlatformTools: false excludes platform tools", async () => {
      const deps = createMinimalDeps();
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1", { includePlatformTools: false });

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      expect(pipelineArgs.platformTools).toBeUndefined();
    });

    it("coding toolGroups respects builtinTools ceiling -- excludes exec/process when disabled", async () => {
      const deps = createMinimalDeps(); // default: exec: false, process: false
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1", { includePlatformTools: true, toolGroups: ["coding"] });

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      const tools = pipelineArgs.platformTools();
      const toolNames = tools.map((t: any) => t.name);

      // builtinTools ceiling: exec and process excluded despite coding profile
      expect(toolNames).not.toContain("exec");
      expect(toolNames).not.toContain("process");
      // Other coding profile tools still present
      expect(toolNames).toContain("apply_patch");
    });

    it("coding toolGroups includes exec/process when builtinTools enables them", async () => {
      const deps = createMinimalDeps({
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: true, process: true },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1", { toolGroups: ["coding"] });

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      const tools = pipelineArgs.platformTools();
      const toolNames = tools.map((t: any) => t.name);

      expect(toolNames).toContain("exec");
      expect(toolNames).toContain("process");
      expect(toolNames).toContain("apply_patch");
    });

    it("logs builtinTools ceiling filter at DEBUG level with all disabled tools", async () => {
      const deps = createMinimalDeps(); // default: exec: false, process: false, browser: false
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");

      // Invoke platformTools to trigger ceiling filter
      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      pipelineArgs.platformTools();

      expect(deps.skillsLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-1",
          builtinTools: expect.objectContaining({
            exec: false,
            process: false,
            browser: false,
          }),
          toolCountBeforeCeiling: expect.any(Number),
        }),
        "builtinTools ceiling filter applied",
      );
    });

    it("logs builtinTools ceiling filter reflecting enabled tools", async () => {
      const deps = createMinimalDeps({
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: true, process: true },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      pipelineArgs.platformTools();

      expect(deps.skillsLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-1",
          builtinTools: expect.objectContaining({
            exec: true,
            process: true,
            browser: false,
          }),
          toolCountBeforeCeiling: expect.any(Number),
        }),
        "builtinTools ceiling filter applied",
      );
    });

    it("coding toolGroups filters out non-coding platform tools", async () => {
      const deps = createMinimalDeps();
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1", { toolGroups: ["coding"] });

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      const tools = pipelineArgs.platformTools();
      const toolNames = tools.map((t: any) => t.name);

      // Non-coding tools should be filtered out
      expect(toolNames).not.toContain("cron");
      expect(toolNames).not.toContain("memory_get");
      expect(toolNames).not.toContain("sessions_spawn");
      expect(toolNames).not.toContain("gateway");
    });

    it("no options defaults to all platform tools", async () => {
      const deps = createMinimalDeps();
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1");

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      expect(pipelineArgs.platformTools).toBeDefined();

      const tools = pipelineArgs.platformTools();
      const toolNames = tools.map((t: any) => t.name);

      // Should include all base platform tools
      expect(toolNames).toContain("cron");
      expect(toolNames).toContain("memory_get");
      expect(toolNames).toContain("gateway");
      expect(toolNames).toContain("sessions_spawn");
    });

    it("full toolGroups bypasses profile filtering", async () => {
      const deps = createMinimalDeps();
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1", { toolGroups: ["full"] });

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      expect(pipelineArgs.platformTools).toBeDefined();

      const tools = pipelineArgs.platformTools();
      const toolNames = tools.map((t: any) => t.name);

      // full profile should return ALL base tools (same as no toolGroups)
      expect(toolNames).toContain("cron");
      expect(toolNames).toContain("memory_get");
      expect(toolNames).toContain("gateway");
      expect(toolNames).toContain("sessions_spawn");
    });

    it("MCP tools survive toolGroups filtering", async () => {
      const mcpClientManager = {
        getTools: vi.fn(() => [{ name: "mcp-tool-1", inputSchema: {} }]),
        callTool: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        disconnectAll: vi.fn(),
        getConnection: vi.fn(),
        getAllConnections: vi.fn(),
      };

      const deps = createMinimalDeps({ mcpClientManager: mcpClientManager as any });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1", { toolGroups: ["coding"] });

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      const tools = pipelineArgs.platformTools();
      const toolNames = tools.map((t: any) => t.name);

      // MCP tool should survive even with coding profile filtering
      expect(toolNames).toContain("mcp:server/tool");
      // Non-coding tools should still be filtered out
      expect(toolNames).not.toContain("cron");
    });

    it("MCP tools excluded when includeMcpTools is false", async () => {
      const mcpClientManager = {
        getTools: vi.fn(() => [{ name: "mcp-tool-1", inputSchema: {} }]),
        callTool: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        disconnectAll: vi.fn(),
        getConnection: vi.fn(),
        getAllConnections: vi.fn(),
      };

      const deps = createMinimalDeps({ mcpClientManager: mcpClientManager as any });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1", { includeMcpTools: false });

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      const tools = pipelineArgs.platformTools();
      const toolNames = tools.map((t: any) => t.name);

      // MCP tools should NOT be present
      expect(toolNames).not.toContain("mcp:server/tool");
      // Base tools should still be present
      expect(toolNames).toContain("cron");
    });

    it("empty toolGroups array defaults to all platform tools", async () => {
      const deps = createMinimalDeps();
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1", { toolGroups: [] });

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      // Empty toolGroups = no filtering (same as no toolGroups)
      expect(pipelineArgs.platformTools).toBeDefined();

      const tools = pipelineArgs.platformTools();
      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain("cron");
      expect(toolNames).toContain("memory_get");
    });
  });

  // -------------------------------------------------------------------------
  // 18. Sandbox wiring
  // -------------------------------------------------------------------------

  describe("sandbox wiring", () => {
    function createMockSandboxProvider() {
      return {
        name: "mock-sandbox",
        available: vi.fn(() => true),
        buildArgs: vi.fn(() => ["--sandbox"]),
        wrapEnv: vi.fn((env: Record<string, string>) => env),
      };
    }

    it("passes sandboxCfg to createExecTool when sandbox enabled and provider available", async () => {
      const deps = createMinimalDeps({
        sandboxProvider: createMockSandboxProvider() as any,
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: true, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");

      mockAssembleToolPipeline.mock.calls[0][0].platformTools();

      expect(mockCreateExecTool).toHaveBeenCalledOnce();
      const sandboxArg = mockCreateExecTool.mock.calls[0][0].sandboxConfig;
      expect(sandboxArg).toBeDefined();
      expect(sandboxArg.sandbox.name).toBe("mock-sandbox");
      // Default agent gets lazy sharedPaths; resolve to verify empty (only one agent, skips self)
      const resolvedShared = typeof sandboxArg.sharedPaths === "function" ? sandboxArg.sharedPaths() : sandboxArg.sharedPaths;
      expect(resolvedShared).toEqual([]);
      expect(sandboxArg.readOnlyPaths).toEqual(["/workspace/agent-1/skills", "/test/data/logs"]);
      expect(sandboxArg.configReadOnlyPaths).toEqual(["/test/data/logs"]);
    });

    it("passes sandboxCfg to exec tool when coding toolGroup used with builtinTools.exec true", async () => {
      const deps = createMinimalDeps({
        sandboxProvider: createMockSandboxProvider() as any,
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: true, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1", { toolGroups: ["coding"] });

      mockAssembleToolPipeline.mock.calls[0][0].platformTools();

      expect(mockCreateExecTool).toHaveBeenCalledOnce();
      const sandboxArg = mockCreateExecTool.mock.calls[0][0].sandboxConfig;
      expect(sandboxArg).toBeDefined();
      expect(sandboxArg.sandbox.name).toBe("mock-sandbox");
    });

    it("does not pass sandboxCfg when sandbox enabled is never", async () => {
      const deps = createMinimalDeps({
        sandboxProvider: createMockSandboxProvider() as any,
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: true, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "never", readOnlyAllowPaths: [] },
            },
          } as any,
        },
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");

      mockAssembleToolPipeline.mock.calls[0][0].platformTools();

      expect(mockCreateExecTool).toHaveBeenCalledOnce();
      const sandboxArg = mockCreateExecTool.mock.calls[0][0].sandboxConfig;
      expect(sandboxArg).toBeUndefined();
    });

    it("does not pass sandboxCfg when no sandbox provider available", async () => {
      const deps = createMinimalDeps({
        sandboxProvider: undefined,
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: true, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");

      mockAssembleToolPipeline.mock.calls[0][0].platformTools();

      expect(mockCreateExecTool).toHaveBeenCalledOnce();
      const sandboxArg = mockCreateExecTool.mock.calls[0][0].sandboxConfig;
      expect(sandboxArg).toBeUndefined();
    });

    it("logs WARN when sandbox enabled but no provider", async () => {
      const deps = createMinimalDeps({
        sandboxProvider: undefined,
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: true, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");

      mockAssembleToolPipeline.mock.calls[0][0].platformTools();

      expect(deps.skillsLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-1",
          hint: expect.stringContaining("no provider"),
          errorKind: "config",
        }),
        "Exec tool running without OS sandbox",
      );
    });

    it("threads sharedPaths to ExecSandboxConfig", async () => {
      const deps = createMinimalDeps({
        sandboxProvider: createMockSandboxProvider() as any,
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: true, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1", { sharedPaths: ["/shared/graph-runs"] });

      mockAssembleToolPipeline.mock.calls[0][0].platformTools();

      expect(mockCreateExecTool).toHaveBeenCalledOnce();
      const sandboxArg = mockCreateExecTool.mock.calls[0][0].sandboxConfig;
      expect(sandboxArg).toBeDefined();
      // Default agent gets lazy sharedPaths; resolve to verify
      const resolvedShared = typeof sandboxArg.sharedPaths === "function" ? sandboxArg.sharedPaths() : sandboxArg.sharedPaths;
      expect(resolvedShared).toEqual(["/shared/graph-runs"]);
    });

    it("threads readOnlyPaths from discoveryPaths to ExecSandboxConfig", async () => {
      const deps = createMinimalDeps({
        sandboxProvider: createMockSandboxProvider() as any,
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: true, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: ["/abs/skills"],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");

      mockAssembleToolPipeline.mock.calls[0][0].platformTools();

      expect(mockCreateExecTool).toHaveBeenCalledOnce();
      const sandboxArg = mockCreateExecTool.mock.calls[0][0].sandboxConfig;
      expect(sandboxArg).toBeDefined();
      expect(sandboxArg.readOnlyPaths).toEqual(["/workspace/agent-1/skills", "/abs/skills", "/test/data/logs"]);
    });

    it("enriches sharedPaths in ExecSandboxConfig for default agent", async () => {
      const deps = createMinimalDeps({
        sandboxProvider: createMockSandboxProvider() as any,
        defaultAgentId: "admin-agent",
        agents: {
          "admin-agent": {
            skills: {
              builtinTools: { browser: false, exec: true, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
          "worker-agent": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "coding" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
        workspaceDirs: new Map([
          ["admin-agent", "/workspace/admin-agent"],
          ["worker-agent", "/workspace/worker-agent"],
        ]),
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("admin-agent");

      mockAssembleToolPipeline.mock.calls[0][0].platformTools();

      const sandboxArg = mockCreateExecTool.mock.calls[0][0].sandboxConfig;
      expect(sandboxArg).toBeDefined();
      // Admin agents get lazy sharedPaths -- resolve to verify contents
      const resolvedShared = typeof sandboxArg.sharedPaths === "function" ? sandboxArg.sharedPaths() : sandboxArg.sharedPaths;
      expect(resolvedShared).toContain("/workspace/worker-agent");
      expect(resolvedShared).not.toContain("/workspace/admin-agent");
    });

    it("threads configReadOnlyPaths from execSandbox.readOnlyAllowPaths", async () => {
      const deps = createMinimalDeps({
        sandboxProvider: createMockSandboxProvider() as any,
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: true, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: ["/data/models"] },
            },
          } as any,
        },
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");

      mockAssembleToolPipeline.mock.calls[0][0].platformTools();

      expect(mockCreateExecTool).toHaveBeenCalledOnce();
      const sandboxArg = mockCreateExecTool.mock.calls[0][0].sandboxConfig;
      expect(sandboxArg).toBeDefined();
      expect(sandboxArg.configReadOnlyPaths).toEqual(["/data/models", "/test/data/logs"]);
    });
  });

  // -------------------------------------------------------------------------
  // 19. Admin cross-workspace sharedPaths (Quick 165)
  // -------------------------------------------------------------------------

  describe("admin cross-workspace sharedPaths", () => {
    it("enriches sharedPaths with other agent workspace dirs for default agent", async () => {
      const deps = createMinimalDeps({
        defaultAgentId: "admin-agent",
        agents: {
          "admin-agent": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
          "worker-agent": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "coding" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
        workspaceDirs: new Map([
          ["admin-agent", "/workspace/admin-agent"],
          ["worker-agent", "/workspace/worker-agent"],
        ]),
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("admin-agent");

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      // Admin agents get a lazy callback -- resolve it to verify contents
      const resolved = typeof pipelineArgs.sharedPaths === "function" ? pipelineArgs.sharedPaths() : pipelineArgs.sharedPaths;
      expect(resolved).toContain("/workspace/worker-agent");
      expect(resolved).not.toContain("/workspace/admin-agent");
    });

    it("enriches sharedPaths with other agent workspace dirs for supervisor-profile agents", async () => {
      const deps = createMinimalDeps({
        defaultAgentId: "other-default",
        agents: {
          "supervisor-agent": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "supervisor" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
          "worker-agent": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "coding" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
          "other-default": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
        workspaceDirs: new Map([
          ["supervisor-agent", "/workspace/supervisor-agent"],
          ["worker-agent", "/workspace/worker-agent"],
          ["other-default", "/workspace/other-default"],
        ]),
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("supervisor-agent");

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      // Supervisor agents get a lazy callback -- resolve it to verify contents
      const resolved = typeof pipelineArgs.sharedPaths === "function" ? pipelineArgs.sharedPaths() : pipelineArgs.sharedPaths;
      expect(resolved).toContain("/workspace/worker-agent");
      expect(resolved).toContain("/workspace/other-default");
      expect(resolved).not.toContain("/workspace/supervisor-agent");
    });

    it("does not enrich sharedPaths for non-admin agents", async () => {
      const deps = createMinimalDeps({
        defaultAgentId: "admin-agent",
        agents: {
          "admin-agent": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "full" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
          "worker-agent": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "coding" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
        workspaceDirs: new Map([
          ["admin-agent", "/workspace/admin-agent"],
          ["worker-agent", "/workspace/worker-agent"],
        ]),
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("worker-agent");

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      expect(pipelineArgs.sharedPaths).not.toContain("/workspace/admin-agent");
      expect(pipelineArgs.sharedPaths).toEqual([]);
    });

    it("merges caller sharedPaths with admin workspace enrichment", async () => {
      const deps = createMinimalDeps({
        defaultAgentId: "admin-agent",
        agents: {
          "admin-agent": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
          "worker-agent": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "coding" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
          } as any,
        },
        workspaceDirs: new Map([
          ["admin-agent", "/workspace/admin-agent"],
          ["worker-agent", "/workspace/worker-agent"],
        ]),
      });

      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("admin-agent", { sharedPaths: ["/shared/graph-runs"] });

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      // Admin agents get a lazy callback -- resolve it to verify contents
      const resolved = typeof pipelineArgs.sharedPaths === "function" ? pipelineArgs.sharedPaths() : pipelineArgs.sharedPaths;
      expect(resolved).toContain("/shared/graph-runs");
      expect(resolved).toContain("/workspace/worker-agent");
      expect(resolved).not.toContain("/workspace/admin-agent");
    });
  });

  // -------------------------------------------------------------------------
  // 20. Image generation tool conditional registration
  // -------------------------------------------------------------------------

  describe("image generation tool", () => {
    it("includes image_generate tool when imageGenProvider is provided", async () => {
      const mockProvider = {
        id: "fal",
        isAvailable: () => true,
        execute: vi.fn(),
      };
      const deps = createMinimalDeps({ imageGenProvider: mockProvider as any });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1");

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      const tools = pipelineArgs.platformTools();
      const toolNames = tools.map((t: any) => t.name);

      expect(toolNames).toContain("image_generate");
      expect(mockCreateImageGenerateTool).toHaveBeenCalled();
    });

    it("excludes image_generate tool when imageGenProvider is undefined", async () => {
      const deps = createMinimalDeps({ imageGenProvider: undefined });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1");

      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      const tools = pipelineArgs.platformTools();
      const toolNames = tools.map((t: any) => t.name);

      expect(toolNames).not.toContain("image_generate");
      expect(mockCreateImageGenerateTool).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 21. Session-lifetime tracker resolution via sessionTrackerRegistry
  //     (options.sessionKey must reach the registry, not fall through to the
  //      ephemeral createFileStateTracker branch.)
  // -------------------------------------------------------------------------

  describe("session-lifetime tracker resolution", () => {
    it("resolves tracker via sessionTrackerRegistry.get when options.sessionKey is provided", async () => {
      // Use a stable tracker identity to prove registry.get was consulted.
      const stableTracker = {
        recordRead: vi.fn(),
        shouldReturnStub: vi.fn(() => false),
        hasBeenRead: vi.fn(() => false),
        getReadState: vi.fn(() => undefined),
        checkStaleness: vi.fn(() => ({ stale: false })),
        clone: vi.fn(),
      };
      const registry = {
        get: vi.fn(() => stableTracker),
        release: vi.fn(),
        size: vi.fn(() => 0),
      };
      const deps = createMinimalDeps({ sessionTrackerRegistry: registry as any });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      const sessionKey = { tenantId: "t", userId: "u", channelId: "c" };
      await assembleToolsForAgent("agent-1", { sessionKey: sessionKey as any });

      // Registry was consulted with the formatted session key.
      expect(registry.get).toHaveBeenCalledTimes(1);
      // The formatted key format is "tenant:channel:user" per formatSessionKey.
      // We assert the call happened with a string arg, not the exact format
      // (the format helper is a separate unit's concern).
      expect(typeof registry.get.mock.calls[0][0]).toBe("string");

      // The resolved tracker was threaded to assembleToolPipeline.
      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      expect(pipelineArgs.fileStateTracker).toBe(stableTracker);
    });

    it("falls back to ephemeral createFileStateTracker when options.sessionKey is absent", async () => {
      const registry = {
        get: vi.fn(),
        release: vi.fn(),
        size: vi.fn(() => 0),
      };
      const deps = createMinimalDeps({ sessionTrackerRegistry: registry as any });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1"); // no options

      expect(registry.get).not.toHaveBeenCalled();
      expect(mockCreateFileStateTracker).toHaveBeenCalled();
      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      expect(pipelineArgs.fileStateTracker).toBeDefined();
    });

    it("explicit options.fileStateTracker wins over options.sessionKey (subagent spawn path)", async () => {
      const explicitTracker = {
        recordRead: vi.fn(),
        shouldReturnStub: vi.fn(() => false),
        hasBeenRead: vi.fn(() => false),
        getReadState: vi.fn(() => undefined),
        checkStaleness: vi.fn(() => ({ stale: false })),
        clone: vi.fn(),
      };
      const registry = {
        get: vi.fn(() => ({ should: "not_be_used" })),
        release: vi.fn(),
        size: vi.fn(() => 0),
      };
      const deps = createMinimalDeps({ sessionTrackerRegistry: registry as any });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1", {
        sessionKey: { tenantId: "t", userId: "u", channelId: "c" } as any,
        fileStateTracker: explicitTracker as any,
      });

      // Registry must NOT be consulted when explicit tracker is provided -- this
      // preserves the subagent contract: subagents get their own fresh tracker.
      expect(registry.get).not.toHaveBeenCalled();
      const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
      expect(pipelineArgs.fileStateTracker).toBe(explicitTracker);
    });
  });

  // -------------------------------------------------------------------------
  // 131-05: dag-gated ctx_* in-session expansion-loop wiring (E1/E2)
  // -------------------------------------------------------------------------

  describe("ctx_* in-session expansion tools (dag-gated wiring)", () => {
    const CTX_NAMES = ["ctx_search", "ctx_inspect", "ctx_expand"];

    /** A no-op ContextStorePort double (only the wiring identity matters here). */
    function makeFakeLcdStore() {
      return {
        searchLcd: vi.fn(() => ({ hits: [], cjkZeroHit: false, lane: "word" as const, matchErrored: false })),
        getSummaries: vi.fn(() => []),
        getSummaryChildren: vi.fn(() => []),
        getSummaryMessages: vi.fn(() => []),
        getMessages: vi.fn(() => []),
      } as any;
    }

    /** Build a deps object with the agent pinned to a given contextEngine version. */
    function depsWithVersion(version: "dag" | "pipeline", lcdStore?: unknown) {
      return createMinimalDeps({
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
            contextEngine: { version, maxExpandTokens: 4_000 },
          } as any,
        },
        ...(lcdStore !== undefined ? { lcdStore: lcdStore as any } : {}),
      });
    }

    it("wires ctx_search/ctx_inspect/ctx_expand when contextEngine version is dag and a store is present", async () => {
      const deps = depsWithVersion("dag", makeFakeLcdStore());
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1");

      const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
      const toolNames = tools.map((t: any) => t.name);
      for (const name of CTX_NAMES) {
        expect(toolNames).toContain(name);
      }
    });

    it("does NOT wire the ctx_* tools in pipeline mode (even with a store present)", async () => {
      const deps = depsWithVersion("pipeline", makeFakeLcdStore());
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1");

      const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
      const toolNames = tools.map((t: any) => t.name);
      for (const name of CTX_NAMES) {
        expect(toolNames).not.toContain(name);
      }
    });

    it("does NOT wire the ctx_* tools in dag mode when no lcdStore is injected", async () => {
      const deps = depsWithVersion("dag"); // no lcdStore on ToolsDeps
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1");

      const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
      const toolNames = tools.map((t: any) => t.name);
      for (const name of CTX_NAMES) {
        expect(toolNames).not.toContain(name);
      }
    });

    // WR-05 (Phase 174-04): a BARE agent config (no explicit contextEngine.version) writes
    // the LCD store by default (shouldRunLcdStorePasses defaults missing version → "dag"), so
    // the ctx_* recovery tools MUST be wired under the SAME default — otherwise the agent
    // writes durable history it can never read back in-session. Aligns the ctx-tool gate
    // default to "dag" to match the store-writes default. Fails on the pre-patch
    // `?? "pipeline"` default (tools not wired for a bare config).
    it("WR-05: wires the ctx_* tools for a BARE agent config (no contextEngine.version) when a store is present", async () => {
      const deps = createMinimalDeps({
        agents: {
          "agent-1": {
            skills: {
              builtinTools: { browser: false, exec: false, process: false },
              toolPolicy: { profile: "default" },
              discoveryPaths: [],
              execSandbox: { enabled: "always", readOnlyAllowPaths: [] },
            },
            // NO contextEngine block — the bare-config default story.
          } as any,
        },
        lcdStore: makeFakeLcdStore() as any,
      });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);

      await assembleToolsForAgent("agent-1");

      const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
      const toolNames = tools.map((t: any) => t.name);
      for (const name of CTX_NAMES) {
        expect(toolNames).toContain(name);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 19. Phase 212 Gap 3 — orchestrate tool assembly + capMint (dormancy activation)
  // -------------------------------------------------------------------------

  describe("orchestrate tool assembly + cap lease mint (Phase 212 Gap 3)", () => {
    function mockSandbox() {
      return { name: "mock-sandbox", available: vi.fn(() => true), buildArgs: vi.fn(() => ["--sandbox"]), wrapEnv: vi.fn((e: Record<string, string>) => e) };
    }
    function mockCapHandle() {
      return {
        leaseManager: { mintLease: vi.fn(() => ({ bearer: "lease-bearer-xyz", leaseId: "leaseid-1" })), validate: vi.fn(), renew: vi.fn(), revoke: vi.fn() },
        endpoint: { handleCapCall: vi.fn(), startSocket: vi.fn(), stopSocket: vi.fn() },
        capSocketPath: "/test/data/cap.sock",
        outputGuard: { scan: vi.fn(), registerSecret: vi.fn() },
        // Phase 213: buildAutonomyToolWiring anchors the tree root here after the mint.
        boundedAutonomy: { registerRoot: vi.fn() },
      } as any;
    }
    const autonomyAgent = {
      "agent-1": {
        autonomy: { profile: "standard" },
        skills: { builtinTools: { browser: false, exec: true, process: false }, toolPolicy: { profile: "default" }, discoveryPaths: [], execSandbox: { enabled: "always", readOnlyAllowPaths: [] } },
      } as any,
    };

    it("assembles the orchestrate tool for an autonomy-bearing agent when the cap handle + sandbox are present", async () => {
      const deps = createMinimalDeps({ sandboxProvider: mockSandbox() as any, capEndpointHandle: mockCapHandle(), agents: autonomyAgent });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");
      const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
      expect(tools.map((t: any) => t.name)).toContain("orchestrate");
    });

    it("does NOT assemble the orchestrate tool when no cap handle was constructed (non-autonomy daemon)", async () => {
      const deps = createMinimalDeps({ sandboxProvider: mockSandbox() as any, capEndpointHandle: undefined, agents: autonomyAgent });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");
      const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
      expect(tools.map((t: any) => t.name)).not.toContain("orchestrate");
    });

    it("does NOT assemble the orchestrate tool when no sandbox provider is available (jail unbuildable)", async () => {
      const deps = createMinimalDeps({ sandboxProvider: undefined, capEndpointHandle: mockCapHandle(), agents: autonomyAgent });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");
      const tools = mockAssembleToolPipeline.mock.calls[0][0].platformTools();
      expect(tools.map((t: any) => t.name)).not.toContain("orchestrate");
    });

    it("threads the cap socket + the minted brokerSpawnEnv into the orchestrate tool", async () => {
      const { createOrchestrateTool } = await import("@comis/skills/tools");
      (createOrchestrateTool as unknown as ReturnType<typeof vi.fn>).mockClear();
      const deps = createMinimalDeps({ sandboxProvider: mockSandbox() as any, capEndpointHandle: mockCapHandle(), agents: autonomyAgent });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");
      mockAssembleToolPipeline.mock.calls[0][0].platformTools();
      const orchArgs = (createOrchestrateTool as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(orchArgs.capSocketPath).toBe("/test/data/cap.sock");
      // The minted lease env rides brokerSpawnEnv.placeholders (COMIS_CAP_LEASE/COMIS_ORCH_SOCKET).
      expect(orchArgs.brokerSpawnEnv?.placeholders?.COMIS_CAP_LEASE).toBe("lease-bearer-xyz");
      expect(orchArgs.brokerSpawnEnv?.placeholders?.COMIS_ORCH_SOCKET).toBe("/test/data/cap.sock");
    });

    it("mints the lease + registers the bearer in OutputGuard for an autonomy agent (capMint threaded to buildBrokerSpawnEnv)", async () => {
      const handle = mockCapHandle();
      const deps = createMinimalDeps({ sandboxProvider: mockSandbox() as any, capEndpointHandle: handle, agents: autonomyAgent });
      const setupTools = await getSetupTools();
      const { assembleToolsForAgent } = setupTools(deps);
      await assembleToolsForAgent("agent-1");
      mockAssembleToolPipeline.mock.calls[0][0].platformTools();
      // buildBrokerSpawnEnv(deps.brokerContext, agentId, capMint) ran the mint → the
      // bearer was minted + registered (Pitfall 1: never logged).
      expect(handle.leaseManager.mintLease).toHaveBeenCalledTimes(1);
      expect(handle.outputGuard.registerSecret).toHaveBeenCalledWith("lease-bearer-xyz");
    });
  });

});
