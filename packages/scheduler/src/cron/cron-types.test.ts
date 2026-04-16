import { describe, it, expect } from "vitest";
import {
  CronScheduleSchema,
  CronPayloadSchema,
  CronJobSchema,
  CronSessionTargetSchema,
  CronSessionStrategySchema,
} from "./cron-types.js";

describe("CronScheduleSchema", () => {
  it("parses cron kind with expr", () => {
    const result = CronScheduleSchema.safeParse({
      kind: "cron",
      expr: "0 */6 * * *",
      tz: "America/New_York",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("cron");
    }
  });

  it("parses every kind with everyMs", () => {
    const result = CronScheduleSchema.safeParse({
      kind: "every",
      everyMs: 60_000,
      anchorMs: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("every");
    }
  });

  it("parses at kind with ISO string", () => {
    const result = CronScheduleSchema.safeParse({
      kind: "at",
      at: "2026-03-01T12:00:00Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("at");
    }
  });

  it("rejects cron kind with empty expr", () => {
    const result = CronScheduleSchema.safeParse({ kind: "cron", expr: "" });
    expect(result.success).toBe(false);
  });

  it("rejects every kind with non-positive everyMs", () => {
    const result = CronScheduleSchema.safeParse({ kind: "every", everyMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown kind", () => {
    const result = CronScheduleSchema.safeParse({ kind: "weekly", expr: "foo" });
    expect(result.success).toBe(false);
  });

  it("rejects cron kind with unknown fields (strict)", () => {
    const result = CronScheduleSchema.safeParse({
      kind: "cron",
      expr: "* * * * *",
      badField: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("CronPayloadSchema", () => {
  it("parses systemEvent kind", () => {
    const result = CronPayloadSchema.safeParse({
      kind: "system_event",
      text: "check disk space",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("system_event");
    }
  });

  it("parses agentTurn kind with optional fields", () => {
    const result = CronPayloadSchema.safeParse({
      kind: "agent_turn",
      message: "summarize recent events",
      model: "gpt-4",
      timeoutSeconds: 120,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("agent_turn");
    }
  });

  it("rejects systemEvent with empty text", () => {
    const result = CronPayloadSchema.safeParse({ kind: "system_event", text: "" });
    expect(result.success).toBe(false);
  });

  it("rejects agentTurn with empty message", () => {
    const result = CronPayloadSchema.safeParse({ kind: "agent_turn", message: "" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown kind", () => {
    const result = CronPayloadSchema.safeParse({ kind: "webhook", url: "http://example.com" });
    expect(result.success).toBe(false);
  });
});

describe("CronSessionTargetSchema", () => {
  it("accepts main", () => {
    expect(CronSessionTargetSchema.safeParse("main").success).toBe(true);
  });

  it("accepts isolated", () => {
    expect(CronSessionTargetSchema.safeParse("isolated").success).toBe(true);
  });

  it("rejects unknown value", () => {
    expect(CronSessionTargetSchema.safeParse("background").success).toBe(false);
  });
});

describe("CronJobSchema", () => {
  const validJob = {
    id: "job-1",
    name: "Disk check",
    agentId: "agent-main",
    schedule: { kind: "cron" as const, expr: "0 */6 * * *" },
    payload: { kind: "system_event" as const, text: "check disk" },
    createdAtMs: Date.now(),
  };

  it("parses valid job with defaults", () => {
    const result = CronJobSchema.safeParse(validJob);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.sessionTarget).toBe("isolated");
    expect(result.data.enabled).toBe(true);
    expect(result.data.consecutiveErrors).toBe(0);
    expect(result.data.nextRunAtMs).toBeUndefined();
    expect(result.data.lastRunAtMs).toBeUndefined();
  });

  it("parses job with all fields", () => {
    const result = CronJobSchema.safeParse({
      ...validJob,
      sessionTarget: "main",
      enabled: false,
      nextRunAtMs: Date.now() + 3600_000,
      lastRunAtMs: Date.now() - 3600_000,
      consecutiveErrors: 3,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sessionTarget).toBe("main");
    expect(result.data.enabled).toBe(false);
    expect(result.data.consecutiveErrors).toBe(3);
  });

  it("rejects job with empty id", () => {
    const result = CronJobSchema.safeParse({ ...validJob, id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects job with name exceeding 200 chars", () => {
    const result = CronJobSchema.safeParse({ ...validJob, name: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects job with unknown fields (strict)", () => {
    const result = CronJobSchema.safeParse({ ...validJob, priority: "high" });
    expect(result.success).toBe(false);
  });

  it("rejects job with non-positive createdAtMs", () => {
    const result = CronJobSchema.safeParse({ ...validJob, createdAtMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects job with negative consecutiveErrors", () => {
    const result = CronJobSchema.safeParse({ ...validJob, consecutiveErrors: -1 });
    expect(result.success).toBe(false);
  });

  it("defaults sessionStrategy to 'fresh' when omitted", () => {
    const result = CronJobSchema.safeParse(validJob);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sessionStrategy).toBe("fresh");
  });

  it("accepts sessionStrategy values: fresh, rolling, accumulate", () => {
    for (const strategy of ["fresh", "rolling", "accumulate"] as const) {
      const result = CronJobSchema.safeParse({ ...validJob, sessionStrategy: strategy });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sessionStrategy).toBe(strategy);
      }
    }
  });

  it("defaults maxHistoryTurns to 3 when omitted", () => {
    const result = CronJobSchema.safeParse(validJob);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.maxHistoryTurns).toBe(3);
  });

  it("rejects invalid sessionStrategy value", () => {
    const result = CronJobSchema.safeParse({ ...validJob, sessionStrategy: "invalid" });
    expect(result.success).toBe(false);
  });
});

describe("CronSessionStrategySchema", () => {
  it("accepts fresh", () => {
    expect(CronSessionStrategySchema.safeParse("fresh").success).toBe(true);
  });

  it("accepts rolling", () => {
    expect(CronSessionStrategySchema.safeParse("rolling").success).toBe(true);
  });

  it("accepts accumulate", () => {
    expect(CronSessionStrategySchema.safeParse("accumulate").success).toBe(true);
  });

  it("rejects unknown value", () => {
    expect(CronSessionStrategySchema.safeParse("infinite").success).toBe(false);
  });
});
