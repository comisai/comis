// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for session.history deliveryStatus join semantics.
 *
 * Pins the join semantics in isolation:
 *
 *   - INBOUND messages (role "user") are ALWAYS confirmed -- they were received
 *     from the channel, not sent. No queue lookup needed.
 *   - OUTBOUND messages (role "assistant" / "tool") are confirmed when there is
 *     NO matching pending/in_flight/failed delivery-queue entry for the session's
 *     channelId + the message body text. They are "pending" iff a matching queue
 *     entry exists -- meaning the channel-adapter has not yet successfully
 *     delivered that outbound message.
 *   - When `deliveryQueue` dep is absent (legacy / non-channel-bound deployments),
 *     every message is reported as `confirmed` -- nothing to mark pending.
 *   - The join is opaque on the session.history handler interface: the field
 *     is purely derived, the schema-additive `deliveryStatus?` field is NEVER
 *     missing from the handler output (handler always sets it, even when it is
 *     "confirmed"). The downstream MCP resources/read filter relies on every
 *     entry carrying a definite value.
 *
 * This test isolates the join via the session-read handler factory; the
 * surface MCP behavior is exercised end-to-end in
 * `test/integration/mcp-server-resources.test.ts`.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { bindSessionReadHandlers } from "./session-read.js";
import type { SessionHandlerDeps } from "./session-helpers.js";
import { ok } from "@comis/shared";
import type { DeliveryQueueEntry, DeliveryQueuePort } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_KEY = "test:user-1:chan-A";

interface SeededSession {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

function makeSession(): SeededSession {
  return {
    messages: [
      // Inbound user message -- always confirmed.
      { role: "user", content: "ping", timestamp: 1_700_000_000_000 },
      // Outbound assistant -- "delivered" => confirmed.
      { role: "assistant", content: "delivered-reply", timestamp: 1_700_000_001_000 },
      // Outbound assistant -- has a pending queue entry => pending.
      { role: "assistant", content: "pending-outbound", timestamp: 1_700_000_002_000 },
      // Outbound assistant -- has an in_flight queue entry => pending.
      { role: "assistant", content: "in-flight-outbound", timestamp: 1_700_000_003_000 },
      // Outbound assistant -- has a failed queue entry => pending.
      { role: "assistant", content: "failed-outbound", timestamp: 1_700_000_004_000 },
    ],
    metadata: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_004_000,
  };
}

/** Build a queue entry stub with only the fields the join consults. */
function makeQueueEntry(
  text: string,
  channelId: string,
  status: DeliveryQueueEntry["status"],
): DeliveryQueueEntry {
  return {
    id: `q-${text}`,
    text,
    channelType: "telegram",
    channelId,
    tenantId: "test",
    optionsJson: "{}",
    origin: "agent",
    status,
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: 0,
    scheduledAt: 0,
    expireAt: Number.MAX_SAFE_INTEGER,
    lastAttemptAt: null,
    nextRetryAt: null,
    lastError: null,
    traceId: null,
  };
}

function makeQueuePort(entries: DeliveryQueueEntry[]): DeliveryQueuePort {
  return {
    enqueue: vi.fn(),
    enqueueInFlight: vi.fn(),
    ack: vi.fn(),
    nack: vi.fn(),
    fail: vi.fn(),
    // Faithful to the real adapter: pendingEntries() is drainer-scoped and
    // returns ONLY status='pending'. The confirmed-only filter must NOT use it
    // (in_flight / failed would fall through as confirmed); it uses
    // unconfirmedEntries(), which returns every not-yet-delivered row. Keeping
    // pendingEntries narrow here makes these tests fail if the wiring regresses.
    pendingEntries: vi.fn(async () => ok(entries.filter((e) => e.status === "pending"))),
    unconfirmedEntries: vi.fn(async () => ok(entries.filter((e) => e.status !== "delivered"))),
    pruneExpired: vi.fn(),
    statusCounts: vi.fn(),
    recoverInFlight: vi.fn(),
  } as unknown as DeliveryQueuePort;
}

/**
 * Loose deps shape -- the test passes the new optional `deliveryQueue` field
 * to assert the join behavior. Typed as a partial record so the test
 * file compiles against both narrow and wide SessionHandlerDeps shapes.
 */
type TestDepsOverrides = Partial<SessionHandlerDeps> & {
  deliveryQueue?: DeliveryQueuePort;
};

function makeDeps(
  overrides: TestDepsOverrides = {},
): SessionHandlerDeps {
  const sessionData = makeSession();
  const base = {
    defaultAgentId: "default",
    agents: {
      default: { name: "TestAgent", model: "test-model" } as SessionHandlerDeps["agents"][string],
    },
    costTrackers: new Map(),
    stepCounters: new Map(),
    defaultWorkspaceDir: "",
    sessionStore: {
      listDetailed: () => [],
      loadByFormattedKey: (key: string) =>
        key === SESSION_KEY ? sessionData : undefined,
      deleteByFormattedKey: () => false,
      saveByFormattedKey: vi.fn(),
    },
    crossSessionSender: { send: vi.fn() } as never,
    subAgentRunner: { spawn: vi.fn(), getRunStatus: vi.fn() } as never,
    securityConfig: { agentToAgent: { enabled: true, waitTimeoutMs: 5000 } },
    tenantId: "test",
    logger: {
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(),
      error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn(),
    } as unknown as SessionHandlerDeps["logger"],
    ...overrides,
  };
  return base as SessionHandlerDeps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session.history deliveryStatus join", () => {
  it("session.history handler marks inbound user-role messages as deliveryStatus confirmed regardless of delivery queue state", async () => {
    // Even when the inbound message text COINCIDENTALLY matches a queue entry,
    // user-role messages are inbound (received, not sent) and always confirmed.
    const queue = makeQueuePort([
      makeQueueEntry("ping", "chan-A", "pending"),
    ]);
    const deps = makeDeps({ deliveryQueue: queue });

    const handlers = bindSessionReadHandlers(deps);
    const r = (await handlers["session.history"]!({ session_key: SESSION_KEY })) as {
      messages: Array<{ role: string; content: string; deliveryStatus?: "confirmed" | "pending" }>;
    };

    const userMsg = r.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.deliveryStatus).toBe("confirmed");
  });

