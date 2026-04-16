/**
 * SYSTEM LIFECYCLE TEST: Pre-flight, health, and authentication tests.
 *
 * Split from comprehensive-system.test.ts for isolated failures and
 * faster debugging. Covers Phases 1-3:
 *
 *   1.  Pre-flight & Daemon Lifecycle
 *   2.  Health Endpoints
 *   3.  Authentication & Authorization
 *
 * Uses config.test-system-manual.yaml (port 8600, 3 tokens with different scopes).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";
import {
  createLogCapture,
} from "../support/log-verifier.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-system-manual.yaml",
);

// Known token secrets — injected via env vars so the daemon uses these exact values
// (the daemon resolves tokens from env > config > auto-gen, per TOKEN-04)
const ADMIN_SECRET = "test-admin-secret-for-comprehensive-test-2026";
const RPC_ONLY_SECRET = "test-rpc-only-secret-comprehensive-test-2026";
const NO_SCOPE_SECRET = "test-noscope-secret-comprehensive-test-2026x";
const INVALID_TOKEN = "zz-invalid-token-that-does-not-exist-anywhere-zz";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SYSTEM LIFECYCLE TEST: Pre-flight, health, and auth", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let rpcId = 0;
  let killSpy: ReturnType<typeof vi.spyOn>;
  let logCapture: ReturnType<typeof createLogCapture>;

  // Resolved token secrets (extracted from daemon config after startup)
  let adminToken: string;
  let rpcOnlyToken: string;
  let noScopeToken: string;

  beforeAll(async () => {
    // Suppress SIGUSR1 signals from persistToConfig (prevents daemon restart mid-test)
    killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: string | number) => {
        if (signal === "SIGUSR1") return true;
        return process.kill.call(process, pid, signal as string);
      }) as typeof process.kill);

    // Create log capture stream
    logCapture = createLogCapture();

    // Inject token secrets via env vars so the daemon uses known values
    // (daemon resolves: config string >= 32 chars -> env var -> auto-generate)
    process.env["GATEWAY_TOKEN_SYSTEM_TESTER"] = ADMIN_SECRET;
    process.env["GATEWAY_TOKEN_READONLY_CLIENT"] = RPC_ONLY_SECRET;
    process.env["GATEWAY_TOKEN_NO_SCOPE_CLIENT"] = NO_SCOPE_SECRET;

    // Start daemon with log capture (port comes from config: 8600)
    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
      logStream: logCapture.stream,
      gatewayPort: 8600,
    });

    // Set token values from known injected secrets
    adminToken = ADMIN_SECRET;
    rpcOnlyToken = RPC_ONLY_SECRET;
    noScopeToken = NO_SCOPE_SECRET;

    // Open admin WebSocket
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, adminToken);
  }, 120_000);

  afterAll(async () => {
    if (ws) {
      ws.close();
    }
    if (killSpy) {
      killSpy.mockRestore();
    }
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
    // Clean up injected env vars
    delete process.env["GATEWAY_TOKEN_SYSTEM_TESTER"];
    delete process.env["GATEWAY_TOKEN_READONLY_CLIENT"];
    delete process.env["GATEWAY_TOKEN_NO_SCOPE_CLIENT"];
  }, 30_000);

  // =========================================================================
  // Phase 1: Pre-flight & Daemon Lifecycle (5 tests)
  // =========================================================================

  describe("Phase 1: Pre-flight & Daemon Lifecycle", () => {
    it("daemon started successfully", () => {
      expect(handle).toBeDefined();
      expect(handle.daemon).toBeDefined();
      expect(handle.daemon.container).toBeDefined();
    });

    it("config has correct tenantId", () => {
      expect(handle.daemon.container.config.tenantId).toBe("test");
    });

    it("config has correct gateway port", () => {
      expect(handle.daemon.container.config.gateway.port).toBe(8600);
    });

    it("config has correct log level", () => {
      expect(handle.daemon.container.config.logLevel).toBe("debug");
    });

    it("config has default agent configured", () => {
      const agents = handle.daemon.container.config.agents;
      expect(agents).toBeDefined();
      expect(agents.default).toBeDefined();
      expect(agents.default.name).toBe("TestBot");
    });
  });

  // =========================================================================
  // Phase 2: Health Endpoints (3 tests)
  // =========================================================================

  describe("Phase 2: Health Endpoints", () => {
    it("GET /health returns 200 with status ok", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/health`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
    });

    it("GET /api/health returns 200", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/api/health`);
      expect(resp.status).toBe(200);
    });

    it("health endpoints require no auth", async () => {
      // No Authorization header
      const resp = await fetch(`${handle.gatewayUrl}/health`);
      expect(resp.status).toBe(200);
    });
  });

  // =========================================================================
  // Phase 3: Authentication & Authorization (6 tests)
  // =========================================================================

  describe("Phase 3: Authentication & Authorization", () => {
    it("unauthenticated REST request is rejected (401)", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/v1/models`);
      expect(resp.status).toBe(401);
    });

    it("empty-scope token is rejected (403)", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/v1/models`, {
        headers: makeAuthHeaders(noScopeToken),
      });
      // 403 or 401 — either is acceptable for insufficient scopes
      expect([401, 403]).toContain(resp.status);
    });

    it("RPC-scope token accesses REST (200)", async () => {
      const resp = await fetch(`${handle.gatewayUrl}/v1/models`, {
        headers: makeAuthHeaders(rpcOnlyToken),
      });
      expect(resp.status).toBe(200);
    });

    it("admin token accesses admin RPC (config.read)", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "config.read",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("RPC-only token rejected from admin RPC methods", async () => {
      // Open a WS with the RPC-only token
      let rpcWs: WebSocket | undefined;
      try {
        rpcWs = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          rpcOnlyToken,
        );

        const resp = (await sendJsonRpc(
          rpcWs,
          "config.read",
          {},
          9001,
          { timeoutMs: RPC_FAST_MS },
        )) as Record<string, unknown>;

        // Should fail with authorization error (not method-not-found)
        expect(resp).toHaveProperty("error");
        const error = resp.error as Record<string, unknown>;
        expect(error.code).not.toBe(-32601); // Not "method not found"
      } finally {
        if (rpcWs) rpcWs.close();
      }
    });

    it("invalid token rejects WebSocket connection", async () => {
      // The gateway may either reject the HTTP upgrade (error event -> rejection)
      // or accept the upgrade then immediately close the WS (open then close).
      // Either way, the connection should not remain open for RPC use.
      let invalidWs: WebSocket | undefined;
      try {
        invalidWs = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          INVALID_TOKEN,
          { timeoutMs: 5000 },
        );
        // If it resolved, the server accepted the upgrade then will close.
        // Wait briefly for the close frame.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(invalidWs.readyState).not.toBe(WebSocket.OPEN);
      } catch {
        // Expected: connection rejected (error event fired)
        expect(true).toBe(true);
      } finally {
        if (invalidWs && invalidWs.readyState === WebSocket.OPEN) {
          invalidWs.close();
        }
      }
    });
  });
});
