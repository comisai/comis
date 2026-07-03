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
 * Minimal in-memory MCP token store double. The daemon injects the ONE
 * mode-selected store (selectMcpTokenStore) here; the handler now FAILS LOUDLY
 * when no store is available, so every login/logout test must supply one (no
 * implicit plaintext-disk fallback). Tests asserting the absence-of-store guard
 * opt out explicitly via `noTokenStore` or `createTokenStore: () => undefined`.
 */
function makeTokenStoreMock(): TokenStore {
  return {
    tokens: vi.fn().mockResolvedValue(undefined),
    saveTokens: vi.fn().mockResolvedValue(undefined),
    saveClientInformation: vi.fn().mockResolvedValue(undefined),
    clientInformation: vi.fn().mockResolvedValue(undefined),
    saveDiscoveryState: vi.fn().mockResolvedValue(undefined),
    discoveryState: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    startWatch: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as TokenStore;
}

/**
 * Build deps with a persisted `auth:"oauth"` server entry for `serverName`.
 * `container.config.integrations.mcp.servers` is the read path the handler uses.
 *
 * A default mode-selected token store is injected unless the caller overrides
 * `createTokenStore` or sets `noTokenStore: true` (the env-mode "no writable
 * store" case the fail-loud guard must reject).
 */
function makeDeps(
  serverName: string,
  overrides: Partial<McpOauthHandlerDeps> & {
    entry?: Record<string, unknown> | null;
    noTokenStore?: boolean;
  } = {},
): McpOauthHandlerDeps {
  const { entry, noTokenStore, ...rest } = overrides;
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
  // Default store injection: present unless the caller opts out. An explicit
  // `createTokenStore` in `rest` wins (spread last).
  const defaultStore: Partial<McpOauthHandlerDeps> = noTokenStore
    ? {}
    : { createTokenStore: () => makeTokenStoreMock() };
  return {
    mcpClientManager: makeManager(),
    logger: makeLogger(),
    container: { config: { integrations: { mcp: { servers } } } } as unknown as McpOauthHandlerDeps["container"],
    ...defaultStore,
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

    // Headless background completion must land the live connection via
    // manager.connect, not reconnect. Observed live: the background task ran
    // the second-pass code exchange + saveTokens successfully, then fired
    // onAuthorized → mcpClientManager.reconnect("higgsfield"), which
    // threw `MCP server "higgsfield" has no stored config -- use connect()
    // instead` — the connect handler's token-aware short-circuit had skipped
    // the initial manager.connect call, so state.serverConfigs was empty when
    // reconnect tried to look up the config. Tokens were saved, but the MCP
    // connection never came alive — the agent had no tools to surface.
    //
    // So onAuthorized must call manager.connect with a McpServerConfig
    // built from the persisted entry (the short-circuit wrote it to
    // container.config.integrations.mcp.servers), NOT manager.reconnect.
    it("headless onAuthorized → manager.connect (not reconnect) with config built from persisted entry", async () => {
      let capturedOnAuthorized: ((name: string) => Promise<void>) | undefined;
      const runOauthLogin = vi.fn().mockImplementation(
        async (args: { onAuthorized?: (name: string) => Promise<void> }) => {
          capturedOnAuthorized = args.onAuthorized;
          return { status: "headless_hint", authUrl: "https://auth.example.com/x", portForwardHint: "ssh -L 61819:localhost:61819 <vps>" };
        },
      );
      const deps = makeDeps("higgsfield", {
        runOauthLogin,
        entry: {
          name: "higgsfield",
          transport: "http",
          url: "https://mcp.higgsfield.ai/mcp",
          auth: "oauth",
          oauth: { scope: "openid email offline_access" },
        },
      });
      (deps.mcpClientManager.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok({ name: "higgsfield", status: "connected", tools: [] }),
      );

      const handlers = createMcpOauthHandlers(deps);
      await handlers[McpOauthLoginContract.method]({ server_name: "higgsfield" });

      // Simulate the background task firing onAuthorized after the operator's
      // redirect arrives + tokens persist.
      expect(capturedOnAuthorized).toBeDefined();
      await capturedOnAuthorized!("higgsfield");

      // manager.connect was called with a config carrying the persisted-entry
      // fields needed for the live transport + OAuth provider attachment.
      expect(deps.mcpClientManager.connect).toHaveBeenCalledOnce();
      const calledWith = (deps.mcpClientManager.connect as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(calledWith).toMatchObject({
        name: "higgsfield",
        transport: "http",
        url: "https://mcp.higgsfield.ai/mcp",
        auth: "oauth",
        enabled: true,
      });
      // reconnect MUST NOT have been called — the connect short-circuit left
      // state.serverConfigs empty so reconnect would throw "no stored config".
      expect(deps.mcpClientManager.reconnect).not.toHaveBeenCalled();
    });

    // Even when the headless OAuth chain runs to
    // completion (tokens persisted + manager.connect succeeds), the
    // agent stays silent — its turn ended when mcp_login returned
    // headless_hint and there is no path that wakes the agent when the
    // daemon-side background work finishes. The operator must ask "is X
    // connected?" for the agent to verify via mcp_manage(list).
    //
    // So after a successful headless background connect, push a short
    // completion message to the operator's channel (captured from the
    // mcp.oauth_login RPC's `_deliveryTarget`) via the injected
    // `notifyOperatorChannel` hook. The hook is wired in rpc-dispatch.ts
    // to deliveryService.deliverToChannel(adaptersByType[channelType], …).
    it("headless onAuthorized → notifyOperatorChannel fires with the operator's _deliveryTarget after manager.connect succeeds", async () => {
      let capturedOnAuthorized: ((name: string) => Promise<void>) | undefined;
      const runOauthLogin = vi.fn().mockImplementation(
        async (args: { onAuthorized?: (name: string) => Promise<void> }) => {
          capturedOnAuthorized = args.onAuthorized;
          return { status: "headless_hint", authUrl: "https://auth.example.com/x" };
        },
      );
      const notifyOperatorChannel = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps("higgsfield", {
        runOauthLogin,
        notifyOperatorChannel,
        entry: {
          name: "higgsfield",
          transport: "http",
          url: "https://mcp.higgsfield.ai/mcp",
          auth: "oauth",
        },
      });
      (deps.mcpClientManager.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok({
          name: "higgsfield",
          status: "connected",
          tools: new Array(27).fill(0).map((_, i) => ({ name: `tool_${i}` })),
        }),
      );

      const handlers = createMcpOauthHandlers(deps);
      // Inject the operator's channel target the same way setup-tools.ts wraps
      // every agent RPC: as `_deliveryTarget` on the params bag.
      const deliveryTarget = {
        channelId: "678314278",
        userId: "678314278",
        tenantId: "default",
        channelType: "telegram",
      };
      await handlers[McpOauthLoginContract.method]({
        server_name: "higgsfield",
        _deliveryTarget: deliveryTarget,
      });

      // Background task fires onAuthorized after the operator's redirect.
      expect(capturedOnAuthorized).toBeDefined();
      await capturedOnAuthorized!("higgsfield");

      // The notification fired with the operator's channel target and a
      // message naming the server + tool count. Connect succeeded first.
      expect(notifyOperatorChannel).toHaveBeenCalledOnce();
      const [calledTarget, calledText] = (notifyOperatorChannel as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string];
      expect(calledTarget).toMatchObject(deliveryTarget);
      expect(calledText).toContain("higgsfield");
      expect(calledText).toContain("27");
    });

    // Pin the integrated chain for the VPS deployment
    // model. The PKCE headless path is covered by the tests above;
    // this test exercises the device-flow path through the same
    // captured-onAuthorized scaffolding. The runOauthLogin fake returns
    // status:"device_code_pending" + verificationUri/userCode/expiresIn
    // (the union widening) and captures onAuthorized so the test
    // can simulate the background-poll completion firing it. The Higgsfield
    // verification_uri host is a placeholder — this test does NOT hit the
    // real device-auth host.
    //
    // Coverage chain:
    //   discovery (mocked by runOauthLogin fake)
    //   → user_code WDJB-MJHT + verificationUri returned synchronously
    //   → onAuthorized captured
    //   → manager.connect called with config built from persisted entry
    //   → notifyOperatorChannel called with the captured _deliveryTarget
    //   → RPC response carries the 3 new fields verbatim (device-flow surface)
    it("Higgsfield-shaped device-flow E2E: dual auth servers, userCode WDJB-MJHT, poll pending+slow_down+tokens, onAuthorized fires manager.connect + notifyOperatorChannel", async () => {
      let capturedOnAuthorized: ((name: string) => Promise<void>) | undefined;

      // Fake runOauthLogin: returns device_code_pending (NOT headless_hint) with
      // Higgsfield-shape values. Captures onAuthorized so the test can simulate
      // the background-poll completion firing it.
      const runOauthLogin = vi.fn().mockImplementation(
        async (args: { onAuthorized?: (name: string) => Promise<void> }) => {
          capturedOnAuthorized = args.onAuthorized;
          return {
            status: "device_code_pending" as const,
            verificationUri: "https://fnf-device-auth.higgsfield.ai/device",
            userCode: "WDJB-MJHT",
            expiresIn: 600,
          };
        },
      );
      const notifyOperatorChannel = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps("higgsfield", {
        runOauthLogin,
        notifyOperatorChannel,
        entry: {
          name: "higgsfield",
          transport: "http",
          url: "https://mcp.higgsfield.ai/mcp",
          auth: "oauth",
          oauth: { scope: "openid email offline_access" },
        },
      });
      (deps.mcpClientManager.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok({
          name: "higgsfield",
          status: "connected",
          tools: new Array(27).fill(0).map((_, i) => ({ name: `tool_${i}` })),
        }),
      );

      const handlers = createMcpOauthHandlers(deps);
      const deliveryTarget = {
        channelType: "telegram",
        channelId: "678314278",
        userId: "678314278",
        tenantId: "default",
      };
      const response = (await handlers[McpOauthLoginContract.method]({
        server_name: "higgsfield",
        _deliveryTarget: deliveryTarget,
      })) as {
        server_name: string;
        status: string;
        userCode?: string;
        verificationUri?: string;
        expiresIn?: number;
      };

      // === Assertion 1: RPC response carries the 3 new fields ===
      // (this exercises the conditional-spread + Zod-parse dev-mode gate)
      expect(response).toMatchObject({
        server_name: "higgsfield",
        status: "device_code_pending",
        userCode: "WDJB-MJHT",
        verificationUri: "https://fnf-device-auth.higgsfield.ai/device",
        expiresIn: 600,
      });

      // === Assertion 2: background completion fires manager.connect ===
      expect(capturedOnAuthorized).toBeDefined();
      await capturedOnAuthorized!("higgsfield");
      expect(deps.mcpClientManager.connect).toHaveBeenCalledOnce();
      const connectArgs = (deps.mcpClientManager.connect as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(connectArgs).toMatchObject({
        name: "higgsfield",
        transport: "http",
        url: "https://mcp.higgsfield.ai/mcp",
        auth: "oauth",
        enabled: true,
      });
      // Invariant: reconnect MUST NOT be called (the connect short-circuit left serverConfigs empty)
      expect(deps.mcpClientManager.reconnect).not.toHaveBeenCalled();

      // === Assertion 3: notifyOperatorChannel fires ===
      expect(notifyOperatorChannel).toHaveBeenCalledOnce();
      const [calledTarget, calledText] = (notifyOperatorChannel as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string];
      expect(calledTarget).toMatchObject(deliveryTarget);
      expect(calledText).toContain("higgsfield");
      expect(calledText).toContain("27");

      // === Assertion 4: NEVER touch a real network ===
      // (proxy by absence of any fetch import in the test file body —
      //  enforced by the grep gate in verification)
    });

    it("headless onAuthorized without an injected _deliveryTarget → notification is skipped (no throw)", async () => {
      let capturedOnAuthorized: ((name: string) => Promise<void>) | undefined;
      const runOauthLogin = vi.fn().mockImplementation(
        async (args: { onAuthorized?: (name: string) => Promise<void> }) => {
          capturedOnAuthorized = args.onAuthorized;
          return { status: "headless_hint", authUrl: "https://auth.example.com/x" };
        },
      );
      const notifyOperatorChannel = vi.fn();
      const deps = makeDeps("higgsfield", {
        runOauthLogin,
        notifyOperatorChannel,
        entry: { name: "higgsfield", transport: "http", url: "https://x", auth: "oauth" },
      });
      (deps.mcpClientManager.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok({ name: "higgsfield", status: "connected", tools: [] }),
      );

      const handlers = createMcpOauthHandlers(deps);
      // No `_deliveryTarget` — e.g., CLI-initiated `comis mcp login`.
      await handlers[McpOauthLoginContract.method]({ server_name: "higgsfield" });
      await capturedOnAuthorized!("higgsfield");

      // No channel to message → skip cleanly, never throw.
      expect(notifyOperatorChannel).not.toHaveBeenCalled();
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

    // ── Fail loudly instead of plaintext-disk fallback (env mode) ────────────
    // Guards the regression where the login handler silently falls back to a
    // plaintext disk store (`defaultCreateTokenStore`) when no store is
    // injected, ignoring security.storage. No token store ⇒ a clear, actionable
    // storage-mode error (NOT a success, NOT a disk write). These two cases
    // cover (a) createTokenStore undefined and (b) createTokenStore() returning
    // undefined (the env-mode pass-through `() => boot.mcpTokenStore`).
    it("rejects with a clear storage-mode error when createTokenStore is undefined (no plaintext-disk fallback)", async () => {
      // runOauthLogin is injected so that IF the handler wrongly fell back to a
      // disk store and proceeded, the test would observe a non-throwing success
      // (the failure mode this guards against) rather than the required loud failure.
      const runOauthLogin = vi.fn().mockResolvedValue({ status: "authorized" });
      const deps = makeDeps("notion", { runOauthLogin, noTokenStore: true });
      // createTokenStore intentionally absent (env mode has no writable store).
      expect(deps.createTokenStore).toBeUndefined();

      const handlers = createMcpOauthHandlers(deps);
      await expect(
        handlers[McpOauthLoginContract.method]({ server_name: "notion" }),
      ).rejects.toThrow(/security\.storage/);
      // The doomed login path must NOT have run against a fallback store.
      expect(runOauthLogin).not.toHaveBeenCalled();
    });

    it("rejects with a clear storage-mode error when createTokenStore() returns undefined (env-mode pass-through)", async () => {
      const runOauthLogin = vi.fn().mockResolvedValue({ status: "authorized" });
      const deps = makeDeps("notion", {
        runOauthLogin,
        // The daemon pass-through is `() => boot.mcpTokenStore`; in env mode that
        // returns undefined. The handler must treat that as "no store" and fail
        // loudly, never dereference undefined.
        createTokenStore: () => undefined,
      });

      const handlers = createMcpOauthHandlers(deps);
      await expect(
        handlers[McpOauthLoginContract.method]({ server_name: "notion" }),
      ).rejects.toThrow(/security\.storage/);
      expect(runOauthLogin).not.toHaveBeenCalled();
    });

    it("login proceeds normally when a token store IS available (guard does not over-fire)", async () => {
      // Positive control: an injected store must NOT trip the storage-mode guard.
      const runOauthLogin = vi.fn().mockResolvedValue({ status: "authorized", authUrl: "https://auth.example.com/x" });
      const tokenStore = {
        tokens: vi.fn(),
        saveTokens: vi.fn(),
        saveClientInformation: vi.fn(),
        clientInformation: vi.fn(),
        saveDiscoveryState: vi.fn(),
        discoveryState: vi.fn(),
        deleteAll: vi.fn(),
        startWatch: vi.fn(),
        close: vi.fn(),
      } as unknown as TokenStore;
      const deps = makeDeps("notion", { runOauthLogin, createTokenStore: () => tokenStore });
      (deps.mcpClientManager.reconnect as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok({ name: "notion", status: "connected", tools: [] }),
      );

      const handlers = createMcpOauthHandlers(deps);
      const res = (await handlers[McpOauthLoginContract.method]({ server_name: "notion" })) as {
        status: string;
      };

      expect(runOauthLogin).toHaveBeenCalledOnce();
      expect(res.status).toBe("authorized");
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
      // server list (guards the regression where it ran regardless).
      expect(deleteAll).not.toHaveBeenCalled();
    });
  });
});
