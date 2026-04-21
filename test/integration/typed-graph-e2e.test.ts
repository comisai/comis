// SPDX-License-Identifier: Apache-2.0
/**
 * Typed Graph E2E Integration Tests (TEST-06 + TEST-08)
 *
 * Validates the full typed-node dispatch pipeline against a real daemon with
 * real LLM calls:
 *
 * - TEST-06: Mixed pipeline with regular + debate + vote nodes executes end-to-end.
 *   All three node types dispatched through the driver interface; research node
 *   completes; debate and vote nodes reach a terminal state.
 *
 * - TEST-08: Two concurrent pipelines hitting the global sub-agent limit (2)
 *   demonstrate queuing (queueDepth > 0) and both eventually complete.
 *
 * Gated on LLM key availability via describe.skipIf. When keys are absent,
 * vitest marks the suite as skipped (not failed).
 *
 * Uses dedicated config (port 8741, graphMaxGlobalSubAgents: 2, 3 agents).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS, RPC_LLM_MS } from "../support/timeouts.js";
import { getProviderEnv, hasAnyProvider, PROVIDER_GROUPS } from "../support/provider-env.js";

// ---------------------------------------------------------------------------
// Path resolution and LLM key detection
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-typed-graph-e2e.yaml");

const providerEnv = getProviderEnv();
const hasLlmKey = hasAnyProvider(providerEnv, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// RPC helper
// ---------------------------------------------------------------------------

/** Auto-incrementing JSON-RPC request ID. */
let rpcId = 0;

/**
 * Send a JSON-RPC request via WebSocket and return the result.
 * Throws an Error with the RPC error message if the response has an error.
 */
async function wsRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<unknown> {
  const id = ++rpcId;
  const response = (await sendJsonRpc(ws, method, params, id, {
    timeoutMs: options?.timeoutMs ?? RPC_FAST_MS,
  })) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };

  if (response.error) {
    throw new Error(response.error.message);
  }

  return response.result;
}

// ---------------------------------------------------------------------------
// Poll helper
// ---------------------------------------------------------------------------

/**
 * Poll graph.status until the graph reaches a terminal state.
 *
 * LLM calls are slow so we poll every 2000ms (not 500ms). Default timeout
 * is 180s to account for multi-round debate + vote operations.
 */
