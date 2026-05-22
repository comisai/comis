// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { formatElapsed } from "./format-elapsed.js";

describe("formatElapsed", () => {
  it("returns '--' for undefined input to indicate missing data", () => {
    expect(formatElapsed(undefined)).toBe("--");
  });

  it("returns '--' for null input to handle nullable property propagation from Lit", () => {
    expect(formatElapsed(null as unknown as number)).toBe("--");
  });

  it("renders zero milliseconds as 0.0s in the sub-minute decimal format", () => {
    expect(formatElapsed(0)).toBe("0.0s");
  });

  it("formats sub-minute durations with 1-decimal precision for visual continuity", () => {
    expect(formatElapsed(5700)).toBe("5.7s");
  });

  it("formats integer sub-minute durations with trailing decimal zero", () => {
    expect(formatElapsed(45000)).toBe("45.0s");
  });

  it("renders the exact 60-second boundary as 1m 00s with zero-padded seconds", () => {
    expect(formatElapsed(60000)).toBe("1m 00s");
  });

  it("zero-pads single-digit seconds in minute-plus output", () => {
    expect(formatElapsed(63000)).toBe("1m 03s");
  });

  it("formats typical minute-plus durations as Xm YYs with zero-padding", () => {
    expect(formatElapsed(225000)).toBe("3m 45s");
  });
});
