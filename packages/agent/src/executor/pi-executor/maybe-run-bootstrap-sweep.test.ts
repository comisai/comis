// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for maybeRunBootstrapSweep — the run-ONCE bootstrap
 * crash-recovery trigger extracted from pi-executor's in-lock body.
 *
 * Motivating bug: the previous inline block gated ONLY on contextStore presence, so the sweep
 * ran on EVERY turn. The first test pins the fix — when `isFirstMessageInSession === false`
 * the helper must NOT invoke the recovery (no store read). It FAILS on a no-gate version
 * (which would delegate every turn). The second test pins the happy path (first message →
 * sweep runs with the well-formed read-scope == write-scope). The recovery logic itself
 * (bootstrapLcdSweep) is mocked — this is the gate + scope-build seam only.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the recovery delegate so we assert ONLY the gate + scope wiring (not the LCD ingest).
const bootstrapLcdSweep = vi.fn(async () => {});
vi.mock("../lcd-bootstrap-sweep.js", () => ({
  bootstrapLcdSweep: (...args: unknown[]) => bootstrapLcdSweep(...args),
}));

import { maybeRunBootstrapSweep, type MaybeRunBootstrapSweepState } from "./maybe-run-bootstrap-sweep.js";
import type { ContextStorePort } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const noopLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  fatal: () => {}, trace: () => {}, child: () => noopLogger,
};

/** A store double — the helper only forwards it to the (mocked) sweep, so identity is enough. */
function fakeStore(): ContextStorePort {
  return { runOnConversation: vi.fn() } as unknown as ContextStorePort;
}

function makeState(overrides: Partial<MaybeRunBootstrapSweepState> = {}): MaybeRunBootstrapSweepState {
  return {
    isFirstMessageInSession: true,
    contextStore: fakeStore(),
    formattedKey: "tenant-a:chan_a:user_a",
    conversationRef: `cv_${"b".repeat(43)}` as MaybeRunBootstrapSweepState["conversationRef"],
    tenantId: "tenant-a",
    agentId: "agent-a",
    live: [{ role: "user", content: "hi" }] as unknown as AgentMessage[],
    clock: { now: () => 1_700_000_000_000 } as MaybeRunBootstrapSweepState["clock"],
    logger: noopLogger as unknown as MaybeRunBootstrapSweepState["logger"],
    eventBus: { emit: vi.fn() } as unknown as MaybeRunBootstrapSweepState["eventBus"],
    config: { contextEngine: { enabled: true } },
    ...overrides,
  };
}

describe("maybeRunBootstrapSweep — run-once gate", () => {
  beforeEach(() => bootstrapLcdSweep.mockClear());

  it("does NOT run the sweep when isFirstMessageInSession is false (the per-turn-overhead fix)", async () => {
    await maybeRunBootstrapSweep(makeState({ isFirstMessageInSession: false }));
    // The pre-patch inline block ran the sweep every turn; the gated helper must skip it.
    expect(bootstrapLcdSweep).not.toHaveBeenCalled();
  });

  it("runs the sweep ONCE on the first message with opaque read authority", async () => {
    await maybeRunBootstrapSweep(makeState());
    expect(bootstrapLcdSweep).toHaveBeenCalledTimes(1);
    const arg = bootstrapLcdSweep.mock.calls[0]![0] as {
      scope: { conversationRef: string; sessionKey: string; agentId: string; tenantId: string };
    };
    expect(arg.scope).toEqual({
      conversationRef: `cv_${"b".repeat(43)}`,
      sessionKey: "tenant-a:chan_a:user_a",
      agentId: "agent-a",
      tenantId: "tenant-a",
    });
  });
});
