// SPDX-License-Identifier: Apache-2.0
/**
 * MCP-03 — trust-sandbox scenario test.
 *
 * Certifies MCP security invariants: trust-level stripping (_trustLevel:admin
 * injected by a hostile client must be removed before dispatching), taint-wrap
 * markers (wrapExternalContent open/close markers + SECURITY NOTICE present),
 * and cwd/rlimits sandbox isolation (deferred to Stage-C operator run).
 *
 * Stage-A (always runs, no COMIS_LIVE needed):
 *   Structural invariants — UNTRUSTED marker regex compiles, bearer token
 *   constant is defined, config path string is present.
 *
 * Stage-B (describe.skipIf(!isLive)):
 *   Boots the product daemon via ConversationDriver with
 *   configPath=config.test-mcp-server-tools-call.yaml — the config that
 *   provides the mcp-client bearer token. Without this configPath the daemon
 *   boots with the default config that has no mcp-client token and /mcp/v1
 *   would return 401. Connects the MCP SDK Client to the product /mcp/v1 endpoint
 *   using TRUST_STRIP_TEST_BEARER, calls tools/call memory_search, and asserts:
 *   - wrapExternalContent taint markers present (expectMcpTaintMarkers)
 *   - _trustLevel:admin injection is stripped (expectTrustLevelStripped)
 *   The log and persistence oracles run in afterEach after each test.
 *
 * Stage-C (it.skip):
 *   cwd/rlimits sandbox per-server workspace isolation — requires a configured
 *   MCP server with cwd set. Deferred to operator run.
 *
 * Security:
 *   Elevation of Privilege: expectTrustLevelStripped verifies that
 *   the product's delete args["_trustLevel"] guard is enforced.
 *
 * costTier: "¢" (memory_search is a local tool, no LLM cost in Stage-B).
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConversationDriver, flushDaemonLogs } from "../../harness/conversation.js";
import { runLogOracle } from "../../assert/log-oracle.js";
import { runDbOracle } from "../../assert/db-oracle.js";
import {
  expectMcpTaintMarkers,
  expectTrustLevelStripped,
  type McpRoundTripResult,
} from "../../assert/mcp-trace.js";

const _here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// COMIS_LIVE gate — Stage-B blocks skip (not fail) when unset
// ---------------------------------------------------------------------------

const isLive = !!process.env["COMIS_LIVE"];

// Daemon startup budget for beforeAll timeout.
const DAEMON_STARTUP_MS = 15_000;

// Bearer token for the mcp-client scope in config.test-mcp-server-tools-call.yaml.
// Confirmed: gateway.tokens[1].secret in that config file.
const TRUST_STRIP_TEST_BEARER = "mcp-svr-toolscall-tok-1-fixture-bbb";

// Config that provides the mcp-client token so /mcp/v1 does not return 401.
// Without this configPath the default config has no mcp-client token and the
// Stage-B MCP SDK Client would receive a 401.
const MCP_TOOLS_CALL_CONFIG = join(
  _here,
  "../../../config/config.test-mcp-server-tools-call.yaml",
);

// ---------------------------------------------------------------------------
// Shared helper — connect MCP SDK Client to product /mcp/v1
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
  const client = new Client({
    name: "mcp-03-trust-sandbox-test",
    version: "0.0.1",
  });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Stage-A — structural invariants, always runs (CI-safe, no COMIS_LIVE needed)
// ---------------------------------------------------------------------------

describe("MCP-03 Stage-A — trust-strip / taint-wrap constants (no COMIS_LIVE)", () => {
  it("UNTRUSTED marker regex matches expected taint-marker pattern", () => {
    const markerRe = /<<<UNTRUSTED_[a-f0-9]+>>>/;
    // Use a local alias to avoid architecture-gate false positive (test.naming gate
    // parses standalone `test(str)` calls; `re.test(str)` is a RegExp method).
    const matches = (s: string): boolean => markerRe.test(s);
    // Should match a valid hex taint marker (lowercase only — product only emits lowercase)
    expect(matches("<<<UNTRUSTED_abc123>>>")).toBe(true);
    // Should match longer hex strings (full 64-char hash prefix)
    expect(matches("<<<UNTRUSTED_deadbeef1234>>>")).toBe(true);
    // Should NOT match uppercase hex (product only emits lowercase)
    expect(matches("<<<UNTRUSTED_ABC123>>>")).toBe(false);
    // Should NOT match the empty string
    expect(matches("")).toBe(false);
    // Should NOT match plain text without the marker delimiters
    expect(matches("UNTRUSTED_abc123")).toBe(false);
  });

  it("trust-strip test bearer token is a fixture value", () => {
    expect(TRUST_STRIP_TEST_BEARER).toBeTruthy();
    expect(typeof TRUST_STRIP_TEST_BEARER).toBe("string");
    expect(TRUST_STRIP_TEST_BEARER.length).toBeGreaterThan(0);
  });

  it("MCP_TOOLS_CALL_CONFIG path is a string", () => {
    expect(typeof MCP_TOOLS_CALL_CONFIG).toBe("string");
    expect(MCP_TOOLS_CALL_CONFIG.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — trust-strip + taint-wrap via product daemon (COMIS_LIVE required)
//
// Boots the product daemon with config.test-mcp-server-tools-call.yaml which
// provides the mcp-client bearer token. Without this configPath the default
// config has no mcp-client token and /mcp/v1 returns 401.
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)(
  "MCP-03 Stage-B — trust-strip + taint-wrap via product daemon",
  () => {
    let driver: ConversationDriver;

    beforeAll(async () => {
      // Pass configPath so the daemon boots with the mcp-client token configured.
      // Without configPath, the default config has no mcp-client token and
      // /mcp/v1 returns 401.
      driver = new ConversationDriver({
        agentId: "mcp-03-b",
        configPath: MCP_TOOLS_CALL_CONFIG,
        timeoutMs: 30_000,
      });
      await driver.init();
    }, DAEMON_STARTUP_MS + 30_000);

    afterAll(async () => {
      try {
        await driver.close();
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (!m.includes("Daemon exit")) throw err;
      }
    });

    afterEach(async () => {
      // Flush daemon log buffer before snapshotting.
      await flushDaemonLogs(driver);

      // Log oracle: no unexpected errors in the daemon log.
      await runLogOracle(driver.capturedLogLines(), { expectedErrors: [] });

      // Persistence oracle — only run if memory.db was created.
      const dbPath = join(driver.getDataDir(), "memory.db");
      if (existsSync(dbPath)) {
        await runDbOracle(dbPath, {});
      }
    });

    it(
      "tools/call memory_search returns wrapExternalContent taint markers (MCP-03 taint-wrap)",
      async () => {
        const handle = driver.getHandle();
        const baseUrl = handle.gatewayUrl;
        const { client, close } = await connectMcpClient(
          baseUrl,
          TRUST_STRIP_TEST_BEARER,
        );
        try {
          const r = (await client.callTool({
            name: "memory_search",
            arguments: { query: "mcp-03-trust-test", limit: 3 },
          })) as {
            isError?: boolean;
            content?: Array<{ type: string; text?: string }>;
          };

          const result: McpRoundTripResult = {
            text: r.content?.[0]?.text ?? "",
            isError: r.isError ?? false,
          };

          await expectMcpTaintMarkers(result);
        } finally {
          await close();
        }
      },
      60_000,
    );

    it(
      "tools/call with _trustLevel:admin does NOT escalate (MCP-03 trust-strip)",
      async () => {
        const handle = driver.getHandle();
        const baseUrl = handle.gatewayUrl;
        const { client, close } = await connectMcpClient(
          baseUrl,
          TRUST_STRIP_TEST_BEARER,
        );
        try {
          const r = (await client.callTool({
            name: "memory_search",
            arguments: {
              query: "trust-strip-test",
              limit: 1,
              _trustLevel: "admin", // hostile injection attempt
            },
          })) as {
            isError?: boolean;
            content?: Array<{ type: string; text?: string }>;
          };

          const result: McpRoundTripResult = {
            text: r.content?.[0]?.text ?? "",
            isError: r.isError ?? false,
          };

          // Verifies the product's delete args["_trustLevel"] guard is enforced.
          // A regression would fail this assertion.
          await expectTrustLevelStripped(result);
        } finally {
          await close();
        }
      },
      60_000,
    );

    it.skip(
      "MCP-03 cwd/rlimits sandbox: per-server workspace isolation — requires configured MCP server with cwd set (deferred to Stage-C operator run)",
      () => {
        // Stage-C: boot a product daemon with a real MCP server config that
        // sets cwd to an isolated workspace directory. Assert that the product's
        // sandbox enforces directory boundaries and rlimits are applied.
        // Deferred: requires a Linux host + a real MCP server binary.
      },
    );
  },
);
