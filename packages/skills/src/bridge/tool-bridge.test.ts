// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for tool bridge: built-in tool collection and two-tier pipeline assembly.
 */

import type { TypedEventBus } from "@comis/core";
import type { SkillsConfig } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { getBuiltinTools, assembleToolPipeline } from "./tool-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(toggles: Partial<SkillsConfig["builtinTools"]> = {}): SkillsConfig {
  return {
    discoveryPaths: [],
    builtinTools: {
      read: toggles.read ?? false,
      write: toggles.write ?? false,
      edit: toggles.edit ?? false,
      grep: toggles.grep ?? false,
      find: toggles.find ?? false,
      ls: toggles.ls ?? false,
      exec: toggles.exec ?? false,
      process: toggles.process ?? false,
      webSearch: toggles.webSearch ?? false,
      webFetch: toggles.webFetch ?? false,
      browser: toggles.browser ?? false,
    },
  };
}

// ---------------------------------------------------------------------------
// getBuiltinTools tests
// ---------------------------------------------------------------------------

describe("getBuiltinTools", () => {
  it("returns read and edit when enabled", () => {
    const tools = getBuiltinTools(makeConfig({ read: true, edit: true }), "/tmp/workspace");
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("edit");
  });

  it("returns all 8 tools when all enabled", () => {
    const tools = getBuiltinTools(
      makeConfig({ read: true, write: true, edit: true, grep: true, find: true, ls: true, webSearch: true, webFetch: true }),
      "/tmp/workspace",
    );
    expect(tools).toHaveLength(8);
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("grep");
    expect(names).toContain("find");
    expect(names).toContain("ls");
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
  });

  it("returns empty array when all config-toggled tools disabled", () => {
    const tools = getBuiltinTools(makeConfig({}), "/tmp/workspace");
    expect(tools).toHaveLength(0);
  });

  it("respects individual toggles", () => {
    const tools = getBuiltinTools(
      makeConfig({ read: false, write: true, webSearch: false, webFetch: true }),
      "/tmp/workspace",
    );
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain("write");
    expect(names).toContain("web_fetch");
  });

  it("returns read tool when read enabled", () => {
    const tools = getBuiltinTools(makeConfig({ read: true }), "/tmp/workspace");
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
  });

  it("returns all 6 file tools when all file toggles enabled", () => {
    const tools = getBuiltinTools(
      makeConfig({
        read: true,
        edit: true,
        write: true,
        grep: true,
        find: true,
        ls: true,
      }),
      "/tmp/workspace",
    );
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("edit");
    expect(names).toContain("write");
    expect(names).toContain("grep");
    expect(names).toContain("find");
    expect(names).toContain("ls");
  });

  it("returns file and web tools together", () => {
    const tools = getBuiltinTools(
      makeConfig({ read: true, grep: true, webSearch: true }),
      "/tmp/workspace",
    );
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("grep");
    expect(names).toContain("web_search");
  });

  it("config-toggled tools default to disabled", () => {
    const tools = getBuiltinTools(makeConfig({}), "/tmp/workspace");
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("read");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
    expect(names).not.toContain("grep");
    expect(names).not.toContain("find");
    expect(names).not.toContain("ls");
    expect(tools).toHaveLength(0);
  });

  it("passes fileStateTracker to file tools when provided", () => {
    const tracker = {
      recordRead: vi.fn(),
      shouldReturnStub: vi.fn(),
      hasBeenRead: vi.fn(),
      getReadState: vi.fn(),
      checkStaleness: vi.fn(),
      clone: vi.fn(),
    };
    const tools = getBuiltinTools(
      makeConfig({ read: true, write: true, edit: true }),
      "/tmp/workspace",
      undefined, // secretManager
      undefined, // logger
      undefined, // onSuspiciousContent
      undefined, // readOnlyPaths
      undefined, // toolSourceProfiles
      undefined, // sharedPaths
      tracker,   // fileStateTracker
    );
    // With tracker, read/write/edit tools should be wrapped with file state guards.
    // Verify we still get the expected 3 tools (the wrapping is transparent).
    expect(tools).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// assembleToolPipeline tests
// ---------------------------------------------------------------------------

function makeMockEventBus(): TypedEventBus & { emitted: Array<{ event: string; payload: unknown }> } {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    emitted,
    emit: vi.fn((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
  } as unknown as TypedEventBus & { emitted: Array<{ event: string; payload: unknown }> };
}

describe("assembleToolPipeline", () => {
  it("combines builtin and platform tiers", async () => {
    const platformTools = () => [
      {
        name: "platform_tool",
        label: "platform_tool",
        description: "A platform tool",
        parameters: {},
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      },
    ];

    const tools = await assembleToolPipeline({
      config: makeConfig({ read: true }),
      workspacePath: "/tmp/workspace",
      platformTools,
    });

    const names = tools.map((t) => t.name);
    expect(names).toContain("read"); // Tier 1
    expect(names).toContain("platform_tool"); // Tier 2
  });

  it("applies policy filter", async () => {
    const tools = await assembleToolPipeline({
      config: {
        ...makeConfig({ read: true, edit: true, webFetch: true }),
        toolPolicy: { profile: "minimal", allow: [], deny: [] },
      },
      workspacePath: "/tmp/workspace",
    });

    const names = tools.map((t) => t.name);
    // Minimal profile allows exec, read, write -- only "read" is enabled in config
    expect(names).toEqual(["read"]);
  });

  it("wraps with audit when eventBus provided", async () => {
    const eventBus = makeMockEventBus();

    const tools = await assembleToolPipeline({
      config: makeConfig({ read: true }),
      workspacePath: "/tmp/workspace",
      eventBus,
    });

    expect(tools).toHaveLength(1);
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");

    // Execute the tool -- audit wrapper emits event even on failure (re-throws)
    try {
      await tools[0]!.execute("test-call", { path: "test.txt" });
    } catch {
      // Expected: real read tool may throw for missing file
    }

    expect(eventBus.emit).toHaveBeenCalledWith(
      "tool:executed",
      expect.objectContaining({
        toolName: "read",
      }),
    );
  });

  it("works without optional deps", async () => {
    const tools = await assembleToolPipeline({
      config: makeConfig({ read: true, write: true }),
      workspacePath: "/tmp/workspace",
    });

    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(tools).toHaveLength(2);
  });
});
