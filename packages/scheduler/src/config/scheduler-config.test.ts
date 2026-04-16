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
    expect(cfg.cron.storeDir).toBe("./data/scheduler");
    expect(cfg.cron.maxConcurrentRuns).toBe(3);
    expect(cfg.cron.defaultTimezone).toBe("");

    // Heartbeat defaults
    expect(cfg.heartbeat.enabled).toBe(true);
    expect(cfg.heartbeat.intervalMs).toBe(300_000);
    expect(cfg.heartbeat.showOk).toBe(false);
    expect(cfg.heartbeat.showAlerts).toBe(true);

    // Quiet hours defaults
    expect(cfg.quietHours.enabled).toBe(false);
    expect(cfg.quietHours.start).toBe("22:00");
    expect(cfg.quietHours.end).toBe("07:00");
    expect(cfg.quietHours.timezone).toBe("");
    expect(cfg.quietHours.criticalBypass).toBe(true);

    // Execution defaults
    expect(cfg.execution.lockDir).toBe("./data/scheduler/locks");
    expect(cfg.execution.staleMs).toBe(600_000);
    expect(cfg.execution.updateMs).toBe(30_000);
    expect(cfg.execution.logDir).toBe("./data/scheduler/logs");
    expect(cfg.execution.maxLogBytes).toBe(2_000_000);
    expect(cfg.execution.keepLines).toBe(2_000);

    // Tasks defaults
    expect(cfg.tasks.enabled).toBe(false);
    expect(cfg.tasks.confidenceThreshold).toBe(0.8);
    expect(cfg.tasks.storeDir).toBe("./data/scheduler/tasks");

  });

  it("validates each section independently", () => {
    const result = SchedulerConfigSchema.safeParse({
      cron: { enabled: true, maxConcurrentRuns: 5 },
      heartbeat: { enabled: true, intervalMs: 60_000 },
      quietHours: { start: "23:00", end: "06:00" },
      execution: { staleMs: 300_000 },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.cron.enabled).toBe(true);
    expect(result.data.cron.maxConcurrentRuns).toBe(5);
    expect(result.data.heartbeat.enabled).toBe(true);
    expect(result.data.heartbeat.intervalMs).toBe(60_000);
    expect(result.data.quietHours.start).toBe("23:00");
    expect(result.data.execution.staleMs).toBe(300_000);
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

  it("rejects invalid cron maxConcurrentRuns (non-positive)", () => {
    const result = SchedulerConfigSchema.safeParse({
      cron: { maxConcurrentRuns: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid heartbeat intervalMs (non-positive)", () => {
    const result = SchedulerConfigSchema.safeParse({
      heartbeat: { intervalMs: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer staleMs", () => {
    const result = SchedulerConfigSchema.safeParse({
      execution: { staleMs: 100.5 },
    });
    expect(result.success).toBe(false);
  });
});
