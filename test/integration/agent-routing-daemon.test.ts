// SPDX-License-Identifier: Apache-2.0
/**
 * Agent Routing Daemon Integration Tests
 *
 * Validates daemon-level routing behavior:
 *   ROUTE-11: Per-agent model configuration via config.get RPC
 *   ROUTE-12: Multi-agent workspace isolation via resolveWorkspaceDir
 *   ROUTE-13: Daemon-level routing integration (explicit agentId dispatch, fallback)
 *
 * Uses port 8512 and unique database path to avoid conflicts with other test suites.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS, RPC_LLM_MS } from "../support/timeouts.js";
import { resolveWorkspaceDir } from "@comis/agent";
import {
  getProviderEnv,
  hasAnyProvider,
  PROVIDER_GROUPS,
} from "../support/provider-env.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, "../config/config.test-agent-routing.yaml");

// ---------------------------------------------------------------------------
// Provider detection for LLM-gated tests
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// ROUTE-11, ROUTE-12, ROUTE-13: Main daemon tests (shared instance)
// ---------------------------------------------------------------------------

describe("Agent Routing: Config, Workspace, Dispatch", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath });
  }, 60_000);

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

  // -------------------------------------------------------------------------
  // ROUTE-11: Per-agent model configuration
  // -------------------------------------------------------------------------

  describe("Per-Agent Model Configuration (ROUTE-11)", () => {
    it(
      "ROUTE-11a: config.get returns all 3 agents with distinct names",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

          const response = (await sendJsonRpc(
            ws,
            "config.get",
            { section: "agents" },
            10,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          // config.get({section: "agents"}) returns { agents: { ... } }
          expect(result).toHaveProperty("agents");
          const agents = result.agents as Record<string, Record<string, unknown>>;

          // Verify all 3 agents are present
          expect(agents).toHaveProperty("router-alpha");
          expect(agents).toHaveProperty("router-beta");
          expect(agents).toHaveProperty("router-gamma");

          // Verify distinct name fields
          expect(agents["router-alpha"]!.name).toBe("RouterAlpha");
          expect(agents["router-beta"]!.name).toBe("RouterBeta");
          expect(agents["router-gamma"]!.name).toBe("RouterGamma");
        } finally {
          ws?.close();
        }
      },
      RPC_FAST_MS,
    );

    it(
      "ROUTE-11b: each agent has anthropic provider and model configured",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

          const response = (await sendJsonRpc(
            ws,
            "config.get",
            { section: "agents" },
            11,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          const agents = result.agents as Record<string, Record<string, unknown>>;

          for (const agentId of ["router-alpha", "router-beta", "router-gamma"]) {
            const agent = agents[agentId]!;
            expect(agent.provider).toBe("anthropic");
            expect(agent.model).toBe("claude-opus-4-6");
            expect(agent.maxSteps).toBe(5);
          }
        } finally {
          ws?.close();
        }
      },
      RPC_FAST_MS,
    );

    it(
      "ROUTE-11c: routing config has correct defaultAgentId and bindings",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

          const response = (await sendJsonRpc(
            ws,
            "config.get",
            { section: "routing" },
            12,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          const routing = result.routing as Record<string, unknown>;

          expect(routing.defaultAgentId).toBe("router-alpha");
          const bindings = routing.bindings as Array<Record<string, unknown>>;
          expect(bindings.length).toBe(2);

          // Verify specific bindings
          const discordBinding = bindings.find((b) => b.channelType === "discord");
          expect(discordBinding).toBeDefined();
          expect(discordBinding!.agentId).toBe("router-beta");

          const vipBinding = bindings.find((b) => b.peerId === "vip-user");
          expect(vipBinding).toBeDefined();
          expect(vipBinding!.agentId).toBe("router-gamma");
        } finally {
          ws?.close();
        }
      },
      RPC_FAST_MS,
    );
  });

  // -------------------------------------------------------------------------
  // ROUTE-12: Multi-agent workspace isolation
  // -------------------------------------------------------------------------

  describe("Multi-Agent Workspace Isolation (ROUTE-12)", () => {
    it("ROUTE-12a: each named agent resolves to workspace-{agentId}", () => {
      // resolveWorkspaceDir is a pure function -- no daemon needed
      const baseDir = join(homedir(), ".comis");

      const alphaPath = resolveWorkspaceDir(
        { workspacePath: undefined } as any,
        "router-alpha",
      );
      const betaPath = resolveWorkspaceDir(
        { workspacePath: undefined } as any,
        "router-beta",
      );
      const gammaPath = resolveWorkspaceDir(
        { workspacePath: undefined } as any,
        "router-gamma",
      );

      expect(alphaPath).toBe(join(baseDir, "workspace-router-alpha"));
      expect(betaPath).toBe(join(baseDir, "workspace-router-beta"));
      expect(gammaPath).toBe(join(baseDir, "workspace-router-gamma"));
    });

    it("ROUTE-12b: all 3 workspace paths are distinct", () => {
      const alphaPath = resolveWorkspaceDir(
        { workspacePath: undefined } as any,
        "router-alpha",
      );
      const betaPath = resolveWorkspaceDir(
        { workspacePath: undefined } as any,
        "router-beta",
      );
      const gammaPath = resolveWorkspaceDir(
        { workspacePath: undefined } as any,
        "router-gamma",
      );

      const paths = new Set([alphaPath, betaPath, gammaPath]);
      expect(paths.size).toBe(3);
    });

    it("ROUTE-12c: default agentId resolves to workspace (no suffix)", () => {
      const baseDir = join(homedir(), ".comis");

      const defaultPath = resolveWorkspaceDir(
        { workspacePath: undefined } as any,
        "default",
      );
      expect(defaultPath).toBe(join(baseDir, "workspace"));

      // Also test undefined agentId -> default workspace
      const undefinedPath = resolveWorkspaceDir(
        { workspacePath: undefined } as any,
        undefined,
      );
      expect(undefinedPath).toBe(join(baseDir, "workspace"));
    });

    it("ROUTE-12d: named agent workspace differs from default workspace", () => {
      const defaultPath = resolveWorkspaceDir(
        { workspacePath: undefined } as any,
        "default",
      );
      const namedPath = resolveWorkspaceDir(
        { workspacePath: undefined } as any,
        "router-alpha",
      );
      expect(defaultPath).not.toBe(namedPath);
    });
  });

  // -------------------------------------------------------------------------
  // ROUTE-13: Daemon-level routing integration (LLM-gated)
  // -------------------------------------------------------------------------

  describe("Daemon-Level Routing Dispatch (ROUTE-13) - Structural", () => {
    it(
      "ROUTE-13a: config.get confirms routing defaultAgentId is router-alpha",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

          const response = (await sendJsonRpc(
            ws,
            "config.get",
            { section: "routing" },
            20,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          const routing = result.routing as Record<string, unknown>;
          expect(routing.defaultAgentId).toBe("router-alpha");
        } finally {
          ws?.close();
        }
      },
      RPC_FAST_MS,
    );

    it(
      "ROUTE-13b: config.get confirms all 3 agent executors are configured",
      async () => {
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

          const response = (await sendJsonRpc(
            ws,
            "config.get",
            { section: "agents" },
            21,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("result");
          const result = response.result as Record<string, unknown>;
          const agents = result.agents as Record<string, unknown>;

          // All 3 agents should be present in config
          expect(Object.keys(agents)).toEqual(
            expect.arrayContaining(["router-alpha", "router-beta", "router-gamma"]),
          );
        } finally {
          ws?.close();
        }
      },
      RPC_FAST_MS,
    );
  });

  describe.skipIf(!hasLlmKey)(
    "Daemon-Level Routing Dispatch (ROUTE-13) - LLM",
    () => {
      it(
        "ROUTE-13c: agent.execute with agentId router-alpha succeeds",
        async () => {
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

            const response = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                agentId: "router-alpha",
                message: "Say ALPHA",
              },
              30,
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("result");
            expect(response).not.toHaveProperty("error");

            const result = response.result as Record<string, unknown>;
            expect(typeof result.response).toBe("string");
            expect((result.response as string).length).toBeGreaterThan(0);
          } finally {
            ws?.close();
          }
        },
        RPC_LLM_MS,
      );

      it(
        "ROUTE-13d: agent.execute with agentId router-beta succeeds",
        async () => {
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

            const response = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                agentId: "router-beta",
                message: "Say BETA",
              },
              31,
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("result");
            expect(response).not.toHaveProperty("error");

            const result = response.result as Record<string, unknown>;
            expect(typeof result.response).toBe("string");
            expect((result.response as string).length).toBeGreaterThan(0);
          } finally {
            ws?.close();
          }
        },
        RPC_LLM_MS,
      );

      it(
        "ROUTE-13e: agent.execute with unknown agentId falls back to default executor",
        async () => {
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

            const response = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                agentId: "nonexistent-agent",
                message: "Say FALLBACK",
              },
              32,
            )) as Record<string, unknown>;

            // Daemon's getExecutor() falls back to defaultAgentId (router-alpha)
            // Should return a result, not an error
            expect(response).toHaveProperty("result");
            expect(response).not.toHaveProperty("error");

            const result = response.result as Record<string, unknown>;
            expect(typeof result.response).toBe("string");
            expect((result.response as string).length).toBeGreaterThan(0);
          } finally {
            ws?.close();
          }
        },
        RPC_LLM_MS,
      );

      it(
        "ROUTE-13f: agent.execute without agentId uses defaultAgentId",
        async () => {
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

            const response = (await sendJsonRpc(
              ws,
              "agent.execute",
              {
                message: "Say DEFAULT",
              },
              33,
            )) as Record<string, unknown>;

            // Without agentId, daemon uses defaultAgentId (router-alpha)
            expect(response).toHaveProperty("result");
            expect(response).not.toHaveProperty("error");

            const result = response.result as Record<string, unknown>;
            expect(typeof result.response).toBe("string");
            expect((result.response as string).length).toBeGreaterThan(0);
          } finally {
            ws?.close();
          }
        },
        RPC_LLM_MS,
      );
    },
  );
});
