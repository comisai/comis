// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyRpcError } from "./rpc-dispatch.js";

// ---------------------------------------------------------------------------
// Mock all 16 handler factory imports so createRpcDispatch can be tested
// without constructing the full 50+ field RpcDispatchDeps object.
// ---------------------------------------------------------------------------

vi.mock("./cron-handlers.js", () => ({
  createCronHandlers: vi.fn(() => ({
    "cron.add": vi.fn(async () => ({ jobId: "j1" })),
    "cron.list": vi.fn(async () => ({ jobs: [] })),
    "cron.update": vi.fn(async () => ({ updated: true })),
    "cron.remove": vi.fn(async () => ({ removed: true })),
    "cron.status": vi.fn(async () => ({ running: true })),
    "cron.runs": vi.fn(async () => ({ runs: [] })),
    "cron.run": vi.fn(async () => ({ triggered: true })),
    "scheduler.wake": vi.fn(async () => ({ woke: true })),
  })),
}));

vi.mock("./memory-handlers.js", () => ({
  createMemoryHandlers: vi.fn(() => ({
    "memory.store": vi.fn(async () => ({ stored: true })),
    "memory.search": vi.fn(async () => ({ results: [] })),
    "memory.stats": vi.fn(async () => ({ totalEntries: 0 })),
    "memory.browse": vi.fn(async () => ({ entries: [] })),
    "memory.delete": vi.fn(async () => ({ deleted: 0 })),
    "memory.flush": vi.fn(async () => ({ flushed: true })),
    "memory.export": vi.fn(async () => ({ entries: [] })),
  })),
}));

vi.mock("./session-handlers.js", () => ({
  createSessionHandlers: vi.fn(() => ({
    "session.list": vi.fn(async () => ({ sessions: [] })),
    "session.get": vi.fn(async () => ({ session: null })),
    "session.delete": vi.fn(async () => ({ deleted: true })),
    "session.send_cross": vi.fn(async () => ({ sent: true })),
  })),
}));

vi.mock("./message-handlers.js", () => ({
  createMessageHandlers: vi.fn(() => ({
    "message.send": vi.fn(async () => ({ sent: true })),
  })),
}));

vi.mock("./media-handlers.js", () => ({
  createMediaHandlers: vi.fn(() => ({
    "image.analyze": vi.fn(async () => ({ description: "img" })),
    "tts.synthesize": vi.fn(async () => ({ filePath: "/tmp/tts.mp3" })),
    "tts.auto_check": vi.fn(async () => ({ shouldSynthesize: false })),
    "link.process": vi.fn(async () => ({ enrichedText: "" })),
    "media.transcribe": vi.fn(async () => ({ text: "" })),
    "media.describe_video": vi.fn(async () => ({ description: "" })),
    "media.extract_document": vi.fn(async () => ({ text: "" })),
  })),
}));

vi.mock("./config-handlers.js", () => ({
  createConfigHandlers: vi.fn(() => ({
    "config.get": vi.fn(async () => ({})),
    "config.set": vi.fn(async () => ({ updated: true })),
    "config.reload": vi.fn(async () => ({ reloaded: true })),
  })),
}));

vi.mock("./browser-handlers.js", () => ({
  createBrowserHandlers: vi.fn(() => ({
    "browser.navigate": vi.fn(async () => ({ url: "https://example.com" })),
    "browser.snapshot": vi.fn(async () => ({ content: "" })),
    "browser.act": vi.fn(async () => ({ success: true })),
  })),
}));

vi.mock("./subagent-handlers.js", () => ({
  createSubagentHandlers: vi.fn(() => ({
    "subagent.run": vi.fn(async () => ({ result: "" })),
  })),
}));

vi.mock("./approval-handlers.js", () => ({
  createApprovalHandlers: vi.fn(() => ({
    "approval.list": vi.fn(async () => ({ approvals: [] })),
  })),
}));

vi.mock("./agent-handlers.js", () => ({
  createAgentHandlers: vi.fn(() => ({
    "agent.list": vi.fn(async () => ({ agents: [] })),
    "agent.suspend": vi.fn(async () => ({ suspended: true })),
  })),
}));

