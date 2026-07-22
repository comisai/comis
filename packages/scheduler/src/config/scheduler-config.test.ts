// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { SchedulerConfigSchema } from "./scheduler-config.js";

describe("SchedulerConfigSchema", () => {
  it("produces valid config from empty object", () => {
    const result = SchedulerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;

    const cfg = result.data;

    // Cron defaults
    expect(cfg.cron.enabled).toBe(true);
    expect(cfg.cron.maxRunsPerTick).toBe(3);
    expect(cfg.cron.defaultTimezone).toBe("UTC");
    expect(cfg.cron.staggerWindowMs).toBe(0);

    // Heartbeat defaults
    expect(cfg.heartbeat.enabled).toBe(true);
    expect(cfg.heartbeat.intervalMs).toBe(300_000);
    expect(cfg.heartbeat.showOk).toBe(false);
    expect(cfg.heartbeat.showAlerts).toBe(true);

    // Quiet hours defaults
    expect(cfg.quietHours.enabled).toBe(false);
    expect(cfg.quietHours.start).toBe("22:00");
    expect(cfg.quietHours.end).toBe("07:00");
    expect(cfg.quietHours.timezone).toBe("UTC");
    expect(cfg.quietHours.criticalBypass).toBe(true);

    // Execution defaults
    expect(cfg.execution.maxLogBytes).toBe(2_000_000);
    expect(cfg.execution.retainedExecutions).toBe(1_000);

    // Task extraction stays opt-in until the task runtime is configured end to end.
    expect(cfg.tasks.enabled).toBe(false);
    expect(cfg.tasks.confidenceThreshold).toBe(0.8);
    expect(cfg.tasks.debounceMs).toBe(15_000);
    expect(cfg.tasks.batchMax).toBe(8);

  });

  it("validates each section independently", () => {
    const result = SchedulerConfigSchema.safeParse({
      cron: { enabled: true, maxRunsPerTick: 5 },
      heartbeat: { enabled: true, intervalMs: 60_000 },
      quietHours: { start: "23:00", end: "06:00" },
      execution: { retainedExecutions: 300 },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.cron.enabled).toBe(true);
    expect(result.data.cron.maxRunsPerTick).toBe(5);
    expect(result.data.heartbeat.enabled).toBe(true);
    expect(result.data.heartbeat.intervalMs).toBe(60_000);
    expect(result.data.quietHours.start).toBe("23:00");
    expect(result.data.execution.retainedExecutions).toBe(300);
  });

  it("rejects unknown fields via .strict()", () => {
    const result = SchedulerConfigSchema.safeParse({
      unknownField: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in nested sections", () => {
    const result = SchedulerConfigSchema.safeParse({
      cron: { enabled: true, badField: 123 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid cron maxRunsPerTick (non-positive)", () => {
    const result = SchedulerConfigSchema.safeParse({
      cron: { maxRunsPerTick: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects cron stagger windows outside the safe nonnegative integer range", () => {
    for (const staggerWindowMs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(SchedulerConfigSchema.safeParse({ cron: { staggerWindowMs } }).success).toBe(false);
    }
  });

  it("rejects invalid heartbeat intervalMs (non-positive)", () => {
    const result = SchedulerConfigSchema.safeParse({
      heartbeat: { intervalMs: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer retainedExecutions", () => {
    const result = SchedulerConfigSchema.safeParse({
      execution: { retainedExecutions: 100.5 },
    });
    expect(result.success).toBe(false);
  });
});
