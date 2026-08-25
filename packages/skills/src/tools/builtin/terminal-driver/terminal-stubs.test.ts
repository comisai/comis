// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the `terminal-tools-stubs.ts` re-export surface. The
 * classifier-backed, owner-scoped `terminal_session_status` implementation lives
 * in `terminal-status-tool.ts`.
 *
 * Asserts:
 *   - the re-exported factory carries the canonical name and schema;
 *   - the four interaction factories are exported only from `terminal-tools.ts`.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { createTerminalSessionStatusTool } from "./terminal-tools-stubs.js";
import * as stubsModule from "./terminal-tools-stubs.js";
import type { TerminalToolDeps } from "./terminal-tools.js";

/** Minimal deps whose registry.status returns a fixed view (the tool delegates to it). */
function makeDeps(): TerminalToolDeps {
  const registry = {
    async status() {
      return {
        state: "working" as const,
        lastActivity: 1,
        interactions: 0,
        cursorParked: false,
        screenDiffEmpty: true,
      };
    },
  } as unknown as TerminalToolDeps["registry"];
  return {
    registry,
    allowEntries: [],
    detectProvider: () => ({}) as never,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    eventBus: { emit: vi.fn() } as unknown as TerminalToolDeps["eventBus"],
    nowMs: () => 1,
    agentId: "agent-1",
  } as unknown as TerminalToolDeps;
}

describe("terminal-tools-stubs — status is now a real tool (no remaining stub)", () => {
  it("the re-exported createTerminalSessionStatusTool is the REAL deps-taking factory (no not_implemented throw)", async () => {
    const tool = createTerminalSessionStatusTool(makeDeps());
    expect(tool.name).toBe("terminal_session_status");
    // It returns a jsonResult, NOT a [not_implemented] throw.
    await expect(tool.execute("call-1", { sessionId: "s" } as never)).resolves.toBeDefined();
  });

  it("status carries its canonical name + a non-empty TypeBox object schema", () => {
    const tool = createTerminalSessionStatusTool(makeDeps());
    const schema = tool.parameters as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("the four interaction factories are NOT exported from this module (they live in terminal-tools.ts — no dual path)", () => {
    const elsewhere = [
      "createTerminalSessionSendTextTool",
      "createTerminalSessionSendKeyTool",
      "createTerminalSessionWaitTool",
      "createTerminalSessionResizeTool",
    ];
    for (const name of elsewhere) {
      expect((stubsModule as Record<string, unknown>)[name]).toBeUndefined();
    }
    // status is re-exported here.
    expect(typeof (stubsModule as Record<string, unknown>).createTerminalSessionStatusTool).toBe("function");
  });
});
