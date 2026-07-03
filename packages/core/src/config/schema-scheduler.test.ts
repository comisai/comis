// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { SchedulerConfigSchema, resolveCronWakeGateEnabled } from "./schema-scheduler.js";

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
      storeDir: "./data/scheduler",
      maxConcurrentRuns: 3,
      defaultTimezone: "",
      maxJobs: 100,
      maxConsecutiveErrors: 5,
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
