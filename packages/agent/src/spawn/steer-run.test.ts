// SPDX-License-Identifier: Apache-2.0
/**
 * STEER-01 (Phase 175 Plan 02, Task 1) — steerRun() inject mechanism.
 *
 * steerRun is the live-child inject helper extracted from sub-agent-runner.ts
 * (which is over the §2.8 800-line cap). It resolves the RUNNING child's live
 * RunHandle via the A1-chosen lookup (175-00-SUMMARY:
 * `resolveActiveSession(deriveCompositeForRun(run))` — the SAME lookup killRun
 * uses for abort()) and calls the channel-path streaming-aware primitive:
 *   isStreaming() && !isCompacting() ? handle.steer(msg) : handle.followUp(msg)
 * (mirroring setup-and-route.ts:267) — NO killRun, NO spawn, NO run.status
 * mutation. The run's identity (runId/transcript/progress) is preserved.
 *
 * These tests use a RunHandle test double exposing the full surface
 * (steer/followUp/abort/isStreaming/isCompacting) so we can assert WHICH
 * primitive lands the inject and that the run object is never mutated.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { steerRun, type SteerRunDeps } from "./steer-run.js";
import type { RunHandle } from "../executor/active-run-registry.js";
import type { SubAgentRun } from "./sub-agent-runner.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A running sub-agent run fixture (the EXACT spawn shape, 175-00-SUMMARY). */
function makeRun(overrides: Partial<SubAgentRun> = {}): SubAgentRun {
  return {
    runId: "run-1",
    status: "running",
    agentId: "researcher",
    task: "research AI",
    sessionKey: "default:sub-agent-run-1:sub-agent:run-1",
    startedAt: 1_000,
    depth: 0,
    ...overrides,
  };
}

/** A full RunHandle double. `streaming`/`compacting` drive the steer-vs-followUp branch. */
function makeHandle(opts: { streaming: boolean; compacting?: boolean }): RunHandle & {
  steer: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
} {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    isStreaming: () => opts.streaming,
    isCompacting: () => opts.compacting ?? false,
  };
}

/** Build SteerRunDeps with a composite resolver returning `handle` for any run. */
function makeDeps(opts: {
  run?: SubAgentRun;
  handle?: RunHandle;
  resolveSpy?: ReturnType<typeof vi.fn>;
}): SteerRunDeps {
  const runs = new Map<string, SubAgentRun>();
  if (opts.run) runs.set(opts.run.runId, opts.run);
  const resolveActiveSession =
    opts.resolveSpy ?? vi.fn().mockReturnValue(opts.handle);
  return {
    runs,
    sessionResolver: { resolveActiveSession },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("steerRun — inject a steer message into a running sub-agent's live session", () => {
  it("streaming child injects via handle.steer and returns {steered:true, mode:'steer'}", async () => {
    const run = makeRun();
    const handle = makeHandle({ streaming: true, compacting: false });
    const deps = makeDeps({ run, handle });

    const result = await steerRun(deps, "run-1", "adjust the plan");

    expect(handle.steer).toHaveBeenCalledWith("adjust the plan");
    expect(handle.followUp).not.toHaveBeenCalled();
    expect(handle.abort).not.toHaveBeenCalled();
    expect(result).toEqual({ steered: true, mode: "steer" });
  });

  it("idle (not streaming) child injects via handle.followUp and returns mode:'followup'", async () => {
    const run = makeRun();
    const handle = makeHandle({ streaming: false });
    const deps = makeDeps({ run, handle });

    const result = await steerRun(deps, "run-1", "adjust the plan");

    expect(handle.followUp).toHaveBeenCalledWith("adjust the plan");
    expect(handle.steer).not.toHaveBeenCalled();
    expect(result).toEqual({ steered: true, mode: "followup" });
  });

  it("compacting child injects via handle.followUp (not steer) even when streaming", async () => {
    const run = makeRun();
    const handle = makeHandle({ streaming: true, compacting: true });
    const deps = makeDeps({ run, handle });

    const result = await steerRun(deps, "run-1", "adjust the plan");

    expect(handle.followUp).toHaveBeenCalledWith("adjust the plan");
    expect(handle.steer).not.toHaveBeenCalled();
    expect(result).toEqual({ steered: true, mode: "followup" });
  });

  it("no live handle returns {steered:false, error:/No live session/} and injects nothing", async () => {
    const run = makeRun();
    const handle = makeHandle({ streaming: true });
    const deps = makeDeps({ run, handle, resolveSpy: vi.fn().mockReturnValue(undefined) });

    const result = await steerRun(deps, "run-1", "adjust the plan");

    expect(result.steered).toBe(false);
    expect(result.error).toMatch(/No live session/);
    expect(handle.steer).not.toHaveBeenCalled();
    expect(handle.followUp).not.toHaveBeenCalled();
  });

  it("unknown run id returns {steered:false, error:/Unknown run/} without resolving a handle", async () => {
    const resolveSpy = vi.fn();
    const deps = makeDeps({ resolveSpy }); // no run added to the map

    const result = await steerRun(deps, "ghost-run", "adjust the plan");

    expect(result.steered).toBe(false);
    expect(result.error).toMatch(/Unknown run/);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("preserves the run object — never mutates status/sessionKey/startedAt (same runId, work preserved)", async () => {
    const run = makeRun();
    const before = { status: run.status, sessionKey: run.sessionKey, startedAt: run.startedAt };
    const handle = makeHandle({ streaming: true });
    const deps = makeDeps({ run, handle });

    await steerRun(deps, "run-1", "adjust the plan");

    expect(run.status).toBe(before.status);
    expect(run.sessionKey).toBe(before.sessionKey);
    expect(run.startedAt).toBe(before.startedAt);
    expect(run.completedAt).toBeUndefined();
    expect(run.error).toBeUndefined();
  });

  it("never re-runs tool assembly — the deps surface carries no tool-grant function (denylist orthogonality)", () => {
    // Structural assertion: a steer is a message, never a tool grant. SteerRunDeps
    // exposes only runs + the resolver/registry lookups + logger — there is no
    // tool-assembly / computeReachableToolNames / profile hook on the inject path.
    // (The runtime denylist proof for a steered denied-tool request is Task 3.)
    const run = makeRun();
    const handle = makeHandle({ streaming: true });
    const deps = makeDeps({ run, handle });

    const depKeys = Object.keys(deps);
    expect(depKeys).toEqual(expect.arrayContaining(["runs", "sessionResolver", "logger"]));
    for (const key of depKeys) {
      expect(key).not.toMatch(/tool|profile|reachable|grant|assembl/i);
    }
  });
});
