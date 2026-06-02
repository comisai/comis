// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for the terminal-driver daemon wiring (`wireTerminalTools`).
 *
 * Asserts the composition root pushes all nine never-export terminal tools onto
 * the agent tool array, reuses one registry per agent, and is fail-closed by
 * construction at this phase: the wired allow-set is empty, so a create on the
 * wired tool rejects with `permission_denied` before any worker is spawned
 * (SEC-01). Imports the real `@comis/skills/tools` factories (resolved from the
 * built `dist`).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { wireTerminalTools } from "./setup-terminal-tools.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import type { TerminalSessionRegistry } from "@comis/skills/tools";

type ToolLike = { name: string; execute: (id: string, params: object) => Promise<unknown> };

function makeDeps() {
  return {
    dataDir: "/tmp/comis-terminal-wiring-test",
    skillsLogger: createMockLogger(),
    eventBus: { emit: () => true },
  };
}

const NINE_NAMES = [
  "terminal_session_create",
  "terminal_session_read",
  "terminal_session_list",
  "terminal_session_kill",
  "terminal_session_send_text",
  "terminal_session_send_key",
  "terminal_session_wait",
  "terminal_session_status",
  "terminal_session_resize",
];

describe("wireTerminalTools — daemon composition root", () => {
  it("pushes all nine never-export terminal tools onto the agent tool array", () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());

    const names = tools.map((t) => t.name);
    for (const expected of NINE_NAMES) {
      expect(names).toContain(expected);
    }
    expect(tools).toHaveLength(9);
  });

  it("reuses one registry per agent (lazy, closure-local map)", () => {
    const registries = new Map<string, TerminalSessionRegistry>();
    const deps = makeDeps();
    wireTerminalTools([] as never, registries, "agent-a", deps);
    wireTerminalTools([] as never, registries, "agent-a", deps);
    wireTerminalTools([] as never, registries, "agent-b", deps);
    // One registry for agent-a (reused), one for agent-b.
    expect(registries.size).toBe(2);
  });

  it("is fail-closed: a create on the empty allow-set rejects permission_denied, no spawn (SEC-01)", async () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());

    const createTool = tools.find((t) => t.name === "terminal_session_create");
    expect(createTool).toBeDefined();
    // The wired allow-set is empty → the allowlist gate rejects before any spawn.
    await expect(
      createTool!.execute("call-1", { allowId: "bash", command: "/bin/bash" }),
    ).rejects.toThrow(/\[permission_denied\]/);
  });

  it("the stub tools reject not_implemented", async () => {
    const tools: ToolLike[] = [];
    const registries = new Map<string, TerminalSessionRegistry>();
    wireTerminalTools(tools as never, registries, "agent-a", makeDeps());

    const stub = tools.find((t) => t.name === "terminal_session_send_text");
    expect(stub).toBeDefined();
    await expect(stub!.execute("call-1", { sessionId: "s", text: "x" })).rejects.toThrow(/\[not_implemented\]/);
  });
});
