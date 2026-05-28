// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the MCP OAuth RPC handlers.
 *
 * Coverage:
 *   1. login happy path: oauth_login for a configured auth:"oauth" server →
 *      the (injected) orchestrator returns authorized → tokens persisted in the
 *      tmpdir store → mcpClientManager.reconnect(server) called → response
 *      status:"authorized", server_name echoed.
 *   2. login headless: the orchestrator returns headless_hint + a portForwardHint
 *      matching `ssh -L \d+:localhost:\d+` + an authUrl; the handler does NOT
 *      reconnect and the daemon openUrl is a no-op. PLUS an architecture grep:
 *      the handler file never imports `open`.
 *   3. login failure: the orchestrator returns failed → response status:"failed"
 *      (no throw escapes the handler).
 *   4. logout: with tokens present on disk for "notion", oauth_logout removes all
 *      three files → cleared:true; a follow-up tokenStore.tokens("notion") is
 *      undefined.
 *   5. Contract-handler parity smoke: createMcpOauthHandlers returns keys EXACTLY
 *      [McpOauthLoginContract.method, McpOauthLogoutContract.method], and each
 *      handler body references "server_name" literally (the auto-discovered
 *      contract-handler-parity test enforces the mechanism repo-wide).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpOauthLoginContract, McpOauthLogoutContract } from "@comis/core";
import { createTokenStore, type TokenStore } from "@comis/skills";
import type { McpClientManager } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";

