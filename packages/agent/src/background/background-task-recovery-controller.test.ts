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
import type {
  BackgroundRecoveryRecorderFailure,
  BackgroundRecoveryRecorderFailureKind,
} from "./background-task-manager.js";

function makeRecorderFailure(
  kind: BackgroundRecoveryRecorderFailureKind,
): BackgroundRecoveryRecorderFailure {
  return { kind, cause: new Error("trajectory unavailable") };
}

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
    const logger = { warn: vi.fn() };
    eventBus.on("background_task:notified", notified);
    eventBus.on("system:error", systemErrors);
    let retry: (() => void) | undefined;
    const handle: TimerHandle = {
      cancelled: false,
      cancel: vi.fn(),
      unref: vi.fn(),
    };
    const recorder = vi.fn()
      .mockReturnValueOnce(err(makeRecorderFailure("recorder_rejected")))
      .mockReturnValue(ok("accepted" as const));
    const controller = createBackgroundTaskRecoveryController({
      eventBus,
      logger,
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
    expect(systemErrors).toHaveBeenCalledWith(expect.objectContaining({
      source: "background-recovery-recorder-capacity",
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("recorder queue capacity"),
        errorKind: "resource",
      }),
      "Background recovery trajectory admission rejected",
    );
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

  it("maps closed recorder failures to actionable health evidence", () => {
    const cases = [
      {
        kind: "session_adapter_unavailable",
        source: "background-recovery-session-adapter",
        message: "Background recovery session adapter unavailable",
        hint: "agent session adapter",
        errorKind: "precondition",
      },
      {
        kind: "protected_path_unavailable",
        source: "background-recovery-trajectory-path",
        message: "Background recovery trajectory path unavailable",
        hint: "path permissions",
        errorKind: "resource",
      },
      {
        kind: "persisted_state_invalid",
        source: "background-recovery-trajectory-state",
        message: "Background recovery trajectory state invalid",
        hint: "persisted trajectory JSONL",
        errorKind: "validation",
      },
      {
        kind: "recorder_rejected",
        source: "background-recovery-recorder-capacity",
        message: "Background recovery trajectory admission rejected",
        hint: "recorder queue capacity",
        errorKind: "resource",
      },
    ] as const;

    for (const entry of cases) {
      const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
      mkdirSync(dataDir, { recursive: true });
      const eventBus = new TypedEventBus();
      const systemErrors = vi.fn();
      const logger = { warn: vi.fn() };
      eventBus.on("system:error", systemErrors);
      const controller = createBackgroundTaskRecoveryController({
        eventBus,
        logger,
        clock: { now: () => 10, nowDate: () => new Date(10) },
        dataDir,
        timers: {
          setTimeout: vi.fn(() => ({
            cancelled: false,
            cancel: vi.fn(),
            unref: vi.fn(),
          })),
          setInterval: vi.fn(),
        },
      });
      controller.setRecorder(vi.fn(() => err(makeRecorderFailure(entry.kind))));

      controller.recordTask({
        id: `task-${entry.kind}`,
        toolName: "report",
        origin: makeOrigin(),
      });

      expect(systemErrors).toHaveBeenCalledWith(expect.objectContaining({
        source: entry.source,
      }));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: expect.stringContaining(entry.hint),
          errorKind: entry.errorKind,
        }),
        entry.message,
      );
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("caps recorder retry backoff and resets after accepted recording", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const logger = { warn: vi.fn() };
    let accepted = false;
    const recorder = vi.fn(() => accepted
      ? ok("accepted" as const)
      : err(makeRecorderFailure("recorder_rejected")));
    const controller = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger,
      clock: { now: () => 10, nowDate: () => new Date(10) },
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
    const task = {
      id: "task-recorder-backoff",
      toolName: "report",
      origin: makeOrigin(),
    };

    controller.recordTask(task);
    controller.recordTask(task);
    expect(scheduled).toHaveLength(1);
    for (let index = 0; index < 7; index++) {
      scheduled[index]?.callback();
    }
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      60_000,
      60_000,
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    accepted = true;
    scheduled[7]?.callback();
    accepted = false;
    controller.resolveTask(task);

    expect(scheduled[8]?.delayMs).toBe(1_000);
    expect(logger.warn).toHaveBeenCalledTimes(2);
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
      .mockReturnValueOnce(err(makeRecorderFailure("protected_path_unavailable")))
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

  it("backs off authority storage retries and resets after confirmed commit", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const logger = { warn: vi.fn() };
    let storageAvailable = false;
    let unlinkAvailable = true;
    const controller = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger,
      clock: { now: () => 10, nowDate: () => new Date(10) },
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
      dataDir,
      persistenceOps: {
        open: (path, flags, mode) => {
          if (!storageAvailable) throw new Error("storage unavailable");
          return openSync(path, flags, mode);
        },
        write: writeFileSync,
        sync: fsyncSync,
        close: closeSync,
        rename: renameSync,
        unlink: (path) => {
          if (!unlinkAvailable) throw new Error("unlink unavailable");
          unlinkSync(path);
        },
      },
    });
    controller.setRecorder(vi.fn(() => ok("accepted" as const)));
    const task = {
      id: "task-authority-backoff",
      toolName: "report",
      origin: makeOrigin(),
    };

    controller.recordTask(task);
    scheduled[0]?.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([1_000, 2_000]);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    storageAvailable = true;
    scheduled[1]?.callback();
    unlinkAvailable = false;
    controller.resolveTask(task);

    expect(scheduled[2]?.delayMs).toBe(1_000);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("waits for confirmed authority durability before canonical recording", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const eventBus = new TypedEventBus();
    const systemErrors = vi.fn();
    eventBus.on("system:error", systemErrors);
    const logger = { warn: vi.fn() };
    const scheduled: Array<() => void> = [];
    const directoryDescriptors = new Set<number>();
    let directorySyncFailures = 2;
    const recorder = vi.fn(() => ok("accepted" as const));
    const controller = createBackgroundTaskRecoveryController({
      eventBus,
      logger,
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
        open: (path, flags, mode) => {
          const fd = openSync(path, flags, mode);
          if (flags === "r") directoryDescriptors.add(fd);
          return fd;
        },
        write: writeFileSync,
        sync: (fd) => {
          if (directoryDescriptors.has(fd) && directorySyncFailures > 0) {
            directorySyncFailures--;
            throw new Error("directory sync unavailable");
          }
          fsyncSync(fd);
        },
        close: (fd) => {
          directoryDescriptors.delete(fd);
          closeSync(fd);
        },
        rename: renameSync,
        unlink: unlinkSync,
      },
    });
    controller.setRecorder(recorder);

    controller.recordTask({
      id: "task-durability-order",
      toolName: "report",
      origin: makeOrigin(),
    });

    expect(recorder).not.toHaveBeenCalled();
    expect(systemErrors).toHaveBeenCalledWith(expect.objectContaining({
      source: "background-recovery-authority-storage",
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("authority storage"),
        errorKind: "resource",
      }),
      "Background recovery authority persistence failed",
    );
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

  it("retains accepted authority while resolution recording is suppressed", () => {
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
      id: "task-resolution-suppressed",
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

    const suppressedTimers = {
      setTimeout: vi.fn(() => ({
        cancelled: false,
        cancel: vi.fn(),
        unref: vi.fn(),
      })),
      setInterval: vi.fn(),
    };
    const suppressedLogger = { warn: vi.fn() };
    const suppressedRecorder = vi.fn(() => ok("suppressed" as const));
    const suppressed = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger: suppressedLogger,
      clock: { now: () => 20, nowDate: () => new Date(20) },
      timers: suppressedTimers,
      dataDir,
    });
    suppressed.setRecorder(suppressedRecorder);
    suppressed.reportScanFailures([], [], vi.fn());

    expect(suppressedRecorder.mock.calls.map(([input]) => input.reason)).toEqual([
      "recovery_resolved",
    ]);
    expect(suppressedTimers.setTimeout).not.toHaveBeenCalled();
    expect(suppressedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("diagnostics.trajectory.enabled"),
        errorKind: "config",
      }),
      "Background recovery resolution is suppressed",
    );

    const acceptedRecorder = vi.fn(() => ok("accepted" as const));
    const accepted = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger: { warn: vi.fn() },
      clock: { now: () => 30, nowDate: () => new Date(30) },
      timers,
      dataDir,
    });
    accepted.setRecorder(acceptedRecorder);
    accepted.reportScanFailures([], [], vi.fn());

    expect(acceptedRecorder.mock.calls.map(([input]) => input.reason)).toEqual([
      "recovery_resolved",
    ]);
    const afterResolutionRecorder = vi.fn(() => ok("accepted" as const));
    const afterResolution = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger: { warn: vi.fn() },
      clock: { now: () => 40, nowDate: () => new Date(40) },
      timers,
      dataDir,
    });
    afterResolution.setRecorder(afterResolutionRecorder);
    afterResolution.reportScanFailures([], [], vi.fn());
    expect(afterResolutionRecorder).not.toHaveBeenCalled();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports authority unlink failures against protected storage", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-controller-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const logger = { warn: vi.fn() };
    const controller = createBackgroundTaskRecoveryController({
      eventBus: new TypedEventBus(),
      logger,
      clock: { now: () => 10, nowDate: () => new Date(10) },
      timers: {
        setTimeout: vi.fn(() => ({
          cancelled: false,
          cancel: vi.fn(),
          unref: vi.fn(),
        })),
        setInterval: vi.fn(),
      },
      dataDir,
      persistenceOps: {
        open: openSync,
        write: writeFileSync,
        sync: fsyncSync,
        close: closeSync,
        rename: renameSync,
        unlink: vi.fn(() => {
          throw new Error("unlink unavailable");
        }),
      },
    });
    controller.setRecorder(vi.fn(() => ok("accepted" as const)));
    const task = {
      id: "task-unlink-failure",
      toolName: "report",
      origin: makeOrigin(),
    };

    controller.recordTask(task);
    controller.resolveTask(task);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("authority storage"),
        errorKind: "resource",
      }),
      "Background recovery authority persistence failed",
    );
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
