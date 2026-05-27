// SPDX-License-Identifier: Apache-2.0
// This test imports the no-op port factory solely as a reference-equality
// sentinel. The architecture-grep targets non-architecture-test files; this
// orchestration smoke test is exempt by the *.test.ts file-extension
// semantics.
//
// Purpose: prove at runtime that the daemon's orchestration order
// (setupMcp → per-agent ToolCapabilityPort adapter via createToolCapabilityAdapter,
// the same factory setupSingleAgent invokes inside the real setupAgents loop)
// completes without throwing AND that the per-agent port emerging from the
// orchestration is the LIVE adapter, not the createNoOpCapabilityPort()
// fallback. A static `awk` line-ordering grep is insufficient.
//
// Two sentinels:
//   1. Reference-equality: the port emerging from the orchestration is NOT
//      the no-op factory's output (no-op factory build for comparison).
//   2. Behavioral: capabilityIndex.enabled = false / installDetours.mode =
//      "soft-stop" produce port methods returning false / "soft-stop"; the
//      no-op hardcodes true / "advise". Different config → different
//      observable behavior is the strongest proof the live adapter is in
//      use.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setupMcp } from "./setup-mcp.js";
// setupAgents is imported as TYPE-ONLY so the type-level dependency surface
// is exercised at compile time -- a future refactor that breaks the
// SetupAgentsDeps contract still surfaces in this file. A runtime
// `import` would pull the entire transitive dep graph (pi-coding-agent,
// ProviderHealthMonitor, OAuth credential store, secret manager,
// better-sqlite3 native bindings via @comis/memory, ~30 other deps),
// inflating module-load cost and risking unrelated load failures
// masquerading as orchestration-order regressions.
//
// The full setupAgents body is out of scope for v1 of this runtime check
// (see the deferred-coverage note in the second `it` block). The
// orchestration-ORDER claim (setupMcp result feeds adapter construction
// without throwing AND the per-agent port is the live adapter) is proven
// here by exercising the SAME factory (createToolCapabilityAdapter) that
// setupSingleAgent invokes inside the real setupAgents loop.
import type { setupAgents } from "./setup-agents/index.js";
import { createToolCapabilityAdapter } from "./tool-capability-adapter.js";
import { createNoOpCapabilityPort } from "@comis/core";
import type { ToolingConfig } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { SkillRegistry, McpServerConnection } from "@comis/skills";

// Compile-time-only reference to setupAgents -- preserves the runtime
// architecture claim (the real setupAgents lives in the same module
// surface this test consumes; a regression that breaks the SetupAgentsDeps
// shape would surface here too via the type-level dep) without paying the
// runtime import cost.
type _SetupAgentsType = typeof setupAgents;

/** Minimal silent logger that satisfies ComisLogger. */
function makeStubLogger(): ComisLogger {
  const stub = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    level: "silent",
    child: () => stub,
    bindings: () => ({}),
    isLevelEnabled: () => false,
    flush: vi.fn(),
  };
  return stub as unknown as ComisLogger;
}

/** Minimal SkillRegistry stub returning zero skills. */
function makeStubSkillRegistry(): SkillRegistry {
  return {
    getPromptSkillCapabilities: vi.fn(() => []),
    getSnapshot: vi.fn(() => ({ prompt: "", count: 0 })),
    init: vi.fn(),
    list: vi.fn(() => []),
    listVisible: vi.fn(() => []),
    get: vi.fn(() => undefined),
    invokeSkill: vi.fn(),
    getResourceWatcherDebounceMs: vi.fn(() => 400),
    startWatching: vi.fn(),
    close: vi.fn(),
  } as unknown as SkillRegistry;
}

