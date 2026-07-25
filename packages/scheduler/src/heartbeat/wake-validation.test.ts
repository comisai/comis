// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SystemEventWakeSchema, WakeRequestSchema } from "./wake-validation.js";

describe("heartbeat wake validation", () => {
  it("accepts trusted task bypass and routine monitoring requests", () => {
    expect(WakeRequestSchema.safeParse({
      target: { kind: "agent", agentId: "agent-a" },
      reason: "task",
      timing: { kind: "spacing_bypass", notBeforeMs: 1_000 },
    }).success).toBe(true);
    expect(WakeRequestSchema.safeParse({
      target: { kind: "monitoring" },
      reason: "interval",
      timing: { kind: "routine", notBeforeMs: 1_000 },
    }).success).toBe(true);
  });

  it("rejects task wakes for monitoring and without trusted bypass", () => {
    expect(WakeRequestSchema.safeParse({
      target: { kind: "monitoring" },
      reason: "task",
      timing: { kind: "routine", notBeforeMs: 1_000 },
    }).success).toBe(false);
    expect(WakeRequestSchema.safeParse({
      target: { kind: "agent", agentId: "agent-a" },
      reason: "task",
      timing: { kind: "routine", notBeforeMs: 1_000 },
    }).success).toBe(false);
  });

  it("rejects spacing bypass for routine wake reasons", () => {
    for (const reason of ["interval", "hook", "wake", "exec-event"] as const) {
      expect(WakeRequestSchema.safeParse({
        target: { kind: "agent", agentId: "agent-a" },
        reason,
        timing: { kind: "spacing_bypass", notBeforeMs: 1_000 },
      }).success).toBe(false);
    }
  });

  it("rejects unknown wake fields and unsafe timing values", () => {
    expect(WakeRequestSchema.safeParse({
      target: { kind: "agent", agentId: "agent-a", extra: true },
      reason: "manual",
      timing: { kind: "routine", notBeforeMs: 1_000 },
    }).success).toBe(false);
    expect(WakeRequestSchema.safeParse({
      target: { kind: "agent", agentId: "agent-a" },
      reason: "manual",
      timing: { kind: "routine", notBeforeMs: -1 },
    }).success).toBe(false);
  });

  it("accepts matching bounded system event wake payloads", () => {
    expect(SystemEventWakeSchema.safeParse({
      target: { kind: "agent", agentId: "agent-a" },
      reason: "cron",
      wakeMode: "next-heartbeat",
      notBeforeMs: 1_000,
      event: { trigger: "cron", contextKey: "cron:job-a", text: "inspect status" },
    }).success).toBe(true);
  });

  it("rejects mismatched triggers and oversized UTF8 event text", () => {
    const base = {
      target: { kind: "agent" as const, agentId: "agent-a" },
      reason: "wake" as const,
      wakeMode: "now" as const,
      notBeforeMs: 1_000,
      event: { trigger: "hook" as const, contextKey: "wake:event-a", text: "inspect status" },
    };
    expect(SystemEventWakeSchema.safeParse(base).success).toBe(false);
    expect(SystemEventWakeSchema.safeParse({
      ...base,
      event: { ...base.event, trigger: "wake", text: "é".repeat(32_769) },
    }).success).toBe(false);
  });
});
