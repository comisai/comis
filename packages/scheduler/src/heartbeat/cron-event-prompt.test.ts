import { describe, it, expect } from "vitest";
import { buildCronEventPrompt, buildExecEventPrompt } from "./cron-event-prompt.js";
import type { SystemEventEntry } from "../system-events/system-event-types.js";

function makeEvent(text: string, contextKey: string): SystemEventEntry {
  return { text, contextKey, enqueuedAt: Date.now() };
}

describe("buildCronEventPrompt", () => {
  it("returns prompt with cron event texts joined by double newline", () => {
    const events = [
      makeEvent("Check disk space", "cron:job-1"),
      makeEvent("Run backups", "cron:job-2"),
    ];
    const result = buildCronEventPrompt(events, { prompt: undefined });
    expect(result).toContain("Check disk space");
    expect(result).toContain("Run backups");
    expect(result).toContain("scheduled reminder");
  });

  it("appends ISO timestamp", () => {
    const events = [makeEvent("Test event", "cron:job-1")];
    const result = buildCronEventPrompt(events, { prompt: undefined });
    expect(result).toMatch(/Current time: \d{4}-\d{2}-\d{2}T/);
  });

  it("filters only cron-prefixed events", () => {
    const events = [
      makeEvent("Cron event", "cron:job-1"),
      makeEvent("Exec event", "exec:cmd-1"),
    ];
    const result = buildCronEventPrompt(events, { prompt: undefined });
    expect(result).toContain("Cron event");
    expect(result).not.toContain("Exec event");
  });
});

describe("buildExecEventPrompt", () => {
  it("returns prompt with exec event texts", () => {
    const events = [makeEvent("Command completed: git pull", "exec:cmd-1")];
    const result = buildExecEventPrompt(events, { prompt: undefined });
    expect(result).toContain("Command completed: git pull");
    expect(result).toContain("async command");
  });

  it("appends ISO timestamp", () => {
    const events = [makeEvent("Done", "exec:cmd-1")];
    const result = buildExecEventPrompt(events, { prompt: undefined });
    expect(result).toMatch(/Current time: \d{4}-\d{2}-\d{2}T/);
  });

  it("filters only exec-prefixed events", () => {
    const events = [
      makeEvent("Exec event", "exec:cmd-1"),
      makeEvent("Cron event", "cron:job-1"),
    ];
    const result = buildExecEventPrompt(events, { prompt: undefined });
    expect(result).toContain("Exec event");
    expect(result).not.toContain("Cron event");
  });
});
