import { describe, expect, it, vi, afterEach } from "vitest";
import { calculateDelay, type BlockTimingContext } from "./delivery-timing.js";
import type { DeliveryTimingConfig } from "@comis/core";

describe("calculateDelay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCtx(overrides: Partial<BlockTimingContext> = {}): BlockTimingContext {
    return {
      blockIndex: 1,
      totalBlocks: 3,
      blockCharCount: 100,
      isFirstBlock: false,
      ...overrides,
    };
  }

  function makeConfig(overrides: Partial<DeliveryTimingConfig> = {}): DeliveryTimingConfig {
    return {
      mode: "natural",
      minMs: 800,
      maxMs: 2500,
      jitterMs: 200,
      firstBlockDelayMs: 0,
      ...overrides,
    };
  }

  // --- Mode: off ---

  it('"off" mode returns 0 regardless of block context', () => {
    const config = makeConfig({ mode: "off" });

    // Test with various block contexts
    expect(calculateDelay(config, makeCtx({ blockIndex: 0, isFirstBlock: false }))).toBe(0);
    expect(calculateDelay(config, makeCtx({ blockIndex: 5, totalBlocks: 10 }))).toBe(0);
    expect(calculateDelay(config, makeCtx({ blockCharCount: 10000 }))).toBe(0);
  });

  // --- Mode: natural ---

  it('"natural" mode returns value between minMs and maxMs+jitterMs/2', () => {
    // Use deterministic Math.random returning 0.5 (midpoint)
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const config = makeConfig({ mode: "natural", minMs: 800, maxMs: 2500, jitterMs: 200 });
    const result = calculateDelay(config, makeCtx());

    // base = 0.5 * (2500 - 800) + 800 = 1650
    // jitter offset = (0.5 - 0.5) * 200 = 0
    // result = 1650
    expect(result).toBe(1650);
  });

  it('"natural" mode with low random produces near-minimum delay', () => {
    vi.spyOn(Math, "random").mockReturnValue(0.0);

    const config = makeConfig({ mode: "natural", minMs: 100, maxMs: 500, jitterMs: 0 });
    const result = calculateDelay(config, makeCtx());

    // base = 0.0 * (500 - 100) + 100 = 100
    expect(result).toBe(100);
  });

  it('"natural" mode with high random produces near-maximum delay', () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    const config = makeConfig({ mode: "natural", minMs: 100, maxMs: 500, jitterMs: 0 });
    const result = calculateDelay(config, makeCtx());

    // base = 0.99 * 400 + 100 = 496
    expect(result).toBeCloseTo(496, 0);
  });

  // --- Mode: custom ---

  it('"custom" mode returns value between minMs and maxMs+jitterMs/2', () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const config = makeConfig({ mode: "custom", minMs: 200, maxMs: 1000, jitterMs: 100 });
    const result = calculateDelay(config, makeCtx());

    // base = 0.5 * (1000 - 200) + 200 = 600
    // jitter = (0.5 - 0.5) * 100 = 0
    // result = 600
    expect(result).toBe(600);
  });

  // --- Mode: adaptive ---

  it('"adaptive" mode returns higher delay for longer blocks', () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const config = makeConfig({ mode: "adaptive", minMs: 100, maxMs: 2000, jitterMs: 0 });

    const shortBlockDelay = calculateDelay(
      config,
      makeCtx({ blockCharCount: 50, blockIndex: 1, totalBlocks: 5 }),
    );
    const longBlockDelay = calculateDelay(
      config,
      makeCtx({ blockCharCount: 1000, blockIndex: 1, totalBlocks: 5 }),
    );

    expect(longBlockDelay).toBeGreaterThan(shortBlockDelay);
  });

  it('"adaptive" mode returns higher delay for later blocks', () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const config = makeConfig({ mode: "adaptive", minMs: 100, maxMs: 2000, jitterMs: 0 });

    const earlyBlockDelay = calculateDelay(
      config,
      makeCtx({ blockIndex: 0, totalBlocks: 10, blockCharCount: 200, isFirstBlock: false }),
    );
    const lateBlockDelay = calculateDelay(
      config,
      makeCtx({ blockIndex: 9, totalBlocks: 10, blockCharCount: 200, isFirstBlock: false }),
    );

    expect(lateBlockDelay).toBeGreaterThan(earlyBlockDelay);
  });

  // --- First block handling ---

  it("first block returns 0 when firstBlockDelayMs is 0", () => {
    const config = makeConfig({ firstBlockDelayMs: 0 });
    const result = calculateDelay(config, makeCtx({ blockIndex: 0, isFirstBlock: true }));
    expect(result).toBe(0);
  });

  it("first block returns delayed value when firstBlockDelayMs > 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const config = makeConfig({ firstBlockDelayMs: 300, jitterMs: 100 });
    const result = calculateDelay(config, makeCtx({ blockIndex: 0, isFirstBlock: true }));

    // base = 300, jitter offset = (0.5 - 0.5) * 100 = 0
    // result = 300
    expect(result).toBe(300);
  });

  it("first block with large jitter still produces non-negative delay", () => {
    // random = 0.0 gives offset = (0.0 - 0.5) * 1000 = -500
    // base 100 + (-500) = -400 -> clamped to 0
    vi.spyOn(Math, "random").mockReturnValue(0.0);

    const config = makeConfig({ firstBlockDelayMs: 100, jitterMs: 1000 });
    const result = calculateDelay(config, makeCtx({ blockIndex: 0, isFirstBlock: true }));

    expect(result).toBeGreaterThanOrEqual(0);
  });

  // --- Jitter ---

  it("jitter never produces negative delays", () => {
    // random = 0.0 gives maximum negative jitter offset
    vi.spyOn(Math, "random").mockReturnValue(0.0);

    const config = makeConfig({ mode: "natural", minMs: 10, maxMs: 20, jitterMs: 500 });
    const result = calculateDelay(config, makeCtx());

    // base = 0.0 * (20-10) + 10 = 10
    // jitter = (0.0 - 0.5) * 500 = -250
    // 10 + (-250) = -240 -> clamped to 0
    expect(result).toBe(0);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("jitter is skipped when jitterMs is 0", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.75);

    const config = makeConfig({ mode: "natural", minMs: 100, maxMs: 500, jitterMs: 0 });
    const result = calculateDelay(config, makeCtx());

    // base = 0.75 * 400 + 100 = 400
    // No jitter applied (jitterMs is 0), so random called only once (for base)
    expect(result).toBe(400);

    // Math.random called once for base delay, not again for jitter
    expect(randomSpy).toHaveBeenCalledTimes(1);
  });
});
