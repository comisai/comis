// SPDX-License-Identifier: Apache-2.0
/**
 * The hard runtime limit fired with a bare `Hard timeout exceeded` — naming neither the knob that
 * set it, the value it was set to, nor the tool that was running. Live: a 300008 ms failure
 * carrying exactly that, while the stall hint next to it named
 * `agents.<id>.promptTimeout.promptTimeoutMs` and both values. A message that says only "a timeout
 * happened" leaves the reader with nothing to change.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { hardTimeoutHint } from "./hard-timeout-hint.js";

describe("hard runtime limit hint", () => {
  it("names the tool whose run was aborted", () => {
    const hint = hardTimeoutHint({ toolName: "vendor_report", agentId: "default", limitMs: 300_000 });

    expect(hint).toContain("vendor_report");
  });

  it("names the exact config key for the OWNING agent, not a generic path", () => {
    const hint = hardTimeoutHint({ toolName: "vendor_report", agentId: "analytics", limitMs: 300_000 });

    // Per-owner-agent knob: a hint naming `agents.<id>` literally would send an operator editing
    // the wrong agent, or nothing at all.
    expect(hint).toContain("agents.analytics.backgroundTasks.maxBackgroundDurationMs");
  });

  it("states the value that actually expired", () => {
    const hint = hardTimeoutHint({ toolName: "vendor_report", agentId: "default", limitMs: 300_000 });

    // The resolved limit, so the reader can compare it against how long the work needs — the
    // schema default is not necessarily what this agent runs with.
    expect(hint).toContain("300000");
  });

  it("says an unchanged retry reaches the same ceiling", () => {
    const hint = hardTimeoutHint({ toolName: "vendor_report", agentId: "default", limitMs: 300_000 });

    expect(hint.toLowerCase()).toContain("unchanged");
  });

  it("says partial work was not returned, so an empty result is not read as an empty answer", () => {
    const hint = hardTimeoutHint({ toolName: "vendor_report", agentId: "default", limitMs: 300_000 });

    expect(hint.toLowerCase()).toContain("not returned");
  });

  it("keeps the timeout hint bounded", () => {
    const hint = hardTimeoutHint({
      toolName: "t".repeat(2000),
      agentId: "a".repeat(2000),
      limitMs: 300_000,
    });

    expect(hint.length).toBeLessThanOrEqual(600);
  });
});
