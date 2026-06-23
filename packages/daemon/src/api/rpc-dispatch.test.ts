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
    "session.export": vi.fn(async () => ({ messages: [] })),
    "session.reset": vi.fn(async () => ({ reset: true })),
    "session.compact": vi.fn(async () => ({ compactionTriggered: true })),
    "session.reset_conversation": vi.fn(async () => ({ reset: true })),
    "session.send_cross": vi.fn(async () => ({ sent: true })),
  })),
}));

vi.mock("./message-handlers.js", () => ({
  createMessageHandlers: vi.fn(() => ({
    "message.send": vi.fn(async () => ({ sent: true })),
    "message.reply": vi.fn(async () => ({ sent: true })),
    "message.react": vi.fn(async () => ({ reacted: true })),
    "message.edit": vi.fn(async () => ({ edited: true })),
    "message.delete": vi.fn(async () => ({ deleted: true })),
    "message.attach": vi.fn(async () => ({ sent: true })),
    "message.fetch": vi.fn(async () => ({ messages: [] })),
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
    "skills.list": vi.fn(async () => ({ skills: [] })),
    "skills.create": vi.fn(async () => ({ created: true })),
    "skills.update": vi.fn(async () => ({ updated: true })),
    "skills.delete": vi.fn(async () => ({ deleted: true })),
    "skills.import": vi.fn(async () => ({ imported: true })),
    "skills.upload": vi.fn(async () => ({ uploaded: true })),
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

  // -----------------------------------------------------------------------
  // ORIGIN-01: the single deny-by-origin chokepoint in the dispatch closure.
  //
  // CRITICAL: these tests call dispatch() DIRECTLY — i.e. they exercise the
  // IN-PROCESS dispatch path the agent's call actually traverses
  // (createAgentRpcCall -> the SAME injected rpcCall -> this dispatch closure),
  // NOT the gateway/method-router leg (which the in-process loop bypasses). A
  // method-router-only chokepoint would MISS this path; the chokepoint MUST
  // live here in createRpcDispatch. The admin set is derived once from
  // API_CONTRACTS_ORDERED (scopes.includes("admin")) so ALL ~146 admin methods
  // are covered by the one check, not a hand-picked subset.
  // -----------------------------------------------------------------------

  /** Pull only the captured `audit:event` payloads off the mock eventBus. */
  function capturedAudits(): Array<Record<string, unknown>> {
    const emit = mockDeps.container.eventBus.emit as ReturnType<typeof vi.fn>;
    return emit.mock.calls
      .filter((c: unknown[]) => c[0] === "audit:event")
      .map((c: unknown[]) => c[1] as Record<string, unknown>);
  }

  it("ORIGIN-01: an _agentId-carrying admin call on the IN-PROCESS dispatch path is denied + audited (the bypass the agent actually traverses)", async () => {
    const dispatch = await getDispatch();
    // secrets.get is admin-scoped. _trustLevel:"admin" is the agent's ALS
    // trust — deny-by-origin must fire on the ORIGIN regardless. We dispatch()
    // directly: this is the in-process leg, not the gateway.
    await expect(
      dispatch("secrets.set", { _agentId: "forged", _trustLevel: "admin", name: "X", value: "Y" }),
    ).rejects.toThrow(/not reachable from an agent origin/i);

    const audits = capturedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.kind).toBe("capability_denied");
    expect(audits[0]!.outcome).toBe("denied");
    expect(audits[0]!.actionType).toBe("secrets.set");
  });

  it("ORIGIN-01: the chokepoint denies across ≥3 DIFFERENT admin scope families (whole admin set, not a subset)", async () => {
    // Three admin methods from distinct domains: secrets.*, auth.*, mcp.* —
    // all contract-declared `scopes:["admin"]` and present in the mock maps.
    const adminMethods = ["secrets.delete", "auth.logout", "mcp.oauth_login"];
    for (const method of adminMethods) {
      vi.clearAllMocks();
      const dispatch = await getDispatch();
      await expect(
        dispatch(method, { _agentId: "forged", _trustLevel: "admin" }),
      ).rejects.toThrow(/not reachable from an agent origin/i);
      const audits = capturedAudits();
      expect(audits, `audit for ${method}`).toHaveLength(1);
      expect(audits[0]!.actionType, `actionType for ${method}`).toBe(method);
      expect(audits[0]!.outcome).toBe("denied");
    }
  });

  it("ORIGIN-01 (Pitfall 2): a NON-admin self-scoped method with _agentId PASSES the chokepoint (agent self-reads still work)", async () => {
    const dispatch = await getDispatch();
    // cron.list is scopes:["rpc"] (NON-admin) — the agent's own _agentId rides
    // it for tenant self-scoping and must NOT be denied. The chokepoint keys on
    // ADMIN_METHODS membership, so a non-admin method's _agentId is untouched.
    await expect(
      dispatch("cron.list", { _agentId: "self" }),
    ).resolves.toBeDefined();
    // No deny-by-origin audit fired for the allowed self-scoped read.
    const denials = capturedAudits().filter((a) => a.kind === "capability_denied");
    expect(denials).toHaveLength(0);
  });

  it("ORIGIN-01: an admin method WITHOUT _agentId (operator/gateway origin) passes the deny-by-origin chokepoint", async () => {
    const dispatch = await getDispatch();
    // No _agentId == operator/gateway origin. The chokepoint must NOT throw the
    // deny-by-origin error (the mocked handler resolves normally).
    await expect(
      dispatch("secrets.delete", { _trustLevel: "admin", name: "X" }),
    ).resolves.toBeDefined();
    const denials = capturedAudits().filter((a) => a.kind === "capability_denied");
    expect(denials).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 210-GAP CR-01/MD-01: the deny-by-origin chokepoint must NOT swallow an
  // agent's OWN granted orchestration surface (message.send/reply/react +
  // skills.* mutating) nor its agent-self reads (message.fetch, session.list/
  // compact/reset). These are the orchestration plane the capability gate
  // owns — not control plane. This test dispatches an _agentId+_capabilities
  // call through the REAL createRpcDispatch closure and asserts it REACHES the
  // mocked handler (resolves), NOT a deny-by-origin throw.
  //
  // This closes the test-layer gap the 210-REVIEW identified: the chokepoint
  // (rpc-dispatch.test) and the per-handler cap gate (message-handlers.test)
  // were tested in two separate layers that never met — no test dispatched an
  // _agentId-bearing call to an orch method through the full closure. RED on
  // pre-fix HEAD (these methods are scopes:["admin"] → in ADMIN_METHODS →
  // assertNotAgentOrigin throws before the handler).
  // -----------------------------------------------------------------------

  /** The orch-gated/agent-read methods that MUST stay reachable from an agent origin. */
  const AGENT_REACHABLE_WITH_CAP: ReadonlyArray<readonly [string, string]> = [
    // outward message subset (§3.5) → orch:message
    ["message.send", "orch:message"],
    ["message.reply", "orch:message"],
    ["message.react", "orch:message"],
    // skills mutating set → orch:skill
    ["skills.create", "orch:skill"],
    ["skills.update", "orch:skill"],
    ["skills.delete", "orch:skill"],
    ["skills.import", "orch:skill"],
    ["skills.upload", "orch:skill"],
  ];

  /** Agent-self read/lifecycle ops (ungated) — reachable WITHOUT any cap.
   *  (message.fetch is INTENTIONALLY excluded — §3.5 keeps fetch admin-only.) */
  const AGENT_REACHABLE_UNGATED: ReadonlyArray<string> = [
    "session.list",
    "session.compact",
    "session.reset",
  ];

  it("210-GAP CR-01: an agent-origin call to its OWN orch-gated method (with the cap held) REACHES the handler, not a deny-by-origin throw", async () => {
    for (const [method, cap] of AGENT_REACHABLE_WITH_CAP) {
      vi.clearAllMocks();
      const dispatch = await getDispatch();
      // Production-shaped agent params: _agentId present (in-process origin) +
      // the granted cap injected. Must resolve (reach the mocked handler), and
      // must emit NO deny-by-origin denial.
      await expect(
        dispatch(method, { _agentId: "agentA", _capabilities: [cap] }),
        `${method} (cap ${cap}) must be reachable from an agent origin`,
      ).resolves.toBeDefined();
      const denials = capturedAudits().filter((a) => a.kind === "capability_denied");
      expect(denials, `${method} must not trip deny-by-origin`).toHaveLength(0);
    }
  });

  it("210-GAP MD-01: an agent-origin agent-self read (ungated) REACHES the handler, not a deny-by-origin throw", async () => {
    for (const method of AGENT_REACHABLE_UNGATED) {
      vi.clearAllMocks();
      const dispatch = await getDispatch();
      await expect(
        dispatch(method, { _agentId: "agentA" }),
        `${method} (ungated agent-self read) must be reachable from an agent origin`,
      ).resolves.toBeDefined();
      const denials = capturedAudits().filter((a) => a.kind === "capability_denied");
      expect(denials, `${method} must not trip deny-by-origin`).toHaveLength(0);
    }
  });

  it("210-GAP: the two gates are DISTINGUISHABLE — an agent WITHOUT orch:message is denied by requireCapability (the cap gate), NOT deny-by-origin", async () => {
    // Wire the REAL requireCapability into the message.send mock so the cap gate
    // actually runs. Post-fix, message.send is rpc-scoped (NOT in ADMIN_METHODS),
    // so an agent origin PASSES deny-by-origin and reaches the handler; the
    // handler's requireCapability then throws CapabilityDeniedError because the
    // agent does not hold orch:message. This proves the gates are separable: the
    // origin check (deny-by-origin) and the held-cap check (requireCapability)
    // are two distinct seams — a missing cap is a CapabilityDeniedError, NOT a
    // "not reachable from an agent origin" throw.
    const { requireCapability, CapabilityDeniedError } = await import("@comis/core");
    const { createMessageHandlers } = await import("./message-handlers.js");
    (createMessageHandlers as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      "message.send": vi.fn(async (p: Record<string, unknown>) => {
        requireCapability(p._capabilities as string[] | undefined, "orch:message");
        return { sent: true };
      }),
    });
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(mockDeps);

    // Agent origin, but NO orch:message held → denied by the CAP gate.
    await expect(
      dispatch("message.send", { _agentId: "agentA", _capabilities: ["orch:read"] }),
    ).rejects.toThrow(CapabilityDeniedError);
    // It must NOT be the deny-by-origin throw (that proves the methods were
    // re-scoped off the admin deny set; otherwise this would never reach the gate).
    await expect(
      dispatch("message.send", { _agentId: "agentA", _capabilities: ["orch:read"] }),
    ).rejects.not.toThrow(/not reachable from an agent origin/i);
    // No deny-by-origin audit fired — the denial came from the cap gate.
    const denials = capturedAudits().filter((a) => a.kind === "capability_denied");
    expect(denials.filter((a) => a.metadata && (a.metadata as Record<string, unknown>).reason === "agent_origin_admin")).toHaveLength(0);
  });

  it("210-GAP: the TRUE control plane (incl. arbitrary-session lifecycle) STILL denies an agent origin", async () => {
    // These remain scopes:["admin"] + deny-by-origin: real control plane plus
    // the arbitrary-session lifecycle ops carrying an in-handler admin check
    // (session.delete/export/reset_conversation) and the message subset §3.5
    // keeps admin-only (edit/delete/attach). An agent origin must be denied.
    const STILL_DENIED = [
      "secrets.set",
      "session.delete",
      "session.export",
      "session.reset_conversation",
      // §3.5: edit/delete/fetch/attach stay admin-only, NOT part of orch:message.
      "message.edit",
      "message.delete",
      "message.attach",
      "message.fetch",
    ];
    for (const method of STILL_DENIED) {
      vi.clearAllMocks();
      const dispatch = await getDispatch();
      await expect(
        dispatch(method, { _agentId: "agentA", _trustLevel: "admin" }),
        `${method} must stay denied from an agent origin`,
      ).rejects.toThrow(/not reachable from an agent origin/i);
      const denials = capturedAudits().filter((a) => a.kind === "capability_denied");
      expect(denials, `${method} must audit the deny-by-origin denial`).toHaveLength(1);
    }
  });

  // -----------------------------------------------------------------------
  // AUDIT-01 (Phase 215 Plan 01 Task 2): the per-cap audit at the IN-PROCESS
  // chokepoint — emitted for an ALLOWED *and* a DENIED capability-gated call.
  // The in-process path has NO lease (chokepoint asymmetry G1): rootRunId comes
  // from the synthetic-root resolver (resolveRootRunId), leaseId is honestly
  // ABSENT (never fabricated). Content-free: ids/caps/method/decision ONLY.
  // -----------------------------------------------------------------------

  /** Pull only the captured `capability:audited` payloads off the mock eventBus. */
  function capturedCapAudited(): Array<Record<string, unknown>> {
    const emit = mockDeps.container.eventBus.emit as ReturnType<typeof vi.fn>;
    return emit.mock.calls
      .filter((c: unknown[]) => c[0] === "capability:audited")
      .map((c: unknown[]) => c[1] as Record<string, unknown>);
  }

  /**
   * Deps with a synthetic-root resolver wired (the in-process audit's rootRunId
   * source, G1) + the tenant config the audit reads. Mirrors `mockDeps` plus
   * `resolveRootRunId` (the production resolver returns `root-session-<key>`).
   */
  function makeAuditDeps(): {
    deps: never;
    auditEvents: () => Array<Record<string, unknown>>;
    capAudited: () => Array<Record<string, unknown>>;
  } {
    const emit = vi.fn();
    const deps = {
      logger: mockLogger,
      container: {
        eventBus: { emit, on: vi.fn() },
        config: { providers: { entries: {} }, tenantId: "tenant-a" },
      },
      // The synthetic per-session root resolver (setup-capability-endpoint-boot.ts).
      resolveRootRunId: (key: { tenantId: string; userId: string; channelId: string }) =>
        `root-session-${key.tenantId}:${key.userId}:${key.channelId}`,
    } as never;
    const pull = (name: string) =>
      emit.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, unknown>);
    return {
      deps,
      auditEvents: () => pull("audit:event"),
      capAudited: () => pull("capability:audited"),
    };
  }

  it("AUDIT-01: an ALLOWED in-process gated call emits audit:event (kind=audit, outcome=success, decision=allow, the mapped cap, synthetic rootRunId, NO leaseId)", async () => {
    const { deps, auditEvents } = makeAuditDeps();
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(deps);

    // message.send → orch:message (HANDLER_CAPABILITY_MAP); rpc-scoped (NOT
    // deny-by-origin) so the call reaches the mocked handler → allow.
    await expect(
      dispatch("message.send", {
        _agentId: "agentA",
        _capabilities: ["orch:message"],
        _callerSessionKey: "tenant-a:user-7:chan-9",
      }),
    ).resolves.toBeDefined();

    const audits = auditEvents();
    expect(audits).toHaveLength(1);
    const evt = audits[0]!;
    expect(evt.kind).toBe("audit");
    expect(evt.outcome).toBe("success");
    const md = evt.metadata as Record<string, unknown>;
    expect(md.decision).toBe("allow");
    expect(md.capability).toBe("orch:message");
    expect(md.method).toBe("message.send");
    expect(md.rootRunId).toBe("root-session-tenant-a:user-7:chan-9");
    // G1: the in-process path has NO lease — leaseId is honestly ABSENT.
    expect("leaseId" in md).toBe(false);
  });

  it("AUDIT-01: the same allowed call ALSO emits capability:audited (decision=allow, the cap, synthetic rootRunId, no leaseId) — the spawn-tree producer", async () => {
    const { deps, capAudited } = makeAuditDeps();
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(deps);

    await dispatch("message.send", {
      _agentId: "agentA",
      _capabilities: ["orch:message"],
      _callerSessionKey: "tenant-a:user-7:chan-9",
    });

    const tree = capAudited();
    expect(tree).toHaveLength(1);
    const evt = tree[0]!;
    expect(evt.decision).toBe("allow");
    expect(evt.capability).toBe("orch:message");
    expect(evt.agentId).toBe("agentA");
    expect(evt.rootRunId).toBe("root-session-tenant-a:user-7:chan-9");
    // In-process: no real lease → leaseId/parentLeaseId honestly absent.
    expect(evt.leaseId).toBeUndefined();
    expect(evt.parentLeaseId).toBeUndefined();
  });

  it("AUDIT-01: a DENIED in-process gated call (handler throws CapabilityDeniedError) emits decision=deny, kind=capability_denied, outcome=denied", async () => {
    // Wire the REAL requireCapability into message.send so a missing cap throws.
    const { requireCapability } = await import("@comis/core");
    const { createMessageHandlers } = await import("./message-handlers.js");
    (createMessageHandlers as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      "message.send": vi.fn(async (p: Record<string, unknown>) => {
        requireCapability(p._capabilities as string[] | undefined, "orch:message");
        return { sent: true };
      }),
    });
    const { deps, auditEvents, capAudited } = makeAuditDeps();
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(deps);

    // Agent origin but WITHOUT orch:message → the handler's requireCapability throws.
    await expect(
      dispatch("message.send", {
        _agentId: "agentA",
        _capabilities: ["orch:read"],
        _callerSessionKey: "tenant-a:user-7:chan-9",
      }),
    ).rejects.toBeInstanceOf((await import("@comis/core")).CapabilityDeniedError);

    const denyAudit = auditEvents().filter(
      (a) => (a.metadata as Record<string, unknown>)?.decision === "deny",
    );
    expect(denyAudit).toHaveLength(1);
    expect(denyAudit[0]!.kind).toBe("capability_denied");
    expect(denyAudit[0]!.outcome).toBe("denied");
    expect((denyAudit[0]!.metadata as Record<string, unknown>).capability).toBe("orch:message");
    // The deny is ALSO on the spawn-tree producer.
    const treeDeny = capAudited().filter((a) => a.decision === "deny");
    expect(treeDeny).toHaveLength(1);
  });

  it("AUDIT-02 (WR-02): a gated in-process call with NO resolvable root still emits the durable audit:event security row — only the capability:audited tree producer needs a root", async () => {
    const { deps, auditEvents, capAudited } = makeAuditDeps();
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(deps);

    // Agent-origin + cap-gated, but NO _callerSessionKey → no resolvable rootRunId
    // (the tree-correlation path has a gap). The durable AUDIT-02 trail must NOT
    // be coupled to that gap — a gated decision is a security fact regardless.
    await expect(
      dispatch("message.send", {
        _agentId: "agentA",
        _capabilities: ["orch:message"],
      }),
    ).resolves.toBeDefined();

    // The durable security trail STILL fires (a gated decision was made).
    const audits = auditEvents();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.kind).toBe("audit");
    const md = audits[0]!.metadata as Record<string, unknown>;
    expect(md.decision).toBe("allow");
    expect(md.capability).toBe("orch:message");
    // rootRunId honestly ABSENT on the row (no resolvable root) — never fabricated.
    expect("rootRunId" in md).toBe(false);
    // The tree producer is correctly SUPPRESSED — a node with no root is unplaceable.
    expect(capAudited()).toHaveLength(0);
  });

  it("AUDIT-01 (content-hygiene): the in-process audit metadata carries NO args/params/body/path/secret — only {capability, method, runId, rootRunId, decision}", async () => {
    const { deps, auditEvents, capAudited } = makeAuditDeps();
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(deps);

    await dispatch("message.send", {
      _agentId: "agentA",
      _capabilities: ["orch:message"],
      _callerSessionKey: "tenant-a:user-7:chan-9",
      // hostile content the audit MUST NOT echo:
      text: "the actual chat message body",
      apiKey: "sk-PLANTED-SECRET",
      path: "/home/user/.comis/secret.txt",
    });

    const md = auditEvents()[0]!.metadata as Record<string, unknown>;
    expect(new Set(Object.keys(md))).toEqual(
      new Set(["capability", "method", "runId", "rootRunId", "decision"]),
    );
    const auditJson = JSON.stringify(auditEvents()[0]);
    const treeJson = JSON.stringify(capAudited()[0]);
    for (const blob of [auditJson, treeJson]) {
      expect(blob).not.toContain("sk-PLANTED-SECRET");
      expect(blob).not.toContain("the actual chat message body");
      expect(blob).not.toContain("secret.txt");
    }
  });

  it("AUDIT-01: an UNGATED method (no AgentCapability mapping) emits NO per-cap audit — it is the per-CAPABILITY trail", async () => {
    const { deps, auditEvents, capAudited } = makeAuditDeps();
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(deps);

    // session.list is "ungated" in HANDLER_CAPABILITY_MAP — not a per-cap call.
    await dispatch("session.list", {
      _agentId: "agentA",
      _callerSessionKey: "tenant-a:user-7:chan-9",
    });
    expect(auditEvents()).toHaveLength(0);
    expect(capAudited()).toHaveLength(0);
  });

  it("AUDIT-01: the admin deny-by-origin path is NOT double-audited (only assertNotAgentOrigin fires, no per-cap deny)", async () => {
    const { deps, auditEvents } = makeAuditDeps();
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(deps);

    // secrets.set is deny-by-origin (ADMIN_METHODS) — assertNotAgentOrigin audits
    // it once; the per-cap emitter (AgentCapability-only) must NOT add a second.
    await expect(
      dispatch("secrets.set", { _agentId: "agentA", _trustLevel: "admin", name: "X", value: "Y" }),
    ).rejects.toThrow(/not reachable from an agent origin/i);
    const denials = auditEvents().filter((a) => a.kind === "capability_denied");
    expect(denials).toHaveLength(1);
    expect((denials[0]!.metadata as Record<string, unknown>).reason).toBe("agent_origin_admin");
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

  // AUTHOR-01 (174-03) wiring: createGraphHandlers MUST also carry the gate
  // (authoringConfig, from container.config.orchestration.authoring) AND the
  // injected conservative repair matcher (repairMatch = matchRawGraphToTemplate
  // from @comis/agent — the daemon→agent boundary is crossed here, the
  // composition site, never inside the pure helper). A typed-but-unwired
  // repairMatch would make the repair branch permanently unreachable in prod.
  it("constructs authoringConfig + repairMatch on the createGraphHandlers deps (AUTHOR-01 — repair branch is reachable in prod)", async () => {
    const { createGraphHandlers } = await import("./graph-handlers/index.js");
    const { createRpcDispatch } = await import("./rpc-dispatch.js");

    const depsWithGate = {
      ...graphMockDeps,
      container: {
        eventBus: { emit: vi.fn(), on: vi.fn() },
        config: {
          providers: { entries: {} },
          dataDir: ".",
          orchestration: { authoring: { repairProducer: true, intentAction: false, gbnfConstrain: false } },
        },
      },
    } as never;
    createRpcDispatch(depsWithGate);

    const factoryDeps = (createGraphHandlers as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { authoringConfig?: { repairProducer?: boolean }; repairMatch?: unknown }
      | undefined;
    expect(factoryDeps).toBeDefined();
    // The gate is threaded from config (the value the operator flips).
    expect(factoryDeps!.authoringConfig).toMatchObject({ repairProducer: true });
    // The repair matcher is a live function (the injected @comis/agent matcher).
    expect(typeof factoryDeps!.repairMatch).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// INTRO-01/02 (Phase 215-04): capabilities.introspect dispatch wiring. The
// capabilities-handlers module is NOT mocked, so the REAL createCapabilitiesHandlers
// runs — this asserts the dispatch-level contract: gated on boundedAutonomy,
// agent-reachable (NOT denied by origin — it is scopes:["rpc"]/"ungated", not in
// ADMIN_METHODS), and self-scoped to the caller's _agentId.
// ---------------------------------------------------------------------------

describe("createRpcDispatch — capabilities.introspect wiring (INTRO-01/02)", () => {
  const mockLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Deps WITH boundedAutonomy + an agents map so the real capabilities handler
   *  is spread into the dispatch. */
  function depsWithAutonomy() {
    return {
      logger: mockLogger,
      container: { eventBus: { emit: vi.fn(), on: vi.fn() }, config: { providers: { entries: {} } } },
      defaultAgentId: "default",
      agents: {
        "agent-a": { autonomy: { profile: "standard", capabilities: ["orch:read", "orch:web"] } },
        default: { autonomy: { profile: "assistant", capabilities: [] } },
      },
      // No resolveRootRunId → no live root → budget omitted (honest).
      boundedAutonomy: {
        snapshot: vi.fn().mockReturnValue({
          budget: { tokensRemaining: 1, wallClockMsRemaining: 1, usdRemaining: 0 },
          outwardQuota: { perHourRemaining: 1 },
          leaseIds: [],
        }),
      },
    } as never;
  }

  it("an _agentId-bearing capabilities.introspect is NOT denied by origin and returns the caller's self-scoped caps", async () => {
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    const dispatch = createRpcDispatch(depsWithAutonomy());

    // Agent-origin call (carries _agentId) — must REACH the handler (not denied;
    // the method is scopes:["rpc"]/"ungated", not in ADMIN_METHODS) and be
    // self-scoped to agent-a (NOT the smuggled agentId param).
    const result = (await dispatch("capabilities.introspect", {
      _agentId: "agent-a",
      agentId: "default", // an arbitrary cross-agent param — MUST be ignored
    })) as { agentId: string; caps: string[] };

    expect(result.agentId).toBe("agent-a");
    expect(result.caps).toContain("orch:web");
    // The caller is the assistant `default` would have ZERO caps — proving the
    // self-scope read the unforgeable _agentId, not the smuggled agentId param.
    expect(result.caps).not.toEqual([]);
  });

  it("capabilities.introspect is NOT registered when boundedAutonomy is absent (gated spread)", async () => {
    const { createRpcDispatch } = await import("./rpc-dispatch.js");
    // Minimal deps WITHOUT boundedAutonomy — the spread is {} → unknown method.
    const dispatch = createRpcDispatch({
      logger: mockLogger,
      container: { eventBus: { emit: vi.fn(), on: vi.fn() }, config: { providers: { entries: {} } } },
    } as never);

    await expect(dispatch("capabilities.introspect", {})).rejects.toThrow(
      "Unknown RPC method: capabilities.introspect",
    );
  });
});