vi.mock("./obs-handlers.js", () => ({
  createObsHandlers: vi.fn(() => ({
    "obs.diagnostics": vi.fn(async () => ({})),
    "obs.billing": vi.fn(async () => ({})),
  })),
}));

vi.mock("./model-handlers.js", () => ({
  createModelHandlers: vi.fn(() => ({
    "model.list": vi.fn(async () => ({ models: [] })),
  })),
}));

vi.mock("./channel-handlers.js", () => ({
  createChannelHandlers: vi.fn(() => ({
    "channel.list": vi.fn(async () => ({ channels: [] })),
  })),
}));

vi.mock("./token-handlers.js", () => ({
  createTokenHandlers: vi.fn(() => ({
    "token.list": vi.fn(async () => ({ tokens: [] })),
  })),
}));

vi.mock("./daemon-handlers.js", () => ({
  createDaemonHandlers: vi.fn(() => ({
    "daemon.info": vi.fn(async () => ({ version: "1.0" })),
  })),
}));

vi.mock("./env-handlers.js", () => ({
  createEnvHandlers: vi.fn(() => ({
    "env.get": vi.fn(async () => ({ value: "" })),
  })),
}));

vi.mock("./mcp-handlers.js", () => ({
  createMcpHandlers: vi.fn(() => ({
    "mcp.list": vi.fn(async () => ({ servers: [] })),
  })),
}));

vi.mock("./workspace-handlers.js", () => ({
  createWorkspaceHandlers: vi.fn(() => ({
    "workspace.list_files": vi.fn(async () => ({ files: [] })),
  })),
}));

vi.mock("./heartbeat-handlers.js", () => ({
  createHeartbeatHandlers: vi.fn(() => ({
    "heartbeat.status": vi.fn(async () => ({ running: false })),
  })),
}));

vi.mock("./skill-handlers.js", () => ({
  createSkillHandlers: vi.fn(() => ({
    "skill.list": vi.fn(async () => ({ skills: [] })),
  })),
}));

vi.mock("./provider-handlers.js", () => ({
  createProviderHandlers: vi.fn(() => ({
    "providers.list": vi.fn(async () => ({ providers: [] })),
    "providers.get": vi.fn(async () => ({ provider: null })),
    "providers.add": vi.fn(async () => ({ added: true })),
    "providers.update": vi.fn(async () => ({ updated: true })),
    "providers.remove": vi.fn(async () => ({ removed: true })),
    "providers.set_default": vi.fn(async () => ({ updated: true })),
    "providers.test": vi.fn(async () => ({ ok: true })),
  })),
}));

// ---------------------------------------------------------------------------
// Tests: classifyRpcError (pure function)
// ---------------------------------------------------------------------------

