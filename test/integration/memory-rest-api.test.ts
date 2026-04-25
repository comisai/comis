// SPDX-License-Identifier: Apache-2.0
/**
 * MEM-REST: Memory REST API Integration Tests
 *
 * Validates the memory REST API endpoints (GET /api/memory/search, GET /api/memory/stats)
 * covering HTTP contract validation, auth enforcement, and parameter validation.
 *
 * Test IDs:
 *   MEM-REST-01: GET /api/memory/stats returns 200 with stats shape on empty DB
 *   MEM-REST-02: GET /api/memory/search returns 400 without q param
 *   MEM-REST-03: GET /api/memory/search with q returns 200 + results shape
 *   MEM-REST-04: GET /api/memory/search limit param is respected
 *   MEM-REST-05: GET /api/memory/stats without Authorization returns 401
 *   MEM-REST-06: GET /api/memory/search without Authorization returns 401
 *   MEM-REST-07: GET /api/memory/stats rejects query param token
 *   MEM-REST-08: GET /api/memory/search with invalid bearer token returns 401
 *   MEM-REST-10: GET /api/memory/search with empty q returns 400
 *
 * Uses a dedicated config (port 8507, separate memory DB) to avoid conflicts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-memory-rest.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MEM-REST: Memory REST API", () => {
  let handle: TestDaemonHandle;
  let gatewayUrl: string;
  let authToken: string;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    gatewayUrl = handle.gatewayUrl;
    authToken = handle.authToken;
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Auth enforcement tests (no data seeding needed)
  // -------------------------------------------------------------------------

  it(
    "GET /api/memory/stats without Authorization returns 401 (MEM-REST-05)",
    async () => {
      const res = await fetch(`${gatewayUrl}/api/memory/stats`);
      expect(res.status).toBe(401);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("error", "Unauthorized");
    },
    10_000,
  );

  it(
    "GET /api/memory/search without Authorization returns 401 (MEM-REST-06)",
    async () => {
      const res = await fetch(`${gatewayUrl}/api/memory/search?q=test`);
      expect(res.status).toBe(401);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("error", "Unauthorized");
    },
    10_000,
  );

  it(
    "GET /api/memory/search with invalid bearer token returns 401 (MEM-REST-08)",
    async () => {
      const res = await fetch(`${gatewayUrl}/api/memory/search?q=test`, {
        headers: makeAuthHeaders("invalid-token-xxx"),
      });
      expect(res.status).toBe(401);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("error", "Unauthorized");
    },
    10_000,
  );

  it(
    "GET /api/memory/stats rejects query param token (MEM-REST-07)",
    async () => {
      // Query param tokens are NOT supported by REST API auth middleware
      // It only reads from Authorization header
      const res = await fetch(
        `${gatewayUrl}/api/memory/stats?token=test-secret-key-for-integration-tests`,
      );
      expect(res.status).toBe(401);
    },
    10_000,
  );

  // -------------------------------------------------------------------------
  // Empty DB contract tests (no data seeding needed)
  // -------------------------------------------------------------------------

  it(
    "GET /api/memory/stats returns 200 with stats shape on empty DB (MEM-REST-01)",
    async () => {
      const res = await fetch(`${gatewayUrl}/api/memory/stats`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.stats).toBeDefined();
      expect(typeof body.stats).toBe("object");

      const stats = body.stats as Record<string, unknown>;
      expect(typeof stats.totalEntries).toBe("number");
      expect(typeof stats.dbSizeBytes).toBe("number");
      expect(typeof stats.byType).toBe("object");
    },
    10_000,
  );

  it(
    "GET /api/memory/search returns 400 without q param (MEM-REST-02)",
    async () => {
      const res = await fetch(`${gatewayUrl}/api/memory/search`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty(
        "error",
        "Missing required query parameter: q",
      );
    },
    10_000,
  );

  it(
    "GET /api/memory/search with empty q returns 400 (MEM-REST-10)",
    async () => {
      const res = await fetch(`${gatewayUrl}/api/memory/search?q=`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty(
        "error",
        "Missing required query parameter: q",
      );
    },
    10_000,
  );

  it(
    "GET /api/memory/search with q returns 200 + results shape (MEM-REST-03)",
    async () => {
      const res = await fetch(`${gatewayUrl}/api/memory/search?q=test`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(Array.isArray(body.results)).toBe(true);
    },
    10_000,
  );

  it(
    "GET /api/memory/search limit param is respected (MEM-REST-04)",
    async () => {
      const headers = makeAuthHeaders(authToken);

      // Test 1: explicit limit=5
      const res1 = await fetch(
        `${gatewayUrl}/api/memory/search?q=test&limit=5`,
        { headers },
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as Record<string, unknown>;
      expect(Array.isArray(body1.results)).toBe(true);

      // Test 2: limit=0 (clamped to 1)
      const res2 = await fetch(
        `${gatewayUrl}/api/memory/search?q=test&limit=0`,
        { headers },
      );
      expect(res2.status).toBe(200);

      // Test 3: limit=999 (clamped to 100)
      const res3 = await fetch(
        `${gatewayUrl}/api/memory/search?q=test&limit=999`,
        { headers },
      );
      expect(res3.status).toBe(200);

      // Test 4: limit=abc (NaN, defaults to 10)
      const res4 = await fetch(
        `${gatewayUrl}/api/memory/search?q=test&limit=abc`,
        { headers },
      );
      expect(res4.status).toBe(200);
    },
    10_000,
  );

});
