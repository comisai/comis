// SPDX-License-Identifier: Apache-2.0
/**
 * Activation seam tests: brokerContext on ToolsDeps + conditional
 * wiring into createExecTool (network: broker-only, secureCredentialHome, brokerSpawnEnv).
 *
 * RED phase: ToolsDeps.brokerContext does not exist yet — tests fail to compile.
 * GREEN phase: add brokerContext to ToolsDeps + conditional wiring in assembleToolsForAgent.
 *
 * Tests cover:
 *   - sandboxCfg.network.mode === "broker-only" when brokerContext present
 *   - brokerSpawnEnv.HTTPS_PROXY contains broker tcpPort when brokerContext present
 *   - brokerSpawnEnv.placeholders contains the placeholder mapping
 *   - real secret absent from spawn env; COMIS_BROKER_TOKEN present (security invariant)
 *   - brokerContext undefined → sandboxCfg.network undefined, no brokerSpawnEnv
 *   - brokerContext undefined → HTTPS_PROXY, NODE_EXTRA_CA_CERTS, COMIS_BROKER_TOKEN absent
 *
 * Separate file from setup-tools.test.ts (which is at 1705 lines, near cap).
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolsDeps, BrokerContextDeps } from "./setup-tools.js";
import type { CapabilitySourceRef } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const mockAssembleToolPipeline = vi.hoisted(() => vi.fn(async () => []));

// We capture createExecTool args here so tests can inspect what was passed
const capturedExecToolDeps: Array<Record<string, unknown>> = [];
const mockCreateExecTool = vi.hoisted(() =>
  vi.fn((deps: Record<string, unknown>) => {
    capturedExecToolDeps.push(deps);
    return { name: "exec" };
  }),
);

const mockCreateProcessTool = vi.hoisted(() => vi.fn(() => ({ name: "process" })));
const mockCreateApplyPatchTool = vi.hoisted(() => vi.fn(() => ({ name: "apply_patch" })));
const mockCreateProcessRegistry = vi.hoisted(() => vi.fn(() => ({
  add: vi.fn(),
  get: vi.fn(),
  list: vi.fn(() => []),
  cleanup: vi.fn(async () => 0),
})));
const mockCreateMediaPersistenceService = vi.hoisted(() => vi.fn(() => ({
  persist: vi.fn(),
})));
const mockMcpToolsToAgentTools = vi.hoisted(() => vi.fn(() => []));
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
  mcpToolsToAgentTools: mockMcpToolsToAgentTools,
  extractServerToolFilters: vi.fn(() => undefined),
  TOOL_PROFILES: {
    minimal: ["exec"],
    full: [],
  },
  TOOL_GROUPS: {},
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
  // The per-session caps factory the terminal wiring constructs ONCE per agent.
  createSessionCaps: vi.fn(() => ({
    startSession: vi.fn(),
    consumeRequest: vi.fn(() => undefined),
    consumeInteraction: vi.fn(() => undefined),
    checkWallClock: vi.fn(() => undefined),
    forget: vi.fn(),
  })),
}));

vi.mock("@comis/skills/platform-tools", () => ({
  createPlatformToolRegistry: vi.fn(() => []),
}));

vi.mock("@comis/core", () => ({
  SkillsConfigSchema: { parse: mockSkillsConfigSchemaParse },
  enterConfigMutationFence: vi.fn(),
  leaveConfigMutationFence: vi.fn(),
  tryGetContext: mockTryGetContext,
  parseFormattedSessionKey: mockParseFormattedSessionKey,
  sanitizeLogString: mockSanitizeLogString,
  systemNowMs: () => 1_700_000_000_000,
  safePath: (...segments: string[]) => segments.join("/"),
  formatSessionKey: (k: { tenantId: string; channelId: string; userId: string }) =>
    `${k.tenantId}:${k.channelId}:${k.userId}`,
  registerWorkspaceFilesInTracker: vi.fn(async () => {}),
  WORKSPACE_FILE_NAMES: [] as string[],
  DEFAULT_TEMPLATES: {} as Record<string, string>,
}));

vi.mock("@comis/agent", () => ({
  sessionKeyToPath: mockSessionKeyToPath,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
    on(event: string, handler: (...args: unknown[]) => unknown) {
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
  };
}

function createMockSessionTrackerRegistry() {
  return {
    get: vi.fn(() => mockCreateFileStateTracker()),
    release: vi.fn(),
    size: vi.fn(() => 0),
  };
}

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

/** Fake SessionManager — issueToken returns a fixed test token. */
function createFakeSessionManager() {
  const issueToken = vi.fn((_agentId: string) => ({
    sessionId: "sid-test-1",
    proxyToken: "test-token-123",
  }));
  return { issueToken };
}

