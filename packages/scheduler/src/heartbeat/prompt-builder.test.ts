import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SystemEventEntry } from "../system-events/system-event-types.js";
import {
  resolveHeartbeatTriggerKind,
  buildHeartbeatPrompt,
  DEFAULT_HEARTBEAT_PROMPT,
  MEMORY_STATS_THRESHOLD,
} from "./prompt-builder.js";

describe("resolveHeartbeatTriggerKind", () => {
  it("returns 'interval' for empty array", () => {
    expect(resolveHeartbeatTriggerKind([])).toBe("interval");
  });

  it("returns 'exec-event' when any contextKey starts with 'exec:'", () => {
    const events: SystemEventEntry[] = [
      { text: "Command completed: git pull", contextKey: "exec:cmd-123", enqueuedAt: 1000 },
    ];
    expect(resolveHeartbeatTriggerKind(events)).toBe("exec-event");
  });

  it("returns 'cron' when any contextKey starts with 'cron:'", () => {
    const events: SystemEventEntry[] = [
      { text: "Check disk space", contextKey: "cron:job-abc", enqueuedAt: 1000 },
    ];
    expect(resolveHeartbeatTriggerKind(events)).toBe("cron");
  });

  it("returns 'exec-event' when mixed exec + cron events (exec priority)", () => {
    const events: SystemEventEntry[] = [
      { text: "Cron triggered", contextKey: "cron:job-abc", enqueuedAt: 1000 },
      { text: "Exec completed", contextKey: "exec:cmd-456", enqueuedAt: 1001 },
    ];
    expect(resolveHeartbeatTriggerKind(events)).toBe("exec-event");
  });

  it("returns 'interval' for events with unknown contextKey prefixes", () => {
    const events: SystemEventEntry[] = [
      { text: "Unknown event", contextKey: "unknown:foo", enqueuedAt: 1000 },
      { text: "Another event", contextKey: "bar:baz", enqueuedAt: 1001 },
    ];
    expect(resolveHeartbeatTriggerKind(events)).toBe("interval");
  });
});

describe("DEFAULT_HEARTBEAT_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof DEFAULT_HEARTBEAT_PROMPT).toBe("string");
    expect(DEFAULT_HEARTBEAT_PROMPT.length).toBeGreaterThan(0);
  });

  it("contains 'HEARTBEAT.md'", () => {
    expect(DEFAULT_HEARTBEAT_PROMPT).toContain("HEARTBEAT.md");
  });

  it("contains 'HEARTBEAT_OK'", () => {
    expect(DEFAULT_HEARTBEAT_PROMPT).toContain("HEARTBEAT_OK");
  });
});

describe("buildHeartbeatPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns DEFAULT_HEARTBEAT_PROMPT + time for interval trigger without custom prompt", () => {
    const result = buildHeartbeatPrompt("interval", [], {});
    expect(result).toBe(DEFAULT_HEARTBEAT_PROMPT + "\n\nCurrent time: 2026-03-04T12:00:00.000Z");
  });

  it("returns config.prompt + time for interval trigger with custom prompt", () => {
    const result = buildHeartbeatPrompt("interval", [], { prompt: "Do maintenance tasks." });
    expect(result).toBe("Do maintenance tasks.\n\nCurrent time: 2026-03-04T12:00:00.000Z");
  });

  it("returns exec completion prompt with event texts for exec-event trigger", () => {
    const events: SystemEventEntry[] = [
      { text: "git pull completed with exit code 0", contextKey: "exec:cmd-123", enqueuedAt: 1000 },
      { text: "npm test finished", contextKey: "exec:cmd-456", enqueuedAt: 1001 },
    ];
    const result = buildHeartbeatPrompt("exec-event", events, {});
    expect(result).toContain("git pull completed with exit code 0");
    expect(result).toContain("npm test finished");
    expect(result).toContain("completed");
    expect(result).toMatch(/\n\nCurrent time: 2026-03-04T12:00:00\.000Z$/);
  });

  it("returns cron reminder prompt with event texts for cron trigger", () => {
    const events: SystemEventEntry[] = [
      { text: "Check disk space", contextKey: "cron:job-abc", enqueuedAt: 1000 },
    ];
    const result = buildHeartbeatPrompt("cron", events, {});
    expect(result).toContain("Check disk space");
    expect(result).toContain("reminder");
    expect(result).toMatch(/\n\nCurrent time: 2026-03-04T12:00:00\.000Z$/);
  });

  it("appends ISO timestamp to all prompt types", () => {
    const timeSuffix = "\n\nCurrent time: 2026-03-04T12:00:00.000Z";

    // Interval
    const intervalResult = buildHeartbeatPrompt("interval", [], {});
    expect(intervalResult.endsWith(timeSuffix)).toBe(true);

    // Exec-event
    const execResult = buildHeartbeatPrompt("exec-event", [
      { text: "done", contextKey: "exec:1", enqueuedAt: 1000 },
    ], {});
    expect(execResult.endsWith(timeSuffix)).toBe(true);

    // Cron
    const cronResult = buildHeartbeatPrompt("cron", [
      { text: "reminder", contextKey: "cron:1", enqueuedAt: 1000 },
    ], {});
    expect(cronResult.endsWith(timeSuffix)).toBe(true);
  });
});

describe("buildHeartbeatPrompt with memoryStats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not include memory stats when not provided", () => {
    const result = buildHeartbeatPrompt("interval", [], {});
    expect(result).not.toContain("Memory store status");
  });

  it("does not include memory stats when totalEntries is at or below threshold", () => {
    const atThreshold = buildHeartbeatPrompt("interval", [], {}, {
      totalEntries: MEMORY_STATS_THRESHOLD,
      oldestEntryAgeDays: 30,
    });
    expect(atThreshold).not.toContain("Memory store status");

    const belowThreshold = buildHeartbeatPrompt("interval", [], {}, {
      totalEntries: 50,
      oldestEntryAgeDays: 30,
    });
    expect(belowThreshold).not.toContain("Memory store status");
  });

  it("includes memory stats when totalEntries exceeds threshold", () => {
    const result = buildHeartbeatPrompt("interval", [], {}, {
      totalEntries: 150,
      oldestEntryAgeDays: 45,
    });
    expect(result).toContain("Memory store status: 150 entries, oldest is 45 days old");
    expect(result).toContain("Consider reviewing old memories");
  });

  it("includes memory stats for all trigger types", () => {
    const stats = { totalEntries: 200, oldestEntryAgeDays: 60 };

    // interval
    const interval = buildHeartbeatPrompt("interval", [], {}, stats);
    expect(interval).toContain("Memory store status: 200 entries");

    // exec-event
    const exec = buildHeartbeatPrompt("exec-event", [
      { text: "done", contextKey: "exec:1", enqueuedAt: 1000 },
    ], {}, stats);
    expect(exec).toContain("Memory store status: 200 entries");

    // cron
    const cron = buildHeartbeatPrompt("cron", [
      { text: "reminder", contextKey: "cron:1", enqueuedAt: 1000 },
    ], {}, stats);
    expect(cron).toContain("Memory store status: 200 entries");
  });
});
