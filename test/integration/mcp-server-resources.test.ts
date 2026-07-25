// SPDX-License-Identifier: Apache-2.0
/**
 * MCP resources/list + resources/read CONFIRMED filter.
 *
 * End-to-end via the MCP SDK 1.29.0 `Client` against a real daemon. Asserts:
 *
 *   1. `resources/list` with sessionAllowlist=[] returns an empty resources array.
 *   2. `resources/list` with sessionAllowlist=[sk] returns exactly one resource
 *      for sk -- correctly per-MCP-client gated.
 *   3. `resources/read` on a session in the allowlist returns ONLY the
 *      messages whose derived deliveryStatus === "confirmed". The seeded
 *      session has one inbound + one delivered outbound + one in-flight
 *      outbound -> two messages returned, in-flight excluded.
 *   4. `resources/read` on a session NOT in the per-client allowlist returns
 *      an MCP error (resource not found / unauthorized).
 *   5. The content text returned by resources/read is wrapped via
 *      wrapExternalContent (markers + SECURITY NOTICE present).
 *
 * Port 8572.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createConversationRef, type ConversationScope } from "@comis/core";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { DAEMON_STARTUP_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Session scopes + conversation_refs
//
// Sessions are addressed by explicit authority: a ConversationScope
// (tenant + agent + partition) that projects to an opaque conversation_ref.
// The mcp-client sessionAllowlist holds those refs (config), so the refs below
// MUST match the config literals in config.test-mcp-server-resources.yaml.
// The endpoint conversationId doubles as the deliveryStatus-join channelId the
// session.history handler uses (endpoint-conversation → partition.endpoint
// .conversationId), so the seeded delivery entry's channelId must equal it.
// ---------------------------------------------------------------------------

function sessionScope(conversationId: string): ConversationScope {
  return {
    tenantId: "test",
    // Must equal the daemon's routing.defaultAgentId (the identity the MCP
    // resources path queries session.history under) — here the schema default
    // "default", since these configs set no routing block.
    agentId: "default",
    partition: {
      kind: "endpoint-conversation",
      endpoint: {
        channelType: "test",
        channelInstanceId: "resources",
        conversationId,
        conversationKind: "direct",
      },
    },
  };
}

function refOf(scope: ConversationScope): string {
  const r = createConversationRef(scope);
  if (!r.ok) throw r.error;
  return r.value;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-mcp-server-resources.yaml",
);

// ---------------------------------------------------------------------------
// Test secrets -- aligned with the YAML config
// ---------------------------------------------------------------------------

const MCP_EMPTY_SECRET = "mcp-svr-resources-empty-tok-1-fixx";
const MCP_S1_SECRET = "mcp-svr-resources-s1-tok-2-fixxxxx";

// Session-key + content fixtures. The seeded session has 3 messages:
//   - inbound "ping" (user role)             -> deliveryStatus confirmed
//   - outbound "delivered-reply"              -> NO pending entry => confirmed
//   - outbound "in-flight-outbound"           -> pending entry exists => pending
//                                               (excluded from resources/read)
// chan-A is allowlisted (in the config); chan-B is NOT (the cross-conversation
// leak negative test). The channelId used for the deliveryStatus join equals
// the endpoint conversationId (chan-A / chan-B).
const SCOPE_S1 = sessionScope("chan-A");
const SCOPE_S2_NOT_ALLOWLISTED = sessionScope("chan-B");
const REF_S1 = refOf(SCOPE_S1);
const REF_S2_NOT_ALLOWLISTED = refOf(SCOPE_S2_NOT_ALLOWLISTED);

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
  const client = new Client({
    name: "mcp-server-resources",
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
// Test Suite
// ---------------------------------------------------------------------------

describe("MCP resources CONFIRMED-only filter", () => {
  let handle: TestDaemonHandle;
  let baseUrl: string;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    baseUrl = handle.gatewayUrl;

    // Seed the session that the allowlisted client will be authorized to read.
    // Three messages: inbound (always confirmed), outbound-delivered (confirmed),
    // outbound-in-flight (pending => excluded by resources/read).
    const bridge = handle.daemon.sessionStoreBridge!;
    const saved = bridge.save(SCOPE_S1, [
      { role: "user", content: "ping", timestamp: 1_700_000_000_000 },
      { role: "assistant", content: "delivered-reply", timestamp: 1_700_000_001_000 },
      { role: "assistant", content: "in-flight-outbound", timestamp: 1_700_000_002_000 },
    ], {});
    if (!saved.ok) throw saved.error;

    // Enqueue an outbound delivery-queue entry for the "in-flight-outbound"
    // text on chan-A. The session.history handler's join calls
    // `pendingEntries()` which returns rows with status='pending' (the
    // queue's canonical NOT-yet-delivered state visible to the join). We
    // seed via `enqueue()` (status='pending') with scheduledAt in the past
    // so `pendingEntries()` includes it. The label "in-flight-outbound"
    // remains semantically apt: from the MCP client's view, this is an
    // outbound message whose channel-side delivery has NOT been ack'd.
    const seedSchedAt = Date.now() - 60_000; // 1 minute ago so scheduled_at <= now
    const r = await handle.daemon.deliveryQueue.enqueue({
      text: "in-flight-outbound",
      channelType: "test",
      // channelId must equal the session's deliveryStatus-join channelId
      // (endpoint conversationId chan-A) so the CONFIRMED filter marks it pending.
      channelId: "chan-A",
      tenantId: "test",
      agentId: "default",
      conversationRef: REF_S1,
      destinationEndpoint: {
        channelType: "test",
        channelInstanceId: "resources",
        conversationId: "chan-A",
        conversationKind: "direct",
      },
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
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // resources/list -- per-MCP-client sessionAllowlist gating
  // -------------------------------------------------------------------------

  it(
    "MCP resources/list with sessionAllowlist empty returns an empty resources array",
    async () => {
      const { client, close } = await connectMcpClient(baseUrl, MCP_EMPTY_SECRET);
      try {
        const list = await client.listResources();
        expect(list.resources).toEqual([]);
      } finally {
        await close();
      }
    },
    30_000,
  );

  it(
    "MCP resources/list with sessionAllowlist with one entry returns exactly one resource for that session",
    async () => {
      const { client, close } = await connectMcpClient(baseUrl, MCP_S1_SECRET);
      try {
        const list = await client.listResources();
        expect(list.resources.length).toBe(1);
        const r = list.resources[0]!;
        // URI scheme is `comis://session/<sessionKey>` per the plan.
        expect(r.uri).toContain(REF_S1);
        expect(r.uri.startsWith("comis://session/")).toBe(true);
      } finally {
        await close();
      }
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // resources/read -- CONFIRMED filter (in-flight excluded)
  // -------------------------------------------------------------------------

  it(
    "MCP resources/read on allowlisted session returns only messages with deliveryStatus confirmed in-flight excluded",
    async () => {
      const { client, close } = await connectMcpClient(baseUrl, MCP_S1_SECRET);
      try {
        const read = await client.readResource({
          uri: `comis://session/${REF_S1}`,
        });
        // The MCP SDK returns `contents: Array<{uri, mimeType?, text?}>`.
        expect(read.contents.length).toBeGreaterThan(0);
        const text = (read.contents[0] as { text?: string }).text ?? "";

        // The two CONFIRMED messages (inbound + delivered outbound) MUST appear.
        expect(text).toContain("ping");
        expect(text).toContain("delivered-reply");

        // The in-flight outbound MUST NOT appear (CONFIRMED-only filter).
        expect(text).not.toContain("in-flight-outbound");
      } finally {
        await close();
      }
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // resources/read -- session NOT in per-client allowlist
  // -------------------------------------------------------------------------

  it(
    "MCP resources/read on a session NOT in sessionAllowlist returns an MCP error",
    async () => {
      const { client, close } = await connectMcpClient(baseUrl, MCP_S1_SECRET);
      try {
        let threw = false;
        try {
          await client.readResource({
            uri: `comis://session/${REF_S2_NOT_ALLOWLISTED}`,
          });
        } catch (err) {
          threw = err instanceof Error;
        }
        expect(threw).toBe(true);
      } finally {
        await close();
      }
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // resources/read -- content wrapped via wrapExternalContent
  // -------------------------------------------------------------------------

  it(
    "MCP resources/read content text is wrapped via wrapExternalContent defense-in-depth",
    async () => {
      const { client, close } = await connectMcpClient(baseUrl, MCP_S1_SECRET);
      try {
        const read = await client.readResource({
          uri: `comis://session/${REF_S1}`,
        });
        const text = (read.contents[0] as { text?: string }).text ?? "";

        // wrapExternalContent surrounds content with random-hex markers and
        // prepends a SECURITY NOTICE block.
        expect(text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
        expect(text).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/);
        expect(text).toContain("SECURITY NOTICE");
      } finally {
        await close();
      }
    },
    30_000,
  );
});
