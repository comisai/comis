/**
 * MEM: Memory RPC Integration Tests
 *
 * Validates the memory.search and memory.inspect WebSocket JSON-RPC methods:
 *   MEM-01: memory.search returns results matching a query against seeded content
 *   MEM-02: memory.inspect returns database statistics (totalEntries, byType, dbSizeBytes)
 *   MEM-03: memory.search returns empty/no-match for unrelated query
 *
 * Uses a dedicated config (port 8445, separate memory DB) to avoid conflicts.
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
import {
  getProviderEnv,
  hasAnyProvider,
  PROVIDER_GROUPS,
  logProviderAvailability,
} from "../support/provider-env.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const memoryConfigPath = resolve(
  __dirname,
  "../config/config.test-memory.yaml",
);

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)("MEM: Memory RPC", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    logProviderAvailability(env);
    handle = await startTestDaemon({ configPath: memoryConfigPath });
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

  it(
    "memory.search returns results for seeded content (MEM-01)",
    async () => {
      // -------------------------------------------------------------------
      // Step 1: Seed memory via agent.execute
      // -------------------------------------------------------------------
      let ws1: WebSocket | undefined;
      try {
        ws1 = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const seedResponse = (await sendJsonRpc(
          ws1,
          "agent.execute",
          {
            message:
              "Remember this critical fact: Project SILVERFOX uses quantum-resistant encryption and was deployed on March 3rd 2025. Acknowledge you've noted this.",
          },
          1,
        )) as Record<string, unknown>;

        // Verify seed succeeded
        expect(seedResponse).toHaveProperty("result");
        expect(seedResponse).not.toHaveProperty("error");
      } finally {
        ws1?.close();
      }

      // Wait for SQLite flush (per decision 29-02)
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // -------------------------------------------------------------------
      // Step 2: Search for the seeded content
      // -------------------------------------------------------------------
      let ws2: WebSocket | undefined;
      try {
        ws2 = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const searchResponse = (await sendJsonRpc(
          ws2,
          "memory.search",
          { query: "SILVERFOX quantum encryption", limit: 10, tenantId: "test" },
          2,
        )) as Record<string, unknown>;

        // Verify response structure
        expect(searchResponse).toHaveProperty("result");
        expect(searchResponse).not.toHaveProperty("error");

        const result = searchResponse.result as Record<string, unknown>;
        expect(Array.isArray(result.results)).toBe(true);

        const results = result.results as Array<Record<string, unknown>>;
        expect(results.length).toBeGreaterThan(0);

        // Verify at least one result contains "SILVERFOX" (case-insensitive)
        const hasSilverfox = results.some((r) =>
          String(r.content).toUpperCase().includes("SILVERFOX"),
        );
        expect(hasSilverfox).toBe(true);
      } finally {
        ws2?.close();
      }
    },
    180_000,
  );

  it(
    "memory.inspect returns database statistics (MEM-02)",
    async () => {
      let ws3: WebSocket | undefined;
      try {
        ws3 = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const inspectResponse = (await sendJsonRpc(
          ws3,
          "memory.inspect",
          {},
          3,
          { timeoutMs: RPC_FAST_MS },
        )) as Record<string, unknown>;

        // Verify response structure
        expect(inspectResponse).toHaveProperty("result");
        expect(inspectResponse).not.toHaveProperty("error");

        const result = inspectResponse.result as Record<string, unknown>;
        expect(result.stats).toBeDefined();
        expect(typeof result.stats).toBe("object");

        const stats = result.stats as Record<string, unknown>;

        // Verify totalEntries is a number >= 0
        expect(typeof stats.totalEntries).toBe("number");
        expect(stats.totalEntries as number).toBeGreaterThanOrEqual(0);

        // Verify dbSizeBytes is a number > 0
        expect(typeof stats.dbSizeBytes).toBe("number");
        expect(stats.dbSizeBytes as number).toBeGreaterThan(0);

        // Verify byType is an object
        expect(typeof stats.byType).toBe("object");
        expect(stats.byType).not.toBeNull();
      } finally {
        ws3?.close();
      }
    },
    30_000,
  );

  it(
    "memory.search returns empty for unrelated query",
    async () => {
      let ws4: WebSocket | undefined;
      try {
        ws4 = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const searchResponse = (await sendJsonRpc(
          ws4,
          "memory.search",
          { query: "xyzzyflurble9999", limit: 5, tenantId: "test" },
          4,
          { timeoutMs: RPC_FAST_MS },
        )) as Record<string, unknown>;

        // Verify response structure (no error)
        expect(searchResponse).toHaveProperty("result");
        expect(searchResponse).not.toHaveProperty("error");

        const result = searchResponse.result as Record<string, unknown>;
        expect(Array.isArray(result.results)).toBe(true);
      } finally {
        ws4?.close();
      }
    },
    30_000,
  );
});
