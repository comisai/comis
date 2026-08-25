// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { ConversationRefSchema, type AnnouncementProducerReservation } from "@comis/core";
import { err, ok } from "@comis/shared";
import {
  createProducerLifecycle,
  type ProducerLifecycleContext,
} from "./announcement-dead-letter-producer.js";
import type { DeadLetterRecordStore } from "./announcement-dead-letter-context.js";
import type {
  DeadLetterEntry,
  ProducerReservationRecord,
} from "./announcement-dead-letter-file.js";

const conversationRef = ConversationRefSchema.parse(`cv_${"d".repeat(43)}`);

function makeReservation(
  overrides: Partial<AnnouncementProducerReservation> = {},
): AnnouncementProducerReservation {
  return {
    idempotencyKey: "operation-a",
    agentId: "agent-a",
    runId: "producer-a",
    sessionKey: "default:agent-a:telegram:chat-a:user_a",
    announcementText: "completion",
    channelType: "telegram",
    channelId: "chat-a",
    failedAt: 100,
    rootRunId: "root-a",
    deliveryAuthority: {
      tenantId: "default",
      agentId: "agent-a",
      conversationRef,
    },
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "test-instance",
      conversationId: "chat-a",
      conversationKind: "direct",
    },
    completionKeys: ["operation-a"],
    producer: {
      kind: "session",
      tenantId: "default",
      agentId: "agent-a",
      conversationRef,
      checkpointId: "producer-a",
    },
    ...overrides,
  };
}

function makeRecord(
  lifecycleState: ProducerReservationRecord["lifecycleState"] = "active",
  overrides: Partial<ProducerReservationRecord> = {},
): ProducerReservationRecord {
  return {
    ...makeReservation(),
    recordType: "producer_reservation",
    id: "reservation-a",
    lifecycleState,
    ...overrides,
  };
}

function makeStore(
  overrides: Partial<DeadLetterRecordStore> = {},
): DeadLetterRecordStore {
  return {
    entries: [],
    decisionReservations: [],
    producerReservations: [],
    producerHandoffs: [],
    invalidRecords: [],
    terminalInvalidRecords: [],
    ...overrides,
  };
}

function makeHarness(overrides: Partial<ProducerLifecycleContext> = {}) {
  const store = overrides.store ?? makeStore();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const persist = overrides.persist ?? vi.fn(async () => ok(undefined));
  const activeProducerKeys = overrides.activeProducerKeys ?? new Set<string>();
  const signalCapacityChange = overrides.signalCapacityChange ?? vi.fn();
  const terminalizeOwner = overrides.terminalizeOwner ?? vi.fn(async () => ok(undefined));
  const cleanupUnreferencedSnapshots = overrides.cleanupUnreferencedSnapshots
    ?? vi.fn(async () => undefined);
  const context: ProducerLifecycleContext = {
    store,
    logger,
    activeProducerKeys,
    signalCapacityChange,
    loadFromDisk: async () => ok(undefined),
    persist,
    canPersistProducerOwnership: () => true,
    publicProducerReservation: (record) => record,
    terminalizeOwner,
    cleanupUnreferencedSnapshots,
    ...overrides,
  };
  return {
    store,
    logger,
    persist,
    activeProducerKeys,
    signalCapacityChange,
    terminalizeOwner,
    cleanupUnreferencedSnapshots,
    lifecycle: createProducerLifecycle(context),
  };
}

