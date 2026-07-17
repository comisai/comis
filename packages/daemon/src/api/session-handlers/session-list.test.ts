// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the session.list handler's agent-origin self-scoping.
 *
 * `session.list` enumerates every session's `{ sessionKey, agentId, userId,
 * channelId, ... }`. Its only pre-existing visibility narrowing is the
 * sub-agent `parentSessionKey` filter. The `tool.invoke` rpc route injects
 * `_agentId = lease.agentId` (setup-capability-endpoint.ts:321) but NOT the
 * `_callerMetadata`/`_callerSessionKey` the sub-agent filter needs, so for a
 * jailed orch:read caller that narrowing never fires — the script receives the
 * directory of EVERY agent's/user's sessions (the keys that turn a
 * single-session read into a turnkey cross-tenant exfiltration, plus a
 * userId/channelId enumeration leak in its own right).
 *
 * The fix mirrors the sibling session.search's existing `_agentId` filter
 * (session-list.ts:163-168): when `_agentId` is present (agent-origin, an
 * unforgeable signal — inbound `_agentId` is stripped at the gateway), only
 * the caller's own sessions are returned; when ABSENT (admin / operator / CLI)
 * the full directory is preserved.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { bindSessionListHandlers } from "./session-list.js";
import type { SessionHandlerDeps } from "./session-helpers.js";

// Two sessions across DIFFERENT tenants/users — the cross-tenant directory a
// jailed orch:read script must NOT be able to enumerate.
const OTHER_KEY = "victim-tenant:victim-user:telegram";
const ANOTHER_KEY = "other-tenant:other-user:discord";

interface DetailedEntry {
  sessionKey: string;
  tenantId: string;
  userId: string;
  channelId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

function entry(sessionKey: string, tenantId: string, userId: string, channelId: string): DetailedEntry {
  return {
    sessionKey,
    tenantId,
    userId,
    channelId,
    metadata: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messageCount: 3,
  };
}

function makeDeps(): SessionHandlerDeps {
  const detailed: DetailedEntry[] = [
    entry(OTHER_KEY, "victim-tenant", "victim-user", "telegram"),
    entry(ANOTHER_KEY, "other-tenant", "other-user", "discord"),
  ];
  const base = {
    defaultAgentId: "default",
    agents: { default: { name: "A", model: "m" } as SessionHandlerDeps["agents"][string] },
    costTrackers: new Map(),
    stepCounters: new Map(),
    defaultWorkspaceDir: "",
    agentDataDir: "",
    sessionStore: {
      listDetailed: () => detailed,
      loadByFormattedKey: () => undefined,
      deleteByFormattedKey: () => false,
      saveByFormattedKey: vi.fn(),
    },
    crossSessionSender: { send: vi.fn() } as never,
    subAgentRunner: { spawn: vi.fn(), getRunStatus: vi.fn() } as never,
    securityConfig: { agentToAgent: { enabled: true, waitTimeoutMs: 5000 } },
    tenantId: "victim-tenant",
    logger: {
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(),
      error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn(),
    } as unknown as SessionHandlerDeps["logger"],
  };
  return base as unknown as SessionHandlerDeps;
}

describe("session.list agent-origin self-scoping", () => {
  it("session.list returns the exact caller session even though formatted keys omit agent identity", async () => {
    const handlers = bindSessionListHandlers(makeDeps());
    const r = (await handlers["session.list"]!({
      _agentId: "jailed-agent",
      _callerSessionKey: OTHER_KEY,
    })) as {
      sessions: Array<{ sessionKey: string; agentId: string }>;
      total: number;
    };

    expect(r.sessions).toEqual([
      expect.objectContaining({ sessionKey: OTHER_KEY, agentId: "jailed-agent" }),
    ]);
    expect(r.total).toBe(1);
  });

  it("session.search searches the exact caller session without relying on an unserialized agent field", async () => {
    const deps = makeDeps();
    deps.sessionStore.loadByFormattedKey = vi.fn((key: string) => key === OTHER_KEY
      ? {
          messages: [{ role: "user", content: "caller-owned marker", timestamp: 10 }],
          metadata: {},
          createdAt: 1,
          updatedAt: 10,
        }
      : undefined);
    const handlers = bindSessionListHandlers(deps);

    const r = (await handlers["session.search"]!({
      query: "caller-owned",
      summarize: false,
      _agentId: "jailed-agent",
      _callerSessionKey: OTHER_KEY,
    })) as {
      results: Array<{ sessionKey: string; agentId: string }>;
      total: number;
    };

    expect(r.results).toEqual([
      expect.objectContaining({ sessionKey: OTHER_KEY, agentId: "jailed-agent" }),
    ]);
    expect(r.total).toBe(1);
  });

  it("session.list does NOT return other agents' sessions to an agent-origin caller (_agentId injected)", async () => {
    // An agent-origin caller (the orchestrate rpc route injects `_agentId`)
    // must never receive the cross-tenant directory. With agent-scoping the
    // enumerated keys are filtered to the caller's own — the victim/other
    // tenant keys must be absent.
    const handlers = bindSessionListHandlers(makeDeps());
    const r = (await handlers["session.list"]!({ _agentId: "jailed-agent" })) as {
      sessions: Array<{ sessionKey: string }>;
      total: number;
    };

    const keys = r.sessions.map((s) => s.sessionKey);
    expect(keys).not.toContain(OTHER_KEY);
    expect(keys).not.toContain(ANOTHER_KEY);
  });

  it("session.list returns the full session directory for an admin/operator call with NO _agentId", async () => {
    // No _agentId (the gateway stripped it for an external operator/CLI call):
    // full enumeration must be preserved — the fix must NOT break the operator
    // path.
    const handlers = bindSessionListHandlers(makeDeps());
    const r = (await handlers["session.list"]!({})) as {
      sessions: Array<{ sessionKey: string }>;
      total: number;
    };

    const keys = r.sessions.map((s) => s.sessionKey);
    expect(keys).toContain(OTHER_KEY);
    expect(keys).toContain(ANOTHER_KEY);
    expect(r.total).toBe(2);
  });
});
