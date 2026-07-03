// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for MCP management RPC handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockTempConnect = vi.hoisted(() => vi.fn());
const mockTempDisconnectAll = vi.hoisted(() => vi.fn());
const mockCreateMcpClientManager = vi.hoisted(() => vi.fn(() => ({
  connect: mockTempConnect,
  disconnect: vi.fn(),
  disconnectAll: mockTempDisconnectAll,
  getConnection: vi.fn(),
  getAllConnections: vi.fn(() => []),
  getTools: vi.fn(() => []),
  callTool: vi.fn(),
  reconnect: vi.fn(),
})));

vi.mock("@comis/skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/skills")>();
  return {
    ...actual,
    createMcpClientManager: mockCreateMcpClientManager,
  };
});

// Mock the persistence + audit-log helpers so unit tests don't
// hit the real filesystem. Existing tests don't inject persistDeps so they
// never reach these mocks; the new mcp.connect/disconnect persistence tests
// below assert directly on the mocked call args.
vi.mock("./shared/persist-to-config.js", () => ({
  persistToConfig: vi.fn().mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } }),
}));
vi.mock("../config/audit-hook.js", () => ({
  buildConfigAuditBase: vi.fn().mockReturnValue({ /* opaque audit base stub */ }),
  appendConfigAuditWithOutcome: vi.fn(),
}));

import { createMcpHandlers } from "./mcp-handlers.js";
import { persistToConfig } from "./shared/persist-to-config.js";
import { buildConfigAuditBase, appendConfigAuditWithOutcome } from "../config/audit-hook.js";
import type { McpClientManager, McpConnection, McpToolDefinition } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";
import { createSecretManager, looksLikeSecretValue } from "@comis/core";

const mockPersistToConfig = vi.mocked(persistToConfig);
const mockBuildConfigAuditBase = vi.mocked(buildConfigAuditBase);
const mockAppendConfigAuditWithOutcome = vi.mocked(appendConfigAuditWithOutcome);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function err(error: Error) {
  return { ok: false as const, error };
}

function makeTool(name: string): McpToolDefinition {
  return {
    name,
    qualifiedName: `mcp:test-server/${name}`,
    description: `Test tool ${name}`,
    inputSchema: { type: "object" },
  };
}

function makeConnection(name: string, tools: McpToolDefinition[] = [], status: "connected" | "error" = "connected"): McpConnection {
  return {
    name,
    client: null as any,
    status,
    tools,
    lastHealthCheck: 1700000000000,
    reconnectAttempt: 0,
    maxReconnectAttempts: 5,
    generation: 0,
  };
}

