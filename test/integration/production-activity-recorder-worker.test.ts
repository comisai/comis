// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openWorkerProductionActivityRecorder,
} from "@comis/memory";
import { createFakeClock } from "../support/fake-clock.js";
import { createFakeTimers } from "../support/fake-timers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runNodeScript(script: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Recorder child failed with code ${code}: ${stderr}`));
    });
  });
}

async function waitForMarker(path: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 10_000 });
}

describe("production activity recorder worker integration", () => {
  it("persists and authenticates activity outside the daemon request thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-recorder-worker-"));
    tempDirs.push(dir);
    const opened = await openWorkerProductionActivityRecorder({
      dbPath: join(dir, "activity.db"),
      masterKey: randomBytes(32),
      limits: {
        maxPayloadBytes: 256 * 1024,
        maxStoredBytes: 8 * 1024 * 1024,
        maxRecords: 10_000,
        gapReserveBytes: 64 * 1024,
        gapReserveRecords: 100,
        busyTimeoutMs: 100,
      },
      clock: createFakeClock(1_700_000_000_000),
      timers: createFakeTimers(),
      handoffCapacity: 16,
      operationTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const recorded = await opened.value.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: {
        id: randomUUID(),
        channelId: "chat_a",
        channelType: "telegram",
        senderId: "user_a",
        text: "private prompt",
        timestamp: 1_700_000_000_000,
        attachments: [],
        metadata: {},
      },
    });
    expect(recorded.ok).toBe(true);
    const inspection = await opened.value.inspect();
    expect(inspection.ok && inspection.value.recordCount).toBe(1);
    expect((await opened.value.close()).ok).toBe(true);
  });

  it("serializes recorder commits made by independent operating-system processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-recorder-processes-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "activity.db");
    const childScript = `
      import { randomUUID } from "node:crypto";
      import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { createSystemClock, createSystemTimers } from "@comis/infra";
      import { openWorkerProductionActivityRecorder } from "@comis/memory";
      const [dbPath, ordinal, barrierDir] = process.argv.slice(1);
      const keepAlive = setInterval(() => {}, 1000);
      writeFileSync(join(barrierDir, "ready-" + ordinal), "");
      while (!existsSync(join(barrierDir, "start"))) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const opened = await openWorkerProductionActivityRecorder({
        dbPath,
        streamId: "process-contention",
        masterKey: Buffer.alloc(32, 7),
        limits: {
          maxPayloadBytes: 262144, maxStoredBytes: 8388608, maxRecords: 10000,
          gapReserveBytes: 65536, gapReserveRecords: 100, busyTimeoutMs: 5000,
        },
        clock: createSystemClock(), timers: createSystemTimers(),
        handoffCapacity: 16, operationTimeoutMs: 5000, startupTimeoutMs: 10000,
      });
      if (!opened.ok) throw opened.error;
      const recorded = await opened.value.recordInboundChannelActivity({
        traceId: randomUUID(), occurredAtMs: 1700000000000 + Number(ordinal),
        message: {
          id: randomUUID(), channelId: "chat_a", channelType: "telegram", senderId: "user_a",
          text: "process-" + ordinal, timestamp: 1700000000000, attachments: [], metadata: {},
        },
      });
      if (!recorded.ok) throw recorded.error.cause;
      const closed = await opened.value.close();
      if (!closed.ok) throw closed.error;
      clearInterval(keepAlive);
    `;
    const children = [
      runNodeScript(childScript, [dbPath, "1", dir]),
      runNodeScript(childScript, [dbPath, "2", dir]),
    ];
    await Promise.all([waitForMarker(join(dir, "ready-1")), waitForMarker(join(dir, "ready-2"))]);
    writeFileSync(join(dir, "start"), "");
    await Promise.all(children);

    const reopened = await openWorkerProductionActivityRecorder({
      dbPath,
      streamId: "process-contention",
      masterKey: Buffer.alloc(32, 7),
      limits: {
        maxPayloadBytes: 256 * 1024,
        maxStoredBytes: 8 * 1024 * 1024,
        maxRecords: 10_000,
        gapReserveBytes: 64 * 1024,
        gapReserveRecords: 100,
        busyTimeoutMs: 5_000,
      },
      clock: createFakeClock(1_700_000_000_100),
      timers: createFakeTimers(),
      handoffCapacity: 16,
      operationTimeoutMs: 5_000,
      startupTimeoutMs: 5_000,
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const inspection = await reopened.value.inspect();
    expect(inspection.ok && inspection.value.recordCount).toBe(2);
    expect(inspection.ok && inspection.value.gapCount).toBe(0);
    await reopened.value.close();
  });

  it("keeps a live process writer authoritative while another process opens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-recorder-writer-lease-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "activity.db");
    const childScript = `
      import { randomUUID } from "node:crypto";
      import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { createSystemClock, createSystemTimers } from "@comis/infra";
      import { openWorkerProductionActivityRecorder } from "@comis/memory";
      const [dbPath, role, barrierDir] = process.argv.slice(1);
      const keepAlive = setInterval(() => {}, 1000);
      const waitFor = async (name) => {
        const deadline = Date.now() + 10000;
        while (!existsSync(join(barrierDir, name))) {
          if (Date.now() >= deadline) throw new Error("Timed out waiting for process barrier");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      const opened = await openWorkerProductionActivityRecorder({
        dbPath,
        streamId: "process-writer-lease",
        masterKey: Buffer.alloc(32, 9),
        limits: {
          maxPayloadBytes: 262144, maxStoredBytes: 8388608, maxRecords: 10000,
          gapReserveBytes: 65536, gapReserveRecords: 100, busyTimeoutMs: 100,
        },
        clock: createSystemClock(), timers: createSystemTimers(),
        handoffCapacity: 16, operationTimeoutMs: 500, startupTimeoutMs: 10000,
        writerLeaseMs: 3000, writerHeartbeatMs: 500,
      });
      if (!opened.ok) throw opened.error;
      if (role === "owner") {
        const attempt = await opened.value.beginDeliveryPlatformAttempt({
          traceId: randomUUID(), occurredAtMs: Date.now(), channelType: "telegram",
          channelId: "chat_a", text: "process delivery", options: {},
          origin: "agent_response", chunkIndex: 0, totalChunks: 1,
        });
        if (!attempt.ok) throw attempt.error.cause;
        writeFileSync(join(barrierDir, "owner-ready"), "");
        await waitFor("owner-finish");
        const outcome = await opened.value.finishDeliveryPlatformAttempt({
          attempt: attempt.value, occurredAtMs: Date.now(), outcomeClass: "success",
          platformMessageId: "platform-message-a",
        });
        if (!outcome.ok) throw outcome.error.cause;
      } else {
        writeFileSync(join(barrierDir, "observer-ready"), "");
        await waitFor("observer-close");
        const inspection = await opened.value.inspect();
        if (!inspection.ok || inspection.value.gapCount !== 0
          || inspection.value.recordCount !== 2) {
          throw new Error("Concurrent observer saw a false writer-loss gap");
        }
      }
      const closed = await opened.value.close();
      if (!closed.ok) throw closed.error;
      clearInterval(keepAlive);
    `;

    const owner = runNodeScript(childScript, [dbPath, "owner", dir]);
    await waitForMarker(join(dir, "owner-ready"));
    const observer = runNodeScript(childScript, [dbPath, "observer", dir]);
    await waitForMarker(join(dir, "observer-ready"));
    writeFileSync(join(dir, "owner-finish"), "");
    await owner;
    writeFileSync(join(dir, "observer-close"), "");
    await observer;

    const reopened = await openWorkerProductionActivityRecorder({
      dbPath,
      streamId: "process-writer-lease",
      masterKey: Buffer.alloc(32, 9),
      limits: {
        maxPayloadBytes: 256 * 1024,
        maxStoredBytes: 8 * 1024 * 1024,
        maxRecords: 10_000,
        gapReserveBytes: 64 * 1024,
        gapReserveRecords: 100,
        busyTimeoutMs: 5_000,
      },
      clock: createFakeClock(1_700_000_000_100),
      timers: createFakeTimers(),
      handoffCapacity: 16,
      operationTimeoutMs: 5_000,
      startupTimeoutMs: 5_000,
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const inspection = await reopened.value.inspect();
    expect(inspection.ok && inspection.value.recordCount).toBe(2);
    expect(inspection.ok && inspection.value.gapCount).toBe(0);
    await reopened.value.close();
  });

  it("bounds aggregate evidence responses before worker transport cloning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-recorder-worker-frame-"));
    tempDirs.push(dir);
    const opened = await openWorkerProductionActivityRecorder({
      dbPath: join(dir, "activity.db"),
      masterKey: randomBytes(32),
      limits: {
        maxPayloadBytes: 4_096,
        maxStoredBytes: 8 * 1024 * 1024,
        maxRecords: 10_000,
        gapReserveBytes: 64 * 1024,
        gapReserveRecords: 100,
        busyTimeoutMs: 100,
      },
      clock: createFakeClock(1_700_000_000_000),
      timers: createFakeTimers(),
      handoffCapacity: 16,
      operationTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    for (let index = 0; index < 2; index++) {
      const recorded = await opened.value.recordInboundChannelActivity({
        traceId: randomUUID(),
        occurredAtMs: 1_700_000_000_000 + index,
        message: {
          id: randomUUID(), channelId: "chat_a", channelType: "telegram", senderId: "user_a",
          text: `${index}:${"x".repeat(3_400)}`,
          timestamp: 1_700_000_000_000 + index, attachments: [], metadata: {},
        },
      });
      expect(recorded.ok).toBe(true);
    }

    const aggregate = await opened.value.exportEvidence({ limit: 2 });
    expect(aggregate.ok).toBe(false);
    const boundedPage = await opened.value.exportEvidence({ limit: 1 });
    expect(boundedPage.ok).toBe(true);
    await opened.value.close();
  });
});
