// SPDX-License-Identifier: Apache-2.0
/**
 * registerMcpResourcesForClient unit tests.
 *
 * Pins the resources/list + resources/read behaviour in isolation by mocking
 * `daemonRpcForMcpClient` and capturing the SDK callback handlers via a
 * `McpServer.prototype.registerResource` spy.
 *
 * Coverage:
 *
 *   - resources/list returns one resource per sessionAllowlist entry; empty
 *     allowlist returns an empty resources array.
 *   - resources/read rejects sessions NOT in the per-client allowlist with a
 *     `[session_not_allowlisted]` error.
 *   - resources/read on an allowlisted session filters out messages whose
 *     `deliveryStatus === "pending"`; messages WITHOUT a deliveryStatus are
 *     excluded (conservative external-trust-boundary default).
 *   - resources/read content is wrapped via wrapExternalContent (markers +
 *     SECURITY NOTICE).
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpResourcesForClient } from "./mcp-server-resources.js";
import type { TokenClient } from "@comis/gateway";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): import("@comis/infra").ComisLogger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as import("@comis/infra").ComisLogger;
}

function makeClient(sessionAllowlist: string[]): TokenClient {
  return {
    id: "test-client",
    scopes: ["mcp-client"],
    mcpClient: {
      allowlist: [],
      sessionAllowlist,
      toolRateLimit: {},
    },
  };
}

interface CapturedResource {
  name: string;
  template: ResourceTemplate;
  config: { description?: string };
  readCallback: (
    uri: URL,
    variables: Record<string, string>,
    extra?: unknown,
  ) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }>;
}

function spyOnRegisterResource(): {
  captured: CapturedResource[];
  restore: () => void;
} {
  const captured: CapturedResource[] = [];
  const spy = vi
    .spyOn(McpServer.prototype, "registerResource")
    .mockImplementation(function mockRegister(
      this: McpServer,
      name: string,
      uriOrTemplate: unknown,
      config: unknown,
      readCallback: unknown,
    ) {
      captured.push({
        name,
        template: uriOrTemplate as ResourceTemplate,
        config: config as { description?: string },
        readCallback: readCallback as CapturedResource["readCallback"],
      });
      return {
        enabled: true,
        enable: () => {},
        disable: () => {},
        update: () => {},
        remove: () => {},
      } as unknown as ReturnType<typeof McpServer.prototype.registerResource>;
    });
  return { captured, restore: () => spy.mockRestore() };
}

function makeMcp(): McpServer {
  return new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: { tools: {}, resources: { subscribe: false } } },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerMcpResourcesForClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registerMcpResourcesForClient resources list with empty sessionAllowlist returns an empty resources array", async () => {
    const client = makeClient([]);
    const rpc = vi.fn(async () => ({ messages: [] }));
    const { captured, restore } = spyOnRegisterResource();
    try {
      registerMcpResourcesForClient(
        makeMcp(),
        { logger: makeLogger(), daemonRpcForMcpClient: rpc, resourceReadLimit: 1000, tenantId: "test", defaultAgentId: "test-agent" },
        client,
      );
      expect(captured.length).toBe(1);
      const template = captured[0]!.template as unknown as { listCallback?: () => Promise<unknown> };
      // SDK's ResourceTemplate exposes the list callback under `listCallback`.
      const listResult = (await template.listCallback!()) as {
        resources: Array<{ uri: string; name: string }>;
      };
      expect(listResult.resources).toEqual([]);
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("registerMcpResourcesForClient resources list enumerates one resource per session in the allowlist", async () => {
    const client = makeClient(["sk-1", "sk-2"]);
    const rpc = vi.fn(async () => ({ messages: [] }));
    const { captured, restore } = spyOnRegisterResource();
    try {
      registerMcpResourcesForClient(
        makeMcp(),
        { logger: makeLogger(), daemonRpcForMcpClient: rpc, resourceReadLimit: 1000, tenantId: "test", defaultAgentId: "test-agent" },
        client,
      );
      const template = captured[0]!.template as unknown as { listCallback?: () => Promise<unknown> };
      const listResult = (await template.listCallback!()) as {
        resources: Array<{ uri: string; name: string }>;
      };
      expect(listResult.resources.length).toBe(2);
      const uris = listResult.resources.map((r) => r.uri).sort();
      expect(uris).toEqual(["comis://session/sk-1", "comis://session/sk-2"]);
    } finally {
      restore();
    }
  });

  it("registerMcpResourcesForClient resources read rejects sessions NOT in the per-client allowlist", async () => {
    const client = makeClient(["sk-allowed"]);
    const rpc = vi.fn(async () => ({ messages: [] }));
    const { captured, restore } = spyOnRegisterResource();
    try {
      registerMcpResourcesForClient(
        makeMcp(),
        { logger: makeLogger(), daemonRpcForMcpClient: rpc, resourceReadLimit: 1000, tenantId: "test", defaultAgentId: "test-agent" },
        client,
      );
      const cb = captured[0]!.readCallback;
      const uri = new URL("comis://session/sk-other");
      await expect(
        cb(uri, { conversationRef: "sk-other" }),
      ).rejects.toThrow(/session_not_allowlisted/);
      // RPC was NEVER called -- the gate fires before dispatch.
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("registerMcpResourcesForClient resources read filters to deliveryStatus confirmed in-flight pending excluded", async () => {
    const client = makeClient(["sk-allowed"]);
    // Mock session.history response: 1 inbound + 1 delivered outbound + 1 in-flight outbound.
    const rpc = vi.fn(async () => ({
      messages: [
        { role: "user", content: "ping", timestamp: 1, deliveryStatus: "confirmed" },
        { role: "assistant", content: "delivered-reply", timestamp: 2, deliveryStatus: "confirmed" },
        { role: "assistant", content: "in-flight-outbound", timestamp: 3, deliveryStatus: "pending" },
      ],
    }));
    const { captured, restore } = spyOnRegisterResource();
    try {
      registerMcpResourcesForClient(
        makeMcp(),
        { logger: makeLogger(), daemonRpcForMcpClient: rpc, resourceReadLimit: 1000, tenantId: "test", defaultAgentId: "test-agent" },
        client,
      );
      const cb = captured[0]!.readCallback;
      const uri = new URL("comis://session/sk-allowed");
      const result = await cb(uri, { conversationRef: "sk-allowed" });
      const text = result.contents[0]!.text ?? "";

      // The two CONFIRMED messages must appear.
      expect(text).toContain("ping");
      expect(text).toContain("delivered-reply");
      // The pending message must NOT appear.
      expect(text).not.toContain("in-flight-outbound");

      // RPC dispatched with the expected method + params.
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0]![0]).toBe("session.history");
      // Session is addressed by explicit authority (tenant_id + agent_id +
      // opaque conversation_ref) — the migrated session.history contract. The
      // allowlist entry / URI variable IS the conversation_ref; tenant + agent
      // come from the daemon identity threaded into the resources deps.
      const params = rpc.mock.calls[0]![1] as Record<string, unknown>;
      expect(params.tenant_id).toBe("test");
      expect(params.agent_id).toBe("test-agent");
      expect(params.conversation_ref).toBe("sk-allowed");
      expect(params).not.toHaveProperty("session_key");
      expect(params.limit).toBe(1000);
    } finally {
      restore();
    }
  });

  // -------------------------------------------------------------------------
  // Conservative default: unknown deliveryStatus excluded
  //
  // The CONFIRMED filter is strict `m.deliveryStatus === "confirmed"` (no
  // nullish coalesce). For the MCP resources/read external trust boundary,
  // ABSENT-FIELD = UNKNOWN, EXCLUDE. Otherwise legacy sessions whose outbound
  // state was never persisted would leak as if confirmed to an external MCP
  // client. The security gate is sessionAllowlist + strict deliveryStatus
  // equality.
  //
  // The internal session.history consumer is unaffected because it runs its
  // own filter pipeline elsewhere.
  // -------------------------------------------------------------------------

  it("registerMcpResourcesForClient resources read excludes messages without a deliveryStatus field", async () => {
    // Legacy sessions store messages without a deliveryStatus field. The
    // conservative external-trust-boundary default is to EXCLUDE them --
    // absence is not equivalent to confirmed.
    const client = makeClient(["sk-allowed"]);
    const rpc = vi.fn(async () => ({
      messages: [
        // Legacy entries without deliveryStatus -- MUST NOT be rendered.
        { role: "user", content: "legacy-no-status-1", timestamp: 1 },
        { role: "assistant", content: "legacy-no-status-2", timestamp: 2 },
        // A confirmed entry alongside -- MUST be rendered.
        {
          role: "assistant",
          content: "confirmed-rendered",
          timestamp: 3,
          deliveryStatus: "confirmed",
        },
      ],
    }));
    const { captured, restore } = spyOnRegisterResource();
    try {
      registerMcpResourcesForClient(
        makeMcp(),
        {
          logger: makeLogger(),
          daemonRpcForMcpClient: rpc,
          resourceReadLimit: 1000,
          tenantId: "test",
          defaultAgentId: "test-agent",
        },
        client,
      );
      const cb = captured[0]!.readCallback;
      const uri = new URL("comis://session/sk-allowed");
      const result = await cb(uri, { conversationRef: "sk-allowed" });
      const text = result.contents[0]!.text ?? "";

      // The strict-equality filter excludes both legacy entries.
      expect(text).not.toContain("legacy-no-status-1");
      expect(text).not.toContain("legacy-no-status-2");
      // The confirmed entry is rendered.
      expect(text).toContain("confirmed-rendered");
    } finally {
      restore();
    }
  });

  it("registerMcpResourcesForClient resources read wraps content via wrapExternalContent markers and SECURITY NOTICE present", async () => {
    const client = makeClient(["sk-allowed"]);
    const rpc = vi.fn(async () => ({
      messages: [
        { role: "user", content: "marker-test-content", timestamp: 1, deliveryStatus: "confirmed" },
      ],
    }));
    const { captured, restore } = spyOnRegisterResource();
    try {
      registerMcpResourcesForClient(
        makeMcp(),
        { logger: makeLogger(), daemonRpcForMcpClient: rpc, resourceReadLimit: 1000, tenantId: "test", defaultAgentId: "test-agent" },
        client,
      );
      const cb = captured[0]!.readCallback;
      const uri = new URL("comis://session/sk-allowed");
      const result = await cb(uri, { conversationRef: "sk-allowed" });
      const text = result.contents[0]!.text ?? "";
      expect(text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
      expect(text).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/);
      expect(text).toContain("SECURITY NOTICE");
      expect(text).toContain("MCP resource content");
      expect(text).toContain("marker-test-content");
    } finally {
      restore();
    }
  });
});
