// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ComisLogger, ProductionActivityRecorderPort } from "@comis/core";
import { AppConfigSchema } from "@comis/core";
import { openWorkerProductionActivityRecorder } from "@comis/memory";
import { ok } from "@comis/shared";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";

vi.mock("@comis/memory", () => ({
  openWorkerProductionActivityRecorder: vi.fn(),
}));

import { setupProductionActivityRecorder } from "./setup-production-activity-recorder.js";

function makeRecorder(): ProductionActivityRecorderPort {
  return {
    recordInboundChannelActivity: vi.fn(),
    beginDeliveryPlatformAttempt: vi.fn(),
    finishDeliveryPlatformAttempt: vi.fn(),
    exportEvidence: vi.fn(),
    inspect: vi.fn(),
    close: vi.fn(async () => ok(undefined)),
  } as unknown as ProductionActivityRecorderPort;
}

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
}

const enabledConfig = AppConfigSchema.parse({
  observability: { activityRecording: { enabled: true } },
}).observability.activityRecording;

describe("setup production activity recorder failure containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a rejected worker open to a setup Result", async () => {
    vi.mocked(openWorkerProductionActivityRecorder).mockRejectedValue(new Error("worker rejected"));

    const result = await setupProductionActivityRecorder({
      config: enabledConfig,
      dataDir: "/tmp/comis-recorder-open-rejection-test",
      activityRecordingMasterKey: randomBytes(32),
      clock: { now: () => 100 },
      timers: createFakeTimers(),
      logger: makeLogger(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Production activity recorder worker open failed");
      expect(result.error.message).not.toContain("worker rejected");
    }
  });

  it("fails before worker open when the setup clock is unavailable", async () => {
    const recorder = makeRecorder();
    vi.mocked(openWorkerProductionActivityRecorder).mockResolvedValue(ok(recorder));

    const result = await setupProductionActivityRecorder({
      config: enabledConfig,
      dataDir: "/tmp/comis-recorder-clock-test",
      activityRecordingMasterKey: randomBytes(32),
      clock: { now: () => { throw new Error("clock failed"); } },
      timers: createFakeTimers(),
      logger: makeLogger(),
    });

    expect(result.ok).toBe(false);
    expect(openWorkerProductionActivityRecorder).not.toHaveBeenCalled();
    expect(recorder.close).not.toHaveBeenCalled();
  });

  it("closes an opened worker when the completion clock fails", async () => {
    const recorder = makeRecorder();
    vi.mocked(openWorkerProductionActivityRecorder).mockResolvedValue(ok(recorder));
    let reads = 0;

    const result = await setupProductionActivityRecorder({
      config: enabledConfig,
      dataDir: "/tmp/comis-recorder-clock-test",
      activityRecordingMasterKey: randomBytes(32),
      clock: {
        now: () => {
          reads += 1;
          if (reads === 1) return 100;
          throw new Error("completion clock failed");
        },
      },
      timers: createFakeTimers(),
      logger: makeLogger(),
    });

    expect(result.ok).toBe(false);
    expect(recorder.close).toHaveBeenCalledTimes(1);
  });

  it("closes an opened worker when completion logging throws", async () => {
    const recorder = makeRecorder();
    vi.mocked(openWorkerProductionActivityRecorder).mockResolvedValue(ok(recorder));
    const logger = makeLogger();
    vi.mocked(logger.info).mockImplementation(() => { throw new Error("logger failed"); });

    const result = await setupProductionActivityRecorder({
      config: enabledConfig,
      dataDir: "/tmp/comis-recorder-logger-test",
      activityRecordingMasterKey: randomBytes(32),
      clock: { now: () => 100 },
      timers: createFakeTimers(),
      logger,
    });

    expect(result.ok).toBe(false);
    expect(recorder.close).toHaveBeenCalledTimes(1);
  });
});
