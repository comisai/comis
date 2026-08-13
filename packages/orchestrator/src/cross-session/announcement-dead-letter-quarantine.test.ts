// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";

import type {
  DeadLetterEntry,
  ParentDecisionReservationRecord,
} from "./announcement-dead-letter-file.js";
import {
  projectQuarantined,
  releaseQuarantined,
} from "./announcement-dead-letter-quarantine.js";

function makeEntry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    id: "entry_a",
    announcementText: "withheld entry",
    channelType: "telegram",
    channelId: "channel_a",
    runId: "run_entry",
    failedAt: 200,
    attemptCount: 1,
    lastAttemptAt: 210,
    ...overrides,
  };
}

function makeReservation(
  overrides: Partial<ParentDecisionReservationRecord> = {},
): ParentDecisionReservationRecord {
  return {
    recordType: "parent_decision_reservation",
    id: "reservation_a",
    idempotencyKey: "decision_a",
    agentId: "agent_a",
    runId: "run_reservation",
    announcementText: "withheld reservation",
    channelType: "telegram",
    channelId: "channel_a",
    failedAt: 100,
    ...overrides,
  };
}

describe("quarantined announcement operator helpers", () => {
  it("projects parked parent decisions without exposing announcement text", () => {
    const rows = projectQuarantined(
      [makeEntry()],
      [makeReservation({ threadId: "thread_a" })],
    );

    expect(rows.map((row) => row.id)).toEqual(["reservation_a", "entry_a"]);
    expect(rows[0]).toEqual({
      id: "reservation_a",
      kind: "parent_decision",
      runId: "run_reservation",
      agentId: "agent_a",
      channelType: "telegram",
      channelId: "channel_a",
      threadId: "thread_a",
      failedAt: 100,
      attemptCount: 0,
      idempotencyKey: "decision_a",
      announcementChars: "withheld reservation".length,
    });
    expect(JSON.stringify(rows)).not.toContain("withheld reservation");
  });

  it("releases a parked parent decision and retains unrelated entries", async () => {
    const entry = makeEntry();
    const reservation = makeReservation();
    const persist = vi.fn(async () => ok(undefined));
    const logger = { info: vi.fn(), error: vi.fn() };

    const released = await releaseQuarantined({
      id: reservation.id,
      outcome: "delivered",
      entries: [entry],
      reservations: [reservation],
      logger,
      persist,
    });

    expect(released).toEqual(ok(true));
    expect(persist).toHaveBeenCalledWith([entry], []);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      {
        runId: "run_reservation",
        kind: "parent_decision",
        outcome: "delivered",
        remaining: 1,
      },
      "Quarantined announcement released by operator decision",
    );
  });

  it("keeps a quarantined entry when durable persistence fails", async () => {
    const entry = makeEntry();
    const storageError = new Error("storage unavailable");
    const persist = vi.fn(async () => err(storageError));
    const logger = { info: vi.fn(), error: vi.fn() };

    const released = await releaseQuarantined({
      id: entry.id,
      outcome: "discarded",
      entries: [entry],
      reservations: [],
      logger,
      persist,
    });

    expect(released).toEqual(err(storageError));
    expect(persist).toHaveBeenCalledWith([], []);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      {
        errorKind: "resource",
        hint: "restore dead-letter storage before releasing; the announcement is still quarantined",
      },
      "Quarantined announcement release was not durably persisted",
    );
  });
});
