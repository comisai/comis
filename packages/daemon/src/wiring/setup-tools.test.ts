import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolsDeps } from "./setup-tools.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mock factories -- shared across vi.mock calls
// ---------------------------------------------------------------------------

const mockAssembleToolPipeline = vi.hoisted(() => vi.fn(async () => []));
const mockCreateCronTool = vi.hoisted(() => vi.fn(() => ({ name: "cron" })));
const mockCreateUnifiedMemoryTool = vi.hoisted(() => vi.fn(() => ({ name: "memory_tool" })));
const mockCreateUnifiedSessionTool = vi.hoisted(() => vi.fn(() => ({ name: "session_tool" })));
const mockCreateUnifiedContextTool = vi.hoisted(() => vi.fn(() => ({ name: "context_tool" })));
const mockCreateAgentsListTool = vi.hoisted(() => vi.fn(() => ({ name: "agents_list" })));
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
const mockCreateObsQueryTool = vi.hoisted(() => vi.fn(() => ({ name: "obs_query" })));
const mockCreateSessionsManageTool = vi.hoisted(() => vi.fn(() => ({ name: "sessions_manage" })));
const mockCreateModelsManageTool = vi.hoisted(() => vi.fn(() => ({ name: "models_manage" })));
const mockCreateTokensManageTool = vi.hoisted(() => vi.fn(() => ({ name: "tokens_manage" })));
const mockCreateChannelsManageTool = vi.hoisted(() => vi.fn(() => ({ name: "channels_manage" })));
const mockCreateSkillsManageTool = vi.hoisted(() => vi.fn(() => ({ name: "skills_manage" })));
const mockCreateMcpManageTool = vi.hoisted(() => vi.fn(() => ({ name: "mcp_manage" })));
const mockCreateExecTool = vi.hoisted(() => vi.fn(() => ({ name: "exec" })));
const mockCreateProcessTool = vi.hoisted(() => vi.fn(() => ({ name: "process" })));
const mockCreateApplyPatchTool = vi.hoisted(() => vi.fn(() => ({ name: "apply_patch" })));
const mockCreateHeartbeatManageTool = vi.hoisted(() => vi.fn(() => ({ name: "heartbeat_manage" })));
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
const mockCreateCredentialInjector = vi.hoisted(() => vi.fn(() => ({
  createInjectedFetch: vi.fn(),
  getMappings: vi.fn(() => []),
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

vi.mock("@comis/skills", () => ({
  assembleToolPipeline: mockAssembleToolPipeline,
  createFileStateTracker: mockCreateFileStateTracker,
  createCronTool: mockCreateCronTool,
  createUnifiedMemoryTool: mockCreateUnifiedMemoryTool,
  createUnifiedSessionTool: mockCreateUnifiedSessionTool,
  createUnifiedContextTool: mockCreateUnifiedContextTool,
  createAgentsListTool: mockCreateAgentsListTool,
  createMessageTool: mockCreateMessageTool,
  createDiscordActionTool: mockCreateDiscordActionTool,
  createTelegramActionTool: mockCreateTelegramActionTool,
  createSlackActionTool: mockCreateSlackActionTool,
  createWhatsAppActionTool: mockCreateWhatsAppActionTool,
  createSessionsSendTool: mockCreateSessionsSendTool,
  createSessionsSpawnTool: mockCreateSessionsSpawnTool,
  createSubagentsTool: mockCreateSubagentsTool,
  createPipelineTool: mockCreatePipelineTool,
  createImageTool: mockCreateImageTool,
  createTTSTool: mockCreateTTSTool,
  createTranscribeAudioTool: mockCreateTranscribeAudioTool,
  createDescribeVideoTool: mockCreateDescribeVideoTool,
  createExtractDocumentTool: mockCreateExtractDocumentTool,
  createGatewayTool: mockCreateGatewayTool,
  createBrowserTool: mockCreateBrowserTool,
  createAgentsManageTool: mockCreateAgentsManageTool,
  createObsQueryTool: mockCreateObsQueryTool,
  createSessionsManageTool: mockCreateSessionsManageTool,
  createModelsManageTool: mockCreateModelsManageTool,
  createTokensManageTool: mockCreateTokensManageTool,
  createChannelsManageTool: mockCreateChannelsManageTool,
  createSkillsManageTool: mockCreateSkillsManageTool,
  createMcpManageTool: mockCreateMcpManageTool,
  createExecTool: mockCreateExecTool,
  createProcessTool: mockCreateProcessTool,
  createApplyPatchTool: mockCreateApplyPatchTool,
  createHeartbeatManageTool: mockCreateHeartbeatManageTool,
  createNotifyTool: mockCreateNotifyTool,
  createImageGenerateTool: mockCreateImageGenerateTool,
  createProcessRegistry: mockCreateProcessRegistry,
  createMediaPersistenceService: mockCreateMediaPersistenceService,
  createCredentialInjector: mockCreateCredentialInjector,
  mcpToolsToAgentTools: mockMcpToolsToAgentTools,
  sanitizeImageForApi: mockSanitizeImageForApi,
  sanitizeLogString: mockSanitizeLogString,
  TOOL_PROFILES: {
    minimal: ["exec", "read", "write"],
    coding: ["read", "edit", "write", "grep", "find", "ls", "apply_patch", "exec", "process"],
    messaging: ["message", "session_status"],
    supervisor: ["agents_manage", "obs_query", "sessions_manage", "memory_manage", "channels_manage", "tokens_manage", "models_manage"],
    full: [],
  },
  TOOL_GROUPS: {
    "group:coding": ["read", "edit", "write", "grep", "find", "ls", "apply_patch", "exec", "process"],
    "group:context": ["ctx_search", "ctx_inspect", "ctx_recall"],
    "group:context_expand": ["ctx_expand", "ctx_inspect"],
  },
}));

vi.mock("@comis/core", () => ({
  SkillsConfigSchema: { parse: mockSkillsConfigSchemaParse },
  tryGetContext: mockTryGetContext,
  parseFormattedSessionKey: mockParseFormattedSessionKey,
  sanitizeLogString: mockSanitizeLogString,
  safePath: (...segments: string[]) => segments.join("/"),
}));

vi.mock("@comis/agent", () => ({
  sessionKeyToPath: mockSessionKeyToPath,
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

function createMinimalDeps(overrides: Partial<ToolsDeps> = {}): ToolsDeps {
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
    eventBus: createMockEventBus() as any,
    skillsLogger: createMockLogger() as any,
    linkRunner: {
      processMessage: vi.fn(async (text: string) => ({
        enrichedText: `enriched:${text}`,
        linksProcessed: 0,
        errors: [],
      })),
    } as any,
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

    // Verify base tools are created (28 base tools + apply_patch = 29 without conditional ones)
    expect(mockCreateCronTool).toHaveBeenCalled();
    expect(mockCreateUnifiedMemoryTool).toHaveBeenCalled();
    expect(mockCreateUnifiedSessionTool).toHaveBeenCalled();
    expect(mockCreateAgentsListTool).toHaveBeenCalled();
    expect(mockCreateMessageTool).toHaveBeenCalled();
    expect(mockCreateApplyPatchTool).toHaveBeenCalled();

    // Tools should include all base platform tools
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("cron");
    expect(toolNames).toContain("memory_tool");
    expect(toolNames).toContain("session_tool");
    expect(toolNames).toContain("apply_patch");
    expect(toolNames).toContain("gateway");
    expect(toolNames).toContain("skills_manage");
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
  // 6. MCP tools skipped when manager absent
  // -------------------------------------------------------------------------

  it("skips MCP tools when mcpClientManager is absent", async () => {
    const deps = createMinimalDeps({ mcpClientManager: undefined });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    // Invoke platformTools
    mockAssembleToolPipeline.mock.calls[0][0].platformTools();

    expect(mockMcpToolsToAgentTools).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Credential injection when store has mappings
  // -------------------------------------------------------------------------

  it("creates credential injector when store has mappings", async () => {
    const credentialMappingStore = {
      listAll: vi.fn(() => ({
        ok: true,
        value: [{ id: "cred-1", secretName: "API_KEY", strategy: "header" }],
      })),
    } as any;

    const deps = createMinimalDeps({ credentialMappingStore });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    expect(mockCreateCredentialInjector).toHaveBeenCalledWith(
      expect.objectContaining({
        mappings: [{ id: "cred-1", secretName: "API_KEY", strategy: "header" }],
        agentId: "agent-1",
      }),
    );

    // Verify credentialInjector is passed to assembleToolPipeline
    const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
    expect(pipelineArgs.credentialInjector).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 8. Credential injection skipped when no store
  // -------------------------------------------------------------------------

  it("skips credential injection when store is absent", async () => {
    const deps = createMinimalDeps({ credentialMappingStore: undefined });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    expect(mockCreateCredentialInjector).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9. preprocessMessageText delegates to linkRunner
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
  // 11. system:shutdown cleans up process registries
  // -------------------------------------------------------------------------

  it("cleans up process registries on system:shutdown", async () => {
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
    const { assembleToolsForAgent } = setupTools(deps);

    // Assemble tools to create a process registry
    await assembleToolsForAgent("agent-1");
    // Invoke platformTools to trigger registry creation
    mockAssembleToolPipeline.mock.calls[0][0].platformTools();

    // Make registry.cleanup return a count
    const registryMock = mockCreateProcessRegistry.mock.results[0]?.value;
    if (registryMock) {
      registryMock.cleanup.mockResolvedValue(2);
    }

    // Trigger shutdown
    await eventBus.emit("system:shutdown", { reason: "test", graceful: true });

    // Wait for async handler
    await new Promise(resolve => setTimeout(resolve, 10));

    if (registryMock) {
      expect(registryMock.cleanup).toHaveBeenCalled();
    }
  });

  // -------------------------------------------------------------------------
  // 12. system:shutdown disconnects MCP
  // -------------------------------------------------------------------------

  it("disconnects MCP servers on system:shutdown", async () => {
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
    setupTools(deps);

    // Trigger shutdown
    await eventBus.emit("system:shutdown", { reason: "test", graceful: true });

    // Wait for async handler
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mcpClientManager.disconnectAll).toHaveBeenCalled();
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
  // 16. Credential injection skipped when listAll returns empty
  // -------------------------------------------------------------------------

  it("skips credential injector when credential store has no mappings", async () => {
    const credentialMappingStore = {
      listAll: vi.fn(() => ({
        ok: true,
        value: [],
      })),
    } as any;

    const deps = createMinimalDeps({ credentialMappingStore });
    const setupTools = await getSetupTools();
    const { assembleToolsForAgent } = setupTools(deps);
    await assembleToolsForAgent("agent-1");

    expect(mockCreateCredentialInjector).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 17. Tool group filtering
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
      expect(toolNames).not.toContain("memory_tool");
      expect(toolNames).not.toContain("sessions_spawn");
      expect(toolNames).not.toContain("gateway");
      expect(toolNames).not.toContain("agents_list");
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
      expect(toolNames).toContain("memory_tool");
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
      expect(toolNames).toContain("memory_tool");
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
      expect(toolNames).toContain("memory_tool");
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
      const sandboxArg = mockCreateExecTool.mock.calls[0][4];
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
      const sandboxArg = mockCreateExecTool.mock.calls[0][4];
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
      const sandboxArg = mockCreateExecTool.mock.calls[0][4];
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
      const sandboxArg = mockCreateExecTool.mock.calls[0][4];
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
      const sandboxArg = mockCreateExecTool.mock.calls[0][4];
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
      const sandboxArg = mockCreateExecTool.mock.calls[0][4];
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

      const sandboxArg = mockCreateExecTool.mock.calls[0][4];
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
      const sandboxArg = mockCreateExecTool.mock.calls[0][4];
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
});
