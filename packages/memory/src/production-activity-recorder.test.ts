// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { err, ok } from "@comis/shared";

import type {
  ActivityRecordingHeadAuthorityPort,
  ActivityRecordingTrustedHead,
  NormalizedMessage,
} from "@comis/core";
import { createActivityRecordingCrypto } from "@comis/observability";

import {
  createSqliteProductionActivityRecorderOnDatabase,
  openSqliteProductionActivityRecorder,
} from "./production-activity-recorder.js";
import { initSchema } from "./production-activity-recorder-support.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "comis-activity-recorder-"));
  tempDirs.push(dir);
  return join(dir, "activity-recording.db");
}

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId: "chat_a",
    channelType: "telegram",
    senderId: "user_a",
    text: "prospective private prompt",
    timestamp: 1_700_000_000_000,
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeCrypto() {
  return createActivityRecordingCrypto(randomBytes(32));
}

function makeHeadAuthority(): ActivityRecordingHeadAuthorityPort & {
  snapshot(streamId: string): ActivityRecordingTrustedHead | undefined;
} {
  const heads = new Map<string, ActivityRecordingTrustedHead>();
  return {
    read: (streamId) => ok(heads.get(streamId)),
    compareAndSet: ({ streamId, expected, next }) => {
      const current = heads.get(streamId);
      if (JSON.stringify(current) !== JSON.stringify(expected)) return ok("conflict");
      heads.set(streamId, structuredClone(next));
      return ok("updated");
    },
    snapshot: (streamId) => heads.get(streamId),
  };
}

function readRecorderFiles(dbPath: string): string {
  return readdirSync(dirname(dbPath))
    .map((name) => readFileSync(join(dirname(dbPath), name)).toString("utf8"))
    .join("");
}

const generousLimits = {
  maxPayloadBytes: 256 * 1024,
  maxStoredBytes: 8 * 1024 * 1024,
  maxRecords: 10_000,
  gapReserveBytes: 64 * 1024,
  gapReserveRecords: 100,
};

const nowMs = () => 1_700_000_100_000;

