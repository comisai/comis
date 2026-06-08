// SPDX-License-Identifier: Apache-2.0
/**
 * buildMcpServerForClient unit tests.
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMcpServerForClient } from "./mcp-server-handlers.js";
import type { TokenClient } from "@comis/gateway";

// ---------------------------------------------------------------------------
// vi.mock @comis/core — stub getAllToolMetadata + getToolMetadata with a
// controlled small set. The live-dispatcher tests need
// getToolMetadata to surface a per-tool validateInput on the
// permission-gated entry to prove the dispatcher runs the validator before
// dispatch.
// ---------------------------------------------------------------------------

type StubMeta = {
  mcpExportPolicy?: "safe" | "permission-gated" | "never-export";
  validateInput?: (
    params: Record<string, unknown>,
  ) => string | undefined | Promise<string | undefined>;
};

const stubRegistry = new Map<string, StubMeta>([
  ["web_search", { mcpExportPolicy: "safe" }],
  [
    "memory_search",
    {
      mcpExportPolicy: "permission-gated",
      // For the dispatcher test, surface a validator that rejects when the
      // caller passes `query === "bad"`. The dispatcher must surface the
      // validator message via MCP `isError: true`.
      validateInput: (params: Record<string, unknown>) => {
        if (params["query"] === "bad") {
          return "query must not be the literal string 'bad'";
        }
        return undefined;
      },
    },
  ],
  ["memory_get", { mcpExportPolicy: "permission-gated" }],
  // obs_explain (154-03): permission-gated. Its dispatch branch invokes the
  // INJECTED obsExplainForMcpClient assembler DIRECTLY (NOT daemonRpcForMcpClient)
  // and feeds the result into the SAME wrapExternalContent wrap.
  ["obs_explain", { mcpExportPolicy: "permission-gated" }],
  // obs_fleet_health (161-02): permission-gated SIBLING of obs_explain. Its
  // dispatch branch invokes the INJECTED obsFleetHealthForMcpClient assembler
  // DIRECTLY (NOT daemonRpcForMcpClient), never injecting admin, and feeds the
  // result into the SAME wrapExternalContent wrap.
  ["obs_fleet_health", { mcpExportPolicy: "permission-gated" }],
  ["tokens_manage", { mcpExportPolicy: "never-export" }],
  ["future_tool_no_policy", {} /* no policy — default-deny safety net */],
]);

// Track systemSetInterval invocations so a test can verify
// _resetRateLimitStateForTest re-enables pruner registration. Hoisted to
// the same scope as `vi.mock("@comis/core", ...)` so the spy is initialized
// BEFORE the hoisted mock factory references it (Vitest hoists vi.mock to
// the top of the file; bare `const` declarations are evaluated AFTER and
// therefore not visible inside the factory). `vi.hoisted` is the supported
// pattern.
const { systemSetIntervalSpy } = vi.hoisted(() => ({
  systemSetIntervalSpy: vi.fn((_cb: () => void, _ms: number) => {
    // ensurePrunerStarted calls .unref() on the returned handle.
    return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
  }),
}));

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    getAllToolMetadata: () => stubRegistry,
    getToolMetadata: (name: string) => stubRegistry.get(name),
    // Track pruner registration so a test can verify re-registration
    // after `_resetRateLimitStateForTest()`.
    systemSetInterval: systemSetIntervalSpy,
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

describe("buildMcpServerForClient -- default-deny tools/list filter", () => {
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
      // obs_explain is permission-gated but NOT in the allowlist → skipped.
      expect(registered).not.toContain("obs_explain");
      // obs_fleet_health is permission-gated but NOT in the allowlist → skipped.
      expect(registered).not.toContain("obs_fleet_health");
      // safe tool still present.
      expect(registered).toContain("web_search");

      const summary = infoCalls.at(-1);
      expect(summary?.obj["registered"]).toBe(2); // web_search + memory_search
      expect(summary?.obj["skippedGated"]).toBe(3); // memory_get + obs_explain + obs_fleet_health
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
      expect(registered).not.toContain("obs_explain");
      expect(registered).not.toContain("obs_fleet_health");

      const summary = infoCalls.at(-1);
      expect(summary?.obj["skippedGated"]).toBe(4); // memory_search + memory_get + obs_explain + obs_fleet_health
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

});