function createMockManager(): McpClientManager {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    getConnection: vi.fn(),
    getAllConnections: vi.fn(() => []),
    getTools: vi.fn(() => []),
    callTool: vi.fn(),
    reconnect: vi.fn(),
  };
}

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    level: "debug",
    isLevelEnabled: vi.fn(() => true),
  } as unknown as ComisLogger;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP RPC Handlers", () => {
  let manager: ReturnType<typeof createMockManager>;

  beforeEach(() => {
    manager = createMockManager();
  });

  describe("mcp.list", () => {
    it("returns all connections with status and tool count", async () => {
      const tool1 = makeTool("search");
      const tool2 = makeTool("query");
      (manager.getAllConnections as any).mockReturnValue([
        makeConnection("context7", [tool1, tool2]),
        makeConnection("filesystem", [], "error"),
      ]);

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.list"]({}) as any;

      expect(result.total).toBe(2);
      expect(result.servers[0]).toEqual(expect.objectContaining({
        name: "context7",
        status: "connected",
        toolCount: 2,
        lastHealthCheck: 1700000000000,
        reconnectAttempt: 0,
      }));
      expect(result.servers[1].status).toBe("error");
    });

    it("includes capabilities and serverVersion in list entries", async () => {
      const conn = {
        ...makeConnection("ctx7", [makeTool("search")]),
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "ctx7-impl", version: "2.0.0" },
      };
      (manager.getAllConnections as any).mockReturnValue([conn]);

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.list"]({}) as any;

      expect(result.servers[0].capabilities).toEqual({ tools: {}, resources: {} });
      expect(result.servers[0].serverVersion).toEqual({ name: "ctx7-impl", version: "2.0.0" });
    });
  });

  describe("mcp.status", () => {
    it("throws on missing name param", async () => {
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(handlers["mcp.status"]({})).rejects.toThrow("Missing required parameter: server_name");
    });

    it("throws when server not found", async () => {
      (manager.getConnection as any).mockReturnValue(undefined);
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(handlers["mcp.status"]({ server_name: "unknown" })).rejects.toThrow('not found: "unknown"');
    });

    it("returns detailed status with tools", async () => {
      const tool = makeTool("search");
      (manager.getConnection as any).mockReturnValue(makeConnection("ctx7", [tool]));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.status"]({ server_name: "ctx7" }) as any;

      expect(result.name).toBe("ctx7");
      expect(result.status).toBe("connected");
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe("search");
    });

    it("returns instructions, capabilities, and serverVersion from connection", async () => {
      const conn = {
        ...makeConnection("ctx7", [makeTool("search")]),
        instructions: "Use search for queries",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "test-server", version: "1.2.3" },
      };
      (manager.getConnection as any).mockReturnValue(conn);

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.status"]({ server_name: "ctx7" }) as any;

      expect(result.instructions).toBe("Use search for queries");
      expect(result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
      expect(result.serverVersion).toEqual({ name: "test-server", version: "1.2.3" });
    });

    it("gracefully handles undefined instructions/capabilities/serverVersion", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("basic", [makeTool("ping")]));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.status"]({ server_name: "basic" }) as any;

      expect(result.instructions).toBeUndefined();
      expect(result.capabilities).toBeUndefined();
      expect(result.serverVersion).toBeUndefined();
    });
  });

  describe("mcp.connect", () => {
    it("connects with stdio transport", async () => {
      const tool = makeTool("resolve");
      (manager.connect as any).mockResolvedValue(ok(makeConnection("new-srv", [tool])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.connect"]({
        server_name: "new-srv",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
      }) as any;

      expect(manager.connect).toHaveBeenCalledWith(expect.objectContaining({
        name: "new-srv",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
      }));
      expect(result.status).toBe("connected");
      expect(result.toolCount).toBe(1);
    });

    it("passes sse transport directly", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("remote", [])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await handlers["mcp.connect"]({
        server_name: "remote",
        transport: "sse",
        url: "https://example.com/mcp",
      });

      expect(manager.connect).toHaveBeenCalledWith(expect.objectContaining({
        transport: "sse",
        url: "https://example.com/mcp",
      }));
    });

    it("passes headers to McpServerConfig", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("authed", [])));

      // Use a ${VAR} reference form — the credential firewall passes
      // through already-substituted ${VAR} refs without touching them.
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await handlers["mcp.connect"]({
        server_name: "authed",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "Authorization": "Bearer ${MY_AUTH_TOKEN}" },
      });

      expect(manager.connect).toHaveBeenCalledWith(expect.objectContaining({
        name: "authed",
        headers: { "Authorization": "Bearer ${MY_AUTH_TOKEN}" },
      }));
    });

    it("throws on connection failure", async () => {
      (manager.connect as any).mockResolvedValue(err(new Error("ENOENT")));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(
        handlers["mcp.connect"]({ server_name: "bad", transport: "stdio", command: "nope" }),
      ).rejects.toThrow("Failed to connect");
    });

    // -------------------------------------------------------------------------
    // Structured throw with .data.needs_oauth_login at RPC boundary.
    //
    // When manager.connect returns a NeedsOAuthLoginError, the RPC handler must
    // throw an Error with .data.needs_oauth_login === true so the
    // mcp_manage catch block can surface the actionable "run mcp login" hint.
    // -------------------------------------------------------------------------
    it("throws structured error with data.needs_oauth_login when manager returns NeedsOAuthLoginError", async () => {
      // Arrange: simulate first-install 401 — construct a NeedsOAuthLoginError
      // with code === "needs_oauth_login" (same shape as tagNeedsOAuthLogin).
      // Importing tagNeedsOAuthLogin from @comis/skills is not possible here
      // because vi.mock("@comis/skills") only re-exports `isNeedsOAuthLoginError`
      // (tagNeedsOAuthLogin is intentionally not in the barrel export).
      const needsOAuthErr = Object.assign(
        new Error(`MCP server "oauth-srv" requires OAuth login.`),
        { code: "needs_oauth_login" as const },
      );
      (manager.connect as any).mockResolvedValue(err(needsOAuthErr));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

      let thrownError: unknown;
      try {
        await handlers["mcp.connect"]({
          server_name: "oauth-srv",
          transport: "http",
          url: "https://example.com/mcp",
        });
      } catch (e) {
        thrownError = e;
      }

      expect(thrownError).toBeInstanceOf(Error);
      // Structured .data must carry needs_oauth_login flag + guidance.
      expect((thrownError as { data?: unknown }).data).toMatchObject({
        needs_oauth_login: true,
        server_name: "oauth-srv",
        action: "comis mcp login oauth-srv",
      });
    });

    it("throws plain Error (no .data field) when manager returns non-oauth error", async () => {
      // Non-oauth errors must NOT get .data — only NeedsOAuthLoginErrors do.
      (manager.connect as any).mockResolvedValue(err(new Error("network timeout")));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

      let thrownError: unknown;
      try {
        await handlers["mcp.connect"]({
          server_name: "plain-srv",
          transport: "http",
          url: "https://example.com/mcp",
        });
      } catch (e) {
        thrownError = e;
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as { data?: unknown }).data).toBeUndefined();
      expect((thrownError as Error).message).toContain('Failed to connect MCP server "plain-srv"');
    });
  });

  // -------------------------------------------------------------------------
  // Global integrations.mcp.keepaliveIntervalMs override must reach
  // the per-server McpServerConfig as the middle tier in the resolution chain:
  //   per-server params ?? per-server persisted ?? global config ?? (transport default in ticker)
  //
  // Cases:
  //   - global keepaliveIntervalMs is forwarded to manager.connect
  //     when neither params nor persisted entry supply a per-server value
  //   - invariant guard: per-server param wins over global
  //   - invariant guard: per-server persisted entry wins over global when
  //     no caller param is supplied
  // -------------------------------------------------------------------------
  describe("mcp.connect global keepaliveIntervalMs override", () => {
    it("forwards global integrations.mcp.keepaliveIntervalMs to McpServerConfig when no per-server override", async () => {
      // When code resolves only `params.keepaliveIntervalMs ?? persistedEntry?.keepaliveIntervalMs`
      // — the global tier is absent — manager.connect receives keepaliveIntervalMs: undefined, not 60_000.
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ka-global", [])));
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        container: {
          config: {
            integrations: {
              mcp: {
                servers: [],
                keepaliveIntervalMs: 60_000, // global override
              },
            },
          },
        },
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ka-global",
        transport: "stdio",
        command: "npx",
        // no keepaliveIntervalMs in params
      });

      // resolvedKeepaliveIntervalMs = undefined ?? undefined ?? 60_000 = 60_000
      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({ keepaliveIntervalMs: 60_000 }),
      );
    });

    it("invariant guard: per-server param keeps priority over global keepaliveIntervalMs", async () => {
      // Invariant: per-server param must beat the global tier.
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ka-param-wins", [])));
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        container: {
          config: {
            integrations: {
              mcp: {
                servers: [],
                keepaliveIntervalMs: 60_000, // global override
              },
            },
          },
        },
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ka-param-wins",
        transport: "stdio",
        command: "npx",
        keepaliveIntervalMs: 10_000, // per-server param wins
      } as any);

      // Resolution: 10_000 (param) ?? undefined (no persisted) ?? 60_000 (global) = 10_000
      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({ keepaliveIntervalMs: 10_000 }),
      );
    });

    it("invariant guard: per-server persisted entry wins over global keepaliveIntervalMs", async () => {
      // Invariant: persisted per-server entry must beat the global tier.
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ka-persisted-wins", [])));
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        container: {
          config: {
            integrations: {
              mcp: {
                servers: [
                  {
                    name: "ka-persisted-wins",
                    transport: "stdio",
                    command: "npx",
                    enabled: true,
                    keepaliveIntervalMs: 45_000, // per-server persisted
                  },
                ],
                keepaliveIntervalMs: 60_000, // global override (lower priority)
              },
            },
          },
        },
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ka-persisted-wins",
        transport: "stdio",
        command: "npx",
        // no keepaliveIntervalMs in params → falls to persisted (45_000), not global (60_000)
      });

      // Resolution: undefined (param) ?? 45_000 (persisted) ?? 60_000 (global) = 45_000
      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({ keepaliveIntervalMs: 45_000 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Plaintext-secret pre-Zod guard on mcp.connect.
  //
  // The guard runs IMMEDIATELY AFTER stripInternalFields and BEFORE
  // McpConnectContract.request.parse. It scans userParams.env values for
  // (a) known credential prefixes (ghp_, sk-, AKIA, etc.) OR (b) the
  // entropy backstop (Shannon entropy > 3.5 AND length >= 44). The
  // per-server `disablePlaintextSecretCheck: true` opt-out from
  // McpServerEntrySchema is the last-resort escape hatch — WARN-and-allow.
  //
  // Length floor 44 (NOT 40): eliminates the OpenAI 40-char org-ID false
  // positive without losing any real-token rejection.
  // -------------------------------------------------------------------------
  describe("mcp.connect plaintext-secret guard", () => {
    it("rejects ghp_ GitHub PAT prefix with [plaintext_secret_in_env] naming the variable", async () => {
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(
        handlers["mcp.connect"]({
          server_name: "gh",
          transport: "stdio",
          command: "npx",
          env: { GITHUB_TOKEN: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
        }),
      ).rejects.toThrow(/\[plaintext_secret_in_env\] env\.GITHUB_TOKEN/);
      expect(manager.connect).not.toHaveBeenCalled();
    });

    it("rejects sk- OpenAI API key prefix with [plaintext_secret_in_env] naming the variable", async () => {
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(
        handlers["mcp.connect"]({
          server_name: "oa",
          transport: "stdio",
          command: "npx",
          env: { OPENAI_API_KEY: "sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef" },
        }),
      ).rejects.toThrow(/\[plaintext_secret_in_env\] env\.OPENAI_API_KEY/);
      expect(manager.connect).not.toHaveBeenCalled();
    });

    it("rejects xoxb- Slack bot token prefix with [plaintext_secret_in_env]", async () => {
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(
        handlers["mcp.connect"]({
          server_name: "slack",
          transport: "stdio",
          command: "npx",
          env: { SLACK_TOKEN: "xoxb-abcdef1234567890abcdef1234567890" },
        }),
      ).rejects.toThrow(/\[plaintext_secret_in_env\]/);
      expect(manager.connect).not.toHaveBeenCalled();
    });

    it("rejects AWS AKIA access-key prefix with [plaintext_secret_in_env]", async () => {
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(
        handlers["mcp.connect"]({
          server_name: "aws",
          transport: "stdio",
          command: "npx",
          env: { AWS_KEY: "AKIAIOSFODNN7EXAMPLE" },
        }),
      ).rejects.toThrow(/\[plaintext_secret_in_env\]/);
      expect(manager.connect).not.toHaveBeenCalled();
    });

    it("PASSES Notion DB UUID (36 chars, entropy <3.99, no prefix) — false-positive negative control", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("notion", [])));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await handlers["mcp.connect"]({
        server_name: "notion",
        transport: "stdio",
        command: "npx",
        env: { NOTION_DB: "8f3b2c1a-9d4e-7f60-b5e2-c8d1a4f7b9c3" },
      });
      expect(manager.connect).toHaveBeenCalled();
    });

    it("PASSES Stripe customer ID cus_* (length ~17, no sk_ prefix) — false-positive negative control", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("stripe", [])));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await handlers["mcp.connect"]({
        server_name: "stripe",
        transport: "stdio",
        command: "npx",
        env: { STRIPE_CUST: "cus_NffrFeUfNV2Hib" },
      });
      expect(manager.connect).toHaveBeenCalled();
    });

    it("PASSES OpenAI org ID org-* (28 chars, length < 44) — false-positive negative control", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("oa-org", [])));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await handlers["mcp.connect"]({
        server_name: "oa-org",
        transport: "stdio",
        command: "npx",
        env: { OPENAI_ORG: "org-ScmHEqZDkG8eYLJBVxpOTEh1" },
      });
      expect(manager.connect).toHaveBeenCalled();
    });

    it("PASSES PATH value at length 44 with entropy ~3.31 (below entropy floor)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("pathy", [])));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await handlers["mcp.connect"]({
        server_name: "pathy",
        transport: "stdio",
        command: "npx",
        env: { PATH_VALUE: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
      });
      expect(manager.connect).toHaveBeenCalled();
    });

    it("REJECTS high-entropy 44-char random string (entropy backstop catches generic high-entropy keys)", async () => {
      // 44-character pseudo-random base64-ish string with no known prefix.
      // Shannon entropy of this string is well above the 3.5 floor.
      const HIGH_ENTROPY_44_CHAR = "Z9aB3xK7mP2qLr5tEvF8nGwHsJ4uVbCdYxRzNoPqW1Aa";
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(
        handlers["mcp.connect"]({
          server_name: "random",
          transport: "stdio",
          command: "npx",
          env: { LONG_RANDOM: HIGH_ENTROPY_44_CHAR },
        }),
      ).rejects.toThrow(/\[plaintext_secret_in_env\] env\.LONG_RANDOM/);
      expect(manager.connect).not.toHaveBeenCalled();
    });

    it("ALLOWS connect when disablePlaintextSecretCheck:true even with ghp_ prefix; logs WARN with errorKind:config", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("gh-optout", [])));
      const logger = makeLogger();
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger });
      await handlers["mcp.connect"]({
        server_name: "gh-optout",
        transport: "stdio",
        command: "npx",
        env: { GITHUB_TOKEN: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
        // Per-server opt-out from McpServerEntrySchema.
        disablePlaintextSecretCheck: true,
      } as any);
      expect(manager.connect).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "mcp.connect",
          entityId: "gh-optout",
          errorKind: "config",
        }),
        expect.stringContaining("plaintext-secret check disabled"),
      );
    });

    it("PASSES unresolved env-ref placeholder ${KEY} (handled separately by findUnresolvedEnvRefs)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("envref", [])));
      const sm = createSecretManager({ GH_TOKEN: "ghp_resolved-value-here-not-a-secret-shape" });
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
      });
      await handlers["mcp.connect"]({
        server_name: "envref",
        transport: "stdio",
        command: "npx",
        env: { RESOLVED_REF: "${GH_TOKEN}" },
      });
      expect(manager.connect).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // looksLikeSecretValue pure-function unit tests.
  //
  // Direct pure-function coverage so the heuristic shape (prefix list +
  // entropy >3.5 AND length >=44 backstop) is pinned independent of the
  // RPC handler integration. This block is the daemon-resident smoke check.
  // -------------------------------------------------------------------------
  describe("looksLikeSecretValue pure-function heuristic", () => {
    it("returns true for ghp_ GitHub PAT prefix", () => {
      expect(looksLikeSecretValue("ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789")).toBe(true);
    });

    it("returns true for sk- OpenAI key prefix", () => {
      expect(looksLikeSecretValue("sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef")).toBe(true);
    });

    it("returns true for AWS AKIA prefix (short 20-char prefix-only rejection)", () => {
      expect(looksLikeSecretValue("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    });

    it("returns true for entropy backstop (length 44, entropy >3.5, no known prefix)", () => {
      expect(looksLikeSecretValue("Z9aB3xK7mP2qLr5tEvF8nGwHsJ4uVbCdYxRzNoPqW1Aa")).toBe(true);
    });

    it("returns false for Notion DB UUID 36-char (no prefix, length < 44)", () => {
      expect(looksLikeSecretValue("8f3b2c1a-9d4e-7f60-b5e2-c8d1a4f7b9c3")).toBe(false);
    });

    it("returns false for OpenAI org ID 28-char (no prefix, length < 44)", () => {
      expect(looksLikeSecretValue("org-ScmHEqZDkG8eYLJBVxpOTEh1")).toBe(false);
    });

    it("returns false for Stripe customer ID cus_* (no sk_ prefix)", () => {
      expect(looksLikeSecretValue("cus_NffrFeUfNV2Hib")).toBe(false);
    });

    it("returns false for unresolved env-ref placeholder ${KEY}", () => {
      expect(looksLikeSecretValue("${GITHUB_TOKEN}")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(looksLikeSecretValue("")).toBe(false);
    });
  });

  describe("mcp.disconnect", () => {
    it("disconnects an existing server", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("ctx7"));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.disconnect"]({ server_name: "ctx7" }) as any;

      expect(manager.disconnect).toHaveBeenCalledWith("ctx7");
      expect(result.status).toBe("disconnected");
    });

    it("throws when server not found", async () => {
      (manager.getConnection as any).mockReturnValue(undefined);

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(handlers["mcp.disconnect"]({ server_name: "nope" })).rejects.toThrow("not found");
    });
  });

  describe("mcp.reconnect", () => {
    it("uses manager.reconnect with stored config", async () => {
      const tool = makeTool("search");
      (manager.reconnect as any).mockResolvedValue(ok(makeConnection("ctx7", [tool])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.reconnect"]({
        server_name: "ctx7",
      }) as any;

      expect(manager.reconnect).toHaveBeenCalledWith("ctx7");
      expect(result.status).toBe("connected");
    });

    it("falls back to connect when no stored config and transport provided", async () => {
      const tool = makeTool("search");
      (manager.reconnect as any).mockResolvedValue(err(new Error('MCP server "ctx7" has no stored config -- use connect() instead')));
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [tool])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      const result = await handlers["mcp.reconnect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      }) as any;

      expect(manager.connect).toHaveBeenCalled();
      expect(result.status).toBe("connected");
    });

    it("throws when server not found and no transport given", async () => {
      (manager.reconnect as any).mockResolvedValue(err(new Error('MCP server "unknown" has no stored config -- use connect() instead')));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await expect(
        handlers["mcp.reconnect"]({ server_name: "unknown" }),
      ).rejects.toThrow("not found and no transport specified");
    });
  });

  describe("mcp.test", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockTempDisconnectAll.mockResolvedValue(undefined);
    });

    it("returns success with tool list on successful connection", async () => {
      const tool = makeTool("search");
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("test-srv", [tool])));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      const result = await handlers["mcp.test"]({
        name: "test-srv",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
      }) as any;

      expect(result.success).toBe(true);
      expect(result.toolCount).toBe(1);
      expect(result.tools).toEqual(["search"]);
      expect(mockTempDisconnectAll).toHaveBeenCalled();
    });

    it("returns error details on connection failure", async () => {
      mockTempConnect.mockResolvedValueOnce(err(new Error("ENOENT: npx not found")));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      const result = await handlers["mcp.test"]({
        name: "bad-srv",
        transport: "stdio",
        command: "nonexistent",
      }) as any;

      expect(result.success).toBe(false);
      expect(result.error).toContain("ENOENT");
      expect(mockTempDisconnectAll).toHaveBeenCalled();
    });

    it("cleans up even when connect throws", async () => {
      mockTempConnect.mockRejectedValueOnce(new Error("Unexpected crash"));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      const result = await handlers["mcp.test"]({
        name: "crash-srv",
        transport: "stdio",
        command: "broken",
      }) as any;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unexpected crash");
      expect(mockTempDisconnectAll).toHaveBeenCalled();
    });

    it("does not require global mcpClientManager", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("isolated", [])));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      const result = await handlers["mcp.test"]({
        name: "isolated",
        transport: "stdio",
        command: "mcp-server",
      }) as any;

      expect(result.success).toBe(true);
      expect(result.toolCount).toBe(0);
    });

    it("uses namespaced server name to avoid production collision", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__probe", [])));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      await handlers["mcp.test"]({
        name: "probe",
        transport: "stdio",
        command: "mcp-server",
      });

      expect(mockTempConnect).toHaveBeenCalledWith(
        expect.objectContaining({ name: "__test__probe" }),
      );
    });

    it("passes sse transport directly for test", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("remote", [])));

      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      await handlers["mcp.test"]({
        name: "remote",
        transport: "sse",
        url: "https://mcp.example.com/sse",
      });

      expect(mockTempConnect).toHaveBeenCalledWith(
        expect.objectContaining({ transport: "sse", url: "https://mcp.example.com/sse" }),
      );
    });

    it("passes headers to temporary manager", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("authed-test", [])));

      // Use a ${VAR} reference form — the credential firewall passes
      // through already-substituted ${VAR} refs without touching them.
      const handlers = createMcpHandlers({ mcpClientManager: createMockManager(), logger: makeLogger() });
      await handlers["mcp.test"]({
        name: "authed-test",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { "X-API-Key": "${MY_API_KEY}" },
      });

      expect(mockTempConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { "X-API-Key": "${MY_API_KEY}" },
        }),
      );
    });

    // -------------------------------------------------------------------------
    // mcp.test must apply the same pre-spawn safety controls as mcp.connect:
    //   - plaintext-secret guard (raw tokens could be passed in env and
    //     would reach the child process)
    //   - findUnresolvedEnvRefs validation (test would fail at spawn-time
    //     instead of producing the structured pre-spawn error)
    //   - safetyAllowedEnvKeys plumb-through (operator-extension keys
    //     are dropped for the test connect)
    //   - osvCheckEnabled / osvCacheTtlMs plumb-through (test connects
    //     would use hard-coded defaults, ignoring operator overrides)
    //   - rlimits plumb-through (test spawns would have no resource caps)
    //
    // mcp.test IS a pre-spawn surface (it actually spawns the child to
    // probe it). Every guard from mcp.connect must be mirrored onto mcp.test.
    // -------------------------------------------------------------------------
    describe("mcp.test safety parity", () => {
      it("rejects ghp_ plaintext secret with [plaintext_secret_in_env] same as mcp.connect", async () => {
        const handlers = createMcpHandlers({
          mcpClientManager: createMockManager(),
          logger: makeLogger(),
        });
        await expect(
          handlers["mcp.test"]({
            name: "gh-test",
            transport: "stdio",
            command: "npx",
            env: { GITHUB_TOKEN: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
          }),
        ).rejects.toThrow(/\[plaintext_secret_in_env\] env\.GITHUB_TOKEN/);
        expect(mockTempConnect).not.toHaveBeenCalled();
      });

      it("rejects sk- plaintext secret with [plaintext_secret_in_env] same as mcp.connect", async () => {
        const handlers = createMcpHandlers({
          mcpClientManager: createMockManager(),
          logger: makeLogger(),
        });
        await expect(
          handlers["mcp.test"]({
            name: "oa-test",
            transport: "stdio",
            command: "npx",
            env: { OPENAI_API_KEY: "sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef" },
          }),
        ).rejects.toThrow(/\[plaintext_secret_in_env\] env\.OPENAI_API_KEY/);
        expect(mockTempConnect).not.toHaveBeenCalled();
      });

      it("ALLOWS plaintext secret when disablePlaintextSecretCheck:true and logs WARN", async () => {
        mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__optout", [])));
        const logger = makeLogger();
        const handlers = createMcpHandlers({
          mcpClientManager: createMockManager(),
          logger,
        });
        await handlers["mcp.test"]({
          name: "optout",
          transport: "stdio",
          command: "npx",
          env: { GITHUB_TOKEN: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
          disablePlaintextSecretCheck: true,
        } as any);
        expect(mockTempConnect).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "mcp.test",
            errorKind: "config",
          }),
          expect.stringContaining("plaintext-secret check disabled"),
        );
      });

      it("rejects unresolved ${VAR} env reference with [invalid_value] same as mcp.connect", async () => {
        const sm = createSecretManager({}); // FOO absent
        const handlers = createMcpHandlers({
          mcpClientManager: createMockManager(),
          logger: makeLogger(),
          secretManager: sm,
        });
        await expect(
          handlers["mcp.test"]({
            name: "missing-env-test",
            transport: "stdio",
            command: "npx",
            args: ["pkg"],
            env: { FOO: "${MISSING_VAR}" },
          }),
        ).rejects.toThrow(/\[invalid_value\].*MCP server "missing-env-test" references env var MISSING_VAR/);
        expect(mockTempConnect).not.toHaveBeenCalled();
      });

      it("forwards safetyAllowedEnvKeys from container.config.integrations.mcp to the temp connect", async () => {
        mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__allowed-keys", [])));
        const handlers = createMcpHandlers({
          mcpClientManager: createMockManager(),
          logger: makeLogger(),
          container: {
            config: {
              integrations: {
                mcp: {
                  safetyAllowedEnvKeys: ["CUSTOM_CA_CERT_PATH"],
                },
              },
            },
          },
        } as any);
        await handlers["mcp.test"]({
          name: "allowed-keys",
          transport: "stdio",
          command: "npx",
        });
        expect(mockTempConnect).toHaveBeenCalledWith(
          expect.objectContaining({
            safetyAllowedEnvKeys: ["CUSTOM_CA_CERT_PATH"],
          }),
        );
      });

      it("forwards osvCheckEnabled and osvCacheTtlMs from container.config.integrations.mcp to the temp connect", async () => {
        mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__osv-cfg", [])));
        const handlers = createMcpHandlers({
          mcpClientManager: createMockManager(),
          logger: makeLogger(),
          container: {
            config: {
              integrations: {
                mcp: {
                  osvCheckEnabled: false,
                  osvCacheTtlMs: 3_600_000,
                },
              },
            },
          },
        } as any);
        await handlers["mcp.test"]({
          name: "osv-cfg",
          transport: "stdio",
          command: "npx",
        });
        expect(mockTempConnect).toHaveBeenCalledWith(
          expect.objectContaining({
            osvCheckEnabled: false,
            osvCacheTtlMs: 3_600_000,
          }),
        );
      });

      it("forwards persisted rlimits from container.config.integrations.mcp.servers[name].rlimits", async () => {
        mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__limited", [])));
        const handlers = createMcpHandlers({
          mcpClientManager: createMockManager(),
          logger: makeLogger(),
          container: {
            config: {
              integrations: {
                mcp: {
                  servers: [
                    { name: "limited", transport: "stdio", command: "npx", enabled: true, rlimits: { cpu: 600 } },
                  ],
                },
              },
            },
          },
        } as any);
        await handlers["mcp.test"]({
          name: "limited",
          transport: "stdio",
          command: "npx",
        });
        expect(mockTempConnect).toHaveBeenCalledWith(
          expect.objectContaining({ rlimits: { cpu: 600 } }),
        );
      });

      it("caller-supplied rlimits override the persisted entry for mcp.test", async () => {
        mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__override", [])));
        const handlers = createMcpHandlers({
          mcpClientManager: createMockManager(),
          logger: makeLogger(),
          container: {
            config: {
              integrations: {
                mcp: {
                  servers: [
                    { name: "override", transport: "stdio", command: "npx", enabled: true, rlimits: { cpu: 300 } },
                  ],
                },
              },
            },
          },
        } as any);
        await handlers["mcp.test"]({
          name: "override",
          transport: "stdio",
          command: "npx",
          rlimits: { cpu: 900 },
        } as any);
        expect(mockTempConnect).toHaveBeenCalledWith(
          expect.objectContaining({ rlimits: { cpu: 900 } }),
        );
      });
    });
  });

  describe("mcp.reconnect headers", () => {
    it("passes headers to McpServerConfig on fallback reconnect", async () => {
      // reconnect returns "no stored config" so handler falls back to connect with provided params
      (manager.reconnect as any).mockResolvedValue(err(new Error('MCP server "recon-srv" has no stored config -- use connect() instead')));
      (manager.connect as any).mockResolvedValue(ok(makeConnection("recon-srv", [])));

      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });
      await handlers["mcp.reconnect"]({
        server_name: "recon-srv",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "Authorization": "Bearer recon-token" },
      });

      expect(manager.connect).toHaveBeenCalledWith(expect.objectContaining({
        name: "recon-srv",
        headers: { "Authorization": "Bearer recon-token" },
      }));
    });
  });

  // -------------------------------------------------------------------------
  // mcp.connect env var validation
  // -------------------------------------------------------------------------
  describe("mcp.connect env var validation", () => {
    // Pre-spawn rejection: missing env var produces the structured
    // [invalid_value] error and manager.connect is NOT called.
    it("rejects pre-spawn when env block references a missing ${VAR}", async () => {
      const sm = createSecretManager({}); // FINNHUB_API_KEY absent
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
      });

      await expect(
        handlers["mcp.connect"]({
          server_name: "finnhub",
          transport: "stdio",
          command: "uvx",
          args: ["mcp-finnhub"],
          env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
        }),
      ).rejects.toThrow(
        /\[invalid_value\] enabled MCP server "finnhub" references env var FINNHUB_API_KEY/,
      );

      expect(manager.connect).not.toHaveBeenCalled();
    });

    // Strict tightening: same env block, secret present → passes
    // through and calls manager.connect as before.
    it("accepts and connects when ${VAR} resolves", async () => {
      const sm = createSecretManager({ FINNHUB_API_KEY: "abc123" });
      (manager.connect as any).mockResolvedValue(ok(makeConnection("finnhub", [makeTool("quote")])));

      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
      });

      const result = await handlers["mcp.connect"]({
        server_name: "finnhub",
        transport: "stdio",
        command: "uvx",
        args: ["mcp-finnhub"],
        env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
      }) as any;

      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "finnhub",
          env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
        }),
      );
      expect(result.status).toBe("connected");
    });

    // Params with no env block: validator is a no-op, existing
    // connect behavior preserved (e.g., stdio servers without secrets).
    it("passes through when params have no env block", async () => {
      const sm = createSecretManager({});
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));

      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
      });

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      });

      expect(manager.connect).toHaveBeenCalled();
    });

    // Defensive: secretManager unwired (test setups omit it) → check
    // is skipped, the connect proceeds. Production always wires it.
    it("skips validator entirely when secretManager is undefined", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("legacy", [])));

      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        // secretManager intentionally omitted — simulates deps wired without one.
      });

      await handlers["mcp.connect"]({
        server_name: "legacy",
        transport: "stdio",
        command: "noop",
        env: { SOME_VAR: "${SOME_VAR}" },
      });

      // No throw, manager.connect was called (the check is skipped when unwired).
      expect(manager.connect).toHaveBeenCalled();
    });

    // 3+ unresolved vars: error lists 3 alphabetically + (+N more).
    // Identical wording to config.patch via shared formatMissingEnvRefError.
    it("caps 4 missing vars to first 3 alphabetically with (+1 more)", async () => {
      const sm = createSecretManager({});
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
      });

      await expect(
        handlers["mcp.connect"]({
          server_name: "many",
          transport: "stdio",
          command: "noop",
          env: {
            VAR_A: "${A}",
            VAR_B: "${B}",
            VAR_C: "${C}",
            VAR_D: "${D}",
          },
        }),
      ).rejects.toThrow(/references env vars A, B, C \(\+1 more\)/);

      expect(manager.connect).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Persistence + audit-log integration.
  // These tests prove the wiring is correct.
  // -------------------------------------------------------------------------

  // makePersistDeps must return ONE shared object for `persistDeps.container`
  // and the outer `container` field. In production wiring
  // (rpc-dispatch.ts:248-267) both refer to the SAME `deps.container`
  // reference — using two separate object literals would let a bug where the
  // in-memory refresh writes to the wrong container pass tests but fail in
  // production. Sharing one container keeps the fixture aligned with
  // production semantics.
  function makePersistDeps(servers: Array<{ name: string; transport: string; command?: string; args?: string[]; enabled?: boolean }> = []) {
    const container = {
      config: { integrations: { mcp: { servers } } },
    } as any;
    return {
      persistDeps: {
        // Share the SAME container reference — separate object literals would
        // cause the in-memory refresh to write to a container that the outer
        // assertion code never observed.
        container: Object.assign(container, { eventBus: { emit: vi.fn() } }),
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/default-config.yaml"],
        logger: makeLogger(),
      } as any,
      container,
    };
  }

  // -------------------------------------------------------------------------
  // Production parity: makePersistDeps's `persistDeps.container` and outer
  // `container` MUST refer to the same object. In production wiring
  // (rpc-dispatch.ts) both reach the same `deps.container`. A bug in the
  // in-memory swap path that wrote to the wrong container would pass tests
  // but fail in production.
  // -------------------------------------------------------------------------
  describe("makePersistDeps — production parity (shared container reference)", () => {
    it("persistDeps.container and outer container point to the SAME object", () => {
      const { persistDeps, container } = makePersistDeps([]);
      expect(persistDeps.container).toBe(container);
    });

    it("mutating persistDeps.container.config.integrations.mcp.servers is visible through outer container", () => {
      const { persistDeps, container } = makePersistDeps([]);
      persistDeps.container.config.integrations.mcp.servers = [
        { name: "ctx7", transport: "stdio", command: "npx", enabled: true },
      ];
      expect(container.config.integrations.mcp.servers).toEqual([
        { name: "ctx7", transport: "stdio", command: "npx", enabled: true },
      ]);
    });
  });

  beforeEach(() => {
    mockPersistToConfig.mockClear();
    mockPersistToConfig.mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } } as never);
    mockBuildConfigAuditBase.mockClear();
    mockBuildConfigAuditBase.mockReturnValue({} as any);
    mockAppendConfigAuditWithOutcome.mockClear();
  });

  describe("mcp.connect persistence", () => {
    it("calls persistToConfig with skipRestart:true and mcp.connect actionType after a successful manager.connect", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [makeTool("price")])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
        args: ["yfinance-mcp-ts"],
      });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [callDeps, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callDeps).toBe(persistDeps);
      expect(callOpts.skipRestart).toBe(true);
      expect(callOpts.actionType).toBe("mcp.connect");
      expect(callOpts.entityId).toBe("yfinance");
      expect(callOpts.patch.integrations.mcp.servers).toEqual([
        expect.objectContaining({
          name: "yfinance",
          transport: "stdio",
          command: "npx",
          args: ["yfinance-mcp-ts"],
          enabled: true,
        }),
      ]);
    });

    it("does NOT call persistToConfig when manager.connect returns err (spawn-failure isolation)", async () => {
      (manager.connect as any).mockResolvedValue(err(new Error("spawn ENOENT")));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await expect(
        handlers["mcp.connect"]({
          server_name: "badmcp",
          transport: "stdio",
          command: "nope",
        }),
      ).rejects.toThrow("Failed to connect");

      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });

    // Closes the chicken-and-egg between mcp.connect's
    // needs_oauth_login refusal and mcp.oauth_login's "server not found"
    // lookup (mcp-oauth-handlers.ts:135-138 reads container.config). When the
    // operator explicitly opts in with auth:"oauth" and connect fails with
    // needs_oauth_login, the server entry MUST be persisted with auth:"oauth"
    // BEFORE the structured throw so the next mcp_login finds it.
    //
    // Observed live failure sequence without the persist: connect →
    // [needs_oauth_login] hint → mcp_login → "MCP server not found".
    it("persists the entry with auth:'oauth' BEFORE throwing when params.auth==='oauth' and manager returns needs_oauth_login", async () => {
      const needsOAuthErr = Object.assign(
        new Error(`MCP server "higgsfield" requires OAuth login.`),
        { code: "needs_oauth_login" as const },
      );
      (manager.connect as any).mockResolvedValue(err(needsOAuthErr));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      let thrownError: unknown;
      try {
        await handlers["mcp.connect"]({
          server_name: "higgsfield",
          transport: "http",
          url: "https://mcp.higgsfield.ai/mcp",
          auth: "oauth",
        });
      } catch (e) {
        thrownError = e;
      }

      // The structured needs_oauth_login throw is preserved.
      expect((thrownError as { data?: unknown }).data).toMatchObject({
        needs_oauth_login: true,
        server_name: "higgsfield",
      });

      // The entry is persisted with auth:"oauth" so mcp.oauth_login can find it.
      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.actionType).toBe("mcp.connect");
      expect(callOpts.entityId).toBe("higgsfield");
      expect(callOpts.patch.integrations.mcp.servers).toEqual([
        expect.objectContaining({
          name: "higgsfield",
          transport: "http",
          url: "https://mcp.higgsfield.ai/mcp",
          auth: "oauth",
        }),
      ]);

      // In-memory swap also visible so subsequent mcp.oauth_login finds the entry.
      const servers = container.config.integrations.mcp.servers;
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({ name: "higgsfield", auth: "oauth" });
    });

    // The agent's mcp_manage(connect,
    // auth:"oauth") on a fresh server SHOULD NOT call manager.connect at all
    // (the SDK's DCR would fail with "at least one redirect_uri is required"
    // because Comis only populates clientMetadata.redirect_uris when
    // mcp.oauth_login starts the loopback callback server). Short-circuit
    // when no token exists: persist the entry, throw structured
    // needs_oauth_login so the agent calls mcp_login(server_name) which DOES
    // start the loopback and provides a real redirect URI.
    //
    // Observed live: without the short-circuit, a fresh install surfaced the
    // readable DCR error but the entry never persisted (manager.connect threw
    // a generic ServerError, not needs_oauth_login → the post-fail persist
    // branch was skipped), so the subsequent mcp_login returned "MCP server
    // not found".
    it("short-circuits manager.connect when params.auth==='oauth' AND no token exists yet (persists + throws needs_oauth_login)", async () => {
      const fakeTokenStore = {
        // Production tokens() reads ~/.comis/mcp-tokens/<server>.json and returns
        // undefined when the file is missing. The token-store API is async; the
        // handler awaits it.
        tokens: vi.fn().mockResolvedValue(undefined),
      };
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
        createTokenStore: () => fakeTokenStore,
      } as any);

      let thrownError: unknown;
      try {
        await handlers["mcp.connect"]({
          server_name: "higgsfield",
          transport: "http",
          url: "https://mcp.higgsfield.ai/mcp",
          auth: "oauth",
        });
      } catch (e) {
        thrownError = e;
      }

      // 1. The doomed handshake is skipped entirely — no DCR-with-empty-
      //    redirect_uris attempt.
      expect(manager.connect).not.toHaveBeenCalled();

      // 2. The structured needs_oauth_login is thrown so the agent's tool
      //    catch can surface the actionable hint.
      expect((thrownError as { data?: unknown }).data).toMatchObject({
        needs_oauth_login: true,
        server_name: "higgsfield",
      });

      // 3. The entry is persisted with auth:"oauth" so the next
      //    mcp.oauth_login finds it (mcp-oauth-handlers.ts:135).
      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.patch.integrations.mcp.servers).toEqual([
        expect.objectContaining({
          name: "higgsfield",
          auth: "oauth",
        }),
      ]);

      // 4. tokenStore.tokens(server_name) was the gate.
      expect(fakeTokenStore.tokens).toHaveBeenCalledWith("higgsfield");
    });

    // Env-mode regression: the mode-selected pass-through `() => boot.mcpTokenStore`
    // is a DEFINED factory that RETURNS undefined in env storage mode (no writable
    // MCP OAuth store). The pre-check must treat that as "no token" — short-circuit
    // to needs_oauth_login (persist + structured throw) — WITHOUT crashing on a
    // `.tokens()` deref of undefined and WITHOUT any plaintext-disk fallback.
    it("treats a store-factory that returns undefined (env mode) as no-token: short-circuits to needs_oauth_login without crashing", async () => {
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
        // env-mode pass-through: defined factory, returns undefined.
        createTokenStore: () => undefined,
      } as any);

      let thrownError: unknown;
      try {
        await handlers["mcp.connect"]({
          server_name: "higgsfield",
          transport: "http",
          url: "https://mcp.higgsfield.ai/mcp",
          auth: "oauth",
        });
      } catch (e) {
        thrownError = e;
      }

      // No crash on `undefined.tokens(...)`; the doomed handshake is skipped …
      expect(manager.connect).not.toHaveBeenCalled();
      // … and the structured needs_oauth_login is thrown so the agent surfaces
      // the actionable "run mcp_login" hint.
      expect((thrownError as { data?: unknown }).data).toMatchObject({
        needs_oauth_login: true,
        server_name: "higgsfield",
      });
      // The entry was persisted with auth:"oauth" so mcp.oauth_login finds it.
      expect(mockPersistToConfig).toHaveBeenCalledOnce();
    });

    it("does NOT short-circuit when params.auth==='oauth' AND a token already exists (refresh path proceeds normally)", async () => {
      // Existing tokens → manager.connect SHOULD run (the SDK will use the
      // refresh path; needs_oauth_login only fires if refresh fails).
      const fakeTokenStore = {
        tokens: vi.fn().mockResolvedValue({ access_token: "abc", token_type: "Bearer" }),
      };
      (manager.connect as any).mockResolvedValue(ok(makeConnection("higgsfield", [makeTool("gen")])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
        createTokenStore: () => fakeTokenStore,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "higgsfield",
        transport: "http",
        url: "https://mcp.higgsfield.ai/mcp",
        auth: "oauth",
      });

      expect(manager.connect).toHaveBeenCalled();
      expect(fakeTokenStore.tokens).toHaveBeenCalledWith("higgsfield");
    });

    it("does NOT call tokenStore.tokens when params.auth is NOT 'oauth' (header-auth path unchanged)", async () => {
      const fakeTokenStore = {
        tokens: vi.fn().mockResolvedValue(undefined),
      };
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [makeTool("read")])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
        createTokenStore: () => fakeTokenStore,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
        args: ["@upstash/context7-mcp"],
      });

      expect(fakeTokenStore.tokens).not.toHaveBeenCalled();
      expect(manager.connect).toHaveBeenCalled();
    });

    it("does NOT persist when manager returns needs_oauth_login WITHOUT params.auth==='oauth' (hint-only path)", async () => {
      // Connect without opting in: the user just wanted to add a server;
      // the daemon hands back the needs_oauth_login hint but does NOT
      // pollute config with an unrequested registration.
      const needsOAuthErr = Object.assign(
        new Error(`MCP server "x" requires OAuth login.`),
        { code: "needs_oauth_login" as const },
      );
      (manager.connect as any).mockResolvedValue(err(needsOAuthErr));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await expect(
        handlers["mcp.connect"]({
          server_name: "x",
          transport: "http",
          url: "https://x/mcp",
        }),
      ).rejects.toMatchObject({
        data: { needs_oauth_login: true },
      });

      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });

    it("returns persistence:'skipped' when persistDeps is not wired (existing-test invariant)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("x", [])));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

      const result = await handlers["mcp.connect"]({
        server_name: "x",
        transport: "stdio",
        command: "npx",
      }) as any;

      expect(result.persistence).toBe("skipped");
      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });

    it("returns persistence:'persisted' and emits an audit JSONL record on persist success", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
      }) as any;

      expect(result.persistence).toBe("persisted");
      expect(result.warning).toBeUndefined();
      expect(mockBuildConfigAuditBase).toHaveBeenCalledWith(expect.any(String), "mcp.connect");
      expect(mockAppendConfigAuditWithOutcome).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: "rename" }),
        expect.anything(),
      );
    });

    it("preserves unresolved env-ref literals in the persisted patch", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ywithenv", [])));
      const sm = createSecretManager({ YFINANCE_PROXY_LIST: "secret-value-not-in-yaml" });
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretManager: sm,
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ywithenv",
        transport: "stdio",
        command: "npx",
        env: { PROXY: "${YFINANCE_PROXY_LIST}" },
      });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.patch.integrations.mcp.servers[0].env.PROXY).toBe("${YFINANCE_PROXY_LIST}");
    });

    it("filters existing same-name entry and appends new one (overwrite)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", args: ["v1"], enabled: true },
        { name: "other", transport: "stdio", command: "npx", args: ["other"], enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
        args: ["v2", "--verbose"],
      });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      const servers = callOpts.patch.integrations.mcp.servers;
      expect(servers).toHaveLength(2);
      expect(servers[0]).toEqual(expect.objectContaining({ name: "other" }));
      expect(servers[1]).toEqual(expect.objectContaining({
        name: "yfinance",
        args: ["v2", "--verbose"],
      }));
    });

    // -----------------------------------------------------------------------
    // SECURITY REGRESSION fix: the persisted `newEntry` must RETAIN the
    // config-only fields from the prior persisted entry.
    //
    // mcp.connect has NO RPC params for toolAllowlist/toolBlocklist/
    // enableResources/enablePrompts/supportsParallelToolCalls/idleTtlMs
    // (config-only by design). The runtime McpServerConfig already forwards
    // them from `persistedEntry`, but the PERSISTED McpServerEntry (the entry
    // written back to config.yaml via persistToConfig) dropped them and
    // hardcoded idleTtlMs:0.
    //
    // Consequence — dropping toolAllowlist/toolBlocklist on persist is a
    // SECURITY REGRESSION: an operator who set `toolAllowlist: ["safe_tool"]`
    // in config.yaml and then triggers mcp.connect on that server gets the
    // entry rewritten WITHOUT the allowlist, so on the next daemon restart
    // ALL tools from that server surface to the agent — bypassing the filter.
    // -----------------------------------------------------------------------
    it("retains toolAllowlist/toolBlocklist/enableResources/enablePrompts/supportsParallelToolCalls + positive idleTtlMs from the prior persisted entry on the persisted patch (security regression)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("guarded", [])));
      const { persistDeps, container } = makePersistDeps([
        {
          name: "guarded",
          transport: "stdio",
          command: "npx",
          args: ["guarded-mcp"],
          enabled: true,
          // Config-only fields the operator set in config.yaml — mcp.connect
          // has no RPC param for any of these.
          toolAllowlist: ["safe_tool"],
          toolBlocklist: ["dangerous_tool"],
          enableResources: false,
          enablePrompts: false,
          supportsParallelToolCalls: true,
          idleTtlMs: 300_000,
          // auth/oauth are config-only on mcp.connect too —
          // dropping them on persist downgrades the server to no-auth.
          auth: "oauth",
          oauth: { scope: "read", stripeAccount: "acct_1" },
        } as any,
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "guarded",
        transport: "stdio",
        command: "npx",
        args: ["guarded-mcp"],
      });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      const persisted = callOpts.patch.integrations.mcp.servers.find(
        (s: { name: string }) => s.name === "guarded",
      );
      expect(persisted).toBeDefined();
      // The allowlist/blocklist MUST survive the rewrite — dropping them is the
      // security regression described above.
      expect(persisted.toolAllowlist).toEqual(["safe_tool"]);
      expect(persisted.toolBlocklist).toEqual(["dangerous_tool"]);
      // Resources/prompts opt-outs must survive.
      expect(persisted.enableResources).toBe(false);
      expect(persisted.enablePrompts).toBe(false);
      // Parallel-calls opt-in must survive.
      expect(persisted.supportsParallelToolCalls).toBe(true);
      // Positive idleTtlMs must be preserved, NOT reset to 0.
      expect(persisted.idleTtlMs).toBe(300_000);
      // auth/oauth must survive the persist rewrite.
      expect(persisted.auth).toBe("oauth");
      expect(persisted.oauth).toEqual({ scope: "read", stripeAccount: "acct_1" });
    });

    // Corollary: a server with NO config-only fields set must persist a clean
    // entry — no spurious allowlist/blocklist keys, idleTtlMs defaults to 0
    // (disabled). Guards against the helper accidentally injecting undefined
    // values via unconditional spreads.
    it("persists idleTtlMs:0 and omits tool filters when the prior entry had none", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("plain", [])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "plain",
        transport: "stdio",
        command: "npx",
      });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      const persisted = callOpts.patch.integrations.mcp.servers.find(
        (s: { name: string }) => s.name === "plain",
      );
      expect(persisted).toBeDefined();
      expect(persisted.idleTtlMs).toBe(0);
      expect(persisted).not.toHaveProperty("toolAllowlist");
      expect(persisted).not.toHaveProperty("toolBlocklist");
      expect(persisted).not.toHaveProperty("enableResources");
      expect(persisted).not.toHaveProperty("enablePrompts");
      expect(persisted).not.toHaveProperty("supportsParallelToolCalls");
      expect(persisted).not.toHaveProperty("auth");
      expect(persisted).not.toHaveProperty("oauth");
    });
  });

  // -------------------------------------------------------------------------
  // rlimits accepted on mcp.connect AND persisted to the McpServerEntry, then
  // applied to the spawn-time wrap on this and subsequent connects.
  //
  // Without these tests, the handler could compute `rlimits:
  // persistedEntry?.rlimits` from an already-persisted entry only, so a fresh
  // `mcp.connect` of a new server would receive `rlimits: undefined` (no
  // prlimit wrap). If the newEntry built in mcp-handlers.ts did NOT carry
  // rlimits either, then even a subsequent reconnect would see the same
  // `undefined`. Combined with the single-writer guard (config.patch on
  // integrations.mcp.servers is blocked), operators would have NO supported
  // path to apply rlimits to a new server via mcp_manage.
  //
  // Contract: McpConnectContract.request must accept `rlimits` and forward
  // it to both the spawn-time McpServerConfig and the persisted McpServerEntry.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // In-memory swap preserves sibling integrations subkeys.
  //
  // A naive swap `(deps.container.config as ...).integrations = cloned` would
  // overwrite the entire integrations subtree. When the prior in-memory
  // `container.config.integrations` has sibling subkeys (braveSearch,
  // media, autoReply), the structuredClone of `integrations ?? {}` preserves
  // them — so the post-persist value carries them through. BUT the
  // documented edge case ("`integrations` is undefined") would replace the
  // subtree with an object that had ONLY `mcp` — silently dropping any
  // disk-state braveSearch/media/autoReply until the next daemon reload.
  //
  // The swap preserves the sibling subkeys by cloning the existing
  // `integrations` subtree (or starting from `{}` if it was undefined),
  // overwriting ONLY `.mcp.servers` (or assigning the whole .mcp if it
  // was undefined). Test pins this contract: a pre-state containing
  // braveSearch+media must yield a post-state STILL containing
  // braveSearch+media + the updated mcp.servers entry.
  // -------------------------------------------------------------------------
  describe("in-memory persist swap preserves sibling integrations subkeys", () => {
    it("preserves braveSearch and media siblings through the mcp.connect persist swap", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));

      // Build a container with the FULL integrations shape — mcp PLUS
      // siblings the test will assert survive the swap.
      const initialIntegrations = {
        braveSearch: { apiKey: "test-key", maxResultsDefault: 5 },
        media: { transcription: { provider: "openai" } },
        autoReply: { enabled: false, rules: [] },
        mcp: { servers: [] },
      };
      const sharedContainer = {
        config: { integrations: initialIntegrations },
      };
      const persistDeps = {
        container: { ...sharedContainer, eventBus: { emit: vi.fn() } },
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/default-config.yaml"],
        logger: makeLogger(),
      } as any;

      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container: sharedContainer,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      });

      // braveSearch / media / autoReply must remain in the in-memory swap.
      const swapped = sharedContainer.config.integrations as any;
      expect(swapped.braveSearch).toEqual({ apiKey: "test-key", maxResultsDefault: 5 });
      expect(swapped.media).toEqual({ transcription: { provider: "openai" } });
      expect(swapped.autoReply).toEqual({ enabled: false, rules: [] });
      // mcp.servers gets the new entry.
      expect(swapped.mcp.servers).toHaveLength(1);
      expect(swapped.mcp.servers[0]).toEqual(expect.objectContaining({ name: "ctx7" }));
    });

    it("does not crash when in-memory integrations is undefined; mcp.servers becomes the only key", async () => {
      // Edge case (defense-in-depth path). With no in-memory integrations to
      // preserve, the swap produces an integrations subtree with only `mcp` —
      // disk-state siblings are silently dropped from memory but disk
      // state on the next reload supplies the rest. We just need to
      // confirm the call doesn't crash and produces a usable result.
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));

      const sharedContainer: any = { config: {} }; // integrations key absent
      const persistDeps = {
        container: { ...sharedContainer, eventBus: { emit: vi.fn() } },
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/default-config.yaml"],
        logger: makeLogger(),
      } as any;
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container: sharedContainer,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      });

      expect(sharedContainer.config.integrations).toBeDefined();
      expect(sharedContainer.config.integrations.mcp.servers).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // mcp.connect forwards the persisted fields
  // (idleTtlMs, toolAllowlist, toolBlocklist, enableResources, enablePrompts)
  // into the runtime McpServerConfig handed to manager.connect.
  //
  // Omitting any of these from the constructed config means a
  // mcp.reconnect-after-disconnect (which routes through this handler) loses
  // config-file-set idle eviction / tool filtering / resources-prompts
  // opt-outs. mcp.connect accepts no CLI params for these, so the source is
  // the persisted entry.
  // -------------------------------------------------------------------------
  describe("mcp.connect forwards persisted fields to manager.connect", () => {
    it("forwards idleTtlMs/toolAllowlist/toolBlocklist/enableResources/enablePrompts from the persisted entry", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));
      const { persistDeps, container } = makePersistDeps([
        {
          name: "ctx7",
          transport: "stdio",
          command: "npx",
          enabled: true,
          // `any` cast — makePersistDeps's signature doesn't model these
          // fields, but McpServerEntrySchema does and the handler reads them
          // off the persisted entry directly.
          idleTtlMs: 300_000,
          toolAllowlist: ["safe-tool"],
          toolBlocklist: ["dangerous-tool"],
          enableResources: false,
          enablePrompts: true,
        } as any,
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      });

      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "ctx7",
          idleTtlMs: 300_000,
          toolAllowlist: ["safe-tool"],
          toolBlocklist: ["dangerous-tool"],
          enableResources: false,
          enablePrompts: true,
        }),
      );
    });

    it("omits idleTtlMs from the runtime config when the persisted value is 0 (disabled)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));
      const { persistDeps, container } = makePersistDeps([
        { name: "ctx7", transport: "stdio", command: "npx", enabled: true, idleTtlMs: 0 } as any,
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      });

      const callArg = (manager.connect as any).mock.calls[0][0];
      expect(callArg).not.toHaveProperty("idleTtlMs");
    });
  });

  // mcp.connect forwards the persisted supportsParallelToolCalls into the
  // runtime McpServerConfig handed to manager.connect. mcp.connect accepts no
  // CLI param for it (config-only forward), so the source is the persisted
  // entry. A reconnect-after-disconnect routes through this handler; without
  // the forward the PQueue concurrency opt-in is lost (silent no-op).
  describe("mcp.connect forwards persisted supportsParallelToolCalls to manager.connect", () => {
    it("forwards supportsParallelToolCalls: true from the persisted entry", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));
      const { persistDeps, container } = makePersistDeps([
        {
          name: "ctx7",
          transport: "stdio",
          command: "npx",
          enabled: true,
          supportsParallelToolCalls: true,
        } as any,
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      });

      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "ctx7",
          supportsParallelToolCalls: true,
        }),
      );
    });

    it("omits supportsParallelToolCalls when absent on the persisted entry", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));
      const { persistDeps, container } = makePersistDeps([
        { name: "ctx7", transport: "stdio", command: "npx", enabled: true } as any,
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      });

      const callArg = (manager.connect as any).mock.calls[0][0];
      expect(callArg).not.toHaveProperty("supportsParallelToolCalls");
    });
  });

  // mcp.connect forwards the persisted auth/oauth into the runtime
  // McpServerConfig handed to manager.connect. mcp.connect accepts no CLI
  // param for them (config-only forward), so the source is the persisted
  // entry. A reconnect-after-disconnect routes through this handler; without
  // the forward the OAuthClientProvider is never wired (silent downgrade to
  // no-auth).
  describe("mcp.connect forwards persisted auth/oauth to manager.connect", () => {
    it("forwards auth='oauth' + oauth block from the persisted entry", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("notion", [])));
      const { persistDeps, container } = makePersistDeps([
        {
          name: "notion",
          transport: "http",
          url: "https://mcp.notion.com/mcp",
          enabled: true,
          auth: "oauth",
          oauth: { scope: "read", stripeAccount: "acct_1" },
        } as any,
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "notion",
        transport: "http",
        url: "https://mcp.notion.com/mcp",
      });

      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "notion",
          auth: "oauth",
          oauth: { scope: "read", stripeAccount: "acct_1" },
        }),
      );
    });

    it("omits auth/oauth when absent on the persisted entry", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));
      const { persistDeps, container } = makePersistDeps([
        { name: "ctx7", transport: "stdio", command: "npx", enabled: true } as any,
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      });

      const callArg = (manager.connect as any).mock.calls[0][0];
      expect(callArg).not.toHaveProperty("auth");
      expect(callArg).not.toHaveProperty("oauth");
    });
  });

  // -------------------------------------------------------------------------
  // first-install auth:"oauth" promotion
  //
  // When mcp.connect is called with auth:"oauth" and there is no prior
  // persistedEntry (first install), buildPersistedMcpEntry must receive
  // auth:"oauth" so the stored config entry retains it. Without this, the
  // mcp.oauth_login precondition check (entry.auth !== "oauth") later rejects
  // with "not configured for OAuth".
  //
  // These tests guard the regression where mcp-handlers.ts does NOT pass
  // params.auth to buildPersistedMcpEntry — auth:"oauth" must be explicitly
  // threaded through for the first-install case (there is no persisted entry
  // to inherit it from).
  // -------------------------------------------------------------------------
  describe("mcp.connect first-install auth:oauth promotion", () => {
    it("stores auth:oauth on the persisted entry when params.auth='oauth' on first install (no prior persistedEntry)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("higgsfield", [])));
      const { persistDeps, container } = makePersistDeps([]); // empty — no prior entry
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "higgsfield",
        transport: "http",
        url: "https://mcp.higgsfield.ai/mcp",
        auth: "oauth",
      } as any);

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      const persistedEntry = callOpts.patch.integrations.mcp.servers.find(
        (s: { name: string }) => s.name === "higgsfield",
      );
      expect(persistedEntry).toBeDefined();
      expect(persistedEntry.auth).toBe("oauth");
    });

    it("forwards auth:oauth to manager.connect runtime config on first install", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("higgsfield", [])));
      const { persistDeps, container } = makePersistDeps([]); // first install
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "higgsfield",
        transport: "http",
        url: "https://mcp.higgsfield.ai/mcp",
        auth: "oauth",
      } as any);

      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({ name: "higgsfield", auth: "oauth" }),
      );
    });

    it("explicit params.auth wins over persistedEntry.auth when both are present", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("reauth", [])));
      const { persistDeps, container } = makePersistDeps([
        {
          name: "reauth",
          transport: "http",
          url: "https://mcp.reauth.example/mcp",
          enabled: true,
          auth: "headers",
        } as any,
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      // Override from headers -> oauth via explicit param
      await handlers["mcp.connect"]({
        server_name: "reauth",
        transport: "http",
        url: "https://mcp.reauth.example/mcp",
        auth: "oauth",
      } as any);

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      const persistedEntry = callOpts.patch.integrations.mcp.servers.find(
        (s: { name: string }) => s.name === "reauth",
      );
      expect(persistedEntry.auth).toBe("oauth");
      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({ auth: "oauth" }),
      );
    });

    it("omits auth from persisted entry when params.auth is absent and no prior persistedEntry", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("noauth", [])));
      const { persistDeps, container } = makePersistDeps([]); // no prior entry
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "noauth",
        transport: "stdio",
        command: "npx",
      } as any);

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      const persistedEntry = callOpts.patch.integrations.mcp.servers.find(
        (s: { name: string }) => s.name === "noauth",
      );
      expect(persistedEntry).toBeDefined();
      expect(persistedEntry).not.toHaveProperty("auth");
    });
  });

  describe("mcp.connect rlimits accepted, forwarded, and persisted", () => {
    it("forwards rlimits to manager.connect (spawn-time) on a fresh connect with no prior persisted entry", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("limited", [])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "limited",
        transport: "stdio",
        command: "npx",
        args: ["yfinance-mcp"],
        rlimits: { cpu: 600 },
      } as any);

      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "limited",
          rlimits: { cpu: 600 },
        }),
      );
    });

    it("persists rlimits onto the McpServerEntry written to config.yaml", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("limited", [])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "limited",
        transport: "stdio",
        command: "npx",
        args: ["yfinance-mcp"],
        rlimits: { as: 1_073_741_824, nofile: 512, cpu: 600 },
      } as any);

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.patch.integrations.mcp.servers[0]).toEqual(
        expect.objectContaining({
          name: "limited",
          rlimits: { as: 1_073_741_824, nofile: 512, cpu: 600 },
        }),
      );
    });

    it("subsequent connect of the same server reads persisted rlimits when caller omits them", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("limited", [])));
      // Pre-seed the persisted store with an entry already carrying rlimits.
      const { persistDeps, container } = makePersistDeps([
        {
          name: "limited",
          transport: "stdio",
          command: "npx",
          enabled: true,
          // Use `any` cast — makePersistDeps's signature doesn't model
          // rlimits, but the production schema (McpServerEntrySchema)
          // does, and the handler reads `persistedEntry.rlimits` directly.
          rlimits: { cpu: 600 },
        } as any,
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      // Caller omits rlimits — handler should fall back to persistedEntry.rlimits.
      await handlers["mcp.connect"]({
        server_name: "limited",
        transport: "stdio",
        command: "npx",
      });

      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "limited",
          rlimits: { cpu: 600 },
        }),
      );
    });

    it("caller-supplied rlimits override the persisted entry's rlimits", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("limited", [])));
      const { persistDeps, container } = makePersistDeps([
        {
          name: "limited",
          transport: "stdio",
          command: "npx",
          enabled: true,
          rlimits: { cpu: 300 },
        } as any,
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "limited",
        transport: "stdio",
        command: "npx",
        rlimits: { cpu: 900 },
      } as any);

      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({ rlimits: { cpu: 900 } }),
      );
      // And the persisted entry reflects the caller's value, not the prior one.
      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.patch.integrations.mcp.servers[0]).toEqual(
        expect.objectContaining({ rlimits: { cpu: 900 } }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // disablePlaintextSecretCheck:true must be persisted to the McpServerEntry
  // so the opt-out survives a daemon restart.
  //
  // The handler reads `userParams.disablePlaintextSecretCheck === true`
  // at runtime (correct at connect-time), and the newEntry built in
  // mcp-handlers.ts must carry the flag to YAML. Otherwise, after a
  // restart the config is reloaded, the previously-OK env block is
  // re-evaluated, and any downstream load-time guard or symmetric
  // mcp.reconnect check silently re-fires. The schema and the
  // MutableIntegrations swap both support the field — the entry
  // builder must as well.
  // -------------------------------------------------------------------------
  describe("mcp.connect disablePlaintextSecretCheck persisted", () => {
    it("persists disablePlaintextSecretCheck:true onto the McpServerEntry", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("optout", [])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "optout",
        transport: "stdio",
        command: "npx",
        env: { GITHUB_TOKEN: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" },
        disablePlaintextSecretCheck: true,
      } as any);

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.patch.integrations.mcp.servers[0]).toEqual(
        expect.objectContaining({
          name: "optout",
          disablePlaintextSecretCheck: true,
        }),
      );
    });

    it("does NOT persist disablePlaintextSecretCheck key when the caller did not set it", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("normal", [])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "normal",
        transport: "stdio",
        command: "npx",
      });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.patch.integrations.mcp.servers[0]).not.toHaveProperty("disablePlaintextSecretCheck");
    });
  });

  describe("mcp.disconnect persistence", () => {
    it("calls persistToConfig with the filtered array on a successful disconnect", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
        { name: "other", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.disconnect"]({ server_name: "yfinance" }) as any;

      expect(result.status).toBe("disconnected");
      expect(result.persistence).toBe("persisted");
      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.skipRestart).toBe(true);
      expect(callOpts.actionType).toBe("mcp.disconnect");
      expect(callOpts.entityId).toBe("yfinance");
      expect(callOpts.patch.integrations.mcp.servers).toEqual([
        expect.objectContaining({ name: "other" }),
      ]);
    });

    it("does NOT call persistToConfig when runtime has no such server (fail-loud preserved)", async () => {
      (manager.getConnection as any).mockReturnValue(undefined);
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await expect(
        handlers["mcp.disconnect"]({ server_name: "nonexistent" }),
      ).rejects.toThrow('MCP server not found: "nonexistent"');

      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });
  });

  describe("mcp.reconnect override-rejection", () => {
    it("throws [reconnect_with_overrides_not_allowed] when override params are supplied AND a stored connection exists", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

      await expect(
        handlers["mcp.reconnect"]({
          server_name: "yfinance",
          transport: "stdio",
        }),
      ).rejects.toThrow(/\[reconnect_with_overrides_not_allowed\].*disconnect then connect/);

      // The override guard fires BEFORE manager.reconnect.
      expect(manager.reconnect).not.toHaveBeenCalled();
    });

    it("does NOT throw the override error when override params are supplied but NO stored connection exists (existing fallback-reconnect path)", async () => {
      (manager.getConnection as any).mockReturnValue(undefined);
      (manager.reconnect as any).mockResolvedValue(err(new Error("MCP server \"x\" has no stored config -- use connect() instead")));
      (manager.connect as any).mockResolvedValue(ok(makeConnection("x", [])));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

      // Override params + no stored connection → falls through to the
      // fallback-reconnect-as-connect path; does NOT throw the override error.
      const result = await handlers["mcp.reconnect"]({
        server_name: "x",
        transport: "stdio",
        command: "npx",
      }) as any;

      expect(result.status).toBe("connected");
    });
  });

  // ===========================================================================
  // Focused unit tests: persistence contract, reconnect-override guard,
  // runtime_only / audit outcomes.
  //
  // Coverage delivered here:
  //
  //   - sole-entry disconnect (leaves `[]`, not undefined)
  //   - skipRestart explicitly asserted on both connect AND disconnect
  //   - per-field reconnect-override-rejection loop (command, args, url,
  //     headers, env in addition to the existing transport assertion)
  //   - reconnect happy-path: NO override fields does not fire guard
  //   - runtime_only outcome: persist err → response has warning
  //   - disconnect happy-path explicitly returns persistence:'persisted'
  //   - failed-audit branch: appendConfigAuditWithOutcome called with
  //     {kind:'failed', message} when persistToConfig returns err
  //
  // Earlier tests already cover connect-success persistence, spawn-failure
  // isolation, env-ref preservation, same-name overwrite, fail-loud
  // disconnect. These blocks are intentionally separated so each behavior
  // is independently traceable.
  // ===========================================================================

  describe("sole-entry disconnect — disconnect of the only entry leaves []", () => {
    it("persists an empty array (NOT undefined) when removing the sole entry", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", args: [], enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.disconnect"]({ server_name: "yfinance" });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      // The slot key remains; the array value is the empty literal.
      expect(callOpts.patch.integrations.mcp.servers).toEqual([]);
      expect(callOpts.patch.integrations.mcp.servers).not.toBeUndefined();
    });
  });

  describe("skipRestart:true on both connect and disconnect persists", () => {
    it("connect passes skipRestart:true to persistToConfig", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
      });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.skipRestart).toBe(true);
    });

    it("disconnect passes skipRestart:true to persistToConfig", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.disconnect"]({ server_name: "yfinance" });

      const [, callOpts] = mockPersistToConfig.mock.calls[0] as any;
      expect(callOpts.skipRestart).toBe(true);
    });
  });

  // ===========================================================================
  // In-memory state effect after persist
  //
  // An earlier implementation wrote to disk but did NOT update
  // container.config.integrations.mcp.servers. After a successful persist,
  // the container.config.integrations subtree is structuredClone'd,
  // .mcp.servers is overwritten with the new array, and the whole subtree is
  // atomically swapped onto container.config.integrations.
  // ===========================================================================

  describe("in-memory state effect — container.config refresh after persist", () => {
    it("connect: container.config.integrations.mcp.servers reflects the new entry after persist", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      });

      // Post-call in-memory state has the new entry.
      expect(container.config.integrations.mcp.servers).toHaveLength(1);
      expect(container.config.integrations.mcp.servers[0]).toEqual(
        expect.objectContaining({ name: "ctx7", transport: "stdio", command: "npx", enabled: true }),
      );
    });

    it("disconnect: container.config.integrations.mcp.servers reflects the filtered array after persist", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
        { name: "other", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.disconnect"]({ server_name: "yfinance" });

      // Post-call in-memory state has only "other".
      expect(container.config.integrations.mcp.servers).toHaveLength(1);
      expect(container.config.integrations.mcp.servers[0]).toEqual(
        expect.objectContaining({ name: "other" }),
      );
    });

    it("atomic swap: post-persist integrations object identity differs from the pre-call object", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      // Capture the pre-call integrations object identity. After a successful
      // persist, the swap replaces the .integrations subtree with a
      // structuredClone'd copy (NOT mutate the original in place) —
      // so a reader holding the prior reference observes the pre-state.
      const preIntegrations = container.config.integrations;

      await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      });

      // Different object identity: structuredClone produced a new subtree.
      expect(container.config.integrations).not.toBe(preIntegrations);
      // The OLD reference still holds the PRE-state servers array (its .mcp
      // subtree was never mutated in place).
      expect(preIntegrations.mcp.servers).toEqual([
        expect.objectContaining({ name: "yfinance" }),
      ]);
      // The NEW reference holds the POST-state servers array.
      expect(container.config.integrations.mcp.servers).toEqual([
        expect.objectContaining({ name: "yfinance" }),
        expect.objectContaining({ name: "ctx7" }),
      ]);
    });

    it("does NOT throw and skips the swap when deps.container is absent (existing test fixture invariant)", async () => {
      // persistDeps is still wired so persistToConfig runs; container is OMITTED.
      // The orphan-branch test fixtures construct deps without container and
      // the swap MUST optional-chain away cleanly (defense-in-depth).
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));
      const { persistDeps } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        // NO container field
      } as any);

      // Must not throw.
      const result = await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      }) as any;

      expect(result.persistence).toBe("persisted");
    });

    it("does NOT mutate container.config.integrations when persistToConfig returns err (refresh is gated on success)", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("ctx7", [])));
      // Make the disk write fail; the in-memory swap must NOT happen.
      mockPersistToConfig.mockResolvedValueOnce({ ok: false, error: "EACCES" } as never);
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.connect"]({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
      }) as any;

      // The handler still returns runtime_only + warning, but the in-memory
      // state remains the PRE-call value — refresh is gated on persist success.
      expect(result.persistence).toBe("runtime_only");
      expect(container.config.integrations.mcp.servers).toHaveLength(1);
      expect(container.config.integrations.mcp.servers[0]).toEqual(
        expect.objectContaining({ name: "yfinance" }),
      );
    });
  });

  describe("reconnect-override-rejection fires for every override field independently", () => {
    // Explicit coverage for command, args, url, headers, env so every
    // override surface is pinned to a regression-safe assertion.
    const overrideFields: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["command", { command: "node" }],
      ["args", { args: ["new"] }],
      ["url", { url: "http://example.com/sse" }],
      ["headers", { headers: { "X-New": "1" } }],
      ["env", { env: { NEW: "1" } }],
    ];

    for (const [fieldName, overrideParams] of overrideFields) {
      it(`throws [reconnect_with_overrides_not_allowed] when ${fieldName} provided + stored config exists`, async () => {
        (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
        const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

        await expect(
          handlers["mcp.reconnect"]({ server_name: "yfinance", ...overrideParams } as any),
        ).rejects.toThrow(/\[reconnect_with_overrides_not_allowed\][\s\S]*disconnect then connect/);

        // Guard fires BEFORE manager.reconnect for every field.
        expect(manager.reconnect).not.toHaveBeenCalled();
      });
    }

    it("does NOT throw the override error when NO override fields are passed (reconnect happy path)", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      (manager.reconnect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      const handlers = createMcpHandlers({ mcpClientManager: manager, logger: makeLogger() });

      await expect(handlers["mcp.reconnect"]({ server_name: "yfinance" })).resolves.toBeDefined();

      // Guard does NOT fire; manager.reconnect runs.
      expect(manager.reconnect).toHaveBeenCalledWith("yfinance");
    });
  });

  describe("runtime_only — persist err surfaces warning in response", () => {
    it("returns persistence:'runtime_only' + warning when persistToConfig returns err on connect", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      mockPersistToConfig.mockResolvedValueOnce({ ok: false, error: "EACCES: write failed" } as never);
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
      }) as any;

      expect(result.persistence).toBe("runtime_only");
      expect(result.warning).toBe("EACCES: write failed");
    });

    it("returns persistence:'runtime_only' + warning when persistToConfig returns err on disconnect", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      mockPersistToConfig.mockResolvedValueOnce({ ok: false, error: "ENOSPC: out of disk" } as never);
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.disconnect"]({ server_name: "yfinance" }) as any;

      expect(result.persistence).toBe("runtime_only");
      expect(result.warning).toBe("ENOSPC: out of disk");
    });

    it("disconnect happy path explicitly returns persistence:'persisted'", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      const result = await handlers["mcp.disconnect"]({ server_name: "yfinance" }) as any;

      expect(result).toMatchObject({
        name: "yfinance",
        status: "disconnected",
        persistence: "persisted",
      });
      expect(result.warning).toBeUndefined();
    });
  });

  describe("failed audit JSONL on persistToConfig err", () => {
    it("calls appendConfigAuditWithOutcome with {kind:'failed', message} when persist fails on connect", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("yfinance", [])));
      mockPersistToConfig.mockResolvedValueOnce({ ok: false, error: "EACCES: write failed" } as never);
      const { persistDeps, container } = makePersistDeps([]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.connect"]({
        server_name: "yfinance",
        transport: "stdio",
        command: "npx",
      });

      expect(mockAppendConfigAuditWithOutcome).toHaveBeenCalledOnce();
      const [, outcomeArg] = mockAppendConfigAuditWithOutcome.mock.calls[0] as any;
      expect(outcomeArg).toEqual({ kind: "failed", message: "EACCES: write failed" });
    });

    it("calls appendConfigAuditWithOutcome with {kind:'failed', message} when persist fails on disconnect", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      mockPersistToConfig.mockResolvedValueOnce({ ok: false, error: "ENOSPC: out of disk" } as never);
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.disconnect"]({ server_name: "yfinance" });

      expect(mockAppendConfigAuditWithOutcome).toHaveBeenCalledOnce();
      const [, outcomeArg] = mockAppendConfigAuditWithOutcome.mock.calls[0] as any;
      expect(outcomeArg).toEqual({ kind: "failed", message: "ENOSPC: out of disk" });
    });

    it("calls buildConfigAuditBase with callerSource='mcp.disconnect' on disconnect", async () => {
      (manager.getConnection as any).mockReturnValue(makeConnection("yfinance"));
      const { persistDeps, container } = makePersistDeps([
        { name: "yfinance", transport: "stdio", command: "npx", enabled: true },
      ]);
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        persistDeps,
        container,
      } as any);

      await handlers["mcp.disconnect"]({ server_name: "yfinance" });

      expect(mockBuildConfigAuditBase).toHaveBeenCalledWith(expect.any(String), "mcp.disconnect");
    });
  });

  // -------------------------------------------------------------------------
  // mcp.connect headers credential firewall
  //
  // The processHeaderCredentials helper (from mcp-header-credential.ts) must
  // be called in BOTH mcp.connect and mcp.test BEFORE McpConnectContract /
  // McpTestContract parse. The canonical case: an inline OAuth bearer in
  // an Authorization header must be refused with
  // [use_oauth_login]. Tests fail if the handler does not call
  // processHeaderCredentials.
  // -------------------------------------------------------------------------

  describe("mcp.connect headers credential firewall", () => {
    // High-entropy Hugging Face token format: hf_ + 45 mixed-case chars (entropy > 3.5).
    // looksLikeSecretValue detects this via the entropy backstop (length ≥ 44, entropy > 3.5).
    const OAUTH_BEARER_CONNECT = "hf_bGkSrzmNqJpVxWyDcAoFuIeHtKlPwCvnMsRgTjUQhZBo";
    const STATIC_SECRET_CONNECT = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const mockSecretStoreConnect = {
      set: vi.fn().mockReturnValue({ ok: true }),
      get: vi.fn(),
      has: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mockSecretStoreConnect.set.mockReturnValue({ ok: true });
    });

    // OAuth bearer in Authorization header — must throw [use_oauth_login]
    it("rejects Authorization: Bearer hf_<44+> with [use_oauth_login]", async () => {
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretStore: mockSecretStoreConnect as any,
      });
      await expect(
        handlers["mcp.connect"]({
          server_name: "higgsfield",
          transport: "http",
          url: "https://api.higgsfield.ai/mcp",
          headers: { Authorization: `Bearer ${OAUTH_BEARER_CONNECT}` },
        }),
      ).rejects.toThrow(/\[use_oauth_login\]/);
      expect(manager.connect).not.toHaveBeenCalled();
    });

    // disablePlaintextSecretCheck:true must NOT bypass oauth-bearer refusal.
    it("rejects oauth bearer even with disablePlaintextSecretCheck:true (no opt-out)", async () => {
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretStore: mockSecretStoreConnect as any,
      });
      await expect(
        handlers["mcp.connect"]({
          server_name: "higgsfield",
          transport: "http",
          url: "https://api.higgsfield.ai/mcp",
          headers: { Authorization: `Bearer ${OAUTH_BEARER_CONNECT}` },
          disablePlaintextSecretCheck: true,
        } as any),
      ).rejects.toThrow(/\[use_oauth_login\]/);
      expect(manager.connect).not.toHaveBeenCalled();
    });

    // already-${VAR} Bearer form passes through without secretStore.set.
    // This is an idempotency guard.
    it("allows Authorization: Bearer \${HIGGSFIELD_TOKEN} without secretStore.set", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("higgsfield", [])));
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretStore: mockSecretStoreConnect as any,
      });
      await handlers["mcp.connect"]({
        server_name: "higgsfield",
        transport: "http",
        url: "https://api.higgsfield.ai/mcp",
        headers: { Authorization: "Bearer ${HIGGSFIELD_TOKEN}" },
      });
      expect(manager.connect).toHaveBeenCalled();
      expect(mockSecretStoreConnect.set).not.toHaveBeenCalled();
    });

    // static-secret header → secretStore.set called, header rewritten.
    it("extracts X-Api-Key: sk-ant-… to secretStore.set and rewrites header", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("myserver", [])));
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretStore: mockSecretStoreConnect as any,
      });
      await handlers["mcp.connect"]({
        server_name: "myserver",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { "X-Api-Key": STATIC_SECRET_CONNECT },
      });
      expect(mockSecretStoreConnect.set).toHaveBeenCalledWith("MCP_MYSERVER__X_API_KEY", STATIC_SECRET_CONNECT);
      // manager.connect must receive the RAW value (the actual credential),
      // not the ${VAR} literal that would cause auth failure on the immediate connect.
      expect(manager.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { "X-Api-Key": STATIC_SECRET_CONNECT },
        }),
      );
    });

    // Fail-safe: no secretStore + static-secret → throw [plaintext_secret_in_headers].
    it("throws [plaintext_secret_in_headers] when secretStore is undefined", async () => {
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        // secretStore intentionally absent — simulates a daemon with no secret store wired
      });
      await expect(
        handlers["mcp.connect"]({
          server_name: "myserver",
          transport: "http",
          url: "https://api.example.com/mcp",
          headers: { "X-Api-Key": STATIC_SECRET_CONNECT },
        }),
      ).rejects.toThrow(/\[plaintext_secret_in_headers\]/);
      expect(manager.connect).not.toHaveBeenCalled();
    });

    // Opt-out: disablePlaintextSecretCheck:true + static-secret → WARN, no throw.
    // Verifies that the WARN fires for the headers block specifically.
    it("disablePlaintextSecretCheck:true + static-secret header emits WARN and allows", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("myserver", [])));
      const logger = makeLogger();
      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger,
        // secretStore absent — opt-out should still WARN-and-allow
      });
      await handlers["mcp.connect"]({
        server_name: "myserver",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { "X-Api-Key": STATIC_SECRET_CONNECT },
        disablePlaintextSecretCheck: true,
      } as any);
      expect(manager.connect).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ errorKind: "config" }),
        expect.stringContaining("plaintext-secret check disabled"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // mcp.connect / mcp.test — mutableSecretManager live-apply
  //
  // When a static-secret header is extracted, the mutableSecretManager.upsert
  // must be called so secretManager.get() returns the value without a restart.
  // The test uses a real shared-Map pair to prove end-to-end visibility.
  // -------------------------------------------------------------------------

  describe("mcp.connect header credential — mutableSecretManager live-apply", () => {
    const STATIC_SECRET_WR01 = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    it("mcp.connect: mutableSecretManager.upsert is called after secretStore.set for a static-secret header", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("myserver", [])));
      const secretStore = {
        set: vi.fn().mockReturnValue({ ok: true }),
        get: vi.fn(),
        has: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
      };
      const upsert = vi.fn();
      const mutableSecretManager = { upsert, remove: vi.fn().mockReturnValue(false) };

      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretStore: secretStore as any,
        mutableSecretManager: mutableSecretManager as any,
      });

      await handlers["mcp.connect"]({
        server_name: "myserver",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { "X-Api-Key": STATIC_SECRET_WR01 },
      });

      expect(secretStore.set).toHaveBeenCalledWith("MCP_MYSERVER__X_API_KEY", STATIC_SECRET_WR01);
      // mutableSecretManager.upsert must fire so the value is live
      // without a daemon restart (additive no-restart guarantee).
      expect(upsert).toHaveBeenCalledOnce();
      expect(upsert).toHaveBeenCalledWith("MCP_MYSERVER__X_API_KEY", STATIC_SECRET_WR01);
    });

    it("mcp.connect: extracted MCP header secret is visible via secretManager.get() without restart", async () => {
      (manager.connect as any).mockResolvedValue(ok(makeConnection("myserver", [])));
      const secretStore = {
        set: vi.fn().mockReturnValue({ ok: true }),
        get: vi.fn(),
        has: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
      };
      // Build a real shared-Map pair to prove end-to-end visibility
      const backingMap = new Map<string, string>();
      const mutableSecretManager = {
        upsert: (key: string, value: string) => { backingMap.set(key, value); },
        remove: (key: string) => backingMap.delete(key),
      };
      const secretManager = { get: (key: string) => backingMap.get(key), has: (key: string) => backingMap.has(key), require: (key: string) => { const v = backingMap.get(key); if (!v) throw new Error(key); return v; }, keys: () => [...backingMap.keys()] };

      const handlers = createMcpHandlers({
        mcpClientManager: manager,
        logger: makeLogger(),
        secretStore: secretStore as any,
        mutableSecretManager: mutableSecretManager as any,
        secretManager: secretManager as any,
      });

      await handlers["mcp.connect"]({
        server_name: "myserver",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { "X-Api-Key": STATIC_SECRET_WR01 },
      });

      // The extracted secret must be live-visible via secretManager.get() immediately
      expect(secretManager.get("MCP_MYSERVER__X_API_KEY")).toBe(STATIC_SECRET_WR01);
    });

    it("mcp.test: mutableSecretManager.upsert is called after secretStore.set for a static-secret header", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__myserver", [])));
      mockTempDisconnectAll.mockResolvedValue(undefined);
      const secretStore = {
        set: vi.fn().mockReturnValue({ ok: true }),
        get: vi.fn(),
        has: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
      };
      const upsert = vi.fn();
      const mutableSecretManager = { upsert, remove: vi.fn().mockReturnValue(false) };

      const handlers = createMcpHandlers({
        mcpClientManager: createMockManager(),
        logger: makeLogger(),
        secretStore: secretStore as any,
        mutableSecretManager: mutableSecretManager as any,
      });

      await handlers["mcp.test"]({
        name: "myserver",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { "X-Api-Key": STATIC_SECRET_WR01 },
      });

      expect(secretStore.set).toHaveBeenCalledWith("MCP_MYSERVER__X_API_KEY", STATIC_SECRET_WR01);
      // mutableSecretManager.upsert must fire in mcp.test too.
      expect(upsert).toHaveBeenCalledOnce();
      expect(upsert).toHaveBeenCalledWith("MCP_MYSERVER__X_API_KEY", STATIC_SECRET_WR01);
    });
  });

  // -------------------------------------------------------------------------
  // mcp.test headers credential firewall
  //
  // Mirror of the mcp.connect tests above. The headers scan must also be
  // present in mcp.test — the handler spawns a real child process and an
  // OAuth bearer would reach the child without this guard.
  // Note: the pre-Zod guards in mcp.test throw directly (outside the inner
  // try/catch that wraps tempManager.connect), so rejects.toThrow is correct.
  // -------------------------------------------------------------------------

  describe("mcp.test headers credential firewall", () => {
    // High-entropy Hugging Face token format: hf_ + 45 mixed-case chars (entropy > 3.5).
    const OAUTH_BEARER_TEST = "hf_bGkSrzmNqJpVxWyDcAoFuIeHtKlPwCvnMsRgTjUQhZBo";
    const STATIC_SECRET_TEST = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const mockSecretStoreTest = {
      set: vi.fn().mockReturnValue({ ok: true }),
      get: vi.fn(),
      has: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mockSecretStoreTest.set.mockReturnValue({ ok: true });
      mockTempDisconnectAll.mockResolvedValue(undefined);
    });

    // OAuth bearer in Authorization header — must throw [use_oauth_login]
    // If handler's inner try/catch wraps it and returns
    // { success: false, error: "..." } instead of rethrowing, rejects.toThrow fails.
    it("rejects Authorization: Bearer hf_<44+> with [use_oauth_login]", async () => {
      const handlers = createMcpHandlers({
        mcpClientManager: createMockManager(),
        logger: makeLogger(),
        secretStore: mockSecretStoreTest as any,
      });
      await expect(
        handlers["mcp.test"]({
          name: "higgsfield",
          transport: "http",
          url: "https://api.higgsfield.ai/mcp",
          headers: { Authorization: `Bearer ${OAUTH_BEARER_TEST}` },
        }),
      ).rejects.toThrow(/\[use_oauth_login\]/);
      expect(mockTempConnect).not.toHaveBeenCalled();
    });

    // disablePlaintextSecretCheck:true must NOT bypass oauth-bearer.
    it("rejects oauth bearer even with disablePlaintextSecretCheck:true (no opt-out)", async () => {
      const handlers = createMcpHandlers({
        mcpClientManager: createMockManager(),
        logger: makeLogger(),
        secretStore: mockSecretStoreTest as any,
      });
      await expect(
        handlers["mcp.test"]({
          name: "higgsfield",
          transport: "http",
          url: "https://api.higgsfield.ai/mcp",
          headers: { Authorization: `Bearer ${OAUTH_BEARER_TEST}` },
          disablePlaintextSecretCheck: true,
        } as any),
      ).rejects.toThrow(/\[use_oauth_login\]/);
      expect(mockTempConnect).not.toHaveBeenCalled();
    });

    // already-${VAR} Bearer form passes through without secretStore.set.
    it("allows Authorization: Bearer \${HIGGSFIELD_TOKEN} without secretStore.set", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__higgsfield", [])));
      const handlers = createMcpHandlers({
        mcpClientManager: createMockManager(),
        logger: makeLogger(),
        secretStore: mockSecretStoreTest as any,
      });
      const result = await handlers["mcp.test"]({
        name: "higgsfield",
        transport: "http",
        url: "https://api.higgsfield.ai/mcp",
        headers: { Authorization: "Bearer ${HIGGSFIELD_TOKEN}" },
      }) as any;
      expect(result.success).toBe(true);
      expect(mockSecretStoreTest.set).not.toHaveBeenCalled();
    });

    // static-secret header → secretStore.set called.
    it("extracts X-Api-Key: sk-ant-… to secretStore.set", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__myserver", [])));
      const handlers = createMcpHandlers({
        mcpClientManager: createMockManager(),
        logger: makeLogger(),
        secretStore: mockSecretStoreTest as any,
      });
      await handlers["mcp.test"]({
        name: "myserver",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { "X-Api-Key": STATIC_SECRET_TEST },
      });
      expect(mockSecretStoreTest.set).toHaveBeenCalledWith("MCP_MYSERVER__X_API_KEY", STATIC_SECRET_TEST);
    });

    // Fail-safe: no secretStore + static-secret → throw [plaintext_secret_in_headers].
    // If handler's inner try/catch wraps it → returns
    // { success: false } instead of rejecting → rejects.toThrow fails.
    it("throws [plaintext_secret_in_headers] when secretStore is undefined", async () => {
      const handlers = createMcpHandlers({
        mcpClientManager: createMockManager(),
        logger: makeLogger(),
        // secretStore intentionally absent
      });
      await expect(
        handlers["mcp.test"]({
          name: "myserver",
          transport: "http",
          url: "https://api.example.com/mcp",
          headers: { "X-Api-Key": STATIC_SECRET_TEST },
        }),
      ).rejects.toThrow(/\[plaintext_secret_in_headers\]/);
      expect(mockTempConnect).not.toHaveBeenCalled();
    });

    // Opt-out: disablePlaintextSecretCheck:true + static-secret → WARN, no throw.
    it("disablePlaintextSecretCheck:true + static-secret header emits WARN and allows", async () => {
      mockTempConnect.mockResolvedValueOnce(ok(makeConnection("__test__myserver", [])));
      const logger = makeLogger();
      const handlers = createMcpHandlers({
        mcpClientManager: createMockManager(),
        logger,
        // secretStore absent — opt-out should WARN-and-allow
      });
      const result = await handlers["mcp.test"]({
        name: "myserver",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { "X-Api-Key": STATIC_SECRET_TEST },
        disablePlaintextSecretCheck: true,
      } as any) as any;
      expect(result.success).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ errorKind: "config" }),
        expect.stringContaining("plaintext-secret check disabled"),
      );
    });
  });
});

