// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  TypedEventBus,
  createConversationRef,
  safePath,
  type BackgroundTaskOrigin,
  type TimerHandle,
} from "@comis/core";
import { err, ok } from "@comis/shared";
import { createBackgroundTaskRecoveryController } from "./background-task-recovery-controller.js";

function makeOrigin(): BackgroundTaskOrigin {
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "echo-main",
    conversationId: "conversation-a",
    conversationKind: "direct" as const,
  };
  const conversation = {
    tenantId: "default",
    agentId: "agent-a",
    partition: {
      kind: "endpoint-conversation-principal" as const,
      endpoint,
      principalId: "user_a",
    },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    turnScope: {
      conversation,
      principal: { principalId: "user_a" },
      endpoint,
    },
    conversationRef: conversationRef.value,
    deliveryOrigin: {
      tenantId: "default",
      userId: "user_a",
      channelType: "echo",
      channelId: "conversation-a",
    },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
  };
}

describe("background task recovery controller", () => {
  it("surfaces and retries a failed canonical incident write", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const eventBus = new TypedEventBus();
    const notified = vi.fn();
    const systemErrors = vi.fn();
    eventBus.on("background_task:notified", notified);
    eventBus.on("system:error", systemErrors);
    let retry: (() => void) | undefined;
    const handle: TimerHandle = {
      cancelled: false,
      cancel: vi.fn(),
      unref: vi.fn(),
    };
    const recorder = vi.fn()
      .mockReturnValueOnce(err(new Error("trajectory unavailable")))
      .mockReturnValue(ok("accepted" as const));
    const controller = createBackgroundTaskRecoveryController({
      eventBus,
      logger: { warn: vi.fn() },
      clock: { now: () => 10, nowDate: () => new Date(10) },
      dataDir,
      timers: {
        setTimeout: (callback) => {
          retry = callback;
          return handle;
        },
        setInterval: vi.fn(),
      },
    });
    controller.setRecorder(recorder);

    controller.recordTask({
      id: "task-a",
      toolName: "report",
      origin: makeOrigin(),
    });

    expect(notified).not.toHaveBeenCalled();
    expect(systemErrors).toHaveBeenCalledTimes(1);
    retry?.();
    expect(recorder).toHaveBeenCalledTimes(2);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-a",
      reason: "recovery_retry_required",
      trajectoryRecorded: true,
    }));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("backs off repeated scan failures and records task resolution", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const eventBus = new TypedEventBus();
    const systemErrors = vi.fn();
    const notified = vi.fn();
    eventBus.on("system:error", systemErrors);
    eventBus.on("background_task:notified", notified);
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    let now = 0;
    const logger = { warn: vi.fn() };
    const recorder = vi.fn(() => ok("accepted" as const));
    const controller = createBackgroundTaskRecoveryController({
      eventBus,
      logger,
      clock: { now: () => now, nowDate: () => new Date(now) },
      dataDir,
      timers: {
        setTimeout: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return {
            cancelled: false,
            cancel: vi.fn(),
            unref: vi.fn(),
          };
        },
        setInterval: vi.fn(),
      },
    });
    controller.setRecorder(recorder);
    const identity = {
      id: "task-scan",
      toolName: "report",
      origin: makeOrigin(),
    };
    const retry = vi.fn();

    controller.reportScanFailures(
      [{ kind: "task_validation", identity }],
      [],
      retry,
    );
    expect(scheduled[0]?.delayMs).toBe(1_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(systemErrors).toHaveBeenCalledTimes(1);

    scheduled[0]?.callback();
    now = 1_000;
    controller.reportScanFailures(
      [{ kind: "task_validation", identity }],
      [],
      retry,
    );
    expect(scheduled[1]?.delayMs).toBe(2_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(systemErrors).toHaveBeenCalledTimes(1);

    scheduled[1]?.callback();
    now = 3_000;
    controller.reportScanFailures([], [], retry);

    expect(recorder).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: "task-scan",
      reason: "recovery_resolved",
    }));
    expect(notified).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: "task-scan",
      reason: "recovery_resolved",
      trajectoryRecorded: true,
    }));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("serializes required evidence before resolution and restores authority after restart", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const eventBus = new TypedEventBus();
    const timers = {
      setTimeout: vi.fn(() => ({
        cancelled: false,
        cancel: vi.fn(),
        unref: vi.fn(),
      })),
      setInterval: vi.fn(),
    };
    const firstRecorder = vi.fn(() => ok("accepted" as const));
    const first = createBackgroundTaskRecoveryController({
      eventBus,
      logger: { warn: vi.fn() },
      clock: { now: () => 10, nowDate: () => new Date(10) },
      timers,
      dataDir,
    });
    first.setRecorder(firstRecorder);
    const identity = {
      id: "task-restart",
      toolName: "report",
      origin: makeOrigin(),
    };

    first.reportScanFailures(
      [{ kind: "task_validation", identity }],
      [],
      vi.fn(),
    );
    expect(firstRecorder).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-restart",
      reason: "recovery_retry_required",
    }));

    const secondRecorder = vi.fn(() => ok("accepted" as const));
    const restarted = createBackgroundTaskRecoveryController({
      eventBus,
      logger: { warn: vi.fn() },
      clock: { now: () => 20, nowDate: () => new Date(20) },
      timers,
      dataDir,
    });
    restarted.setRecorder(secondRecorder);
    restarted.reportScanFailures([], [], vi.fn());

    expect(secondRecorder.mock.calls.map(([input]) => input.reason)).toEqual([
      "recovery_resolved",
    ]);
    const thirdRecorder = vi.fn(() => ok("accepted" as const));
    const afterResolution = createBackgroundTaskRecoveryController({
      eventBus,
      logger: { warn: vi.fn() },
      clock: { now: () => 30, nowDate: () => new Date(30) },
      timers,
      dataDir,
    });
    afterResolution.setRecorder(thirdRecorder);
    expect(thirdRecorder).not.toHaveBeenCalled();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("retains a pending required record when resolution is requested", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const scheduled: Array<() => void> = [];
    const recorder = vi.fn()
      .mockReturnValueOnce(err(new Error("trajectory unavailable")))
      .mockReturnValue(ok("accepted" as const));
    const controller = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger: { warn: vi.fn() },
      clock: { now: () => 10, nowDate: () => new Date(10) },
      timers: {
        setTimeout: (callback) => {
          scheduled.push(callback);
          return {
            cancelled: false,
            cancel: vi.fn(),
            unref: vi.fn(),
          };
        },
        setInterval: vi.fn(),
      },
      dataDir,
    });
    controller.setRecorder(recorder);
    const task = {
      id: "task-ordered",
      toolName: "report",
      origin: makeOrigin(),
    };

    controller.recordTask(task);
    controller.resolveTask(task);
    scheduled.shift()?.();

    expect(recorder.mock.calls.map(([input]) => input.reason)).toEqual([
      "recovery_retry_required",
      "recovery_retry_required",
      "recovery_resolved",
    ]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("persists authority before accepting canonical recovery evidence", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    let storageAvailable = false;
    const scheduled: Array<() => void> = [];
    const recorder = vi.fn(() => ok("accepted" as const));
    const controller = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger: { warn: vi.fn() },
      clock: { now: () => 10, nowDate: () => new Date(10) },
      timers: {
        setTimeout: (callback) => {
          scheduled.push(callback);
          return {
            cancelled: false,
            cancel: vi.fn(),
            unref: vi.fn(),
          };
        },
        setInterval: vi.fn(),
      },
      dataDir,
      persistenceOps: {
        open: vi.fn((...args: Parameters<typeof openSync>) => {
          if (!storageAvailable) throw new Error("storage unavailable");
          return openSync(...args);
        }) as never,
        write: writeFileSync,
        sync: fsyncSync,
        close: closeSync,
        rename: renameSync,
        unlink: unlinkSync,
      },
    });
    controller.setRecorder(recorder);

    controller.recordTask({
      id: "task-storage-order",
      toolName: "report",
      origin: makeOrigin(),
    });

    expect(recorder).not.toHaveBeenCalled();
    const restartedRecorder = vi.fn(() => ok("accepted" as const));
    const restarted = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger: { warn: vi.fn() },
      clock: { now: () => 20, nowDate: () => new Date(20) },
      timers: {
        setTimeout: vi.fn(),
        setInterval: vi.fn(),
      } as never,
      dataDir,
    });
    restarted.setRecorder(restartedRecorder);
    restarted.reportScanFailures([], [], vi.fn());
    expect(restartedRecorder).not.toHaveBeenCalled();
    storageAvailable = true;
    scheduled.shift()?.();
    expect(recorder).toHaveBeenCalledTimes(1);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("closes suppressed recovery authority without claiming trajectory acceptance", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const eventBus = new TypedEventBus();
    const notified = vi.fn();
    eventBus.on("background_task:notified", notified);
    const recorder = vi.fn(() => ok("suppressed" as const));
    const controller = createBackgroundTaskRecoveryController({
      eventBus,
      logger: { warn: vi.fn() },
      clock: { now: () => 10, nowDate: () => new Date(10) },
      timers: {
        setTimeout: vi.fn(),
        setInterval: vi.fn(),
      } as never,
      dataDir,
    });
    controller.setRecorder(recorder);
    const task = {
      id: "task-suppressed",
      toolName: "report",
      origin: makeOrigin(),
    };

    controller.recordTask(task);
    controller.resolveTask(task);

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(notified).not.toHaveBeenCalledWith(expect.objectContaining({
      trajectoryRecorded: true,
    }));
    const restartedRecorder = vi.fn(() => ok("accepted" as const));
    const restarted = createBackgroundTaskRecoveryController({
      eventBus,
      logger: { warn: vi.fn() },
      clock: { now: () => 20, nowDate: () => new Date(20) },
      timers: {
        setTimeout: vi.fn(),
        setInterval: vi.fn(),
      } as never,
      dataDir,
    });
    restarted.setRecorder(restartedRecorder);
    restarted.reportScanFailures([], [], vi.fn());
    expect(restartedRecorder).not.toHaveBeenCalled();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("resolves removed task authority after restart before replaying lifecycle", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const timers = {
      setTimeout: vi.fn(() => ({
        cancelled: false,
        cancel: vi.fn(),
        unref: vi.fn(),
      })),
      setInterval: vi.fn(),
    };
    const first = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger: { warn: vi.fn() },
      clock: { now: () => 10, nowDate: () => new Date(10) },
      timers,
      dataDir,
    });
    first.setRecorder(vi.fn(() => ok("accepted" as const)));
    first.recordTask({
      id: "task-removed",
      toolName: "report",
      origin: makeOrigin(),
    });

    const recorder = vi.fn(() => ok("accepted" as const));
    const restarted = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger: { warn: vi.fn() },
      clock: { now: () => 20, nowDate: () => new Date(20) },
      timers,
      dataDir,
    });
    restarted.setRecorder(recorder);
    restarted.reportScanFailures([], [], vi.fn());

    expect(recorder.mock.calls.map(([input]) => input.reason)).toEqual([
      "recovery_resolved",
    ]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("applies latched scan and closed-task resolution after authority load retry", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const timers = {
      setTimeout: vi.fn(() => ({
        cancelled: false,
        cancel: vi.fn(),
        unref: vi.fn(),
      })),
      setInterval: vi.fn(),
    };
    const task = {
      id: "task-delayed-load",
      toolName: "report",
      origin: makeOrigin(),
    };
    const first = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger: { warn: vi.fn() },
      clock: { now: () => 10, nowDate: () => new Date(10) },
      timers,
      dataDir,
    });
    first.setRecorder(vi.fn(() => ok("accepted" as const)));
    first.recordTask(task);

    let storageAvailable = false;
    let loadRetry: (() => void) | undefined;
    const recorder = vi.fn(() => ok("accepted" as const));
    const restarted = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger: { warn: vi.fn() },
      clock: { now: () => 20, nowDate: () => new Date(20) },
      timers: {
        setTimeout: (callback) => {
          loadRetry = callback;
          return {
            cancelled: false,
            cancel: vi.fn(),
            unref: vi.fn(),
          };
        },
        setInterval: vi.fn(),
      },
      dataDir,
      authorityRecoveryOps: {
        readdir: (path) => {
          if (!storageAvailable) throw new Error("storage unavailable");
          return readdirSync(path);
        },
        stat: statSync,
        read: (path) => readFileSync(path, "utf-8"),
      },
    });
    restarted.setRecorder(recorder);
    restarted.reportScanFailures([], [task.id], vi.fn());
    restarted.resolveTask(task);

    storageAvailable = true;
    loadRetry?.();

    expect(recorder.mock.calls.map(([input]) => input.reason)).toEqual([
      "recovery_resolved",
    ]);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
