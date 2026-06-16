// SPDX-License-Identifier: Apache-2.0
/**
 * 166-03 — co-located unit coverage for the extracted NOTIFY-01/02 emit helpers
 * (`emitTerminalOutcome` + `runHeartbeatTick`). The holder suite
 * (`setup-terminal-wake.test.ts`) exercises these THROUGH the wiring; this suite pins their
 * branches DIRECTLY with plain fakes so the packages/daemon coverage floor stays green on the
 * new sibling — especially the gated-skip when `drive.notify` suppresses a non-escalation
 * outcome, the bus-only (no-notify) path, the `needs-you` defensive return, and the
 * no-journal / empty-journal heartbeat fallback.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { emitTerminalOutcome, runHeartbeatTick, type TerminalNotifyDeps, type TerminalOutcomeArgs, type HeartbeatTickArgs } from "./terminal-wake-notify.js";
import type { NotifyPolicy, DriveJournal } from "@comis/skills/tools";

interface NotifyHarness {
  /** The deps handed to the helper — `notify` is ABSENT when `opts.notify === false` (bus-only). */
  deps: TerminalNotifyDeps;
  /** The notify spy (exposed for assertions even when not wired into `deps`). */
  notify: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}

/** A capturing TerminalNotifyDeps fake (notify + info + warn + clock + policy). */
function makeNotifyDeps(policy: NotifyPolicy, opts: { notify?: boolean; rejectNotify?: boolean } = {}): NotifyHarness {
  const notify = vi.fn(async () => {
    if (opts.rejectNotify) throw new Error("channel down");
    return undefined;
  });
  const info = vi.fn();
  const warn = vi.fn();
  const deps = {
    // The bus-only case (opts.notify === false) deliberately omits `notify` so the helper
    // takes the "no channel callback" branch (I1).
    ...(opts.notify === false ? {} : { notify }),
    info,
    warn,
    nowMs: () => 1_000_000,
    policy,
  } as unknown as TerminalNotifyDeps;
  return { deps, notify, info, warn };
}

const baseArgs: TerminalOutcomeArgs = { sessionId: "s-1", agentId: "a", transition: "exited", durationMs: 7_200_000, interactions: 5 };

