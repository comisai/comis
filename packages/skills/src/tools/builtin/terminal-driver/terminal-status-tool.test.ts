// SPDX-License-Identifier: Apache-2.0
/**
 * Unit test for the REAL `terminal_session_status` tool — the lone `not_implemented`
 * stub promoted to a classifier-backed, owner-scoped factory.
 *
 * RED on pre-patch: the stub takes NO deps and `execute()` throws `[not_implemented]`.
 * GREEN: `createTerminalSessionStatusTool(deps).execute(id, {sessionId})`
 * returns a jsonResult of the status view (state from the classifier, via
 * `registry.status`) for an owned session, and degrades to the not-found minimal view
 * for a non-owned session (owner-scoping is inherited from `registry.status`).
 *
 * Also asserts (architecture) that `terminal_session_status` stays
 * `mcpExportPolicy:"never-export"` — the default-deny that keeps a driven
 * session off any remote MCP surface.
 *
 * Pure-JS / macOS-green.
 *
 * @module
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { getToolMetadata } from "@comis/core";

import { createTerminalSessionStatusTool } from "./terminal-tools-stubs.js";
import type { TerminalToolDeps } from "./terminal-tools.js";
import type { TerminalStatusView } from "./terminal-status-view.js";
import { registerAllToolMetadata } from "../../../skills/bridge/tool-metadata-registry.js";

beforeAll(() => {
  registerAllToolMetadata();
});

/** A focused fake registry exposing just the `status` method the tool calls. */
function makeStatusDeps(
  statusImpl: (sessionId: string) => Promise<TerminalStatusView>,
): { deps: TerminalToolDeps; statusCalls: string[] } {
  const statusCalls: string[] = [];
  const registry = {
    async status(sessionId: string): Promise<TerminalStatusView> {
      statusCalls.push(sessionId);
      return statusImpl(sessionId);
    },
  } as unknown as TerminalToolDeps["registry"];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    registry,
    allowEntries: [],
    detectProvider: () => ({}) as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as TerminalToolDeps["eventBus"],
    nowMs: () => 1000,
    agentId: "agent-1",
  } as unknown as TerminalToolDeps;
  return { deps, statusCalls };
}

const OWNED_VIEW: TerminalStatusView = {
  state: "awaiting-input",
  lastActivity: 1000,
  interactions: 2,
  cursorParked: true,
  screenDiffEmpty: true,
  // The classifier confidence + reason ride the view; a dialog verdict is
  // {medium, dialog_detected}. TerminalStatusView carries them, so a fixture without
  // them is a tsc error — the type-level RED.
  confidence: "medium",
  reason: "dialog_detected",
};

describe("terminal_session_status — the real classifier-backed tool", () => {
  it("execute returns a jsonResult of the status (classifier state) for an owned session — NOT a not_implemented throw", async () => {
    const { deps, statusCalls } = makeStatusDeps(async () => OWNED_VIEW);
    const tool = createTerminalSessionStatusTool(deps);

    expect(tool.name).toBe("terminal_session_status");
    const result = await tool.execute("call-1", { sessionId: "s1" } as never);
    // jsonResult wraps the view as a JSON content block — parse it back.
    const block = (result as { content: Array<{ type: string; text: string }> }).content[0];
    const view = JSON.parse(block.text) as TerminalStatusView;
    expect(view.state).toBe("awaiting-input");
    expect(view.cursorParked).toBe(true);
    expect(view.interactions).toBe(2);
    // The serialized view surfaces the classifier confidence +
    // reason — the WHY/HOW-SURE the autonomous policy + `comis explain` read; the
    // richer view flows through the tool's jsonResult verbatim (no tool edit).
    expect(view.confidence).toBe("medium");
    expect(view.reason).toBe("dialog_detected");
    expect(statusCalls).toEqual(["s1"]);
  });

  it("degrades to the not-found minimal view for a non-owned session (owner-scoping inherited from registry.status)", async () => {
    // registry.status enforces the owner check; a non-owned probe gets the not-found view.
    const notFound: TerminalStatusView = {
      state: "exited",
      lastActivity: 0,
      interactions: 0,
      cursorParked: false,
      screenDiffEmpty: true,
      // The not-found degrade carries the safe total default (high/exited) — never a
      // real classifier verdict.
      confidence: "high",
      reason: "exited",
    };
    const { deps } = makeStatusDeps(async () => notFound);
    const tool = createTerminalSessionStatusTool(deps);

    const result = await tool.execute("call-1", { sessionId: "someone-elses" } as never);
    const block = (result as { content: Array<{ type: string; text: string }> }).content[0];
    const view = JSON.parse(block.text) as TerminalStatusView;
    expect(view.state).not.toBe("awaiting-input");
    expect(view.cursorParked).toBe(false);
    // The degrade default surfaces verbatim through the tool.
    expect(view.confidence).toBe("high");
    expect(view.reason).toBe("exited");
  });

  it("stays mcpExportPolicy 'never-export' — never exposed to a remote MCP client", () => {
    const meta = getToolMetadata("terminal_session_status");
    expect(meta).toBeDefined();
    expect(meta!.mcpExportPolicy).toBe("never-export");
  });
});
