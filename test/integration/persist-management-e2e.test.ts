// SPDX-License-Identifier: Apache-2.0
/**
 * PERSIST-MANAGEMENT-E2E: Management Action YAML Persistence E2E Tests
 *
 * Validates that management RPC actions (agents, tokens, channels) persist
 * expected YAML content to config.yaml on disk (TEST-02):
 *   - agents.create writes new agent entry to YAML
 *   - agents.update writes updated fields to YAML
 *   - agents.delete removes agent entry from YAML
 *   - tokens.create appends new token to gateway.tokens array in YAML
 *   - tokens.revoke removes token from gateway.tokens array in YAML
 *   - channels.disable writes enabled: false to YAML
 *   - channels.enable writes enabled: true to YAML
 *
 * Uses a temp config copy, real daemon, and internal rpcCall.
 * Spies on process.kill to no-op SIGUSR1 signals (prevents daemon restart mid-test).
 * Injects an EchoChannelAdapter for channel enable/disable tests (no real
 * Telegram credentials in test environment).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { EchoChannelAdapter } from "@comis/channels";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-persist-management.yaml",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for the daemon's internal rpcCall function. */
type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read and parse the temp config YAML file. */
function readConfigYaml(tmpConfigPath: string): Record<string, unknown> {
  const raw = readFileSync(tmpConfigPath, "utf-8");
  return parseYaml(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("PERSIST-MANAGEMENT-E2E: Management Action YAML Persistence", () => {
  let handle: TestDaemonHandle;
  let rpcCall: RpcCall;
  let tmpDir: string;
  let tmpConfigPath: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Create temp directory for mutable config
    tmpDir = join(tmpdir(), `comis-persist-mgmt-e2e-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Copy config to temp location for mutation safety
    tmpConfigPath = join(tmpDir, "config.test-persist-management.yaml");
    const configContent = readFileSync(BASE_CONFIG_PATH, "utf-8");
    writeFileSync(tmpConfigPath, configContent, "utf-8");

    // Spy on process.kill to no-op SIGUSR1 signals (prevents daemon restart mid-test)
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === "SIGUSR1") {
        // No-op: suppress restart signal during tests
        return true;
      }
      // Pass through other signals to the real implementation
      return process.kill.call(process, pid, signal as string);
    }) as typeof process.kill);

    // Start daemon with tmp config
    handle = await startTestDaemon({ configPath: tmpConfigPath });

    // Access internal rpcCall from daemon instance
    rpcCall = (handle.daemon as any).rpcCall as RpcCall;

    // Inject an EchoChannelAdapter for channel enable/disable tests.
    // The test config has channels.telegram.enabled: true but no real token,
    // so the daemon won't register a Telegram adapter. We inject an echo
    // adapter typed as "telegram" so that channel handlers find it.
    const echoAdapter = new EchoChannelAdapter({
      channelId: "telegram-test",
      channelType: "telegram",
    });
    handle.daemon.adapterRegistry.set("telegram", echoAdapter);
  }, 120_000);

  afterAll(async () => {
    // Restore process.kill spy
    if (killSpy) {
      killSpy.mockRestore();
    }

    // Cleanup daemon
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
  // Agent persistence (TEST-02)
  // -------------------------------------------------------------------------

  describe("Agent persistence (TEST-02)", () => {
    it(
      "agents.create persists new agent to config.yaml on disk",
      async () => {
        await rpcCall("agents.create", {
          agentId: "e2e-agent",
          config: {
            name: "E2E Agent",
            model: "gpt-4o",
            provider: "openai",
          },
          _trustLevel: "admin",
        });

        // Wait for async file write to complete
        await new Promise((r) => setTimeout(r, 200));

        const config = readConfigYaml(tmpConfigPath);
        const agents = config.agents as Record<string, Record<string, unknown>>;

        expect(agents["e2e-agent"]).toBeDefined();
        expect(agents["e2e-agent"]!.name).toBe("E2E Agent");
        expect(agents["e2e-agent"]!.model).toBe("gpt-4o");
        // Default agent must still exist (not lost by merge)
        expect(agents.default).toBeDefined();
      },
      30_000,
    );

    it(
      "agents.update persists updated fields to config.yaml on disk",
      async () => {
        await rpcCall("agents.update", {
          agentId: "e2e-agent",
          config: { name: "Updated E2E Agent" },
          _trustLevel: "admin",
        });

        await new Promise((r) => setTimeout(r, 200));

        const config = readConfigYaml(tmpConfigPath);
        const agents = config.agents as Record<string, Record<string, unknown>>;

        expect(agents["e2e-agent"]!.name).toBe("Updated E2E Agent");
        // Model preserved from create
        expect(agents["e2e-agent"]!.model).toBe("gpt-4o");
      },
      30_000,
    );

    it(
      "agents.delete removes agent from config.yaml on disk",
      async () => {
        await rpcCall("agents.delete", { agentId: "e2e-agent", _trustLevel: "admin" });

        await new Promise((r) => setTimeout(r, 200));

        const config = readConfigYaml(tmpConfigPath);
        const agents = config.agents as Record<string, Record<string, unknown>>;

        expect(agents["e2e-agent"]).toBeUndefined();
        // Default agent must still exist
        expect(agents.default).toBeDefined();
      },
      30_000,
    );
  });

  // -------------------------------------------------------------------------
  // Token persistence (TEST-02)
  // -------------------------------------------------------------------------

  describe("Token persistence (TEST-02)", () => {
    let createdTokenId: string;

    it(
      "tokens.create persists new token to config.yaml gateway.tokens array",
      async () => {
        const result = (await rpcCall("tokens.create", {
          scopes: ["rpc", "ws"],
          _trustLevel: "admin",
        })) as { id: string; secret: string };

        createdTokenId = result.id;

        await new Promise((r) => setTimeout(r, 200));

        const config = readConfigYaml(tmpConfigPath);
        const gateway = config.gateway as Record<string, unknown>;
        const tokens = gateway.tokens as Array<Record<string, unknown>>;

        expect(Array.isArray(tokens)).toBe(true);
        // New token exists
        const newToken = tokens.find((t) => t.id === createdTokenId);
        expect(newToken).toBeDefined();
        // Original test-token still exists
        const originalToken = tokens.find((t) => t.id === "test-token");
        expect(originalToken).toBeDefined();
      },
      30_000,
    );

    it(
      "tokens.revoke removes token from config.yaml gateway.tokens array",
      async () => {
        await rpcCall("tokens.revoke", { id: createdTokenId, _trustLevel: "admin" });

        await new Promise((r) => setTimeout(r, 200));

        const config = readConfigYaml(tmpConfigPath);
        const gateway = config.gateway as Record<string, unknown>;
        const tokens = gateway.tokens as Array<Record<string, unknown>>;

        expect(Array.isArray(tokens)).toBe(true);
        // Revoked token no longer in array
        const revokedToken = tokens.find((t) => t.id === createdTokenId);
        expect(revokedToken).toBeUndefined();
        // Original test-token still exists
        const originalToken = tokens.find((t) => t.id === "test-token");
        expect(originalToken).toBeDefined();
      },
      30_000,
    );
  });

  // -------------------------------------------------------------------------
  // Channel persistence (TEST-02)
  // -------------------------------------------------------------------------

  describe("Channel persistence (TEST-02)", () => {
    it(
      "channels.disable persists enabled: false to config.yaml",
      async () => {
        await rpcCall("channels.disable", { channel_type: "telegram", _trustLevel: "admin" });

        await new Promise((r) => setTimeout(r, 200));

        const config = readConfigYaml(tmpConfigPath);
        const channels = config.channels as Record<string, Record<string, unknown>>;

        expect(channels.telegram.enabled).toBe(false);
      },
      30_000,
    );

    it(
      "channels.enable persists enabled: true to config.yaml",
      async () => {
        await rpcCall("channels.enable", { channel_type: "telegram", _trustLevel: "admin" });

        await new Promise((r) => setTimeout(r, 200));

        const config = readConfigYaml(tmpConfigPath);
        const channels = config.channels as Record<string, Record<string, unknown>>;

        expect(channels.telegram.enabled).toBe(true);
      },
      30_000,
    );
  });
});