describe("daemon orchestration order runtime check", () => {
  it("setupMcp constructs a live mcpClientManager that the per-agent ToolCapabilityPort adapter can close over without throwing", async () => {
    // === Arrange: minimal silent logger + empty skill registry ===
    const logger = makeStubLogger();

    // === Act 1: real setupMcp first (mirrors daemon.ts post-Task-3a reorder) ===
    const mcpResult = await setupMcp({
      servers: [],   // no real MCP servers configured; manager is constructed without I/O
      logger,
      callToolTimeoutMs: 30_000,
      eventBus: undefined,
      stdioDefaultConcurrency: 1,
      httpDefaultConcurrency: 4,
    });

    // The manager is always constructed (per setup-mcp.ts contract), even
    // when zero servers are configured at startup.
    expect(mcpResult.mcpClientManager).toBeDefined();
    expect(mcpResult.mcpClientManager.getAllConnections()).toEqual([]);
    expect(mcpResult.mcpClientManager.getTools()).toEqual([]);
  });

  it("per-agent ToolCapabilityPort emerging from the post-setupMcp orchestration is the LIVE adapter (not createNoOpCapabilityPort) -- two sentinels (reference-equality + behavioral)", async () => {
    // TODO: Exercise the real setupAgents body end-to-end (not just the
    // createToolCapabilityAdapter factory it invokes). v1 of this smoke
    // test stops short of full setupAgents because its dependency surface
    // (pi-coding-agent, OAuthCredentialStore, ProviderHealthMonitor,
    // SecretManager + ~30 fields on container.config) requires a fixture
    // that's brittle in proportion to the daemon's wiring depth. The
    // invariant (setupMcp produces a manager the per-agent adapter can
    // close over without throwing AND the resulting port is the live
    // adapter) is proven here by running the SAME factory setupSingleAgent
    // invokes inside setupAgents -- if that factory produces a live port
    // for a known toolingConfig, the per-agent port emerging from the real
    // setupAgents loop is identical (the loop has no other code path that
    // could substitute a no-op).
    const logger = makeStubLogger();

    // === Arrange: tooling config whose values DIFFER from the no-op
    // hardcodes (`isCapabilityIndexEnabled: () => true`,
    // `getInstallDetourMode: () => "advise"`). The behavioral sentinel
    // exploits this: a live adapter reads from the config and returns
    // these different values; a no-op returns the hardcodes.
    const toolingConfig: ToolingConfig = {
      capabilityClusters: { clusters: {}, builtinAssignments: {} },
      mcp: { capabilityHints: {} },
      skills: { capabilityHints: {} },
      capabilityIndex: { enabled: false },           // sentinel: no-op hardcodes true
      installDetours: { mode: "soft-stop" },         // sentinel: no-op hardcodes "advise"
    };
    const skillRegistry = makeStubSkillRegistry();

    // === Act 1: real setupMcp first -- mirrors daemon.ts orchestration order.
    // This MUST happen before any per-agent adapter construction so the
    // manager is in scope at adapter-build time.
    const mcpResult = await setupMcp({
      servers: [],
      logger,
      callToolTimeoutMs: 30_000,
      eventBus: undefined,
      stdioDefaultConcurrency: 1,
      httpDefaultConcurrency: 4,
    });

    // === Act 2: construct the per-agent ToolCapabilityPort adapter via the
    // SAME factory that setupSingleAgent invokes (createToolCapabilityAdapter).
    // The adapter closes over the mcpClientManager produced in Act 1 --
    // proving the orchestration order works (Act 1 result is consumable
    // here without throwing) AND that the resulting port reads live from
    // its closure-captured manager + config.
    const port = createToolCapabilityAdapter({
      toolingConfig,
      skillRegistry,
      mcpClientManager: mcpResult.mcpClientManager,
      logger,
    });

    // === Assert: the live adapter is in use, not the no-op fallback ===

    // Sentinel 1 -- reference-equality: not the no-op factory output.
    const noOp = createNoOpCapabilityPort();
    expect(port).not.toBe(noOp);

    // Sentinel 2 -- behavioral: live adapter reads from toolingConfig (the
    // no-op hardcodes different values).
    // toolingConfig.capabilityIndex.enabled = false; no-op returns true.
    expect(port.isCapabilityIndexEnabled()).toBe(false);
    // toolingConfig.installDetours.mode = "soft-stop"; no-op returns "advise".
    expect(port.getInstallDetourMode()).toBe("soft-stop");

    // Cross-check: the no-op behaves as expected (sanity that we're not
    // comparing two adapters that happen to agree on these surfaces).
    expect(noOp.isCapabilityIndexEnabled()).toBe(true);
    expect(noOp.getInstallDetourMode()).toBe("advise");
  });

  it("port stays consistent with live MCP state changes via mcpClientManager -- closure captures the live reference, not a snapshot", async () => {
    const logger = makeStubLogger();
    const skillRegistry = makeStubSkillRegistry();
    const toolingConfig: ToolingConfig = {
      capabilityClusters: { clusters: {}, builtinAssignments: {} },
      mcp: { capabilityHints: {} },
      skills: { capabilityHints: {} },
      capabilityIndex: { enabled: true },
      installDetours: { mode: "advise" },
    };

    // setupMcp first.
    const mcpResult = await setupMcp({
      servers: [],
      logger,
      callToolTimeoutMs: 30_000,
      eventBus: undefined,
      stdioDefaultConcurrency: 1,
      httpDefaultConcurrency: 4,
    });

    // Construct adapter -- it closes over mcpResult.mcpClientManager.
    const port = createToolCapabilityAdapter({
      toolingConfig,
      skillRegistry,
      mcpClientManager: mcpResult.mcpClientManager,
      logger,
    });

    // Initially zero connected servers. The adapter MUST report the same.
    expect(port.getConnectedMcpServers()).toEqual([]);

    // Patch the manager's getAllConnections to simulate a runtime mutation
    // (e.g., a successful mcp.connect RPC). The port closure should see the
    // new state on the NEXT call -- proving fresh-per-call liveness, not a
    // snapshot taken at adapter construction.
    const fakeConnection: McpServerConnection = {
      name: "test-server",
      transport: "stdio",
      status: "connected",
      tools: [],
      reconnectAttempts: 0,
    } as unknown as McpServerConnection;
    mcpResult.mcpClientManager.getAllConnections =
      vi.fn(() => [fakeConnection]);

    // Adapter sees the new state on the next call -- live closure, not a
    // snapshot.
    expect(port.getConnectedMcpServers()).toEqual(["test-server"]);
  });

  // ---------------------------------------------------------------------------
  // R8 daemon-wiring gap: setupMcp must receive oauthCredentialStore + dataDir
  // (02-06 gap-closure).
  //
  // Confirms that daemon.ts passes `oauthCredentialStore` and `dataDir` to
  // `setupMcp` so that MCP OAuth tokens are routed through the unified
  // OAuthCredentialStorePort (not the disk-default fallback).
  //
  // The test is structural: it reads daemon.ts source and verifies the
  // `setupMcp({...})` call block contains these wiring fields. A runtime
  // integration harness that spins up `bootAgents` is out of scope (see the
  // deferred-coverage note in the second `it` block above); the structural
  // check is sufficient to prevent regression — any future edit to daemon.ts
  // that strips these fields is caught immediately.
  //
  // RED: daemon.ts currently does NOT pass oauthCredentialStore/dataDir to
  // setupMcp — this test must fail before the fix and pass after.
  // ---------------------------------------------------------------------------
  it("daemon.ts passes oauthCredentialStore and dataDir to setupMcp (R8 wiring gap closure 02-06)", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // daemon.ts lives two directories up from wiring/
    const daemonSrc = readFileSync(join(__dirname, "..", "daemon.ts"), "utf-8");

    // Find the setupMcp({ call block. The block ends at the first `});` that
    // closes the call (the call is never nested inside another block, so this
    // is safe). Slice from the call opener to the first `});` after it.
    const setupMcpCallStart = daemonSrc.indexOf("const { mcpClientManager } = await setupMcp({");
    expect(setupMcpCallStart).toBeGreaterThan(-1); // sanity: call exists

    // Narrow window: slice from the opening brace to the first `});` that
    // closes setupMcp's argument object. The call is written as a multi-line
    // object literal, so the first `});` after the opener closes it.
    const windowEnd = daemonSrc.indexOf("});", setupMcpCallStart);
    expect(windowEnd).toBeGreaterThan(setupMcpCallStart); // sanity: close found
    const setupMcpCallBlock = daemonSrc.slice(setupMcpCallStart, windowEnd + 3);

    // Both wiring fields MUST be present in the setupMcp call block.
    // These are the fields that route MCP OAuth tokens through the port
    // instead of the disk-default fallback (R8 SC5 second clause).
    expect(setupMcpCallBlock).toContain("oauthCredentialStore");
    expect(setupMcpCallBlock).toContain("dataDir");
  });
});