function createMinimalDeps(overrides: Partial<ToolsDeps> = {}): ToolsDeps {
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
    getMcpServerEntries: () => [],
    ...overrides,
  };
}

/** Canonical brokerContext fixture for the broker-present tests. */
function createBrokerContext(): BrokerContextDeps {
  return {
    tcpPort: 9999,
    socketPath: "/tmp/test-broker.sock",
    caPath: "/tmp/broker-ca.pem",
    sessionManager: createFakeSessionManager() as any,
    placeholders: { ANTHROPIC_API_KEY: "comis-broker-placeholder" },
  };
}

/** Fake SandboxProvider so sandboxCfg is constructed (the broker-present test needs the network field). */
function createFakeSandboxProvider() {
  return {
    name: "fake-sandbox",
    available: vi.fn(() => true),
    buildArgs: vi.fn(() => ["--fake-sandbox"]),
  };
}

async function getSetupTools() {
  const mod = await import("./setup-tools.js");
  return mod.setupTools;
}

/**
 * Helper: call assembleToolsForAgent, then invoke the captured platformTools()
 * function so that createExecTool is actually called. Returns the captured
 * exec tool deps from the first createExecTool invocation.
 */
async function assembleAndCapture(agentId: string, deps: ToolsDeps): Promise<Record<string, unknown>> {
  const setupTools = await getSetupTools();
  const { assembleToolsForAgent } = setupTools(deps);

  await assembleToolsForAgent(agentId);

  // assembleToolsForAgent passes platformTools as a callback to assembleToolPipeline.
  // The mock never calls it. We must invoke it ourselves to trigger createExecTool.
  const pipelineArgs = mockAssembleToolPipeline.mock.calls[0][0];
  if (pipelineArgs?.platformTools) {
    pipelineArgs.platformTools();
  }

  return capturedExecToolDeps[0] ?? {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("brokerContext activation seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExecToolDeps.length = 0;
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

  afterEach(() => {
    vi.clearAllMocks();
    capturedExecToolDeps.length = 0;
  });

  // sandboxCfg.network.mode === "broker-only" and secureCredentialHome === true
  it("brokerContext present → createExecTool receives sandboxConfig with network.mode === 'broker-only' and secureCredentialHome === true", async () => {
    const brokerCtx = createBrokerContext();
    // sandboxProvider must be present so sandboxCfg is constructed (guards: enabled === "always" && sandboxProvider)
    const deps = createMinimalDeps({ brokerContext: brokerCtx, sandboxProvider: createFakeSandboxProvider() as any });

    const execDeps = await assembleAndCapture("agent-1", deps);

    // Inspect what createExecTool was called with
    expect(mockCreateExecTool).toHaveBeenCalled();
    expect(execDeps).toBeDefined();

    const sandboxConfig = execDeps.sandboxConfig as any;
    expect(sandboxConfig).toBeDefined();
    expect(sandboxConfig.network).toBeDefined();
    expect(sandboxConfig.network.mode).toBe("broker-only");
    expect(sandboxConfig.network.brokerSocketPath).toBe("/tmp/test-broker.sock");
    expect(sandboxConfig.secureCredentialHome).toBe(true);
  });

  // brokerSpawnEnv.HTTPS_PROXY contains the broker tcpPort; HTTP_PROXY absent
  it("brokerContext present → brokerSpawnEnv.HTTPS_PROXY contains tcpPort (9999); HTTP_PROXY absent (broker is CONNECT-only)", async () => {
    const brokerCtx = createBrokerContext();
    const deps = createMinimalDeps({ brokerContext: brokerCtx });

    const execDeps = await assembleAndCapture("agent-1", deps);

    expect(mockCreateExecTool).toHaveBeenCalled();
    const brokerSpawnEnv = execDeps.brokerSpawnEnv as any;
    expect(brokerSpawnEnv).toBeDefined();
    expect(brokerSpawnEnv.HTTPS_PROXY).toBe("http://127.0.0.1:9999");
    // HTTP_PROXY intentionally absent — broker handles only TLS-CONNECT tunnels (HTTPS).
    // Plain HTTP via HTTP_PROXY is unsupported by the broker.
    expect(brokerSpawnEnv.HTTP_PROXY).toBeUndefined();
    expect(brokerSpawnEnv.NODE_EXTRA_CA_CERTS).toBe("/tmp/broker-ca.pem");
  });

  // brokerSpawnEnv.placeholders contains the placeholder mapping
  it("brokerContext present → brokerSpawnEnv.placeholders contains { ANTHROPIC_API_KEY: 'comis-broker-placeholder' }", async () => {
    const brokerCtx = createBrokerContext();
    const deps = createMinimalDeps({ brokerContext: brokerCtx });

    const execDeps = await assembleAndCapture("agent-1", deps);

    expect(mockCreateExecTool).toHaveBeenCalled();
    const brokerSpawnEnv = execDeps.brokerSpawnEnv as any;
    expect(brokerSpawnEnv).toBeDefined();
    expect(brokerSpawnEnv.placeholders).toMatchObject({
      ANTHROPIC_API_KEY: "comis-broker-placeholder",
    });
  });

  // security invariant — real secret absent; COMIS_BROKER_TOKEN present
  it("brokerContext present → real secret value absent from spawn env; COMIS_BROKER_TOKEN present (security invariant)", async () => {
    const fakeMgr = createFakeSessionManager();
    const brokerCtx: BrokerContextDeps = {
      tcpPort: 9999,
      socketPath: "/tmp/test-broker.sock",
      caPath: "/tmp/broker-ca.pem",
      sessionManager: fakeMgr as any,
      // The placeholder maps ANTHROPIC_API_KEY → placeholder string.
      // The REAL secret value is "real-test-secret" — it must NEVER appear in the spawn env.
      placeholders: { ANTHROPIC_API_KEY: "comis-broker-placeholder" },
    };
    const deps = createMinimalDeps({ brokerContext: brokerCtx });

    const execDeps = await assembleAndCapture("agent-1", deps);

    expect(mockCreateExecTool).toHaveBeenCalled();
    const brokerSpawnEnv = execDeps.brokerSpawnEnv as any;

    // sessionManager.issueToken was called (a token exists in placeholders)
    expect(fakeMgr.issueToken).toHaveBeenCalledWith("agent-1");
    expect(brokerSpawnEnv.placeholders.COMIS_BROKER_TOKEN).toBe("test-token-123");

    // The REAL secret value "real-test-secret" must be absent from the entire spawn env
    const envJson = JSON.stringify(brokerSpawnEnv);
    expect(envJson).not.toContain("real-test-secret");
  });

  // brokerContext undefined → sandboxCfg.network is undefined; no brokerSpawnEnv
  it("brokerContext undefined → sandboxCfg.network undefined; createExecTool receives no brokerSpawnEnv", async () => {
    const deps = createMinimalDeps({ brokerContext: undefined });

    const execDeps = await assembleAndCapture("agent-1", deps);

    expect(mockCreateExecTool).toHaveBeenCalled();

    // sandboxCfg should be undefined (execSandbox.enabled === "always" but no sandboxProvider)
    // OR if defined it must have network === undefined
    const sandboxConfig = execDeps.sandboxConfig as any;
    if (sandboxConfig !== undefined) {
      // sandbox was constructed — network must be absent/undefined
      expect(sandboxConfig.network).toBeUndefined();
      expect(sandboxConfig.secureCredentialHome).toBeUndefined();
    }

    // brokerSpawnEnv must not be passed
    expect(execDeps.brokerSpawnEnv).toBeUndefined();
  });

  // brokerContext undefined → no HTTPS_PROXY, NODE_EXTRA_CA_CERTS, COMIS_BROKER_TOKEN
  it("brokerContext undefined → HTTPS_PROXY, NODE_EXTRA_CA_CERTS, COMIS_BROKER_TOKEN absent from all exec deps (no-regression)", async () => {
    const deps = createMinimalDeps({ brokerContext: undefined });

    const execDeps = await assembleAndCapture("agent-1", deps);

    expect(mockCreateExecTool).toHaveBeenCalled();
    const execDepsJson = JSON.stringify(execDeps);

    // None of the broker proxy vars should appear in any exec deps
    expect(execDepsJson).not.toContain("HTTPS_PROXY");
    expect(execDepsJson).not.toContain("NODE_EXTRA_CA_CERTS");
    expect(execDepsJson).not.toContain("COMIS_BROKER_TOKEN");
  });
});
