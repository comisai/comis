// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 65 OPUX-10 integration test — capability-gated resources/prompts
 * utility tools + per-server opt-out.
 *
 * Drives the @comis/skills platform-tool registry (via dist/) end-to-end.
 * Proves the locked OPUX-10 behaviors (Plan 05) at the integration tier:
 *
 *   1. The 4 resources/prompts descriptors (list_resources, read_resource,
 *      list_prompts, get_prompt) are GLOBAL — exactly 4 entries in the
 *      registry regardless of how many MCP servers are connected (mitigates
 *      the Cursor 40-tool ceiling). NOT N×4.
 *   2. A connected server advertising `capabilities.resources` makes
 *      list_resources + read_resource conditionals pass; with no prompts
 *      capability the list_prompts/get_prompt conditionals stay false.
 *   3. `capabilities.prompts` makes list_prompts + get_prompt pass.
 *   4. Per-server `enableResources: false` suppresses the resources tools even
 *      when the capability is present (and symmetrically `enablePrompts:
 *      false`).
 *   5. No connected server with the capability ⇒ none of the 4 register.
 *
 * The registry's `conditional` predicate re-evaluates per build context, so
 * the tools register on the first agent assemble AFTER the relevant server
 * connects (RESEARCH Pitfall 4) — here we simulate "after connect" by feeding
 * a build context whose `mcpClientManager.getAllConnections()` returns the
 * connected server.
 *
 * Per CLAUDE.md: integration tests import from `dist/` — requires `pnpm build`
 * first. The `@comis/skills/platform-tools` alias resolves to
 * `packages/skills/dist/platform-tools/index.js`.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createPlatformToolRegistry } from "@comis/skills/platform-tools";
import type { PlatformToolBuildContext } from "@comis/skills/platform-tools";

// ---------------------------------------------------------------------------
// Mock McpClientManager — only the surface the registry conditionals consume:
// getAllConnections() returning McpConnection-shaped objects carrying
// { status, capabilities, enableResources, enablePrompts }.
// ---------------------------------------------------------------------------

interface MockConnection {
  name: string;
  status: "connected" | "disconnected" | "connecting" | "reconnecting" | "error";
  capabilities?: Record<string, unknown>;
  enableResources?: boolean;
  enablePrompts?: boolean;
}

/** Build a mock manager whose getAllConnections() returns the given connections. */
function makeMockManager(connections: MockConnection[]): never {
  return {
    getAllConnections: () => connections,
    // The registry's resources/prompts descriptors only call getAllConnections
    // in their `conditional`; `build` (when reached) just hands the manager to
    // the tool factory. The remaining manager methods are not exercised by the
    // conditional path under test.
    getConnection: (name: string) => connections.find((c) => c.name === name),
    getTools: () => [],
    connect: async () => ({ ok: false, error: new Error("not used") }),
    disconnect: async () => undefined,
    disconnectAll: async () => undefined,
    callTool: async () => ({ ok: false, error: new Error("not used") }),
    reconnect: async () => ({ ok: false, error: new Error("not used") }),
  } as never;
}

/** Construct a PlatformToolBuildContext carrying the mock manager. */
function makeCtx(manager: ReturnType<typeof makeMockManager> | undefined): PlatformToolBuildContext {
  return {
    agentId: "test-agent",
    rpcCall: async () => ({}),
    skillsLogger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
      child() {
        return this;
      },
    } as never,
    ...(manager !== undefined && { mcpClientManager: manager }),
  } as PlatformToolBuildContext;
}

// ---------------------------------------------------------------------------
// Helpers — isolate the 4 mcp resource/prompt descriptors by name.
// ---------------------------------------------------------------------------

const MCP_RESOURCE_PROMPT_TOOLS = ["list_resources", "read_resource", "list_prompts", "get_prompt"] as const;

function resourcePromptDescriptors() {
  return createPlatformToolRegistry().filter(
    (d) => d.category === "mcp" && (MCP_RESOURCE_PROMPT_TOOLS as readonly string[]).includes(d.name),
  );
}

