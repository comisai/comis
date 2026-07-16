// SPDX-License-Identifier: Apache-2.0
/** Composition-root setup for the opt-in prospective production recorder. */
import {
  ACTIVITY_RECORDING_EXACTNESS_BLOCKERS,
  safePath,
  type ActivityRecordingConfig,
  type ClockPort,
  type ComisLogger,
  type ProductionActivityRecorderPort,
  type TimerPort,
} from "@comis/core";
import { openWorkerProductionActivityRecorder } from "@comis/memory";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

export interface SetupProductionActivityRecorderDeps {
  readonly config: ActivityRecordingConfig;
  readonly dataDir: string;
  readonly activityRecordingMasterKey: Buffer | undefined;
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly logger: ComisLogger;
}

export interface ProductionActivityRecorderSetup {
  readonly activityRecorder: ProductionActivityRecorderPort | undefined;
}

/**
 * Disabled means no key access, path construction, directory creation, or DB
 * open. Enabled startup fails closed when durable key authority is unavailable.
 */
export async function setupProductionActivityRecorder(
  deps: SetupProductionActivityRecorderDeps,
): Promise<Result<ProductionActivityRecorderSetup, Error>> {
  if (!deps.config.enabled) return ok({ activityRecorder: undefined });
  if (deps.activityRecordingMasterKey === undefined) {
    return err(new Error(
      "Production activity recording requires encrypted security storage key authority",
    ));
  }
  const masterKey = deps.activityRecordingMasterKey;
  const started = tryCatch(() => deps.clock.now());
  if (!started.ok || !Number.isSafeInteger(started.value) || started.value < 0) {
    return err(new Error("Production activity recorder setup clock is unavailable"));
  }
  const dbPath = tryCatch(() => safePath(
    safePath(deps.dataDir, "observability"),
    "production-activity.db",
  ));
  if (!dbPath.ok) return dbPath;
  const openInvoked = tryCatch(() => openWorkerProductionActivityRecorder({
    dbPath: dbPath.value,
    masterKey,
    limits: {
      maxPayloadBytes: deps.config.maxPayloadBytes,
      maxStoredBytes: deps.config.maxStoredBytes,
      maxRecords: deps.config.maxRecords,
      gapReserveBytes: deps.config.gapReserveBytes,
      gapReserveRecords: deps.config.gapReserveRecords,
      busyTimeoutMs: deps.config.busyTimeoutMs,
    },
    clock: deps.clock,
    timers: deps.timers,
    handoffCapacity: deps.config.handoffCapacity,
    operationTimeoutMs: deps.config.operationTimeoutMs,
    startupTimeoutMs: deps.config.startupTimeoutMs,
  }));
  if (!openInvoked.ok) {
    return err(new Error("Production activity recorder worker open failed"));
  }
  const openAwaited = await fromPromise(openInvoked.value);
  if (!openAwaited.ok) {
    return err(new Error("Production activity recorder worker open failed"));
  }
  const opened = openAwaited.value;
  if (!opened.ok) return opened;
  const recorder = opened.value;
  async function failAfterOpen(message: string): Promise<Result<ProductionActivityRecorderSetup, Error>> {
    const closeInvoked = tryCatch(() => recorder.close());
    if (!closeInvoked.ok) {
      return err(new Error(`${message}; recorder cleanup also failed`));
    }
    const closed = await fromPromise(closeInvoked.value);
    if (!closed.ok || !closed.value.ok) {
      return err(new Error(`${message}; recorder cleanup also failed`));
    }
    return err(new Error(message));
  }
  const completed = tryCatch(() => deps.clock.now());
  if (!completed.ok || !Number.isSafeInteger(completed.value) || completed.value < 0) {
    return failAfterOpen("Production activity recorder completion clock is unavailable");
  }
  const logged = tryCatch(() => deps.logger.info({
    step: "activity-recording",
    durationMs: Math.max(0, completed.value - started.value),
    exactReplayEligible: false,
    blockerCount: ACTIVITY_RECORDING_EXACTNESS_BLOCKERS.length,
  }, "Prospective production activity recorder enabled"));
  if (!logged.ok) {
    return failAfterOpen("Production activity recorder completion logging failed");
  }
  return ok({ activityRecorder: recorder });
}
