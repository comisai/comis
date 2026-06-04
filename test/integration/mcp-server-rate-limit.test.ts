// SPDX-License-Identifier: Apache-2.0
/**
 * MCP server tools/call rate-limit integration / stress test.
 *
 * Stress-tests the live tools/call dispatcher's per-MCP-client per-tool
 * minute-bucket rate limit end-to-end via the SDK 1.29.0 `Client`.
 * Acceptance criterion:
 *
 *   100 tools/call to memory_search from a single mcp-client within ~1s
 *   -> ~30 succeed, ~70 return rate-limit error (MCP isError:true with text
 *   containing "rate_limit_exceeded"). Daemon memory remains bounded (no
 *   per-call map explosion).
 *
 * Uses a dedicated port + config that issues an mcp-client token with
 * allowlist = ["memory_search"]. The dispatcher dispatches through the live
 * RPC indirection -- via `memory.search_files`.
 *
 * Port 8570 to coexist with parallel test runs under vitest pool: "forks".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { DAEMON_STARTUP_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-mcp-server-rate-limit.yaml",
);

// ---------------------------------------------------------------------------
// Test secrets
// ---------------------------------------------------------------------------

const MCP_RATELIMIT_SECRET = "mcp-svr-ratelimit-tok-1-test-fixture-aaa";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connectMcpClient(
  baseUrl: string,
  bearer: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp/v1`),
    {
      requestInit: {
        headers: { authorization: `Bearer ${bearer}` },
      },
    },
  );
  const client = new Client({ name: "mcp-ratelimit-test", version: "0.0.1" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("MCP tools/call per-client per-tool rate limit", () => {
  let handle: TestDaemonHandle;
  let baseUrl: string;
  // Survives vitest retries (module state persists across re-runs of the
  // test fn): a retry must wait for a fresh minute — the failed attempt
  // already consumed the current bucket. See the runway guard in the test.
  let burstAttempted = false;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    baseUrl = handle.gatewayUrl;
  }, DAEMON_STARTUP_MS + 30_000);

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

  it(
    "100 tools/call memory_search from a single mcp-client are throttled to 30 in the same minute",
    async () => {
      const { client, close } = await connectMcpClient(
        baseUrl,
        MCP_RATELIMIT_SECRET,
      );
      try {
        // The dispatcher's bucket is keyed by wall-clock minute, and the 100
        // sequential round-trips take 5-15s — a burst started late in a
        // minute straddles the boundary, the bucket resets mid-burst, and
        // ~2x the ceiling succeeds (observed on CI: 54). A vitest retry
        // within the same minute then finds the bucket already exhausted by
        // the first attempt and sees 0 successes. Start at a fresh minute
        // whenever the runway is short OR a previous attempt already
        // consumed this minute's bucket.
        const msIntoMinute = Date.now() % 60_000;
        if (msIntoMinute > 35_000 || burstAttempted) {
          await new Promise((r) => setTimeout(r, 60_000 - msIntoMinute + 250));
        }
        burstAttempted = true;

        // Fire 100 calls SEQUENTIALLY (or in parallel via Promise.all -- both
        // are valid; sequential keeps the failure mode easier to reason about
        // when something goes wrong). The dispatcher's minute-bucket counts
        // each invocation regardless of overlap.
        const results: Array<{ isError?: boolean; text?: string }> = [];
        for (let i = 0; i < 100; i++) {
          // Use a varied query so any FTS-side caching does not collapse.
          const r = (await client.callTool({
            name: "memory_search",
            arguments: { query: `q-${i}`, limit: 1 },
          })) as {
            isError?: boolean;
            content?: Array<{ type: string; text?: string }>;
          };
          results.push({
            isError: r.isError,
            text: r.content?.[0]?.text,
          });
        }

        const successes = results.filter((r) => (r.isError ?? false) === false);
        const errors = results.filter((r) => r.isError === true);

        // Default ceiling 30/min. Allow a tiny ±1 flex for clock-edge effects
        // (a call that lands exactly on the minute boundary could roll into
        // the next bucket; in practice 30 calls within ~1s never cross).
        expect(successes.length).toBeGreaterThanOrEqual(29);
        expect(successes.length).toBeLessThanOrEqual(31);
        expect(errors.length).toBeGreaterThanOrEqual(69);
        expect(errors.length).toBeLessThanOrEqual(71);
        expect(successes.length + errors.length).toBe(100);

        // Every error carries the rate-limit-exceeded marker AND resetAt
        // metadata (per the dispatcher contract).
        for (const e of errors) {
          expect(e.text ?? "").toContain("rate_limit_exceeded");
          expect(e.text ?? "").toContain("resetAt=");
        }
      } finally {
        await close();
      }
    },
    150_000, // up to 60s fresh-window wait + 100 sequential round-trips (5-15s)
  );
});