// ===========================================================================
// Live tools/call dispatcher tests
// ===========================================================================
//
// These tests pin the five-step pipeline:
//   1. Live policy re-check (defense-in-depth -- never-export rejected)
//   2. Per-client allowlist enforced at dispatch time
//   3. Per-client per-tool rate limit (default + per-client override)
//   4. Per-tool validateInput runs before dispatch
//   5. Dispatch through daemonRpcForMcpClient (NEVER injects _trustLevel:"admin")
//   6. Output wrapped via wrapExternalContent
// ===========================================================================

/** Capture every (method, params) pair daemonRpcForMcpClient was called with. */
interface RpcRecorder {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }>;
  readonly fn: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

function makeRpcRecorder(
  returnValue: unknown = { hits: [{ id: "1", text: "fixture hit" }] },
): RpcRecorder {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    fn: async (method, params) => {
      calls.push({ method, params });
      return returnValue;
    },
  };
}

/** Identity mapping (default: MCP tool name == RPC method name). */
const identityToolNameToRpcMethod = (name: string) => name;

/** Memory_search mapping (the canonical real-world mapping in Comis). */
const memorySearchMapping = (name: string) => {
  if (name === "memory_search") return "memory.search_files";
  return name;
};

describe("buildMcpServerForClient -- live tools/call dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ------------------------------------------------------------------------
  // Trust-flag isolation
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch NEVER injects _trustLevel admin in the rpc params", async () => {
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["memory_search"]);
    const rpc = makeRpcRecorder();

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: memorySearchMapping,
        },
        client,
      );

      // Invoke the callback registered for memory_search.
      const cb = capturedCallback["memory_search"];
      expect(cb).toBeDefined();

      // Even when a hostile caller passes _trustLevel in the args, the
      // dispatcher MUST NOT pass it through to daemonRpcForMcpClient. The
      // indirection is the trust-flag isolation point.
      const result = (await cb!({
        query: "anything",
        _trustLevel: "admin",
      })) as { isError?: boolean; content?: unknown };

      expect(result.isError ?? false).toBe(false);
      expect(rpc.calls.length).toBe(1);
      const dispatchedParams = rpc.calls[0]!.params;
      expect(dispatchedParams).not.toHaveProperty("_trustLevel");
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // Live policy re-check (never-export rejected even if somehow registered)
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch rejects a never-export tool with policy_violation isError", async () => {
    // To reach this test path we have to register a tool that the live
    // policy re-check should reject. We do this by mutating the stubRegistry
    // to flip memory_get's policy to "never-export" AFTER registration.
    // (The registration filter sees "permission-gated" at registration; the
    // dispatcher's live re-read sees "never-export" -- a different value at
    // dispatch time. The re-check is the belt-and-suspenders defense.)
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["memory_get"]);
    const rpc = makeRpcRecorder();

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: identityToolNameToRpcMethod,
        },
        client,
      );

      const cb = capturedCallback["memory_get"];
      expect(cb).toBeDefined();

      // Mutate the registry post-registration so the live re-check fires.
      const originalMeta = stubRegistry.get("memory_get")!;
      stubRegistry.set("memory_get", {
        ...originalMeta,
        mcpExportPolicy: "never-export",
      });
      try {
        const result = (await cb!({})) as {
          isError?: boolean;
          content?: Array<{ text?: string }>;
        };
        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text).toContain("policy_violation");
        expect(rpc.calls.length).toBe(0); // never reached the dispatch step
      } finally {
        // Restore registry for downstream tests.
        stubRegistry.set("memory_get", originalMeta);
      }
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // Rate limit -- per-client per-tool 30/min default
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch returns rate_limit_exceeded after the per-client per-tool ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_715_000_000_000);

    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["memory_search"]);
    const rpc = makeRpcRecorder();

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 3, // small ceiling for the test
          toolNameToRpcMethod: memorySearchMapping,
        },
        client,
      );

      const cb = capturedCallback["memory_search"]!;
      // 3 allowed
      const r1 = (await cb({ query: "ok" })) as { isError?: boolean };
      const r2 = (await cb({ query: "ok" })) as { isError?: boolean };
      const r3 = (await cb({ query: "ok" })) as { isError?: boolean };
      expect(r1.isError ?? false).toBe(false);
      expect(r2.isError ?? false).toBe(false);
      expect(r3.isError ?? false).toBe(false);

      // 4th rejected with rate-limit isError
      const r4 = (await cb({ query: "ok" })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      expect(r4.isError).toBe(true);
      expect(r4.content?.[0]?.text).toContain("rate_limit_exceeded");
      expect(r4.content?.[0]?.text).toContain("resetAt=");

      // Underlying RPC was called only 3 times.
      expect(rpc.calls.length).toBe(3);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // Per-client rate-limit override via mcpClient.toolRateLimit
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch honors per-client toolRateLimit override", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_715_000_000_000);

    const { logger } = makeCapturingLogger();
    // Allowlist memory_search; override its ceiling to 5 (vs default 3).
    const client: TokenClient = {
      id: "client-with-override",
      scopes: ["mcp-client"],
      mcpClient: {
        allowlist: ["memory_search"],
        sessionAllowlist: [],
        toolRateLimit: { memory_search: 5 },
      },
    };
    const rpc = makeRpcRecorder();

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 3,
          toolNameToRpcMethod: memorySearchMapping,
        },
        client,
      );

      const cb = capturedCallback["memory_search"]!;
      // 5 allowed (override wins over default 3).
      for (let i = 0; i < 5; i++) {
        const r = (await cb({ query: `q${i}` })) as { isError?: boolean };
        expect(r.isError ?? false).toBe(false);
      }
      const blocked = (await cb({ query: "q5" })) as { isError?: boolean };
      expect(blocked.isError).toBe(true);
      expect(rpc.calls.length).toBe(5);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // validateInput failure surfaces as MCP isError
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch surfaces per-tool validateInput rejection as isError true", async () => {
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["memory_search"]);
    const rpc = makeRpcRecorder();

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: memorySearchMapping,
        },
        client,
      );

      const cb = capturedCallback["memory_search"]!;
      // The stub validator at line 35-42 rejects `query === "bad"`.
      const r = (await cb({ query: "bad" })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      expect(r.isError).toBe(true);
      expect(r.content?.[0]?.text).toContain("invalid_args");
      expect(r.content?.[0]?.text).toContain("must not be");
      // The validator rejected before dispatch -- RPC was NOT called.
      expect(rpc.calls.length).toBe(0);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // Happy path -- output wrapped via wrapExternalContent
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch wraps the rpc result via wrapExternalContent for prompt-injection defense-in-depth", async () => {
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["memory_search"]);
    const rpc = makeRpcRecorder({ hits: [{ id: "1", text: "alpha" }] });

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: memorySearchMapping,
        },
        client,
      );

      const cb = capturedCallback["memory_search"]!;
      const r = (await cb({ query: "alpha" })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
      expect(r.isError ?? false).toBe(false);
      expect(r.content?.length).toBeGreaterThan(0);
      const text = r.content?.[0]?.text ?? "";
      // The wrapExternalContent helper from @comis/core surrounds the
      // payload with `<<<UNTRUSTED_…>>>` markers and a SECURITY NOTICE.
      expect(text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
      expect(text).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/);
      expect(text).toContain("SECURITY NOTICE");
      // The original payload survives between the markers.
      expect(text).toContain("alpha");
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // Bucket-isolation across clients (security regression guard)
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch buckets are isolated per client -- one client saturating does not affect another", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_715_000_000_000);

    const { logger } = makeCapturingLogger();
    const clientA = makeMcpClient(["mcp-client"], ["memory_search"]);
    const clientB: TokenClient = {
      ...makeMcpClient(["mcp-client"], ["memory_search"]),
      id: "client-b",
    };
    const rpc = makeRpcRecorder();

    const { capturedCallback: cbsA, restore: restoreA } =
      captureRegisteredCallback();
    buildMcpServerForClient(
      {
        logger,
        daemonVersion: "0.0.0-test",
        daemonRpcForMcpClient: rpc.fn,
        defaultToolRateLimit: 2,
        toolNameToRpcMethod: memorySearchMapping,
      },
      clientA,
    );
    const cbA = cbsA["memory_search"]!;
    restoreA();

    const { capturedCallback: cbsB, restore: restoreB } =
      captureRegisteredCallback();
    buildMcpServerForClient(
      {
        logger,
        daemonVersion: "0.0.0-test",
        daemonRpcForMcpClient: rpc.fn,
        defaultToolRateLimit: 2,
        toolNameToRpcMethod: memorySearchMapping,
      },
      clientB,
    );
    const cbB = cbsB["memory_search"]!;
    restoreB();

    // Saturate client A
    expect(((await cbA({ query: "q" })) as { isError?: boolean }).isError ?? false).toBe(false);
    expect(((await cbA({ query: "q" })) as { isError?: boolean }).isError ?? false).toBe(false);
    expect(((await cbA({ query: "q" })) as { isError?: boolean }).isError).toBe(true);

    // Client B still has full headroom
    expect(((await cbB({ query: "q" })) as { isError?: boolean }).isError ?? false).toBe(false);
    expect(((await cbB({ query: "q" })) as { isError?: boolean }).isError ?? false).toBe(false);
    expect(((await cbB({ query: "q" })) as { isError?: boolean }).isError).toBe(true);
  });

  // ------------------------------------------------------------------------
  // safeStringify(undefined) info leak guard
  //
  // When the underlying RPC handler resolves to `undefined` (a legal value
  // for the Promise<unknown> return type of daemonRpcForMcpClient), the
  // dispatcher MUST NOT propagate the JavaScript `undefined` value into
  // wrapExternalContent. JSON.stringify(undefined) returns the value
  // `undefined`, not the string `"null"`, so a naive
  // `safeStringify(v) -> JSON.stringify(v)` returns `undefined` (the value)
  // -- and the `string` return type is a lie. Passing undefined to
  // wrapExternalContent triggers String.prototype.replace on undefined ->
  // TypeError; the SDK catches it and surfaces the raw TypeError message
  // verbatim to the external MCP client (information disclosure).
  //
  // Required invariants:
  //   - rpcResult === undefined produces a wrapped response (no throw, no
  //     isError) containing an empty/safe payload between the markers.
  //   - The output is still a non-empty string (markers + SECURITY NOTICE).
  //   - The output does NOT contain the literal text "TypeError" or "Cannot
  //     read properties of undefined" (which would indicate the bug leaked).
  // ------------------------------------------------------------------------

  // ------------------------------------------------------------------------
  // Raw daemon RPC error message leak guard
  //
  // Previously the dispatcher returned `[dispatch_error] ${err.message}` --
  // exposing whatever the daemon RPC handler threw (session keys, user
  // IDs, internal hints, file paths). The WS RPC path emits a generic
  // "Internal error" message for uncaught errors (ws-handler.ts:384) --
  // mirror that posture on the MCP boundary.
  //
  // Required invariants:
  //   - Dispatch errors return isError:true with a GENERIC message
  //     including the toolName + clientId (a correlation handle the
  //     operator can grep against Pino logs).
  //   - The raw err.message text must NOT appear in the MCP response.
  //   - The structured WARN log still carries `err` so server-side
  //     debugging is intact.
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch wraps daemon RPC errors in a generic response that hides internal detail", async () => {
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["memory_search"]);

    // Simulate a daemon RPC handler that throws a message containing a
    // session key + tenant ID -- typical of "Session not found" errors
    // from session.history and friends.
    const secretMessage =
      "Session not found: tenant-abc:user-123:channel-456. Available session keys: a,b,c";
    const rpc: RpcRecorder = {
      calls: [],
      fn: async () => {
        throw new Error(secretMessage);
      },
    };

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: memorySearchMapping,
        },
        client,
      );

      const cb = capturedCallback["memory_search"]!;
      const r = (await cb({ query: "ok" })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
      expect(r.isError).toBe(true);
      const text = r.content?.[0]?.text ?? "";

      // The MCP response must NOT carry the raw internal message.
      expect(text).not.toContain("tenant-abc");
      expect(text).not.toContain("user-123");
      expect(text).not.toContain("channel-456");
      expect(text).not.toContain("Available session keys");
      expect(text).not.toContain(secretMessage);

      // It SHOULD include the dispatch_error sentinel + correlation
      // handles (toolName + clientId) so an operator can grep logs.
      expect(text).toContain("[dispatch_error]");
      expect(text).toContain("memory_search");
      expect(text).toContain("test-client");
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // Validator-threw path also leaks raw error detail
  //
  // The `[invalid_args] validator threw: ${msg}` branch surfaced the raw
  // thrown message verbatim. Same posture as the dispatch_error branch:
  // sanitize the on-wire payload, keep the structured WARN log.
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch sanitizes validator-throw error responses", async () => {
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["memory_search"]);
    const rpc = makeRpcRecorder();

    // Override stubRegistry.memory_search to throw from validateInput.
    const secret = "tenant-internal-data: 0xCAFEBABE";
    const originalMeta = stubRegistry.get("memory_search")!;
    stubRegistry.set("memory_search", {
      ...originalMeta,
      validateInput: () => {
        throw new Error(secret);
      },
    });

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: memorySearchMapping,
        },
        client,
      );

      const cb = capturedCallback["memory_search"]!;
      const r = (await cb({ query: "ok" })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
      expect(r.isError).toBe(true);
      const text = r.content?.[0]?.text ?? "";

      expect(text).not.toContain("tenant-internal-data");
      expect(text).not.toContain("0xCAFEBABE");
      expect(text).not.toContain(secret);
      // The validator never even reached dispatch -- RPC was not called.
      expect(rpc.calls.length).toBe(0);
      // The sanitized response retains the invalid_args sentinel + the
      // toolName for correlation but nothing else.
      expect(text).toContain("[invalid_args]");
      expect(text).toContain("memory_search");
    } finally {
      // Restore stub for other tests.
      stubRegistry.set("memory_search", originalMeta);
      restore();
    }
  });

  it("buildMcpServerForClient dispatch does not throw when daemon RPC returns undefined (info leak guard)", async () => {
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["memory_search"]);

    // The RPC handler resolves to `undefined` -- a legal value for the
    // Promise<unknown> indirection but the value `safeStringify` mishandled.
    // NOTE: don't use makeRpcRecorder() with undefined -- the default
    // parameter substitutes the fallback object. Build the recorder
    // directly so the captured returnValue stays literally `undefined`.
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc: RpcRecorder = {
      calls,
      fn: async (method, params) => {
        calls.push({ method, params });
        return undefined; // <-- the bug-triggering value
      },
    };

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: memorySearchMapping,
        },
        client,
      );

      const cb = capturedCallback["memory_search"]!;
      // The dispatcher must NOT throw. On the pre-fix code, await cb(...)
      // rejects with TypeError: Cannot read properties of undefined
      // (reading 'replace') inside wrapExternalContent's replaceMarkers.
      // The SDK then catches and surfaces the raw message to the external
      // MCP client (information disclosure).
      const r = (await cb({ query: "ok" })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };

      // Sanity: the RPC was actually called with our undefined-returning fn.
      expect(rpc.calls.length).toBe(1);
      // The response is a happy-path wrap (NOT an isError).
      expect(r.isError ?? false).toBe(false);
      // The response carries content wrapped with the markers.
      expect(r.content?.length).toBeGreaterThan(0);
      const text = r.content?.[0]?.text ?? "";
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      // The wrapped output carries the standard markers + SECURITY NOTICE.
      expect(text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
      expect(text).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/);
      // The TypeError message MUST NOT leak to the external MCP client.
      expect(text).not.toContain("TypeError");
      expect(text).not.toContain("Cannot read properties of undefined");
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // obs_explain (154-03) — direct-assembler dispatch under daemon authority
  //
  // The SECURITY-CRITICAL path: obs_explain reaches the Phase-153 IncidentReport
  // over POST /mcp/v1 with NO new privilege. Its dispatch branch invokes the
  // INJECTED obsExplainForMcpClient assembler DIRECTLY (NOT daemonRpcForMcpClient
  // -> the admin-gated obs.explain RPC, NOT a trust-isolated indirection) and feeds the result
  // into the SAME Step-5 wrapExternalContent wrap. Authorization is the
  // per-client mcpClient.allowlist + the digest-only/bounded report.
  //
  // Required invariants:
  //   - ALLOWLISTED: obsExplainForMcpClient called with params that DO NOT
  //     contain _trustLevel (stripTrustLevel ran); daemonRpcForMcpClient NOT
  //     called for obs_explain; result wrapped with the SECURITY NOTICE marker.
  //   - NOT ALLOWLISTED: obs_explain is not registered (default-deny) — the
  //     callback is absent, i.e. unreachable without the operator allowlist.
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient obs_explain dispatch invokes the direct assembler (NOT daemonRpcForMcpClient) and strips _trustLevel", async () => {
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["obs_explain"]);
    const rpc = makeRpcRecorder();

    // The injected assembler — a stand-in for the production
    // assembleIncidentReportFromSources closure. Records its params so we can
    // prove _trustLevel was stripped before it ran.
    const assemblerCalls: Array<Record<string, unknown>> = [];
    const obsExplainForMcpClient = vi.fn(
      async (params: Record<string, unknown>) => {
        assemblerCalls.push(params);
        return {
          sessionKey: "k",
          likelyRootCause: { code: "content_heuristic_misclassification" },
          outcome: { degraded: true },
        };
      },
    );

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: identityToolNameToRpcMethod,
          obsExplainForMcpClient,
        },
        client,
      );

      const cb = capturedCallback["obs_explain"];
      expect(cb).toBeDefined();

      // A hostile caller smuggles _trustLevel:"admin" in the args. The
      // dispatcher MUST strip it before invoking the assembler (no admin path).
      const r = (await cb!({
        sessionKey: "k",
        _trustLevel: "admin",
      })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };

      // (a) the assembler ran with _trustLevel stripped.
      expect(obsExplainForMcpClient).toHaveBeenCalledTimes(1);
      expect(assemblerCalls.length).toBe(1);
      expect(assemblerCalls[0]).not.toHaveProperty("_trustLevel");
      expect(assemblerCalls[0]).toMatchObject({ sessionKey: "k" });

      // (b) obs_explain did NOT route through the daemonRpcForMcpClient indirection.
      expect(rpc.calls.length).toBe(0);

      // (c) the result flowed through wrapExternalContent (SECURITY NOTICE +
      // hex markers) — the digest-only report is treated as untrusted data.
      expect(r.isError ?? false).toBe(false);
      const text = r.content?.[0]?.text ?? "";
      expect(text).toContain("SECURITY NOTICE");
      expect(text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
      expect(text).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/);
      // The report payload survives between the markers.
      expect(text).toContain("content_heuristic_misclassification");
    } finally {
      restore();
    }
  });

  it("buildMcpServerForClient obs_explain is UNREACHABLE for a client without it allowlisted (permission-gated default-deny)", async () => {
    const { logger } = makeCapturingLogger();
    // Empty allowlist — obs_explain is permission-gated, so it must NOT be
    // registered. The allowlist IS the granted permission; without it there is
    // no obs_explain callback to invoke (no new privilege).
    const client = makeMcpClient(["mcp-client"], /* allowlist */ []);
    const rpc = makeRpcRecorder();
    const obsExplainForMcpClient = vi.fn(async () => ({ sessionKey: "k" }));

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: identityToolNameToRpcMethod,
          obsExplainForMcpClient,
        },
        client,
      );

      // obs_explain was never registered → no callback → unreachable.
      expect(capturedCallback["obs_explain"]).toBeUndefined();
      // And the assembler was never invoked.
      expect(obsExplainForMcpClient).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("buildMcpServerForClient obs_explain fails closed (dispatch_error, no crash) when obsExplainForMcpClient is unwired", async () => {
    // Defense-in-depth: an obsStore-less boot / wiring gap leaves
    // obsExplainForMcpClient undefined. The dispatch branch must return a
    // generic dispatch_error sentinel (NOT throw, NOT leak), and MUST NOT fall
    // through to daemonRpcForMcpClient (which would hit the admin-gated RPC).
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["obs_explain"]);
    const rpc = makeRpcRecorder();

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: identityToolNameToRpcMethod,
          // obsExplainForMcpClient intentionally omitted (unwired).
        },
        client,
      );

      const cb = capturedCallback["obs_explain"];
      expect(cb).toBeDefined();
      const r = (await cb!({ sessionKey: "k" })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
      expect(r.isError).toBe(true);
      const text = r.content?.[0]?.text ?? "";
      expect(text).toContain("[dispatch_error]");
      // It did NOT fall back to the daemonRpcForMcpClient indirection.
      expect(rpc.calls.length).toBe(0);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------------
  // obs_fleet_health (161-02) — direct-assembler dispatch under daemon authority
  //
  // The SECURITY-CRITICAL fleet sibling of obs_explain. Its dispatch branch
  // invokes the INJECTED obsFleetHealthForMcpClient assembler DIRECTLY (NOT
  // daemonRpcForMcpClient -> the admin-gated obs.fleet.health RPC) and feeds the
  // result into the SAME Step-5 wrapExternalContent wrap. Authorization is the
  // per-client mcpClient.allowlist + the digest-only/bounded report.
  //
  // Required invariants (H1-MCP):
  //   - never-inject-admin: obsFleetHealthForMcpClient called with params that
  //     DO NOT contain _trustLevel (stripTrustLevel ran); the result is wrapped.
  //   - fail-closed: undefined closure -> generic dispatch_error, no crash, no
  //     fall-through to the admin RPC indirection.
  //   - error-opacity: a throwing closure -> generic dispatch_error with NO raw
  //     err.message (no sessionKey/path leak).
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient obs_fleet_health dispatch invokes the direct assembler (NOT daemonRpcForMcpClient), strips _trustLevel, and wraps the result", async () => {
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["obs_fleet_health"]);
    const rpc = makeRpcRecorder();

    // The injected assembler — a stand-in for the production
    // assembleFleetHealthReport closure. Records its params so we can prove
    // _trustLevel was stripped before it ran.
    const assemblerCalls: Array<Record<string, unknown>> = [];
    const obsFleetHealthForMcpClient = vi.fn(
      async (params: Record<string, unknown>) => {
        assemblerCalls.push(params);
        return {
          windowHours: 6,
          likelyRootCause: { code: "fleet_high_degraded_rate" },
          sessions: { total: 3, degraded: 2, degradedRate: 0.66 },
        };
      },
    );

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: identityToolNameToRpcMethod,
          obsFleetHealthForMcpClient,
        },
        client,
      );

      const cb = capturedCallback["obs_fleet_health"];
      expect(cb).toBeDefined();

      // A hostile caller smuggles _trustLevel:"admin" in the args. The
      // dispatcher MUST strip it before invoking the assembler (no admin path).
      const r = (await cb!({
        sinceHours: 6,
        _trustLevel: "admin",
      })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };

      // (a) the assembler ran with _trustLevel stripped.
      expect(obsFleetHealthForMcpClient).toHaveBeenCalledTimes(1);
      expect(assemblerCalls.length).toBe(1);
      expect(assemblerCalls[0]).not.toHaveProperty("_trustLevel");
      expect(assemblerCalls[0]).toMatchObject({ sinceHours: 6 });

      // (b) obs_fleet_health did NOT route through daemonRpcForMcpClient.
      expect(rpc.calls.length).toBe(0);

      // (c) the result flowed through wrapExternalContent (SECURITY NOTICE +
      // hex markers) — the digest-only report is treated as untrusted data.
      expect(r.isError ?? false).toBe(false);
      const text = r.content?.[0]?.text ?? "";
      expect(text).toContain("SECURITY NOTICE");
      expect(text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
      expect(text).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/);
      // The report payload survives between the markers.
      expect(text).toContain("fleet_high_degraded_rate");
    } finally {
      restore();
    }
  });

  it("buildMcpServerForClient obs_fleet_health fails closed (dispatch_error, no crash) when obsFleetHealthForMcpClient is unwired", async () => {
    // Defense-in-depth: an obsStore-less boot / wiring gap leaves the closure
    // undefined. The dispatch branch must return a generic dispatch_error
    // sentinel (NOT throw, NOT leak), and MUST NOT fall through to
    // daemonRpcForMcpClient (which would hit the admin-gated RPC).
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["obs_fleet_health"]);
    const rpc = makeRpcRecorder();

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: identityToolNameToRpcMethod,
          // obsFleetHealthForMcpClient intentionally omitted (unwired).
        },
        client,
      );

      const cb = capturedCallback["obs_fleet_health"];
      expect(cb).toBeDefined();
      const r = (await cb!({ sinceHours: 24 })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
      expect(r.isError).toBe(true);
      const text = r.content?.[0]?.text ?? "";
      expect(text).toContain("[dispatch_error]");
      // It did NOT fall back to the daemonRpcForMcpClient indirection.
      expect(rpc.calls.length).toBe(0);
    } finally {
      restore();
    }
  });

  it("buildMcpServerForClient obs_fleet_health returns a generic dispatch_error (no raw err.message leak) when the assembler throws", async () => {
    // Error-opacity (T-161-08): a throwing assembler must NOT surface its raw
    // message (it can carry sessionKeys/file paths). The on-wire response is a
    // generic sentinel; the structured err is captured on the WARN log only.
    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], ["obs_fleet_health"]);
    const rpc = makeRpcRecorder();

    const leakyMessage = "sessionKey /Users/secret/.comis/x leak";
    const obsFleetHealthForMcpClient = vi.fn(async () => {
      throw new Error(leakyMessage);
    });

    const { capturedCallback, restore } = captureRegisteredCallback();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: identityToolNameToRpcMethod,
          obsFleetHealthForMcpClient,
        },
        client,
      );

      const cb = capturedCallback["obs_fleet_health"];
      expect(cb).toBeDefined();
      const r = (await cb!({ sinceHours: 24 })) as {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
      expect(r.isError).toBe(true);
      const text = r.content?.[0]?.text ?? "";
      expect(text).toContain("[dispatch_error]");
      // The raw err.message (path/sessionKey) must NOT leak on the wire.
      expect(text).not.toContain(leakyMessage);
      expect(text).not.toContain("/Users/secret");
      // It did NOT fall back to the daemonRpcForMcpClient indirection.
      expect(rpc.calls.length).toBe(0);
    } finally {
      restore();
    }
  });
});