describe("announcement producer lifecycle boundaries", () => {
  it("rejects invalid, conflicting, over-capacity, and unwritable reservations", async () => {
    const invalidIdentity = makeHarness();
    expect((await invalidIdentity.lifecycle.reserveProducerDurably(
      makeReservation({ runId: "" }),
      false,
    )).ok).toBe(false);

    const invalidRoute = makeHarness();
    expect((await invalidRoute.lifecycle.reserveProducerDurably(
      makeReservation({ rootRunId: "" }),
      false,
    )).ok).toBe(false);

    const conflicting = makeHarness({
      store: makeStore({ producerReservations: [makeRecord()] }),
    });
    expect((await conflicting.lifecycle.reserveProducerDurably(
      makeReservation({ idempotencyKey: "operation-other" }),
      false,
    )).ok).toBe(false);

    const capacity = makeHarness({ canPersistProducerOwnership: () => false });
    expect((await capacity.lifecycle.reserveProducerDurably(makeReservation(), false)).ok)
      .toBe(false);

    for (const message of [
      "Dead-letter snapshot exceeds the row limit",
      "Dead-letter snapshot exceeds the byte limit",
    ]) {
      const unwritable = makeHarness({
        persist: async () => err(new Error(message)),
      });
      const result = await unwritable.lifecycle.reserveProducerDurably(makeReservation(), false);
      expect(result).toMatchObject({ ok: false, error: { message: "Announcement producer capacity exhausted" } });
    }
  });

  it("returns authoritative outcomes for every retained producer lifecycle state", async () => {
    for (const state of ["delivery_owned", "no_reply", "promotion_ready"] as const) {
      const harness = makeHarness({
        store: makeStore({ producerReservations: [makeRecord(state)] }),
        activeProducerKeys: new Set(["producer-a"]),
      });
      const result = await harness.lifecycle.reserveProducerDurably(makeReservation(), false);
      expect(result).toMatchObject({ ok: true, value: { status: "recovery_owned", lifecycleState: state } });
      expect(harness.activeProducerKeys.has("producer-a")).toBe(false);
    }

    const active = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("active")] }),
      activeProducerKeys: new Set(["producer-a"]),
    });
    await expect(active.lifecycle.reserveProducerDurably(makeReservation(), true))
      .resolves.toEqual(ok({ status: "recovery_owned", lifecycleState: "active" }));
  });

  it("finishes pending no-reply ownership only after terminalization and persistence", async () => {
    const failedTerminal = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("no_reply_pending")] }),
      terminalizeOwner: async () => err(new Error("terminal store unavailable")),
    });
    expect((await failedTerminal.lifecycle.reserveProducerDurably(makeReservation(), false)).ok)
      .toBe(false);

    const failedPersist = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("no_reply_pending")] }),
      persist: async () => err(new Error("snapshot unavailable")),
    });
    expect((await failedPersist.lifecycle.reserveProducerDurably(makeReservation(), false)).ok)
      .toBe(false);

    const completed = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("no_reply_pending")] }),
    });
    await expect(completed.lifecycle.reserveProducerDurably(makeReservation(), false))
      .resolves.toEqual(ok({ status: "recovery_owned", lifecycleState: "no_reply" }));
    expect(completed.store.producerReservations[0]?.lifecycleState).toBe("no_reply");
  });

  it("reclaims terminal producer facts and propagates retirement probe failures", async () => {
    const outcome = {
      kind: "session" as const,
      terminalReason: "completed" as const,
      completedAtMs: 123,
      summary: "finished",
    };
    const terminal = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("active")] }),
      retirementProducerState: async () => ok({
        status: "terminal" as const,
        terminalReason: "completed" as const,
        recoveryOutcome: outcome,
      }),
    });
    await expect(terminal.lifecycle.reserveProducerDurably(makeReservation(), true))
      .resolves.toEqual(ok({
        status: "recovery_owned",
        lifecycleState: "promotion_ready",
        recoveryOutcome: outcome,
      }));

    const failedProbe = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("active")] }),
      retirementProducerState: async () => err(new Error("probe unavailable")),
    });
    expect((await failedProbe.lifecycle.reserveProducerDurably(makeReservation(), true)).ok)
      .toBe(false);
  });

  it("guards release and outcome transitions against missing or conflicting owners", async () => {
    const missing = makeHarness({ activeProducerKeys: new Set(["producer-a"]) });
    await expect(missing.lifecycle.releaseProducerDurably("producer-a"))
      .resolves.toEqual(ok(undefined));
    expect(missing.activeProducerKeys.size).toBe(0);

    for (const state of ["cancel_pending", "no_reply_pending"] as const) {
      const conflict = makeHarness({
        store: makeStore({ producerReservations: [makeRecord(state)] }),
      });
      expect((await conflict.lifecycle.releaseProducerDurably("producer-a")).ok).toBe(false);
    }

    const noOwner = makeHarness();
    expect((await noOwner.lifecycle.recordProducerOutcomeDurably("producer-a", {
      kind: "session",
      terminalReason: "completed",
      completedAtMs: 1,
    })).ok).toBe(false);
    const mismatch = makeHarness({
      store: makeStore({ producerReservations: [makeRecord()] }),
    });
    expect((await mismatch.lifecycle.recordProducerOutcomeDurably("producer-a", {
      kind: "graph",
      terminalReason: "completed",
      completedAtMs: 1,
      announcementText: "done",
    })).ok).toBe(false);
    expect((await mismatch.lifecycle.recordProducerOutcomeDurably(
      "producer-a",
      { kind: "invalid" } as never,
    )).ok).toBe(false);
  });

  it("retains a durable cancellation intent when cleanup persistence fails", async () => {
    let callCount = 0;
    const persist = vi.fn(async () => {
      callCount += 1;
      return callCount === 1 ? ok(undefined) : err(new Error("cleanup unavailable"));
    });
    const harness = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("active")] }),
      activeProducerKeys: new Set(["producer-a"]),
      persist,
    });

    await expect(harness.lifecycle.cancelProducerDurably("producer-a"))
      .resolves.toEqual(ok(undefined));
    expect(harness.store.producerReservations[0]?.lifecycleState).toBe("cancel_pending");
    expect(harness.logger.warn).toHaveBeenCalledOnce();
  });

  it("rejects cancellation after ownership transfers and accepts an absent owner", async () => {
    const transferred = makeHarness({
      store: makeStore({ entries: [{ runId: "producer-a" } as DeadLetterEntry] }),
    });
    expect((await transferred.lifecycle.cancelProducerDurably("producer-a")).ok).toBe(false);

    const absent = makeHarness({ activeProducerKeys: new Set(["producer-a"]) });
    await expect(absent.lifecycle.cancelProducerDurably("producer-a"))
      .resolves.toEqual(ok(undefined));
    expect(absent.activeProducerKeys.size).toBe(0);

    for (const state of ["no_reply_pending", "no_reply", "delivery_owned"] as const) {
      const conflict = makeHarness({
        store: makeStore({ producerReservations: [makeRecord(state)] }),
      });
      expect((await conflict.lifecycle.cancelProducerDurably("producer-a")).ok).toBe(false);
    }
  });

  it("suppresses owners through durable and degraded terminalization paths", async () => {
    const absent = makeHarness();
    await expect(absent.lifecycle.suppressProducerDurably("producer-a"))
      .resolves.toEqual(ok(false));

    const fallback = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("active")] }),
      persist: async () => err(new Error("snapshot unavailable")),
    });
    await expect(fallback.lifecycle.suppressProducerDurably("producer-a"))
      .resolves.toEqual(ok(true));
    expect(fallback.terminalizeOwner).toHaveBeenCalledOnce();

    const retainedPending = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("no_reply_pending")] }),
      terminalizeOwner: async () => err(new Error("terminal store unavailable")),
    });
    await expect(retainedPending.lifecycle.suppressProducerDurably("producer-a"))
      .resolves.toEqual(ok(true));
    expect(retainedPending.logger.warn).toHaveBeenCalledOnce();
  });

  it("rejects a shared handoff and cleans snapshots after complete suppression", async () => {
    const shared = makeHarness({
      store: makeStore({
        producerHandoffs: [{
          operations: [{ runId: "producer-a" }, { runId: "producer-other" }],
        } as never],
      }),
    });
    expect((await shared.lifecycle.suppressProducerDurably("producer-a")).ok).toBe(false);

    const snapshot = {
      kind: "snapshot" as const,
      sourceAgentId: "agent-a",
      sourcePath: "artifact.bin",
      path: "/snapshots/artifact.bin",
      fileName: "artifact.bin",
      mimeType: "application/octet-stream",
      contentDigest: "a".repeat(64),
      sizeBytes: 1,
    };
    const complete = makeHarness({
      store: makeStore({
        producerReservations: [makeRecord("active", { attachment: snapshot })],
        entries: [{ ...makeReservation(), id: "entry-a", attemptCount: 1, attachment: snapshot } as DeadLetterEntry],
      }),
    });
    await expect(complete.lifecycle.suppressProducerDurably("producer-a"))
      .resolves.toEqual(ok(true));
    expect(complete.store.entries).toEqual([]);
    expect(complete.store.producerReservations[0]?.lifecycleState).toBe("no_reply");
    expect(complete.cleanupUnreferencedSnapshots).toHaveBeenCalledOnce();
  });

  it("consumes missing and persisted producer slots with capacity signaling", async () => {
    const missing = makeHarness({
      activeProducerKeys: new Set(["producer-a"]),
      signalCapacityChange: vi.fn(),
    });
    await expect(missing.lifecycle.consumeProducerReservationsDurably(["producer-a"]))
      .resolves.toEqual(ok(undefined));
    expect(missing.signalCapacityChange).toHaveBeenCalledOnce();

    const failed = makeHarness({
      store: makeStore({ producerReservations: [makeRecord()] }),
      persist: async () => err(new Error("snapshot unavailable")),
    });
    expect((await failed.lifecycle.consumeProducerReservationsDurably(["producer-a"])).ok)
      .toBe(false);
  });

  it("recognizes producer handoff ownership and resumes a cancelled reservation", async () => {
    const handoffOwned = makeHarness({
      store: makeStore({
        producerHandoffs: [{ operations: [makeReservation()] } as never],
      }),
      activeProducerKeys: new Set(["producer-a"]),
    });
    await expect(handoffOwned.lifecycle.reserveProducerDurably(makeReservation(), false))
      .resolves.toEqual(ok({ status: "recovery_owned", lifecycleState: "delivery_owned" }));

    const cancelled = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("cancel_pending")] }),
    });
    await expect(cancelled.lifecycle.reserveProducerDurably(makeReservation(), false))
      .resolves.toEqual(ok({ status: "claimed" }));
  });

  it("releases terminal producers without outcomes and propagates release persistence failures", async () => {
    const terminal = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("active")] }),
      retirementProducerState: async () => ok({
        status: "terminal" as const,
        terminalReason: "completed" as const,
      }),
    });
    await expect(terminal.lifecycle.reserveProducerDurably(makeReservation(), true))
      .resolves.toEqual(ok({ status: "recovery_owned", lifecycleState: "promotion_ready" }));

    const noReply = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("no_reply")] }),
      activeProducerKeys: new Set(["producer-a"]),
    });
    await expect(noReply.lifecycle.releaseProducerDurably("producer-a")).resolves.toEqual(ok(undefined));

    const persistence = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("active")] }),
      persist: async () => err(new Error("disk unavailable")),
    });
    await expect(persistence.lifecycle.releaseProducerDurably("producer-a"))
      .resolves.toMatchObject({ ok: false });
  });

  it("guards recorded outcomes during handoff and pending terminal transitions", async () => {
    const outcome = {
      kind: "session" as const,
      terminalReason: "completed" as const,
      completedAtMs: 1,
    };
    const handedOff = makeHarness({
      store: makeStore({
        producerReservations: [makeRecord("active")],
        producerHandoffs: [{ operations: [makeReservation()] } as never],
      }),
    });
    await expect(handedOff.lifecycle.recordProducerOutcomeDurably("producer-a", outcome))
      .resolves.toEqual(ok(undefined));
    expect(handedOff.store.producerReservations[0]?.lifecycleState).toBe("delivery_owned");

    const pending = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("cancel_pending")] }),
    });
    await expect(pending.lifecycle.recordProducerOutcomeDurably("producer-a", outcome))
      .resolves.toMatchObject({ ok: false });

    const persistence = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("active")] }),
      persist: async () => err(new Error("disk unavailable")),
    });
    await expect(persistence.lifecycle.recordProducerOutcomeDurably("producer-a", outcome))
      .resolves.toMatchObject({ ok: false });
  });

  it("removes absent reservations and rejects cancellation after handoff transfer", async () => {
    const missing = makeHarness({ activeProducerKeys: new Set(["producer-a"]) });
    await expect(missing.lifecycle.removeProducerReservationDurably("producer-a"))
      .resolves.toEqual(ok(undefined));
    expect(missing.activeProducerKeys).toEqual(new Set());

    const transferred = makeHarness({
      store: makeStore({ producerHandoffs: [{ operations: [makeReservation()] } as never] }),
    });
    await expect(transferred.lifecycle.cancelProducerDurably("producer-a"))
      .resolves.toMatchObject({
        ok: false,
        error: { message: "Announcement producer ownership already transferred" },
      });
  });

  it("retains suppression evidence when terminalization or final cleanup fails", async () => {
    const terminalFailure = makeHarness({
      store: makeStore({ entries: [{
        ...makeReservation(),
        id: "entry-a",
        attemptCount: 1,
        lastAttemptAt: 1,
      } as DeadLetterEntry] }),
      terminalizeOwner: async () => err(new Error("terminal unavailable")),
    });
    await expect(terminalFailure.lifecycle.suppressProducerDurably("producer-a"))
      .resolves.toMatchObject({ ok: false });

    let persistCalls = 0;
    const cleanupFailure = makeHarness({
      store: makeStore({ producerReservations: [makeRecord("active")] }),
      persist: async () => ++persistCalls === 2
        ? err(new Error("cleanup unavailable"))
        : ok(undefined),
    });
    await expect(cleanupFailure.lifecycle.suppressProducerDurably("producer-a"))
      .resolves.toEqual(ok(true));
    expect(cleanupFailure.logger.warn).toHaveBeenCalledOnce();
  });
});
