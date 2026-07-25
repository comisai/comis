// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { formatCompletionAnnouncement, TRAILING_INSTRUCTION } from "./completion-formatter.js";
import { TRAILING_INSTRUCTION as NARRATIVE_TRAILING } from "../spawn/narrative-caster.js";
import type { BackgroundTask } from "./background-task-types.js";

function buildTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    toolName: "exec",
    status: "completed",
    startedAt: Date.now(),
    completedAt: Date.now(),
    origin: {
      agentId: "default",
      sessionKey: "default:echo:test:user1",
      channelType: "echo",
      channelId: "test",
      traceId: null,
      backgroundHopCount: 0,
    },
    ...overrides,
  };
}

describe("formatCompletionAnnouncement", () => {
  it("renders [Background Task: exec] header for completed task", () => {
    const task = buildTask({ status: "completed", result: "ok" });
    const out = formatCompletionAnnouncement(task);
    expect(out.startsWith("[Background Task: exec]")).toBe(true);
  });

  it("renders [Background Task Failed: exec] header for failed task", () => {
    const task = buildTask({ status: "failed", error: "boom", result: undefined });
    const out = formatCompletionAnnouncement(task);
    expect(out.startsWith("[Background Task Failed: exec]")).toBe(true);
  });

  it("success body present", () => {
    const task = buildTask({ status: "completed", result: "RESULT_BODY" });
    const out = formatCompletionAnnouncement(task);
    expect(out).toContain("RESULT_BODY");
  });

  it("failure body present", () => {
    const task = buildTask({ status: "failed", error: "ERROR_BODY", result: undefined });
    const out = formatCompletionAnnouncement(task);
    expect(out).toContain("ERROR_BODY");
  });

  it("trailing instruction byte-identical to narrative-caster.ts", () => {
    // First: confirm the re-exported constant equals the source.
    expect(TRAILING_INSTRUCTION).toBe(NARRATIVE_TRAILING);
    // Second: assert formatter output ends with the constant.
    const task = buildTask({ status: "completed", result: "ok" });
    const out = formatCompletionAnnouncement(task);
    expect(out.endsWith(TRAILING_INSTRUCTION)).toBe(true);
  });

  it("requires completion turns to consume continuation metadata before summarizing", () => {
    const task = buildTask({ status: "completed", result: '{"next_page_number":2}' });
    const out = formatCompletionAnnouncement(task);
    expect(out).toContain("retrieve every remaining result page");
    expect(out).toContain("file tools before summarizing");
  });

  it("size cap truncates body, preserves header + trailing", () => {
    // Body large enough to force total > 32768.
    const massiveResult = "X".repeat(40_000);
    const task = buildTask({ status: "completed", result: massiveResult });
    const out = formatCompletionAnnouncement(task);
    expect(out.length).toBeLessThanOrEqual(32_768);
    expect(out.startsWith("[Background Task: exec]")).toBe(true);
    expect(out.endsWith(TRAILING_INSTRUCTION)).toBe(true);
    expect(out).toContain("…[truncated]");
  });

  it("restart-recovery announcement uses explicit copy", () => {
    const task = buildTask({
      status: "failed",
      error: "Daemon restarted while task was running",
      result: undefined,
    });
    const out = formatCompletionAnnouncement(task);
    expect(out.startsWith("[Background Task Failed: exec]")).toBe(true);
    expect(out).toContain("This background task was interrupted by a daemon restart");
  });
});
