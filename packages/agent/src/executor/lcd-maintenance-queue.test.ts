// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { enqueueContextMaintenance } from "./lcd-maintenance-queue.js";

describe("enqueueContextMaintenance — slow work isolation", () => {
  it("serializes maintenance per conversation without owning the live writer queue", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstLatch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];

    const first = enqueueContextMaintenance("conversation_a", async () => {
      events.push("first-start");
      await firstLatch;
      events.push("first-end");
    });
    const secondTask = vi.fn(async () => {
      events.push("second");
    });
    const second = enqueueContextMaintenance("conversation_a", secondTask);

    await Promise.resolve();
    events.push("live-write");
    expect(events).toEqual(["first-start", "live-write"]);
    expect(secondTask).not.toHaveBeenCalled();

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "live-write", "first-end", "second"]);
  });

  it("continues the conversation queue after a maintenance rejection", async () => {
    const failed = enqueueContextMaintenance("conversation_b", async () => {
      throw new Error("summarizer unavailable");
    });
    await expect(failed).rejects.toThrow("summarizer unavailable");

    const next = vi.fn(async () => {});
    await expect(enqueueContextMaintenance("conversation_b", next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
