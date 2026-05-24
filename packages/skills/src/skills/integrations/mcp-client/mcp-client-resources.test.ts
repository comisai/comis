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

import { describe, it, expect, vi } from "vitest";
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

/**
 * Build a connected McpConnection wrapping the given stub SDK client.
 *
 * Defaults `capabilities` to BOTH resources + prompts advertised so the
 * happy-path adapter tests pass the CR-01 runtime capability gate. Override
 * `capabilities` (e.g. `{}`) to drive the gate-rejection cases.
 */
function makeConnection(
  client: Partial<Client>,
  status: McpConnectionStatus = "connected",
  overrides: Partial<McpConnection> = {},
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
    capabilities: { resources: {}, prompts: {} },
    ...overrides,
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
    // Use a custom MCP scheme (not file:/http:/https:, which CR-01 blocks for
    // SSRF). The returned content uri is opaque and just round-trips.
    const conn = makeConnection({
      readResource: async () => ({ contents: [{ uri: "res://a", text: "hello" }] }),
    });
    const result = await readResourceFromServer(makeManager(conn), "fs", "res://a");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ uri: "res://a", text: "hello" }]);
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

  it("WR-03 coerces non-string getPrompt argument values to strings before the SDK call", async () => {
    let received: Record<string, unknown> | undefined;
    const conn = makeConnection({
      getPrompt: async (req: { name: string; arguments?: Record<string, unknown> }) => {
        received = req.arguments;
        return { messages: [] };
      },
    });
    const result = await getPromptFromServer(makeManager(conn), "fs", "greet", {
      count: 5,
      flag: true,
      label: "hi",
    });
    expect(result.ok).toBe(true);
    // Every value must be a string — a raw cast would have leaked 5/true.
    expect(received).toEqual({ count: "5", flag: "true", label: "hi" });
  });
});

// ---------------------------------------------------------------------------
// CR-01: runtime capability gate + URI validation
// ---------------------------------------------------------------------------

describe("CR-01 runtime capability gate — adapters reject when capability not advertised", () => {
  it("rejects listResourcesForServer when the live connection advertises no resources capability", async () => {
    // SDK stub WOULD succeed; the gate must short-circuit before delegating.
    const listResources = vi.fn(async () => ({ resources: [{ uri: "x://a", name: "a" }] }));
    const conn = makeConnection({ listResources }, "connected", { capabilities: {} });
    const result = await listResourcesForServer(makeManager(conn), "fs");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("does not advertise resources capability");
    }
    expect(listResources).not.toHaveBeenCalled();
  });

  it("rejects readResourceFromServer when resources capability is absent (post-reconnect drop)", async () => {
    const readResource = vi.fn(async () => ({ contents: [] }));
    const conn = makeConnection({ readResource }, "connected", { capabilities: {} });
    const result = await readResourceFromServer(makeManager(conn), "fs", "x://a");
    expect(result.ok).toBe(false);
    expect(readResource).not.toHaveBeenCalled();
  });

  it("rejects the resources adapters when enableResources === false even with the capability present", async () => {
    const listResources = vi.fn(async () => ({ resources: [] }));
    const conn = makeConnection({ listResources }, "connected", {
      capabilities: { resources: {} },
      enableResources: false,
    });
    const result = await listResourcesForServer(makeManager(conn), "fs");
    expect(result.ok).toBe(false);
    expect(listResources).not.toHaveBeenCalled();
  });

  it("rejects listPromptsForServer when the live connection advertises no prompts capability", async () => {
    const listPrompts = vi.fn(async () => ({ prompts: [] }));
    const conn = makeConnection({ listPrompts }, "connected", { capabilities: {} });
    const result = await listPromptsForServer(makeManager(conn), "fs");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("does not advertise prompts capability");
    }
    expect(listPrompts).not.toHaveBeenCalled();
  });

  it("rejects getPromptFromServer when prompts capability is absent", async () => {
    const getPrompt = vi.fn(async () => ({ messages: [] }));
    const conn = makeConnection({ getPrompt }, "connected", { capabilities: {} });
    const result = await getPromptFromServer(makeManager(conn), "fs", "greet");
    expect(result.ok).toBe(false);
    expect(getPrompt).not.toHaveBeenCalled();
  });
});

describe("CR-01 readResourceFromServer rejects SSRF-prone URI schemes", () => {
  // The caller-controlled uri flows to client.readResource({ uri }); a remote
  // MCP server could be driven to fetch internal network/local resources.
  // http/https/file are rejected at the adapter boundary; the SDK call must
  // not be reached for those.
  it.each(["http://169.254.169.254/latest/meta-data/", "https://internal.local/secret", "file:///etc/passwd"])(
    "rejects %s before delegating to client.readResource",
    async (uri) => {
      const readResource = vi.fn(async () => ({ contents: [] }));
      const conn = makeConnection({ readResource });
      const result = await readResourceFromServer(makeManager(conn), "fs", uri);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("scheme");
      }
      expect(readResource).not.toHaveBeenCalled();
    },
  );

  it("allows MCP-conventional resource schemes (e.g. custom server namespaces)", async () => {
    const readResource = vi.fn(async () => ({ contents: [{ uri: "screen://display", text: "ok" }] }));
    const conn = makeConnection({ readResource });
    const result = await readResourceFromServer(makeManager(conn), "fs", "screen://display");
    expect(result.ok).toBe(true);
    expect(readResource).toHaveBeenCalledWith({ uri: "screen://display" });
  });
});
