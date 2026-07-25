// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createCronExecutionFence } from "./cron-execution-fence.js";

describe("cron execution linearization fence", () => {
  it("cancellation before an irreversible phase prevents that phase from entering", () => {
    const controller = new AbortController();
    const fence = createCronExecutionFence(controller.signal);

    controller.abort();

    expect(fence.enter("platform_delivery")).toBe(false);
    expect(fence.isClosed()).toBe(true);
    fence.dispose();
  });

  it("a phase that enters before cancellation may settle but closes every later phase", () => {
    const controller = new AbortController();
    const fence = createCronExecutionFence(controller.signal);

    expect(fence.enter("platform_delivery")).toBe(true);
    controller.abort();
    expect(fence.isClosed()).toBe(false);

    fence.leave("platform_delivery");

    expect(fence.isClosed()).toBe(true);
    expect(fence.enter("continuation")).toBe(false);
    fence.dispose();
  });

  it("a settled phase leaves the fence open when no cancellation was requested", () => {
    const controller = new AbortController();
    const fence = createCronExecutionFence(controller.signal);

    expect(fence.enter("platform_delivery")).toBe(true);
    fence.leave("platform_delivery");

    expect(fence.enter("continuation")).toBe(true);
    fence.leave("continuation");
    expect(fence.isClosed()).toBe(false);
    fence.dispose();
  });

  it("rejects overlapping or mismatched phase transitions", () => {
    const fence = createCronExecutionFence(new AbortController().signal);

    expect(fence.enter("platform_delivery")).toBe(true);
    expect(fence.enter("continuation")).toBe(false);
    expect(fence.leave("continuation")).toBe(false);
    expect(fence.leave("platform_delivery")).toBe(true);
    fence.dispose();
  });
});
