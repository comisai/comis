// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import PQueue from "p-queue";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { err, ok } from "@comis/shared";
import { runWithContext, type RequestContext } from "@comis/core";
import {
  MCP_CAPABILITY_CALL_CONTEXT_KEY,
  MCP_MANAGED_RUN_RESULT_KEY,
  McpCapabilityCallContextSchema,
  McpManagedRunResultSchema,
} from "@comis/capability-service-sdk";
import { callTool } from "../integrations/mcp-client/mcp-client-call.js";
import type {
  McpClientManagerDeps,
  McpClientManager,
  McpClientManagerState,
  McpConnection,
  McpServerConfig,
} from "../integrations/mcp-client/mcp-client-types.js";
import {
  mcpToolsToAgentTools,
  type McpPrivateMetadataBridge,
} from "./mcp-tool-bridge.js";

function makeContext(): RequestContext {
  return {
    tenantId: "default",
    userId: "user_a",
    agentId: "agent_a",
    sessionKey: "default:user_a:telegram:chat_a",
    traceId: "40000000-0000-4000-8000-000000000004",
    startedAt: 1,
    trustLevel: "user",
    channelType: "telegram",
  };
}

function makeState(client: Client): McpClientManagerState {
  const serverName = "fixture-service";
  const connection: McpConnection = {
    name: serverName,
    client,
    status: "connected",
    tools: [],
    lastHealthCheck: 0,
    reconnectAttempt: 0,
    maxReconnectAttempts: 1,
    generation: 1,
  };
  return {
    connections: new Map([[serverName, connection]]),
    reconnectionAbortControllers: new Map(),
    userDisconnectedFlags: new Set(),
    serverConfigs: new Map<string, McpServerConfig>(),
    generations: new Map(),
    callQueues: new Map([[serverName, new PQueue({ concurrency: 1 })]]),
    keepaliveQueues: new Map(),
    consecutiveErrors: new Map(),
    lastStderr: new Map(),
    keepaliveTickers: new Map(),
    circuitBreakers: new Map(),
    idleEvictionTimers: new Map(),
    lastActivityMs: new Map(),
    inflightRefreshes: new Map(),
    options: {
      connectTimeoutMs: 5_000,
      callToolTimeoutMs: 5_000,
      stdioDefaultConcurrency: 1,
      httpDefaultConcurrency: 4,
      reconnectOpts: {
        maxAttempts: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        growFactor: 2,
      },
      keepaliveIntervalMs: 0,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 60_000,
    },
  };
}

describe("MCP private metadata viability", () => {
  let client: Client | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  it("carries private request and prepared-result metadata without exposing it to the model", async () => {
    const callContext = {
      operationId: "operation_fixture_a",
      serviceInstanceId: "service_instance_fixture_a",
      agentId: "agent_a",
      conversationRef: "conversation_a",
      workspacePolicyHash: "c".repeat(64),
      rootRunId: "root_run_fixture_a",
      traceId: makeContext().traceId,
    } as const;
    const requestMeta = {
      [MCP_CAPABILITY_CALL_CONTEXT_KEY]: callContext,
    } as const;
    const preparedRun = {
      state: "prepared",
      externalRunRef: "external_run_fixture_a",
      registrationNonce: "registration_nonce_fixture_a",
      expiresAt: "2030-01-01T00:00:00.000Z",
    } as const;
    const preparedResultMeta = {
      [MCP_MANAGED_RUN_RESULT_KEY]: preparedRun,
    } as const;

    let receivedRequestMeta: Readonly<Record<string, unknown>> | undefined;
    server = new Server(
      { name: "fixture-service", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      receivedRequestMeta = request.params._meta;
      return {
        content: [{ type: "text", text: "Preparation accepted" }],
        _meta: preparedResultMeta,
      };
    });

    client = new Client({ name: "comis-fixture-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const state = makeState(client);
    const deps = {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as unknown as McpClientManagerDeps;
    const callThroughRealClient: McpClientManager["callTool"] = (
      qualifiedName,
      args,
      signal,
      privateMeta,
    ) => callTool(state, deps, qualifiedName, args, signal, privateMeta);

    let acceptedResultMeta: Readonly<Record<string, unknown>> | undefined;
    const privateMetadataBridge: McpPrivateMetadataBridge = {
      createRequestMeta: () => {
        const parsed = McpCapabilityCallContextSchema.safeParse(callContext);
        return parsed.success
          ? ok({ [MCP_CAPABILITY_CALL_CONTEXT_KEY]: parsed.data })
          : err(parsed.error);
      },
      acceptResultMeta: (input) => {
        const parsed = McpManagedRunResultSchema.safeParse(
          input.meta[MCP_MANAGED_RUN_RESULT_KEY],
        );
        if (!parsed.success) return err(parsed.error);
        acceptedResultMeta = { [MCP_MANAGED_RUN_RESULT_KEY]: parsed.data };
        return ok(undefined);
      },
    };
    const tools = mcpToolsToAgentTools(
      [{
        name: "prepare",
        qualifiedName: "mcp:fixture-service/prepare",
        description: "Prepare a synthetic operation",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      }],
      callThroughRealClient,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      privateMetadataBridge,
    );
    const tool = tools[0];
    if (!tool) throw new Error("expected the fixture MCP tool");

    const agentResult = await runWithContext(
      makeContext(),
      () => tool.execute("operation_fixture_a", {}),
    );

    expect(receivedRequestMeta).toMatchObject({
      ...requestMeta,
      "comis.ai/requestTraceId": makeContext().traceId,
    });
    expect(acceptedResultMeta).toEqual(preparedResultMeta);
    expect(agentResult.details).toEqual({ success: true });

    const modelVisibleOutput = JSON.stringify(agentResult.content);
    expect(modelVisibleOutput).toContain("Preparation accepted");
    for (const privateToken of [
      "comis.managedRun",
      "externalRunRef",
      "external_run_fixture_a",
      "registrationNonce",
      "registration_nonce_fixture_a",
      "expiresAt",
      "serviceInstanceId",
      "service_instance_fixture_a",
      "workspacePolicyHash",
      "root_run_fixture_a",
    ]) {
      expect(modelVisibleOutput).not.toContain(privateToken);
    }
  });
});
