// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  TypedEventBus,
  tryGetContext,
  type RequestContext,
} from "@comis/core";
import { createTokenStore } from "@comis/gateway";
import {
  mountGatewayRoutes,
  type GatewayRouteDeps,
} from "./setup-gateway-routes.js";

const TOKEN_SECRET = "test-gateway-token";

function createDeps(scopes: readonly string[]): {
  deps: GatewayRouteDeps;
  observedContexts: RequestContext[];
} {
  const observedContexts: RequestContext[] = [];
  const app = new Hono();
  const eventBus = new TypedEventBus();

  const deps: GatewayRouteDeps = {
    gatewayHandle: { app } as GatewayRouteDeps["gatewayHandle"],
    container: {
      config: {
        tenantId: "tenant_a",
        dataDir: "/tmp/comis-gateway-auth-test",
      },
      eventBus,
      secretManager: { get: vi.fn(() => undefined) },
    } as unknown as GatewayRouteDeps["container"],
    defaultAgentId: "default",
    agents: {
      default: {
        provider: "anthropic",
        model: "default-model",
        name: "Default",
      },
      specialist: {
        provider: "openai",
        model: "specialist-model",
        name: "Specialist",
        elevatedReply: { defaultTrustLevel: "admin" },
      },
    } as GatewayRouteDeps["agents"],
    gatewayLogger: {
      level: "silent",
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      audit: vi.fn(),
      child: vi.fn(),
    } as unknown as GatewayRouteDeps["gatewayLogger"],
    gwConfig: { httpBodyLimitBytes: 1_048_576 } as GatewayRouteDeps["gwConfig"],
    tokenStore: createTokenStore([
      { id: "client_a", secret: TOKEN_SECRET, scopes },
    ]),
    getExecutor: vi.fn(() => ({
      execute: vi.fn(async () => {
        const context = tryGetContext();
        if (context) observedContexts.push(context);
        return {
          response: "ok",
          tokensUsed: { input: 1, output: 1, total: 2 },
          cost: { total: 0 },
          finishReason: "stop" as const,
          stepsExecuted: 0,
          llmCalls: 1,
        };
      }),
    })) as GatewayRouteDeps["getExecutor"],
    sessionResolver: {
      resolveActiveSession: vi.fn(() => undefined),
      hasActiveSession: vi.fn(() => false),
    },
    assembleToolsForAgent: vi.fn(async () => []),
    preprocessMessageText: vi.fn(async (text: string) => text),
    cachedPort: null,
    workspaceDirs: new Map(),
  };

  mountGatewayRoutes(deps);
  return { deps, observedContexts };
}

function apiRequest(surface: "chat" | "responses"): Request {
  const path = surface === "chat" ? "/v1/chat/completions" : "/v1/responses";
  const body = surface === "chat"
    ? {
        model: "specialist",
        messages: [{ role: "user", content: "hello" }],
      }
    : {
        model: "specialist",
        input: "hello",
      };
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe.each(["chat", "responses"] as const)(
  "%s API bearer-token trust",
  (surface) => {
    it.each(["api", "rpc"])(
      "keeps a %s-scoped caller at user trust when it selects an admin-default agent",
      async (scope) => {
        const { deps, observedContexts } = createDeps([scope]);

        const response = await deps.gatewayHandle.app.fetch(apiRequest(surface));

        expect(response.status).toBe(200);
        expect(observedContexts).toHaveLength(1);
        expect(observedContexts[0]).toMatchObject({
          agentId: "specialist",
          trustLevel: "user",
        });
      },
    );

    it.each([
      ["explicit admin", ["api", "admin"]],
      ["wildcard", ["*"]],
    ] as const)(
      "uses admin trust for an admitted caller with %s scope",
      async (_label, scopes) => {
        const { deps, observedContexts } = createDeps(scopes);

        const response = await deps.gatewayHandle.app.fetch(apiRequest(surface));

        expect(response.status).toBe(200);
        expect(observedContexts).toHaveLength(1);
        expect(observedContexts[0]).toMatchObject({
          agentId: "specialist",
          trustLevel: "admin",
        });
      },
    );

    it("does not admit an admin-only token without an API or RPC scope", async () => {
      const { deps, observedContexts } = createDeps(["admin"]);

      const response = await deps.gatewayHandle.app.fetch(apiRequest(surface));

      expect(response.status).toBe(403);
      expect(observedContexts).toHaveLength(0);
    });
  },
);
