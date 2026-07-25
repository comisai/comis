// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the bootstrap crash-recovery sweep.
 *
 * Drives `bootstrapLcdSweep` — a thin trigger that
 * runs the EXISTING `ingestTurnGuarded` (lcd-ingest.ts:269) inside
 * `runOnConversation` at SESSION START (not only at afterTurn). The recovery
 * logic is the existing epoch-cursor continue-append; the new code is only the
 * bootstrap trigger + a distinct content-free event/log. So the assertions here
 * pin the TRIGGER contract, not the (already-tested) ingest engine:
 *
 *  - "crash recovery: gap recovered exactly once" (LOAD-BEARING) — simulate a
 *    mid-turn crash: the store + cursor.ingestedLiveLen are BELOW live.length
 *    (the afterTurn never ran for the last N messages), live[0] anchor MATCHES
 *    the stored cursor (same epoch). The sweep continue-appends the N-message
 *    gap and bumps the cursor to live.length — once.
 *  - "no double-append: sweep + subsequent afterTurn" (LOAD-BEARING) — after the
 *    sweep recovers the gap, a SECOND ingestTurnGuarded (the simulated afterTurn)
 *    with the SAME live array appends zero further rows (the cursor guard).
 *  - "fail-closed ambiguous identity" (LOAD-BEARING) — conversationRef≠sessionKey
 *    → ingestTurnGuarded refuses (isScopeSafeForIngest); the sweep fires the
 *    onFailClosed path → a content-free context:dag_degraded reason
 *    "fail_closed_rollover" is emitted, and NOTHING is written.
 *  - "no-op steady-state" — persisted == cursor.ingestedLiveLen == live.length →
 *    the sweep appends nothing (byte-identical to not running it).
 *  - "pipeline-mode / store-absent → no-op" — store undefined OR
 *    shouldRunContextStorePasses(config)===false → no store read, no event.
 *  - "rebase continuation emits session_rebase" — live[0] anchor DIFFERS from the
 *    stored cursor (JSONL re-based) → the sweep continue-appends at the store's
 *    current max seq and fires onRebase → context:dag_degraded reason
 *    "session_rebase" (the same rebase path the afterTurn ingest takes, reachable
 *    at bootstrap too).
 *
 * The store is the REAL `createLcdStore(new Database(":memory:"))` for the
 * recovery-fidelity cases — `@comis/memory` is an agent devDependency, allowed in
 * `.test.ts` only (the agent↛memory cut) — so the crash sim drives the genuine
 * persisted count + durable cursor, not a hand-rolled stub. A spy
 * ContextStorePort (never read) covers the pipeline/store-absent no-op.
 */
import {
  type AppendMessageInput,
  type ContextStorePort,
  type ContextStoreScope,
  type ConversationRef,
  type TypedEventBus,
} from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";
import { initSchema, createLcdStore } from "@comis/memory";
import { describe, it, expect, vi } from "vitest";
import { bootstrapLcdSweep } from "./lcd-bootstrap-sweep.js";
import { ingestTurnGuarded, messageEpochAnchor } from "./lcd-ingest.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = 1000;
const CONVERSATION_ID = `cv_${"b".repeat(43)}` as ConversationRef;

const SCOPE: ContextStoreScope = {
  conversationRef: CONVERSATION_ID,
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "tenant_a:agent_a:user_a:channel_a",
};

/** A fixed wall clock — the sweep reads `clock.now()` (never Date.now()). */
const clock = { now: () => FIXED_NOW };

/** Canonical context assembly is enabled. */
const canonicalConfig = { contextEngine: { enabled: true } };

function userMsg(ts: number, text: string): AgentMessage {
  return { role: "user", timestamp: ts, content: text } as unknown as AgentMessage;
}

