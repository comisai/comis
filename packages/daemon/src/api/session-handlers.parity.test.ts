// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { stableStringify } from "../../../../test/support/stable-stringify.js";
import {
  createSessionHandlers,
  type SessionHandlerDeps,
} from "./session-handlers.js";

/**
 * Phase 43 parity protection (FILE-SPLIT-04).
 *
 * These snapshots lock the byte-identical output of session-handlers.ts's
 * public-API factory BEFORE the Phase 43 split refactor lands.
 *
 * The post-refactor behavior MUST match these snapshots exactly. Any byte
 * change FAILS this test, which fails `pnpm test`, which fails the
 * per-commit gate.
 *
 * Captured: in Phase 43 Wave 7 sub-plan 43-07a Task 2. Subsequent split
 * commits in 43-07b must keep this test green. Per FILE-SPLIT-17 + OQ-5
 * (progressive deletion), this file is DELETED at the end of 43-07b's
 * session-handlers split commit once each new structure has at least one
 * independent behavior test per extracted module.
 *
 * Source-symbol surface as of capture (session-handlers.ts at the merge
 * base):
 *   value: createSessionHandlers
 *   type:  SessionHandlerDeps (re-exported from api/types.ts)
 *
 * The behavior matrix targets:
 *   1. Public API surface (createSessionHandlers + the returned handler-map's
 *      method names).
 *   2. Representative method invocations against a minimal-deps factory.
 *
 * Methods chosen for behavior snapshots:
 *   agents.list      (trivial; lists deps.agents keys)
 *   session.list     (returns empty list for empty session store)
 *   session.delete   (error path: session not found message)
 *   session.delete   (admin-trust guard rejection message)
 *   session.compact  (success path on a mock session)
 */

// ---------------------------------------------------------------------------
// Minimal deps factory: vi.fn() stubs only; no IO and no `vi.useFakeTimers()`
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<SessionHandlerDeps>): SessionHandlerDeps {
  const mockSessionData = {
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    metadata: { parentSessionKey: undefined } as Record<string, unknown>,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_060_000,
  };
  return {
    defaultAgentId: "default",
    agents: {
      default: { name: "Test", model: "test-model" } as SessionHandlerDeps["agents"][string],
    },
    costTrackers: new Map(),
    stepCounters: new Map(),
    sessionStore: {
      listDetailed: () => [],
      loadByFormattedKey: (key: string) =>
        key === "valid-session" ? mockSessionData : undefined,
      deleteByFormattedKey: (key: string) => key === "valid-session",
      saveByFormattedKey: vi.fn(),
    },
    crossSessionSender: { send: vi.fn() },
    subAgentRunner: { spawn: vi.fn(), getRunStatus: vi.fn() },
    securityConfig: { agentToAgent: { enabled: true, waitTimeoutMs: 5000 } },
    ...overrides,
  } as unknown as SessionHandlerDeps;
}

// ---------------------------------------------------------------------------
// Parity describe: sorted by (a) public-API surface (b) behavior matrix
// ---------------------------------------------------------------------------

describe("session-handlers parity (FILE-SPLIT-04)", () => {
  describe("public API surface", () => {
    it("createSessionHandlers: returned handler map has expected method names", () => {
      const handlers = createSessionHandlers(makeDeps());
      expect(stableStringify(Object.keys(handlers).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix: representative inputs", () => {
    it("agents.list: returns the deps.agents key set for a single-agent fixture", async () => {
      const handlers = createSessionHandlers(makeDeps());
      const result = await handlers["agents.list"]!({});
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("session.list: returns empty envelope for empty session store", async () => {
      const handlers = createSessionHandlers(makeDeps());
      const result = await handlers["session.list"]!({});
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("session.delete: throws expected error message for unknown session key with admin trust", async () => {
      const handlers = createSessionHandlers(makeDeps());
      let captured: unknown;
      try {
        await handlers["session.delete"]!({
          session_key: "no-such-session",
          _trustLevel: "admin",
        });
      } catch (e) {
        captured = (e as Error).message;
      }
      expect(stableStringify({ error: captured })).toMatchSnapshot();
    });

    it("session.delete: rejects with admin-trust error message when trust is missing", async () => {
      const handlers = createSessionHandlers(makeDeps());
      let captured: unknown;
      try {
        await handlers["session.delete"]!({ session_key: "valid-session" });
      } catch (e) {
        captured = (e as Error).message;
      }
      expect(stableStringify({ error: captured })).toMatchSnapshot();
    });

    it("session.compact: returns expected envelope for a valid session with instructions", async () => {
      const handlers = createSessionHandlers(makeDeps());
      const result = await handlers["session.compact"]!({
        session_key: "valid-session",
        instructions: "summarize the conversation",
      });
      expect(stableStringify(result)).toMatchSnapshot();
    });
  });
});