  it("session.history handler marks outbound messages with deliveryQueue.status delivered as deliveryStatus confirmed", async () => {
    // Queue holds an entry that no longer matches any outbound text in the
    // session -- as in real life where "delivered" rows are pruned/excluded
    // from pendingEntries(). The "delivered-reply" outbound text has NO
    // pending/in_flight/failed queue entry => confirmed.
    const queue = makeQueuePort([]);
    const deps = makeDeps({ deliveryQueue: queue });

    const handlers = bindSessionReadHandlers(deps);
    const r = (await handlers["session.history"]!({ session_key: SESSION_KEY })) as {
      messages: Array<{ role: string; content: string; deliveryStatus?: "confirmed" | "pending" }>;
    };

    const delivered = r.messages.find((m) => m.content === "delivered-reply");
    expect(delivered).toBeDefined();
    expect(delivered!.deliveryStatus).toBe("confirmed");
  });

  it("session.history handler marks outbound messages with deliveryQueue.status pending or in_flight or failed as deliveryStatus pending", async () => {
    const queue = makeQueuePort([
      makeQueueEntry("pending-outbound", "chan-A", "pending"),
      makeQueueEntry("in-flight-outbound", "chan-A", "in_flight"),
      makeQueueEntry("failed-outbound", "chan-A", "failed"),
    ]);
    const deps = makeDeps({ deliveryQueue: queue });

    const handlers = bindSessionReadHandlers(deps);
    const r = (await handlers["session.history"]!({ session_key: SESSION_KEY })) as {
      messages: Array<{ role: string; content: string; deliveryStatus?: "confirmed" | "pending" }>;
    };

    const pending = r.messages.find((m) => m.content === "pending-outbound");
    const inflight = r.messages.find((m) => m.content === "in-flight-outbound");
    const failed = r.messages.find((m) => m.content === "failed-outbound");
    expect(pending?.deliveryStatus).toBe("pending");
    expect(inflight?.deliveryStatus).toBe("pending");
    expect(failed?.deliveryStatus).toBe("pending");
  });

