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

function makeView(
  behavior: "prepare_run" | "prepare_run_group" | "run_command" = "prepare_run",
  actionClassification: "read" | "mutate" | "destructive" = "mutate",
) {
  return {
    viewHash: "c".repeat(64),
    definitions: [{
      contributionId: "example.service",
      serviceDefinitionId: "example.service-definition",
      mcpServerName: "fixture-service",
      managedToolBindings: [{
        toolName: behavior === "prepare_run"
          ? "prepare_work"
          : behavior === "prepare_run_group"
            ? "prepare_initiative"
            : "send_command",
        behavior,
        ...(behavior === "run_command" ? { runHandleArgument: "run_handle" } : {}),
        actionClassification,
        invocationSideEffects: ["deferred_work"],
      }],
      requestedScopes: ["health", "report"] as const,
      evidencePolicies: [] as const,
    }],
    instances: [{
      contributionId: "example.service",
      serviceDefinitionId: "example.service-definition",
      serviceInstanceId: "service-instance_a",
      mcpServerName: "fixture-service",
      allowedAgents: ["agent_a"],
      allowedWorkspaceRoots: [],
      allowedRuntimeRoots: [],
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
    [MCP_MANAGED_RUN_RESULT_KEY]: makePreparedResult(overrides),
  };
}

function makePreparedResult(overrides: Record<string, unknown> = {}) {
  return {
    state: "prepared",
    externalRunRef: "external-run_a",
    registrationNonce: "registration-nonce_a",
    expiresAt: new Date(NOW_MS + 60_000).toISOString(),
    displayLabel: "Synthetic managed run",
    ...overrides,
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
    getManagedRunByExternalRef: vi.fn(async () => ok(undefined)),
    activatePrepared: vi.fn(async () => ok({ kind: "activated" as const })),
    activatePreparedGroup: vi.fn(async () => ok({ kind: "activated" as const })),
    logger: makeLogger(),
    ...overrides,
  };
}

describe("managed MCP private metadata boundary", () => {
  it("exposes exact binding metadata for tool registration", () => {
    const bridge = createManagedMcpPrivateMetadataBridge(makeDeps());
    const call = makeCall();

    expect(bridge.resolveRegistrationMetadata?.({
      serverName: call.serverName,
      toolName: call.toolName,
      qualifiedName: call.qualifiedName,
    })).toEqual({
      actionClassification: "mutate",
      invocationSideEffects: ["deferred_work"],
    });
  });

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

  it("activates a complete prepared group through one private host binding", async () => {
    const activeView = makeView("prepare_run_group");
    const deps = makeDeps({
      activeView: {
        ...activeView,
        instances: [{
          ...activeView.instances[0]!,
          activeScopes: ["health", "managed_run_group", "workspace_lease", "execution_attachment"],
        }],
      },
      getCapturedToolIds: () => ["mcp:fixture-service/prepare_initiative"],
    });
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const call = makeCall("prepare_initiative");

    const accepted = await runWithContext(makeContext(), async () => {
      expect((await bridge.createRequestMeta(call)).ok).toBe(true);
      return bridge.acceptResultMeta({
        ...call,
        meta: {
          [MCP_MANAGED_RUN_RESULT_KEY]: {
            state: "prepared",
            registrationNonce: "group-registration-nonce_a",
            expiresAt: new Date(NOW_MS + 60_000).toISOString(),
            members: [{
              state: "prepared",
              externalRunRef: "external-run_group-member-a",
              registrationNonce: "registration-nonce_group-member-a",
              expiresAt: new Date(NOW_MS + 60_000).toISOString(),
              requestedWorkspace: { rootHint: "/srv/comis-workspaces/group-task-a" },
              requestedAttachment: {
                kind: "unix_socket",
                sourcePath: "/srv/comis-runtime/group-task-a/reporter.sock",
              },
            }],
          },
        },
      });
    });

    expect(accepted.ok).toBe(true);
    expect(deps.activatePrepared).not.toHaveBeenCalled();
    expect(deps.activatePreparedGroup).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expect.stringMatching(/^mcp-[a-f0-9]{48}$/),
      serviceInstanceId: "service-instance_a",
      prepared: expect.objectContaining({
        registrationNonce: "group-registration-nonce_a",
        members: [expect.objectContaining({
          externalRunRef: "external-run_group-member-a",
          requestedWorkspace: { rootHint: "/srv/comis-workspaces/group-task-a" },
        })],
      }),
    }));
  });

  it("accepts prepared metadata exposed by an enumerable own accessor", async () => {
    const deps = makeDeps();
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const call = makeCall();
    const meta: Record<string, unknown> = {};
    Object.defineProperty(meta, MCP_MANAGED_RUN_RESULT_KEY, {
      configurable: false,
      enumerable: true,
      get: () => makePreparedResult(),
    });

    const accepted = await runWithContext(makeContext(), async () => {
      expect((await bridge.createRequestMeta(call)).ok).toBe(true);
      return bridge.acceptResultMeta({ ...call, meta });
    });

    expect(accepted.ok).toBe(true);
    expect(deps.activatePrepared).toHaveBeenCalledOnce();
  });

  it("passes a validated workspace request into managed-run activation", async () => {
    const activeView = makeView();
    const deps = makeDeps({
      activeView: {
        ...activeView,
        instances: [{
          ...activeView.instances[0]!,
          activeScopes: ["health", "report", "workspace_lease", "execution_attachment"],
        }],
      },
    });
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const call = makeCall();

    const accepted = await runWithContext(makeContext(), async () => {
      expect((await bridge.createRequestMeta(call)).ok).toBe(true);
      return bridge.acceptResultMeta({
        ...call,
        meta: makePreparedMeta({
          requestedWorkspace: { rootHint: "/srv/comis-workspaces/task-a" },
          requestedAttachment: {
            kind: "unix_socket",
            sourcePath: "/srv/comis-runtime/task-a/reporter.sock",
          },
        }),
      });
    });

    expect(accepted.ok).toBe(true);
    expect(deps.activatePrepared).toHaveBeenCalledWith(expect.objectContaining({
      prepared: expect.objectContaining({
        requestedWorkspace: { rootHint: "/srv/comis-workspaces/task-a" },
        requestedAttachment: {
          kind: "unix_socket",
          sourcePath: "/srv/comis-runtime/task-a/reporter.sock",
        },
      }),
    }));
  });

  it("rejects an attachment request without execution attachment scope", async () => {
    const logger = makeLogger();
    const activeView = makeView();
    const deps = makeDeps({
      logger,
      activeView: {
        ...activeView,
        instances: [{ ...activeView.instances[0]!, activeScopes: ["health", "report", "workspace_lease"] }],
      },
    });
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const call = makeCall();

    const accepted = await runWithContext(makeContext(), async () => {
      expect((await bridge.createRequestMeta(call)).ok).toBe(true);
      return bridge.acceptResultMeta({
        ...call,
        meta: makePreparedMeta({
          requestedWorkspace: { rootHint: "/srv/comis-workspaces/task-a" },
          requestedAttachment: {
            kind: "unix_socket",
            sourcePath: "/srv/comis-runtime/task-a/reporter.sock",
          },
        }),
      });
    });

    expect(accepted.ok).toBe(false);
    expect(deps.activatePrepared).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      rejectionReason: "managed-run attachment request lacks execution attachment scope",
    }), "Managed MCP private metadata rejected");
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

  it("resolves a model-visible external run handle through the exact owner scope", async () => {
    const record = {
      managedRunId: "managed-run_a",
      serviceInstanceId: "service-instance_a",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationRef.value,
      status: "active",
    } as ManagedRunRecord;
    const getManagedRunByExternalRef = vi.fn(async () => ok(record));
    const deps = makeDeps({
      activeView: makeView("run_command"),
      getManagedRunByExternalRef,
      getCapturedToolIds: () => ["mcp:fixture-service/send_command"],
    });
    const bridge = createManagedMcpPrivateMetadataBridge(deps);
    const call = makeCall("send_command", { run_handle: "external-run_a", command: "status" });

    const request = await runWithContext(makeContext(), () => bridge.createRequestMeta(call));

    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(request.value?.[MCP_CAPABILITY_CALL_CONTEXT_KEY]).toMatchObject({
      managedRunId: "managed-run_a",
    });
    expect(getManagedRunByExternalRef).toHaveBeenCalledWith({
      kind: "owner",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationRef.value,
    }, "service-instance_a", "external-run_a");
  });

  it("rejects run commands for terminal managed-run records", async () => {
    const terminalRecord = {
      managedRunId: "managed-run_a",
      serviceInstanceId: "service-instance_a",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationRef.value,
      status: "cancelled",
    } as ManagedRunRecord;
    const bridge = createManagedMcpPrivateMetadataBridge(makeDeps({
      activeView: makeView("run_command"),
      getManagedRunByExternalRef: vi.fn(async () => ok(terminalRecord)),
      getCapturedToolIds: () => ["mcp:fixture-service/send_command"],
    }));

    const request = await runWithContext(makeContext(), () => bridge.createRequestMeta(
      makeCall("send_command", { run_handle: "external-run_a", command: "status" }),
    ));

    expect(request.ok).toBe(false);
  });

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "resolves destructive run commands for %s managed-run records",
    async (status) => {
      const terminalRecord = {
        managedRunId: "managed-run_a",
        serviceInstanceId: "service-instance_a",
        tenantId: "tenant_a",
        agentId: "agent_a",
        principalId: "principal_a",
        conversationRef: conversationRef.value,
        status,
      } as ManagedRunRecord;
      const bridge = createManagedMcpPrivateMetadataBridge(makeDeps({
        activeView: makeView("run_command", "destructive"),
        getManagedRunByExternalRef: vi.fn(async () => ok(terminalRecord)),
        getCapturedToolIds: () => ["mcp:fixture-service/send_command"],
      }));

      const request = await runWithContext(makeContext(), () => bridge.createRequestMeta(
        makeCall("send_command", { run_handle: "external-run_a", command: "release" }),
      ));

      expect(request.ok).toBe(true);
      if (!request.ok) return;
      expect(request.value?.[MCP_CAPABILITY_CALL_CONTEXT_KEY]).toMatchObject({
        managedRunId: "managed-run_a",
      });
    },
  );

  it("resolves destructive run commands for unknown managed-run records", async () => {
    const unknownRecord = {
      managedRunId: "managed-run_a",
      serviceInstanceId: "service-instance_a",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationRef.value,
      status: "unknown",
    } as ManagedRunRecord;
    const bridge = createManagedMcpPrivateMetadataBridge(makeDeps({
      activeView: makeView("run_command", "destructive"),
      getManagedRunByExternalRef: vi.fn(async () => ok(unknownRecord)),
      getCapturedToolIds: () => ["mcp:fixture-service/send_command"],
    }));

    const request = await runWithContext(makeContext(), () => bridge.createRequestMeta(
      makeCall("send_command", { run_handle: "external-run_a", command: "release" }),
    ));

    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(request.value?.[MCP_CAPABILITY_CALL_CONTEXT_KEY]).toMatchObject({
      managedRunId: "managed-run_a",
    });
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
