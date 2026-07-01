// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the `wait` reply mapping (terminal-wait-reply). RED-first: the module
 * does not exist when first committed. Covers the T1.1 producing/hint passthrough and the
 * load-bearing "never coerce isComplete to true" defense.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { mapWaitReply, degradedWaitResult, withCompleteNote, type WaitResult } from "./terminal-wait-reply.js";

describe("mapWaitReply", () => {
  it("passes the T1.1 producing + hint through verbatim", () => {
    const r = mapWaitReply({
      matched: false,
      isComplete: false,
      reason: "timeout",
      producing: true,
      hint: "keep waiting",
      screen: "scr",
      cursor: { x: 1, y: 2 },
    });
    expect(r).toMatchObject({
      matched: false,
      isComplete: false,
      reason: "timeout",
      producing: true,
      hint: "keep waiting",
      screen: "scr",
      cursor: { x: 1, y: 2 },
    });
  });

  it("NEVER coerces isComplete to true + defaults an unrecognized reason to timeout", () => {
    const r = mapWaitReply({ isComplete: "yes", reason: 42 });
    expect(r.isComplete).toBe(false);
    expect(r.reason).toBe("timeout");
  });

  it("omits producing/hint when absent or mistyped", () => {
    const r = mapWaitReply({ matched: true, isComplete: true, reason: "idle", producing: "nope", hint: 7 });
    expect(r.producing).toBeUndefined();
    expect(r.hint).toBeUndefined();
    expect(r.reason).toBe("idle");
  });

  it("tolerates a null/garbage payload (the safe empty not-complete view)", () => {
    const r = mapWaitReply(null);
    expect(r).toMatchObject({
      matched: false,
      isComplete: false,
      reason: "timeout",
      screen: "",
      cursor: { x: 0, y: 0 },
    });
  });
});

describe("withCompleteNote — FINDING-3 scope guard on a settle-complete wait", () => {
  // Live VPS 2026-06-17: the driving model over-reads `isComplete:true` (a SETTLE-scoped signal)
  // as "my whole task is done" and ends the turn, dropping later requested steps after a build.
  // The complete path must carry a model-facing note scoping `isComplete` to the settle.
  it("attaches the scope note when isComplete (so the driver does not over-read it as task-done)", () => {
    const out: WaitResult = { matched: true, isComplete: true, reason: "idle", screen: "x", cursor: { x: 0, y: 0 } };
    const r = withCompleteNote(out) as WaitResult & { note?: string };
    expect(r.note).toBeDefined();
    expect(r.note).toMatch(/SETTLED/);
    expect(r.note).toMatch(/does NOT mean your overall task is done/i);
    expect(r.note).toMatch(/remaining steps/i);
    // the rest of the result is preserved verbatim
    expect(r.isComplete).toBe(true);
    expect(r.reason).toBe("idle");
    expect(r.screen).toBe("x");
  });

  it("leaves a NOT-complete (timeout) result unchanged — no note (the driver keeps waiting)", () => {
    const out: WaitResult = { matched: false, isComplete: false, reason: "timeout", producing: true, screen: "", cursor: { x: 0, y: 0 } };
    const r = withCompleteNote(out) as WaitResult & { note?: string };
    expect(r.note).toBeUndefined();
    expect(r).toEqual(out);
  });
});

describe("withCompleteNote — never-tasked live-drive directive (loop-closure recovery, webhook-claude-cli-tdd-20260701)", () => {
  // The dominant flub: the agent creates a drive, clears the trust gate with send_key, then WAITS
  // before ever delivering the task (send_text). The wait resolves idle and the agent reads "nothing
  // to do" → ends the turn / hallucinates "I have no task". When the wait tool detects a LIVE
  // never-tasked drive it flips `neverTaskedLiveDrive`, and this helper returns a JIT directive
  // (superseding the FINDING-3 complete-note) steering the agent to deliver the task or fail honestly.
  it("attaches the task-not-delivered directive when the drive was never tasked (supersedes the complete-note)", () => {
    const out: WaitResult = { matched: true, isComplete: true, reason: "idle", screen: "idle-composer", cursor: { x: 0, y: 0 } };
    const r = withCompleteNote(out, true) as WaitResult & { note?: string };
    expect(r.note).toBeDefined();
    expect(r.note).toMatch(/have NOT delivered a task/i);
    expect(r.note).toMatch(/send_text/i);
    expect(r.note).toMatch(/honestly/i); // the honest-fail half
    expect(r.note).not.toMatch(/overall task is done/i); // it's the directive, NOT the FINDING-3 complete-note
    expect(r.isComplete).toBe(true); // the rest of the result is preserved verbatim
    expect(r.screen).toBe("idle-composer");
  });

  it("fires the directive even on a NOT-complete (timeout) wait when never-tasked (waiting is premature regardless of settle)", () => {
    const out: WaitResult = { matched: false, isComplete: false, reason: "timeout", producing: false, screen: "", cursor: { x: 0, y: 0 } };
    const r = withCompleteNote(out, true) as WaitResult & { note?: string };
    expect(r.note).toMatch(/have NOT delivered a task/i);
    expect(r.isComplete).toBe(false); // never coerced
  });

  it("a TASKED complete wait keeps the FINDING-3 scope note, NOT the directive (neverTaskedLiveDrive=false)", () => {
    const out: WaitResult = { matched: true, isComplete: true, reason: "idle", screen: "x", cursor: { x: 0, y: 0 } };
    const r = withCompleteNote(out, false) as WaitResult & { note?: string };
    expect(r.note).toMatch(/SETTLED/);
    expect(r.note).not.toMatch(/have NOT delivered a task/i);
  });

  it("default (neverTaskedLiveDrive omitted) is byte-identical to today — complete→scope-note, timeout→unchanged", () => {
    const complete: WaitResult = { matched: true, isComplete: true, reason: "idle", screen: "x", cursor: { x: 0, y: 0 } };
    expect((withCompleteNote(complete) as { note?: string }).note).toMatch(/SETTLED/);
    const timeout: WaitResult = { matched: false, isComplete: false, reason: "timeout", producing: true, screen: "", cursor: { x: 0, y: 0 } };
    expect(withCompleteNote(timeout)).toEqual(timeout);
  });
});

describe("degradedWaitResult", () => {
  it("is the honest not-complete shape with a worker-wedged hint (never isComplete:true)", () => {
    const r = degradedWaitResult();
    expect(r.matched).toBe(false);
    expect(r.isComplete).toBe(false);
    expect(r.hint).toMatch(/did not reply|wedged|status/i);
  });
});
