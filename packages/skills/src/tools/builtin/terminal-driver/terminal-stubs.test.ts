// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the five not-yet-implemented terminal-driver stub tools
 * (send_text / send_key / wait / status / resize). They carry their FINAL spec
 * §5 TypeBox schemas now (so the registered surface is correct) but their
 * `execute()` bodies reject with `[not_implemented]` naming the landing phase
 * (Open Q1). No no-backward-compat-banned wording.
 *
 * Pure-JS / macOS-green. Pre-patch RED: the factory import fails (module absent).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import {
  createTerminalSessionSendTextTool,
  createTerminalSessionSendKeyTool,
  createTerminalSessionWaitTool,
  createTerminalSessionStatusTool,
  createTerminalSessionResizeTool,
} from "./terminal-tools-stubs.js";

const STUBS = [
  { name: "terminal_session_send_text", make: createTerminalSessionSendTextTool, phase: 120 },
  { name: "terminal_session_send_key", make: createTerminalSessionSendKeyTool, phase: 120 },
  { name: "terminal_session_wait", make: createTerminalSessionWaitTool, phase: 120 },
  { name: "terminal_session_status", make: createTerminalSessionStatusTool, phase: 124 },
  { name: "terminal_session_resize", make: createTerminalSessionResizeTool, phase: 120 },
] as const;

describe("terminal-tools-stubs — reject not_implemented", () => {
  it.each(STUBS)("$name rejects with [not_implemented] naming its landing phase", async ({ name, make }) => {
    const tool = make();
    await expect(tool.execute("call-1", { sessionId: "s" } as never)).rejects.toThrow(/^\[not_implemented\]/);
    await expect(tool.execute("call-1", { sessionId: "s" } as never)).rejects.toThrow(/not available until Phase/);
  });

  it.each(STUBS)("$name carries its canonical name + a non-empty TypeBox schema", ({ name, make }) => {
    const tool = make();
    expect(tool.name).toBe(name);
    // A TypeBox object schema (the real spec §5 signature) — schema surface is final.
    const schema = tool.parameters as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it.each(STUBS)("$name message has no no-backward-compat-banned wording", async ({ make }) => {
    const tool = make();
    let message = "";
    try {
      await tool.execute("call-1", { sessionId: "s" } as never);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/not available until Phase/);
    expect(message).not.toMatch(/legacy|backward|fallback|deprecated/i);
  });
});
