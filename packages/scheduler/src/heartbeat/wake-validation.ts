// SPDX-License-Identifier: Apache-2.0
/** Strict parsing and trusted timing refinements for heartbeat admission. */
import { z } from "zod";

const MAX_EVENT_TEXT_BYTES = 64 * 1024;

const TargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agent"), agentId: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal("monitoring") }),
]);
const TimingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("routine"), notBeforeMs: z.number().int().nonnegative().safe() }),
  z.strictObject({ kind: z.literal("spacing_bypass"), notBeforeMs: z.number().int().nonnegative().safe() }),
]);

export const WakeRequestSchema = z.strictObject({
  target: TargetSchema,
  reason: z.enum(["interval", "manual", "hook", "wake", "exec-event", "cron", "task"]),
  timing: TimingSchema,
}).superRefine((value, ctx) => {
  if (value.target.kind === "monitoring" && value.reason === "task") {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "monitoring cannot use the task lane" });
  }
  if (value.reason === "task" && value.timing.kind !== "spacing_bypass") {
    ctx.addIssue({ code: "custom", path: ["timing"], message: "task wake requires trusted spacing bypass" });
  }
  if (["interval", "hook", "wake", "exec-event"].includes(value.reason) && value.timing.kind !== "routine") {
    ctx.addIssue({ code: "custom", path: ["timing"], message: "wake reason requires routine spacing" });
  }
});

export const SystemEventWakeSchema = z.strictObject({
  target: z.strictObject({ kind: z.literal("agent"), agentId: z.string().min(1).max(256) }),
  reason: z.enum(["hook", "wake", "exec-event", "cron"]),
  wakeMode: z.enum(["now", "next-heartbeat"]),
  notBeforeMs: z.number().int().nonnegative().safe(),
  event: z.strictObject({
    trigger: z.enum(["hook", "wake", "exec-event", "cron"]),
    contextKey: z.string().min(1).max(512),
    text: z.string().min(1),
  }),
}).superRefine((value, ctx) => {
  if (value.event.trigger !== value.reason) {
    ctx.addIssue({ code: "custom", path: ["event", "trigger"], message: "event trigger must equal wake reason" });
  }
  if (Buffer.byteLength(value.event.text, "utf8") > MAX_EVENT_TEXT_BYTES) {
    ctx.addIssue({ code: "custom", path: ["event", "text"], message: "event text exceeds UTF-8 byte bound" });
  }
});
