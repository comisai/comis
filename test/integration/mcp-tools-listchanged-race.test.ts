// SPDX-License-Identifier: Apache-2.0
/**
 * PROVING integration test (NO production change).
 *
 * Pins the existing safety of a `tools/list_changed` notification that fires
 * DURING an in-flight `callTool`. Two invariants are locked against regression:
 *
 *   1. ATOMIC CACHE SWAP — the `onChanged` handler (mcp-client-discover.ts:328-343)
 *      reads the connection and does a single synchronous `state.connections.set`
 *      with NO `await` between the get and the set. After it runs, the cached tool
 *      list (`manager.getTools()`) reflects the NEW list. The swap carries the
 *      SAME generation (only reconnect bumps generation — mcp-client-reconnect.ts:218).
 *
 *   2. DISPATCH DOESN'T READ THE CACHE — an in-flight `callTool` forwards
 *      `{ name: toolName, arguments: args }` to the LIVE SDK client
 *      (mcp-client-call.ts:187) and never consults `conn.tools`. A `list_changed`
 *      mid-call therefore CANNOT alter the in-flight call's result: it completes
 *      against the tool it was dispatched with. Because `onChanged` does NOT bump
 *      the generation, the post-call generation guard (mcp-client-call.ts:195)
 *      does NOT fire, so the call returns `ok` (NOT "connection recycled").
 *
 * Why this is a genuine proving test (would FAIL if the safety broke):
 *   - If a future change bumped `state.generations` inside `onChanged`, the
 *     in-flight call would trip the generation guard and return
 *     `err("... connection recycled ... Retry safely")` — the
 *     `result.ok === true` + `text === "alpha-result"` assertions would FAIL.
 *     (Contrast: mcp-client.test.ts:1102 proves a RECONNECT-bumped generation
 *     DOES make the in-flight call fail; this test proves list_changed does not.)
 *   - If `callTool` were changed to re-read the cached tool definition mid-dispatch,
 *     the swap-removed "alpha" would no longer resolve and the call would diverge
 *     from `alpha-result`.
 *   - If an `await` were introduced between the `.get` and `.set` in `onChanged`
 *     (making the swap non-atomic), the back-to-back-swap test's last-writer-wins
 *     assertion (`gamma` wins, `alpha`/`beta` gone) would be at risk.
 *
 * A proving/regression test for already-correct behavior may
 * land as a single commit — there is no production change to make it
 * fail; this docblock + the commit message record that rationale.
 *
 * Integration tests import `@comis/skills` via `dist/` — run
 * `pnpm build` before vitest. The integration vitest config aliases
 * `@comis/skills` -> `packages/skills/dist/skills/index.js`.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// SDK module path resolution — copied verbatim from mcp-keepalive.test.ts.
// createRequire is rooted at a dist .js file so pnpm's symlink chain is
// followed the same way the dist code's own imports resolve. require.resolve
// returns the CJS variant; we swap to ESM since the dist code loads the ESM
// build. Vitest 4 does NOT bridge specifier-based mocks across module graphs
// when the consumer is compiled dist .js code — mocking
// the resolved ABSOLUTE path is the working pattern.
// ---------------------------------------------------------------------------

const sdkPaths = vi.hoisted(() => {
  const Module = require("node:module") as typeof import("node:module");
  const path = require("node:path") as typeof import("node:path");
  const testDir = path.dirname(import.meta.url.replace("file://", ""));
  const worktreeRoot = path.resolve(testDir, "..", "..");
  const skillsDistFile = path.resolve(
    worktreeRoot,
    "packages",
    "skills",
    "dist",
    "skills",
    "integrations",
    "mcp-client",
    "mcp-client-discover.js",
  );
  const req = Module.createRequire(skillsDistFile);
  const toEsm = (p: string) => p.replace("/dist/cjs/", "/dist/esm/");
  return {
    clientIndex: toEsm(req.resolve("@modelcontextprotocol/sdk/client/index.js")),
    stdio: toEsm(req.resolve("@modelcontextprotocol/sdk/client/stdio.js")),
    sse: toEsm(req.resolve("@modelcontextprotocol/sdk/client/sse.js")),
    streamableHttp: toEsm(req.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")),
  };
});

// ---------------------------------------------------------------------------
// SDK Client mock — vi.hoisted ensures the closure variables are initialised
// before the (also-hoisted) vi.mock factories execute.
//
// Harness extension (vs the keepalive mock): the keepalive Client mock
// IGNORES its constructor args; this test MUST CAPTURE the second arg's
// `listChanged.tools.onChanged`. The manager wires that callback ONLY when an
// eventBus is present (mcp-client-discover.ts:317), so this test constructs the
// manager WITH an eventBus. `capturedOnChanged` is how the test fires a
// `tools/list_changed` the same way the SDK would (with the already-fetched
// new tool list).
// ---------------------------------------------------------------------------

type OnChanged = (error: unknown, tools: Array<Record<string, unknown>> | undefined) => void;

const sdkMocks = vi.hoisted(() => {
  interface MockedClientInstance {
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    getInstructions: ReturnType<typeof vi.fn>;
    getServerCapabilities: ReturnType<typeof vi.fn>;
    getServerVersion: ReturnType<typeof vi.fn>;
  }
  return {
    mockPing: vi.fn(),
    mockCallTool: vi.fn(),
    mockConnect: vi.fn(),
    mockClose: vi.fn(),
    mockListTools: vi.fn(),
    clientInstances: [] as MockedClientInstance[],
    // Captured tools/list_changed callback (undefined until the
    // manager constructs the Client with an eventBus and wires it).
    capturedOnChanged: undefined as ((error: unknown, tools: unknown[] | undefined) => void) | undefined,
  };
});

vi.mock(sdkPaths.clientIndex, () => ({
  Client: vi.fn().mockImplementation(function (_info: unknown, options: any) {
    // Capture: discover.ts passes listChanged.tools.onChanged only when
    // an eventBus is configured. Grab it so the test can fire list_changed.
    sdkMocks.capturedOnChanged = options?.listChanged?.tools?.onChanged;
    const instance = {
      connect: sdkMocks.mockConnect,
      close: sdkMocks.mockClose,
      listTools: sdkMocks.mockListTools,
      callTool: sdkMocks.mockCallTool,
      ping: sdkMocks.mockPing,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
      getInstructions: vi.fn().mockReturnValue(undefined),
      getServerCapabilities: vi.fn().mockReturnValue({}),
      getServerVersion: vi.fn().mockReturnValue({ name: "test", version: "1.0" }),
    };
    sdkMocks.clientInstances.push(instance);
    return instance;
  }),
}));

vi.mock(sdkPaths.stdio, () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return { type: "stdio" };
  }),
}));

vi.mock(sdkPaths.sse, () => ({
  SSEClientTransport: vi.fn().mockImplementation(function () {
    return { type: "sse" };
  }),
}));

vi.mock(sdkPaths.streamableHttp, () => {
  class _StreamableHTTPError extends Error {
    code: number | undefined;
    constructor(code: number | undefined, message: string | undefined) {
      super(message);
      this.code = code;
      this.name = "StreamableHTTPError";
    }
  }
  return {
    StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
      return { type: "http" };
    }),
    StreamableHTTPError: _StreamableHTTPError,
  };
});

import { createMcpClientManager } from "@comis/skills";

const { mockPing, mockCallTool, mockConnect, mockClose, mockListTools, clientInstances } = sdkMocks;

// ---------------------------------------------------------------------------
// Logger + eventBus fixtures (copied from mcp-keepalive.test.ts — not imported
// across test files). emit is a vi.fn() so the tools_changed assertion can
// inspect the call args.
// ---------------------------------------------------------------------------

function makeLogger() {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: "debug",
    isLevelEnabled: vi.fn(() => true),
  };
  logger.child = vi.fn(() => logger);
  return logger;
}

function makeEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
  };
}

// Helpers to keep the assertions readable.
const qn = (tool: string) => `mcp:test-server/${tool}`;
const toolNames = (mgr: ReturnType<typeof createMcpClientManager>) =>
  mgr.getTools().map((t) => t.qualifiedName);

// ---------------------------------------------------------------------------
// Tests — list_changed vs in-flight callTool.
//
// REAL timers (NOT fake): the in-flight ordering is what matters and it is
// driven by manual `await Promise.resolve()` microtask flushes around the slow
// call plus the synchronous `capturedOnChanged` invocation — no ticker is
// involved, so fake timers are unnecessary (and would only obscure the order).
// ---------------------------------------------------------------------------

describe("tools/list_changed during in-flight callTool", () => {
  beforeEach(() => {
    mockPing.mockReset().mockResolvedValue({});
    mockCallTool.mockReset();
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockClose.mockReset().mockResolvedValue(undefined);
    // Initial discovery: the server reports a single tool "alpha".
    mockListTools.mockReset().mockResolvedValue({
      tools: [{ name: "alpha", inputSchema: { type: "object" } }],
    });
    clientInstances.length = 0;
    sdkMocks.capturedOnChanged = undefined;
  });

  it("leaves the in-flight call's result unchanged while getTools() reflects the new list", async () => {
    const eventBus = makeEventBus();
    const mgr = createMcpClientManager({
      logger: makeLogger(),
      // eventBus is REQUIRED: discover.ts:317 only wires onChanged when present.
      eventBus: eventBus as never,
    });

    const connectResult = await mgr.connect({
      name: "test-server",
      transport: "stdio",
      command: "/usr/bin/test",
      enabled: true,
    });
    expect(connectResult.ok).toBe(true);

    // Connect discovered "alpha"; the manager wired the SDK list_changed cb.
    expect(toolNames(mgr)).toContain(qn("alpha"));
    expect(typeof sdkMocks.capturedOnChanged).toBe("function");

    // --- Start an in-flight callTool with a slow resolve-later promise. ------
    // mockCallTool IS the live SDK client.callTool that callTool() forwards to
    // (mcp-client-call.ts:187). Holding it open models a request in flight to
    // the server.
    let resolveSlowCall: ((value: unknown) => void) | undefined;
    mockCallTool.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSlowCall = resolve; }),
    );

    const callPromise = mgr.callTool(qn("alpha"), { x: 1 });
    // Flush microtasks so the queued call actually invokes mockCallTool and is
    // pending (the slow promise has not resolved yet).
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(resolveSlowCall).toBeTypeOf("function");

    // --- MID-FLIGHT: the SDK delivers tools/list_changed with a NEW list. ----
    // (alpha removed, beta added). The SDK has already fetched the new list;
    // it just hands it to the captured onChanged callback.
    sdkMocks.capturedOnChanged!(undefined, [{ name: "beta", inputSchema: { type: "object" } }]);

    // The swap is synchronous, so getTools() ALREADY reflects the new list,
    // even though the in-flight call has NOT resolved.
    expect(toolNames(mgr)).toContain(qn("beta"));
    expect(toolNames(mgr)).not.toContain(qn("alpha"));

    // --- Resolve the slow call with the dispatch-time tool's result. ---------
    resolveSlowCall!({
      content: [{ type: "text", text: "alpha-result" }],
      isError: false,
    });
    const result = await callPromise;

    // INVARIANT 1: the in-flight call is UNAFFECTED by the mid-flight swap. It
    // completed against the tool it was dispatched with. Because onChanged does
    // NOT bump the generation, the post-call generation guard does not fire — so
    // this is `ok`, not "connection recycled". (Would FAIL if onChanged bumped
    // the generation.)
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isError).toBe(false);
    expect(result.value.content[0]?.text).toBe("alpha-result");

    // callTool forwarded the captured toolName (NEVER re-read the cache).
    expect(mockCallTool).toHaveBeenCalledWith(
      { name: "alpha", arguments: { x: 1 } },
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );

    // INVARIANT 2: post-notification, getTools() reflects the NEW list.
    expect(toolNames(mgr)).toEqual([qn("beta")]);

    // The tools_changed event was emitted with the post-notification counts.
    expect(eventBus.emit).toHaveBeenCalledWith(
      "mcp:server:tools_changed",
      expect.objectContaining({
        serverName: "test-server",
        previousToolCount: 1,
        currentToolCount: 1,
        addedTools: expect.arrayContaining(["beta"]),
        removedTools: expect.arrayContaining(["alpha"]),
      }),
    );
  });

  it("applies back-to-back swaps last-writer-wins while the in-flight call stays on its dispatch-time result", async () => {
    // Regression teeth: two synchronous onChanged invocations BEFORE the call
    // resolves. This pins that the swap is a synchronous last-writer-wins
    // Map.set and the in-flight call is immune to BOTH swaps. It would break if
    // a future change introduced an await between the get and set in onChanged
    // (non-atomic swap) or made callTool consult the cache mid-dispatch.
    const eventBus = makeEventBus();
    const mgr = createMcpClientManager({
      logger: makeLogger(),
      eventBus: eventBus as never,
    });

    await mgr.connect({
      name: "test-server",
      transport: "stdio",
      command: "/usr/bin/test",
      enabled: true,
    });
    expect(toolNames(mgr)).toContain(qn("alpha"));

    let resolveSlowCall: ((value: unknown) => void) | undefined;
    mockCallTool.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSlowCall = resolve; }),
    );

    const callPromise = mgr.callTool(qn("alpha"), { x: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCallTool).toHaveBeenCalledTimes(1);

    // Two back-to-back list_changed deliveries, NO await between them.
    sdkMocks.capturedOnChanged!(undefined, [{ name: "beta", inputSchema: { type: "object" } }]);
    sdkMocks.capturedOnChanged!(undefined, [{ name: "gamma", inputSchema: { type: "object" } }]);

    // Last writer wins: only "gamma" survives; "alpha" and "beta" are gone.
    expect(toolNames(mgr)).toEqual([qn("gamma")]);

    // The in-flight call still resolves to its dispatch-time result — neither
    // swap touched it.
    resolveSlowCall!({
      content: [{ type: "text", text: "alpha-result" }],
      isError: false,
    });
    const result = await callPromise;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content[0]?.text).toBe("alpha-result");

    // Final list is still the LAST swap's list after the call resolves.
    expect(toolNames(mgr)).toEqual([qn("gamma")]);

    // Two notifications => two tools_changed emissions; the last carries gamma.
    const changedCalls = eventBus.emit.mock.calls.filter(
      ([name]) => name === "mcp:server:tools_changed",
    );
    expect(changedCalls).toHaveLength(2);
    expect(changedCalls[1][1]).toEqual(
      expect.objectContaining({
        serverName: "test-server",
        currentToolCount: 1,
        addedTools: expect.arrayContaining(["gamma"]),
        removedTools: expect.arrayContaining(["beta"]),
      }),
    );
  });
});
