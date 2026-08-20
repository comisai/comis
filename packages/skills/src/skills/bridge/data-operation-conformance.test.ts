// SPDX-License-Identifier: Apache-2.0
/**
 * Data-operation conformance for the capability-service platform.
 *
 * One service, two tools: an inspection that only reads, and a mutation that
 * changes something outside Comis. They must not blur. A read that inherited the
 * mutation's side effects would be gated as though it changed the world; a
 * mutation that inherited the read's posture would run without the approval its
 * side effects require, which is the failure that matters.
 *
 * The fixture also pins the claim that gives the shape its name: holding the
 * attention scope — the ability to ask a human a question and receive an answer
 * — grants no mutation authority. A human answering "yes, that looks right" to a
 * question is not the same act as approving a side effect, and a runtime that
 * let one stand in for the other would turn any conversational reply into
 * consent for a change the person was never shown.
 *
 * The fixture is deliberately neutral: it carries no consumer's domain nouns.
 *
 * @module
 */
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import { runWithContext } from "@comis/core";
import type { ApprovalGate, ComisLogger, RequestContext } from "@comis/core";
import type {
  McpClientManager,
  McpToolDefinition,
} from "../integrations/mcp-client/index.js";
import {
  mcpToolsToAgentTools,
  type McpPrivateMetadataBridge,
} from "./mcp-tool-bridge.js";
import { createManagedMcpPrivateMetadataBridge } from "./managed-mcp-private-metadata.js";

const NOW_MS = 1_800_000_000_000;
const POLICY_HASH = "d".repeat(64);

const TURN_SCOPE = {
  conversation: {
    tenantId: "tenant_a",
    agentId: "agent_a",
    partition: { kind: "agent" as const },
  },
  principal: { principalId: "user_a" },
  endpoint: {
    channelType: "telegram",
    channelInstanceId: "channel-instance_a",
    conversationId: "conversation_a",
    conversationKind: "direct" as const,
  },
};

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

/**
 * One service exposing both shapes at once. The scopes deliberately include
 * attention: the point is that holding it changes nothing about what the
 * mutation requires.
 */
function dataOperationView(scopes: readonly string[] = ["health", "report", "attention_response"]) {
  return {
    viewHash: "c".repeat(64),
    definitions: [{
      contributionId: "data.fixture",
      serviceDefinitionId: "data.fixture-definition",
      mcpServerName: "data-fixture",
      managedToolBindings: [
        {
          toolName: "inspect_records",
          behavior: "read_only" as const,
          actionClassification: "read" as const,
          invocationSideEffects: [] as readonly string[],
        },
        {
          toolName: "apply_change",
          behavior: "read_only" as const,
          actionClassification: "destructive" as const,
          invocationSideEffects: ["external_write"] as readonly string[],
        },
      ],
      requestedScopes: scopes,
      evidencePolicies: [] as const,
    }],
    instances: [{
      contributionId: "data.fixture",
      serviceDefinitionId: "data.fixture-definition",
      serviceInstanceId: "service-instance_data",
      mcpServerName: "data-fixture",
      allowedAgents: ["agent_a"],
      allowedWorkspaceRoots: [],
      allowedRuntimeRoots: [],
      state: "active" as const,
      activeScopes: scopes,
    }],
  };
}

function makeContext(): RequestContext {
  return {
    tenantId: "tenant_a",
    userId: "user_a",
    sessionKey: "tenant_a:user_a:telegram:conversation_a",
    agentId: "agent_a",
    rootRunId: "root-run_a",
    turnScope: TURN_SCOPE,
    traceId: "10000000-0000-4000-8000-000000000001",
    startedAt: NOW_MS,
    trustLevel: "user",
    channelType: "telegram",
    deliveryOrigin: Object.freeze({
      channelType: "telegram",
      channelId: "conversation_a",
      userId: "user_a",
      tenantId: "tenant_a",
    }),
    workspacePolicyHash: POLICY_HASH,
    responseLocalePolicy: {
      locale: "en",
      source: "request",
      enforceLocale: true,
    },
  };
}

function makeTool(name: "inspect_records" | "apply_change"): McpToolDefinition {
  return {
    name,
    qualifiedName: `mcp:data-fixture/${name}`,
    description: name === "inspect_records"
      ? "Inspect synthetic records"
      : "Apply one synthetic external change",
    inputSchema: {
      type: "object",
      properties: {
        recordId: { type: "string" },
        attentionResponse: { type: "string" },
      },
      required: ["recordId"],
    },
  };
}

function makeCallTool(): McpClientManager["callTool"] {
  return vi.fn(async () => ok({
    content: [{ type: "text" as const, text: "synthetic operation complete" }],
    isError: false,
  }));
}

function makeApprovalGate(approved: boolean): ApprovalGate {
  return {
    requestApproval: vi.fn(async () => ({
      requestId: "10000000-0000-4000-8000-000000000002",
      approved,
      approvedBy: approved ? "user_a" : "system:test-denial",
      reason: approved ? "Approved for conformance" : "Denied for conformance",
      resolvedAt: NOW_MS,
    })),
  } as unknown as ApprovalGate;
}

function makeAgentTools(
  callTool: McpClientManager["callTool"],
  privateMetadataBridge: McpPrivateMetadataBridge,
  approvalGate: ApprovalGate | undefined,
) {
  return mcpToolsToAgentTools(
    [makeTool("inspect_records"), makeTool("apply_change")],
    callTool,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    privateMetadataBridge,
    approvalGate,
  );
}