/** Names of the resource/prompt descriptors whose conditional passes for ctx. */
function activeNames(ctx: PlatformToolBuildContext): string[] {
  return resourcePromptDescriptors()
    .filter((d) => d.conditional?.(ctx) === true)
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Tests — OPUX-10 capability gating + per-server opt-out
// ---------------------------------------------------------------------------

describe("Phase 65 OPUX-10 — capability-gated resources/prompts tools", () => {
  it("registers EXACTLY 4 GLOBAL resource/prompt descriptors (not N×4)", () => {
    const descriptors = resourcePromptDescriptors();
    expect(descriptors).toHaveLength(4);
    expect(descriptors.map((d) => d.name).sort()).toEqual([
      "get_prompt",
      "list_prompts",
      "list_resources",
      "read_resource",
    ]);
    // All four are categorized under "mcp".
    expect(descriptors.every((d) => d.category === "mcp")).toBe(true);
    // Each is gated by a conditional (none unconditional).
    expect(descriptors.every((d) => typeof d.conditional === "function")).toBe(true);
  });

  it("count stays 4 even with MANY connected servers advertising the capability (global, not per-server)", () => {
    // Five resources-capable servers would be 5×2 = 10 per-server tools; GLOBAL
    // keeps it at 2 (list_resources + read_resource) regardless.
    const manager = makeMockManager(
      Array.from({ length: 5 }, (_, i) => ({
        name: `srv-${i}`,
        status: "connected" as const,
        capabilities: { resources: { subscribe: true } },
      })),
    );
    const ctx = makeCtx(manager);
    // Total descriptor count is still 4.
    expect(resourcePromptDescriptors()).toHaveLength(4);
    // Resources tools active (2); prompts not (no prompts capability).
    expect(activeNames(ctx)).toEqual(["list_resources", "read_resource"]);
  });

  it("capabilities.resources → list_resources + read_resource conditionals pass; prompts stay off", () => {
    const manager = makeMockManager([
      { name: "fs", status: "connected", capabilities: { resources: { subscribe: true } } },
    ]);
    const ctx = makeCtx(manager);
    expect(activeNames(ctx)).toEqual(["list_resources", "read_resource"]);
  });

  it("capabilities.prompts → list_prompts + get_prompt conditionals pass; resources stay off", () => {
    const manager = makeMockManager([
      { name: "kb", status: "connected", capabilities: { prompts: {} } },
    ]);
    const ctx = makeCtx(manager);
    expect(activeNames(ctx)).toEqual(["get_prompt", "list_prompts"]);
  });

  it("a server advertising BOTH capabilities activates all 4", () => {
    const manager = makeMockManager([
      {
        name: "full",
        status: "connected",
        capabilities: { resources: { subscribe: true }, prompts: {} },
      },
    ]);
    const ctx = makeCtx(manager);
    expect(activeNames(ctx)).toEqual([
      "get_prompt",
      "list_prompts",
      "list_resources",
      "read_resource",
    ]);
  });

  it("per-server enableResources:false suppresses the resources tools (opt-out at registration)", () => {
    const manager = makeMockManager([
      {
        name: "fs",
        status: "connected",
        capabilities: { resources: { subscribe: true } },
        enableResources: false,
      },
    ]);
    const ctx = makeCtx(manager);
    // The only resources-capable server opted out → no resources tools register.
    expect(activeNames(ctx)).toEqual([]);
  });

  it("per-server enablePrompts:false suppresses the prompts tools (opt-out at registration)", () => {
    const manager = makeMockManager([
      {
        name: "kb",
        status: "connected",
        capabilities: { prompts: {} },
        enablePrompts: false,
      },
    ]);
    const ctx = makeCtx(manager);
    expect(activeNames(ctx)).toEqual([]);
  });

  it("opt-out is per-server: one server opts out, another with the capability still registers", () => {
    const manager = makeMockManager([
      {
        name: "noisy",
        status: "connected",
        capabilities: { resources: { subscribe: true } },
        enableResources: false,
      },
      {
        name: "fs",
        status: "connected",
        capabilities: { resources: { subscribe: true } },
        // enableResources undefined → auto-register.
      },
    ]);
    const ctx = makeCtx(manager);
    // The non-opted-out server keeps the resources tools alive.
    expect(activeNames(ctx)).toEqual(["list_resources", "read_resource"]);
  });

  it("no connected server with the capability → none of the 4 register", () => {
    const manager = makeMockManager([
      // Connected but advertises neither resources nor prompts.
      { name: "bare", status: "connected", capabilities: {} },
      // Resources-capable but NOT connected (status disconnected) → ignored.
      { name: "down", status: "disconnected", capabilities: { resources: {} } },
    ]);
    const ctx = makeCtx(manager);
    expect(activeNames(ctx)).toEqual([]);
  });

  it("no mcpClientManager on the build context → none of the 4 register", () => {
    // A non-MCP build context (parity-test stub, agents without MCP wired)
    // simply skips the 4 descriptors.
    const ctx = makeCtx(undefined);
    expect(activeNames(ctx)).toEqual([]);
  });

  it("a disconnected resources-capable server does not activate the tools (status gate)", () => {
    const manager = makeMockManager([
      { name: "fs", status: "reconnecting", capabilities: { resources: { subscribe: true } } },
    ]);
    const ctx = makeCtx(manager);
    expect(activeNames(ctx)).toEqual([]);
  });
});
