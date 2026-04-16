/**
 * MEM: Memory Tools & Hybrid Search
 *
 * Integration tests validating agent-invoked memory tools and search ranking:
 *   MEM-03: memory_search finds entries by semantic query
 *   MEM-04: memory_get reads workspace files (SOUL.md)
 *   MEM-05: Hybrid search produces ranked results (keyword-matching entry ranked higher)
 *
 * Uses a dedicated config (port 8446, separate memory DB) to avoid conflicts.
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
const memoryToolsConfigPath = resolve(
  __dirname,
  "../config/config.test-memory-tools.yaml",
);

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)("MEM: Memory Tools & Hybrid Search", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    logProviderAvailability(env);
    handle = await startTestDaemon({ configPath: memoryToolsConfigPath });
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
  // Test 1: Seed memory entries with distinct keywords
  // -------------------------------------------------------------------------

  it(
    "seed memory entries with distinct keywords",
    async () => {
      // Seed entry 1: BLUEFOX
      let ws1: WebSocket | undefined;
      try {
        ws1 = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const seedResponse1 = (await sendJsonRpc(
          ws1,
          "agent.execute",
          {
            message:
              "Please remember this project note: Project BLUEFOX is a software engineering initiative launched in April 2025 focusing on microservices architecture and API gateway design. Acknowledge that you've stored this.",
          },
          1,
        )) as Record<string, unknown>;

        expect(seedResponse1).toHaveProperty("result");
        expect(seedResponse1).not.toHaveProperty("error");
        const seedResult1 = seedResponse1.result as Record<string, unknown>;
        expect(typeof seedResult1.response).toBe("string");
        expect((seedResult1.response as string).length).toBeGreaterThan(0);
      } finally {
        ws1?.close();
      }

      // Wait for SQLite flush
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // Seed entry 2: REDHAWK
      let ws2: WebSocket | undefined;
      try {
        ws2 = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const seedResponse2 = (await sendJsonRpc(
          ws2,
          "agent.execute",
          {
            message:
              "Please remember this separate project note: Project REDHAWK is a data analytics platform started in June 2025 for real-time dashboard visualization and reporting. Acknowledge that you've stored this.",
          },
          2,
        )) as Record<string, unknown>;

        expect(seedResponse2).toHaveProperty("result");
        expect(seedResponse2).not.toHaveProperty("error");
        const seedResult2 = seedResponse2.result as Record<string, unknown>;
        expect(typeof seedResult2.response).toBe("string");
        expect((seedResult2.response as string).length).toBeGreaterThan(0);
      } finally {
        ws2?.close();
      }

      // Wait for SQLite flush
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    },
    180_000,
  );

  // -------------------------------------------------------------------------
  // Test 2: Agent uses memory_search tool to find a specific entry (MEM-03)
  // -------------------------------------------------------------------------

  it(
    "agent uses memory_search tool to find a specific entry (MEM-03)",
    async () => {
      let ws3: WebSocket | undefined;
      try {
        ws3 = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const searchResponse = (await sendJsonRpc(
          ws3,
          "agent.execute",
          {
            message:
              "Use your memory_search tool to search for 'BLUEFOX microservices'. Report exactly what the search results contain.",
          },
          3,
        )) as Record<string, unknown>;

        expect(searchResponse).toHaveProperty("result");
        expect(searchResponse).not.toHaveProperty("error");

        const searchResult = searchResponse.result as Record<string, unknown>;
        expect(typeof searchResult.response).toBe("string");

        // The agent should report BLUEFOX content from memory_search results
        const responseText = (searchResult.response as string).toUpperCase();
        expect(responseText).toContain("BLUEFOX");
      } finally {
        ws3?.close();
      }
    },
    180_000,
  );

  // -------------------------------------------------------------------------
  // Test 3: Agent uses memory_get tool to read workspace file (MEM-04)
  // -------------------------------------------------------------------------

  it(
    "agent uses memory_get tool to read workspace file (MEM-04)",
    async () => {
      let ws4: WebSocket | undefined;
      try {
        ws4 = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const getResponse = (await sendJsonRpc(
          ws4,
          "agent.execute",
          {
            message:
              "Use your memory_get tool to read the file 'SOUL.md' from your workspace. Tell me what the file contains.",
          },
          4,
        )) as Record<string, unknown>;

        expect(getResponse).toHaveProperty("result");
        expect(getResponse).not.toHaveProperty("error");

        const getResult = getResponse.result as Record<string, unknown>;
        expect(typeof getResult.response).toBe("string");

        // SOUL.md contains personality/privacy-related content
        const responseText = (getResult.response as string).toLowerCase();
        const mentionsWorkspaceContent =
          responseText.includes("privacy") ||
          responseText.includes("personality") ||
          responseText.includes("identity") ||
          responseText.includes("soul") ||
          responseText.includes("boundaries") ||
          responseText.includes("values") ||
          responseText.includes("principles");
        expect(mentionsWorkspaceContent).toBe(true);
      } finally {
        ws4?.close();
      }
    },
    180_000,
  );

  // -------------------------------------------------------------------------
  // Test 4: Hybrid search ranks matching entries higher (MEM-05)
  // -------------------------------------------------------------------------

  it(
    "hybrid search ranks matching entries higher than non-matching (MEM-05)",
    async () => {
      let ws5: WebSocket | undefined;
      try {
        ws5 = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        // Use the memory.search RPC directly (not via agent)
        // tenantId must match config (defaults to "default" if not provided)
        const searchResponse = (await sendJsonRpc(
          ws5,
          "memory.search",
          { query: "BLUEFOX microservices API gateway", limit: 10, tenantId: "test" },
          5,
          { timeoutMs: RPC_FAST_MS },
        )) as Record<string, unknown>;

        expect(searchResponse).toHaveProperty("result");
        expect(searchResponse).not.toHaveProperty("error");

        const searchResult = searchResponse.result as Record<string, unknown>;
        const results = searchResult.results as Array<{
          id: string;
          content: string;
          memoryType: string;
          trustLevel: string;
          score: number;
          createdAt: string;
        }>;

        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);

        // Find entries containing BLUEFOX and REDHAWK
        const bluefoxIndex = results.findIndex((r) =>
          r.content.toUpperCase().includes("BLUEFOX"),
        );
        const redhawkIndex = results.findIndex((r) =>
          r.content.toUpperCase().includes("REDHAWK"),
        );

        // At least one result must contain BLUEFOX (the query-matching entry)
        expect(bluefoxIndex).toBeGreaterThanOrEqual(0);

        // If both are present, BLUEFOX should rank higher (lower index)
        if (redhawkIndex >= 0) {
          expect(bluefoxIndex).toBeLessThan(redhawkIndex);
        }
        // If only BLUEFOX is present, ranking correctly prioritized it
      } finally {
        ws5?.close();
      }
    },
    30_000,
  );
});
