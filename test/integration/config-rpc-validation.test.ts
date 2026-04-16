/**
 * CONFIG-RPC: Comprehensive Config RPC Validation Tests
 *
 * Validates config RPC methods through WebSocket JSON-RPC and internal rpcCall:
 *   config.read  — returns full config with all sections, or individual sections by name
 *   config.schema — returns JSON Schema for all 15 serializer sections, errors for others
 *   config.patch — enforces immutability for all 11 protected prefixes, accepts mutable paths
 *
 * Uses a dedicated config (port 8500, separate memory DB) to avoid conflicts.
 * Temp config copy for config.patch mutation tests (same pattern as infrastructure-mutation.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";
import { isImmutableConfigPath } from "@comis/core";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-config-rpc.yaml",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for the daemon's internal rpcCall function. */
type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CONFIG-RPC: Comprehensive Config RPC Validation", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let rpcCall: RpcCall;
  let rpcId = 0;
  let tmpDir: string;
  let tmpConfigPath: string;

  beforeAll(async () => {
    // Create temp directory for mutable config (config.patch writes to disk)
    tmpDir = join(tmpdir(), `comis-config-rpc-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Copy config to temp location for mutation safety
    tmpConfigPath = join(tmpDir, "config.test-config-rpc.yaml");
    const configContent = readFileSync(BASE_CONFIG_PATH, "utf-8");
    writeFileSync(tmpConfigPath, configContent, "utf-8");

    handle = await startTestDaemon({ configPath: tmpConfigPath });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

    // Access internal rpcCall for config.patch tests
    rpcCall = (handle.daemon as any).rpcCall as RpcCall;
  }, 120_000);

  afterAll(async () => {
    if (ws) {
      ws.close();
    }
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
    // Remove tmp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // config.read comprehensive section coverage
  // -------------------------------------------------------------------------

  describe("config.read comprehensive section coverage", () => {
    it("config.read returns full config with all known sections", async () => {
      const response = (await sendJsonRpc(ws, "config.read", {}, ++rpcId, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(result).toHaveProperty("config");
      expect(result).toHaveProperty("sections");

      // Verify sections array
      const sections = result.sections as string[];
      expect(Array.isArray(sections)).toBe(true);

      // Verify config has all expected object-section keys
      const config = result.config as Record<string, unknown>;
      const expectedObjectSections = [
        "agents",
        "channels",
        "memory",
        "security",
        "routing",
        "daemon",
        "scheduler",
        "gateway",
        "integrations",
        "monitoring",
        "plugins",
        "queue",
        "streaming",
        "autoReplyEngine",
        "sendPolicy",
        "embedding",
        "envelope",
        "browser",
        "models",
        "providers",
        "messages",
        "approvals",
        "webhooks",
      ];

      const configKeys = Object.keys(config);
      for (const section of expectedObjectSections) {
        expect(configKeys).toContain(section);
      }

      // Verify scalar keys from our test config
      expect(config.tenantId).toBe("config-rpc-test");
      expect(config.logLevel).toBe("debug");
    });

    // Test config.read for each of the 15 serializer sections individually
    const serializerSections = [
      "agents",
      "channels",
      "memory",
      "security",
      "routing",
      "daemon",
      "scheduler",
      "gateway",
      "integrations",
      "monitoring",
      "browser",
      "models",
      "providers",
      "messages",
      "approvals",
    ];

    it.each(serializerSections)(
      "config.read returns section '%s' individually",
      async (sectionName) => {
        const response = (await sendJsonRpc(
          ws,
          "config.read",
          { section: sectionName },
          ++rpcId,
          { timeoutMs: RPC_FAST_MS },
        )) as Record<string, unknown>;

        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        const result = response.result;
        expect(result).toBeDefined();

        // For gateway specifically, verify our test port
        if (sectionName === "gateway") {
          expect((result as Record<string, unknown>).port).toBe(8500);
        }
      },
    );

    // Test config.read for non-serializer sections (present in AppConfigSchema but not in SECTION_SCHEMAS)
    const nonSerializerSections = [
      "plugins",
      "queue",
      "streaming",
      "autoReplyEngine",
      "sendPolicy",
      "embedding",
      "envelope",
      "webhooks",
    ];

    it.each(nonSerializerSections)(
      "config.read returns non-serializer section '%s'",
      async (sectionName) => {
        const response = (await sendJsonRpc(
          ws,
          "config.read",
          { section: sectionName },
          ++rpcId,
          { timeoutMs: RPC_FAST_MS },
        )) as Record<string, unknown>;

        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        const result = response.result;
        expect(result).toBeDefined();
      },
    );

    it("config.read rejects truly unknown section", async () => {
      const response = (await sendJsonRpc(
        ws,
        "config.read",
        { section: "totallyFakeSection" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(typeof error.code).toBe("number");
      expect(typeof error.message).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // config.schema comprehensive section coverage
  // -------------------------------------------------------------------------

  describe("config.schema comprehensive section coverage", () => {
    it("config.schema returns full JSON Schema", async () => {
      const response = (await sendJsonRpc(ws, "config.schema", {}, ++rpcId, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(result).toHaveProperty("schema");
      expect(result).toHaveProperty("sections");

      // Full schema is a JSON Schema with type:"object" and properties
      const schema = result.schema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema).toHaveProperty("properties");

      // Properties should include known section keys
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("gateway");
      expect(properties).toHaveProperty("agents");
      expect(properties).toHaveProperty("scheduler");

      // Sections list should match serializer sections
      const sections = result.sections as string[];
      expect(Array.isArray(sections)).toBe(true);
      expect(sections).toContain("agents");
      expect(sections).toContain("gateway");
    });

    // Test config.schema for each of the 15 serializer sections
    const serializerSections = [
      "agents",
      "channels",
      "memory",
      "security",
      "routing",
      "daemon",
      "scheduler",
      "gateway",
      "integrations",
      "monitoring",
      "browser",
      "models",
      "providers",
      "messages",
      "approvals",
    ];

    it.each(serializerSections)(
      "config.schema returns schema for serializer section '%s'",
      async (sectionName) => {
        const response = (await sendJsonRpc(
          ws,
          "config.schema",
          { section: sectionName },
          ++rpcId,
          { timeoutMs: RPC_FAST_MS },
        )) as Record<string, unknown>;

        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        const result = response.result as Record<string, unknown>;
        expect(result.section).toBe(sectionName);
        expect(result).toHaveProperty("schema");

        const schema = result.schema as Record<string, unknown>;
        expect(schema.type).toBe("object");
      },
    );

    // Test config.schema rejects non-serializer sections
    const nonSerializerSections = [
      "plugins",
      "queue",
      "streaming",
    ];

    it.each(nonSerializerSections)(
      "config.schema rejects non-serializer section '%s'",
      async (sectionName) => {
        const response = (await sendJsonRpc(
          ws,
          "config.schema",
          { section: sectionName },
          ++rpcId,
          { timeoutMs: RPC_FAST_MS },
        )) as Record<string, unknown>;

        expect(response).toHaveProperty("error");
        expect(response).not.toHaveProperty("result");
      },
    );
  });

  // -------------------------------------------------------------------------
  // config.patch immutable key enforcement
  // -------------------------------------------------------------------------

  describe("config.patch immutable key enforcement", () => {
    // RPC-level immutable rejection tests.
    // config.patch has a token-bucket rate limiter (5/minute) that fires
    // BEFORE the immutable check. To avoid exhausting the budget we test
    // one whole-section and one sub-path via rpcCall, then verify all
    // paths via the isImmutableConfigPath guard directly (no RPC cost).

    it(
      "config.patch rejects immutable whole-section (security) via RPC",
      async () => {
        await expect(
          rpcCall("config.patch", {
            section: "security",
            value: {},
            _trustLevel: "admin",
          }),
        ).rejects.toThrow(/immutable/i);
      },
      30_000,
    );

    it(
      "config.patch rejects immutable sub-path (gateway.tls.certPath) via RPC",
      async () => {
        await expect(
          rpcCall("config.patch", {
            section: "gateway",
            key: "tls.certPath",
            value: "/fake",
            _trustLevel: "admin",
          }),
        ).rejects.toThrow(/immutable/i);
      },
      30_000,
    );

    it(
      "config.patch accepts mutable path with admin trust",
      async () => {
        const result = (await rpcCall("config.patch", {
          section: "scheduler",
          key: "heartbeat.intervalMs",
          value: 600000,
          _trustLevel: "admin",
        })) as Record<string, unknown>;

        expect(result.patched).toBe(true);
        expect(result.section).toBe("scheduler");
        expect(result.key).toBe("heartbeat.intervalMs");
      },
      30_000,
    );

    it(
      "config.patch rejects non-admin trust level",
      async () => {
        await expect(
          rpcCall("config.patch", {
            section: "scheduler",
            key: "heartbeat.intervalMs",
            value: 600000,
            _trustLevel: "external",
          }),
        ).rejects.toThrow(/admin/i);
      },
      30_000,
    );

    // Exhaustive immutable path coverage via isImmutableConfigPath guard.
    // No RPC call needed -- exercises the same guard the handler uses.
    it("isImmutableConfigPath covers all whole-section immutable prefixes", () => {
      const wholeSections = ["security", "channels", "integrations", "providers", "approvals", "agents"];
      for (const section of wholeSections) {
        expect(
          isImmutableConfigPath(section),
          `Expected "${section}" to be immutable`,
        ).toBe(true);
      }
    });

    it("isImmutableConfigPath covers all sub-path immutable prefixes", () => {
      const subPaths: Array<[string, string]> = [
        ["security", "agentToAgent.enabled"],
        ["gateway", "tls.certPath"],
        ["gateway", "tokens"],
        ["gateway", "host"],
        ["gateway", "port"],
        ["browser", "noSandbox"],
        ["agents", "default.model"],
        ["daemon", "logging.filePath"],
      ];
      for (const [section, key] of subPaths) {
        expect(
          isImmutableConfigPath(section, key),
          `Expected "${section}.${key}" to be immutable`,
        ).toBe(true);
      }
    });

    it("isImmutableConfigPath allows known mutable paths", () => {
      const mutablePaths: Array<[string, string | undefined]> = [
        ["scheduler", "heartbeat.intervalMs"],
        ["memory", "guardrails.maxEntries"],
        ["monitoring", "healthCheckInterval"],
      ];
      for (const [section, key] of mutablePaths) {
        expect(
          isImmutableConfigPath(section, key),
          `Expected "${section}.${key ?? ""}" to be mutable`,
        ).toBe(false);
      }
    });
  });
});
