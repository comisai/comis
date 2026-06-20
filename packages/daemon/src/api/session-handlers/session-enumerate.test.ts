// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the two JSONL scanners so the merge logic is exercised without the FS.
vi.mock("./session-helpers.js", async (orig) => {
  const actual = await orig<typeof import("./session-helpers.js")>();
  return { ...actual, scanJsonlSessions: vi.fn(), scanWorkspaceSessions: vi.fn() };
});

import { enumerateListableSessions } from "./session-list.js";
import { scanJsonlSessions, scanWorkspaceSessions } from "./session-helpers.js";
import type { SessionHandlerDeps } from "./session-helpers.js";

const wsEntry = (sessionKey: string) => ({
  sessionKey,
  messageCount: 1,
  updatedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  metadata: {},
});

beforeEach(() => vi.clearAllMocks());

describe("enumerateListableSessions", () => {
  it("merges workspace JSONL sessions absent from SQLite (session.search drift regression, live 2026-06-20)", () => {
    // SQLite is empty (the chat-API session is JSONL-only, written by the pi-agent
    // session manager to the workspace). Search mode used listDetailed() ALONE and
    // was blind to it → session.search returned 0 for content session.history could see.
    (scanJsonlSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (scanWorkspaceSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      wsEntry("default:openai-api:openai"),
    ]);
    const deps = {
      sessionStore: { listDetailed: () => [] },
      agentDataDir: "/data",
      agents: {},
      defaultWorkspaceDir: "/data/workspace",
    } as unknown as SessionHandlerDeps;

    const keys = enumerateListableSessions(deps, undefined).map((s) => s.sessionKey);
    expect(keys).toContain("default:openai-api:openai");
  });

  it("de-dups: a session in BOTH SQLite and the workspace scan appears once", () => {
    (scanJsonlSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (scanWorkspaceSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      wsEntry("default:u:c"),
    ]);
    const deps = {
      sessionStore: { listDetailed: () => [wsEntry("default:u:c")] },
      agentDataDir: "/data",
      agents: {},
      defaultWorkspaceDir: "/data/workspace",
    } as unknown as SessionHandlerDeps;

    const keys = enumerateListableSessions(deps, undefined).map((s) => s.sessionKey);
    expect(keys.filter((k) => k === "default:u:c")).toHaveLength(1);
  });
});
