// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 69 Plan 03 -- buildMcpServerForClient unit tests.
 *
 * Pins the default-deny tools/list filter in isolation:
 *   - `safe` policy → registered regardless of allowlist
 *   - `permission-gated` policy → registered ONLY when allowlist contains
 *     the tool name
 *   - `never-export` policy → SKIPPED
 *   - missing policy (undefined) → SKIPPED (default-deny safety net)
 *
 * The integration test at test/integration/mcp-server-tools-list.test.ts
 * exercises the full Hono + SDK transport path end-to-end; this file pins
 * the factory behavior without a live transport.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  STUB_NOT_IMPLEMENTED_MSG,
  buildMcpServerForClient,
} from "./mcp-server-handlers.js";
import type { TokenClient } from "@comis/gateway";

// ---------------------------------------------------------------------------
// vi.mock @comis/core — stub getAllToolMetadata with a controlled small set
// ---------------------------------------------------------------------------

const stubRegistry = new Map<
  string,
  { mcpExportPolicy?: "safe" | "permission-gated" | "never-export" }
>([
  ["web_search", { mcpExportPolicy: "safe" }],
  ["memory_search", { mcpExportPolicy: "permission-gated" }],
  ["memory_get", { mcpExportPolicy: "permission-gated" }],
  ["tokens_manage", { mcpExportPolicy: "never-export" }],
  ["future_tool_no_policy", {} /* no policy — default-deny safety net */],
]);

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    getAllToolMetadata: () => stubRegistry,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tiny ComisLogger stand-in that captures structured-log call args for
 *  later assertion. Only the methods buildMcpServerForClient actually
 *  invokes are populated (info + child). */