// ===========================================================================
// _resetRateLimitStateForTest must reset prunerStarted
//
// `prunerStarted` is a module-level boolean that gates `systemSetInterval`
// registration. After the first `buildMcpServerForClient` call in any test
// suite, it is `true` for the module's lifetime. Without resetting it, a
// later test cannot reproduce the "pruner has not yet started" state -- the
// interval is already running, and the registration call (`systemSetInterval`)
// has been made exactly once for the module's lifetime.
//
// Criterion: after one `buildMcpServerForClient` call, then
// `_resetRateLimitStateForTest()`, then a second build, the
// `systemSetInterval` mock must have been called TWICE. On the pre-fix code
// it is called only once (the second build hits the `if (prunerStarted)
// return;` short-circuit).
//
// The @comis/core mock at top-of-file is augmented here for this single
// test by spreading `systemSetInterval: vi.fn(...)` into the returned
// namespace. Doing it INSIDE a `vi.doMock` is awkward because the import
// is hoisted; we instead bind a module-level spy via vi.mock at module
// level then reach into it from this suite.
// ===========================================================================

describe("buildMcpServerForClient -- _resetRateLimitStateForTest also resets prunerStarted", () => {
  it("_resetRateLimitStateForTest re-enables re-registration of the pruner interval", async () => {
    const { _resetRateLimitStateForTest } = await import(
      "./mcp-server-handlers.js"
    );
    // Start from a known state: clear the spy + reset module state.
    systemSetIntervalSpy.mockClear();
    _resetRateLimitStateForTest();

    const { logger } = makeCapturingLogger();
    const client = makeMcpClient(["mcp-client"], []);
    const rpc = makeRpcRecorder();

    // First build -- with prunerStarted reset to false, ensurePrunerStarted
    // calls systemSetInterval once.
    const { restore: restore1 } = spyOnRegisterTool();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: identityToolNameToRpcMethod,
        },
        client,
      );
    } finally {
      restore1();
    }
    expect(systemSetIntervalSpy).toHaveBeenCalledTimes(1);

    // Reset state again. On the pre-fix code this clears buckets but
    // leaves prunerStarted=true; on the post-fix code prunerStarted is
    // reset to false.
    _resetRateLimitStateForTest();

    // Second build after reset. On the pre-fix code, ensurePrunerStarted
    // short-circuits because prunerStarted is still true -> spy stays at
    // 1 call. On the post-fix code, the spy fires again -> 2 calls.
    const { restore: restore2 } = spyOnRegisterTool();
    try {
      buildMcpServerForClient(
        {
          logger,
          daemonVersion: "0.0.0-test",
          daemonRpcForMcpClient: rpc.fn,
          defaultToolRateLimit: 30,
          toolNameToRpcMethod: identityToolNameToRpcMethod,
        },
        client,
      );
    } finally {
      restore2();
    }
    expect(systemSetIntervalSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Helper: capture the per-tool callback the factory registers, indexed by
// tool name. We replace registerTool's mock to store both the name and the
// callback so each test can invoke the callback directly without spinning up
// the SDK transport.
// ---------------------------------------------------------------------------

function captureRegisteredCallback(): {
  capturedCallback: Record<
    string,
    (
      args: Record<string, unknown>,
    ) => Promise<{
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    }>
  >;
  restore: () => void;
} {
  const capturedCallback: Record<
    string,
    (
      args: Record<string, unknown>,
    ) => Promise<{
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    }>
  > = {};
  const spy = vi
    .spyOn(McpServer.prototype, "registerTool")
    .mockImplementation(function mockRegister(
      this: McpServer,
      name: string,
      _config: unknown,
      cb: unknown,
    ) {
      capturedCallback[name] = cb as (
        args: Record<string, unknown>,
      ) => Promise<{
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      }>;
      return {
        enabled: true,
        enable: () => {},
        disable: () => {},
        update: () => {},
        remove: () => {},
      } as unknown as ReturnType<typeof McpServer.prototype.registerTool>;
    });
  return { capturedCallback, restore: () => spy.mockRestore() };
}
