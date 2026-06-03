// SPDX-License-Identifier: Apache-2.0
/**
 * Unit test for the LONE remaining terminal-driver stub tool: `status`
 * (`terminal_session_status`). The four interaction tools
 * (send_text / send_key / wait / resize) are REAL factories in `terminal-tools.ts`;
 * only `status` is still deferred (the attention + autonomous tier). It carries
 * its final spec §5 TypeBox schema now (so the registered surface is correct) but
 * its `execute()` rejects with `[not_implemented]`. No
 * no-backward-compat-banned wording.
 *
 * Also asserts (negative) that the four interaction factories are NO LONGER
 * exported from the stubs module — they moved to `terminal-tools.ts`, so the stubs
 * file is the single-stub surface and there is no dual path.
 *
 * Pure-JS / macOS-green.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { createTerminalSessionStatusTool } from "./terminal-tools-stubs.js";
import * as stubsModule from "./terminal-tools-stubs.js";

describe("terminal-tools-stubs — status is the only remaining stub", () => {
  it("terminal_session_status rejects [not_implemented]", async () => {
    const tool = createTerminalSessionStatusTool();
    expect(tool.name).toBe("terminal_session_status");
    await expect(tool.execute("call-1", { sessionId: "s" } as never)).rejects.toThrow(/^\[not_implemented\]/);
    await expect(tool.execute("call-1", { sessionId: "s" } as never)).rejects.toThrow(/not yet implemented/);
  });

  it("status carries its canonical name + a non-empty TypeBox object schema", () => {
    const tool = createTerminalSessionStatusTool();
    const schema = tool.parameters as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("status's reject message has no no-backward-compat-banned wording", async () => {
    const tool = createTerminalSessionStatusTool();
    let message = "";
    try {
      await tool.execute("call-1", { sessionId: "s" } as never);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/not yet implemented/);
    expect(message).not.toMatch(/legacy|backward|fallback|deprecated/i);
  });

  it("the four interaction factories are NO LONGER exported from the stubs module (they moved to terminal-tools.ts — no dual path)", () => {
    const removed = [
      "createTerminalSessionSendTextTool",
      "createTerminalSessionSendKeyTool",
      "createTerminalSessionWaitTool",
      "createTerminalSessionResizeTool",
    ];
    for (const name of removed) {
      expect((stubsModule as Record<string, unknown>)[name]).toBeUndefined();
    }
    // status is still here.
    expect(typeof (stubsModule as Record<string, unknown>).createTerminalSessionStatusTool).toBe("function");
  });
});
