// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyRpcError } from "./rpc-dispatch.js";
import { PreconditionError, ValidationError } from "./errors.js";
import { RequiredToolsUnreachableError } from "@comis/core";

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

vi.mock("./memory-portability-handlers.js", () => ({
  createMemoryPortabilityHandlers: vi.fn(() => ({
    "memory.portability.export": vi.fn(async () => ({ entries: [] })),
    "memory.portability.import": vi.fn(async () => ({ imported: 0 })),
  })),
}));

vi.mock("./memory-pinning-handlers.js", () => ({
  createMemoryPinningHandlers: vi.fn(() => ({
    "memory.pin": vi.fn(async () => ({ pinned: true })),
    "memory.unpin": vi.fn(async () => ({ unpinned: true })),
  })),
}));

vi.mock("./session-handlers/index.js", () => ({
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

vi.mock("./config-handlers/index.js", () => ({
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

vi.mock("./obs-handlers/index.js", () => ({
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

vi.mock("./auth-handlers.js", () => ({
  createAuthHandlers: vi.fn(() => ({
    "auth.list": vi.fn(async () => ({ profiles: [] })),
    "auth.logout": vi.fn(async () => ({ deleted: true })),
    "auth.set": vi.fn(async () => ({ profileId: "test", stored: true })),
  })),
}));

vi.mock("./secrets-handlers.js", () => ({
  createSecretsHandlers: vi.fn(() => ({
    "secrets.list": vi.fn(async () => ({ secrets: [] })),
    "secrets.set": vi.fn(async () => ({ stored: true })),
    "secrets.delete": vi.fn(async () => ({ deleted: true })),
    "secrets.init": vi.fn(async () => ({ initialized: true })),
  })),
}));

vi.mock("./mcp-oauth-handlers.js", () => ({
  createMcpOauthHandlers: vi.fn(() => ({
    "mcp.oauth_login": vi.fn(async () => ({ authUrl: "" })),
    "mcp.oauth_logout": vi.fn(async () => ({ deleted: true })),
  })),
}));

vi.mock("./notification-handlers.js", () => ({
  createNotificationHandlers: vi.fn(() => ({})),
}));

vi.mock("./image-handlers.js", () => ({
  createImageHandlers: vi.fn(() => ({})),
}));

vi.mock("./graph-handlers/index.js", () => ({
  createGraphHandlers: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Tests: classifyRpcError (pure function)
// ---------------------------------------------------------------------------

describe("classifyRpcError", () => {
  // The 5 substring-match fallbacks (`errMsg.includes("immutable") |
  // "Admin access required" | "Unknown RPC method" | "not found" |
  // "validation failed" | "Invalid input"`) were deleted alongside their
  // pinning tests. Handlers still
  // throwing bare `Error("Admin access required" | ...)` now classify as
  // `internal`/`error` until they migrate to typed errors (deferred).

  it("classifies bare Error with any message as internal error (error level)", () => {
    // Only typed errors short-circuit to warn. Bare
    // `new Error(...)` always lands at the typed-classifier's default.
    const result = classifyRpcError(new Error("Something unexpected went wrong"));
    expect(result.errorKind).toBe("internal");
    expect(result.hint).toBeTruthy();
    expect(result.level).toBe("error");
  });

  it("classifies non-Error throws (string, undefined) as internal error", () => {
    expect(classifyRpcError("string thrown").errorKind).toBe("internal");
    expect(classifyRpcError(undefined).errorKind).toBe("internal");
    expect(classifyRpcError({ random: "object" }).errorKind).toBe("internal");
  });

  // ---------------------------------------------------------------------
  // Typed RPC error classes (only path to warn-level classification)
  // ---------------------------------------------------------------------

  it("classifies PreconditionError as precondition error (warn level)", () => {
    const result = classifyRpcError(new PreconditionError("No active DAG conversation for this session"));
    expect(result.errorKind).toBe("precondition");
    expect(result.level).toBe("warn");
    expect(result.hint).toBeTruthy();
  });

  it("classifies ValidationError as validation error (warn level)", () => {
    const result = classifyRpcError(new ValidationError("Unknown ID prefix. Expected 'sum_' or 'file_', got: abc-123"));
    expect(result.errorKind).toBe("validation");
    expect(result.level).toBe("warn");
    expect(result.hint).toBeTruthy();
  });

  // RequiredToolsUnreachableError must classify as validation/warn (not internal/error)
  it("classifies RequiredToolsUnreachableError as validation error at warn level", () => {
    const err = new RequiredToolsUnreachableError([
      { toolName: "mcp_manage", reason: "outside_profile", hint: "Re-spawn with tool_groups:['supervisor']." },
    ]);
    const result = classifyRpcError(err);
    expect(result.errorKind).toBe("validation");
    expect(result.level).toBe("warn");
    expect(result.hint).toBeTruthy();
  });

  it("typed-class check fully replaces message-pattern match (PreconditionError carrying legacy substring still routes via typed branch)", () => {
    // A PreconditionError whose message happens to contain the legacy
    // "not found" substring still routes through the typed-class branch.
    // This invariant survives the substring-fallback deletion because
    // the typed `instanceof` checks always run.
    const result = classifyRpcError(new PreconditionError("Grant not found: grant_abc"));
    expect(result.errorKind).toBe("precondition");
    expect(result.level).toBe("warn");
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

  it("logs unmatched handler errors through Pino at ERROR level", async () => {
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
    expect(logObj.errorKind).toBe("internal");
    // params now joins the payload so operator debugging doesn't
    // need a separate grep against the request log.
    expect("params" in logObj).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Severity-aware dispatcher
  // -----------------------------------------------------------------------

  it("PreconditionError → logger.warn (NOT .error), errorKind=precondition, params on payload", async () => {
    const { createCronHandlers } = await import("./cron-handlers.js");
    (createCronHandlers as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      "cron.add": vi.fn(async () => {
        throw new PreconditionError("No active DAG conversation for this session");
      }),
    });

    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(mockDeps);

    await expect(dispatch("cron.add", { spec: "rate(5 minutes)" })).rejects.toThrow();

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [logObj, msg] = mockLogger.warn.mock.calls[0]!;
    expect(msg).toBe("JSON-RPC method error");
    expect(logObj.errorKind).toBe("precondition");
    expect(logObj.method).toBe("cron.add");
    expect(logObj.params).toEqual({ spec: "rate(5 minutes)" });
  });

  it("ValidationError → logger.warn, errorKind=validation, params payload includes the offending id", async () => {
    const { createCronHandlers } = await import("./cron-handlers.js");
    (createCronHandlers as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      "cron.add": vi.fn(async () => {
        throw new ValidationError("Unknown ID prefix. Expected 'sum_' or 'file_', got: abc-123");
      }),
    });

    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(mockDeps);

    // Regression for the ~/.comis/logs/ "cron.add id=abc-123" case:
    // params MUST appear on the same log payload so an operator does not
    // have to cross-reference a separate request log to find the input.
    await expect(dispatch("cron.add", { id: "abc-123" })).rejects.toThrow();

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [logObj] = mockLogger.warn.mock.calls[0]!;
    expect(logObj.errorKind).toBe("validation");
    expect(logObj.params).toEqual({ id: "abc-123" });
  });

  it("generic Error → logger.error, errorKind=internal (default for unmatched)", async () => {
    const { createCronHandlers } = await import("./cron-handlers.js");
    (createCronHandlers as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      "cron.add": vi.fn(async () => {
        throw new Error("Database connection lost mid-write");
      }),
    });

    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(mockDeps);

    await expect(dispatch("cron.add", {})).rejects.toThrow();

    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [logObj] = mockLogger.error.mock.calls[0]!;
    expect(logObj.errorKind).toBe("internal");
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

  // -----------------------------------------------------------------------
  // auth.set failure MUST NOT log raw access/refresh tokens
  // -----------------------------------------------------------------------

  it("auth.set handler error — dispatcher must NOT emit raw bearer or refresh token in log payload", async () => {
    // The dispatcher error log path includes `params` on the log object.
    // For auth.set, params carries { access: "<bearer>", refresh: "<token>" }.
    // Before the fix, these bare field names were absent from CREDENTIAL_KEYS
    // so the Pino/diagnostic sanitizer did not redact them.
    //
    // This test simulates an auth.set failure (e.g. SQLITE_BUSY) and asserts
    // that neither ACCESS_SENTINEL nor REFRESH_SENTINEL appears in the log
    // payload written to logger.error.
    const ACCESS_SENTINEL = "tok-bearer-DISPATCH-CR01-SENTINEL";
    const REFRESH_SENTINEL = "tok-refresh-DISPATCH-CR01-SENTINEL";

    const { createAuthHandlers } = await import("./auth-handlers.js");
    (createAuthHandlers as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      "auth.set": vi.fn(async () => {
        throw new Error("database is locked");
      }),
    });

    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(mockDeps);

    const authSetParams = {
      _trustLevel: "admin",
      provider: "openai-codex",
      profileId: "openai-codex:user@example.com",
      access: ACCESS_SENTINEL,
      refresh: REFRESH_SENTINEL,
      expires: Date.now() + 3_600_000,
      accountId: "acct-SENTINEL",
      version: 1,
    };

    await expect(dispatch("auth.set", authSetParams)).rejects.toThrow("database is locked");

    // The dispatcher must have logged an error
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [logObj] = mockLogger.error.mock.calls[0]!;

    // Serialize the log payload and confirm token sentinels are absent.
    // The safeParams projection in the dispatcher (Part B defense-in-depth)
    // must replace access/refresh with "[REDACTED]" before they reach the
    // log call. CREDENTIAL_KEYS redaction (Part A) ensures the diagnostic
    // sanitizer also catches any future bypass.
    const logSerialized = JSON.stringify(logObj);
    expect(logSerialized).not.toContain(ACCESS_SENTINEL);
    expect(logSerialized).not.toContain(REFRESH_SENTINEL);
  });

  // -----------------------------------------------------------------------
  // WR-04: image.analyze (and other base64-bearing media methods) MUST NOT
  // log the raw base64 source/image/video bytes on a throw branch.
  // -----------------------------------------------------------------------

  it("WR-04: image.analyze handler error — dispatcher must NOT emit the raw base64 source in the log payload", async () => {
    // The dispatcher logs `params` on every thrown handler error. For
    // image.analyze with source_type:"base64", params.source is the raw base64
    // image — Pino key-name redaction (apiKey/token/…) does NOT cover `source`,
    // so the whole image used to land in the daemon log. The dispatcher must
    // strip large binary payload fields for media methods before logging.
    const BASE64_SENTINEL = "QkFTRTY0LUlNQUdFLVdSMDQtU0VOVElORUwtYmFzZTY0LWJvZHk=";

    const { createMediaHandlers } = await import("./media-handlers.js");
    (createMediaHandlers as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      "image.analyze": vi.fn(async () => {
        throw new Error("No vision provider available for image analysis.");
      }),
    });

    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(mockDeps);

    await expect(
      dispatch("image.analyze", {
        source_type: "base64",
        source: BASE64_SENTINEL,
        prompt: "describe this",
      }),
    ).rejects.toThrow(/vision provider available/i);

    // The dispatcher logged a warn or error — find whichever fired.
    const logCall =
      mockLogger.error.mock.calls[0] ?? mockLogger.warn.mock.calls[0];
    expect(logCall).toBeDefined();
    const logSerialized = JSON.stringify(logCall![0]);
    // WR-04: the base64 bytes must be absent from the log payload.
    expect(logSerialized).not.toContain(BASE64_SENTINEL);
    // The method + a non-binary param (prompt is small; kept) still aid triage,
    // but the load-bearing assertion is that the bytes are gone.
    expect(logSerialized).toContain("image.analyze");
  });

  it("WR-04: a NON-media method still logs its params (the strip is scoped, not global)", async () => {
    // Regression guard: the binary-strip must not eat ordinary RPC params —
    // only the known base64-bearing media methods are projected.
    const ID_SENTINEL = "cron-job-id-WR04-still-logged";
    const { createCronHandlers } = await import("./cron-handlers.js");
    (createCronHandlers as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      "cron.add": vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(mockDeps);

    await expect(dispatch("cron.add", { id: ID_SENTINEL })).rejects.toThrow("boom");

    const logCall = mockLogger.error.mock.calls[0] ?? mockLogger.warn.mock.calls[0];
    expect(logCall).toBeDefined();
    const logSerialized = JSON.stringify(logCall![0]);
    // A non-media method's ordinary param IS still on the log line (diagnostic).
    expect(logSerialized).toContain(ID_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// TELEM-01 WIRING (the 172-WR-02 lesson, T-173-13): the createGraphHandlers
// deps MUST actually carry a constructed `resolveCapabilityClass` — without it
// every pipeline:authored emit fail-defaults to "unknown" and the small-model
// authoring metric is permanently 0 / dead (a silent DoS on the gate). A typed-
// but-never-constructed dep would pass tsc and ship a dead metric; this asserts
// the production path at rpc-dispatch.ts:200 builds the resolver AND that it is
// LIVE (closes over deps.agents + getProviderCapabilityClass), not a no-op.
// ---------------------------------------------------------------------------

describe("createRpcDispatch — pipeline:authored tier resolver wiring (TELEM-01 / T-173-13)", () => {
  const mockLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Deps that make the (deps.graphCoordinator || deps.namedGraphStore) branch at
  // rpc-dispatch.ts:200 TAKEN, and supply the two inputs the resolver closes
  // over: an agents map (agentId -> {provider}) and getProviderCapabilityClass
  // (provider -> tier). "weakbot" runs on the "ollama" provider, which resolves
  // to the "small" tier.
  const graphMockDeps = {
    logger: mockLogger,
    container: { eventBus: { emit: vi.fn(), on: vi.fn() }, config: { providers: { entries: {} }, dataDir: "." } },
    graphCoordinator: { run: vi.fn(), cancel: vi.fn() },
    agents: { weakbot: { provider: "ollama" } },
    getProviderCapabilityClass: (provider: string | undefined) =>
      provider === "ollama" ? ("small" as const) : undefined,
  } as never;

  it("constructs resolveCapabilityClass on the createGraphHandlers deps (defined, a function — not a typed-only dead metric)", async () => {
    const { createGraphHandlers } = await import("./graph-handlers/index.js");
    const { createRpcDispatch } = await import("./rpc-dispatch.js");

    createRpcDispatch(graphMockDeps);

    const factoryDeps = (createGraphHandlers as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { resolveCapabilityClass?: unknown }
      | undefined;
    expect(factoryDeps).toBeDefined();
    expect(typeof factoryDeps!.resolveCapabilityClass).toBe("function");
  });

  it("the wired resolver returns the REAL tier (small) for a known agent — NOT a permanent unknown", async () => {
    const { createGraphHandlers } = await import("./graph-handlers/index.js");
    const { createRpcDispatch } = await import("./rpc-dispatch.js");

    createRpcDispatch(graphMockDeps);

    const factoryDeps = (createGraphHandlers as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      resolveCapabilityClass: (agentId: string | undefined) => string | undefined;
    };
    // weakbot -> ollama -> small (the resolver is LIVE: it closes over both
    // deps.agents and deps.getProviderCapabilityClass; a no-op would yield
    // undefined → the emit would record "unknown").
    expect(factoryDeps.resolveCapabilityClass("weakbot")).toBe("small");
    // An unknown agent yields undefined (the emit then records "unknown" honestly).
    expect(factoryDeps.resolveCapabilityClass("ghost")).toBeUndefined();
    expect(factoryDeps.resolveCapabilityClass(undefined)).toBeUndefined();
  });
});
