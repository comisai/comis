import { describe, it, expect } from "vitest";
import { BackgroundTasksConfigSchema } from "./schema-background-tasks.js";
import { PerAgentConfigSchema } from "./schema-agent.js";

describe("BackgroundTasksConfigSchema", () => {
  it("parses empty object with defaults", () => {
    const result = BackgroundTasksConfigSchema.parse({});
    expect(result).toEqual({
      enabled: true,
      autoBackgroundMs: 10_000,
      maxPerAgent: 5,
      maxTotal: 20,
      maxBackgroundDurationMs: 300_000,
      excludeTools: [],
    });
  });

  it("rejects negative autoBackgroundMs", () => {
    expect(() =>
      BackgroundTasksConfigSchema.parse({ autoBackgroundMs: -1 }),
    ).toThrow();
  });

  it("rejects zero maxPerAgent", () => {
    expect(() =>
      BackgroundTasksConfigSchema.parse({ maxPerAgent: 0 }),
    ).toThrow();
  });

  it("accepts custom overrides", () => {
    const result = BackgroundTasksConfigSchema.parse({
      enabled: false,
      autoBackgroundMs: 5_000,
      maxPerAgent: 10,
      maxTotal: 50,
      maxBackgroundDurationMs: 600_000,
      excludeTools: ["exec_command"],
    });
    expect(result.enabled).toBe(false);
    expect(result.autoBackgroundMs).toBe(5_000);
    expect(result.maxPerAgent).toBe(10);
    expect(result.maxTotal).toBe(50);
    expect(result.maxBackgroundDurationMs).toBe(600_000);
    expect(result.excludeTools).toEqual(["exec_command"]);
  });
});

describe("PerAgentConfigSchema backgroundTasks integration", () => {
  it("backgroundTasks is undefined by default", () => {
    const result = PerAgentConfigSchema.parse({});
    expect(result.backgroundTasks).toBeUndefined();
  });

  it("backgroundTasks parses with defaults when empty object provided", () => {
    const result = PerAgentConfigSchema.parse({ backgroundTasks: {} });
    expect(result.backgroundTasks).toEqual({
      enabled: true,
      autoBackgroundMs: 10_000,
      maxPerAgent: 5,
      maxTotal: 20,
      maxBackgroundDurationMs: 300_000,
      excludeTools: [],
    });
  });
});
