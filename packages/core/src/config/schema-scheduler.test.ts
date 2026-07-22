// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { SchedulerConfigSchema, resolveCronWakeGateEnabled } from "./schema-scheduler.js";
import { PerAgentCronConfigSchema } from "./schema-agent/schema-agent-runtime.js";

describe("CronConfigSchema — wakeGate operator toggle", () => {
  it("omits wakeGate entirely when the key is absent (optional, never defaulted) so parse stays byte-identical", () => {
    const cron = SchedulerConfigSchema.parse({}).cron;
    // An absent toggle materializes NO key: undefined is a meaningful third
    // state (follow the agent's script surface), so it must never be coerced
    // to a boolean default.
    expect("wakeGate" in cron).toBe(false);
    expect(cron.wakeGate).toBeUndefined();
    // Byte-identity: an omitted toggle leaves the whole parsed cron block
    // exactly as it was before the field existed.
    expect(cron).toEqual({
      enabled: true,
      maxRunsPerTick: 3,
      defaultTimezone: "UTC",
      maxJobs: 100,
      maxConsecutiveDependencyErrors: 5,
      staggerWindowMs: 0,
    });
  });

  it("parses an explicit true toggle", () => {
    expect(SchedulerConfigSchema.parse({ cron: { wakeGate: true } }).cron.wakeGate).toBe(true);
  });

  it("parses an explicit false toggle", () => {
    expect(SchedulerConfigSchema.parse({ cron: { wakeGate: false } }).cron.wakeGate).toBe(false);
  });

  it("rejects a non-boolean toggle (boolean-only; the strict typo guard still holds)", () => {
    expect(() => SchedulerConfigSchema.parse({ cron: { wakeGate: "yes" } })).toThrow();
  });

  it("uses a safe nonnegative deterministic cron stagger window", () => {
    expect(SchedulerConfigSchema.parse({ cron: { staggerWindowMs: 30_000 } }).cron.staggerWindowMs).toBe(30_000);
    expect(() => SchedulerConfigSchema.parse({ cron: { staggerWindowMs: -1 } })).toThrow();
    expect(() => SchedulerConfigSchema.parse({ cron: { staggerWindowMs: Number.MAX_SAFE_INTEGER + 1 } })).toThrow();
    expect(PerAgentCronConfigSchema.parse({ staggerWindowMs: 45_000 }).staggerWindowMs).toBe(45_000);
  });
});

describe("scheduler task inference opt-in", () => {
  it("keeps task extraction disabled until an operator explicitly enables it", () => {
    expect(SchedulerConfigSchema.parse({}).tasks.enabled).toBe(false);
    expect(SchedulerConfigSchema.parse({ tasks: { enabled: true } }).tasks.enabled).toBe(true);
  });

  it("materializes the complete bounded task runtime configuration without a path override", () => {
    expect(SchedulerConfigSchema.parse({}).tasks).toEqual({
      enabled: false,
      confidenceThreshold: 0.8,
      debounceMs: 15_000,
      batchMax: 8,
      maxPerCheck: 3,
      maxPerDayPerConversation: 3,
      defaultWindowMs: 43_200_000,
      preAcceptanceRetryLimit: 3,
    });
    expect(SchedulerConfigSchema.safeParse({ tasks: { storeDir: "./elsewhere" } }).success).toBe(false);
  });
});

