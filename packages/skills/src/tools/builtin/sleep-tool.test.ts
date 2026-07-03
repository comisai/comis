// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first contract for the `sleep` primitive.
 *
 * The sleep builtin lets the model pace itself between turns with a SINGLE
 * deferral keyed to the ~5-min prompt-cache TTL, instead of polling in a
 * token-burning loop. The behavior under test (all asserted via an INJECTED
 * fake timer — never a real wall-clock wait):
 *   1. resolves only after the requested duration advances on the fake clock;
 *   2. the scheduled handle is `.unref()`'d (a pending sleep never blocks drain);
 *   3. an AbortSignal mid-sleep resolves promptly AND clears the timer (no leak);
 *   4. a negative / absurd duration is clamped to a safe bound (0..~300s), never
 *      a throw and never an unbounded sleep;
 *   5. the description surfaces the ~5-min cache TTL + the sleep-once-not-poll
 *      guidance so the model defers in one call.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createSleepTool, MAX_SLEEP_MS, type SleepTimer } from "./sleep-tool.js";

// ---------------------------------------------------------------------------
// Fake timer: a deterministic stand-in for the sanctioned systemSetTimeout /
// systemClearTimeout helpers. Records unref() and clearTimeout() so the tests
// assert the no-shutdown-block + no-leak invariants without a wall-clock wait.
// ---------------------------------------------------------------------------

interface FakeScheduled {
  readonly id: number;
  readonly cb: () => void;
  readonly ms: number;
  unrefCalled: boolean;
  cleared: boolean;
}

function createFakeTimer(): {
  timer: SleepTimer;
  advance: (ms: number) => void;
  scheduled: FakeScheduled[];
} {
  const scheduled: FakeScheduled[] = [];
  let nextId = 1;
  let now = 0;
  const timer: SleepTimer = {
    setTimeout(cb: () => void, ms: number) {
      const entry: FakeScheduled = { id: nextId++, cb, ms: now + ms, unrefCalled: false, cleared: false };
      scheduled.push(entry);
      return {
        unref() {
          entry.unrefCalled = true;
          return this;
        },
      };
    },
    clearTimeout(handle: { unref(): unknown }) {
      // The handle is opaque to the fake; the tool schedules exactly one timer,
      // so clear the most-recent un-cleared entry — that is the one being cancelled.
      void handle;
      const live = scheduled.filter((s) => !s.cleared);
      const last = live[live.length - 1];
      if (last) last.cleared = true;
    },
  };
  return {
    timer,
    scheduled,
    advance(ms: number) {
      now += ms;
      for (const entry of scheduled) {
        if (!entry.cleared && entry.ms <= now) {
          entry.cleared = true; // fire-once
          entry.cb();
        }
      }
    },
  };
}

function textOf(result: AgentToolResult<unknown>): string {
  const block = result.content.find((c) => c.type === "text");
  return block && "text" in block ? block.text : "";
}

