// SPDX-License-Identifier: Apache-2.0
/**
 * RPC leaf tests for the deferred RPC bridge (`setupRpcBridge`) plus the
 * source guard that the execution-request log-field redaction helper is
 * still wired into the executeAgent adapter.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conversationScopeToSessionKey,
  formatSessionKey,
  TypedEventBus,
  tryGetContext,
  type RequestContext,
  type SessionKey,
} from "@comis/core";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createGatewayAttachmentPersister } from "../gateway-attachment-persistence.js";
import { err, ok } from "@comis/shared";

// Hoisted mocks for RPC bridge
const mockCreateRpcDispatch = vi.hoisted(() => vi.fn());
const mockClassifyRpcError = vi.hoisted(() => vi.fn(() => ({
  hint: "Check RPC target",
  errorKind: "internal" as const,
})));

vi.mock("../../api/rpc-dispatch.js", () => ({
  createRpcDispatch: mockCreateRpcDispatch,
  classifyRpcError: mockClassifyRpcError,
}));

function makePassingSessionAdapters(agentIds: string[] = ["default"]) {
  return new Map(agentIds.map((agentId) => [agentId, {
    destroySession: vi.fn(async () => undefined),
    getSessionStats: vi.fn(() => undefined),
    persistInboundMessage: vi.fn(async () => ({
      ok: true as const,
      value: { payloads: [], ledgerContent: "" },
    })),
  }]));
}

describe("setupRpcBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getSetupRpcBridge() {
    const mod = await import("./setup-gateway-rpc.js");
    return mod.setupRpcBridge;
  }

  // 30s timeout: the first dynamic `await import("./setup-gateway-rpc.js")`
  // in the test suite pays the full one-time cost of loading the SUT +
  // transitive deps (@comis/observability, @comis/core, @comis/agent,
  // @comis/skills, etc.) under vitest's transformer. Subsequent tests in
  // the file reuse the cached module so they run in ms. The 5s default
  // is too tight under parallel-test-pool load — 15s was still tail-end
  // flaky in the parallel pool, so this bumps to 30s for a comfortable
  // margin without slowing down isolated runs (which complete in 6-7s).
  it("returns rpcCall and wireDispatch functions", { timeout: 30000 }, async () => {
    const setupRpcBridge = await getSetupRpcBridge();
    const result = setupRpcBridge({ gatewayLogger: createMockLogger() as any });

    expect(typeof result.rpcCall).toBe("function");
    expect(typeof result.wireDispatch).toBe("function");
  });

  it("rpcCall delegates to inner dispatch after wireDispatch is called", async () => {
    const mockInner = vi.fn(async () => ({ success: true }));
    mockCreateRpcDispatch.mockReturnValue(mockInner);

    const setupRpcBridge = await getSetupRpcBridge();
    const { rpcCall, wireDispatch } = setupRpcBridge({
      gatewayLogger: createMockLogger() as any,
    });

    wireDispatch({ some: "deps" } as any);

    const result = await rpcCall("test.method", { key: "value" });

    expect(mockCreateRpcDispatch).toHaveBeenCalledWith({ some: "deps" });
    expect(mockInner).toHaveBeenCalledWith("test.method", { key: "value" });
    expect(result).toEqual({ success: true });
  });

  it("rpcCall throws before wireDispatch is called (rpcCallInner is undefined)", async () => {
    const setupRpcBridge = await getSetupRpcBridge();
    const { rpcCall } = setupRpcBridge({
      gatewayLogger: createMockLogger() as any,
    });

    // rpcCallInner is undefined, calling it should throw
    await expect(rpcCall("test.method", {})).rejects.toThrow();
  });

  it("rpcCall wraps errors with classifyRpcError and logs via gatewayLogger.debug", async () => {
    const mockInner = vi.fn(async () => { throw new Error("Not found"); });
    mockCreateRpcDispatch.mockReturnValue(mockInner);
    mockClassifyRpcError.mockReturnValue({
      hint: "Check method name",
      errorKind: "validation",
    });

    const gatewayLogger = createMockLogger();
    const setupRpcBridge = await getSetupRpcBridge();
    const { rpcCall, wireDispatch } = setupRpcBridge({ gatewayLogger: gatewayLogger as any });

    wireDispatch({} as any);

    await expect(rpcCall("bad.method", { x: 1 })).rejects.toThrow("Not found");

    // OBS-RPC-REFUSAL-CLASS: classifyRpcError must receive the error OBJECT (so its
    // typed-refusal recognition resolves), NOT err.message — a string can never match.
    expect(mockClassifyRpcError).toHaveBeenCalledWith(expect.any(Error));
    expect(gatewayLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "bad.method",
        err: "Not found",
        hint: "Check method name",
        errorKind: "validation",
      }),
      "[rpcCall] failed",
    );
  });

  it("rpcCall handles non-Error thrown values", async () => {
    const mockInner = vi.fn(async () => { throw "string error"; });
    mockCreateRpcDispatch.mockReturnValue(mockInner);

    const gatewayLogger = createMockLogger();
    const setupRpcBridge = await getSetupRpcBridge();
    const { rpcCall, wireDispatch } = setupRpcBridge({ gatewayLogger: gatewayLogger as any });

    wireDispatch({} as any);

    await expect(rpcCall("test.method", {})).rejects.toBe("string error");

    expect(mockClassifyRpcError).toHaveBeenCalledWith("string error");
    expect(gatewayLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ err: "string error" }),
      "[rpcCall] failed",
    );
  });

  it("wireDispatch calls createRpcDispatch with provided deps", async () => {
    const dispatchDeps = {
      heartbeatRunner: { start: vi.fn() },
      rpcHandlers: new Map(),
    };

    mockCreateRpcDispatch.mockReturnValue(vi.fn(async () => ({})));

    const setupRpcBridge = await getSetupRpcBridge();
    const { wireDispatch } = setupRpcBridge({ gatewayLogger: createMockLogger() as any });

    wireDispatch(dispatchDeps as any);

    expect(mockCreateRpcDispatch).toHaveBeenCalledWith(dispatchDeps);
  });
});

describe("buildRpcAdapterDeps getConfig non-secret allowlist", () => {
  // Minimal container.config carrying an apiKey-shaped secret in the `agents`
  // section (the real leak: per-agent auth/model profiles) plus a non-secret
  // gateway section and the two scalar allowlist fields. Only the fields the
  // getConfig handler reads need to be real — the rest of AppConfig is absent.
  function makeContainerConfig() {
    return {
      tenantId: "tenant-a",
      logLevel: "info",
      gateway: {
        enabled: true,
        host: "127.0.0.1",
        port: 4766,
        // A secret adjacent to the allowlisted gateway projection — bearer
        // tokens live on the raw gateway object and must NEVER egress even
        // when `gateway` is allowlisted (the handler returns the projection).
        tokens: [{ token: "tok-GATEWAY-SECRET", scopes: ["admin"] }],
      },
      agents: {
        default: {
          name: "Comis",
          provider: "anthropic",
          model: "claude",
          // apiKey-shaped value reachable when the section is returned verbatim.
          modelFailover: { authProfiles: [{ keyName: "ANTHROPIC_API_KEY", provider: "anthropic" }] },
          apiKey: "sk-LEAK-TOKEN",
        },
      },
    };
  }

  async function makeDeps(config: ReturnType<typeof makeContainerConfig>) {
    const mod = await import("./setup-gateway-rpc.js");
    const container = {
      config,
      eventBus: { emit: vi.fn() },
    } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"];
    return mod.buildRpcAdapterDeps({
      container,
      gwConfig: config.gateway as never,
      agents: config.agents as never,
      defaultAgentId: "default",
      gatewayLogger: createMockLogger() as never,
      memoryApi: {} as never,
      sessionStore: {} as never,
      getExecutor: (() => ({})) as never,
      assembleToolsForAgent: (async () => []) as never,
      preprocessMessageText: (async (t: string) => t) as never,
      rpcCall: (async () => ({})) as never,
      costTrackers: new Map() as never,
      workspaceDirs: new Map() as never,
      activeExecutions: new Map() as never,
    });
  }

  async function makeGetConfig(config: ReturnType<typeof makeContainerConfig>) {
    return (await makeDeps(config)).getConfig;
  }

  it("does not egress apiKey-shaped values when getConfig requests the agents section", async () => {
    const getConfig = await makeGetConfig(makeContainerConfig());

    const res = await getConfig({ section: "agents" });
    const serialized = JSON.stringify(res);

    // RED on the verbatim passthrough: the `agents` section flows out wholesale.
    expect(serialized).not.toContain("sk-LEAK-TOKEN");
    expect(serialized).not.toContain("ANTHROPIC_API_KEY");
    expect(serialized).not.toContain("apiKey");
    // The non-allowlisted section must not be echoed back as its own key.
    expect((res as Record<string, unknown>).agents).toBeUndefined();
  });

  it("does not return the security section verbatim when getConfig requests it", async () => {
    const config = makeContainerConfig() as Record<string, unknown>;
    // security.secrets is the encrypted-store config block; never egress it.
    config.security = { secrets: { masterKeyPath: "/etc/comis/master.key", password: "pw-LEAK" } };
    const getConfig = await makeGetConfig(config as ReturnType<typeof makeContainerConfig>);

    const res = await getConfig({ section: "security" });
    const serialized = JSON.stringify(res);

    expect(serialized).not.toContain("pw-LEAK");
    expect(serialized).not.toContain("master.key");
    expect((res as Record<string, unknown>).security).toBeUndefined();
  });

  it("still returns the allowlisted gateway section as a non-secret projection", async () => {
    const getConfig = await makeGetConfig(makeContainerConfig());

    const res = await getConfig({ section: "gateway" });
    const gateway = (res as { gateway?: Record<string, unknown> }).gateway;

    // Allowlisted section is returned (regression guard) but only as the
    // {enabled,host,port} projection — never the raw object with tokens.
    expect(gateway).toEqual({ enabled: true, host: "127.0.0.1", port: 4766 });
    expect(JSON.stringify(res)).not.toContain("tok-GATEWAY-SECRET");
  });

  it("returns the safe default object unchanged for the no-section request", async () => {
    const getConfig = await makeGetConfig(makeContainerConfig());

    const res = await getConfig({});

    expect(res).toEqual({
      tenantId: "tenant-a",
      logLevel: "info",
      gateway: { enabled: true, host: "127.0.0.1", port: 4766 },
    });
  });

  it("listAgentSummaries returns only non-secret id/name/provider/model fields", async () => {
    const deps = await makeDeps(makeContainerConfig());

    // Dedicated non-secret projection for the dashboard's GET /api/agents.
    // `agents` was removed from getConfig's allowlist, so the REST listing
    // can no longer source agents from getConfig; this is its replacement.
    const summaries = deps.listAgentSummaries?.();

    expect(summaries).toEqual([
      { id: "default", name: "Comis", provider: "anthropic", model: "claude" },
    ]);
    // The same secret-shaped fields the getConfig egress test guards against
    // must NOT appear in this projection either.
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain("sk-LEAK-TOKEN");
    expect(serialized).not.toContain("ANTHROPIC_API_KEY");
    expect(serialized).not.toContain("apiKey");
  });

  it("listChannelSummaries returns only non-secret name/enabled fields (no tokens)", async () => {
    // makeContainerConfig has no channels; add one carrying a secret-shaped
    // token plus the internal healthCheck block to prove both are handled.
    const config = {
      ...makeContainerConfig(),
      channels: {
        telegram: { enabled: true, botToken: "tok-LEAK" },
        discord: { enabled: false },
        healthCheck: { enabled: true },
      },
    } as ReturnType<typeof makeContainerConfig>;
    const deps = await makeDeps(config);

    const summaries = deps.listChannelSummaries?.();

    // healthCheck excluded (not a chat adapter); bot token dropped.
    expect(summaries).toEqual([
      { name: "telegram", enabled: true },
      { name: "discord", enabled: false },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("tok-LEAK");
  });
});

describe("buildRpcAdapterDeps executeAgent unknown-agent guard", () => {
  // agent.execute with an explicit
  // but UNKNOWN agentId silently fell back to the default agent — so a request
  // addressed to a local $0 model (e.g. "qwen35") was answered by the paid
  // default provider with NO indication of the substitution. Silent cross-provider
  // spend + a routing-integrity hole (an operator typo bills the wrong model).
  // An ABSENT agentId must still default (intended); an explicit UNKNOWN one must
  // error before any execution/spend.
  async function makeExecDeps(agents: Record<string, unknown>) {
    const mod = await import("./setup-gateway-rpc.js");
    const getExecutor = vi.fn(() => ({ execute: vi.fn(async () => ({ response: "x", tokensUsed: { input: 0, output: 0, total: 0 }, finishReason: "stop", cost: { total: 0 }, stepsExecuted: 0, llmCalls: 0 })) }));
    const container = { config: { tenantId: "t" }, eventBus: { emit: vi.fn() } } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"];
    const deps = mod.buildRpcAdapterDeps({
      container,
      gwConfig: {} as never,
      agents: agents as never,
      defaultAgentId: "default",
      gatewayLogger: createMockLogger() as never,
      memoryApi: {} as never,
      sessionStore: { load: () => ok(undefined), save: () => ok(undefined) } as never,
      getExecutor: getExecutor as never,
      assembleToolsForAgent: (async () => []) as never,
      preprocessMessageText: (async (t: string) => t) as never,
      rpcCall: (async () => ({})) as never,
      costTrackers: new Map() as never,
      workspaceDirs: new Map() as never,
      piSessionAdapters: makePassingSessionAdapters(Object.keys(agents)) as never,
      activeExecutions: new Map() as never,
    });
    return { executeAgent: deps.executeAgent, getExecutor };
  }

  const baseParams = { message: "hi", scopes: ["*"], sessionKey: { userId: "u", channelId: "c", peerId: "p" } };

  it("rejects an explicit unknown agentId without executing (no silent fallback, no spend)", async () => {
    const { executeAgent, getExecutor } = await makeExecDeps({ default: { name: "d" } });
    await expect(
      executeAgent({ ...baseParams, agentId: "qwen35" } as never),
    ).rejects.toThrow(/unknown agent: qwen35/);
    // The fallback executed the default agent (billing) before this fix.
    expect(getExecutor).not.toHaveBeenCalled();
  });

  it("names the available agents in the error to aid the caller", async () => {
    const { executeAgent } = await makeExecDeps({ default: { name: "d" }, editor: { name: "e" } });
    await expect(
      executeAgent({ ...baseParams, agentId: "ghost" } as never),
    ).rejects.toThrow(/available:.*default.*editor|available:.*editor.*default/);
  });

  it("still defaults when agentId is ABSENT (intended) and executes the default agent", async () => {
    const { executeAgent, getExecutor } = await makeExecDeps({ default: { name: "d" } });
    await executeAgent({ ...baseParams } as never);
    expect(getExecutor).toHaveBeenCalledWith("default");
  });

  it("executes a known agentId unchanged", async () => {
    const { executeAgent, getExecutor } = await makeExecDeps({ default: { name: "d" }, qwen35: { name: "q" } });
    await executeAgent({ ...baseParams, agentId: "qwen35" } as never);
    expect(getExecutor).toHaveBeenCalledWith("qwen35");
  });
});

describe("buildRpcAdapterDeps executeAgent inbound provenance", () => {
  async function makeProvenanceDeps(options?: {
    persistResult?: { ok: true; value: undefined } | {
      ok: false;
      error: { error: Error; errorKind: "validation" | "resource" };
    };
    eventBus?: TypedEventBus;
    save?: (...args: unknown[]) => void;
  }) {
    const mod = await import("./setup-gateway-rpc.js");
    const order: string[] = [];
    const logger = createMockLogger();
    const emit = vi.fn((eventName: string, _payload?: unknown) => {
      if (eventName === "message:received") order.push("received");
    });
    const eventBus = options?.eventBus ?? {
      emit,
      emitSafely: vi.fn((eventName: string, payload: unknown) => {
        emit(eventName, payload);
        return {
          hadListeners: false,
          failures: [],
          pendingFailures: Promise.resolve([]),
        };
      }),
    };
    const execute = vi.fn(async () => {
      order.push("execute");
      return {
        response: "Done",
        tokensUsed: { input: 1, output: 1, total: 2 },
        finishReason: "stop",
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
      };
    });
    const persistInboundMessage = vi.fn(async () => {
      order.push("persist");
      return options?.persistResult ?? {
        ok: true as const,
        value: { payloads: [], ledgerContent: "" },
      };
    });
    const deps = mod.buildRpcAdapterDeps({
      container: {
        config: { tenantId: "tenant-a" },
        eventBus,
      } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"],
      gwConfig: {} as never,
      agents: { default: { name: "Default" } } as never,
      defaultAgentId: "default",
      gatewayLogger: logger,
      memoryApi: {} as never,
      sessionStore: {
        load: () => ok(undefined),
        save: options?.save ?? vi.fn(() => ok(undefined)),
      } as never,
      getExecutor: (() => ({ execute })) as never,
      assembleToolsForAgent: (async () => {
        order.push("tools");
        return [];
      }) as never,
      preprocessMessageText: (async (text: string) => {
        order.push("preprocess");
        return `enriched:${text}`;
      }) as never,
      rpcCall: (async () => ({})) as never,
      costTrackers: new Map() as never,
      workspaceDirs: new Map(),
      piSessionAdapters: new Map([[
        "default",
        {
          destroySession: vi.fn(),
          getSessionStats: vi.fn(),
          persistInboundMessage,
        },
      ]]) as never,
      activeExecutions: new Map() as never,
    });
    return { deps, emit, execute, logger, order, persistInboundMessage };
  }

  it("commits the exact gateway message before reception, preprocessing, tools, and direct execution", async () => {
    const { deps, execute, order, persistInboundMessage } = await makeProvenanceDeps();

    await deps.executeAgent({
      message: "User-authored gateway text",
      locale: "ar",
      sessionKey: { userId: "user_a", channelId: "gateway-channel", peerId: "peer_a" },
      scopes: ["rpc"],
    } as Parameters<typeof deps.executeAgent>[0] & { locale: string });

    expect(order).toEqual(["persist", "received", "preprocess", "tools", "execute"]);
    const [persistedSessionKey, persistedMessage] = persistInboundMessage.mock.calls[0]!;
    expect(persistedSessionKey).toMatchObject({
      tenantId: "tenant-a",
      agentId: "default",
      userId: "gateway-anonymous",
      peerId: "gateway-anonymous",
    });
    expect(persistedMessage).toMatchObject({
      channelType: "gateway",
      channelId: persistedSessionKey.channelId,
      senderId: "peer_a",
      text: "User-authored gateway text",
      metadata: { locale: "ar" },
    });
    expect(execute.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      text: "enriched:User-authored gateway text",
      metadata: { locale: "ar" },
      originalMessages: [expect.objectContaining({ text: "User-authored gateway text" })],
    }));
  });

  it("fails closed with actionable logging and terminal events when the gateway ledger commit fails", async () => {
    const persistenceError = new Error("ledger unavailable");
    const { deps, emit, execute, logger, order, persistInboundMessage } = await makeProvenanceDeps({
      persistResult: {
        ok: false,
        error: { error: persistenceError, errorKind: "resource" },
      },
    });

    await expect(deps.executeAgent({
      message: "Do not execute without a ledger",
      sessionKey: { userId: "user_a", channelId: "gateway-channel", peerId: "peer_a" },
      scopes: ["rpc"],
    })).rejects.toBe(persistenceError);

    expect(order).toEqual(["persist"]);
    expect(persistInboundMessage).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "default",
        channelType: "gateway",
        step: "session-provenance",
        hint: expect.any(String),
        errorKind: "resource",
      }),
      "Gateway inbound message provenance persistence failed",
    );
    const persistedMessage = persistInboundMessage.mock.calls[0]?.[1];
    expect(emit).toHaveBeenCalledWith("message:terminal", {
      channelType: "gateway",
      channelId: persistedMessage?.channelId,
      sourceMessageId: persistedMessage?.id,
      outcome: "error",
      reason: "inbound_rejected",
      timestamp: expect.any(Number),
    });
    expect(emit).toHaveBeenCalledWith("system:error", {
      error: persistenceError,
      source: "gateway-session-provenance",
    });
    expect(emit).not.toHaveBeenCalledWith(
      "message:received",
      expect.anything(),
    );
  });

  it("contains history and sent-event subscriber failures while preserving the execution result and later observers", async () => {
    const eventBus = new TypedEventBus();
    const laterSystemObserver = vi.fn();
    const laterSentObserver = vi.fn();
    eventBus.on("system:error", () => {
      throw new Error("private history subscriber payload");
    });
    eventBus.on("system:error", laterSystemObserver);
    eventBus.on("message:sent", () => {
      throw new Error("private response subscriber payload");
    });
    eventBus.on("message:sent", laterSentObserver);
    const { deps, execute, logger } = await makeProvenanceDeps({
      eventBus,
      save: () => {
        return err(Object.assign(new Error("session store unavailable"), {
          errorKind: "resource" as const,
        }));
      },
    });

    const result = await deps.executeAgent({
      message: "User-authored gateway text",
      sessionKey: { userId: "user_a", channelId: "gateway-channel", peerId: "peer_a" },
      scopes: ["rpc"],
    });

    expect(result.response).toBe("Done");
    expect(execute).toHaveBeenCalledOnce();
    expect(laterSystemObserver).toHaveBeenCalledTimes(2);
    expect(laterSentObserver).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private history subscriber payload");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private response subscriber payload");
  });
});

describe("buildRpcAdapterDeps executeAgent request context", () => {
  it("isolates identical caller-selected sessions by authenticated gateway client", async () => {
    const mod = await import("./setup-gateway-rpc.js");
    const executedKeys: SessionKey[] = [];
    const savedOwners: unknown[] = [];
    const sessionStore = {
      load: vi.fn(() => ok(undefined)),
      save: vi.fn((_scope: unknown, _messages: unknown[], metadata?: Record<string, unknown>) => {
        savedOwners.push(metadata?.gatewayClientId);
        return ok(undefined);
      }),
    };
    const deps = mod.buildRpcAdapterDeps({
      container: {
        config: { tenantId: "tenant-a" },
        eventBus: { emit: vi.fn() },
      } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"],
      gwConfig: {} as never,
      agents: { default: { name: "Default" } } as never,
      defaultAgentId: "default",
      gatewayLogger: createMockLogger() as never,
      memoryApi: {} as never,
      sessionStore: sessionStore as never,
      getExecutor: (() => ({
        execute: vi.fn(async (_message: unknown, key: SessionKey) => {
          executedKeys.push(key);
          return {
            response: "Done",
            tokensUsed: { input: 1, output: 1, total: 2 },
            finishReason: "stop",
            cost: { total: 0 },
            stepsExecuted: 0,
            llmCalls: 1,
          };
        }),
      })) as never,
      assembleToolsForAgent: (async () => []) as never,
      preprocessMessageText: (async (text: string) => text) as never,
      rpcCall: (async () => ({})) as never,
      costTrackers: new Map() as never,
      workspaceDirs: new Map(),
      piSessionAdapters: makePassingSessionAdapters(["default", "specialist"]) as never,
      activeExecutions: new Map() as never,
    });
    const selectedSession = {
      userId: "caller-selected-user",
      channelId: "shared-channel",
      peerId: "shared-peer",
    };

    await deps.executeAgent({
      message: "From A",
      clientId: "client-a",
      sessionKey: selectedSession,
      scopes: ["rpc"],
    });
    await deps.executeAgent({
      message: "From B",
      clientId: "client-b",
      sessionKey: selectedSession,
      scopes: ["rpc"],
    });

    expect(executedKeys).toHaveLength(2);
    expect(executedKeys[0]?.channelId).toBe(executedKeys[1]?.channelId);
    expect(executedKeys[0]?.peerId).not.toBe(executedKeys[1]?.peerId);
    expect(executedKeys[0]?.userId).not.toBe("caller-selected-user");
    expect(executedKeys[1]?.userId).not.toBe("caller-selected-user");
    expect(formatSessionKey(executedKeys[0]!)).not.toBe(formatSessionKey(executedKeys[1]!));
    expect(savedOwners).toEqual(["client-a", "client-a", "client-b", "client-b"]);
  });

  it("uses resolved client authority instead of persisted display metadata", async () => {
    const mod = await import("./setup-gateway-rpc.js");
    const execute = vi.fn(async () => ({
      response: "Done",
      tokensUsed: { input: 1, output: 1, total: 2 },
      finishReason: "stop",
      cost: { total: 0 },
      stepsExecuted: 0,
      llmCalls: 1,
    }));
    const getExecutor = vi.fn(() => ({ execute }));
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("system:error", () => {
      throw new Error("private ownership subscriber payload");
    });
    eventBus.on("system:error", laterObserver);
    const logger = createMockLogger();
    const deps = mod.buildRpcAdapterDeps({
      container: {
        config: { tenantId: "tenant-a" },
        eventBus,
      } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"],
      gwConfig: {} as never,
      agents: { default: { name: "Default" } } as never,
      defaultAgentId: "default",
      gatewayLogger: logger as never,
      memoryApi: {} as never,
      sessionStore: {
        load: () => ok({
          messages: [],
          metadata: { agentId: "default", gatewayClientId: "client-a" },
          createdAt: 1,
          updatedAt: 1,
        }),
        save: vi.fn(() => ok(undefined)),
      } as never,
      getExecutor: getExecutor as never,
      assembleToolsForAgent: (async () => []) as never,
      preprocessMessageText: (async (text: string) => text) as never,
      rpcCall: (async () => ({})) as never,
      costTrackers: new Map() as never,
      workspaceDirs: new Map(),
      piSessionAdapters: makePassingSessionAdapters(["default", "specialist"]) as never,
      activeExecutions: new Map() as never,
    });

    await expect(deps.executeAgent({
      message: "Continue",
      clientId: "client-b",
      sessionKey: { userId: "ignored", channelId: "shared", peerId: "peer" },
      scopes: ["rpc"],
    })).resolves.toEqual(expect.objectContaining({ response: "Done" }));
    expect(getExecutor).toHaveBeenCalledWith("default");
    expect(laterObserver).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      "private ownership subscriber payload",
    );
  });

  it("uses resolved agent authority instead of persisted display metadata", async () => {
    const mod = await import("./setup-gateway-rpc.js");
    const execute = vi.fn(async () => ({
      response: "Done",
      tokensUsed: { input: 1, output: 1, total: 2 },
      finishReason: "stop",
      cost: { total: 0 },
      stepsExecuted: 0,
      llmCalls: 1,
    }));
    const getExecutor = vi.fn(() => ({ execute }));
    const deps = mod.buildRpcAdapterDeps({
      container: {
        config: { tenantId: "tenant-a" },
        eventBus: { emit: vi.fn() },
      } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"],
      gwConfig: {} as never,
      agents: { default: { name: "Default" }, specialist: { name: "Specialist" } } as never,
      defaultAgentId: "default",
      gatewayLogger: createMockLogger() as never,
      memoryApi: {} as never,
      sessionStore: {
        load: () => ok({ messages: [], metadata: { agentId: "default" }, createdAt: 1, updatedAt: 1 }),
        save: vi.fn(() => ok(undefined)),
      } as never,
      getExecutor: getExecutor as never,
      assembleToolsForAgent: (async () => []) as never,
      preprocessMessageText: (async (text: string) => text) as never,
      rpcCall: (async () => ({})) as never,
      costTrackers: new Map() as never,
      workspaceDirs: new Map(),
      piSessionAdapters: makePassingSessionAdapters(["default", "specialist"]) as never,
      activeExecutions: new Map() as never,
    });

    await expect(deps.executeAgent({
      agentId: "specialist",
      message: "Continue",
      sessionKey: { userId: "user_a", channelId: "gateway-channel", peerId: "peer_a" },
      scopes: ["rpc"],
    })).resolves.toEqual(expect.objectContaining({ response: "Done" }));
    expect(getExecutor).toHaveBeenCalledWith("specialist");
  });

  it("keeps one resolved context through preprocessing, tool assembly, and execution", async () => {
    const observedContexts: Array<RequestContext | undefined> = [];
    const observedStartedAt: Array<number | undefined> = [];
    const observeContext = (): void => {
      const context = tryGetContext();
      observedContexts.push(context);
      observedStartedAt.push(context?.startedAt);
    };
    const mod = await import("./setup-gateway-rpc.js");
    const deps = mod.buildRpcAdapterDeps({
      container: {
        config: { tenantId: "tenant-a" },
        eventBus: { emit: vi.fn() },
      } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"],
      gwConfig: {} as never,
      agents: {
        default: { name: "Default" },
        specialist: { name: "Specialist" },
      } as never,
      defaultAgentId: "default",
      gatewayLogger: createMockLogger() as never,
      memoryApi: {} as never,
      sessionStore: { load: () => ok(undefined), save: () => ok(undefined) } as never,
      getExecutor: vi.fn(() => ({
        execute: vi.fn(async () => {
          observeContext();
          return {
            response: "Done",
            tokensUsed: { input: 1, output: 1, total: 2 },
            finishReason: "stop",
            cost: { total: 0 },
            stepsExecuted: 0,
            llmCalls: 1,
          };
        }),
      })) as never,
      assembleToolsForAgent: vi.fn(async () => {
        observeContext();
        return [];
      }) as never,
      preprocessMessageText: vi.fn(async (text: string) => {
        observeContext();
        return text;
      }) as never,
      rpcCall: (async () => ({})) as never,
      costTrackers: new Map() as never,
      workspaceDirs: new Map(),
      piSessionAdapters: makePassingSessionAdapters(["default", "specialist"]) as never,
      activeExecutions: new Map() as never,
    });

    await deps.executeAgent({
      agentId: "specialist",
      message: "Continue",
      clientId: "dashboard-a",
      sessionKey: {
        userId: "user_a",
        channelId: "gateway-channel",
        peerId: "peer_a",
      },
      scopes: ["admin"],
    });

    expect(observedContexts).toHaveLength(3);
    const [preprocessContext, toolsContext, executorContext] = observedContexts;
    expect(preprocessContext).toBeDefined();
    expect(toolsContext).toBe(preprocessContext);
    expect(executorContext).toBe(preprocessContext);
    expect(preprocessContext).toMatchObject({
      tenantId: "tenant-a",
      agentId: "specialist",
      clientId: "dashboard-a",
      trustLevel: "admin",
      channelType: "gateway",
      deliveryOrigin: {
        channelType: "gateway",
        channelId: 'control-plane:gateway:["gateway-channel","peer_a"]',
        tenantId: "tenant-a",
      },
    });
    expect(preprocessContext?.userId).toMatch(/^gateway-[a-f0-9]{64}$/);
    expect(preprocessContext?.deliveryOrigin?.userId).toBe(preprocessContext?.userId);
    expect(preprocessContext?.turnScope?.conversation).toMatchObject({
      tenantId: "tenant-a",
      agentId: "specialist",
      partition: {
        kind: "endpoint-conversation-principal",
        principalId: preprocessContext?.userId,
        endpoint: {
          channelType: "control-plane",
          conversationId: '["gateway-channel","peer_a"]',
        },
      },
    });
    expect(preprocessContext?.startedAt).toEqual(expect.any(Number));
    expect(preprocessContext?.startedAt).toBeGreaterThan(0);
    expect(observedStartedAt).toEqual([
      preprocessContext?.startedAt,
      preprocessContext?.startedAt,
      preprocessContext?.startedAt,
    ]);
    expect(Reflect.set(preprocessContext!, "trustLevel", "guest")).toBe(false);
    expect(Reflect.set(preprocessContext!, "agentId", "forged-agent")).toBe(false);
  });
});

describe("buildRpcAdapterDeps attachment history bridge", () => {
  it("persists the user before attachments and appends the response afterward", async () => {
    const marker = '<!-- attachment:{"url":"/media/image.png","type":"image","mimeType":"image/png","fileName":"image.png"} -->';
    let stored = {
      messages: [] as Array<{ role: string; content: string; timestamp: number }>,
      metadata: {
        label: "Pinned chat",
        agentId: "default",
        gatewayClientId: "dashboard-a",
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const sessionStore = {
      load: vi.fn(() => ok(stored)),
      save: vi.fn((_key: SessionKey, messages: unknown[], metadata?: Record<string, unknown>) => {
        stored = {
          ...stored,
          messages: messages as typeof stored.messages,
          metadata: metadata ?? {},
        };
        return ok(undefined);
      }),
    };
    const logger = createMockLogger();
    const persistAttachment = createGatewayAttachmentPersister({
      sessionStore: sessionStore as never,
      clock: createFakeClock(1_700_000_000_000),
      logger,
      emitSystemError: vi.fn(),
    });
    const execute = vi.fn(async () => {
      expect(stored.messages.map((message) => message.content)).toEqual(["Show the image"]);
      expect(tryGetContext()?.clientId).toBe("dashboard-a");
      const conversation = tryGetContext()?.turnScope?.conversation;
      expect(conversation).toBeDefined();
      const projectedSessionKey = conversationScopeToSessionKey(conversation!);
      expect(projectedSessionKey.ok).toBe(true);
      if (!projectedSessionKey.ok) throw projectedSessionKey.error;
      persistAttachment(projectedSessionKey.value, marker);
      return {
        response: "Done",
        tokensUsed: { input: 1, output: 1, total: 2 },
        finishReason: "stop",
        cost: { total: 0 },
        stepsExecuted: 1,
        llmCalls: 1,
      };
    });
    const mod = await import("./setup-gateway-rpc.js");
    const deps = mod.buildRpcAdapterDeps({
      container: {
        config: { tenantId: "tenant-a" },
        eventBus: { emit: vi.fn() },
      } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"],
      gwConfig: {} as never,
      agents: { default: { name: "Default" } } as never,
      defaultAgentId: "default",
      gatewayLogger: logger,
      memoryApi: {} as never,
      sessionStore: sessionStore as never,
      getExecutor: (() => ({ execute })) as never,
      assembleToolsForAgent: (async () => []) as never,
      preprocessMessageText: (async (text: string) => text) as never,
      rpcCall: (async () => ({})) as never,
      costTrackers: new Map() as never,
      workspaceDirs: new Map(),
      piSessionAdapters: makePassingSessionAdapters() as never,
      activeExecutions: new Map() as never,
    });

    await deps.executeAgent({
      message: "Show the image",
      clientId: "dashboard-a",
      sessionKey: { userId: "user_a", channelId: "history-channel", peerId: "user_a" },
      scopes: ["rpc"],
    });

    expect(stored.metadata).toEqual({
      label: "Pinned chat",
      agentId: "default",
      gatewayClientId: "dashboard-a",
    });

    expect(stored.messages.map((message) => message.content)).toEqual([
      "Show the image",
      marker,
      "Done",
    ]);
  });

  it("warns with recovery guidance when main history persistence fails", async () => {
    const logger = createMockLogger();
    const emit = vi.fn();
    const sessionStore = {
      load: vi.fn(() => ok(undefined)),
      save: vi.fn(() => err(Object.assign(new Error("database is locked"), {
        errorKind: "resource" as const,
      }))),
    };
    const mod = await import("./setup-gateway-rpc.js");
    const deps = mod.buildRpcAdapterDeps({
      container: {
        config: { tenantId: "tenant-a" },
        eventBus: {
          emit,
          emitSafely: vi.fn((eventName: string, payload: unknown) => {
            emit(eventName, payload);
            return {
              hadListeners: false,
              failures: [],
              pendingFailures: Promise.resolve([]),
            };
          }),
        },
      } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"],
      gwConfig: {} as never,
      agents: { default: { name: "Default" } } as never,
      defaultAgentId: "default",
      gatewayLogger: logger,
      memoryApi: {} as never,
      sessionStore: sessionStore as never,
      getExecutor: (() => ({
        execute: vi.fn(async () => ({
          response: "Done",
          tokensUsed: { input: 1, output: 1, total: 2 },
          finishReason: "stop",
          cost: { total: 0 },
          stepsExecuted: 1,
          llmCalls: 1,
        })),
      })) as never,
      assembleToolsForAgent: (async () => []) as never,
      preprocessMessageText: (async (text: string) => text) as never,
      rpcCall: (async () => ({})) as never,
      costTrackers: new Map() as never,
      workspaceDirs: new Map(),
      piSessionAdapters: makePassingSessionAdapters() as never,
      activeExecutions: new Map() as never,
    });

    await expect(deps.executeAgent({
      message: "Continue",
      sessionKey: { userId: "user_a", channelId: "history-channel", peerId: "user_a" },
      scopes: ["rpc"],
    })).resolves.toEqual(expect.objectContaining({ response: "Done" }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.stringContaining("database is locked"),
        hint: expect.any(String),
        errorKind: "resource",
      }),
      "Gateway session history persistence failed",
    );
    expect(emit).toHaveBeenCalledWith("system:error", {
      error: expect.objectContaining({ message: "database is locked" }),
      source: "gateway-session-history",
    });
  });

  it("preserves canonical attachment history without injecting a second marker format", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "comis-attachment-history-"));
    const channelId = "history-channel";
    const jsonlDir = join(workspaceDir, "sessions", "default", channelId);
    mkdirSync(jsonlDir, { recursive: true });

    const historicalMediaId = "bbbbbbbbbbbbbbbb.jpg";
    writeFileSync(join(jsonlDir, "default.jsonl"), [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            name: "message",
            id: "tool-attachment",
            arguments: {
              action: "attach",
              channel_type: "gateway",
              attachment_type: "image",
              mime_type: "image/jpeg",
              file_name: "historical.jpg",
            },
          }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tool-attachment",
          content: `Attachment delivered (mediaId: ${historicalMediaId})`,
        },
      }),
    ].join("\n"));

    const canonicalMediaId = "aaaaaaaaaaaaaaaa.png";
    const canonicalMarker = `Current image\n\n<!-- attachment:${JSON.stringify({
      url: `/media/${canonicalMediaId}`,
      type: "image",
      mimeType: "image/png",
      fileName: "current.png",
    })} -->`;
    let stored = {
      messages: [{ role: "assistant", content: canonicalMarker, timestamp: 1 }],
      metadata: { agentId: "default" },
      createdAt: 1,
      updatedAt: 1,
    };
    const sessionStore = {
      load: vi.fn(() => ok(stored)),
      save: vi.fn((_key: unknown, messages: unknown[]) => {
        stored = { ...stored, messages: messages as typeof stored.messages };
        return ok(undefined);
      }),
    };

    try {
      const mod = await import("./setup-gateway-rpc.js");
      const deps = mod.buildRpcAdapterDeps({
        container: {
          config: { tenantId: "tenant-a" },
          eventBus: { emit: vi.fn() },
        } as unknown as Parameters<typeof mod.buildRpcAdapterDeps>[0]["container"],
        gwConfig: {} as never,
        agents: { default: { name: "Default" } } as never,
        defaultAgentId: "default",
        gatewayLogger: createMockLogger() as never,
        memoryApi: {} as never,
        sessionStore: sessionStore as never,
        getExecutor: (() => ({
          execute: vi.fn(async () => ({
            response: "Done",
            tokensUsed: { input: 1, output: 1, total: 2 },
            finishReason: "stop",
            cost: { total: 0 },
            stepsExecuted: 1,
            llmCalls: 1,
          })),
        })) as never,
        assembleToolsForAgent: (async () => []) as never,
        preprocessMessageText: (async (text: string) => text) as never,
        rpcCall: (async () => ({})) as never,
        costTrackers: new Map() as never,
        workspaceDirs: new Map([["default", workspaceDir]]),
        piSessionAdapters: makePassingSessionAdapters() as never,
        activeExecutions: new Map() as never,
      });

      await deps.executeAgent({
        message: "Continue",
        sessionKey: { userId: "user_a", channelId, peerId: "user_a" },
        scopes: ["rpc"],
      });

      const savedMessages = sessionStore.save.mock.calls.at(-1)?.[1] as Array<{ content?: string }>;
      const attachmentMessages = savedMessages.filter((message) => message.content?.includes("<!-- attachment:"));
      expect(attachmentMessages).toEqual([
        expect.objectContaining({ content: canonicalMarker }),
      ]);
      expect(JSON.stringify(savedMessages)).not.toContain("attachment:type=");
      expect(JSON.stringify(savedMessages)).not.toContain(`/media/${historicalMediaId.replace(".jpg", "")}`);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("setup-gateway-rpc source guard", () => {
  it("wires buildExecutionRequestedLogFields into the executeAgent log call and removes the raw-message logger pattern", async () => {
    // The executeAgent adapter that consumes buildExecutionRequestedLogFields
    // lives in setup-gateway-rpc.ts (buildRpcAdapterDeps body).
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./setup-gateway-rpc.ts", import.meta.url).pathname,
      "utf-8",
    );
    // Forward proof: helper is wired in.
    expect(source).toContain("buildExecutionRequestedLogFields(");
    // Backward proof: offending raw-message log call is gone.
    expect(source).not.toContain("message: rawMsg.slice(");
    // Cleanup proof: dead field reference gone.
    expect(source).not.toContain("messageTruncated");
  });
});
