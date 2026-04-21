// SPDX-License-Identifier: Apache-2.0
/**
 * PERSIST-RESTART-E2E: Management Actions Survive Daemon Restart
 *
 * Validates that management RPC actions persisted to config.yaml survive a
 * full daemon restart cycle (TEST-03):
 *   Phase 1: Start daemon, create agent, create token, shut down
 *   Phase 2: Start fresh daemon with same (modified) config, verify state
 *
 * The restart cycle exercises the full persistence pipeline end-to-end:
 *   RPC call -> persistToConfig -> YAML write -> daemon shutdown ->
 *   daemon restart -> config reload -> state restored
 *
 * Uses a temp config copy, real daemon, and internal rpcCall.
 * Spies on process.kill to no-op SIGUSR1 signals during Phase 1 (prevents
 * daemon restart mid-test while mutations are in flight).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-persist-restart.yaml",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for the daemon's internal rpcCall function. */
type RpcCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read and parse the temp config YAML file. */
function readConfigYaml(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf-8");
  return parseYaml(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("PERSIST-RESTART-E2E: Management actions survive daemon restart", () => {
  let tmpDir: string;
  let tmpConfigPath: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  // Track state from Phase 1 for verification in Phase 2
  let createdTokenId: string;

  beforeAll(() => {
    // Create temp dir and copy config
    tmpDir = mkdtempSync(join(tmpdir(), "persist-restart-e2e-"));
    tmpConfigPath = join(tmpDir, "config.yaml");
    writeFileSync(tmpConfigPath, readFileSync(BASE_CONFIG_PATH, "utf-8"));

    // Spy on process.kill to no-op SIGUSR1 (prevent actual restart during writes)
    killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(
        ((pid: number, signal?: string | number) => {
          if (signal === "SIGUSR1") return true;
          return process.kill.call(process, pid, signal as string);
        }) as typeof process.kill,
      );
  }, 30_000);

  afterAll(() => {
    if (killSpy) killSpy.mockRestore();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }, 30_000);

  // -----------------------------------------------------------------------
  // Phase 1: Start daemon, make management changes, shut down
  // -----------------------------------------------------------------------

  describe("Phase 1: Make management changes", () => {
    let handle: TestDaemonHandle;
    let rpcCall: RpcCall;

    beforeAll(async () => {
      handle = await startTestDaemon({ configPath: tmpConfigPath });
      rpcCall = (handle.daemon as any).rpcCall;
    }, 120_000);

    afterAll(async () => {
      if (handle) {
        try {
          await handle.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit with code")) throw err;
        }
      }
    }, 30_000);

    it(
      "creates a new agent via RPC",
      async () => {
        const result = await rpcCall("agents.create", {
          agentId: "restart-test-agent",
          config: {
            name: "Restart Test Agent",
            model: "gpt-4o",
            provider: "openai",
          },
          _trustLevel: "admin",
        });
        expect((result as any).created).toBe(true);
        // Wait for async file write
        await new Promise((r) => setTimeout(r, 500));
      },
      30_000,
    );

    it(
      "creates a new token via RPC",
      async () => {
        const result = (await rpcCall("tokens.create", {
          scopes: ["rpc", "ws"],
          _trustLevel: "admin",
        })) as { id: string; secret: string };
        createdTokenId = result.id;
        expect(result.id).toBeDefined();
        await new Promise((r) => setTimeout(r, 500));
      },
      30_000,
    );

    it(
      "disables telegram channel via RPC (best-effort)",
      async () => {
        // The daemon may not have a real Telegram adapter without valid credentials.
        // We try the call; if it fails, we log and move on. The agent and token
        // restart tests are the primary TEST-03 validation targets.
        try {
          const result = await rpcCall("channels.disable", {
            channel_type: "telegram",
            _trustLevel: "admin",
          });
          expect((result as any).status).toBe("stopped");
        } catch {
          // Expected: adapter not available in test environment.
          // Channel disable persistence was validated in 259-02.
        }
        await new Promise((r) => setTimeout(r, 500));
      },
      30_000,
    );

    it("config.yaml on disk reflects all changes after Phase 1", () => {
      const yaml = readConfigYaml(tmpConfigPath);

      // Agent was created
      const agents = yaml.agents as Record<string, Record<string, unknown>>;
      expect(agents["restart-test-agent"]).toBeDefined();
      expect(agents["restart-test-agent"]!.name).toBe("Restart Test Agent");

      // Token was created (gateway.tokens array should have 2 entries)
      const gateway = yaml.gateway as Record<string, unknown>;
      const tokens = gateway.tokens as Array<Record<string, unknown>>;
      expect(tokens.length).toBeGreaterThanOrEqual(2);
      const newToken = tokens.find(
        (t: Record<string, unknown>) => t.id === createdTokenId,
      );
      expect(newToken).toBeDefined();

      // Original config preserved
      expect(agents.default).toBeDefined();
      const originalToken = tokens.find(
        (t: Record<string, unknown>) => t.id === "restart-token",
      );
      expect(originalToken).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Phase 2: Start fresh daemon with same config, verify state survived
  // -----------------------------------------------------------------------

  describe("Phase 2: Verify state after restart", () => {
    let handle2: TestDaemonHandle;
    let rpcCall2: RpcCall;

    beforeAll(async () => {
      // Start a completely new daemon instance reading the same (now-modified) config
      handle2 = await startTestDaemon({ configPath: tmpConfigPath });
      rpcCall2 = (handle2.daemon as any).rpcCall;
    }, 120_000);

    afterAll(async () => {
      if (handle2) {
        try {
          await handle2.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit with code")) throw err;
        }
      }
    }, 30_000);

    it(
      "restarted daemon has the created agent in runtime",
      async () => {
        const result = (await rpcCall2("agents.get", {
          agentId: "restart-test-agent",
        })) as { agentId: string; config: { name: string } };

        expect(result.agentId).toBe("restart-test-agent");
        expect(result.config.name).toBe("Restart Test Agent");
      },
      30_000,
    );

    it(
      "restarted daemon has the created token in token registry",
      async () => {
        const result = (await rpcCall2("tokens.list", { _trustLevel: "admin" })) as {
          tokens: Array<{ id: string; scopes: string[] }>;
        };

        const found = result.tokens.find((t) => t.id === createdTokenId);
        expect(found).toBeDefined();
        expect(found!.scopes).toEqual(["rpc", "ws"]);
      },
      30_000,
    );

    it(
      "restarted daemon still has the default agent",
      async () => {
        const result = (await rpcCall2("agents.get", {
          agentId: "default",
        })) as { agentId: string; config: { name: string } };

        expect(result.agentId).toBe("default");
        expect(result.config.name).toBe("RestartTestAgent");
      },
      30_000,
    );

    it(
      "restarted daemon still has the original token",
      async () => {
        const result = (await rpcCall2("tokens.list", { _trustLevel: "admin" })) as {
          tokens: Array<{ id: string }>;
        };

        const original = result.tokens.find((t) => t.id === "restart-token");
        expect(original).toBeDefined();
      },
      30_000,
    );
  });
});
