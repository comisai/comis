// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import type { OutwardSendLedgerPort } from "@comis/core";
import type { DeadLetterQueueContext } from "./announcement-dead-letter-context.js";
import type { DeadLetterEntry, ParentDecisionReservationRecord } from "./announcement-dead-letter-file.js";
import { createDecisionStage } from "./announcement-dead-letter-decisions.js";

const authority = { tenantId: "default", agentId: "agent-a", conversationRef: "conversation-a" };
const endpoint = {
  channelType: "telegram",
  channelInstanceId: "test-instance",
  conversationId: "chat-a",
  conversationKind: "direct" as const,
};

function makeEntry(overrides: Record<string, unknown> = {}): DeadLetterEntry {
  return {
    id: "entry-a",
    announcementText: "completion",
    channelType: "telegram",
    channelId: "chat-a",
    agentId: "agent-a",
    runId: "run-a",
    sessionKey: "default:agent-a:telegram:chat-a:user_a",
    failedAt: 0,
    attemptCount: 0,
    lastAttemptAt: 0,
    idempotencyKey: "operation-a",
    rootRunId: "root-a",
    completionKeys: ["operation-a"],
    deliveryAuthority: authority,
    destinationEndpoint: endpoint,
    ...overrides,
  } as DeadLetterEntry;
}

