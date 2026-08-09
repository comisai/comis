// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  createConversationRef,
  runWithContext,
  type ComisLogger,
  type ManagedRunRecord,
  type RequestContext,
} from "@comis/core";
import {
  MCP_CAPABILITY_CALL_CONTEXT_KEY,
  MCP_MANAGED_RUN_RESULT_KEY,
} from "@comis/capability-service-sdk";
import { ok } from "@comis/shared";
import { createManagedMcpPrivateMetadataBridge } from "./managed-mcp-private-metadata.js";

const NOW_MS = 1_800_000_000_000;
const POLICY_HASH = "b".repeat(64);

const TURN_SCOPE = {
  conversation: {
    tenantId: "tenant_a",
    agentId: "agent_a",
    partition: {
      kind: "endpoint-conversation-principal" as const,
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "channel-instance_a",
        conversationId: "conversation_a",
        threadId: "thread_a",
        conversationKind: "direct" as const,
      },
      principalId: "principal_a",
    },
  },
  principal: { principalId: "principal_a" },
  endpoint: {
    channelType: "telegram",
    channelInstanceId: "channel-instance_a",
    conversationId: "conversation_a",
    threadId: "thread_a",
    conversationKind: "direct" as const,
  },
};

const conversationRef = createConversationRef(TURN_SCOPE.conversation);
if (!conversationRef.ok) throw conversationRef.error;

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

function makeContext(overrides: Record<string, unknown> = {}): RequestContext {
  return {
    tenantId: "tenant_a",
    userId: "principal_a",
    sessionKey: "tenant_a:principal_a:telegram:conversation_a",
    agentId: "agent_a",
    rootRunId: "root-run_a",
    turnScope: TURN_SCOPE,
    traceId: "10000000-0000-4000-8000-000000000001",
    startedAt: NOW_MS,
    trustLevel: "user",
    channelType: "telegram",
    deliveryOrigin: {
      channelType: "telegram",
      channelId: "conversation_a",
      userId: "principal_a",
      threadId: "thread_a",
      tenantId: "tenant_a",
    },
    workspacePolicyHash: POLICY_HASH,
    responseLocalePolicy: {
      locale: "en",
      source: "request",
      enforceLocale: true,
    },
    ...overrides,
  } as unknown as RequestContext;
}

function makeView(behavior: "prepare_run" | "run_command" = "prepare_run") {
  return {
    viewHash: "c".repeat(64),
    definitions: [{
      contributionId: "example.service",
      serviceDefinitionId: "example.service-definition",
      mcpServerName: "fixture-service",
      managedToolBindings: [{
        toolName: behavior === "prepare_run" ? "prepare_work" : "send_command",
        behavior,
        ...(behavior === "run_command" ? { runHandleArgument: "run_handle" } : {}),
        actionClassification: "mutate" as const,
        invocationSideEffects: ["deferred_work"],
      }],
      requestedScopes: ["health", "report"] as const,
    }],
    instances: [{
      contributionId: "example.service",
      serviceDefinitionId: "example.service-definition",
      serviceInstanceId: "service-instance_a",
      mcpServerName: "fixture-service",
      allowedAgents: ["agent_a"],
      state: "active" as const,
      activeScopes: ["health", "report"] as const,
    }],
  };
}

function makeCall(
  toolName = "prepare_work",
  params: Readonly<Record<string, unknown>> = {},
) {
  return {
    serverName: "fixture-service",
    toolName,
    qualifiedName: `mcp:fixture-service/${toolName}`,
    toolCallId: "tool-call_a",
    params,
  };
}

function makePreparedMeta(overrides: Record<string, unknown> = {}) {
  return {
    [MCP_MANAGED_RUN_RESULT_KEY]: {
      state: "prepared",
      externalRunRef: "external-run_a",
      registrationNonce: "registration-nonce_a",
      expiresAt: new Date(NOW_MS + 60_000).toISOString(),
      displayLabel: "Synthetic managed run",
      ...overrides,
    },
  };
}

function makeDeps(
  overrides: Record<string, unknown> = {},
) {
  return {
    agentId: "agent_a",
    activeView: makeView(),
    capturedAgentCapabilities: ["orch:read", "orch:web"] as const,
    getCapturedToolIds: () => ["mcp:fixture-service/prepare_work", "web_search"],
    nowMs: () => NOW_MS,
    resolveRootRunId: () => ok("root-run_a"),
    getManagedRun: vi.fn(async () => ok(undefined)),
    activatePrepared: vi.fn(async () => ok({ kind: "activated" as const })),
    logger: makeLogger(),
    ...overrides,
  };
}