// ===========================================================================
// Gateway-patch single-writer guard (cross-test)
//
// The `integrations.mcp.servers is managed by mcp_manage` guard fires in
// config-write.ts. The full positive-and-negative coverage lives in
// packages/daemon/src/api/config-handlers.test.ts. This describe block adds
// a focused cross-test asserting the guard fires from the same factory
// consumers use in production.
// ===========================================================================

describe("gateway-patch single-writer guard (cross-test from mcp-handlers test file)", () => {
  it("rejects config.patch against integrations.mcp.servers and routes the caller to mcp_manage", async () => {
    // Lazy-load the SUT here so the file-top vi.mock for persist-to-config does
    // not interfere — config-write.ts imports persist-to-config too, but the
    // guard fires BEFORE that import is exercised (trust-check → single-writer
    // guard → rate-limit → persist). The mock is therefore a non-issue.
    const { bindConfigWriteHandlers } = await import("./config-handlers/config-write.js");

    // Minimal handler deps. The guard fires BEFORE deps.container, configPaths,
    // or the patch bucket are touched, so the test-double can be minimal.
    const handlers = bindConfigWriteHandlers(
      {
        container: { config: {} },
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/test-default.yaml"],
        logger: makeLogger(),
      } as any,
      // PatchBucket double: never consume (`tryConsume` always returns allowed)
      // — the guard is supposed to fire BEFORE this point is reached.
      { tryConsume: () => ({ allowed: true, retryAfterMs: 0 }) } as any,
    );

    // Dotted-path variant (the sibling test below covers the section/key shape).
    await expect(
      handlers["config.patch"]!({
        path: "integrations.mcp.servers",
        value: [{ name: "foo", transport: "stdio", command: "echo" }],
        _trustLevel: "admin",
      } as any),
    ).rejects.toThrow(/mcp_manage/);
  });

  it("rejects sub-paths under integrations.mcp.servers (section/key shape)", async () => {
    const { bindConfigWriteHandlers } = await import("./config-handlers/config-write.js");
    const handlers = bindConfigWriteHandlers(
      {
        container: { config: {} },
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/test-default.yaml"],
        logger: makeLogger(),
      } as any,
      { tryConsume: () => ({ allowed: true, retryAfterMs: 0 }) } as any,
    );

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers.0.enabled",
        value: false,
        _trustLevel: "admin",
      } as any),
    ).rejects.toThrow(/integrations\.mcp\.servers is managed by mcp_manage/);
  });

  it("admin-trust check takes precedence over the single-writer guard (non-admin trust gets the trust error, not the mcp_manage redirect)", async () => {
    const { bindConfigWriteHandlers } = await import("./config-handlers/config-write.js");
    const handlers = bindConfigWriteHandlers(
      {
        container: { config: {} },
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/test-default.yaml"],
        logger: makeLogger(),
      } as any,
      { tryConsume: () => ({ allowed: true, retryAfterMs: 0 }) } as any,
    );

    await expect(
      handlers["config.patch"]!({
        section: "integrations",
        key: "mcp.servers",
        value: [],
        _trustLevel: "user",
      } as any),
    ).rejects.toThrow(/Admin access required/);
  });
});