describe("createSleepTool — sleep primitive", () => {
  it("resolves only AFTER the requested duration advances on the injected clock", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });

    let resolved = false;
    const p = tool.execute("call-1", { seconds: 2 }).then((r) => {
      resolved = true;
      return r;
    });

    // Let any microtasks flush — the sleep MUST still be pending (timer not advanced).
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(fake.scheduled).toHaveLength(1);
    expect(fake.scheduled[0].ms).toBe(2000); // 2 seconds → 2000ms scheduled

    // Advance the fake clock past the duration — now it resolves.
    fake.advance(2000);
    const result = await p;
    expect(resolved).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("accepts an `ms` parameter directly", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });

    const p = tool.execute("call-ms", { ms: 1500 });
    await Promise.resolve();
    expect(fake.scheduled[0].ms).toBe(1500);
    fake.advance(1500);
    await p;
  });

  it("uses the real systemSetTimeout defaultTimer when no timer is injected (ms:0 resolves promptly)", async () => {
    // No timer override → the production defaultTimer (sanctioned systemSetTimeout + .unref()).
    // ms:0 schedules a real next-tick timer, exercising the default wiring end-to-end.
    const tool = createSleepTool();
    const result = await tool.execute("call-real-timer", { ms: 0 });
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("calls .unref() on the scheduled handle (a pending sleep never blocks shutdown)", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });

    const p = tool.execute("call-2", { seconds: 1 });
    await Promise.resolve();
    expect(fake.scheduled).toHaveLength(1);
    expect(fake.scheduled[0].unrefCalled).toBe(true);

    fake.advance(1000);
    await p;
  });

  it("resolves promptly AND clears the timer when the AbortSignal fires mid-sleep (no leak)", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });
    const ac = new AbortController();

    const p = tool.execute("call-3", { seconds: 300 }, ac.signal);
    await Promise.resolve();
    expect(fake.scheduled).toHaveLength(1);
    expect(fake.scheduled[0].cleared).toBe(false);

    // Abort mid-sleep — without advancing the clock at all.
    ac.abort();
    const result = await p; // MUST resolve without the timer ever firing
    expect(fake.scheduled[0].cleared).toBe(true); // timer cleared → no leak
    expect(textOf(result).toLowerCase()).toContain("abort");
  });

  it("resolves immediately when the signal is ALREADY aborted (never schedules)", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });
    const ac = new AbortController();
    ac.abort();

    const result = await tool.execute("call-pre", { seconds: 60 }, ac.signal);
    expect(textOf(result).toLowerCase()).toContain("abort");
  });

  it("clamps a negative duration to 0 (never an unbounded/throwing sleep)", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });

    const p = tool.execute("call-4", { seconds: -50 });
    await Promise.resolve();
    expect(fake.scheduled[0].ms).toBe(0); // clamped to 0
    fake.advance(0);
    const result = await p;
    expect(textOf(result)).not.toBe("");
  });

  it("clamps an absurd duration to the MAX_SLEEP_MS cache-TTL bound", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });

    const p = tool.execute("call-5", { seconds: 99999 });
    await Promise.resolve();
    expect(fake.scheduled[0].ms).toBe(MAX_SLEEP_MS); // clamped to the bound
    expect(MAX_SLEEP_MS).toBeLessThanOrEqual(300_000); // ~5 minutes
    fake.advance(MAX_SLEEP_MS);
    await p;
  });

  it("treats a non-numeric / missing duration as a clamped default, never a throw", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });

    // No params at all — must resolve a clamped value, not throw.
    const p = tool.execute("call-6", {});
    await Promise.resolve();
    expect(fake.scheduled).toHaveLength(1);
    expect(fake.scheduled[0].ms).toBeGreaterThanOrEqual(0);
    expect(fake.scheduled[0].ms).toBeLessThanOrEqual(MAX_SLEEP_MS);
    fake.advance(MAX_SLEEP_MS);
    await p;
  });

  it("a NUMERIC-STRING ms (LLMs emit `{ ms: \"1500\" }`) is coerced, not thrown", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });

    // readNumberParam(...,false) THROWS on a present-but-non-number value, which
    // would escape execute() (no try/catch) — contradicting the "never a throw"
    // invariant. A numeric string must coerce to its number and schedule.
    const p = tool.execute("call-str-ms", { ms: "1500" });
    await Promise.resolve();
    expect(fake.scheduled).toHaveLength(1);
    expect(fake.scheduled[0].ms).toBe(1500);
    fake.advance(1500);
    await expect(p).resolves.toBeDefined();
  });

  it("an UNPARSEABLE string duration falls back to the clamped default, never a throw", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });

    // `{ seconds: "abc" }` is present but not a number → must NOT throw; it falls
    // back to the MAX_SLEEP_MS cache-window default (the documented invariant).
    const p = tool.execute("call-bad-sec", { seconds: "abc" });
    await Promise.resolve();
    expect(fake.scheduled).toHaveLength(1);
    expect(fake.scheduled[0].ms).toBe(MAX_SLEEP_MS);
    fake.advance(MAX_SLEEP_MS);
    await expect(p).resolves.toBeDefined();
  });

  it("a numeric-string `seconds` coerces (and ms-string still wins over seconds-string)", async () => {
    const fake = createFakeTimer();
    const tool = createSleepTool({ timer: fake.timer });

    const p = tool.execute("call-str-sec", { seconds: "2", ms: "500" });
    await Promise.resolve();
    expect(fake.scheduled).toHaveLength(1);
    // ms takes precedence over seconds even when both arrive as strings.
    expect(fake.scheduled[0].ms).toBe(500);
    fake.advance(500);
    await expect(p).resolves.toBeDefined();
  });

  it("surfaces the ~5-min prompt-cache TTL and the sleep-once-not-poll guidance in its description", () => {
    const tool = createSleepTool({ timer: createFakeTimer().timer });
    const desc = tool.description.toLowerCase();
    expect(desc).toMatch(/5.?min|cache/);
    expect(desc).toContain("cache");
    expect(desc).toMatch(/once|poll/); // "sleep once rather than poll"
  });

  it("is named `sleep` with label `Sleep`", () => {
    const tool = createSleepTool({ timer: createFakeTimer().timer });
    expect(tool.name).toBe("sleep");
    expect(tool.label).toBe("Sleep");
  });

  it("defaults to the sanctioned systemSetTimeout when no timer is injected", async () => {
    // Real timer path: a tiny sleep resolves under real time. Bounded so the
    // suite stays fast; proves the default wiring is live (no injected fake).
    const tool = createSleepTool();
    const result = await tool.execute("call-real", { ms: 1 });
    expect(textOf(result)).not.toBe("");
  });
});
