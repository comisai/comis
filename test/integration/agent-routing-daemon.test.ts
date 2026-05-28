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
import { RPC_FAST_MS } from "../support/timeouts.js";
import { resolveWorkspaceDir } from "@comis/core";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, "../config/config.test-agent-routing.yaml");

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
      "ROUTE-11a: agents.list/agents.get return all 3 agents with distinct names",
      async () => {
        // WR-03: agent config is read via agents.list / agents.get rather than
        // config.get({section:"agents"}), which no longer egresses agent configs.
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

          const listResponse = (await sendJsonRpc(
            ws,
            "agents.list",
            {},
            10,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(listResponse).toHaveProperty("result");
          const listResult = listResponse.result as { agents: string[] };

          // Verify all 3 agents are present
          expect(listResult.agents).toContain("router-alpha");
          expect(listResult.agents).toContain("router-beta");
          expect(listResult.agents).toContain("router-gamma");

          // Verify distinct name fields via agents.get
          const expectedNames: Record<string, string> = {
            "router-alpha": "RouterAlpha",
            "router-beta": "RouterBeta",
            "router-gamma": "RouterGamma",
          };
          for (const [agentId, expectedName] of Object.entries(expectedNames)) {
            const getResponse = (await sendJsonRpc(
              ws,
              "agents.get",
              { agentId },
              10,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;
            expect(getResponse).toHaveProperty("result");
            const getResult = getResponse.result as Record<string, unknown>;
            expect(getResult.agentId).toBe(agentId);
            const config = getResult.config as Record<string, unknown>;
            expect(config.name).toBe(expectedName);
          }
        } finally {
          ws?.close();
        }
      },
      RPC_FAST_MS,
    );

    it(
      "ROUTE-11b: each agent has anthropic provider and model configured",
      async () => {
        // WR-03: per-agent provider/model is read via agents.get rather than
        // config.get({section:"agents"}).
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

          for (const agentId of ["router-alpha", "router-beta", "router-gamma"]) {
            const response = (await sendJsonRpc(
              ws,
              "agents.get",
              { agentId },
              11,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("result");
            const result = response.result as Record<string, unknown>;
            const agent = result.config as Record<string, unknown>;
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
      "ROUTE-11c: config.get does not egress the routing section (WR-03)",
      async () => {
        // WR-03: config.get({section:"routing"}) no longer egresses routing config;
        // it returns only the safe default { tenantId, logLevel, gateway }. The
        // defaultAgentId/bindings values were previously asserted here but are no
        // longer RPC-observable via config.get post-WR-03.
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

          // The requested section must be absent: only the safe default is returned.
          expect(result.routing).toBeUndefined();
          expect(result).toHaveProperty("tenantId");
          expect(result).toHaveProperty("gateway");

          // Binding details must not leak through any other field of the response.
          const serialized = JSON.stringify(result);
          expect(serialized).not.toContain("defaultAgentId");
          expect(serialized).not.toContain("vip-user");
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
      "ROUTE-13a: config.get does not egress the routing section (WR-03)",
      async () => {
        // WR-03: the routing defaultAgentId is no longer RPC-observable via
        // config.get; it returns only the safe default and omits the routing section.
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
          expect(result.routing).toBeUndefined();
          expect(JSON.stringify(result)).not.toContain("defaultAgentId");
        } finally {
          ws?.close();
        }
      },
      RPC_FAST_MS,
    );

    it(
      "ROUTE-13b: agents.list confirms all 3 agent executors are configured",
      async () => {
        // WR-03: the configured agent set is read via agents.list rather than
        // config.get({section:"agents"}).
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

          const response = (await sendJsonRpc(
            ws,
            "agents.list",
            {},
            21,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(response).toHaveProperty("result");
          const result = response.result as { agents: string[] };

          // All 3 agents should be present in the configured agent list
          expect(result.agents).toEqual(
            expect.arrayContaining(["router-alpha", "router-beta", "router-gamma"]),
          );
        } finally {
          ws?.close();
        }
      },
      RPC_FAST_MS,
    );
  });
});