describe("classifyRpcError", () => {
  it("classifies 'immutable' as config error", () => {
    const result = classifyRpcError("This path is immutable and cannot be changed");
    expect(result.errorKind).toBe("config");
    expect(result.hint).toBeTruthy();
    expect(result.hint.length).toBeGreaterThan(0);
  });

  it("classifies 'Admin access required' as auth error", () => {
    const result = classifyRpcError("Admin access required for this operation");
    expect(result.errorKind).toBe("auth");
    expect(result.hint).toBeTruthy();
  });

  it("classifies 'Unknown RPC method' as validation error", () => {
    const result = classifyRpcError("Unknown RPC method: foo.bar");
    expect(result.errorKind).toBe("validation");
    expect(result.hint).toContain("method name");
  });

  it("classifies 'not found' as validation error", () => {
    const result = classifyRpcError("Job not found: job-123");
    expect(result.errorKind).toBe("validation");
    expect(result.hint).toContain("does not exist");
  });

  it("classifies 'validation failed' as validation error", () => {
    const result = classifyRpcError("Parameter validation failed: name is required");
    expect(result.errorKind).toBe("validation");
    expect(result.hint).toContain("parameter");
  });

  it("classifies 'Invalid input' as validation error", () => {
    const result = classifyRpcError("Invalid input for schedule_every_ms");
    expect(result.errorKind).toBe("validation");
    expect(result.hint).toContain("parameter");
  });

  it("classifies unmatched messages as internal error", () => {
    const result = classifyRpcError("Something unexpected went wrong");
    expect(result.errorKind).toBe("internal");
    expect(result.hint).toBeTruthy();
  });

  it("returns actionable hints for all error types", () => {
    const messages = [
      "immutable config",
      "Admin access required",
      "Unknown RPC method: x",
      "not found",
      "validation failed",
      "random error",
    ];
    for (const msg of messages) {
      const result = classifyRpcError(msg);
      expect(result.hint.length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: createRpcDispatch (routing)
// ---------------------------------------------------------------------------

describe("createRpcDispatch", () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  // Minimal mock deps: logger + container stub needed by createRpcDispatch
  // to evaluate inline expressions like `deps.container.eventBus`.
  const mockDeps = {
    logger: mockLogger,
    container: { eventBus: { emit: vi.fn(), on: vi.fn() }, config: { providers: { entries: {} } } },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Lazy import to ensure mocks are in place
  async function getDispatch() {
    // Re-import to pick up mocked factories
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    // Provide mock logger so error paths can log through Pino
    const dispatch = createRpcDispatch(mockDeps);
    return dispatch;
  }

  it("routes known method to correct handler", async () => {
    const dispatch = await getDispatch();

    const result = (await dispatch("cron.add", {})) as { jobId: string };
    expect(result.jobId).toBe("j1");
  });

  it("throws for unknown RPC method", async () => {
    const dispatch = await getDispatch();

    await expect(dispatch("nonexistent.method", {})).rejects.toThrow(
      "Unknown RPC method: nonexistent.method",
    );
  });

  it("propagates handler errors", async () => {
    // Get the mock factory and make one handler throw
    const { createCronHandlers } = await import("./cron-handlers.js");
    (createCronHandlers as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      "cron.add": vi.fn(async () => {
        throw new Error("Scheduler not available");
      }),
    });

    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(mockDeps);

    await expect(dispatch("cron.add", {})).rejects.toThrow("Scheduler not available");
  });

  it("logs handler errors through Pino at ERROR level", async () => {
    const { createCronHandlers } = await import("./cron-handlers.js");
    (createCronHandlers as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      "cron.add": vi.fn(async () => {
        throw new Error("Scheduler not available");
      }),
    });

    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(mockDeps);

    await expect(dispatch("cron.add", {})).rejects.toThrow();

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [logObj, msg] = mockLogger.error.mock.calls[0]!;
    expect(msg).toBe("JSON-RPC method error");
    expect(logObj.method).toBe("cron.add");
    expect(logObj.hint).toBeTruthy();
    expect(logObj.errorKind).toBeTruthy();
  });

  it("merges handlers from all 16 factory modules", async () => {
    const dispatch = await getDispatch();

    // Verify methods from different factories are all routable
    // Each of these comes from a different handler factory module
    const methodsToCheck = [
      "cron.add",
      "memory.store",
      "session.list",
      "message.send",
      "image.analyze",
      "config.get",
      "browser.navigate",
      "subagent.run",
      "agent.list",
      "obs.diagnostics",
      "model.list",
      "channel.list",
      "token.list",
      "daemon.info",
      "providers.list",
    ];

    for (const method of methodsToCheck) {
      // Should not throw "Unknown RPC method"
      await expect(dispatch(method, {})).resolves.toBeDefined();
    }
  });

  it("routes memory.search to memory handler", async () => {
    const dispatch = await getDispatch();

    const result = (await dispatch("memory.search", { query: "test" })) as { results: unknown[] };
    expect(result.results).toEqual([]);
  });

  it("routes image.analyze to media handler", async () => {
    const dispatch = await getDispatch();

    const result = (await dispatch("image.analyze", {})) as { description: string };
    expect(result.description).toBe("img");
  });
});
