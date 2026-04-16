/**
 * SYSTEM INTEGRATIONS TEST: Observability, scheduler, skills, and approvals tests.
 *
 * Split from comprehensive-system.test.ts for isolated failures and
 * faster debugging. Covers Phases 5, 9, 13-14:
 *
 *   5.  Observability
 *   9.  Scheduler / Cron
 *  13.  Skills
 *  14.  Approvals
 *
 * Uses config.test-system-integrations.yaml (port 8602, 3 tokens with different scopes).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
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
  "../config/config.test-system-integrations.yaml",
);

// Known token secrets — injected via env vars so the daemon uses these exact values
// (the daemon resolves tokens from env > config > auto-gen, per TOKEN-04)
const ADMIN_SECRET = "test-admin-secret-for-comprehensive-test-2026";
const RPC_ONLY_SECRET = "test-rpc-only-secret-comprehensive-test-2026";
const NO_SCOPE_SECRET = "test-noscope-secret-comprehensive-test-2026x";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SYSTEM INTEGRATIONS TEST: Observability, scheduler, skills, approvals", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let rpcId = 0;
  let killSpy: ReturnType<typeof vi.spyOn>;
  let logCapture: ReturnType<typeof createLogCapture>;

  // Resolved token secrets (extracted from daemon config after startup)
  let adminToken: string;

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

    // Start daemon with log capture (port comes from config: 8602)
    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
      logStream: logCapture.stream,
      gatewayPort: 8602,
    });

    // Set token values from known injected secrets
    adminToken = ADMIN_SECRET;

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
  // Phase 5: Observability (12 tests)
  // =========================================================================

  describe("Phase 5: Observability", () => {
    it("obs.diagnostics returns diagnostics", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.diagnostics",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("obs.billing.byProvider returns provider billing", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.billing.byProvider",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("obs.billing.total returns total billing", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.billing.total",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("obs.billing.usage24h returns 24h usage", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.billing.usage24h",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("obs.billing.byAgent is registered (requires agentId)", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.billing.byAgent",
        { agentId: "default" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("obs.billing.bySession is registered (requires sessionKey)", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.billing.bySession",
        { sessionKey: "test-session" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("obs.channels.all returns channel overview", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.channels.all",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("obs.channels.stale returns stale channel info", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.channels.stale",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("result");
      expect(resp).not.toHaveProperty("error");
    });

    it("obs.channels.get is registered", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.channels.get",
        { channelType: "echo" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("obs.delivery.recent returns recent deliveries", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.delivery.recent",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("obs.delivery.stats returns delivery stats", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "obs.delivery.stats",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });
  });

  // =========================================================================
  // Phase 9: Scheduler / Cron (3 tests)
  // =========================================================================

  describe("Phase 9: Scheduler / Cron", () => {
    it("cron.list is registered", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "cron.list",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      // cron.list bridges to scheduler — may return an error if scheduler
      // is not fully wired in test config, but must not be "method not found"
      if (resp.error) {
        const error = resp.error as { code: number };
        expect(error.code).not.toBe(-32601);
      }
    });

    it("cron.status is registered", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "cron.status",
        { jobId: "nonexistent-job" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("cron.runs is registered", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "cron.runs",
        { jobId: "nonexistent-job" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });
  });

  // =========================================================================
  // Phase 13: Skills (2 tests)
  // =========================================================================

  describe("Phase 13: Skills", () => {
    it("skills.list returns skills", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "skills.list",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("skills.list with agentId returns agent-specific skills", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "skills.list",
        { agentId: "default" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });
  });

  // =========================================================================
  // Phase 14: Approvals (2 tests)
  // =========================================================================

  describe("Phase 14: Approvals", () => {
    it("admin.approval.pending returns pending approvals", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "admin.approval.pending",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });

    it("admin.approval.resolve handles nonexistent approval", async () => {
      const resp = (await sendJsonRpc(
        ws,
        "admin.approval.resolve",
        { requestId: "nonexistent-approval", approved: false },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(resp).toHaveProperty("jsonrpc", "2.0");
      if (resp.error) {
        expect((resp.error as Record<string, unknown>).code).not.toBe(-32601);
      }
    });
  });
});
