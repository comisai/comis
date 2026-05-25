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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMcpServerForClient } from "./mcp-server-handlers.js";
import type { TokenClient } from "@comis/gateway";

// ---------------------------------------------------------------------------
// vi.mock @comis/core — stub getAllToolMetadata + getToolMetadata with a
// controlled small set. The live-dispatcher tests (Plan 04) need
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
  ["tokens_manage", { mcpExportPolicy: "never-export" }],
  ["future_tool_no_policy", {} /* no policy — default-deny safety net */],
]);

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    getAllToolMetadata: () => stubRegistry,
    getToolMetadata: (name: string) => stubRegistry.get(name),
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

});

// ===========================================================================
// Plan 04 -- live tools/call dispatcher tests
// ===========================================================================
//
// These tests pin the five-step pipeline:
//   1. Live policy re-check (defense-in-depth -- never-export rejected)
//   2. Per-client allowlist enforced at dispatch time
//   3. Per-client per-tool rate limit (default + per-client override)
//   4. Per-tool validateInput runs before dispatch
//   5. Dispatch through daemonRpcForMcpClient (NEVER injects _trustLevel:"admin")
//   6. Output wrapped via wrapExternalContent
//
// The RED state of this file (before mcp-server-handlers.ts ships the live
// dispatcher) will fail on the new BuildMcpServerForClientDeps signature
// (TS-error -- the factory does not accept daemonRpcForMcpClient yet) and
// on the stubCallback's `isError:true` return that every assertion below
// expects to be `isError:false`.
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

describe("buildMcpServerForClient -- Phase 69 Plan 04 live tools/call dispatcher", () => {
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
    // (The Plan 03 filter sees "permission-gated" at registration; the
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
  // Phase 69 CR-01 -- safeStringify(undefined) info leak
  //
  // RED test pinning the fix: when the underlying RPC handler resolves to
  // `undefined` (a legal value for the Promise<unknown> return type of
  // daemonRpcForMcpClient), the dispatcher MUST NOT propagate the JavaScript
  // `undefined` value into wrapExternalContent. JSON.stringify(undefined)
  // returns the value `undefined`, not the string `"null"`, so a naive
  // `safeStringify(v) -> JSON.stringify(v)` returns `undefined` (the value)
  // -- and the `string` return type is a lie. Passing undefined to
  // wrapExternalContent triggers String.prototype.replace on undefined ->
  // TypeError; the SDK catches it and surfaces the raw TypeError message
  // verbatim to the external MCP client (information disclosure).
  //
  // Post-fix invariants:
  //   - rpcResult === undefined produces a wrapped response (no throw, no
  //     isError) containing an empty/safe payload between the markers.
  //   - The output is still a non-empty string (markers + SECURITY NOTICE).
  //   - The output does NOT contain the literal text "TypeError" or "Cannot
  //     read properties of undefined" (which would indicate the bug leaked).
  // ------------------------------------------------------------------------

  // ------------------------------------------------------------------------
  // Phase 69 WR-02 -- raw daemon RPC error message leaks to MCP client
  //
  // The pre-fix dispatcher returned `[dispatch_error] ${err.message}` --
  // exposing whatever the daemon RPC handler threw (session keys, user
  // IDs, internal hints, file paths). The WS RPC path emits a generic
  // "Internal error" message for uncaught errors (ws-handler.ts:384) --
  // mirror that posture on the MCP boundary.
  //
  // Post-fix invariants:
  //   - Dispatch errors return isError:true with a GENERIC message
  //     including the toolName + clientId (a correlation handle the
  //     operator can grep against Pino logs).
  //   - The raw err.message text must NOT appear in the MCP response.
  //   - The structured WARN log still carries `err` so server-side
  //     debugging is intact.
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch wraps daemon RPC errors in a generic response that hides internal detail WR-02", async () => {
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
  // Phase 69 WR-02 -- validator-threw path also leaks
  //
  // The `[invalid_args] validator threw: ${msg}` branch surfaced the raw
  // thrown message verbatim. Same posture as the dispatch_error branch:
  // sanitize the on-wire payload, keep the structured WARN log.
  // ------------------------------------------------------------------------

  it("buildMcpServerForClient dispatch sanitizes validator-throw error responses WR-02", async () => {
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

  it("buildMcpServerForClient dispatch does not throw when daemon RPC returns undefined CR-01 info leak guard", async () => {
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
