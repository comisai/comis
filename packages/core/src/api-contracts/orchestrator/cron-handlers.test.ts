// SPDX-License-Identifier: Apache-2.0
/**
 * Contract test for the cron-handlers slice — the optional wake-gate authoring
 * fields on `cron.add` / `cron.update`, plus the additive-no-op guard.
 *
 * The request schemas are plain `z.object` (unknown keys stripped), so a
 * preservation assertion is the right signal: an un-declared field survives
 * `.parse()` only once the schema actually declares it. The additive-no-op case
 * pins the forward-only invariant — a request WITHOUT any wake-gate field parses
 * exactly as before.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { CronAddContract, CronUpdateContract } from "./cron-handlers.js";

describe("cron.add / cron.update wake-gate request fields", () => {
  // --- cron.add: flat chat-tool shape --------------------------------------

  it("cron.add: request preserves the flat wake_gate_script", () => {
    const parsed = CronAddContract.request.parse({
      name: "watcher",
      wake_gate_script: "fetch('https://x')",
    });
    expect(parsed.wake_gate_script).toBe("fetch('https://x')");
  });

  it("cron.add: request preserves the flat wake_gate_language", () => {
    const parsed = CronAddContract.request.parse({
      name: "watcher",
      wake_gate_language: "ts",
    });
    expect(parsed.wake_gate_language).toBe("ts");
  });

  // --- cron.add: nested web shape ------------------------------------------

  it("cron.add: request preserves the nested wakeGate object", () => {
    const parsed = CronAddContract.request.parse({
      name: "watcher",
      wakeGate: { script: "fetch('https://x')", language: "js" },
    });
    expect(parsed.wakeGate).toEqual({ script: "fetch('https://x')", language: "js" });
  });

  // --- cron.update: flat + nested ------------------------------------------

  it("cron.update: request preserves the flat wake_gate_script", () => {
    const parsed = CronUpdateContract.request.parse({
      jobId: "job-1",
      wake_gate_script: "grep('changed')",
    });
    expect(parsed.wake_gate_script).toBe("grep('changed')");
  });

  it("cron.update: request preserves the nested wakeGate object", () => {
    const parsed = CronUpdateContract.request.parse({
      jobId: "job-1",
      wakeGate: { script: "grep('changed')" },
    });
    expect(parsed.wakeGate).toEqual({ script: "grep('changed')" });
  });

  // --- additive no-op (forward-only) ---------------------------------------

  it("cron.add: a request without any wake-gate field parses unchanged", () => {
    const parsed = CronAddContract.request.parse({
      name: "plain",
      schedule_kind: "cron",
      schedule_expr: "* * * * *",
    });
    expect(parsed).toEqual({
      name: "plain",
      schedule_kind: "cron",
      schedule_expr: "* * * * *",
    });
    expect(parsed).not.toHaveProperty("wake_gate_script");
    expect(parsed).not.toHaveProperty("wake_gate_language");
    expect(parsed).not.toHaveProperty("wakeGate");
  });
});