  it("session.history handler emits deliveryStatus on every messages entry none missing derived field is mandatory after computation", async () => {
    // With an empty pendingEntries() result, every message must still carry
    // a definite deliveryStatus (all confirmed). The downstream MCP
    // resources/read filter relies on the field being set on every entry.
    const queue = makeQueuePort([]);
    const deps = makeDeps({ deliveryQueue: queue });

    const handlers = bindSessionReadHandlers(deps);
    const r = (await handlers["session.history"]!({ session_key: SESSION_KEY })) as {
      messages: Array<{ role: string; content: string; deliveryStatus?: "confirmed" | "pending" }>;
    };

    expect(r.messages.length).toBeGreaterThan(0);
    for (const m of r.messages) {
      expect(m.deliveryStatus).toBeDefined();
      expect(["confirmed", "pending"]).toContain(m.deliveryStatus);
    }
  });

  it("session.history handler defaults every message to confirmed when deliveryQueue dep is absent", async () => {
    // Deployments without a delivery queue (no channel adapters) report
    // every message as confirmed -- nothing to mark pending.
    const deps = makeDeps({ deliveryQueue: undefined });

    const handlers = bindSessionReadHandlers(deps);
    const r = (await handlers["session.history"]!({ session_key: SESSION_KEY })) as {
      messages: Array<{ role: string; content: string; deliveryStatus?: "confirmed" | "pending" }>;
    };

    expect(r.messages.length).toBeGreaterThan(0);
    for (const m of r.messages) {
      expect(m.deliveryStatus).toBe("confirmed");
    }
  });
});

// ---------------------------------------------------------------------------
// CR-02: agent-origin self-scoping. The tool.invoke rpc route injects
// `_agentId = lease.agentId` (setup-capability-endpoint.ts:321), so its
// PRESENCE is the unforgeable agent-origin signal (inbound _agentId is
// stripped from external callers). Without a self-scope, a jailed orch:read
// script reads ANY session's full transcript by session_key — cross-agent /
// cross-user exfiltration. The handler must mirror session.search's existing
// `_agentId` filter (session-list.ts:163-168): when `_agentId` is present,
// only the caller's own sessions are readable; when ABSENT (admin / operator
// / CLI, whose _agentId was stripped at the gateway), full access is
// preserved.
// ---------------------------------------------------------------------------
describe("session.history agent-origin self-scoping (CR-02)", () => {
  it("session.history denies an agent-origin caller reading a session that is not the caller's own", async () => {
    // _agentId is injected (agent-origin). The seeded session key
    // "test:user-1:chan-A" does not belong to the caller agent, so the read
    // must be refused content-free (a "not found"), NOT return the transcript.
    const deps = makeDeps({ deliveryQueue: makeQueuePort([]) });
    const handlers = bindSessionReadHandlers(deps);

    await expect(
      handlers["session.history"]!({
        session_key: SESSION_KEY,
        _agentId: "attacker-agent",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("session.history still returns the full transcript for an admin/operator call with NO _agentId injected", async () => {
    // No _agentId (the gateway stripped it for an external operator/CLI call):
    // full-access enumeration must be preserved — the fix must NOT break the
    // operator path.
    const deps = makeDeps({ deliveryQueue: makeQueuePort([]) });
    const handlers = bindSessionReadHandlers(deps);

    const r = (await handlers["session.history"]!({ session_key: SESSION_KEY })) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(r.messages.length).toBeGreaterThan(0);
  });
});