function dataOperationDeps(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent_a",
    activeView: dataOperationView(),
    capturedAgentCapabilities: ["orch:read"] as const,
    getCapturedToolIds: () => [
      "mcp:data-fixture/inspect_records",
      "mcp:data-fixture/apply_change",
    ],
    nowMs: () => NOW_MS,
    resolveRootRunId: () => ok("root-run_a"),
    getManagedRunByExternalRef: vi.fn(async () => ok(undefined)),
    activatePrepared: vi.fn(async () => ok({ kind: "activated" as const })),
    logger: makeLogger(),
    ...overrides,
  };
}

function metadataFor(toolName: string, deps = dataOperationDeps()) {
  const bridge = createManagedMcpPrivateMetadataBridge(deps);
  return bridge.resolveRegistrationMetadata?.({
    serverName: "data-fixture",
    toolName,
    qualifiedName: `mcp:data-fixture/${toolName}`,
  });
}

describe("data-operation fixture conformance", () => {
  it("keeps the inspection read-only and the mutation separately gated", () => {
    const inspection = metadataFor("inspect_records");
    const mutation = metadataFor("apply_change");

    expect(inspection?.actionClassification).toBe("read");
    // A read that carried the sibling's side effects would be gated as though it
    // changed the world, and an agent would learn to route around the gate.
    expect(inspection?.invocationSideEffects).toEqual([]);

    expect(mutation?.actionClassification).toBe("destructive");
    expect(mutation?.invocationSideEffects).toEqual(["external_write"]);
  });

  it("does not let the attention scope stand in for the mutation's approval", () => {
    // The service holds attention_response: it can ask a human a question and
    // receive an answer. That is a different act from approving a side effect,
    // and it must not weaken what the mutation declares. The same binding
    // resolved on a service without the scope must produce identical authority.
    const withAttention = metadataFor("apply_change");
    const withoutAttention = metadataFor("apply_change", dataOperationDeps({
      activeView: dataOperationView(["health", "report"]),
    }));

    expect(withAttention).toEqual(withoutAttention);
    expect(withAttention?.invocationSideEffects).toEqual(["external_write"]);
    expect(withAttention?.actionClassification).not.toBe("read");
  });

  it("executes inspection without approval but gates the external mutation", async () => {
    const callTool = makeCallTool();
    const approvalGate = makeApprovalGate(false);
    const privateMetadataBridge = createManagedMcpPrivateMetadataBridge(dataOperationDeps());
    const [inspection, mutation] = makeAgentTools(
      callTool,
      privateMetadataBridge,
      approvalGate,
    );

    await runWithContext(makeContext(), () =>
      inspection!.execute("tool-call_inspect", { recordId: "record_a" }),
    );
    expect(approvalGate.requestApproval).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);

    await expect(runWithContext(makeContext(), () =>
      mutation!.execute("tool-call_mutate", {
        recordId: "record_a",
        attentionResponse: "yes",
      }),
    )).rejects.toThrow(/not approved|denied/iu);

    expect(approvalGate.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "mcp__data-fixture--apply_change",
      action: "mcp.data-fixture.apply_change",
      params: {
        serverName: "data-fixture",
        toolName: "apply_change",
      },
      fingerprintParams: {
        serverName: "data-fixture",
        toolName: "apply_change",
        arguments: {
          recordId: "record_a",
          attentionResponse: "yes",
        },
      },
    }));
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("fails a destructive data operation closed when approvals are unavailable", async () => {
    const callTool = makeCallTool();
    const privateMetadataBridge = createManagedMcpPrivateMetadataBridge(dataOperationDeps());
    const [, mutation] = makeAgentTools(callTool, privateMetadataBridge, undefined);

    await expect(runWithContext(makeContext(), () =>
      mutation!.execute("tool-call_without_gate", { recordId: "record_a" }),
    )).rejects.toThrow(/approval gate is unavailable/iu);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("reaches the data service only after explicit approval", async () => {
    const callTool = makeCallTool();
    const approvalGate = makeApprovalGate(true);
    const privateMetadataBridge = createManagedMcpPrivateMetadataBridge(dataOperationDeps());
    const [, mutation] = makeAgentTools(callTool, privateMetadataBridge, approvalGate);

    await expect(runWithContext(makeContext(), () =>
      mutation!.execute("tool-call_approved", { recordId: "record_a" }),
    )).resolves.toBeDefined();

    expect(approvalGate.requestApproval).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("fails an unresolvable binding closed to destructive rather than open to read", () => {
    // Two definitions claiming the same server and tool name is an ambiguity the
    // host cannot resolve. The safe answer is the most restrictive one: treating
    // an unresolvable tool as a read would let a mutation run ungated precisely
    // when the runtime has lost track of what the tool is.
    const ambiguous = dataOperationView();
    const duplicate = {
      ...ambiguous.definitions[0]!,
      serviceDefinitionId: "data.fixture-duplicate",
    };
    const metadata = metadataFor("apply_change", dataOperationDeps({
      activeView: { ...ambiguous, definitions: [ambiguous.definitions[0]!, duplicate] },
    }));

    expect(metadata?.actionClassification).toBe("destructive");
  });

  it("publishes nothing for a tool no active instance authorizes for this agent", () => {
    // An unknown tool is not a permissive default. It has no managed metadata at
    // all, so nothing downstream can mistake it for a reviewed read.
    const foreign = metadataFor("apply_change", dataOperationDeps({ agentId: "agent_b" }));

    expect(foreign?.actionClassification).toBe("destructive");
  });
});
