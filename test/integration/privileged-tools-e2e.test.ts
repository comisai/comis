/**
 * PRIVILEGED TOOLS E2E: Agent Lifecycle, Memory Management, and Session Management.
 *
 * Validates all privileged management RPC methods against a running daemon:
 *
 * AGENT LIFECYCLE (TEST-07):
 *   TEST-07-01: agents.list returns configured agents
 *   TEST-07-02: agents.get returns agent config and state
 *   TEST-07-03: agents.create creates a new runtime agent
 *   TEST-07-04: agents.update patches an existing agent config
 *   TEST-07-05: agents.suspend suspends an agent
 *   TEST-07-06: agents.resume resumes a suspended agent
 *   TEST-07-07: agents.delete removes an agent
 *   TEST-07-08: agents.create with existing ID returns error
 *
 * MEMORY MANAGEMENT (TEST-08 - Memory):
 *   TEST-08-M01: memory.stats returns stats shape
 *   TEST-08-M02: memory.store creates entries
 *   TEST-08-M03: memory.browse lists entries with pagination
 *   TEST-08-M04: memory.export returns all entries as JSON
 *   TEST-08-M05: memory.delete removes entries by ID
 *   TEST-08-M06: memory.flush clears all entries
 *
 * SESSION MANAGEMENT (TEST-08 - Sessions):
 *   TEST-08-S01: session.list returns sessions shape
 *   TEST-08-S02: session seed and export returns messages (seeded via sessionStoreBridge)
 *   TEST-08-S03: session.compact returns compaction status for seeded session
 *   TEST-08-S04: session.reset clears messages for seeded session
 *   TEST-08-S05: session.delete removes seeded session
 *   TEST-08-S06: session.list with kind filter returns proper shape
 *   TEST-08-S07: session.export returns error for non-existent session
 *
 * Uses a dedicated config (port 8523, separate memory DB) to avoid conflicts.
 * Accesses daemon internals directly: rpcCall, sessionStoreBridge.
 * No LLM keys needed -- tests exercise RPC dispatch directly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-privileged-tools-e2e.yaml",
);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("PRIVILEGED TOOLS E2E: Agent, Memory, and Session Management", () => {
  let handle: TestDaemonHandle;
  let rpcCall: TestDaemonHandle["daemon"]["rpcCall"];
  let sessionStoreBridge: NonNullable<TestDaemonHandle["daemon"]["sessionStoreBridge"]>;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });

    // Access internal rpcCall from daemon instance
    rpcCall = handle.daemon.rpcCall;
    expect(rpcCall).toBeDefined();

    // Access sessionStoreBridge for session seeding
    sessionStoreBridge = handle.daemon.sessionStoreBridge!;
    expect(sessionStoreBridge).toBeDefined();
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // =========================================================================
  // Section 1: Agent Lifecycle Management (TEST-07)
  // =========================================================================

  describe.sequential("Agent Lifecycle Management (TEST-07)", () => {
    it(
      "TEST-07-01: agents.list returns configured agents",
      async () => {
        const result = (await rpcCall("agents.list", {})) as {
          agents: string[];
        };

        expect(result).toBeDefined();
        expect(Array.isArray(result.agents)).toBe(true);
        expect(result.agents).toContain("default");
        expect(result.agents).toContain("helper");
        expect(result.agents.length).toBe(2);
      },
      10_000,
    );

    it(
      "TEST-07-02: agents.get returns agent config and state",
      async () => {
        const result = (await rpcCall("agents.get", {
          agentId: "default",
        })) as {
          agentId: string;
          config: {
            name: string;
            model: string;
            provider: string;
            maxSteps: number;
          };
          suspended: boolean;
          isDefault: boolean;
        };

        expect(result).toBeDefined();
        expect(result.agentId).toBe("default");
        expect(result.config.name).toBe("TestAgent");
        expect(result.config.model).toBe("claude-opus-4-6");
        expect(result.config.provider).toBe("anthropic");
        expect(result.config.maxSteps).toBe(10);
        expect(result.suspended).toBe(false);
        expect(result.isDefault).toBe(true);
      },
      10_000,
    );

    it(
      "TEST-07-03: agents.create creates a new runtime agent",
      async () => {
        const createResult = (await rpcCall("agents.create", {
          agentId: "e2e-test-agent",
          config: {
            name: "E2E Agent",
            model: "claude-opus-4-6",
            provider: "anthropic",
            maxSteps: 3,
          },
          _trustLevel: "admin",
        })) as {
          agentId: string;
          config: { name: string; maxSteps: number };
          created: boolean;
        };

        expect(createResult.agentId).toBe("e2e-test-agent");
        expect(createResult.created).toBe(true);
        expect(createResult.config.name).toBe("E2E Agent");
        expect(createResult.config.maxSteps).toBe(3);

        // Verify agent appears in list
        const listResult = (await rpcCall("agents.list", {})) as {
          agents: string[];
        };
        expect(listResult.agents).toContain("e2e-test-agent");
        expect(listResult.agents.length).toBe(3);

        // Verify agent.get returns correct config
        const getResult = (await rpcCall("agents.get", {
          agentId: "e2e-test-agent",
        })) as {
          agentId: string;
          config: { name: string; model: string; maxSteps: number };
          isDefault: boolean;
        };
        expect(getResult.config.name).toBe("E2E Agent");
        expect(getResult.config.model).toBe("claude-opus-4-6");
        expect(getResult.config.maxSteps).toBe(3);
        expect(getResult.isDefault).toBe(false);
      },
      10_000,
    );

    it(
      "TEST-07-04: agents.update patches an existing agent config",
      async () => {
        const updateResult = (await rpcCall("agents.update", {
          agentId: "e2e-test-agent",
          config: { name: "Updated E2E Agent" },
          _trustLevel: "admin",
        })) as {
          agentId: string;
          config: { name: string; maxSteps: number };
          updated: boolean;
        };

        expect(updateResult.agentId).toBe("e2e-test-agent");
        expect(updateResult.updated).toBe(true);
        expect(updateResult.config.name).toBe("Updated E2E Agent");

        // Verify name changed via agents.get
        const getResult = (await rpcCall("agents.get", {
          agentId: "e2e-test-agent",
        })) as {
          config: { name: string; maxSteps: number };
        };
        expect(getResult.config.name).toBe("Updated E2E Agent");
        // maxSteps should be preserved from create
        expect(getResult.config.maxSteps).toBe(3);
      },
      10_000,
    );

    it(
      "TEST-07-05: agents.suspend suspends an agent",
      async () => {
        const suspendResult = (await rpcCall("agents.suspend", {
          agentId: "e2e-test-agent",
          _trustLevel: "admin",
        })) as {
          agentId: string;
          suspended: boolean;
        };

        expect(suspendResult.agentId).toBe("e2e-test-agent");
        expect(suspendResult.suspended).toBe(true);

        // Verify suspended state via agents.get
        const getResult = (await rpcCall("agents.get", {
          agentId: "e2e-test-agent",
        })) as {
          suspended: boolean;
        };
        expect(getResult.suspended).toBe(true);
      },
      10_000,
    );

    it(
      "TEST-07-06: agents.resume resumes a suspended agent",
      async () => {
        const resumeResult = (await rpcCall("agents.resume", {
          agentId: "e2e-test-agent",
          _trustLevel: "admin",
        })) as {
          agentId: string;
          resumed: boolean;
        };

        expect(resumeResult.agentId).toBe("e2e-test-agent");
        expect(resumeResult.resumed).toBe(true);

        // Verify no longer suspended via agents.get
        const getResult = (await rpcCall("agents.get", {
          agentId: "e2e-test-agent",
        })) as {
          suspended: boolean;
        };
        expect(getResult.suspended).toBe(false);
      },
      10_000,
    );

    it(
      "TEST-07-07: agents.delete removes an agent",
      async () => {
        const deleteResult = (await rpcCall("agents.delete", {
          agentId: "e2e-test-agent",
          _trustLevel: "admin",
        })) as {
          agentId: string;
          deleted: boolean;
        };

        expect(deleteResult.agentId).toBe("e2e-test-agent");
        expect(deleteResult.deleted).toBe(true);

        // Verify agent no longer in list
        const listResult = (await rpcCall("agents.list", {})) as {
          agents: string[];
        };
        expect(listResult.agents).not.toContain("e2e-test-agent");
        expect(listResult.agents.length).toBe(2);

        // Verify agents.get throws for deleted agent
        await expect(
          rpcCall("agents.get", { agentId: "e2e-test-agent" }),
        ).rejects.toThrow(/Agent not found/);
      },
      10_000,
    );

    it(
      "TEST-07-08: agents.create with existing ID returns error",
      async () => {
        await expect(
          rpcCall("agents.create", {
            agentId: "default",
            config: {
              name: "Duplicate",
              model: "claude-opus-4-6",
              provider: "anthropic",
            },
            _trustLevel: "admin",
          }),
        ).rejects.toThrow(/Agent already exists/);
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 2: Memory Management (TEST-08 - Memory)
  // =========================================================================

  describe.sequential("Memory Management (TEST-08 - Memory)", () => {
    /** Track stored entry IDs for deletion tests. */
    const storedEntryIds: string[] = [];

    it(
      "TEST-08-M01: memory.stats returns stats shape",
      async () => {
        const result = (await rpcCall("memory.stats", {})) as Record<
          string,
          unknown
        >;

        expect(result).toBeDefined();
        // Stats should have numeric fields (exact shape depends on MemoryApi.stats)
        expect(typeof result).toBe("object");
      },
      10_000,
    );

    it(
      "TEST-08-M02: memory.store creates entries",
      async () => {
        // Store 3 test entries
        const entry1 = (await rpcCall("memory.store", {
          content: "Test memory entry one for E2E testing",
          tags: ["e2e-test", "entry-one"],
        })) as { stored: boolean; id: string };

        expect(entry1.stored).toBe(true);
        expect(typeof entry1.id).toBe("string");
        storedEntryIds.push(entry1.id);

        const entry2 = (await rpcCall("memory.store", {
          content: "Test memory entry two for E2E testing",
          tags: ["e2e-test", "entry-two"],
        })) as { stored: boolean; id: string };

        expect(entry2.stored).toBe(true);
        expect(typeof entry2.id).toBe("string");
        storedEntryIds.push(entry2.id);

        const entry3 = (await rpcCall("memory.store", {
          content: "Test memory entry three for E2E testing",
          tags: ["e2e-test", "entry-three"],
        })) as { stored: boolean; id: string };

        expect(entry3.stored).toBe(true);
        expect(typeof entry3.id).toBe("string");
        storedEntryIds.push(entry3.id);

        expect(storedEntryIds.length).toBe(3);
      },
      10_000,
    );

    it(
      "TEST-08-M03: memory.browse lists entries with pagination",
      async () => {
        // Browse with limit 2
        const result = (await rpcCall("memory.browse", {
          limit: 2,
        })) as {
          entries: Array<{
            id: string;
            content: string;
            trustLevel: string;
            tags: string[];
            agentId: string;
            createdAt: number;
          }>;
          total: number;
          offset: number;
          limit: number;
          hasMore: boolean;
        };

        expect(result).toBeDefined();
        expect(Array.isArray(result.entries)).toBe(true);
        expect(result.entries.length).toBeLessThanOrEqual(2);
        expect(typeof result.total).toBe("number");
        expect(result.offset).toBe(0);
        expect(result.limit).toBe(2);

        // Verify entry shape
        for (const entry of result.entries) {
          expect(typeof entry.id).toBe("string");
          expect(typeof entry.content).toBe("string");
          expect(typeof entry.trustLevel).toBe("string");
          expect(Array.isArray(entry.tags)).toBe(true);
          expect(typeof entry.createdAt).toBe("number");
        }

        // Browse with offset
        const page2 = (await rpcCall("memory.browse", {
          limit: 2,
          offset: 2,
        })) as {
          entries: Array<{ id: string }>;
          total: number;
          offset: number;
        };

        expect(page2.offset).toBe(2);
        // Should have remaining entries (1 more from the 3 we stored)
        expect(page2.entries.length).toBeGreaterThanOrEqual(0);
      },
      10_000,
    );

    it(
      "TEST-08-M04: memory.export returns all entries as JSON",
      async () => {
        const result = (await rpcCall("memory.export", {})) as {
          entries: Array<{
            id: string;
            content: string;
            trustLevel: string;
            tags: string[];
            agentId: string;
            userId: string;
            source: Record<string, unknown>;
            createdAt: number;
          }>;
          total: number;
          offset: number;
          limit: number;
        };

        expect(result).toBeDefined();
        expect(Array.isArray(result.entries)).toBe(true);
        expect(result.total).toBeGreaterThanOrEqual(3);

        // Verify export returns full untruncated content
        const testEntries = result.entries.filter((e) =>
          e.content.includes("E2E testing"),
        );
        expect(testEntries.length).toBe(3);

        // Verify export entry shape includes more fields than browse
        for (const entry of testEntries) {
          expect(typeof entry.id).toBe("string");
          expect(typeof entry.content).toBe("string");
          expect(typeof entry.userId).toBe("string");
          expect(typeof entry.source).toBe("object");
        }
      },
      10_000,
    );

    it(
      "TEST-08-M05: memory.delete removes entries by ID",
      async () => {
        // Delete the third entry
        const entryToDelete = storedEntryIds[2]!;
        const deleteResult = (await rpcCall("memory.delete", {
          ids: [entryToDelete],
          _trustLevel: "admin",
        })) as {
          deleted: number;
          failed: number;
          total: number;
        };

        expect(deleteResult.deleted).toBe(1);
        expect(deleteResult.failed).toBe(0);
        expect(deleteResult.total).toBe(1);

        // Verify the entry is gone from browse
        const browseResult = (await rpcCall("memory.browse", {
          limit: 100,
        })) as {
          entries: Array<{ id: string }>;
          total: number;
        };

        const deletedEntry = browseResult.entries.find(
          (e) => e.id === entryToDelete,
        );
        expect(deletedEntry).toBeUndefined();
      },
      10_000,
    );

    it(
      "TEST-08-M06: memory.flush clears all entries",
      async () => {
        // Verify we have entries before flush
        const beforeStats = (await rpcCall("memory.stats", {})) as Record<
          string,
          unknown
        >;
        expect(beforeStats).toBeDefined();

        const beforeBrowse = (await rpcCall("memory.browse", {
          limit: 100,
        })) as { entries: unknown[]; total: number };
        expect(beforeBrowse.total).toBeGreaterThan(0);

        // Flush all entries
        const flushResult = (await rpcCall("memory.flush", { _trustLevel: "admin" })) as {
          flushed: boolean;
          entriesRemoved: number;
          scope: { tenantId: string; agentId: string | null };
        };

        expect(flushResult.flushed).toBe(true);
        expect(flushResult.entriesRemoved).toBeGreaterThan(0);
        expect(flushResult.scope.tenantId).toBe("test");

        // Verify browse returns empty after flush
        const afterBrowse = (await rpcCall("memory.browse", {
          limit: 100,
        })) as { entries: unknown[]; total: number };
        expect(afterBrowse.total).toBe(0);
        expect(afterBrowse.entries.length).toBe(0);
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 3: Session Management (TEST-08 - Sessions)
  // =========================================================================

  describe("Session Management (TEST-08 - Sessions)", () => {
    it(
      "TEST-08-S01: session.list returns sessions shape",
      async () => {
        const result = (await rpcCall("session.list", {})) as {
          sessions: Array<{
            sessionKey: string;
            userId: string;
            channelId: string;
            kind: string;
            updatedAt: number;
            createdAt: number;
          }>;
          total: number;
        };

        expect(result).toBeDefined();
        expect(Array.isArray(result.sessions)).toBe(true);
        expect(typeof result.total).toBe("number");
        expect(result.total).toBe(result.sessions.length);

        // Verify session shape if any exist
        for (const session of result.sessions) {
          expect(typeof session.sessionKey).toBe("string");
          expect(typeof session.userId).toBe("string");
          expect(typeof session.channelId).toBe("string");
          expect(["dm", "group", "sub-agent"]).toContain(session.kind);
          expect(typeof session.updatedAt).toBe("number");
          expect(typeof session.createdAt).toBe("number");
        }
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // Session Lifecycle (seeded via sessionStoreBridge)
    // -----------------------------------------------------------------------

    describe.sequential("Session Lifecycle (seeded)", () => {
      const SESSION_KEY = "test:e2e-session-user:e2e-channel";

      it(
        "TEST-08-S02: session seed and export returns messages",
        async () => {
          // 1. Seed a session via sessionStoreBridge
          sessionStoreBridge.saveByFormattedKey(SESSION_KEY, [
            { role: "user", content: "Hello from E2E" },
            { role: "assistant", content: "Hello back" },
          ]);

          // 2. Export the session via RPC
          const result = (await rpcCall("session.export", {
            session_key: SESSION_KEY,
            _trustLevel: "admin",
          })) as {
            sessionKey: string;
            messages: Array<{ role: string; content: string }>;
            metadata: Record<string, unknown>;
            messageCount: number;
            createdAt: number;
            updatedAt: number;
          };

          // 3. Assert export shape and content
          expect(result.sessionKey).toBe(SESSION_KEY);
          expect(result.messages).toHaveLength(2);
          expect(result.messageCount).toBe(2);
          expect(typeof result.createdAt).toBe("number");
          expect(typeof result.updatedAt).toBe("number");

          // 4. Assert messages contain the seeded content
          expect(result.messages[0]!.role).toBe("user");
          expect(result.messages[0]!.content).toBe("Hello from E2E");
          expect(result.messages[1]!.role).toBe("assistant");
          expect(result.messages[1]!.content).toBe("Hello back");
        },
        10_000,
      );

      it(
        "TEST-08-S03: session.compact returns compaction status for seeded session",
        async () => {
          // 1. Compact the session
          const result = (await rpcCall("session.compact", {
            session_key: SESSION_KEY,
          })) as {
            sessionKey: string;
            messageCount: number;
            estimatedTokens: number;
            compactionTriggered: boolean;
            instructions: string | null;
          };

          // 2. Assert compact response shape
          expect(result.sessionKey).toBe(SESSION_KEY);
          expect(result.messageCount).toBe(2);
          expect(typeof result.estimatedTokens).toBe("number");
          expect(result.estimatedTokens).toBeGreaterThan(0);
          expect(result.compactionTriggered).toBe(true);
          expect(result.instructions).toBeNull();
        },
        10_000,
      );

      it(
        "TEST-08-S04: session.reset clears messages for seeded session",
        async () => {
          // 1. Reset the session
          const result = (await rpcCall("session.reset", {
            session_key: SESSION_KEY,
            _trustLevel: "admin",
          })) as {
            sessionKey: string;
            reset: boolean;
            previousMessageCount: number;
          };

          // 2. Assert reset response
          expect(result.sessionKey).toBe(SESSION_KEY);
          expect(result.reset).toBe(true);
          expect(result.previousMessageCount).toBe(2);

          // 3. Verify by exporting: messages should be empty
          const exported = (await rpcCall("session.export", {
            session_key: SESSION_KEY,
            _trustLevel: "admin",
          })) as {
            messages: unknown[];
            messageCount: number;
          };
          expect(exported.messages).toHaveLength(0);
          expect(exported.messageCount).toBe(0);
        },
        10_000,
      );

      it(
        "TEST-08-S05: session.delete removes seeded session",
        async () => {
          // 1. Delete the session
          const result = (await rpcCall("session.delete", {
            session_key: SESSION_KEY,
            _trustLevel: "admin",
          })) as {
            sessionKey: string;
            deleted: boolean;
            transcript: {
              messages: unknown[];
              metadata: Record<string, unknown>;
              messageCount: number;
            };
          };

          // 2. Assert delete response
          expect(result.sessionKey).toBe(SESSION_KEY);
          expect(result.deleted).toBe(true);
          expect(result.transcript).toBeDefined();
          expect(result.transcript.messageCount).toBe(0); // Was reset above

          // 3. Verify: export should now throw "Session not found"
          await expect(
            rpcCall("session.export", { session_key: SESSION_KEY, _trustLevel: "admin" }),
          ).rejects.toThrow(/Session not found/);
        },
        10_000,
      );
    });

    it(
      "TEST-08-S06: session.list with kind filter returns proper shape",
      async () => {
        // dm filter
        const dmResult = (await rpcCall("session.list", {
          kind: "dm",
        })) as { sessions: unknown[]; total: number };
        expect(Array.isArray(dmResult.sessions)).toBe(true);
        expect(typeof dmResult.total).toBe("number");

        // group filter
        const groupResult = (await rpcCall("session.list", {
          kind: "group",
        })) as { sessions: unknown[]; total: number };
        expect(Array.isArray(groupResult.sessions)).toBe(true);

        // sub-agent filter
        const subAgentResult = (await rpcCall("session.list", {
          kind: "sub-agent",
        })) as { sessions: unknown[]; total: number };
        expect(Array.isArray(subAgentResult.sessions)).toBe(true);
      },
      10_000,
    );

    it(
      "TEST-08-S07: session.export returns error for non-existent session",
      async () => {
        await expect(
          rpcCall("session.export", {
            session_key: "test:nonexistent:nonexistent",
            _trustLevel: "admin",
          }),
        ).rejects.toThrow(/Session not found/);
      },
      10_000,
    );
  });
});