describe("SQLite production activity recorder", () => {
  it("enforces one outcome-or-gap settlement per platform attempt in SQLite", () => {
    const db = new Database(":memory:");
    initSchema(db, "settlement-constraint");
    const writerId = randomUUID();
    const instance = db.prepare(`
      SELECT instance_id AS instanceId FROM activity_recording_meta WHERE singleton = 1
    `).get() as { readonly instanceId: string };
    db.prepare(`
      INSERT INTO activity_recording_writers
        (writer_id, instance_id, lease_expires_at_ms, closed_at_ms)
      VALUES (?, ?, ?, NULL)
    `).run(writerId, instance.instanceId, 1_000);
    const insert = db.prepare(`
      INSERT INTO activity_recording_records (
        sequence, record_id, kind, trace_id, parent_record_id,
        attempt_id, capability_digest, writer_id, occurred_at_ms,
        payload_ciphertext, payload_iv, payload_auth_tag, payload_salt,
        payload_digest, payload_bytes, previous_hash, record_hash,
        state_logical_bytes, state_record_count, state_gap_count,
        proof_ciphertext, proof_iv, proof_auth_tag, proof_salt, logical_bytes
      ) VALUES (
        @sequence, @recordId, @kind, NULL, @parentRecordId,
        NULL, NULL, @writerId, 1, @blob, @blob, @blob, @blob,
        @digest, 1, @digest, @digest,
        1, @sequence, @gapCount,
        @blob, @blob, @blob, @blob, 1
      )
    `);
    const insertRow = (
      sequence: number,
      kind: "delivery_platform_attempt" | "gap",
      parentRecordId: string | null,
    ) => insert.run({
      sequence,
      recordId: `record:${String(sequence).padStart(20, "0")}`,
      kind,
      parentRecordId,
      writerId,
      blob: Buffer.from([sequence]),
      digest: String(sequence).padStart(64, "0"),
      gapCount: kind === "gap" ? sequence - 1 : 0,
    });
    const attemptRecordId = "record:00000000000000000001";
    insertRow(1, "delivery_platform_attempt", null);
    insertRow(2, "gap", attemptRecordId);

    expect(() => insertRow(3, "gap", attemptRecordId)).toThrow(/UNIQUE/);
    db.close();
  });

  it("serializes concurrent appends into one gap-free global sequence", async () => {
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        opened.value.recordInboundChannelActivity({
          traceId: randomUUID(),
          occurredAtMs: 1_700_000_000_000 + index,
          message: makeMessage({ text: `prompt-${index}` }),
        }),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.ok ? result.value.sequence : -1)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    const inspection = await opened.value.inspect();
    expect(inspection.ok && inspection.value.recordCount).toBe(40);
    expect(inspection.ok && inspection.value.gapCount).toBe(0);
    await opened.value.close();
  });

  it("keeps bodies and routing identifiers out of database pages and sidecars", async () => {
    const dbPath = makePath();
    const opened = openSqliteProductionActivityRecorder({
      dbPath,
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const result = await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage({
        channelId: "private-channel-marker",
        senderId: "private-sender-marker",
        text: "private-body-marker",
      }),
    });
    expect(result.ok).toBe(true);
    await opened.value.close();

    const files = readRecorderFiles(dbPath);
    expect(files).not.toContain("private-body-marker");
    expect(files).not.toContain("private-channel-marker");
    expect(files).not.toContain("private-sender-marker");
  });

  it("rejects a tampered content-free index before accepting new writes", async () => {
    const dbPath = makePath();
    const crypto = makeCrypto();
    const opened = openSqliteProductionActivityRecorder({ dbPath, crypto, limits: generousLimits, nowMs });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage(),
    });
    await opened.value.close();

    const db = new Database(dbPath);
    db.prepare("UPDATE activity_recording_records SET trace_id = ? WHERE sequence = 1")
      .run(randomUUID());
    db.close();

    const reopened = openSqliteProductionActivityRecorder({ dbPath, crypto, limits: generousLimits, nowMs });
    expect(reopened.ok).toBe(false);
  });

  it("authenticates payload ciphertext while verifying an existing chain", async () => {
    const dbPath = makePath();
    const crypto = makeCrypto();
    const opened = openSqliteProductionActivityRecorder({
      dbPath, crypto, limits: generousLimits, nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect((await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage(),
    })).ok).toBe(true);
    await opened.value.close();

    const reopened = openSqliteProductionActivityRecorder({
      dbPath,
      limits: generousLimits,
      nowMs,
      crypto: {
        seal: (context, plaintext) => crypto.seal(context, plaintext),
        open: (context, encrypted) => context.purpose === "payload"
          ? err(new Error("payload authentication unavailable"))
          : crypto.open(context, encrypted),
      },
    });

    expect(reopened.ok).toBe(false);
  });

  it("does not settle a live writer's delivery attempt when another recorder opens", async () => {
    const dbPath = makePath();
    const crypto = makeCrypto();
    const first = openSqliteProductionActivityRecorder({
      dbPath, crypto, limits: generousLimits, nowMs,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const attempt = await first.value.beginDeliveryPlatformAttempt({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      channelType: "telegram",
      channelId: "chat_a",
      text: "outbound private body",
      options: {},
      origin: "agent_response",
      chunkIndex: 0,
      totalChunks: 1,
    });
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;

    const second = openSqliteProductionActivityRecorder({
      dbPath, crypto, limits: generousLimits, nowMs,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const outcome = await first.value.finishDeliveryPlatformAttempt({
      attempt: attempt.value,
      occurredAtMs: 1_700_000_000_100,
      outcomeClass: "success",
      platformMessageId: "platform-message-a",
    });

    expect(outcome.ok).toBe(true);
    const inspection = await second.value.inspect();
    expect(inspection.ok && inspection.value.gapCount).toBe(0);
    await first.value.close();
    await second.value.close();
  });

  it("fails before writer registration when the lease clock is unavailable", () => {
    const db = new Database(":memory:");
    initSchema(db, "clock-registration");

    const created = createSqliteProductionActivityRecorderOnDatabase({
      db,
      closeDatabase: false,
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs: () => { throw new Error("clock unavailable"); },
      streamId: "clock-registration",
    });

    expect(created.ok).toBe(false);
    const writers = db.prepare("SELECT COUNT(*) AS count FROM activity_recording_writers")
      .get() as { readonly count: number };
    expect(writers.count).toBe(0);
    db.close();
  });

  it("refuses lease renewal and settlement when a live writer clock fails", async () => {
    const dbPath = makePath();
    const crypto = makeCrypto();
    let clockAvailable = true;
    const currentNowMs = 1_700_000_100_000;
    const writerClock = () => {
      if (!clockAvailable) throw new Error("clock unavailable");
      return currentNowMs;
    };
    const first = openSqliteProductionActivityRecorder({
      dbPath, crypto, limits: generousLimits, nowMs: writerClock,
      streamId: "clock-live-writer", writerLeaseMs: 10_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const attempt = await first.value.beginDeliveryPlatformAttempt({
      traceId: randomUUID(), occurredAtMs: currentNowMs,
      channelType: "telegram", channelId: "chat_a", text: "body", options: {},
      origin: "agent_response", chunkIndex: 0, totalChunks: 1,
    });
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;

    clockAvailable = false;
    const second = openSqliteProductionActivityRecorder({
      dbPath, crypto, limits: generousLimits, nowMs: () => currentNowMs,
      streamId: "clock-live-writer", writerLeaseMs: 10_000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const outcome = await first.value.finishDeliveryPlatformAttempt({
      attempt: attempt.value, occurredAtMs: currentNowMs + 1,
      outcomeClass: "success", platformMessageId: "platform-message-a",
    });
    expect(!outcome.ok && outcome.error.reason).toBe("clock_unavailable");
    const inspection = await second.value.inspect();
    expect(inspection.ok && inspection.value.recordCount).toBe(1);
    expect(inspection.ok && inspection.value.gapCount).toBe(0);

    clockAvailable = true;
    await first.value.close();
    await second.value.close();
  });

  it("converts a crash-open delivery attempt into an explicit restart gap once", async () => {
    const dbPath = makePath();
    const crypto = makeCrypto();
    const db = new Database(dbPath);
    let currentNowMs = 1_700_000_100_000;
    const leaseNowMs = () => currentNowMs;
    const opened = createSqliteProductionActivityRecorderOnDatabase({
      db,
      closeDatabase: false,
      crypto,
      limits: generousLimits,
      nowMs: leaseNowMs,
      streamId: "restart-machine",
      writerLeaseMs: 100,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const attempt = await opened.value.beginDeliveryPlatformAttempt({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      channelType: "telegram",
      channelId: "chat_a",
      text: "outbound private body",
      options: {},
      origin: "agent_response",
      chunkIndex: 0,
      totalChunks: 1,
    });
    expect(attempt.ok).toBe(true);
    db.close();
    currentNowMs += 101;

    const recovered = openSqliteProductionActivityRecorder({
      dbPath, crypto, limits: generousLimits, nowMs: leaseNowMs,
      streamId: "restart-machine", writerLeaseMs: 100,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    const firstInspection = await recovered.value.inspect();
    expect(firstInspection.ok && firstInspection.value.gapCount).toBe(1);
    expect(firstInspection.ok && firstInspection.value.recordCount).toBe(2);
    await recovered.value.close();

    const second = openSqliteProductionActivityRecorder({
      dbPath, crypto, limits: generousLimits, nowMs: leaseNowMs,
      streamId: "restart-machine", writerLeaseMs: 100,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondInspection = await second.value.inspect();
    expect(secondInspection.ok && secondInspection.value.gapCount).toBe(1);
    expect(secondInspection.ok && secondInspection.value.recordCount).toBe(2);
    await second.value.close();
  });

  it("closes every remaining platform attempt with an authenticated shutdown gap", async () => {
    const dbPath = makePath();
    const crypto = makeCrypto();
    const rolledBackNow = () => 1_600_000_000_000;
    const opened = openSqliteProductionActivityRecorder({
      dbPath, crypto, limits: generousLimits, nowMs: rolledBackNow,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const attempt = await opened.value.beginDeliveryPlatformAttempt({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      channelType: "telegram",
      channelId: "chat_a",
      text: "possibly delivered",
      options: {},
      origin: "agent_response",
      chunkIndex: 0,
      totalChunks: 1,
    });
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;

    expect((await opened.value.close()).ok).toBe(true);
    const late = await opened.value.finishDeliveryPlatformAttempt({
      attempt: attempt.value,
      occurredAtMs: 1_700_000_000_100,
      outcomeClass: "success",
      platformMessageId: "late-platform-id",
    });
    expect(!late.ok && late.error.reason).toBe("recorder_closed");

    const reopened = openSqliteProductionActivityRecorder({
      dbPath, crypto, limits: generousLimits, nowMs: rolledBackNow,
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const inspection = await reopened.value.inspect();
    expect(inspection.ok && inspection.value.gapCount).toBe(1);
    expect(inspection.ok && inspection.value.recordCount).toBe(2);
    const exported = await reopened.value.exportEvidence({ limit: 10 });
    expect(exported.ok && exported.value.records[1]?.payload).toEqual({
      reason: "unknown_at_shutdown",
      sourceKind: "delivery_platform_attempt",
    });
    expect(exported.ok && exported.value.records[1]?.occurredAtMs).toBe(1_700_000_000_000);
    await reopened.value.close();
  });

  it("accounts an oversized payload in durable loss state without storing its body", async () => {
    const dbPath = makePath();
    const opened = openSqliteProductionActivityRecorder({
      dbPath,
      crypto: makeCrypto(),
      limits: { ...generousLimits, maxPayloadBytes: 512 },
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const result = await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage({ text: "x".repeat(2_000) }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("payload_too_large");
      expect(result.error.gapDurablyAccounted).toBe(true);
      expect(result.error.gapCount).toBe(1);
    }
    const inspection = await opened.value.inspect();
    expect(inspection.ok && inspection.value.gapCount).toBe(1);
    await opened.value.close();
    expect(readRecorderFiles(dbPath)).not.toContain("x".repeat(100));
  });

  it("rejects cyclic delivery options before serialization and records the gap", async () => {
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const result = await opened.value.beginDeliveryPlatformAttempt({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      channelType: "telegram",
      channelId: "chat_a",
      text: "body",
      options: { extra: cyclic },
      origin: "agent_response",
      chunkIndex: 0,
      totalChunks: 1,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.reason).toBe("payload_invalid");
    expect(!result.ok && result.error.gapDurablyAccounted).toBe(true);
    await opened.value.close();
  });

  it("never claims a durable authenticated gap when encryption is unavailable", async () => {
    const workingCrypto = makeCrypto();
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: {
        open: workingCrypto.open,
        seal: () => ({ ok: false as const, error: new Error("crypto unavailable") }),
      },
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const result = await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage(),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.reason).toBe("crypto_failed");
    expect(!result.ok && result.error.gapDurablyAccounted).toBe(false);
    await opened.value.close();
  });

  it("contains throwing crypto and rejects unavailable clocks inside Result boundaries", async () => {
    const workingCrypto = makeCrypto();
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: {
        open: workingCrypto.open,
        seal: () => { throw new Error("crypto adapter threw"); },
      },
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const capture = await opened.value.beginDeliveryPlatformAttempt({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      channelType: "telegram",
      channelId: "chat_a",
      text: "body",
      options: {},
      origin: "agent_response",
      chunkIndex: 0,
      totalChunks: 1,
    });
    const invalid = await opened.value.finishDeliveryPlatformAttempt(null as never);

    expect(!capture.ok && capture.error.reason).toBe("crypto_failed");
    expect(!capture.ok && capture.error.gapDurablyAccounted).toBe(false);
    expect(!invalid.ok && invalid.error.occurredAtMs).toBe(nowMs());
    await opened.value.close();

    const unavailableClock = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: workingCrypto,
      limits: generousLimits,
      nowMs: () => { throw new Error("clock adapter threw"); },
    });
    expect(unavailableClock.ok).toBe(false);

    const malformed = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: {
        open: workingCrypto.open,
        seal: () => ({ ok: true as const, value: null as never }),
      },
      limits: generousLimits,
      nowMs,
    });
    expect(malformed.ok).toBe(true);
    if (!malformed.ok) return;
    const malformedCapture = await malformed.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage(),
    });
    expect(!malformedCapture.ok && malformedCapture.error.reason).toBe("crypto_failed");
    await malformed.value.close();
  });

  it("returns authenticated export and construction failures without throwing", async () => {
    expect(openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: makeCrypto(),
      limits: null as never,
      nowMs,
    }).ok).toBe(false);
    const closedDb = new Database(":memory:");
    closedDb.close();
    expect(createSqliteProductionActivityRecorderOnDatabase({
      db: closedDb,
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
      closeDatabase: false,
    }).ok).toBe(false);
    const throwingPrepareDb = {
      exec: () => undefined,
      prepare: () => { throw new Error("prepare threw"); },
    } as unknown as Database.Database;
    expect(createSqliteProductionActivityRecorderOnDatabase({
      db: throwingPrepareDb,
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
      closeDatabase: false,
    }).ok).toBe(false);

    const workingCrypto = makeCrypto();
    let throwOnOpen = false;
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: {
        seal: workingCrypto.seal,
        open: (purpose, encrypted) => {
          if (throwOnOpen) throw new Error("crypto open threw");
          return workingCrypto.open(purpose, encrypted);
        },
      },
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage(),
    });
    throwOnOpen = true;

    const exported = await opened.value.exportEvidence({ limit: 10 });
    expect(exported.ok).toBe(false);
    await opened.value.close();
  });

  it("reserves record capacity so a primary cap failure can append its gap", async () => {
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: makeCrypto(),
      limits: {
        ...generousLimits,
        maxRecords: 3,
        gapReserveRecords: 1,
      },
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    for (let index = 0; index < 2; index++) {
      expect((await opened.value.recordInboundChannelActivity({
        traceId: randomUUID(),
        occurredAtMs: 1_700_000_000_000 + index,
        message: makeMessage({ text: `accepted-${index}` }),
      })).ok).toBe(true);
    }
    const capped = await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_100,
      message: makeMessage({ text: "must-be-gap" }),
    });

    expect(capped.ok).toBe(false);
    expect(!capped.ok && capped.error.reason).toBe("record_limit_exceeded");
    expect(!capped.ok && capped.error.gapDurablyAccounted).toBe(true);
    const inspection = await opened.value.inspect();
    expect(inspection.ok && inspection.value.recordCount).toBe(3);
    expect(inspection.ok && inspection.value.gapCount).toBe(1);
    await opened.value.close();
  });

  it("turns hostile runtime port values into typed failures without throwing", async () => {
    const dbPath = makePath();
    const opened = openSqliteProductionActivityRecorder({
      dbPath,
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const badBegin = await opened.value.beginDeliveryPlatformAttempt({
      occurredAtMs: 1_700_000_000_000,
      channelType: "telegram",
      channelId: "chat_a",
      text: 42,
      options: {},
      origin: "agent_response",
      chunkIndex: 0,
      totalChunks: 1,
    } as never);
    const badFinish = await opened.value.finishDeliveryPlatformAttempt({
      attemptRecordId: null,
      occurredAtMs: Number.NaN,
      durationMs: -1,
      outcomeClass: "success",
    } as never);

    expect(badBegin.ok).toBe(false);
    expect(!badBegin.ok && badBegin.error.reason).toBe("payload_invalid");
    expect(badFinish.ok).toBe(false);
    expect(!badFinish.ok && badFinish.error.reason).toBe("outcome_shape_invalid");
    await opened.value.close();
  });

  it("rejects nonexistent and already-settled delivery attempt parents", async () => {
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const attempt = await opened.value.beginDeliveryPlatformAttempt({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      channelType: "telegram",
      channelId: "chat_a",
      text: "outbound",
      options: {},
      origin: "agent_response",
      chunkIndex: 0,
      totalChunks: 1,
    });
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect((await opened.value.finishDeliveryPlatformAttempt({
      attempt: attempt.value,
      occurredAtMs: 1_700_000_000_100,
      outcomeClass: "success",
      platformMessageId: "platform-1",
    })).ok).toBe(true);

    const duplicate = await opened.value.finishDeliveryPlatformAttempt({
      attempt: attempt.value,
      occurredAtMs: 1_700_000_000_200,
      outcomeClass: "success",
      platformMessageId: "platform-2",
    });
    const missing = await opened.value.finishDeliveryPlatformAttempt({
      attempt: {
        ...attempt.value,
        recordId: "record:99999999999999999999",
        sequence: 999_999,
      },
      occurredAtMs: 1_700_000_000_300,
      outcomeClass: "platform_error",
      error: { name: "Error", message: "missing parent" },
    });

    expect(!duplicate.ok && duplicate.error.reason).toBe("attempt_already_settled");
    expect(!missing.ok && missing.error.reason).toBe("causal_parent_invalid");
    await opened.value.close();
  });

  it("authenticates one ordered outcome against an unguessable attempt capability", async () => {
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const traceId = randomUUID();
    const attempt = await opened.value.beginDeliveryPlatformAttempt({
      traceId,
      occurredAtMs: 1_700_000_000_000,
      channelType: "telegram",
      channelId: "chat_a",
      text: "send once",
      options: {},
      origin: "agent",
      chunkIndex: 0,
      totalChunks: 1,
    });
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    const receipt = attempt.value as typeof attempt.value & {
      readonly attemptId: string;
      readonly settlementCapability: string;
      readonly traceId: string;
      readonly occurredAtMs: number;
    };
    expect(receipt.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.settlementCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(receipt.traceId).toBe(traceId);

    const before = await opened.value.inspect();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const finish = (attemptReceipt: typeof receipt, occurredAtMs: number, outcome: object) =>
      opened.value.finishDeliveryPlatformAttempt({
        attempt: attemptReceipt,
        occurredAtMs,
        ...outcome,
      } as never);

    const forged = await finish({
      ...receipt,
      settlementCapability: "A".repeat(43),
    }, 1_700_000_000_010, {
      outcomeClass: "success",
      platformMessageId: "platform-1",
    });
    expect(!forged.ok && forged.error.reason).toBe("settlement_capability_invalid");

    const wrongTrace = await finish({ ...receipt, traceId: randomUUID() }, 1_700_000_000_010, {
      outcomeClass: "success",
      platformMessageId: "platform-1",
    });
    expect(!wrongTrace.ok && wrongTrace.error.reason).toBe("trace_mismatch");

    const outOfOrder = await finish(receipt, 1_699_999_999_999, {
      outcomeClass: "success",
      platformMessageId: "platform-1",
    });
    expect(!outOfOrder.ok && outOfOrder.error.reason).toBe("timestamp_order_invalid");

    const inconsistent = await finish(receipt, 1_700_000_000_010, {
      outcomeClass: "success",
      platformMessageId: "platform-1",
      error: { name: "Error", message: "contradiction" },
    });
    expect(!inconsistent.ok && inconsistent.error.reason).toBe("outcome_shape_invalid");

    const accepted = await finish(receipt, 1_700_000_000_010, {
      outcomeClass: "success",
      platformMessageId: "platform-1",
    });
    expect(accepted.ok).toBe(true);

    const duplicate = await finish(receipt, 1_700_000_000_011, {
      outcomeClass: "success",
      platformMessageId: "platform-2",
    });
    expect(!duplicate.ok && duplicate.error.reason).toBe("attempt_already_settled");
    const after = await opened.value.inspect();
    expect(after.ok && after.value.gapCount).toBe(before.value.gapCount);
    await opened.value.close();
  });

  it("exports bounded pages of decrypted records only after authentication", async () => {
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    for (let index = 0; index < 3; index++) {
      await opened.value.recordInboundChannelActivity({
        traceId: randomUUID(),
        occurredAtMs: 1_700_000_000_000 + index,
        message: makeMessage({ text: `exported-private-prompt-${index}` }),
      });
    }

    const first = await opened.value.exportEvidence({ limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.records).toHaveLength(2);
    expect(first.value.nextAfterSequence).toBe(2);
    expect(first.value.records[0]?.payload).toEqual(expect.objectContaining({
      message: expect.objectContaining({ text: "exported-private-prompt-0" }),
    }));
    const second = await opened.value.exportEvidence({
      afterSequence: first.value.nextAfterSequence,
      limit: 2,
    });
    expect(second.ok && second.value.records).toHaveLength(1);
    expect(second.ok && second.value.nextAfterSequence).toBeUndefined();
    await opened.value.close();
  });

  it("bounds export authentication work and holds one snapshot across concurrent appends", async () => {
    const baseCrypto = makeCrypto();
    let openCalls = 0;
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: {
        seal: baseCrypto.seal,
        open(context, encrypted) {
          openCalls += 1;
          return baseCrypto.open(context, encrypted);
        },
      },
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    for (let index = 0; index < 50; index++) {
      expect((await opened.value.recordInboundChannelActivity({
        traceId: randomUUID(),
        occurredAtMs: 1_700_000_000_000 + index,
        message: makeMessage({ text: `snapshot-${index}` }),
      })).ok).toBe(true);
    }

    openCalls = 0;
    const first = await opened.value.exportEvidence({ limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(openCalls).toBeLessThanOrEqual(8);
    expect(first.value.snapshotHeadSequence).toBe(50);
    expect((await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_100,
      message: makeMessage({ text: "after-snapshot" }),
    })).ok).toBe(true);

    openCalls = 0;
    const second = await opened.value.exportEvidence({
      afterSequence: first.value.nextAfterSequence,
      snapshotHeadSequence: first.value.snapshotHeadSequence,
      limit: 1_000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.records).toHaveLength(48);
    expect(second.value.records.at(-1)?.sequence).toBe(50);
    expect(second.value.snapshotHeadSequence).toBe(50);
    expect(openCalls).toBeLessThanOrEqual(148);
    await opened.value.close();
  });

  it("rolls back authenticated gap and counters together when metadata commit aborts", async () => {
    const db = new Database(":memory:");
    const created = createSqliteProductionActivityRecorderOnDatabase({
      db,
      closeDatabase: false,
      crypto: makeCrypto(),
      limits: { ...generousLimits, maxPayloadBytes: 512 },
      nowMs,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    db.exec(`
      CREATE TRIGGER abort_activity_meta_update
      BEFORE UPDATE ON activity_recording_meta
      BEGIN
        SELECT RAISE(ABORT, 'simulated metadata commit failure');
      END
    `);

    const failed = await created.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage({ text: "x".repeat(2_000) }),
    });

    expect(!failed.ok && failed.error.gapDurablyAccounted).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM activity_recording_records").get())
      .toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT logical_bytes, record_count, gap_count FROM activity_recording_meta
      WHERE singleton = 1
    `).get()).toEqual({ logical_bytes: 0, record_count: 0, gap_count: 0 });
    db.close();
  });

  it("serializes independent database handles and reports lock contention as typed loss", async () => {
    const dbPath = makePath();
    const crypto = makeCrypto();
    const options = { dbPath, crypto, limits: { ...generousLimits, busyTimeoutMs: 1 }, nowMs };
    const first = openSqliteProductionActivityRecorder(options);
    const second = openSqliteProductionActivityRecorder(options);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const results = await Promise.all([
      first.value.recordInboundChannelActivity({
        traceId: randomUUID(), occurredAtMs: 1, message: makeMessage({ text: "first-handle" }),
      }),
      second.value.recordInboundChannelActivity({
        traceId: randomUUID(), occurredAtMs: 2, message: makeMessage({ text: "second-handle" }),
      }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    const lock = new Database(dbPath);
    lock.exec("BEGIN IMMEDIATE");
    const contended = await second.value.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 3, message: makeMessage({ text: "contended" }),
    });
    expect(!contended.ok && contended.error.reason).toBe("database_busy");
    expect(!contended.ok && contended.error.gapDurablyAccounted).toBe(false);
    lock.exec("ROLLBACK");
    lock.close();
    await first.value.close();
    await second.value.close();
  });

  it("refuses evidence export when a live plaintext index is modified after startup", async () => {
    const dbPath = makePath();
    const opened = openSqliteProductionActivityRecorder({
      dbPath,
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage(),
    });
    const tamper = new Database(dbPath);
    tamper.prepare("UPDATE activity_recording_records SET occurred_at_ms = ? WHERE sequence = 1")
      .run(1_700_000_999_999);
    tamper.close();

    const exported = await opened.value.exportEvidence({ limit: 10 });
    expect(exported.ok).toBe(false);
    await opened.value.close();
  });

  it("reports a non-accounted gap when the database itself cannot accept bookkeeping", async () => {
    const db = new Database(":memory:");
    const created = createSqliteProductionActivityRecorderOnDatabase({
      db,
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
      closeDatabase: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    db.close();

    const result = await created.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("storage_failed");
      expect(result.error.gapDurablyAccounted).toBe(false);
    }
  });

  it("always reports family-level blockers and never claims exact eligibility", async () => {
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const inspection = await opened.value.inspect();
    expect(inspection.ok && inspection.value.exactness.eligible).toBe(false);
    expect(inspection.ok && inspection.value.exactness.blockers).toContain(
      "delivery_queue_drain_and_direct_adapter_sends",
    );
    expect(inspection.ok && inspection.value.trustedHeadAnchor).toBe(false);
    expect(inspection.ok && inspection.value.exactness.blockers).toContain(
      "trusted_external_head_anchor_missing",
    );
    await opened.value.close();
  });

  it("removes only the trusted-head blocker when an external authority is present", async () => {
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
      streamId: "anchored-machine",
      headAuthority: makeHeadAuthority(),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const inspection = await opened.value.inspect();

    expect(inspection.ok && inspection.value.trustedHeadAnchor).toBe(true);
    expect(inspection.ok && inspection.value.exactness.blockers)
      .not.toContain("trusted_external_head_anchor_missing");
    expect(inspection.ok && inspection.value.exactness.eligible).toBe(false);
    await opened.value.close();
  });

  it("restores the trusted-head blocker when runtime anchoring becomes unavailable", async () => {
    const backing = makeHeadAuthority();
    let available = true;
    const headAuthority: ActivityRecordingHeadAuthorityPort = {
      read: (streamId) => backing.read(streamId),
      compareAndSet: (input) => available
        ? backing.compareAndSet(input)
        : err(new Error("external head authority unavailable")),
    };
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(),
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
      streamId: "anchored-runtime-failure",
      headAuthority,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    available = false;

    const recorded = await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage(),
    });
    expect(recorded.ok).toBe(false);
    expect(!recorded.ok && recorded.error.reason).toBe("head_anchor_unavailable");

    const inspection = await opened.value.inspect();
    expect(inspection.ok && inspection.value.trustedHeadAnchor).toBe(false);
    expect(inspection.ok && inspection.value.exactness.blockers).toContain(
      "trusted_external_head_anchor_missing",
    );
  });

  it("revalidates trusted-head deletion and tampering for every inspection and export", async () => {
    let head: ActivityRecordingTrustedHead | undefined;
    let lastValidHead: ActivityRecordingTrustedHead | undefined;
    const authority: ActivityRecordingHeadAuthorityPort = {
      read: () => ok(head),
      compareAndSet: ({ expected, next }) => {
        if (JSON.stringify(expected) !== JSON.stringify(head)) return ok("conflict");
        head = structuredClone(next);
        lastValidHead = structuredClone(next);
        return ok("updated");
      },
    };
    const opened = openSqliteProductionActivityRecorder({
      dbPath: makePath(), crypto: makeCrypto(), limits: generousLimits, nowMs,
      streamId: "revalidated-head", headAuthority: authority,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect((await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_000, message: makeMessage(),
    })).ok).toBe(true);

    head = undefined;
    const deletedInspection = await opened.value.inspect();
    expect(deletedInspection.ok && deletedInspection.value.trustedHeadAnchor).toBe(false);
    expect(deletedInspection.ok && deletedInspection.value.exactness.blockers).toContain(
      "trusted_external_head_anchor_missing",
    );
    const deletedExport = await opened.value.exportEvidence({ limit: 1 });
    expect(deletedExport.ok && deletedExport.value.inspection.trustedHeadAnchor).toBe(false);

    expect(lastValidHead).toBeDefined();
    head = lastValidHead === undefined
      ? undefined
      : { ...lastValidHead, stateHash: "f".repeat(64) };
    const tamperedInspection = await opened.value.inspect();
    expect(tamperedInspection.ok && tamperedInspection.value.trustedHeadAnchor).toBe(false);
    await opened.value.close();
  });

  it("detects tail deletion and an old database snapshot through the external head", async () => {
    const dbPath = makePath();
    const snapshotPath = `${dbPath}.snapshot`;
    const crypto = makeCrypto();
    const headAuthority = makeHeadAuthority();
    const options = {
      dbPath,
      crypto,
      limits: generousLimits,
      nowMs,
      streamId: "production-machine-a",
      headAuthority,
    };
    const first = openSqliteProductionActivityRecorder(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage({ text: "first" }),
    });
    await first.value.close();
    copyFileSync(dbPath, snapshotPath);

    const second = openSqliteProductionActivityRecorder(options);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await second.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_001,
      message: makeMessage({ text: "second" }),
    });
    await second.value.close();
    expect(headAuthority.snapshot("production-machine-a")?.sequence).toBe(2);

    copyFileSync(snapshotPath, dbPath);
    expect(openSqliteProductionActivityRecorder(options).ok).toBe(false);
  });

  it("detects a full database reset while the trusted head survives", async () => {
    const dbPath = makePath();
    const headAuthority = makeHeadAuthority();
    const options = {
      dbPath,
      crypto: makeCrypto(),
      limits: generousLimits,
      nowMs,
      streamId: "production-machine-reset",
      headAuthority,
    };
    const opened = openSqliteProductionActivityRecorder(options);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: makeMessage(),
    });
    await opened.value.close();
    unlinkSync(dbPath);

    expect(openSqliteProductionActivityRecorder(options).ok).toBe(false);
  });

  it("rejects a prefix transplanted from another anchored database", async () => {
    const dbA = makePath();
    const dbB = makePath();
    const crypto = makeCrypto();
    const headAuthority = makeHeadAuthority();
    const base = { crypto, limits: generousLimits, nowMs, headAuthority };
    const a = openSqliteProductionActivityRecorder({ ...base, dbPath: dbA, streamId: "machine-a" });
    const b = openSqliteProductionActivityRecorder({ ...base, dbPath: dbB, streamId: "machine-b" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    await a.value.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_000, message: makeMessage({ text: "a" }),
    });
    await b.value.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_000, message: makeMessage({ text: "b" }),
    });
    await a.value.close();
    await b.value.close();
    copyFileSync(dbA, dbB);

    expect(openSqliteProductionActivityRecorder({
      ...base, dbPath: dbB, streamId: "machine-b",
    }).ok).toBe(false);
  });
});
