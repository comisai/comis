// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { narrowManagedTerminalScope, prepareManagedTerminalWorkspaceGit } from "./terminal-managed-create.js";

describe("managed terminal scope narrowing", () => {
  it("retains operator-reviewed credential binds while forcing the leased workspace root", () => {
    expect(narrowManagedTerminalScope({
      filesystem: "home",
      network: "full",
      credentialPaths: ["/home/comis/.codex/auth.json"],
      ephemeralWritablePaths: ["/home/comis/.codex/runtime"],
      uid: "daemon",
    })).toEqual({
      filesystem: "workspace",
      network: "full",
      credentialPaths: ["/home/comis/.codex/auth.json"],
      ephemeralWritablePaths: ["/home/comis/.codex/runtime"],
      uid: "daemon",
    });
  });

  it("records private Git preparation failures before a managed launch", () => {
    const logs: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const result = prepareManagedTerminalWorkspaceGit({
      prepareManagedWorkspaceGit: () => ({ ok: false, error: new Error("invalid linked worktree") }),
      logger: { warn: (fields) => logs.push(fields) },
      eventBus: { emit: (_event, payload) => events.push(payload) },
      nowMs: () => 120,
      agentId: "agent_a",
    }, "/workspace", "codex", 100);

    expect(result).toEqual({
      ok: false,
      error: {
        message: "managed terminal workspace Git preparation failed: invalid linked worktree",
        hint: expect.stringContaining("no terminal was reserved or spawned"),
      },
    });
    expect(logs).toContainEqual(expect.objectContaining({
      durationMs: 20,
      errorKind: "precondition",
      step: "managed-git-prepare",
    }));
    expect(events).toContainEqual(expect.objectContaining({ errorKind: "precondition" }));
  });
});
