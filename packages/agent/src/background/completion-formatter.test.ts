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

describe("formatCompletionAnnouncement (Phase 14 SPEC R1)", () => {
  it("Test 1: success header tag (AC-1)", () => {
    const task = buildTask({ status: "completed", result: "ok" });
    const out = formatCompletionAnnouncement(task);
    expect(out.startsWith("[Background Task: exec]")).toBe(true);
  });

  it("Test 2: failure header tag (AC-1)", () => {
    const task = buildTask({ status: "failed", error: "boom", result: undefined });
    const out = formatCompletionAnnouncement(task);
    expect(out.startsWith("[Background Task Failed: exec]")).toBe(true);
  });

  it("Test 3: success body present", () => {
    const task = buildTask({ status: "completed", result: "RESULT_BODY" });
    const out = formatCompletionAnnouncement(task);
    expect(out).toContain("RESULT_BODY");
  });

  it("Test 4: failure body present", () => {
    const task = buildTask({ status: "failed", error: "ERROR_BODY", result: undefined });
    const out = formatCompletionAnnouncement(task);
    expect(out).toContain("ERROR_BODY");
  });

  it("Test 5: trailing instruction byte-identical to narrative-caster.ts (AC-2)", () => {
    // First: confirm the re-exported constant equals the source.
    expect(TRAILING_INSTRUCTION).toBe(NARRATIVE_TRAILING);
    // Second: assert formatter output ends with the constant.
    const task = buildTask({ status: "completed", result: "ok" });
    const out = formatCompletionAnnouncement(task);
    expect(out.endsWith(TRAILING_INSTRUCTION)).toBe(true);
  });

  it("Test 6: D-05 size cap truncates body, preserves header + trailing", () => {
    // Body large enough to force total > 32768.
    const massiveResult = "X".repeat(40_000);
    const task = buildTask({ status: "completed", result: massiveResult });
    const out = formatCompletionAnnouncement(task);
    expect(out.length).toBeLessThanOrEqual(32_768);
    expect(out.startsWith("[Background Task: exec]")).toBe(true);
    expect(out.endsWith(TRAILING_INSTRUCTION)).toBe(true);
    expect(out).toContain("…[truncated]");
  });

  it("Test 7: D-09 restart-recovery announcement uses explicit copy", () => {
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
