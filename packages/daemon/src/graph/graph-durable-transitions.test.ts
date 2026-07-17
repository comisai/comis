// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { GraphRunState } from "./graph-coordinator-state.js";
import { createGraphDurableTransitions } from "./graph-durable-transitions.js";

function graphState(graphId: string): GraphRunState {
  return { graphId } as GraphRunState;
}

describe("createGraphDurableTransitions", () => {
  it("releases a continuation only after its serialized checkpoint succeeds", async () => {
    let releaseCheckpoint = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const checkpoint = vi.fn(async () => {
      await gate;
      return true;
    });
    const transitions = createGraphDurableTransitions({
      requiresBoundary: () => true,
      checkpoint,
    });
    const continuation = vi.fn();
    const pending = transitions.run(graphState("graph-a"), (afterPersistence) => {
      afterPersistence(continuation);
    });

    await Promise.resolve();
    expect(continuation).not.toHaveBeenCalled();
    releaseCheckpoint();
    expect(await pending).toBe(true);
    expect(continuation).toHaveBeenCalledTimes(1);
  });

  it("settles a throwing transition and parks only that graph tail", async () => {
    const logger = { error: vi.fn() };
    const transitions = createGraphDurableTransitions({
      requiresBoundary: () => true,
      checkpoint: async () => true,
      logger,
    });

    expect(await transitions.run(graphState("graph-bad"), () => {
      throw new Error("transition failed");
    })).toBe(false);
    expect(await transitions.awaitGraph(graphState("graph-bad"))).toBe(false);
    expect(await transitions.run(graphState("graph-good"), () => {})).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("drains an in-flight tail without releasing its continuation after blocking", async () => {
    let releaseCheckpoint = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const transitions = createGraphDurableTransitions({
      requiresBoundary: () => true,
      checkpoint: async () => {
        await gate;
        return true;
      },
    });
    const continuation = vi.fn();
    const gs = graphState("graph-shutdown");
    const pending = transitions.run(gs, (afterPersistence) => afterPersistence(continuation));
    const drained = transitions.blockAllAndDrain([gs.graphId]);

    releaseCheckpoint();
    await drained;
    expect(await pending).toBe(false);
    expect(continuation).not.toHaveBeenCalled();
  });
});
