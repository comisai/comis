// SPDX-License-Identifier: Apache-2.0
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

vi.mock("@comis/core", async (importOriginal) => {
  // Spread the REAL module: the W-live context test needs the actual
  // runWithContext/tryGetContext AsyncLocalStorage pair; only the two
  // path/token helpers stay stubbed.
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    safePath: vi.fn((...args: string[]) => args.join("/")),
    generateStrongToken: vi.fn(() => "mock-generated-token"),
  };
});

import { mountGatewayRoutes, resolveContextTrustLevel, type GatewayRouteDeps } from "./setup-gateway-routes.js";
import {
  createMappedWebhookEndpoint,
  getPresetMappings,
  createMediaRoutes,
  createOpenaiCompletionsRoute,
  createResponsesRoute,
} from "@comis/gateway";
import { generateStrongToken, tryGetContext } from "@comis/core";

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

// ---------------------------------------------------------------------------
// resolveContextTrustLevel — reconciles elevatedReply trust with the
// UserTrustLevel that platform-tool guards read (live VPS incident 2026-06-19:
// `elevatedReply.defaultTrustLevel: admin` un-deferred memory_manage but the
// chat-API context still hard-coded "user", so execution was denied with
// "permission_denied: requires admin, current level is user").
// ---------------------------------------------------------------------------
describe("resolveContextTrustLevel", () => {
  it("maps defaultTrustLevel:admin → admin (the chat-API elevation lever)", () => {
    // chat-API senderId is a random per-request peerId, so only defaultTrustLevel
    // can ever apply — it MUST reach the platform-tool gate as UserTrustLevel admin.
    expect(resolveContextTrustLevel({ defaultTrustLevel: "admin" } as any, "chatcmpl-random-xyz")).toBe("admin");
  });
  it("defaults to user when defaultTrustLevel is external/unset (the safe prior default)", () => {
    expect(resolveContextTrustLevel({ defaultTrustLevel: "external" } as any, "x")).toBe("user");
    expect(resolveContextTrustLevel({} as any, "x")).toBe("user");
    expect(resolveContextTrustLevel(undefined, "x")).toBe("user");
  });
  it("honors a senderTrustMap admin entry (responses-path / mappable senders)", () => {
    expect(
      resolveContextTrustLevel({ senderTrustMap: { "678314278": "admin" }, defaultTrustLevel: "external" } as any, "678314278"),
    ).toBe("admin");
  });
  it("never elevates non-admin elevatedReply values (learned/system → user)", () => {
    expect(resolveContextTrustLevel({ defaultTrustLevel: "learned" } as any, "x")).toBe("user");
    expect(resolveContextTrustLevel({ defaultTrustLevel: "system" } as any, "x")).toBe("user");
  });
});

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
  // Unattended honest-fail backstop (WEBHOOK-CLAUDE-AGENT-DRIVE-RELIABILITY,
  // webhook-claude-cli-tdd-20260701): a webhook turn that launches Claude Code but
  // ends WITHOUT delivering the task (a live never-tasked drive — the "I have no task"
  // flub) must record an HONEST failure, not the silent success the delivered-event
  // would otherwise report. Owner reconstructs deterministically (agentId = sk.userId).
  // -----------------------------------------------------------------------

  const WEBHOOK_CFG = { enabled: true, path: "/hooks", mappings: [{ id: "m1", name: "devtask" }], presets: [] } as any;

  it("reaps a stranded never-tasked drive at webhook turn-end → webhook_delivered success:false + honest reason", async () => {
    const reapNeverTaskedDrives = vi.fn(async () => ({ reaped: ["sess-1"] }));
    const deps = createMockDeps({ webhooksConfig: WEBHOOK_CFG, reapNeverTaskedDrives });
    mountGatewayRoutes(deps);
    const cfg = vi.mocked(createMappedWebhookEndpoint).mock.calls.at(-1)![0] as any;
    await cfg.onAgentAction({ id: "m1", name: "devtask" }, "build is_prime", "hook:devtask:x");
    // the deterministic reap ran for the exec agent with the terminal-tools fallback owner
    // ({ agentId: execAgentId, sessionKey: "" }) — the webhook execute() path leaves ctx.userId/sessionKey
    // unset, so resolveOwner falls back to deps.agentId + "" (the owner the drive is registered under).
    expect(reapNeverTaskedDrives).toHaveBeenCalledWith("default", { agentId: "default", sessionKey: "" });
    const delivered = (deps.container.eventBus.emit as any).mock.calls.find((c: unknown[]) => c[0] === "diagnostic:webhook_delivered");
    expect(delivered).toBeDefined();
    expect(delivered[1]).toMatchObject({ success: false });
    expect(String(delivered[1].error)).toMatch(/without delivering the task|never-tasked|did not run/i);
  });

  it("no stranded drive at webhook turn-end → webhook_delivered success:true (happy path unchanged)", async () => {
    const reapNeverTaskedDrives = vi.fn(async () => ({ reaped: [] }));
    const deps = createMockDeps({ webhooksConfig: WEBHOOK_CFG, reapNeverTaskedDrives });
    mountGatewayRoutes(deps);
    const cfg = vi.mocked(createMappedWebhookEndpoint).mock.calls.at(-1)![0] as any;
    await cfg.onAgentAction({ id: "m1", name: "devtask" }, "build is_prime", "hook:devtask:x");
    const delivered = (deps.container.eventBus.emit as any).mock.calls.find((c: unknown[]) => c[0] === "diagnostic:webhook_delivered");
    expect(delivered[1]).toMatchObject({ success: true });
  });

  it("no reap seam wired (undefined) → inert; webhook_delivered success:true (byte-identical to pre-backstop)", async () => {
    const deps = createMockDeps({ webhooksConfig: WEBHOOK_CFG }); // reapNeverTaskedDrives omitted
    mountGatewayRoutes(deps);
    const cfg = vi.mocked(createMappedWebhookEndpoint).mock.calls.at(-1)![0] as any;
    await cfg.onAgentAction({ id: "m1", name: "devtask" }, "build is_prime", "hook:devtask:x");
    const delivered = (deps.container.eventBus.emit as any).mock.calls.find((c: unknown[]) => c[0] === "diagnostic:webhook_delivered");
    expect(delivered[1]).toMatchObject({ success: true });
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
  // Microsoft Teams inbound ingress mount (the wiring half of the two-part
  // mounted-route test). The route exists ONLY when the composition root
  // threaded a built ingress sub-app (channel enabled + creds valid); it is
  // absent otherwise. This is the guard that a caller-less, silently-dead
  // route can never ship: presence of the threaded ingress IS the mount signal.
  // -----------------------------------------------------------------------

  it("mounts /channels/msteams when the threaded ingress is present (enabled)", () => {
    const deps = createMockDeps({ msTeamsIngress: new Hono() });

    mountGatewayRoutes(deps);

    expect(deps.gatewayHandle.app.route).toHaveBeenCalledWith(
      "/channels/msteams",
      expect.any(Hono),
    );
  });

  it("does NOT mount /channels/msteams when the ingress is absent (disabled)", () => {
    const deps = createMockDeps();

    mountGatewayRoutes(deps);

    expect(deps.gatewayHandle.app.route).not.toHaveBeenCalledWith(
      "/channels/msteams",
      expect.anything(),
    );
  });

  // -----------------------------------------------------------------------
  // Google Chat inbound ingress mount (same presence-gated contract). The
  // route exists ONLY when the composition root threaded a built ingress
  // sub-app (channel enabled + creds valid); absent otherwise. Presence of
  // the threaded ingress IS the mount signal — a caller-less dead route can
  // never ship.
  // -----------------------------------------------------------------------

  it("mounts /channels/googlechat when the threaded ingress is present (enabled)", () => {
    const deps = createMockDeps({ googlechatIngress: new Hono() });

    mountGatewayRoutes(deps);

    expect(deps.gatewayHandle.app.route).toHaveBeenCalledWith(
      "/channels/googlechat",
      expect.any(Hono),
    );
  });

  it("does NOT mount /channels/googlechat when the ingress is absent (disabled)", () => {
    const deps = createMockDeps();

    mountGatewayRoutes(deps);

    expect(deps.gatewayHandle.app.route).not.toHaveBeenCalledWith(
      "/channels/googlechat",
      expect.anything(),
    );
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

// ---------------------------------------------------------------------------
// §2.6 request-context wrap on the openai-compatible entries (live finding,
// 2026-06-10): the exhausted-run log showed EVERY executor line traceId-less
// on this channel — no ALS context means no trace stitching and no incident
// ref on the degraded reply. The route closures ARE the channel entry, so
// they must runWithContext once per request.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model-validation guard on /v1/chat/completions (live finding 2026-06-11):
// the route factory ships a resolveModel → 404 guard, but the wiring never
// passed resolveModel, so ANY model string (model: "bogus-xyz") returned 200
// served by the default agent — a dishonest surface for OpenAI clients.
// ---------------------------------------------------------------------------

describe("an OpenAI client sending an unknown model name gets a 404, not a silent default-agent answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function capturedResolveModel(): (m: string) => { provider: string; modelId: string } | undefined {
    const deps = createMockDeps();
    mountGatewayRoutes(deps);
    const routeArgs = vi.mocked(createOpenaiCompletionsRoute).mock.calls[0]![0] as {
      resolveModel?: (m: string) => { provider: string; modelId: string } | undefined;
    };
    expect(routeArgs.resolveModel).toBeDefined();
    return routeArgs.resolveModel!;
  }

  it("accepts the catalog id form provider/model (what /v1/models advertises)", () => {
    const resolve = capturedResolveModel();
    expect(resolve("anthropic/claude-sonnet-4-5-20250929")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5-20250929",
    });
  });

  it("accepts the bare configured model id", () => {
    const resolve = capturedResolveModel();
    expect(resolve("claude-sonnet-4-5-20250929")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5-20250929",
    });
  });

  it("accepts an agent id as the model (routes to that agent's model)", () => {
    const resolve = capturedResolveModel();
    expect(resolve("default")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5-20250929",
    });
  });

  it("rejects an unknown model name (the route factory turns undefined into a 404)", () => {
    const resolve = capturedResolveModel();
    expect(resolve("bogus-model-does-not-exist-xyz")).toBeUndefined();
  });
});