describe("truthful scheduler configuration", () => {
  it("rejects removed scheduler leaves instead of silently accepting unused behavior", () => {
    for (const value of [
      { cron: { storeDir: "./data" } },
      { cron: { maxConcurrentRuns: 3 } },
      { cron: { maxConsecutiveErrors: 5 } },
      { execution: { lockDir: "./locks" } },
      { execution: { staleMs: 1_000 } },
      { execution: { updateMs: 1_000 } },
      { execution: { logDir: "./logs" } },
      { execution: { keepLines: 2_000 } },
    ]) {
      expect(SchedulerConfigSchema.safeParse(value).success).toBe(false);
    }
  });

  it("uses bounded counters whose names match their production behavior", () => {
    const parsed = SchedulerConfigSchema.parse({});
    expect(parsed.cron.maxRunsPerTick).toBe(3);
    expect(parsed.cron.maxJobs).toBe(100);
    expect(parsed.cron.maxConsecutiveDependencyErrors).toBe(5);
    expect(parsed.execution).toEqual({ maxLogBytes: 2_000_000, retainedExecutions: 1_000 });
    expect(SchedulerConfigSchema.safeParse({ cron: { maxJobs: 0 } }).success).toBe(false);
    expect(SchedulerConfigSchema.safeParse({ cron: { maxJobs: 10_001 } }).success).toBe(false);
    expect(SchedulerConfigSchema.safeParse({ execution: { retainedExecutions: 0 } }).success).toBe(false);
  });

  it("normalizes omitted quiet-hours timezone to UTC and rejects malformed time policy", () => {
    expect(SchedulerConfigSchema.parse({}).quietHours.timezone).toBe("UTC");
    expect(SchedulerConfigSchema.parse({ quietHours: { timezone: "" } }).quietHours.timezone).toBe("UTC");
    expect(SchedulerConfigSchema.safeParse({ quietHours: { start: "24:00" } }).success).toBe(false);
    expect(SchedulerConfigSchema.safeParse({ quietHours: { end: "7:00" } }).success).toBe(false);
    expect(SchedulerConfigSchema.safeParse({ quietHours: { timezone: "Mars/Olympus" } }).success).toBe(false);
    expect(SchedulerConfigSchema.safeParse({ cron: { defaultTimezone: "Mars/Olympus" } }).success).toBe(false);
  });

  it("keeps global and per-agent cron names aligned", () => {
    const perAgent = PerAgentCronConfigSchema.parse({});
    expect(perAgent).toMatchObject({
      maxRunsPerTick: 3,
      defaultTimezone: "UTC",
      maxJobs: 100,
      maxConsecutiveDependencyErrors: 5,
    });
    expect(PerAgentCronConfigSchema.safeParse({ maxConcurrentRuns: 3 }).success).toBe(false);
    expect(PerAgentCronConfigSchema.safeParse({ maxConsecutiveErrors: 5 }).success).toBe(false);
  });
});

describe("resolveCronWakeGateEnabled — tri-state resolution", () => {
  it("resolves an explicit true toggle to on, regardless of the script surface", () => {
    expect(resolveCronWakeGateEnabled(true, true)).toBe(true);
    expect(resolveCronWakeGateEnabled(true, false)).toBe(true);
    expect(resolveCronWakeGateEnabled(true, undefined)).toBe(true);
  });

  it("resolves an explicit false toggle to off, even when the script surface is on", () => {
    expect(resolveCronWakeGateEnabled(false, true)).toBe(false);
    expect(resolveCronWakeGateEnabled(false, false)).toBe(false);
    expect(resolveCronWakeGateEnabled(false, undefined)).toBe(false);
  });

  it("follows the agent's script surface when the toggle is undefined", () => {
    expect(resolveCronWakeGateEnabled(undefined, true)).toBe(true);
    expect(resolveCronWakeGateEnabled(undefined, false)).toBe(false);
    expect(resolveCronWakeGateEnabled(undefined, undefined)).toBe(false);
  });
});

describe("PerAgentCronConfigSchema — wakeGate override", () => {
  // The daemon resolves effectiveCron = agentConfig.scheduler.cron ?? global
  // cron, and `??` swaps in the WHOLE per-agent cron object — so the per-agent
  // override must carry the same optional toggle, or setting a per-agent cron
  // would silently drop the operator's wakeGate choice.
  it("omits wakeGate when absent so a per-agent cron override stays additive", () => {
    const cron = PerAgentCronConfigSchema.parse({});
    expect("wakeGate" in cron).toBe(false);
    expect(cron.wakeGate).toBeUndefined();
  });

  it("parses an explicit per-agent true/false toggle", () => {
    expect(PerAgentCronConfigSchema.parse({ wakeGate: true }).wakeGate).toBe(true);
    expect(PerAgentCronConfigSchema.parse({ wakeGate: false }).wakeGate).toBe(false);
  });

  it("rejects a non-boolean per-agent toggle", () => {
    expect(() => PerAgentCronConfigSchema.parse({ wakeGate: "yes" })).toThrow();
  });
});
