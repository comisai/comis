/**
 * Graph Persistence: Named Graph RPC Round-Trip Integration Tests
 *
 * Validates the full save -> list -> load -> delete round-trip for named
 * graph persistence via the daemon's JSON-RPC WebSocket interface. Proves
 * the complete wiring works end-to-end: from WebSocket RPC call through
 * the daemon dispatch to the SQLite store and back.
 *
 * Uses a dedicated config (port 8710, separate memory DB) to avoid conflicts.
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
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-graph-persistence.yaml",
);

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
): Promise<unknown> {
  const id = ++rpcId;
  const response = (await sendJsonRpc(ws, method, params, id, {
    timeoutMs: RPC_FAST_MS,
  })) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };

  if (response.error) {
    throw new Error(response.error.message);
  }

  return response.result;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const GRAPH_1 = {
  id: "test-graph-1",
  label: "Test Pipeline",
  nodes: [
    {
      id: "n1",
      task: "Do something",
      dependsOn: [],
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  settings: { label: "Test Pipeline", onFailure: "fail-fast" },
};

const GRAPH_1_UPDATED = {
  id: "test-graph-1",
  label: "Updated Pipeline",
  nodes: [
    {
      id: "n1",
      task: "Do something",
      dependsOn: [],
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  settings: { label: "Updated Pipeline", onFailure: "continue" },
};

const GRAPH_2 = {
  id: "test-graph-2",
  label: "Second Pipeline",
  nodes: [
    {
      id: "n1",
      task: "First step",
      dependsOn: [],
      position: { x: 0, y: 0 },
    },
    {
      id: "n2",
      task: "Second step",
      dependsOn: ["n1"],
      position: { x: 0, y: 100 },
    },
  ],
  edges: [{ from: "n1", to: "n2" }],
  settings: { label: "Second Pipeline", onFailure: "fail-fast" },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Graph Persistence: Named Graph RPC Round-Trip", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  }, 60_000);

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
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 1: graph.save creates a new named graph
  // -------------------------------------------------------------------------

  it("graph.save creates a new named graph", async () => {
    const result = (await wsRpc(ws, "graph.save", GRAPH_1)) as {
      id: string;
      saved: boolean;
    };

    expect(result.id).toBe("test-graph-1");
    expect(result.saved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: graph.load retrieves the saved graph
  // -------------------------------------------------------------------------

  it("graph.load retrieves the saved graph", async () => {
    const result = (await wsRpc(ws, "graph.load", {
      id: "test-graph-1",
    })) as Record<string, unknown>;

    expect(result.id).toBe("test-graph-1");
    expect(result.label).toBe("Test Pipeline");

    // Verify nodes round-trip
    const nodes = result.nodes as Array<Record<string, unknown>>;
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("n1");

    // Verify edges round-trip
    const edges = result.edges as unknown[];
    expect(Array.isArray(edges)).toBe(true);
    expect(edges).toHaveLength(0);

    // Verify settings round-trip
    const settings = result.settings as Record<string, unknown>;
    expect(settings.onFailure).toBe("fail-fast");

    // Verify timestamps
    expect(typeof result.createdAt).toBe("number");
    expect(typeof result.updatedAt).toBe("number");
  });

  // -------------------------------------------------------------------------
  // Test 3: graph.save upserts an existing graph
  // -------------------------------------------------------------------------

  it("graph.save upserts an existing graph", async () => {
    // Save with updated data
    const saveResult = (await wsRpc(ws, "graph.save", GRAPH_1_UPDATED)) as {
      id: string;
      saved: boolean;
    };

    expect(saveResult.id).toBe("test-graph-1");
    expect(saveResult.saved).toBe(true);

    // Load and verify update
    const loadResult = (await wsRpc(ws, "graph.load", {
      id: "test-graph-1",
    })) as Record<string, unknown>;

    expect(loadResult.label).toBe("Updated Pipeline");
    const settings = loadResult.settings as Record<string, unknown>;
    expect(settings.onFailure).toBe("continue");
  });

  // -------------------------------------------------------------------------
  // Test 4: graph.list returns saved graphs with pagination
  // -------------------------------------------------------------------------

  it("graph.list returns saved graphs with pagination", async () => {
    // Save a second graph
    await wsRpc(ws, "graph.save", GRAPH_2);

    // List all (limit 10)
    const allResult = (await wsRpc(ws, "graph.list", { limit: 10 })) as {
      entries: Array<Record<string, unknown>>;
      total: number;
    };

    expect(allResult.total).toBeGreaterThanOrEqual(2);
    const ids = allResult.entries.map((e) => e.id);
    expect(ids).toContain("test-graph-1");
    expect(ids).toContain("test-graph-2");

    // Paginated: limit 1, offset 0
    const pageResult = (await wsRpc(ws, "graph.list", {
      limit: 1,
      offset: 0,
    })) as { entries: Array<Record<string, unknown>>; total: number };

    expect(pageResult.entries).toHaveLength(1);
    expect(pageResult.total).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Test 5: graph.list entries have summary fields
  // -------------------------------------------------------------------------

  it("graph.list entries have summary fields", async () => {
    const result = (await wsRpc(ws, "graph.list", { limit: 10 })) as {
      entries: Array<Record<string, unknown>>;
      total: number;
    };

    // Find test-graph-1 entry (upserted to "Updated Pipeline")
    const entry = result.entries.find((e) => e.id === "test-graph-1");
    expect(entry).toBeDefined();

    // Summary fields present
    expect(entry!.id).toBe("test-graph-1");
    expect(entry!.label).toBe("Updated Pipeline");
    expect(typeof entry!.nodeCount).toBe("number");
    expect(typeof entry!.createdAt).toBe("number");
    expect(typeof entry!.updatedAt).toBe("number");

    // Full payload fields should NOT be in summary
    expect(entry!).not.toHaveProperty("nodes");
    expect(entry!).not.toHaveProperty("edges");
    expect(entry!).not.toHaveProperty("settings");
  });

  // -------------------------------------------------------------------------
  // Test 6: graph.delete soft-deletes a graph
  // -------------------------------------------------------------------------

  it("graph.delete soft-deletes a graph", async () => {
    // Delete
    const deleteResult = (await wsRpc(ws, "graph.delete", {
      id: "test-graph-1",
    })) as { id: string; deleted: boolean };

    expect(deleteResult.id).toBe("test-graph-1");
    expect(deleteResult.deleted).toBe(true);

    // Verify not in list
    const listResult = (await wsRpc(ws, "graph.list", { limit: 10 })) as {
      entries: Array<Record<string, unknown>>;
      total: number;
    };

    const ids = listResult.entries.map((e) => e.id);
    expect(ids).not.toContain("test-graph-1");

    // Verify load returns error
    await expect(
      wsRpc(ws, "graph.load", { id: "test-graph-1" }),
    ).rejects.toThrow("Named graph not found");
  });

  // -------------------------------------------------------------------------
  // Test 7: graph.load throws for non-existent graph
  // -------------------------------------------------------------------------

  it("graph.load throws for non-existent graph", async () => {
    await expect(
      wsRpc(ws, "graph.load", { id: "non-existent-id" }),
    ).rejects.toThrow("Named graph not found");
  });

  // -------------------------------------------------------------------------
  // Test 8: graph.delete throws for non-existent graph
  // -------------------------------------------------------------------------

  it("graph.delete throws for non-existent graph", async () => {
    await expect(
      wsRpc(ws, "graph.delete", { id: "non-existent-id" }),
    ).rejects.toThrow("Named graph not found");
  });
});
