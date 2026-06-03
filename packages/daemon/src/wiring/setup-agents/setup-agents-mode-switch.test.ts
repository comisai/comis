// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the context-engine mode-switch helpers extracted from
 * setupSingleAgent (setup-agents-mode-switch.ts).
 *
 * Covers the detection guard (records only on a REAL prior!=new version
 * change; schema-default fallback when the new version is unset; brand-new
 * build records nothing) and the one-shot delete-on-read consumer (returns
 * the pending switch exactly once, then clears).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "@comis/infra";
import {
  detectAndRecordModeSwitch,
  makeConsumePendingModeSwitch,
  type PendingModeSwitches,
} from "./setup-agents-mode-switch.js";

function makeLogger(): ComisLogger {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as unknown as ComisLogger;
}

describe("detectAndRecordModeSwitch", () => {
  it("records a pending switch when the prior version differs from the new (pipeline->dag)", () => {
    const pending: PendingModeSwitches = new Map();
    const logger = makeLogger();

    detectAndRecordModeSwitch("agent-1", "pipeline", "dag", pending, logger);

    expect(pending.get("agent-1")).toEqual({ from: "pipeline", to: "dag" });
    // event<->log duality: the switch INFO-logs at the rebuild seam too.
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("records a pending switch in the dag->pipeline direction with the right from/to", () => {
    const pending: PendingModeSwitches = new Map();
    detectAndRecordModeSwitch("agent-2", "dag", "pipeline", pending, makeLogger());
    expect(pending.get("agent-2")).toEqual({ from: "dag", to: "pipeline" });
  });

  it("records NOTHING on a brand-new build (no prior version) — fullImport is not a switch", () => {
    const pending: PendingModeSwitches = new Map();
    const logger = makeLogger();

    detectAndRecordModeSwitch("agent-3", undefined, "dag", pending, logger);

    expect(pending.has("agent-3")).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("records NOTHING when the version is unchanged across a reload (prior === new)", () => {
    const pending: PendingModeSwitches = new Map();
    detectAndRecordModeSwitch("agent-4", "dag", "dag", pending, makeLogger());
    expect(pending.has("agent-4")).toBe(false);
  });

  it("falls back to the schema default ('dag') when the new version is unset", () => {
    const pending: PendingModeSwitches = new Map();
    // prior=pipeline, new=undefined -> resolves to the schema default 'dag',
    // which differs from pipeline, so a switch IS recorded.
    detectAndRecordModeSwitch("agent-5", "pipeline", undefined, pending, makeLogger());
    expect(pending.get("agent-5")).toEqual({ from: "pipeline", to: "dag" });
  });

  it("records NOTHING when prior matches the resolved schema default and new is unset", () => {
    const pending: PendingModeSwitches = new Map();
    // prior='dag' (the schema default), new=undefined -> resolves to 'dag' -> no change.
    detectAndRecordModeSwitch("agent-6", "dag", undefined, pending, makeLogger());
    expect(pending.has("agent-6")).toBe(false);
  });
});

describe("makeConsumePendingModeSwitch", () => {
  it("returns the pending switch on first read, then undefined (one-shot delete-on-read)", () => {
    const pending: PendingModeSwitches = new Map([
      ["agent-1", { from: "pipeline", to: "dag" }],
    ]);
    const consume = makeConsumePendingModeSwitch(pending);

    expect(consume("agent-1")).toEqual({ from: "pipeline", to: "dag" });
    // Cleared after the first read — a second reconcile sees nothing.
    expect(consume("agent-1")).toBeUndefined();
    expect(pending.has("agent-1")).toBe(false);
  });

  it("returns undefined for an agent with no pending switch (brand-new DAG conversation)", () => {
    const consume = makeConsumePendingModeSwitch(new Map());
    expect(consume("unknown-agent")).toBeUndefined();
  });

  it("consumes only the requested agent's entry, leaving other agents' switches intact", () => {
    const pending: PendingModeSwitches = new Map([
      ["agent-1", { from: "pipeline", to: "dag" }],
      ["agent-2", { from: "dag", to: "pipeline" }],
    ]);
    const consume = makeConsumePendingModeSwitch(pending);

    expect(consume("agent-1")).toEqual({ from: "pipeline", to: "dag" });
    // agent-2's pending switch is untouched.
    expect(pending.get("agent-2")).toEqual({ from: "dag", to: "pipeline" });
  });
});
