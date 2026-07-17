// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import { createGraphCompletionTracker } from "./graph-completion-tracker.js";

describe("graph completion tracker", () => {
  it("deduplicates a graph completion and drains its pending receipt", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const complete = vi.fn(async () => {
      await gate;
      return ok(undefined);
    });
    const tracker = createGraphCompletionTracker(complete);
    const gs = { graphId: "graph-1" } as never;

    const first = tracker.run(gs);
    const second = tracker.run(gs);
    let drained = false;
    const drain = tracker.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(first).toBe(second);
    expect(complete).toHaveBeenCalledOnce();
    expect(drained).toBe(false);
    release();
    const [completion] = await Promise.all([first, drain]);
    expect(completion).toEqual({ ok: true, value: undefined });
    expect(drained).toBe(true);
    await expect(tracker.run(gs)).resolves.toEqual(ok(undefined));
    expect(complete).toHaveBeenCalledOnce();
  });

  it("returns a failed result when terminal completion rejects unexpectedly", async () => {
    const failure = new Error("completion boundary failed");
    const logger = { error: vi.fn() };
    const tracker = createGraphCompletionTracker(
      vi.fn(async () => Promise.reject(failure)),
      logger,
    );

    const result = await tracker.run({ graphId: "graph-failed" } as never);

    expect(result).toEqual({ ok: false, error: failure });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: "graph-failed",
        errorKind: "internal",
      }),
      "Graph completion task failed",
    );
  });

  it("reserves the graph before completion can re-enter the tracker", async () => {
    const gs = { graphId: "graph-reentrant" } as never;
    let reentrant: Promise<unknown> | undefined;
    let tracker: ReturnType<typeof createGraphCompletionTracker>;
    const complete = vi.fn(async () => {
      reentrant = tracker.run(gs);
      return ok(undefined);
    });
    tracker = createGraphCompletionTracker(complete);

    const first = tracker.run(gs);
    await expect(first).resolves.toEqual(ok(undefined));

    expect(reentrant).toBe(first);
    expect(complete).toHaveBeenCalledOnce();
  });
});