describe("openai/responses executeAgent request-context wrap (§2.6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("chat-completions executeAgent runs the executor inside an ALS context carrying a traceId", async () => {
    const seenTraceIds: Array<string | undefined> = [];
    const deps = createMockDeps({
      getExecutor: vi.fn(() => ({
        execute: vi.fn(async () => {
          seenTraceIds.push(tryGetContext()?.traceId);
          return { response: "ok", tokensUsed: 0, finishReason: "stop" };
        }),
      })) as any,
    });
    mountGatewayRoutes(deps);

    const routeArgs = vi.mocked(createOpenaiCompletionsRoute).mock.calls[0]![0] as {
      executeAgent: (p: { message: string }) => Promise<unknown>;
    };
    await routeArgs.executeAgent({ message: "hi" });

    expect(seenTraceIds).toHaveLength(1);
    expect(seenTraceIds[0]).toBeDefined();
    expect(typeof seenTraceIds[0]).toBe("string");
  });

  it("responses executeAgent runs the executor inside an ALS context carrying a traceId", async () => {
    const seenTraceIds: Array<string | undefined> = [];
    const deps = createMockDeps({
      getExecutor: vi.fn(() => ({
        execute: vi.fn(async () => {
          seenTraceIds.push(tryGetContext()?.traceId);
          return { response: "ok", tokensUsed: 0, finishReason: "stop" };
        }),
      })) as any,
    });
    mountGatewayRoutes(deps);

    const routeArgs = vi.mocked(createResponsesRoute).mock.calls[0]![0] as {
      executeAgent: (p: { message: string }) => Promise<unknown>;
    };
    await routeArgs.executeAgent({ message: "hi" });

    expect(seenTraceIds).toHaveLength(1);
    expect(seenTraceIds[0]).toBeDefined();
  });
});