function assistantMsg(ts: number, text: string): AgentMessage {
  return {
    role: "assistant",
    timestamp: ts,
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

/** A recording ContextStorePort spy whose reads are tracked (for the no-op cases). */
function makeSpyStore(): {
  store: ContextStorePort;
  appended: AppendMessageInput[];
  getMessagesCalls: number;
  runOnConversationCalls: number;
  reads: () => number;
} {
  const appended: AppendMessageInput[] = [];
  let getMessagesCalls = 0;
  let runOnConversationCalls = 0;
  let cursor: { epochAnchor: string; ingestedLiveLen: number } | null = null;
  const store: ContextStorePort = {
    append(input: AppendMessageInput): void {
      appended.push(input);
    },
    getMessages() {
      getMessagesCalls += 1;
      return [];
    },
    getIngestCursor(_scope: ContextStoreScope) {
      return cursor;
    },
    upsertIngestCursor(_scope: ContextStoreScope, c: { epochAnchor: string; ingestedLiveLen: number }) {
      cursor = { ...c };
    },
    async runOnConversation<T>(_id: string, fn: () => T | Promise<T>): Promise<T> {
      runOnConversationCalls += 1;
      return fn();
    },
    deleteConversationLcd() {
      return 0;
    },
  } as unknown as ContextStorePort;
  return {
    store,
    appended,
    get getMessagesCalls() {
      return getMessagesCalls;
    },
    get runOnConversationCalls() {
      return runOnConversationCalls;
    },
    reads: () => getMessagesCalls + runOnConversationCalls,
  };
}

/** A vi.fn() eventBus that records emitted (event, payload) pairs. */
function makeEventBus(): { eventBus: TypedEventBus; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  const eventBus = { emit, on: vi.fn(), off: vi.fn() } as unknown as TypedEventBus;
  return { eventBus, emit };
}

/** Find a context:dag_degraded emit by its closed-union reason. */
function degradedEmits(emit: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return emit.mock.calls
    .filter((c) => c[0] === "context:dag_degraded")
    .map((c) => c[1] as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrapLcdSweep (bootstrap crash-recovery sweep)", () => {
  it("crash recovery: gap recovered exactly once (mid-turn crash after JSONL write, before afterTurn)", async () => {
    // Arrange a crashed mid-turn: the store holds 3 persisted rows + a cursor
    // that says only 3 live messages were ingested (the afterTurn for the last 2
    // never ran because the daemon was killed after the JSONL write). The live
    // transcript (JSONL-loaded at session start) holds all 5 — same epoch.
    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const logger = createMockLogger();
    const { eventBus, emit } = makeEventBus();

    // The full 5-message live transcript reloaded from JSONL.
    const live: AgentMessage[] = [
      userMsg(1, "u0"),
      assistantMsg(2, "a0"),
      userMsg(3, "u1"),
      assistantMsg(4, "a1"),
      userMsg(5, "u2"), // the last user message — written to JSONL, not yet in LCD
    ];

    // Pre-crash state: only the first 3 messages reached the durable LCD store
    // (the afterTurn ran for the first turn, then the daemon crashed mid-second).
    ingestTurnGuarded(store, SCOPE, live.slice(0, 3), FIXED_NOW, logger);
    expect(store.getMessages(SCOPE).length).toBe(3);
    expect(store.getIngestCursor(SCOPE)!.ingestedLiveLen).toBe(3);

    // Act: session start → the bootstrap sweep runs with the FULL live array.
    await bootstrapLcdSweep({ store, scope: SCOPE, live, clock, logger, eventBus, config: canonicalConfig });

    // Assert: the 2-message gap is continue-appended (3 → 5), seqs continuous,
    // and the cursor bumps to live.length (5) — the exactly-once guard armed.
    const rows = store.getMessages(SCOPE);
    expect(rows.length).toBe(5);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(store.getIngestCursor(SCOPE)!.ingestedLiveLen).toBe(5);
    // A steady-state same-epoch catch-up is NOT a degradation → no fail/diverge/rebase event.
    expect(degradedEmits(emit)).toHaveLength(0);
  });

  it("no double-append: bootstrap sweep + subsequent afterTurn appends nothing more (cursor guard)", async () => {
    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const logger = createMockLogger();
    const { eventBus } = makeEventBus();

    const live: AgentMessage[] = [
      userMsg(1, "u0"),
      assistantMsg(2, "a0"),
      userMsg(3, "u1"),
      assistantMsg(4, "a1"),
      userMsg(5, "u2"),
    ];
    // Pre-crash: 3 persisted.
    ingestTurnGuarded(store, SCOPE, live.slice(0, 3), FIXED_NOW, logger);

    // Bootstrap sweep recovers the 2-message gap.
    await bootstrapLcdSweep({ store, scope: SCOPE, live, clock, logger, eventBus, config: canonicalConfig });
    expect(store.getMessages(SCOPE).length).toBe(5);

    // The subsequent afterTurn (same live array, no new messages this first turn)
    // must append ZERO further rows — delta = live.slice(ingestedLiveLen=5) = [].
    ingestTurnGuarded(store, SCOPE, live, FIXED_NOW, logger);

    const rows = store.getMessages(SCOPE);
    expect(rows.length).toBe(5); // still 5 — no duplicates
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]); // no seq collision
  });

  it("fail-closed ambiguous identity: refuses the import + emits a content-free fail_closed_rollover event, writes nothing", async () => {
    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const logger = createMockLogger();
    const { eventBus, emit } = makeEventBus();

    // Invalid opaque authority is refused before any write.
    const ambiguousScope: ContextStoreScope = {
      conversationRef: "conv-A" as ConversationRef,
      tenantId: "tenant_a",
      agentId: "agent_a",
      sessionKey: "conv-B",
    };
    const live: AgentMessage[] = [userMsg(1, "u0"), assistantMsg(2, "a0")];

    await bootstrapLcdSweep({ store, scope: ambiguousScope, live, clock, logger, eventBus, config: canonicalConfig });

    // Nothing written — the refuse path skips the append entirely.
    expect(store.getMessages(ambiguousScope).length).toBe(0);
    // A content-free context:dag_degraded reason:"fail_closed_rollover" fired —
    // identifiers + reason + durationMs only, NEVER message content.
    const fc = degradedEmits(emit).filter((p) => p.reason === "fail_closed_rollover");
    expect(fc).toHaveLength(1);
    expect(fc[0]).toMatchObject({
      conversationId: "conv-A",
      agentId: "agent_a",
      sessionKey: "conv-B",
      reason: "fail_closed_rollover",
    });
    expect(typeof fc[0]!.durationMs).toBe("number");
    // No recovered/message text leaks into the payload.
    expect(JSON.stringify(fc[0])).not.toContain("u0");
    expect(JSON.stringify(fc[0])).not.toContain("a0");
  });

  it("no-op steady-state: persisted == cursor == live.length → appends nothing (byte-identical to no sweep)", async () => {
    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const logger = createMockLogger();
    const { eventBus, emit } = makeEventBus();

    const live: AgentMessage[] = [userMsg(1, "u0"), assistantMsg(2, "a0"), userMsg(3, "u1")];
    // Fully caught up already (the common no-gap case).
    ingestTurnGuarded(store, SCOPE, live, FIXED_NOW, logger);
    expect(store.getMessages(SCOPE).length).toBe(3);

    // The sweep is a no-op — delta = live.slice(3) = [].
    await bootstrapLcdSweep({ store, scope: SCOPE, live, clock, logger, eventBus, config: canonicalConfig });

    expect(store.getMessages(SCOPE).length).toBe(3); // unchanged
    expect(degradedEmits(emit)).toHaveLength(0);
  });

  it("disabled context assembly skips the recovery sweep without reading the store", async () => {
    const { store, reads, appended } = makeSpyStore();
    const logger = createMockLogger();
    const { eventBus, emit } = makeEventBus();
    const live: AgentMessage[] = [userMsg(1, "u0"), assistantMsg(2, "a0")];

    await bootstrapLcdSweep({
      store,
      scope: SCOPE,
      live,
      clock,
      logger,
      eventBus,
      config: { contextEngine: { enabled: false } },
    });

    // Disabled context assembly does no sweep work.
    expect(reads()).toBe(0);
    expect(appended).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rebase continuation: a re-based live[0] continue-appends at max seq + emits session_rebase (also reachable at bootstrap)", async () => {
    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const logger = createMockLogger();
    const { eventBus, emit } = makeEventBus();

    // Pre-existing epoch-A rows + cursor.
    const epochA: AgentMessage[] = [userMsg(1, "epoch-a u0"), assistantMsg(2, "epoch-a a0")];
    ingestTurnGuarded(store, SCOPE, epochA, FIXED_NOW, logger);
    expect(store.getMessages(SCOPE).length).toBe(2);

    // Session restart with a FRESH, disjoint JSONL (different timestamps → a
    // different live[0] anchor → a detected re-base).
    const epochB: AgentMessage[] = [userMsg(9_000_000, "epoch-b u0"), assistantMsg(9_000_001, "epoch-b a0")];
    expect(messageEpochAnchor(epochB[0]!)).not.toBe(messageEpochAnchor(epochA[0]!));

    await bootstrapLcdSweep({ store, scope: SCOPE, live: epochB, clock, logger, eventBus, config: canonicalConfig });

    // Continue-append at the store's current max seq (2 → 4); seqs 2,3 added.
    const rows = store.getMessages(SCOPE);
    expect(rows.length).toBe(4);
    expect(rows[2]!.seq).toBe(2);
    expect(rows[3]!.seq).toBe(3);
    // A content-free session_rebase fired (a correct continuation, not corruption).
    const rebase = degradedEmits(emit).filter((p) => p.reason === "session_rebase");
    expect(rebase).toHaveLength(1);
    expect(rebase[0]).toMatchObject({ conversationId: CONVERSATION_ID, reason: "session_rebase" });
  });
});
