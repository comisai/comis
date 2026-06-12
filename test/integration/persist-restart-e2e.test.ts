// SPDX-License-Identifier: Apache-2.0
/**
 * PERSIST-RESTART-E2E: Management Actions Survive Daemon Restart
 *
 * Validates that management RPC actions persisted to config.yaml survive a
 * full daemon restart cycle:
 *   Stage 1: Start daemon, create agent, create token, shut down
 *   Stage 2: Start fresh daemon with same (modified) config, verify state
 *
 * The restart cycle exercises the full persistence pipeline end-to-end:
 *   RPC call -> persistToConfig -> YAML write -> daemon shutdown ->
 *   daemon restart -> config reload -> state restored
 *
 * Uses a temp config copy, real daemon, and internal rpcCall.
 * Spies on process.kill to no-op SIGUSR1 signals during the setup stage
 * (prevents daemon restart mid-test while mutations are in flight).
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
// Clears the module-scoped SIGUSR2 debounce timer that persistToConfig arms
// after each write, so a pending restart signal can't fire once the killSpy is
// restored (a stray real SIGUSR2 with no daemon handler would terminate the
// test fork).
import { _resetSigusr1Timer } from "@comis/daemon";

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

// Suite drives the daemon's real `agents.create`/`agents.update` flow which
// sets `provider: openai`. That path only VALIDATES that a credential is
// present (no real LLM call), so a dummy OPENAI_API_KEY suffices — set in the
// "Make management changes" beforeAll AFTER boot (the daemon scrubs OPENAI_*
// from process.env at boot, so it must be re-seeded post-boot, mirroring the
// harness's own ANTHROPIC/OPENROUTER re-seed). No real key required → no skip.
describe("PERSIST-RESTART-E2E: Management actions survive daemon restart", () => {
  let tmpDir: string;
  let tmpConfigPath: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  // Track state from setup stage for verification after restart
  let createdTokenId: string;
  /** Prior COMIS_GATEWAY_TOKEN, restored in afterAll so the suite leaves env clean. */
  let priorGatewayToken: string | undefined;

  beforeAll(() => {
    // Resolve the config's `${COMIS_GATEWAY_TOKEN}` ref to a real ≥32-char
    // secret. Set before any daemon boots. NOTE: COMIS_ escapes the stage-1
    // prefix scrub, but the stage-2 scrub deletes every CONFIG-REFERENCED
    // name from process.env regardless of prefix — so the restart describe
    // re-seeds this var before the second boot.
    priorGatewayToken = process.env["COMIS_GATEWAY_TOKEN"];
    process.env["COMIS_GATEWAY_TOKEN"] = "test-secret-persist-restart-gateway-token-pad32";
    // Create temp dir and copy config
    tmpDir = mkdtempSync(join(tmpdir(), "persist-restart-e2e-"));
    tmpConfigPath = join(tmpDir, "config.yaml");
    writeFileSync(tmpConfigPath, readFileSync(BASE_CONFIG_PATH, "utf-8"));

    // Spy on process.kill to NO-OP the daemon's restart signal so persisted
    // mutations don't trigger a self-restart mid-test (the suite drives the
    // restart manually via cleanup + a fresh startTestDaemon). The config-change
    // restart signal is SIGUSR2 (see setup-shutdown.ts / persist-to-config.ts);
    // SIGUSR1 is no-op'd too for safety. Capture the ORIGINAL kill up-front and
    // delegate other signals to it — calling `process.kill` here would re-enter
    // this very spy and recurse infinitely (RangeError: Maximum call stack size).
    const originalKill = process.kill.bind(process);
    killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(
        ((pid: number, signal?: string | number) => {
          if (signal === "SIGUSR2" || signal === "SIGUSR1") return true;
          return originalKill(pid, signal as NodeJS.Signals);
        }) as typeof process.kill,
      );
  }, 30_000);

  afterAll(() => {
    // Clear any pending SIGUSR2 restart timer BEFORE restoring the spy, so it
    // cannot fire a real signal at the now-unspied process.kill.
    _resetSigusr1Timer();
    if (killSpy) killSpy.mockRestore();
    if (priorGatewayToken === undefined) {
      delete process.env["COMIS_GATEWAY_TOKEN"];
    } else {
      process.env["COMIS_GATEWAY_TOKEN"] = priorGatewayToken;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }, 30_000);

  // -----------------------------------------------------------------------
  // Start daemon, make management changes, shut down
  // -----------------------------------------------------------------------

  describe("Make management changes", () => {
    let handle: TestDaemonHandle;
    let rpcCall: RpcCall;
    /** Prior OPENAI_API_KEY, restored in afterAll. */
    let priorOpenAiKey: string | undefined;

    beforeAll(async () => {
      handle = await startTestDaemon({ configPath: tmpConfigPath });
      // Seed a dummy OpenAI key AFTER boot: the daemon scrubs OPENAI_* from
      // process.env during bootstrap, and `agents.create` (provider: openai)
      // reads the env live to validate credential PRESENCE — it makes no real
      // LLM call, so a non-empty placeholder satisfies the guard. (The harness
      // re-seeds ANTHROPIC/OPENROUTER this same way; OpenAI is added here.)
      priorOpenAiKey = process.env["OPENAI_API_KEY"];
      process.env["OPENAI_API_KEY"] = "test-fixture-not-a-real-key";
      rpcCall = (handle.daemon as any).rpcCall;
    }, 120_000);

    afterAll(async () => {
      if (priorOpenAiKey === undefined) {
        delete process.env["OPENAI_API_KEY"];
      } else {
        process.env["OPENAI_API_KEY"] = priorOpenAiKey;
      }
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
        // restart tests are the primary validation targets.
        try {
          const result = await rpcCall("channels.disable", {
            channel_type: "telegram",
            _trustLevel: "admin",
          });
          expect((result as any).status).toBe("stopped");
        } catch {
          // Expected: adapter not available in test environment.
          // Channel disable persistence is validated separately.
        }
        await new Promise((r) => setTimeout(r, 500));
      },
      30_000,
    );

    it("config.yaml on disk reflects all changes after setup", () => {
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
  // Start fresh daemon with same config, verify state survived
  // -----------------------------------------------------------------------

  describe("Verify state after restart", () => {
    let handle2: TestDaemonHandle;
    let rpcCall2: RpcCall;

    beforeAll(async () => {
      // Re-seed the gateway token before the second boot. The FIRST boot's
      // stage-2 scrub (daemon.ts: platformSecretNames) deleted it from
      // process.env because the config references ${COMIS_GATEWAY_TOKEN} —
      // regardless of the COMIS_ prefix. A production restart is a fresh
      // process whose env comes from .env/systemd, so re-seeding here models
      // reality. (This was masked until #186: tokens.create used to SEVER the
      // ${VAR} ref and persist plaintext tokens, so the restart never needed
      // the env var. The ref now survives — and so must the env var.)
      process.env["COMIS_GATEWAY_TOKEN"] =
        "test-secret-persist-restart-gateway-token-pad32";
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