function makeCapturingLogger(): {
  logger: import("@comis/infra").ComisLogger;
  infoCalls: Array<{ obj: Record<string, unknown>; msg: string }>;
} {
  const infoCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const logger = {
    info: vi.fn((obj: Record<string, unknown> | string, msg?: string) => {
      if (typeof obj === "string") {
        infoCalls.push({ obj: {}, msg: obj });
      } else {
        infoCalls.push({ obj, msg: msg ?? "" });
      }
    }),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as import("@comis/infra").ComisLogger;
  return { logger, infoCalls };
}

function makeMcpClient(
  scopes: string[],
  allowlist: string[] = [],
): TokenClient {
  return {
    id: "test-client",
    scopes,
    mcpClient: {
      allowlist,
      sessionAllowlist: [],
      toolRateLimit: {},
    },
  };
}

/**
 * Spy on registerTool to capture the set of tools the factory registers.
 * Calls the real method so the returned McpServer remains valid (the test
 * suite doesn't otherwise interact with it, but defensive).
 */
function spyOnRegisterTool(): {
  registered: Array<string>;
  restore: () => void;
} {
  const registered: string[] = [];
  const spy = vi
    .spyOn(McpServer.prototype, "registerTool")
    .mockImplementation(function mockRegister(
      this: McpServer,
      name: string,
      ..._rest: unknown[]
    ) {
      registered.push(name);
      // Return the minimum-shape RegisteredTool to satisfy the type system.
      return {
        enabled: true,
        enable: () => {},
        disable: () => {},
        update: () => {},
        remove: () => {},
      } as unknown as ReturnType<typeof McpServer.prototype.registerTool>;
    });
  return { registered, restore: () => spy.mockRestore() };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("buildMcpServerForClient -- Phase 69 Plan 03 default-deny tools/list filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------------
  // safe policy
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient registers tools annotated safe regardless of allowlist", () => {
    const { logger, infoCalls } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], /* allowlist */ []);
    const { registered, restore } = spyOnRegisterTool();
    try {
      buildMcpServerForClient(
        { logger, daemonVersion: "0.0.0-test" },
        client,
      );

      expect(registered).toContain("web_search");
      // Logger summary fields prove the same outcome via the structured log.
      const summary = infoCalls.at(-1);
      expect(summary).toBeDefined();
      expect(summary?.obj["registered"]).toBe(1);
      expect(summary?.obj["allowlistSize"]).toBe(0);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // permission-gated policy — allowed
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient registers permission-gated tools only when allowlist includes them", () => {
    const { logger, infoCalls } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["memory_search"]);
    const { registered, restore } = spyOnRegisterTool();
    try {
      buildMcpServerForClient(
        { logger, daemonVersion: "0.0.0-test" },
        client,
      );

      // memory_search is permission-gated AND in the allowlist → registered.
      expect(registered).toContain("memory_search");
      // memory_get is permission-gated but NOT in the allowlist → skipped.
      expect(registered).not.toContain("memory_get");
      // safe tool still present.
      expect(registered).toContain("web_search");

      const summary = infoCalls.at(-1);
      expect(summary?.obj["registered"]).toBe(2); // web_search + memory_search
      expect(summary?.obj["skippedGated"]).toBe(1); // memory_get
      expect(summary?.obj["allowlistSize"]).toBe(1);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // permission-gated policy — denied
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient SKIPS permission-gated tools when the per-client allowlist is empty", () => {
    const { logger, infoCalls } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], /* allowlist */ []);
    const { registered, restore } = spyOnRegisterTool();
    try {
      buildMcpServerForClient(
        { logger, daemonVersion: "0.0.0-test" },
        client,
      );

      // No permission-gated tools registered when allowlist is empty.
      expect(registered).not.toContain("memory_search");
      expect(registered).not.toContain("memory_get");

      const summary = infoCalls.at(-1);
      expect(summary?.obj["skippedGated"]).toBe(2);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // never-export policy
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient SKIPS tools annotated never-export under all allowlist configs", () => {
    const { logger, infoCalls } = makeCapturingLogger();
    // Even when the allowlist explicitly names a never-export tool, the
    // policy gate refuses registration (allowlist applies ONLY to
    // permission-gated, not never-export — never-export is absolute).
    const client = makeMcpClient(["mcp-client"], ["tokens_manage"]);
    const { registered, restore } = spyOnRegisterTool();
    try {
      buildMcpServerForClient(
        { logger, daemonVersion: "0.0.0-test" },
        client,
      );

      expect(registered).not.toContain("tokens_manage");

      const summary = infoCalls.at(-1);
      expect(summary?.obj["skippedNeverExport"]).toBe(1);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // undefined policy (default-deny safety net)
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient SKIPS tools missing mcpExportPolicy default-deny safety net", () => {
    const { logger, infoCalls } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], /* allowlist */ []);
    const { registered, restore } = spyOnRegisterTool();
    try {
      buildMcpServerForClient(
        { logger, daemonVersion: "0.0.0-test" },
        client,
      );

      expect(registered).not.toContain("future_tool_no_policy");

      const summary = infoCalls.at(-1);
      expect(summary?.obj["skippedUndefined"]).toBe(1);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // Token without mcpClient block
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient treats absent mcpClient block as empty allowlist", () => {
    const { logger } = makeCapturingLogger();
    // No `mcpClient` field at all — simulates an mcp-client-scoped token
    // that was issued without the optional config block. Default-deny says
    // permission-gated tools are still NOT exposed.
    const client: TokenClient = { id: "no-block", scopes: ["mcp-client"] };
    const { registered, restore } = spyOnRegisterTool();
    try {
      buildMcpServerForClient(
        { logger, daemonVersion: "0.0.0-test" },
        client,
      );

      expect(registered).toContain("web_search");
      expect(registered).not.toContain("memory_search");
      expect(registered).not.toContain("memory_get");
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // Stub callback shape (Plan 04 replaces with real dispatcher)
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient stub callback message is the plan-04 marker", () => {
    expect(STUB_NOT_IMPLEMENTED_MSG).toContain("Plan 04");
    expect(STUB_NOT_IMPLEMENTED_MSG).toContain("SERVE-07");
  });
});