describe("emitTerminalOutcome — the gated done/failed emit + the §2.7 record (166-03)", () => {
  it("emits an INFO done record + a content-free notify on a promoted exit under terminal", () => {
    const deps = makeNotifyDeps("terminal");
    emitTerminalOutcome(deps.deps, baseArgs);
    const info = deps.info.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome");
    expect(info, "a done outcome emits an INFO step:drive_outcome record").toBeDefined();
    expect((info![0] as { outcome?: string }).outcome).toBe("done");
    expect(deps.notify).toHaveBeenCalledTimes(1);
    const msg = deps.notify.mock.calls[0]![0].message as string;
    expect(msg).toContain("s-1");
    expect(msg.toLowerCase()).toContain("done");
    // Content-free: the message carries the durations/counts, never screen text.
    expect(msg).toContain("elapsed");
    expect(msg).toContain("5 interactions");
  });

  it("emits a WARN failed (errorKind:dependency) + a hint on a lost transition", () => {
    const deps = makeNotifyDeps("terminal");
    emitTerminalOutcome(deps.deps, { ...baseArgs, transition: "lost" });
    const warn = deps.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome");
    expect(warn, "a lost outcome WARNs with step:drive_outcome").toBeDefined();
    expect((warn![0] as { outcome?: string }).outcome).toBe("failed");
    expect((warn![0] as { errorKind?: string }).errorKind).toBe("dependency");
    expect(typeof (warn![0] as { hint?: string }).hint).toBe("string");
    expect(deps.notify.mock.calls[0]![0].message.toLowerCase()).toContain("failed");
  });

  it("emits a WARN failed (errorKind:resource) NAMING the cap on an evicted transition", () => {
    const deps = makeNotifyDeps("terminal");
    emitTerminalOutcome(deps.deps, { ...baseArgs, transition: "evicted", capName: "wall_clock" });
    const warn = deps.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome");
    expect((warn![0] as { errorKind?: string }).errorKind).toBe("resource");
    expect((warn![0] as { capName?: string }).capName).toBe("wall_clock");
    expect(deps.notify.mock.calls[0]![0].message).toContain("wall_clock");
  });

  it("falls back to a structural cap name when an evicted transition carries no capName", () => {
    const deps = makeNotifyDeps("terminal");
    emitTerminalOutcome(deps.deps, { sessionId: "s-2", agentId: "a", transition: "evicted" });
    // Still a failed (resource) — a missing cap defaults to a safe structural label, never throws.
    const warn = deps.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome");
    expect((warn![0] as { errorKind?: string }).errorKind).toBe("resource");
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it("SKIPS the channel notify under policy none but STILL emits the §2.7 record (the gated-skip)", () => {
    const deps = makeNotifyDeps("none");
    emitTerminalOutcome(deps.deps, baseArgs); // a done under "none"
    expect(deps.notify, "done is suppressed under notify:none (the gate)").not.toHaveBeenCalled();
    // The log floor still fires (an operator who silenced the channel still gets the record).
    expect(deps.info.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome")).toBeDefined();
  });

  it("SKIPS the failed channel notify under policy none (still records the WARN)", () => {
    const deps = makeNotifyDeps("none");
    emitTerminalOutcome(deps.deps, { ...baseArgs, transition: "evicted", capName: "max_interactions" });
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome")).toBeDefined();
  });

  it("fires the channel notify under policy all", () => {
    const deps = makeNotifyDeps("all");
    emitTerminalOutcome(deps.deps, baseArgs);
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it("records the §2.7 line but makes NO channel call when no notify callback is present (bus-only, I1)", () => {
    const deps = makeNotifyDeps("terminal", { notify: false });
    emitTerminalOutcome(deps.deps, baseArgs);
    expect(deps.notify, "a bus-only channel makes no notify call").not.toHaveBeenCalled();
    expect(deps.info.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome")).toBeDefined();
  });

  it("swallows a notify rejection into a WARN (fire-and-forget; never throws on a channel fault)", async () => {
    const deps = makeNotifyDeps("terminal", { rejectNotify: true });
    expect(() => emitTerminalOutcome(deps.deps, baseArgs)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    const warn = deps.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_outcome_notify_failed");
    expect(warn, "a notify rejection degrades to a WARN").toBeDefined();
    expect((warn![0] as { errorKind?: string }).errorKind).toBe("resource");
  });

  it("omits the content-free tail when durationMs/interactions are absent or degenerate", () => {
    const deps = makeNotifyDeps("terminal");
    emitTerminalOutcome(deps.deps, { sessionId: "s-3", agentId: "a", transition: "exited" });
    const msg = deps.notify.mock.calls[0]![0].message as string;
    expect(msg, "no tail when there is nothing to report").not.toContain("elapsed");
    expect(msg, "no tail when there is nothing to report").not.toContain("interactions");
    // A negative/non-finite duration is degenerate → no tail (never "NaNh").
    deps.notify.mockClear();
    emitTerminalOutcome(deps.deps, { sessionId: "s-4", agentId: "a", transition: "exited", durationMs: -5, interactions: 0 });
    expect(deps.notify.mock.calls[0]![0].message).not.toContain("elapsed");
  });
});

describe("runHeartbeatTick — the NOTIFY-02 per-tick heartbeat loop body (166-03)", () => {
  const journal = (over: Partial<DriveJournal> = {}): DriveJournal => ({
    objective: "build",
    lastClassification: "working",
    lastScreenDigest: "12r 80c, 3 changed",
    answeredPrompts: [],
    stepsTried: [],
    elapsedMs: 7_200_000,
    interactions: 5,
    costUsd: 1.25,
    truncations: 0,
    ...over,
  });

  function makeTickArgs(over: Partial<HeartbeatTickArgs> = {}): HeartbeatTickArgs & { notify: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; lastHeartbeatSentMs: Map<string, number> } {
    const notify = vi.fn(async () => undefined);
    const info = vi.fn();
    const warn = vi.fn();
    return {
      promotedSessions: new Set(["s-1"]),
      driveJournals: new Map([["s-1", journal()]]),
      sessionAgent: new Map([["s-1", "a"]]),
      lastHeartbeatSentMs: new Map<string, number>(),
      notify,
      info,
      warn,
      nowMs: () => 10_000_000,
      heartbeatNotifyMs: 3_600_000,
      ...over,
    } as HeartbeatTickArgs & { notify: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; lastHeartbeatSentMs: Map<string, number> };
  }

  it("emits a content-free heartbeat + an INFO record for a due promoted drive and stamps the dedupe map", () => {
    const args = makeTickArgs();
    runHeartbeatTick(args);
    expect(args.notify).toHaveBeenCalledTimes(1);
    const msg = args.notify.mock.calls[0]![0].message as string;
    expect(msg.toLowerCase()).toContain("still working");
    expect(msg, "the digest carries the already-redacted lastScreenDigest verbatim").toContain("12r 80c, 3 changed");
    expect(args.info.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_heartbeat")).toBeDefined();
    // The dedupe stamp was set to now.
    expect(args.lastHeartbeatSentMs.get("s-1")).toBe(10_000_000);
  });

  it("does NOT re-emit for a session stamped within the cadence (the coarse dedupe)", () => {
    const args = makeTickArgs({ lastHeartbeatSentMs: new Map([["s-1", 9_999_000]]) });
    runHeartbeatTick(args); // now=10_000_000, last=9_999_000 → delta 1_000 < 3_600_000 → not due
    expect(args.notify).not.toHaveBeenCalled();
  });

  it("falls back to a safe '(no activity yet)' digest when the promoted session has no journal", () => {
    const args = makeTickArgs({ driveJournals: new Map() });
    runHeartbeatTick(args);
    expect(args.notify).toHaveBeenCalledTimes(1);
    expect(args.notify.mock.calls[0]![0].message).toContain("(no activity yet)");
  });

  it("emits NOTHING when there are no promoted sessions (I1)", () => {
    const args = makeTickArgs({ promotedSessions: new Set() });
    runHeartbeatTick(args);
    expect(args.notify).not.toHaveBeenCalled();
  });

  it("targets an empty agentId when the session-agent bridge is missing (defensive, never throws)", () => {
    const args = makeTickArgs({ sessionAgent: new Map() });
    expect(() => runHeartbeatTick(args)).not.toThrow();
    expect(args.notify.mock.calls[0]![0].agentId).toBe("");
  });

  it("swallows a heartbeat notify rejection into a WARN (fire-and-forget)", async () => {
    const notify = vi.fn(async () => {
      throw new Error("channel down");
    });
    const args = makeTickArgs({ notify });
    expect(() => runHeartbeatTick(args)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    const warn = args.warn.mock.calls.find((c) => (c[0] as { step?: string })?.step === "drive_heartbeat_notify_failed");
    expect(warn, "a heartbeat notify rejection degrades to a WARN").toBeDefined();
  });
});
