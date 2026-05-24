// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the Phase 65 OPUX-10 resources/prompts adapters + gate
 * helpers (mcp-client-resources.ts).
 *
 * Drives RED for:
 *  - serverAdvertisesResources / serverAdvertisesPrompts gate logic:
 *      capability present + config undefined  -> true (auto-register)
 *      capability present + config === false  -> false (opt-out)
 *      capability absent                       -> false
 *  - listResourcesForServer against a not-connected manager -> err
 *  - listResourcesForServer happy path over a mock manager whose
 *    getConnection returns a connected conn with a stubbed SDK client.
 *
 * The manager is a hand-built partial object exposing only getConnection
 * (the single method the adapters call). The SDK Client is stubbed with the
 * 4 resources/prompts methods.
 */

import { describe, it, expect } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  listResourcesForServer,
  readResourceFromServer,
  listPromptsForServer,
  getPromptFromServer,
  serverAdvertisesResources,
  serverAdvertisesPrompts,
} from "./mcp-client-resources.js";
import type {
  McpClientManager,
  McpConnection,
  McpConnectionStatus,
} from "./mcp-client-types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Build a partial McpClientManager whose getConnection returns `conn`. */
function makeManager(conn: McpConnection | undefined): McpClientManager {
  return {
    getConnection: () => conn,
  } as unknown as McpClientManager;
}

/** Build a connected McpConnection wrapping the given stub SDK client. */
function makeConnection(
  client: Partial<Client>,
  status: McpConnectionStatus = "connected",
): McpConnection {
  return {
    name: "fs",
    client: client as unknown as Client,
    status,
    tools: [],
    lastHealthCheck: 0,
    reconnectAttempt: 0,
    maxReconnectAttempts: 5,
    generation: 0,
  };
}

// ---------------------------------------------------------------------------
// Gate helpers
// ---------------------------------------------------------------------------

describe("serverAdvertisesResources / serverAdvertisesPrompts gate logic", () => {
  it("treats capabilities.resources present + config undefined as advertised (auto-register)", () => {
    expect(serverAdvertisesResources({ resources: { subscribe: true } }, undefined)).toBe(true);
  });

  it("suppresses resources when enableResources === false even with the capability present", () => {
    expect(serverAdvertisesResources({ resources: {} }, false)).toBe(false);
  });

  it("returns false for resources when the server advertises no resources capability", () => {
    expect(serverAdvertisesResources({}, undefined)).toBe(false);
  });

  it("treats capabilities.prompts present + config undefined as advertised, false opts out", () => {
    expect(serverAdvertisesPrompts({ prompts: {} }, undefined)).toBe(true);
    expect(serverAdvertisesPrompts({ prompts: {} }, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

describe("resources/prompts RPC adapters delegate to the per-server SDK client", () => {
  it("returns err when the requested server has no connection", async () => {
    const result = await listResourcesForServer(makeManager(undefined), "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('MCP server "x" not connected');
    }
  });

  it("returns err when the connection exists but is not in the connected state", async () => {
    const conn = makeConnection({ listResources: async () => ({ resources: [] }) }, "reconnecting");
    const result = await listResourcesForServer(makeManager(conn), "fs");
    expect(result.ok).toBe(false);
  });

  it("maps client.listResources() entries into ResourceListEntry[] on the happy path", async () => {
    const conn = makeConnection({
      listResources: async () => ({ resources: [{ uri: "file://a", name: "a" }] }),
    });
    const result = await listResourcesForServer(makeManager(conn), "fs");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ uri: "file://a", name: "a" }]);
    }
  });

  it("delegates readResourceFromServer to client.readResource and maps contents", async () => {
    const conn = makeConnection({
      readResource: async () => ({ contents: [{ uri: "file://a", text: "hello" }] }),
    });
    const result = await readResourceFromServer(makeManager(conn), "fs", "file://a");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ uri: "file://a", text: "hello" }]);
    }
  });

  it("delegates listPromptsForServer to client.listPrompts and maps entries", async () => {
    const conn = makeConnection({
      listPrompts: async () => ({ prompts: [{ name: "greet", description: "say hi" }] }),
    });
    const result = await listPromptsForServer(makeManager(conn), "fs");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ name: "greet", description: "say hi" }]);
    }
  });

  it("delegates getPromptFromServer to client.getPrompt with name + arguments", async () => {
    const conn = makeConnection({
      getPrompt: async (req: { name: string; arguments?: Record<string, unknown> }) => ({
        description: `prompt:${req.name}`,
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      }),
    });
    const result = await getPromptFromServer(makeManager(conn), "fs", "greet", { who: "world" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.description).toBe("prompt:greet");
      expect(result.value.messages).toHaveLength(1);
    }
  });
});
