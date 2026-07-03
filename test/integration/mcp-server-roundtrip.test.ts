// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end SDK Client <-> Comis MCP server integration test.
 *
 * **Regression guard.** A single comprehensive test that drives the entire MCP
 * surface against the real `/mcp/v1` endpoint via the official SDK 1.29.0
 * `Client` + `StreamableHTTPClientTransport`. Per-feature tests live in
 *
 *   - mcp-server-tools-list.test.ts  (default-deny filter)
 *   - mcp-server-tools-call.test.ts  (live dispatcher)
 *   - mcp-server-rate-limit.test.ts  (30/min/tool ceiling)
 *   - mcp-server-resources.test.ts   (CONFIRMED-only filter)
 *
 * This test asserts the WIRE-LEVEL contract holds across the WHOLE stack:
 * a future SDK bump, a transport-version skew, or a body-parsing race that
 * passes the per-feature suites but breaks the lifecycle as a whole MUST
 * fail HERE.
 *
 * Threat coverage: wire-compat regression guard + cross-cuts of
 * default-deny + trust-flag + CONFIRMED filter + wrapExternalContent
 * (all asserted in the one lifecycle).
 *
 * Port 8573 to avoid conflicts with other integration configs
 * (8569/8570/8571/8572).
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
  "../config/config.test-mcp-server-roundtrip.yaml",
);

// ---------------------------------------------------------------------------
// Test secrets -- neutral placeholders (never real credentials).
// ---------------------------------------------------------------------------

const MCP_ROUNDTRIP_SECRET = "mcp-svr-roundtrip-client-tok-1-fix";

// Session fixture used across resources/list + resources/read.
const SESSION_KEY_RT = "test:roundtrip-user:chan-RT";

// Expected safe set (3 tools annotated mcpExportPolicy="safe").
const EXPECTED_SAFE_TOOLS = ["browser", "web_fetch", "web_search"] as const;