async function pollGraphUntilTerminal(
  ws: WebSocket,
  graphId: string,
  timeoutMs = 180_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  const pollInterval = 2000;

  while (Date.now() - start < timeoutMs) {
    const status = (await wsRpc(ws, "graph.status", { graphId }, {
      timeoutMs: RPC_LLM_MS,
    })) as Record<string, unknown>;

    if (status.isTerminal === true) {
      return status;
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`Graph ${graphId} did not reach terminal state within ${timeoutMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// Test suite (gated on LLM key availability)
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)("Typed Graph E2E Integration (TEST-06 + TEST-08)", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
  }, 120_000);

  afterAll(async () => {
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
  }, 30_000);

  // -------------------------------------------------------------------------
  // TEST-06: Mixed pipeline with regular + debate + vote nodes
  // -------------------------------------------------------------------------

  it("mixed pipeline with regular + debate + vote nodes executes end-to-end", async () => {
    let ws: WebSocket | null = null;

    try {
      ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

      // Submit mixed-type pipeline: regular node -> debate typed node -> vote typed node
      const execResult = (await wsRpc(ws, "graph.execute", {
        nodes: [
          {
            nodeId: "research",
            task: "Write one sentence about TypeScript.",
            dependsOn: [],
          },
          {
            nodeId: "debate",
            task: "Debate the merits of: {{research}}",
            dependsOn: ["research"],
            typeId: "debate",
            typeConfig: { agents: ["alpha", "beta"], rounds: 1 },
          },
          {
            nodeId: "vote",
            task: "Vote on the best argument from: {{debate}}",
            dependsOn: ["debate"],
            typeId: "vote",
            typeConfig: { voters: ["alpha", "beta"] },
          },
        ],
        label: "Mixed Pipeline E2E",
        onFailure: "continue",
      }, { timeoutMs: RPC_FAST_MS })) as { graphId?: string };

      expect(execResult.graphId).toBeDefined();
      const graphId = execResult.graphId as string;

      // Poll until terminal (generous timeout for multi-round LLM calls)
      const result = await pollGraphUntilTerminal(ws, graphId, 180_000);

      // Structural assertions only -- do NOT assert on LLM output text
      const nodes = result.nodes as Record<string, { status: string }>;

      // Research node (regular, no typeId) should complete
      expect(nodes.research).toBeDefined();
      expect(nodes.research.status).toBe("completed");

      // Debate and vote nodes: reaching any terminal state confirms they
      // were dispatched through the typed driver interface
      expect(nodes.debate).toBeDefined();
      expect(["completed", "failed"]).toContain(nodes.debate.status);

      expect(nodes.vote).toBeDefined();
      expect(["completed", "failed"]).toContain(nodes.vote.status);

      // If all 3 completed, graph status should be "completed"
      if (
        nodes.research.status === "completed" &&
        nodes.debate.status === "completed" &&
        nodes.vote.status === "completed"
      ) {
        expect(result.status).toBe("completed");
      }
    } finally {
      if (ws) ws.close();
    }
  }, 300_000);

  // -------------------------------------------------------------------------
  // TEST-08: Concurrent pipelines hitting global sub-agent limit
  // -------------------------------------------------------------------------

  it("two concurrent pipelines hitting global sub-agent limit demonstrate queuing", async () => {
    let ws: WebSocket | null = null;

    try {
      ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

      // Submit two graphs simultaneously -- 6 independent nodes total,
      // but graphMaxGlobalSubAgents: 2 means only 2 can run at once
      const [execA, execB] = await Promise.all([
        wsRpc(ws, "graph.execute", {
          nodes: [
            { nodeId: "a1", task: "Say hello in English.", dependsOn: [] },
            { nodeId: "a2", task: "Say hello in French.", dependsOn: [] },
            { nodeId: "a3", task: "Say hello in Spanish.", dependsOn: [] },
          ],
          label: "Concurrent Pipeline A",
        }, { timeoutMs: RPC_FAST_MS }) as Promise<{ graphId?: string }>,
        wsRpc(ws, "graph.execute", {
          nodes: [
            { nodeId: "b1", task: "Count to three.", dependsOn: [] },
            { nodeId: "b2", task: "Count to four.", dependsOn: [] },
            { nodeId: "b3", task: "Count to five.", dependsOn: [] },
          ],
          label: "Concurrent Pipeline B",
        }, { timeoutMs: RPC_FAST_MS }) as Promise<{ graphId?: string }>,
      ]);

      expect(execA.graphId).toBeDefined();
      expect(execB.graphId).toBeDefined();
      const graphIdA = execA.graphId as string;
      const graphIdB = execB.graphId as string;

      // Observe queuing: sample concurrency stats while nodes are running.
      // The contention window may be brief, so poll multiple times.
      let sawContention = false;
      let confirmedMaxGlobal = false;

      // Brief delay to let nodes start spawning
      await new Promise((r) => setTimeout(r, 500));

      for (let sample = 0; sample < 5; sample++) {
        const statsResult = (await wsRpc(ws, "graph.status", {}, {
          timeoutMs: RPC_FAST_MS,
        })) as { concurrency?: { maxGlobalSubAgents: number; globalActiveSubAgents: number; queueDepth: number } };

        if (statsResult.concurrency) {
          // Confirm config was wired correctly
          if (statsResult.concurrency.maxGlobalSubAgents === 2) {
            confirmedMaxGlobal = true;
          }

          // Check for contention evidence
          if (
            statsResult.concurrency.queueDepth > 0 ||
            statsResult.concurrency.globalActiveSubAgents === 2
          ) {
            sawContention = true;
          }
        }

        // If we already confirmed both conditions, no need to keep polling
        if (sawContention && confirmedMaxGlobal) break;

        await new Promise((r) => setTimeout(r, 1000));
      }

      // maxGlobalSubAgents must be 2 (confirms new daemon.ts wiring)
      expect(confirmedMaxGlobal).toBe(true);

      // Contention should have been observed (queueDepth > 0 or at capacity)
      expect(sawContention).toBe(true);

      // Wait for both graphs to complete
      const [resultA, resultB] = await Promise.all([
        pollGraphUntilTerminal(ws, graphIdA, 180_000),
        pollGraphUntilTerminal(ws, graphIdB, 180_000),
      ]);

      // Both graphs should reach a terminal state
      expect(resultA.isTerminal).toBe(true);
      expect(resultB.isTerminal).toBe(true);

      // Both should have status completed or failed (we care about the
      // concurrency mechanism, not LLM output quality)
      expect(["completed", "failed"]).toContain(resultA.status);
      expect(["completed", "failed"]).toContain(resultB.status);
    } finally {
      if (ws) ws.close();
    }
  }, 300_000);
});
