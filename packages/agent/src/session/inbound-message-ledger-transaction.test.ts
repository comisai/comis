// SPDX-License-Identifier: Apache-2.0
/** Fault-injection coverage for the locked inbound-message ledger append. */

import { afterEach, describe, expect, it, vi } from "vitest";

const { writeFailure } = vi.hoisted(() => ({
  writeFailure: {
    enabled: false,
    calls: 0,
    fsyncCalls: 0,
    firstWriteBytes: 17,
  },
}));

const { readTracking } = vi.hoisted(() => ({
  readTracking: {
    snapshotCalls: 0,
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readSync: (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset?: number,
      length?: number,
      position?: number | bigint | null,
    ): number => {
      if ((length ?? buffer.byteLength) > 1) readTracking.snapshotCalls += 1;
      return real.readSync(fd, buffer, offset, length, position);
    },
    writeSync: (
      fd: number,
      buffer: Buffer,
      offset?: number,
      length?: number,
      position?: number | null,
    ): number => {
      if (!writeFailure.enabled) {
        return real.writeSync(fd, buffer, offset, length, position);
      }
      writeFailure.calls += 1;
      if (writeFailure.calls === 2) {
        throw Object.assign(new Error("EIO after partial ledger append"), {
          code: "EIO",
        });
      }
      const effectiveOffset = offset ?? 0;
      const effectiveLength = length ?? buffer.length - effectiveOffset;
      return real.writeSync(
        fd,
        buffer,
        effectiveOffset,
        Math.min(effectiveLength, writeFailure.firstWriteBytes),
        position,
      );
    },
    fsyncSync: (fd: number): void => {
      writeFailure.fsyncCalls += 1;
      real.fsyncSync(fd);
    },
  };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  type FileLockPort,
  type NormalizedMessage,
  type SessionKey,
} from "@comis/core";
import { ok } from "@comis/shared";
import { createComisSessionManager } from "./comis-session-manager.js";
import { planInboundMessageProvenance } from "./inbound-message-provenance.js";
import { sessionKeyToInboundMessageLedgerPath } from "./session-key-mapper.js";

const tempDirs: string[] = [];

afterEach(() => {
  writeFailure.enabled = false;
  writeFailure.calls = 0;
  writeFailure.fsyncCalls = 0;
  readTracking.snapshotCalls = 0;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-ledger-transaction-"));
  tempDirs.push(dir);
  return dir;
}

describe("persistInboundMessage", () => {
  it("reuses provenance after restart without treating receipt as completed processing", async () => {
    const fileLock = {
      withLock: vi.fn(async (
        _lockPath: string,
        callback: () => unknown | Promise<unknown>,
      ) => ok(await callback())),
      cleanupStaleLocks: vi.fn(async () => 0),
    } as unknown as FileLockPort;
    const sessionBaseDir = makeTempDir();
    const lockDir = makeTempDir();
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user_a",
      channelId: "telegram-chat",
      agentId: "default",
    };
    const message: NormalizedMessage = {
      id: "33333333-3333-4333-8333-333333333333",
      channelId: "telegram-chat",
      channelType: "telegram",
      senderId: "user_a",
      text: "one Telegram delivery",
      timestamp: 1_789_000_000_003,
      attachments: [],
      metadata: {},
    };
    const createManager = () => createComisSessionManager({
      sessionBaseDir,
      lockDir,
      cwd: sessionBaseDir,
      fileLock,
    });

    const first = await createManager().persistInboundMessage(
      sessionKey,
      message,
      1_789_000_100_002,
    );
    const afterRestart = await createManager().persistInboundMessage(
      sessionKey,
      message,
      1_789_000_100_003,
    );
    const identityCollision = await createManager().persistInboundMessage(
      sessionKey,
      { ...message, text: "different delivery with the same physical identity" },
      1_789_000_100_004,
    );

    expect(first).toMatchObject({ ok: true, value: { payloads: [{ batchId: message.id }] } });
    expect(afterRestart).toMatchObject({
      ok: true,
      value: { payloads: [{ batchId: message.id, recordedAt: 1_789_000_100_002 }] },
    });
    expect(identityCollision).toMatchObject({
      ok: false,
      error: { errorKind: "precondition" },
    });
    const ledgerPath = sessionKeyToInboundMessageLedgerPath(sessionKey, sessionBaseDir);
    expect(fs.readFileSync(ledgerPath, "utf8").trimEnd().split("\n")).toHaveLength(1);
  });

  it("does not reread an unchanged long-lived ledger and invalidates its index after replacement", async () => {
    const fileLock = {
      withLock: vi.fn(async (
        _lockPath: string,
        callback: () => unknown | Promise<unknown>,
      ) => ok(await callback())),
      cleanupStaleLocks: vi.fn(async () => 0),
    } as unknown as FileLockPort;
    const sessionBaseDir = makeTempDir();
    const manager = createComisSessionManager({
      sessionBaseDir,
      lockDir: makeTempDir(),
      cwd: sessionBaseDir,
      fileLock,
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user_a",
      channelId: "telegram-chat",
      agentId: "default",
    };
    const makeMessage = (index: number): NormalizedMessage => ({
      id: `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      channelId: "telegram-chat",
      channelType: "telegram",
      senderId: "user_a",
      text: `physical inbound message ${index}`,
      timestamp: 1_789_000_000_100 + index,
      attachments: [],
      metadata: {},
    });

    expect((await manager.persistInboundMessage(
      sessionKey,
      makeMessage(0),
      1_789_000_100_100,
    )).ok).toBe(true);
    readTracking.snapshotCalls = 0;
    for (let index = 1; index < 20; index += 1) {
      expect((await manager.persistInboundMessage(
        sessionKey,
        makeMessage(index),
        1_789_000_100_100 + index,
      )).ok).toBe(true);
    }
    expect(readTracking.snapshotCalls).toBe(0);

    const ledgerPath = sessionKeyToInboundMessageLedgerPath(sessionKey, sessionBaseDir);
    const conflicting = planInboundMessageProvenance(
      { ...makeMessage(0), text: "different content under the same source identity" },
      1_789_000_100_100,
    );
    expect(conflicting.ok).toBe(true);
    if (!conflicting.ok) return;
    const replacementPath = `${ledgerPath}.replacement`;
    fs.writeFileSync(replacementPath, conflicting.value.ledgerContent, { mode: 0o600 });
    fs.renameSync(replacementPath, ledgerPath);

    const afterReplacement = await manager.persistInboundMessage(
      sessionKey,
      makeMessage(0),
      1_789_000_100_999,
    );

    expect(afterReplacement).toMatchObject({
      ok: false,
      error: { errorKind: "precondition" },
    });
    expect(readTracking.snapshotCalls).toBeGreaterThan(0);
  });

  it("classifies complete malformed ledger records as integrity preconditions", async () => {
    const fileLock = {
      withLock: vi.fn(async (
        _lockPath: string,
        callback: () => unknown | Promise<unknown>,
      ) => ok(await callback())),
      cleanupStaleLocks: vi.fn(async () => 0),
    } as unknown as FileLockPort;
    const sessionBaseDir = makeTempDir();
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user_a",
      channelId: "telegram-chat",
      agentId: "default",
    };
    const ledgerPath = sessionKeyToInboundMessageLedgerPath(sessionKey, sessionBaseDir);
    const messageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, `${JSON.stringify({
      type: "custom",
      customType: INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
      data: { batchId: messageId },
    })}\n`, { mode: 0o600 });
    const manager = createComisSessionManager({
      sessionBaseDir,
      lockDir: makeTempDir(),
      cwd: sessionBaseDir,
      fileLock,
    });

    const result = await manager.persistInboundMessage(
      sessionKey,
      {
        id: messageId,
        channelId: "telegram-chat",
        channelType: "telegram",
        senderId: "user_a",
        text: "message after malformed provenance",
        timestamp: 1_789_000_000_200,
        attachments: [],
        metadata: {},
      },
      1_789_000_100_200,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { errorKind: "precondition" },
    });
  });

  it("repairs a crash after a complete chunk prefix and finishes the same batch", async () => {
    const fileLock = {
      withLock: vi.fn(async (
        _lockPath: string,
        callback: () => unknown | Promise<unknown>,
      ) => ok(await callback())),
      cleanupStaleLocks: vi.fn(async () => 0),
    } as unknown as FileLockPort;
    const sessionBaseDir = makeTempDir();
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user_a",
      channelId: "telegram-chat",
      agentId: "default",
    };
    const originalMessages = Array.from({ length: 40 }, (_, index) => ({
      id: `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      channelId: "telegram-chat",
      channelType: "telegram" as const,
      senderId: "user_a",
      text: "x".repeat(32_768),
      timestamp: 1_789_000_000_100 + index,
    }));
    const message: NormalizedMessage = {
      ...originalMessages.at(-1)!,
      attachments: [],
      metadata: {},
      text: "coalesced Telegram delivery",
      originalMessages,
    };
    const planned = planInboundMessageProvenance(message, 1_789_000_100_010);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.payloads.length).toBeGreaterThan(1);
    const lines = planned.value.ledgerContent.trimEnd().split("\n");
    const ledgerPath = sessionKeyToInboundMessageLedgerPath(sessionKey, sessionBaseDir);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, `${lines[0]}\n${lines[1]!.slice(0, 100)}`, "utf8");
    const manager = createComisSessionManager({
      sessionBaseDir,
      lockDir: makeTempDir(),
      cwd: sessionBaseDir,
      fileLock,
    });

    const recovered = await manager.persistInboundMessage(
      sessionKey,
      message,
      1_789_000_100_011,
    );

    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.payloads.every(
      (payload) => payload.recordedAt === 1_789_000_100_010,
    )).toBe(true);
    expect(fs.readFileSync(ledgerPath, "utf8").trimEnd().split("\n")).toHaveLength(
      planned.value.payloads.length,
    );
  });

  it("rolls a partial append back under the session lock so a retry writes one complete occurrence", async () => {
    const withLock = vi.fn(async (
      _lockPath: string,
      callback: () => unknown | Promise<unknown>,
    ) => ok(await callback()));
    const fileLock = {
      withLock,
      cleanupStaleLocks: vi.fn(async () => 0),
    } as unknown as FileLockPort;
    const sessionBaseDir = makeTempDir();
    const lockDir = makeTempDir();
    const manager = createComisSessionManager({
      sessionBaseDir,
      lockDir,
      cwd: sessionBaseDir,
      fileLock,
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user_a",
      channelId: "telegram-chat",
      agentId: "default",
    };
    const message: NormalizedMessage = {
      id: "11111111-1111-4111-8111-111111111111",
      channelId: "telegram-chat",
      channelType: "telegram",
      senderId: "user_a",
      text: "one physical inbound message",
      timestamp: 1_789_000_000_001,
      attachments: [],
      metadata: {},
    };
    const ledgerPath = sessionKeyToInboundMessageLedgerPath(
      sessionKey,
      sessionBaseDir,
    );

    writeFailure.enabled = true;
    const failed = await manager.persistInboundMessage(
      sessionKey,
      message,
      1_789_000_100_000,
    );

    expect(failed.ok).toBe(false);
    expect(failed).toMatchObject({
      ok: false,
      error: { errorKind: "resource" },
    });
    expect(withLock).toHaveBeenCalledOnce();
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe("");

    writeFailure.enabled = false;
    const retried = await manager.persistInboundMessage(
      sessionKey,
      message,
      1_789_000_100_000,
    );

    expect(retried.ok).toBe(true);
    expect(withLock).toHaveBeenCalledTimes(2);
    const lines = fs.readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "custom",
      data: {
        batchId: message.id,
        messages: [{ id: message.id, text: message.text }],
      },
    });
  });

  it("truncates a crash-torn final line before a retry appends and syncs one recoverable occurrence", async () => {
    const fileLock = {
      withLock: vi.fn(async (
        _lockPath: string,
        callback: () => unknown | Promise<unknown>,
      ) => ok(await callback())),
      cleanupStaleLocks: vi.fn(async () => 0),
    } as unknown as FileLockPort;
    const sessionBaseDir = makeTempDir();
    const manager = createComisSessionManager({
      sessionBaseDir,
      lockDir: makeTempDir(),
      cwd: sessionBaseDir,
      fileLock,
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user_a",
      channelId: "telegram-chat",
      agentId: "default",
    };
    const message: NormalizedMessage = {
      id: "22222222-2222-4222-8222-222222222222",
      channelId: "telegram-chat",
      channelType: "telegram",
      senderId: "user_a",
      text: "retry after interrupted append",
      timestamp: 1_789_000_000_002,
      attachments: [],
      metadata: {},
    };
    const ledgerPath = sessionKeyToInboundMessageLedgerPath(sessionKey, sessionBaseDir);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, '{"type":"custom","customType":"inbound-message-provenance"', "utf8");
    const retried = await manager.persistInboundMessage(
      sessionKey,
      message,
      1_789_000_100_001,
    );

    expect(retried.ok).toBe(true);
    expect(writeFailure.fsyncCalls).toBeGreaterThan(0);
    const lines = fs.readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "custom",
      data: { batchId: message.id },
    });
  });
});
