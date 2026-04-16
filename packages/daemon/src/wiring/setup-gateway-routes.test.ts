/**
 * Tests for setup-gateway-routes HTTP route mounting.
 * Verifies webhook sub-app mounting, token resolution, media routes,
 * and OpenAI-compatible API routes with Bearer auth.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock @comis/gateway before importing the module under test
vi.mock("@comis/gateway", () => ({
  extractBearerToken: vi.fn((header: string) => {
    const match = header.match(/^Bearer (.+)$/i);
    return match ? match[1] : null;
  }),
  checkScope: vi.fn((scopes: string[], scope: string) => scopes.includes(scope) || scopes.includes("*")),
  createMappedWebhookEndpoint: vi.fn(() => new Hono()),
  getPresetMappings: vi.fn(() => []),
  createOpenaiCompletionsRoute: vi.fn(() => new Hono()),
  createOpenaiModelsRoute: vi.fn(() => new Hono()),
  createOpenaiEmbeddingsRoute: vi.fn(() => new Hono()),
  createResponsesRoute: vi.fn(() => new Hono()),
  createMediaRoutes: vi.fn(() => new Hono()),
  createTokenStore: vi.fn(() => ({ verify: vi.fn() })),
}));

vi.mock("@comis/core", () => ({
  safePath: vi.fn((...args: string[]) => args.join("/")),
  generateStrongToken: vi.fn(() => "mock-generated-token"),
}));

import { mountGatewayRoutes, type GatewayRouteDeps } from "./setup-gateway-routes.js";
import {
  createMappedWebhookEndpoint,
  getPresetMappings,
  createMediaRoutes,
} from "@comis/gateway";
import { generateStrongToken } from "@comis/core";

function createMockDeps(overrides: Partial<GatewayRouteDeps> = {}): GatewayRouteDeps {
  return {
    gatewayHandle: {
      app: { route: vi.fn(), use: vi.fn() },
    } as any,
    container: {
      config: { tenantId: "test" },
      eventBus: { emit: vi.fn() },
      secretManager: { get: vi.fn(() => undefined) },
    } as any,
    defaultAgentId: "default",
    agents: {
      default: { provider: "anthropic", model: "claude-sonnet-4-5-20250929", name: "Test" },
    } as any,
    gatewayLogger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any,
    gwConfig: { httpBodyLimitBytes: 1_048_576 } as any,
    tokenStore: { verify: vi.fn() } as any,
    getExecutor: vi.fn(() => ({ execute: vi.fn() })) as any,
    assembleToolsForAgent: vi.fn(async () => []) as any,
    preprocessMessageText: vi.fn(async (t: string) => t) as any,
    cachedPort: null,
    workspaceDirs: new Map(),
    ...overrides,
  };
}

describe("mountGatewayRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Webhook sub-app
  // -----------------------------------------------------------------------

  it("mounts webhook sub-app when enabled with mappings", () => {
    const deps = createMockDeps({
      webhooksConfig: {
        enabled: true,
        mappings: [{ id: "m1", name: "test" }],
      } as any,
    });

    mountGatewayRoutes(deps);

    expect(createMappedWebhookEndpoint).toHaveBeenCalled();
    expect(deps.gatewayHandle.app.route).toHaveBeenCalledWith(
      "/hooks",
      expect.any(Hono),
    );
  });

  it("skips webhook when disabled", () => {
    const deps = createMockDeps({
      webhooksConfig: { enabled: false } as any,
    });

    mountGatewayRoutes(deps);

    expect(createMappedWebhookEndpoint).not.toHaveBeenCalled();
  });

  it("skips webhook when enabled but no mappings", () => {
    vi.mocked(getPresetMappings).mockReturnValue([]);
    const deps = createMockDeps({
      webhooksConfig: { enabled: true, mappings: [], presets: [] } as any,
    });

    mountGatewayRoutes(deps);

    expect(createMappedWebhookEndpoint).not.toHaveBeenCalled();
  });

  it("uses custom basePath for webhooks", () => {
    const deps = createMockDeps({
      webhooksConfig: {
        enabled: true,
        path: "/webhooks",
        mappings: [{ id: "m1" }],
      } as any,
    });

    mountGatewayRoutes(deps);

    expect(deps.gatewayHandle.app.route).toHaveBeenCalledWith(
      "/webhooks",
      expect.any(Hono),
    );
  });

  // -----------------------------------------------------------------------
  // Webhook token resolution
  // -----------------------------------------------------------------------

  it("uses config token when provided", () => {
    const deps = createMockDeps({
      webhooksConfig: {
        enabled: true,
        token: "cfg-token",
        mappings: [{ id: "m1" }],
      } as any,
    });

    mountGatewayRoutes(deps);

    expect(createMappedWebhookEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "cfg-token" }),
    );
  });

  it("falls back to SecretManager when no config token", () => {
    const deps = createMockDeps({
      webhooksConfig: {
        enabled: true,
        mappings: [{ id: "m1" }],
      } as any,
    });
    vi.mocked(deps.container.secretManager.get).mockReturnValue("sm-token");

    mountGatewayRoutes(deps);

    expect(createMappedWebhookEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "sm-token" }),
    );
  });

  it("auto-generates token when neither config nor SecretManager has one", () => {
    const deps = createMockDeps({
      webhooksConfig: {
        enabled: true,
        mappings: [{ id: "m1" }],
      } as any,
    });
    vi.mocked(deps.container.secretManager.get).mockReturnValue(undefined as any);

    mountGatewayRoutes(deps);

    expect(generateStrongToken).toHaveBeenCalled();
    expect(createMappedWebhookEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "mock-generated-token" }),
    );
    expect(deps.gatewayLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ envVar: "WEBHOOK_HMAC_SECRET" }),
      expect.stringContaining("auto-generated"),
    );
  });

  // -----------------------------------------------------------------------
  // Media routes
  // -----------------------------------------------------------------------

  it("mounts media routes when defaultWorkspaceDir is provided", () => {
    const deps = createMockDeps({
      defaultWorkspaceDir: "/ws",
    });

    mountGatewayRoutes(deps);

    expect(createMediaRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ mediaDir: expect.stringContaining("media") }),
    );
    expect(deps.gatewayHandle.app.route).toHaveBeenCalledWith(
      "/media",
      expect.any(Hono),
    );
  });

  it("skips media routes when no workspace dir", () => {
    const deps = createMockDeps();

    mountGatewayRoutes(deps);

    expect(createMediaRoutes).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // OpenAI routes
  // -----------------------------------------------------------------------

  it("mounts OpenAI-compatible API at /v1", () => {
    const deps = createMockDeps();

    mountGatewayRoutes(deps);

    const routeCalls = vi.mocked(deps.gatewayHandle.app.route).mock.calls;
    const v1Call = routeCalls.find(([path]) => path === "/v1");
    expect(v1Call).toBeDefined();
    expect(v1Call![1]).toBeInstanceOf(Hono);
  });

  it("OpenAI auth middleware rejects missing token (401 via integration)", async () => {
    const deps = createMockDeps();
    vi.mocked(deps.tokenStore.verify).mockReturnValue(null);

    mountGatewayRoutes(deps);

    // Extract the Hono sub-app mounted at /v1
    const routeCalls = vi.mocked(deps.gatewayHandle.app.route).mock.calls;
    const v1Call = routeCalls.find(([path]) => path === "/v1");
    const openaiApp = v1Call![1] as Hono;

    // Test auth middleware via a request to the mounted sub-app
    const req = new Request("http://localhost/models", {
      headers: {},
    });
    const res = await openaiApp.fetch(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toBe("Unauthorized");
  });

  it("OpenAI auth middleware rejects insufficient scope (403)", async () => {
    const deps = createMockDeps();
    vi.mocked(deps.tokenStore.verify).mockReturnValue({ scopes: ["read"] } as any);

    mountGatewayRoutes(deps);

    const routeCalls = vi.mocked(deps.gatewayHandle.app.route).mock.calls;
    const v1Call = routeCalls.find(([path]) => path === "/v1");
    const openaiApp = v1Call![1] as Hono;

    const req = new Request("http://localhost/models", {
      headers: { authorization: "Bearer valid-token" },
    });
    const res = await openaiApp.fetch(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe("Insufficient scope");
  });
});
