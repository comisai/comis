// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createBlockPacer } from "./block-pacer.js";
import type { PacerConfig } from "./block-pacer.js";

describe("createBlockPacer", () => {
  const defaultConfig: PacerConfig = {
    timingConfig: { mode: "natural", minMs: 100, maxMs: 200, jitterMs: 0, firstBlockDelayMs: 0 },
    coalesceMaxChars: 500,
  };

  let send: Mock<(text: string) => Promise<void>>;

  beforeEach(() => {
    send = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers all blocks to send function in order", async () => {
    const pacer = createBlockPacer({
      timingConfig: { mode: "off", minMs: 0, maxMs: 0, jitterMs: 0, firstBlockDelayMs: 0 },
      coalesceMaxChars: 10, // Small enough that blocks won't coalesce
    });

    await pacer.deliver(["Block 1", "Block 2", "Block 3"], send);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toBe("Block 1");
    expect(send.mock.calls[1][0]).toBe("Block 2");
    expect(send.mock.calls[2][0]).toBe("Block 3");
  });

  it("coalesces short blocks below coalesceMaxChars", async () => {
    const pacer = createBlockPacer({
      timingConfig: { mode: "off", minMs: 0, maxMs: 0, jitterMs: 0, firstBlockDelayMs: 0 },
      coalesceMaxChars: 500,
    });

    await pacer.deliver(["Hi", "there", "friend"], send);

    // All three short blocks should be merged into one send
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("Hi\n\nthere\n\nfriend");
  });

  it("does not coalesce blocks exceeding coalesceMaxChars", async () => {
    const pacer = createBlockPacer({
      timingConfig: { mode: "off", minMs: 0, maxMs: 0, jitterMs: 0, firstBlockDelayMs: 0 },
      coalesceMaxChars: 10,
    });

    await pacer.deliver(["Hello world!", "Another block"], send);

    // Each block exceeds 10 chars when combined, so they stay separate
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBe("Hello world!");
    expect(send.mock.calls[1][0]).toBe("Another block");
  });

  it("adds delay between coalesced groups", async () => {
    vi.useFakeTimers();

    const pacer = createBlockPacer({
      timingConfig: { mode: "custom", minMs: 100, maxMs: 100, jitterMs: 0, firstBlockDelayMs: 0 },
      coalesceMaxChars: 10,
    });

    const deliverPromise = pacer.deliver(["Block 1", "Block 2"], send);

    // First block should be sent immediately (firstBlockDelayMs = 0)
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("Block 1");

    // Second block not yet sent (waiting on delay)
    expect(send).toHaveBeenCalledTimes(1);

    // Advance past the delay
    await vi.advanceTimersByTimeAsync(150);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBe("Block 2");

    await deliverPromise;

    vi.useRealTimers();
  });

  it("no delay before first block", async () => {
    vi.useFakeTimers();

    const pacer = createBlockPacer({
      timingConfig: { mode: "natural", minMs: 500, maxMs: 500, jitterMs: 0, firstBlockDelayMs: 0 },
      coalesceMaxChars: 10,
    });

    const deliverPromise = pacer.deliver(["First block"], send);

    // First block should be sent immediately with no delay
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("First block");

    await deliverPromise;

    vi.useRealTimers();
  });

  it("cancel sends remaining blocks immediately without pacing delays", async () => {
    vi.useFakeTimers();

    const pacer = createBlockPacer({
      timingConfig: { mode: "custom", minMs: 5000, maxMs: 5000, jitterMs: 0, firstBlockDelayMs: 0 },
      coalesceMaxChars: 10,
    });

    const deliverPromise = pacer.deliver(
      ["Block 1", "Block 2", "Block 3"],
      send,
    );

    // First block sent immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    // Cancel while waiting for delay before second block
    pacer.cancel();

    // The remaining blocks should be delivered immediately
    await vi.advanceTimersByTimeAsync(0);
    await deliverPromise;

    // All 3 blocks should have been sent (none dropped)
    expect(send).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it("handles empty blocks array", async () => {
    const pacer = createBlockPacer(defaultConfig);

    await pacer.deliver([], send);

    expect(send).not.toHaveBeenCalled();
  });

  it("handles single block without delay or coalescing", async () => {
    const pacer = createBlockPacer(defaultConfig);

    await pacer.deliver(["Only one"], send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("Only one");
  });

  // --- New tests ---

  it("skips internal coalescing when disableCoalescing is true", async () => {
    const pacer = createBlockPacer({
      timingConfig: { mode: "off", minMs: 0, maxMs: 0, jitterMs: 0, firstBlockDelayMs: 0 },
      coalesceMaxChars: 500, // High enough to normally coalesce
      disableCoalescing: true,
    });

    await pacer.deliver(["Hi", "there", "friend"], send);

    // With disableCoalescing, all 3 blocks should be sent separately
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toBe("Hi");
    expect(send.mock.calls[1][0]).toBe("there");
    expect(send.mock.calls[2][0]).toBe("friend");
  });

  it("delivers first block with delay when firstBlockDelayMs > 0", async () => {
    vi.useFakeTimers();

    const pacer = createBlockPacer({
      timingConfig: { mode: "natural", minMs: 100, maxMs: 200, jitterMs: 0, firstBlockDelayMs: 200 },
      coalesceMaxChars: 10,
    });

    const deliverPromise = pacer.deliver(["First", "Second"], send);

    // First block should NOT be sent at t=0
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(0);

    // First block IS sent after the firstBlockDelayMs
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("First");

    // Advance past second block delay
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledTimes(2);

    await deliverPromise;

    vi.useRealTimers();
  });

  // --- External abort signal ---

  describe("external abort signal", () => {
    it("stops delivery when external signal aborts during delay", async () => {
      vi.useFakeTimers();

      const externalController = new AbortController();
      const pacer = createBlockPacer({
        timingConfig: { mode: "custom", minMs: 5000, maxMs: 5000, jitterMs: 0, firstBlockDelayMs: 0 },
        coalesceMaxChars: 10,
        externalSignal: externalController.signal,
      });

      const deliverPromise = pacer.deliver(
        ["Block 1", "Block 2", "Block 3"],
        send,
      );

      // First block sent immediately (firstBlockDelayMs = 0)
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);

      // Abort external signal during delay before second block
      externalController.abort("User sent /stop");

      // Advance past the delay -- remaining blocks should NOT be sent
      await vi.advanceTimersByTimeAsync(6000);
      await deliverPromise;

      // Only the first block should have been sent (hard stop, not graceful)
      expect(send).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("external abort stops even mid-sequence (does not send remaining)", async () => {
      // Pre-aborted signal: deliver() should send 0 blocks
      const externalController = new AbortController();
      externalController.abort("pre-aborted");

      const pacer = createBlockPacer({
        timingConfig: { mode: "off", minMs: 0, maxMs: 0, jitterMs: 0, firstBlockDelayMs: 0 },
        coalesceMaxChars: 10,
        externalSignal: externalController.signal,
      });

      await pacer.deliver(["Block 1", "Block 2", "Block 3"], send);

      expect(send).toHaveBeenCalledTimes(0);
    });

    it("cancel() still sends remaining immediately with external signal present", async () => {
      vi.useFakeTimers();

      const externalController = new AbortController();
      const pacer = createBlockPacer({
        timingConfig: { mode: "custom", minMs: 5000, maxMs: 5000, jitterMs: 0, firstBlockDelayMs: 0 },
        coalesceMaxChars: 10,
        externalSignal: externalController.signal, // NOT aborted
      });

      const deliverPromise = pacer.deliver(
        ["Block 1", "Block 2", "Block 3"],
        send,
      );

      // First block sent immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);

      // Cancel (graceful) while waiting for delay
      pacer.cancel();

      // Remaining blocks should be sent immediately (no blocks skipped)
      await vi.advanceTimersByTimeAsync(0);
      await deliverPromise;

      // All 3 blocks should have been sent
      expect(send).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });
  });

  it("off mode delivers all blocks without delay", async () => {
    vi.useFakeTimers();

    const pacer = createBlockPacer({
      timingConfig: { mode: "off", minMs: 800, maxMs: 2500, jitterMs: 200, firstBlockDelayMs: 0 },
      coalesceMaxChars: 1, // Prevent coalescing so blocks stay separate
    });

    const deliverPromise = pacer.deliver(["A", "B", "C"], send);

    // All blocks should be sent immediately (no delays)
    await vi.advanceTimersByTimeAsync(0);
    await deliverPromise;

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toBe("A");
    expect(send.mock.calls[1][0]).toBe("B");
    expect(send.mock.calls[2][0]).toBe("C");

    vi.useRealTimers();
  });
});