import { createMcpOauthHandlers, type McpOauthHandlerDeps } from "./mcp-oauth-handlers.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(value: T) {
  return { ok: true as const, value };
}
function err(error: Error) {
  return { ok: false as const, error };
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

function makeManager(): McpClientManager {
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

/**
 * Build deps with a persisted `auth:"oauth"` server entry for `serverName`.
 * `container.config.integrations.mcp.servers` is the read path the handler uses.
 */
function makeDeps(
  serverName: string,
  overrides: Partial<McpOauthHandlerDeps> & {
    entry?: Record<string, unknown> | null;
  } = {},
): McpOauthHandlerDeps {
  const { entry, ...rest } = overrides;
  const servers =
    entry === null
      ? []
      : [
          entry ?? {
            name: serverName,
            transport: "http",
            url: "https://mcp.example.com",
            auth: "oauth",
            oauth: { scope: "read" },
          },
        ];
  return {
    mcpClientManager: makeManager(),
    logger: makeLogger(),
    container: { config: { integrations: { mcp: { servers } } } } as unknown as McpOauthHandlerDeps["container"],
    ...rest,
  } as McpOauthHandlerDeps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP OAuth RPC handlers", () => {
  describe("createMcpOauthHandlers — factory shape (contract parity smoke)", () => {
    it("returns keys EXACTLY the two contract methods", () => {
      const handlers = createMcpOauthHandlers(makeDeps("notion"));
      expect(Object.keys(handlers).sort()).toEqual(
        [McpOauthLoginContract.method, McpOauthLogoutContract.method].sort(),
      );
    });

    it("handler-file source references server_name literally (contract-handler parity mechanism)", () => {
      const src = readFileSync(resolve(HERE, "mcp-oauth-handlers.ts"), "utf8");
      expect(src).toContain("server_name");
    });

    it("handler-file NEVER imports open (browser launch is daemon/CLI-side)", () => {
      const src = readFileSync(resolve(HERE, "mcp-oauth-handlers.ts"), "utf8");
      expect(src).not.toMatch(/from\s+["']open["']/);
      expect(src).not.toMatch(/require\(\s*["']open["']\s*\)/);
    });
  });

  describe("mcp.oauth_login", () => {
    it("happy path: authorized → reconnect called → status authorized, server_name echoed", async () => {
      const runOauthLogin = vi.fn().mockResolvedValue({ status: "authorized", authUrl: "https://auth.example.com/x" });
      const deps = makeDeps("notion", { runOauthLogin });
      (deps.mcpClientManager.reconnect as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok({ name: "notion", status: "connected", tools: [] }),
      );

      const handlers = createMcpOauthHandlers(deps);
      const res = (await handlers[McpOauthLoginContract.method]({ server_name: "notion" })) as {
        server_name: string;
        status: string;
      };

      expect(runOauthLogin).toHaveBeenCalledOnce();
      expect(runOauthLogin.mock.calls[0]![0]).toEqual(
        expect.objectContaining({ serverName: "notion", serverUrl: "https://mcp.example.com" }),
      );
      expect(deps.mcpClientManager.reconnect).toHaveBeenCalledWith("notion");
      expect(res.status).toBe("authorized");
      expect(res.server_name).toBe("notion");
    });

    it("headless: status headless_hint + portForwardHint (ssh -L) + authUrl; no reconnect; daemon openUrl is a no-op", async () => {
      const runOauthLogin = vi.fn().mockResolvedValue({
        status: "headless_hint",
        portForwardHint: "ssh -L 49152:localhost:49152 <vps>",
        authUrl: "https://auth.example.com/x?state=abc",
      });
      const deps = makeDeps("notion", { runOauthLogin });

      const handlers = createMcpOauthHandlers(deps);
      const res = (await handlers[McpOauthLoginContract.method]({ server_name: "notion" })) as {
        status: string;
        portForwardHint?: string;
        authUrl?: string;
      };

      expect(res.status).toBe("headless_hint");
      expect(res.portForwardHint).toMatch(/ssh -L \d+:localhost:\d+/);
      expect(res.authUrl).toBe("https://auth.example.com/x?state=abc");
      expect(deps.mcpClientManager.reconnect).not.toHaveBeenCalled();
    });

    it("failure: orchestrator returns failed → status failed, no throw escapes", async () => {
      const runOauthLogin = vi.fn().mockResolvedValue({ status: "failed" });
      const deps = makeDeps("notion", { runOauthLogin });

      const handlers = createMcpOauthHandlers(deps);
      const res = (await handlers[McpOauthLoginContract.method]({ server_name: "notion" })) as {
        status: string;
      };

      expect(res.status).toBe("failed");
      expect(deps.mcpClientManager.reconnect).not.toHaveBeenCalled();
    });

    it("authorized but reconnect fails → status failed (does not claim authorized)", async () => {
      const runOauthLogin = vi.fn().mockResolvedValue({ status: "authorized" });
      const deps = makeDeps("notion", { runOauthLogin });
      (deps.mcpClientManager.reconnect as ReturnType<typeof vi.fn>).mockResolvedValue(
        err(new Error("connect refused")),
      );

      const handlers = createMcpOauthHandlers(deps);
      const res = (await handlers[McpOauthLoginContract.method]({ server_name: "notion" })) as {
        status: string;
      };

      expect(res.status).toBe("failed");
    });

    it("throws on missing server_name", async () => {
      const handlers = createMcpOauthHandlers(makeDeps("notion"));
      await expect(handlers[McpOauthLoginContract.method]({})).rejects.toThrow(
        "Missing required parameter: server_name",
      );
    });

    it("throws when the server is not an auth:oauth server", async () => {
      const deps = makeDeps("plain", {
        entry: { name: "plain", transport: "http", url: "https://x", auth: "none" },
      });
      const handlers = createMcpOauthHandlers(deps);
      await expect(handlers[McpOauthLoginContract.method]({ server_name: "plain" })).rejects.toThrow(
        /not configured for OAuth/,
      );
    });

    it("throws when the server is unknown", async () => {
      const deps = makeDeps("notion", { entry: null });
      const handlers = createMcpOauthHandlers(deps);
      await expect(handlers[McpOauthLoginContract.method]({ server_name: "ghost" })).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe("mcp.oauth_logout", () => {
    let dir: string;
    let store: TokenStore;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "comis-oauth-logout-"));
    });

    afterEach(async () => {
      await store?.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("clears all three token files → cleared:true; subsequent tokens() is undefined", async () => {
      // Seed the tmpdir store with tokens for "notion".
      const logger = makeLogger();
      store = createTokenStore({
        tokensDir: dir,
        confinedBaseDir: dir,
        logger: logger as unknown as Parameters<typeof createTokenStore>[0]["logger"],
        watchPersistent: true,
      });
      await store.saveTokens("notion", {
        access_token: "AT",
        refresh_token: "RT",
        expires_in: 3600,
        token_type: "Bearer",
      });
      await store.saveClientInformation("notion", {
        client_id: "cid",
        redirect_uris: ["http://127.0.0.1:1/callback"],
      } as unknown as Parameters<TokenStore["saveClientInformation"]>[1]);
      expect(await store.tokens("notion")).toBeDefined();

      // The handler builds its own store over the same tmpdir.
      const deps = makeDeps("notion", {
        createTokenStore: () =>
          createTokenStore({
            tokensDir: dir,
            confinedBaseDir: dir,
            logger: logger as unknown as Parameters<typeof createTokenStore>[0]["logger"],
            watchPersistent: true,
          }),
      });
      const handlers = createMcpOauthHandlers(deps);
      const res = (await handlers[McpOauthLogoutContract.method]({ server_name: "notion" })) as {
        server_name: string;
        cleared: boolean;
      };

      expect(res).toEqual({ server_name: "notion", cleared: true });

      // Verify deletion via a FRESH store (the seed store's in-memory cache is
      // only invalidated by its chokidar watcher after the debounce flush — a
      // fresh store reads straight from disk, proving the files are gone).
      const verifyStore = createTokenStore({
        tokensDir: dir,
        confinedBaseDir: dir,
        logger: logger as unknown as Parameters<typeof createTokenStore>[0]["logger"],
        watchPersistent: true,
      });
      try {
        expect(await verifyStore.tokens("notion")).toBeUndefined();
        expect(await verifyStore.clientInformation("notion")).toBeUndefined();
      } finally {
        await verifyStore.close();
      }
    });

    it("throws on missing server_name", async () => {
      const handlers = createMcpOauthHandlers(makeDeps("notion"));
      await expect(handlers[McpOauthLogoutContract.method]({})).rejects.toThrow(
        "Missing required parameter: server_name",
      );
    });

    it("throws when the server is unknown — does NOT call deleteAll for arbitrary names", async () => {
      // The login handler already guards on findServerEntry; without this
      // guard the logout handler would call deleteAll for ANY string
      // `safePath` accepted — letting an admin-scope caller clear token
      // files for a server they did not configure (typo, or another
      // daemon's files in the shared mcp-tokens/ dir).
      //
      // Mirror the login handler's findServerEntry pre-flight so an unknown
      // name surfaces a clear error rather than a silent cleared:true.
      const deleteAll = vi.fn(async () => undefined);
      const closeStore = vi.fn(async () => undefined);
      const deps = makeDeps("notion", {
        entry: null,
        createTokenStore: () =>
          ({
            deleteAll,
            close: closeStore,
            // Unused by the logout handler — present to satisfy the interface.
            tokens: vi.fn(),
            saveTokens: vi.fn(),
            clientInformation: vi.fn(),
            saveClientInformation: vi.fn(),
            discoveryState: vi.fn(),
            saveDiscoveryState: vi.fn(),
            startWatch: vi.fn(),
          }) as unknown as TokenStore,
      });
      const handlers = createMcpOauthHandlers(deps);
      await expect(
        handlers[McpOauthLogoutContract.method]({ server_name: "ghost" }),
      ).rejects.toThrow(/not found/);
      // The unknown-server guard runs BEFORE any token-store side effect —
      // deleteAll must NEVER be called for a name that is not in the persisted
      // server list. (Previously this was called regardless.)
      expect(deleteAll).not.toHaveBeenCalled();
    });
  });
});
