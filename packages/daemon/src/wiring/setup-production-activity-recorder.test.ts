// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppConfigSchema,
  type ComisLogger,
} from "@comis/core";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { setupProductionActivityRecorder } from "./setup-production-activity-recorder.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "comis-recorder-setup-"));
  tempDirs.push(dir);
  return dir;
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

describe("setupProductionActivityRecorder", () => {
  it("performs no key or filesystem work while the default-off gate is disabled", async () => {
    const dataDir = makeDir();
    const result = await setupProductionActivityRecorder({
      config: AppConfigSchema.parse({}).observability.activityRecording,
      dataDir,
      activityRecordingMasterKey: undefined,
      clock: createFakeClock(100),
      timers: createFakeTimers(),
      logger: makeLogger(),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.activityRecorder).toBeUndefined();
    expect(existsSync(join(dataDir, "observability"))).toBe(false);
  });

  it("fails closed before opening a database when enabled without key authority", async () => {
    const dataDir = makeDir();
    const result = await setupProductionActivityRecorder({
      config: AppConfigSchema.parse({
        observability: { activityRecording: { enabled: true } },
      }).observability.activityRecording,
      dataDir,
      activityRecordingMasterKey: undefined,
      clock: createFakeClock(100),
      timers: createFakeTimers(),
      logger: makeLogger(),
    });

    expect(result.ok).toBe(false);
    expect(existsSync(join(dataDir, "observability"))).toBe(false);
  });

  it("opens the dedicated encrypted store and never claims exact eligibility", async () => {
    const dataDir = makeDir();
    const result = await setupProductionActivityRecorder({
      config: AppConfigSchema.parse({
        observability: { activityRecording: { enabled: true } },
      }).observability.activityRecording,
      dataDir,
      activityRecordingMasterKey: randomBytes(32),
      clock: createFakeClock(100),
      timers: createFakeTimers(),
      logger: makeLogger(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.activityRecorder === undefined) return;
    expect(existsSync(join(dataDir, "observability", "production-activity.db"))).toBe(true);
    const inspection = await result.value.activityRecorder.inspect();
    expect(inspection.ok && inspection.value.exactness.eligible).toBe(false);
    await result.value.activityRecorder.close();
  });
});