// Never-export canaries -- a handful of high-value names that MUST NOT appear
// in tools/list regardless of allowlist -- they are annotated never-export.
const NEVER_EXPORT_CANARIES = [
  "tokens_manage",
  "exec",
  "write",
  "memory_store",
  "sessions_send",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connectMcpClient(
  baseUrl: string,
  bearer: string,
  clientName = "roundtrip",
): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp/v1`),
    {
      requestInit: {
        headers: { authorization: `Bearer ${bearer}` },
      },
    },
  );
  const client = new Client({ name: clientName, version: "0.0.1" });
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

describe("SDK Client end-to-end roundtrip against /mcp/v1", () => {
  let handle: TestDaemonHandle;
  let baseUrl: string;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    baseUrl = handle.gatewayUrl;

    // Seed the session that the allowlisted mcp-client will read via
    // resources/read. Three messages -- inbound (always confirmed),
    // outbound-delivered (confirmed), outbound-in-flight (pending, excluded
    // from resources/read by the CONFIRMED-only filter).
    const bridge = handle.daemon.sessionStoreBridge!;
    bridge.saveByFormattedKey(
      SESSION_KEY_RT,
      [
        { role: "user", content: "roundtrip-ping", timestamp: 1_700_001_000_000 },
        {
          role: "assistant",
          content: "roundtrip-delivered",
          timestamp: 1_700_001_001_000,
        },
        {
          role: "assistant",
          content: "roundtrip-pending",
          timestamp: 1_700_001_002_000,
        },
      ],
      {},
    );

    // Enqueue an IN-FLIGHT delivery-queue row for the "roundtrip-pending" text.
    // Using enqueueInFlight (status='in_flight') rather than enqueue (pending)
    // deterministically reproduces the state the recurring drainer produces the
    // moment it claims a pending row mid-send. The CONFIRMED-only filter must
    // still exclude it via `unconfirmedEntries()` (status != 'delivered'); the
    // older `pendingEntries()` path (status='pending' AND scheduled_at<=now)
    // hides in_flight rows and leaked this message — the exact CI race this pins.
    const seedSchedAt = Date.now() - 60_000;
    const r = await handle.daemon.deliveryQueue.enqueueInFlight({
      text: "roundtrip-pending",
      channelType: "test",
      channelId: "chan-RT",
      tenantId: "test",
      optionsJson: "{}",
      origin: "agent",
      maxAttempts: 3,
      createdAt: seedSchedAt,
      scheduledAt: seedSchedAt,
      expireAt: Date.now() + 3_600_000,
      traceId: null,
    });
    if (!r.ok) {
      throw new Error(`Failed to seed pending queue entry: ${r.error.message}`);
    }
  }, DAEMON_STARTUP_MS + 30_000);

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
  // The comprehensive lifecycle. One SDK Client. One connection. All five
  // wire-level interactions in sequence. Asserts at every step.
  // -------------------------------------------------------------------------

  it(
    "SDK Client completes full MCP lifecycle -- initialize tools/list tools/call resources/list resources/read close",
    async () => {
      const { client, close } = await connectMcpClient(baseUrl, MCP_ROUNDTRIP_SECRET);
      try {
        // -------------------------------------------------------------------
        // initialize -- SDK performs this inside connect(). Assert server
        // version + capabilities are populated -- a wire-level break here
        // means the SDK handshake didn't complete.
        // -------------------------------------------------------------------
        const serverInfo = client.getServerVersion();
        expect(serverInfo).toBeDefined();
        // The Comis MCP server identifies itself by package name in
        // packages/daemon/src/api/mcp-server-handlers.ts. Loose check --
        // the exact name is internal -- but it MUST be a non-empty string.
        expect(typeof serverInfo?.name).toBe("string");
        expect((serverInfo?.name ?? "").length).toBeGreaterThan(0);

        const caps = client.getServerCapabilities();
        expect(caps).toBeDefined();
        // The server advertises tools + resources capabilities; subscribe=false
        // on resources is implementation-internal -- the SDK exposes the
        // capability presence boolean.
        expect(caps?.tools).toBeDefined();
        expect(caps?.resources).toBeDefined();

        // -------------------------------------------------------------------
        // tools/list -- per-MCP-client filter exposes safe UNION allowlist.
        // Asserts annotation + filter interaction on the wire.
        // -------------------------------------------------------------------
        const tools = await client.listTools();
        const toolNames = tools.tools.map((t) => t.name).sort();
        const expectedNames = [...EXPECTED_SAFE_TOOLS, "memory_search"].sort();
        expect(toolNames).toEqual(expectedNames);

        // Negative assertion: never-export canaries MUST NOT appear.
        for (const canary of NEVER_EXPORT_CANARIES) {
          expect(toolNames).not.toContain(canary);
        }

        // -------------------------------------------------------------------
        // tools/call (happy path -- permission-gated tool in allowlist).
        // Asserts dispatcher: input validation pass-through, trust-flag
        // isolation, wrapExternalContent output wrap.
        // -------------------------------------------------------------------
        const callResult = (await client.callTool({
          name: "memory_search",
          arguments: { query: "roundtrip-test-query", limit: 3 },
        })) as {
          isError?: boolean;
          content?: Array<{ type: string; text?: string }>;
        };
        expect(callResult.isError ?? false).toBe(false);
        expect(callResult.content?.length).toBeGreaterThan(0);
        const callText = callResult.content?.[0]?.text ?? "";
        // wrapExternalContent markers -- the source label "MCP tool result"
        // (vs "MCP resource content" further down) distinguishes this from
        // the resource path.
        expect(callText).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
        expect(callText).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/);
        expect(callText).toContain("SECURITY NOTICE");
        expect(callText).toContain("MCP tool result");

        // -------------------------------------------------------------------
        // tools/call (never-export -- proves the wire-level public surface
        // does NOT include never-export tools even when explicitly asked).
        // The SDK either throws or returns isError -- either is acceptable.
        // -------------------------------------------------------------------
        let neverExportThrew = false;
        let neverExportSurfacedError = false;
        try {
          const r = (await client.callTool({
            name: "tokens_manage",
            arguments: { action: "list" },
          })) as { isError?: boolean };
          if (r.isError === true) {
            neverExportSurfacedError = true;
          }
        } catch (err) {
          neverExportThrew = err instanceof Error;
        }
        expect(neverExportThrew || neverExportSurfacedError).toBe(true);

        // -------------------------------------------------------------------
        // tools/call (trust-flag injection -- proves the dispatcher strips
        // _trustLevel BEFORE it reaches the underlying RPC. Successful
        // memory_search dispatch with the hostile flag in args = proof the
        // strip ran (an admin-trust-only RPC would have FAILED differently
        // if the flag leaked through).
        // -------------------------------------------------------------------
        const trustInjResult = (await client.callTool({
          name: "memory_search",
          arguments: {
            query: "roundtrip-trust-injection-test",
            limit: 1,
            _trustLevel: "admin",
          },
        })) as {
          isError?: boolean;
          content?: Array<{ type: string; text?: string }>;
        };
        expect(trustInjResult.isError ?? false).toBe(false);
        const trustInjText = trustInjResult.content?.[0]?.text ?? "";
        expect(trustInjText).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);

        // -------------------------------------------------------------------
        // resources/list -- per-MCP-client sessionAllowlist enumeration.
        // -------------------------------------------------------------------
        const resources = await client.listResources();
        expect(resources.resources.length).toBe(1);
        const seededResource = resources.resources[0]!;
        expect(seededResource.uri).toBe(`comis://session/${SESSION_KEY_RT}`);
        expect(seededResource.uri.startsWith("comis://session/")).toBe(true);

        // -------------------------------------------------------------------
        // resources/read -- CONFIRMED-only filter excludes "roundtrip-pending";
        // wrapExternalContent applied with source "MCP resource content".
        // -------------------------------------------------------------------
        const read = await client.readResource({
          uri: `comis://session/${SESSION_KEY_RT}`,
        });
        expect(read.contents.length).toBeGreaterThan(0);
        const readText = (read.contents[0] as { text?: string }).text ?? "";

        // Two CONFIRMED messages appear (inbound + delivered-outbound).
        expect(readText).toContain("roundtrip-ping");
        expect(readText).toContain("roundtrip-delivered");
        // The pending outbound MUST be excluded.
        expect(readText).not.toContain("roundtrip-pending");

        // wrapExternalContent markers + the resource-specific source label.
        expect(readText).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
        expect(readText).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/);
        expect(readText).toContain("SECURITY NOTICE");
        expect(readText).toContain("MCP resource content");

        // -------------------------------------------------------------------
        // close -- lifecycle clean exit. If the transport leaked state
        // anywhere (open sockets, dangling timers) the daemon's afterAll
        // cleanup would surface it.
        // -------------------------------------------------------------------
      } finally {
        await close();
      }
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // Independent connection test -- a SECOND SDK Client connects, completes
  // a minimal cycle, and disconnects. Proves the per-request McpServer +
  // singleton rate-limit-state model survives sequential client lifecycles
  // (no cross-client leak; rate-limit state for the previous tool calls
  // does not block this fresh client).
  // -------------------------------------------------------------------------

  it(
    "SDK Client second sequential connection on same /mcp/v1 endpoint completes minimal cycle",
    async () => {
      const { client, close } = await connectMcpClient(
        baseUrl,
        MCP_ROUNDTRIP_SECRET,
        "roundtrip-2nd",
      );
      try {
        // Fresh handshake -- the per-request McpServer model means this is
        // a brand-new server instance, but the rate-limit state singleton
        // remembers the previous test's tool calls. We use a small budget
        // (1 call) well under the 30/min ceiling.
        const tools = await client.listTools();
        expect(tools.tools.length).toBeGreaterThan(0);

        // Same per-client allowlist (memory_search) -- one call to prove
        // the dispatcher still works across the second connection.
        const r = (await client.callTool({
          name: "memory_search",
          arguments: { query: "second-connection", limit: 1 },
        })) as {
          isError?: boolean;
          content?: Array<{ type: string; text?: string }>;
        };
        expect(r.isError ?? false).toBe(false);
        expect(r.content?.[0]?.text ?? "").toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
      } finally {
        await close();
      }
    },
    60_000,
  );
});