function makeReservation(overrides: Record<string, unknown> = {}): ParentDecisionReservationRecord {
  const { attemptCount: _attemptCount, lastAttemptAt: _lastAttemptAt, ...entry } = makeEntry();
  return {
    ...entry,
    id: "reservation-a",
    recordType: "parent_decision_reservation",
    ...overrides,
  } as ParentDecisionReservationRecord;
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const store = {
    entries: [] as DeadLetterEntry[],
    decisionReservations: [] as ParentDecisionReservationRecord[],
    producerReservations: [], producerHandoffs: [], invalidRecords: [], terminalInvalidRecords: [],
  };
  const terminalDecisionStore = {
    lookup: vi.fn(async () => ok(undefined)),
    record: vi.fn(async () => ok(undefined)),
  };
  const decisionStore = {
    lookup: vi.fn(async () => ok(undefined)),
    resolve: vi.fn(async () => ok(true)),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    store,
    maxRetries: 5,
    maxAgeMs: Number.MAX_SAFE_INTEGER,
    logger,
    outwardLedger: undefined,
    terminalDecisionStore,
    decisionStore,
    persist: vi.fn(async () => ok(undefined)),
    cleanupUnreferencedSnapshots: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as DeadLetterQueueContext;
}

function makeLedger(overrides: Partial<OutwardSendLedgerPort> = {}): OutwardSendLedgerPort {
  return {
    lookupTerminalDecision: vi.fn(async () => ok(undefined)),
    recordTerminalDecision: vi.fn(async () => ok(undefined)),
    allocateStep: vi.fn(async () => ok(0)),
    lookup: vi.fn(async () => ok(undefined)),
    begin: vi.fn(async () => ok(undefined)),
    markUnknown: vi.fn(async () => ok(undefined)),
    reclaimPreSend: vi.fn(async () => ok(true)),
    commit: vi.fn(async () => ok(undefined)),
    markFailed: vi.fn(async () => ok(undefined)),
    parkUncertain: vi.fn(async () => ok(true)),
    hasUncertainty: vi.fn(async () => ok(false)),
    listUnreconciled: vi.fn(async () => ok([])),
    ...overrides,
  };
}

describe("dead-letter terminal-decision boundaries", () => {
  it("looks through group keys and propagates secondary lookup failures", async () => {
    let calls = 0;
    const context = makeContext({
      terminalDecisionStore: {
        lookup: vi.fn(async () => ++calls === 1
          ? ok(undefined)
          : err(new Error("terminal unavailable"))),
        record: vi.fn(async () => ok(undefined)),
      },
    });
    await expect(createDecisionStage(context).lookupTerminalDecision(makeEntry({
      terminalGroupKey: "group-a",
    }))).resolves.toMatchObject({ ok: false });
  });

  it("records grouped and completion terminal decisions and propagates failures", async () => {
    const groupFailure = makeContext({
      terminalDecisionStore: {
        lookup: vi.fn(async () => ok(undefined)),
        record: vi.fn(async () => err(new Error("terminal unavailable"))),
      },
    });
    await expect(createDecisionStage(groupFailure).terminalizeOwner(
      makeEntry({ terminalGroupKey: "group-a" }),
      "discarded",
      [],
      [],
    )).resolves.toMatchObject({ ok: false });

    let calls = 0;
    const completionFailure = makeContext({
      terminalDecisionStore: {
        lookup: vi.fn(async () => ok(undefined)),
        record: vi.fn(async () => ++calls === 2
          ? err(new Error("completion unavailable"))
          : ok(undefined)),
      },
    });
    await expect(createDecisionStage(completionFailure).terminalizeOwner(
      makeEntry({ completionKeys: ["operation-a", "completion-b"] }),
      "delivered",
      [],
      [],
    )).resolves.toMatchObject({ ok: false });
  });

  it("projects chunk owners only for complete unchunked identities", () => {
    const stage = createDecisionStage(makeContext());
    expect(stage.textChunkOwners(makeEntry({ textChunks: undefined }))).toEqual([]);
    const owners = stage.textChunkOwners(makeEntry({
      textChunks: ["first", "second"],
      completionKeys: ["operation-a", "completion-a"],
    }));
    expect(owners).toHaveLength(2);
    expect(owners[0]).toMatchObject({ announcementText: "first", completionKeys: ["completion-a"] });
    expect(stage.unresolvedChunkOperationId(makeEntry({
      lastError: `outward_operation_unresolved:${owners[0]?.idempotencyKey}`,
    }))).toBe(owners[0]?.idempotencyKey);
  });

  it("rejects conflicting and in-flight chunk releases", async () => {
    const conflict = makeContext({
      terminalDecisionStore: {
        lookup: vi.fn(async () => ok("discarded" as const)),
        record: vi.fn(async () => ok(undefined)),
      },
    });
    await expect(createDecisionStage(conflict).settleTextChunkRelease(
      makeEntry({ textChunks: ["first"] }),
      "delivered",
    )).resolves.toMatchObject({ ok: false });

    const entry = makeEntry({ textChunks: ["first"] });
    const ledger = makeLedger({
      lookup: vi.fn(async () => ok({ state: "send_attempt_started" } as never)),
    });
    const inFlight = makeContext({ outwardLedger: ledger });
    await expect(createDecisionStage(inFlight).settleTextChunkRelease(entry, "discarded"))
      .resolves.toMatchObject({ ok: false, error: { message: "Announcement chunk is still in flight" } });
  });

  it("propagates chunk allocation, lookup, terminalization, and retention persistence failures", async () => {
    const entry = makeEntry({ textChunks: ["first"] });
    const allocation = makeContext({
      outwardLedger: makeLedger({ allocateStep: vi.fn(async () => err(new Error("allocation unavailable"))) }),
    });
    await expect(createDecisionStage(allocation).settleTextChunkRelease(entry, "discarded"))
      .resolves.toMatchObject({ ok: false });

    const lookup = makeContext({
      outwardLedger: makeLedger({ lookup: vi.fn(async () => err(new Error("lookup unavailable"))) }),
    });
    await expect(createDecisionStage(lookup).settleTextChunkRelease(entry, "discarded"))
      .resolves.toMatchObject({ ok: false });

    const record = makeContext({
      outwardLedger: makeLedger({ recordTerminalDecision: vi.fn(async () => err(new Error("terminal unavailable"))) }),
    });
    await expect(createDecisionStage(record).settleTextChunkRelease(entry, "discarded"))
      .resolves.toMatchObject({ ok: false });

    const retention = makeContext({
      outwardLedger: makeLedger(),
      store: { ...makeContext().store, entries: [entry] },
      persist: vi.fn(async () => err(new Error("disk unavailable"))),
    });
    await expect(createDecisionStage(retention).settleTextChunkRelease(entry, "delivered"))
      .resolves.toMatchObject({ ok: false });
  });

  it("handles missing, conflicting, failed, and unpersisted decision resolutions", async () => {
    const missing = makeContext();
    await expect(createDecisionStage(missing).resolveDecisionDurably("missing", "no_reply"))
      .resolves.toEqual(ok(false));

    const reservation = makeReservation();
    const conflict = makeContext({
      decisionStore: { lookup: async () => ok(reservation), resolve: async () => ok(true) },
      terminalDecisionStore: { lookup: async () => ok("delivered" as const), record: async () => ok(undefined) },
    });
    conflict.store.decisionReservations = [reservation];
    await expect(createDecisionStage(conflict).resolveDecisionDurably("operation-a", "no_reply"))
      .resolves.toMatchObject({ ok: false, error: { message: "No-reply resolution conflicts with its durable outcome" } });

    const terminalFailure = makeContext({
      decisionStore: { lookup: async () => ok(reservation), resolve: async () => ok(true) },
      terminalDecisionStore: { lookup: async () => ok(undefined), record: async () => err(new Error("terminal unavailable")) },
    });
    terminalFailure.store.decisionReservations = [reservation];
    await expect(createDecisionStage(terminalFailure).resolveDecisionDurably("operation-a", "no_reply"))
      .resolves.toMatchObject({ ok: false });
    expect(terminalFailure.logger?.error).toHaveBeenCalledOnce();

    const persistence = makeContext({
      decisionStore: { lookup: async () => ok(reservation), resolve: async () => ok(true) },
      persist: async () => err(new Error("disk unavailable")),
    });
    persistence.store.decisionReservations = [reservation];
    await expect(createDecisionStage(persistence).resolveDecisionDurably("operation-a", "no_reply"))
      .resolves.toMatchObject({ ok: false });
  });
});
