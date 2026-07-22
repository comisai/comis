// SPDX-License-Identifier: Apache-2.0
import type { SystemEventEntry } from "../system-events/system-event-types.js";
import { describe, expect, it } from "vitest";
import {
  buildHeartbeatPrompt,
  DEFAULT_HEARTBEAT_PROMPT,
  MEMORY_STATS_THRESHOLD,
} from "./prompt-builder.js";

const NOW_MS = Date.parse("2026-03-04T12:00:00.000Z");

function event(
  trigger: SystemEventEntry["trigger"],
  text: string,
  contextKey: string,
  enqueuedAt: number,
): SystemEventEntry {
  return { trigger, text, contextKey, enqueuedAt };
}

describe("heartbeat prompt builder", () => {
  it("uses the configured periodic prompt and caller-owned timestamp for an empty interval", () => {
    expect(buildHeartbeatPrompt("interval", [], { prompt: "Do maintenance tasks." }, undefined, NOW_MS))
      .toBe("Do maintenance tasks.\n\nCurrent time: 2026-03-04T12:00:00.000Z");
    expect(buildHeartbeatPrompt("interval", [], {}, undefined, NOW_MS))
      .toContain(DEFAULT_HEARTBEAT_PROMPT);
  });

  it("groups mixed events by explicit trigger order and wraps every text separately", () => {
    const events = [
      event("cron", "cron-first", "exec:misleading", 1),
      event("exec-event", "exec-second", "cron:misleading", 2),
      event("cron", "cron-third", "unknown", 3),
    ];

    const prompt = buildHeartbeatPrompt("exec-event", events, {}, undefined, NOW_MS);

    expect(prompt.indexOf("Scheduled events")).toBeLessThan(prompt.indexOf("Completed execution events"));
    expect(prompt.indexOf("cron-first")).toBeLessThan(prompt.indexOf("cron-third"));
    expect(prompt).toContain("exec-second");
    expect(prompt.match(/<<<UNTRUSTED_[a-f0-9]{24}>>>/gu)).toHaveLength(3);
    expect(prompt.match(/<<<END_UNTRUSTED_[a-f0-9]{24}>>>/gu)).toHaveLength(3);
  });

  it("does not discard lower-priority event groups based on the winning wake reason", () => {
    const prompt = buildHeartbeatPrompt("cron", [
      event("hook", "hook-content", "same", 1),
      event("wake", "wake-content", "same", 2),
      event("exec-event", "exec-content", "same", 3),
      event("cron", "cron-content", "same", 4),
    ], {}, undefined, NOW_MS);

    expect(prompt).toContain("hook-content");
    expect(prompt).toContain("wake-content");
    expect(prompt).toContain("exec-content");
    expect(prompt).toContain("cron-content");
  });

  it("injects bounded memory status only above the established threshold", () => {
    const atThreshold = buildHeartbeatPrompt("interval", [], {}, {
      totalEntries: MEMORY_STATS_THRESHOLD,
      oldestEntryAgeDays: 30,
    }, NOW_MS);
    const aboveThreshold = buildHeartbeatPrompt("interval", [], {}, {
      totalEntries: MEMORY_STATS_THRESHOLD + 1,
      oldestEntryAgeDays: 31,
    }, NOW_MS);

    expect(atThreshold).not.toContain("Memory store status");
    expect(aboveThreshold).toContain(`Memory store status: ${MEMORY_STATS_THRESHOLD + 1} entries`);
  });
});