describe("managed MCP private metadata boundary", () => {
  it("injects exact host call context and activates a valid prepared result", async () => {
    const deps = makeDeps();
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const call = makeCall();

    await runWithContext(makeContext(), async () => {
      const request = await bridge.createRequestMeta(call);
      expect(request.ok).toBe(true);
      if (!request.ok) return;
      expect(request.value).toEqual({
        [MCP_CAPABILITY_CALL_CONTEXT_KEY]: {
          operationId: expect.stringMatching(/^mcp-[a-f0-9]{48}$/),
          serviceInstanceId: "service-instance_a",
          agentId: "agent_a",
          conversationRef: conversationRef.value,
          workspacePolicyHash: POLICY_HASH,
          rootRunId: "root-run_a",
          traceId: "10000000-0000-4000-8000-000000000001",
        },
      });

      const accepted = await bridge.acceptResultMeta({ ...call, meta: makePreparedMeta() });
      expect(accepted.ok).toBe(true);
    });

    expect(deps.activatePrepared).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expect.stringMatching(/^mcp-[a-f0-9]{48}$/),
      serviceInstanceId: "service-instance_a",
      prepared: {
        state: "prepared",
        externalRunRef: "external-run_a",
        registrationNonce: "registration-nonce_a",
        expiresAtMs: NOW_MS + 60_000,
        displayLabel: "Synthetic managed run",
      },
      authority: expect.objectContaining({
        tenantId: "tenant_a",
        agentId: "agent_a",
        principalId: "principal_a",
        conversationRef: conversationRef.value,
        workspacePolicyHash: POLICY_HASH,
        capturedCapabilityViewHash: "c".repeat(64),
        capturedAgentCapabilities: ["orch:read", "orch:web"],
        capturedToolIds: ["mcp:fixture-service/prepare_work", "web_search"],
      }),
    }));
  });

  it("passes a validated workspace request into managed-run activation", async () => {
    const deps = makeDeps();
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const call = makeCall();

    const accepted = await runWithContext(makeContext(), async () => {
      expect((await bridge.createRequestMeta(call)).ok).toBe(true);
      return bridge.acceptResultMeta({
        ...call,
        meta: makePreparedMeta({
          requestedWorkspace: { rootHint: "/srv/comis-workspaces/task-a" },
        }),
      });
    });

    expect(accepted.ok).toBe(true);
    expect(deps.activatePrepared).toHaveBeenCalledWith(expect.objectContaining({
      prepared: expect.objectContaining({
        requestedWorkspace: { rootHint: "/srv/comis-workspaces/task-a" },
      }),
    }));
  });

  it("rejects prepared metadata after active-turn policy ownership changes", async () => {
    const deps = makeDeps();
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const call = makeCall();
    const context = makeContext();

    const accepted = await runWithContext(context, async () => {
      const request = await bridge.createRequestMeta(call);
      expect(request.ok).toBe(true);
      context.workspacePolicyHash = "d".repeat(64);
      return bridge.acceptResultMeta({ ...call, meta: makePreparedMeta() });
    });

    expect(accepted.ok).toBe(false);
    expect(deps.activatePrepared).not.toHaveBeenCalled();
  });

  it.each([
    ["short nonce", { registrationNonce: "short" }],
    ["expired preparation", { expiresAt: new Date(NOW_MS).toISOString() }],
    ["unknown extension field", { injectedAuthority: "admin" }],
    ["oversized extension", { displayLabel: "x".repeat(70_000) }],
  ])("rejects %s before managed-run activation", async (_label, extension) => {
    const deps = makeDeps();
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const call = makeCall();

    const accepted = await runWithContext(makeContext(), async () => {
      const request = await bridge.createRequestMeta(call);
      expect(request.ok).toBe(true);
      return bridge.acceptResultMeta({ ...call, meta: makePreparedMeta(extension) });
    });

    expect(accepted.ok).toBe(false);
    expect(deps.activatePrepared).not.toHaveBeenCalled();
  });

  it("resolves a run-command handle through the exact owner scope", async () => {
    const record = {
      managedRunId: "managed-run_a",
      serviceInstanceId: "service-instance_a",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationRef.value,
    } as ManagedRunRecord;
    const getManagedRun = vi.fn(async () => ok(record));
    const deps = makeDeps({
      activeView: makeView("run_command"),
      getManagedRun,
      getCapturedToolIds: () => ["mcp:fixture-service/send_command"],
    });
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const call = makeCall("send_command", { run_handle: "managed-run_a", command: "status" });

    const request = await runWithContext(makeContext(), () => bridge.createRequestMeta(call));

    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(request.value?.[MCP_CAPABILITY_CALL_CONTEXT_KEY]).toMatchObject({
      managedRunId: "managed-run_a",
    });
    expect(getManagedRun).toHaveBeenCalledWith({
      kind: "owner",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationRef.value,
    }, "managed-run_a");
  });

  it("rejects managed metadata from an unbound tool despite server-authored claims", async () => {
    const deps = makeDeps();
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const hostileCall = makeCall("hostile_starter");

    const outcome = await runWithContext(makeContext(), async () => {
      const request = await bridge.createRequestMeta(hostileCall);
      expect(request).toEqual(ok(undefined));
      return bridge.acceptResultMeta({ ...hostileCall, meta: makePreparedMeta() });
    });

    expect(outcome.ok).toBe(false);
    expect(deps.activatePrepared).not.toHaveBeenCalled();
  });
});
