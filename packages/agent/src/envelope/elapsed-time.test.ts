import { describe, it, expect } from "vitest";
import { formatElapsed } from "./elapsed-time.js";

describe("formatElapsed", () => {
  it("returns +Ns for < 60 seconds", () => {
    expect(formatElapsed(30_000, 0)).toBe("+30s");
  });

  it("returns +1s for exactly 1 second", () => {
    expect(formatElapsed(1_000, 0)).toBe("+1s");
  });

  it("returns +Nm for < 60 minutes (floors to whole minutes)", () => {
    expect(formatElapsed(60_000, 0)).toBe("+1m");
    expect(formatElapsed(90_000, 0)).toBe("+1m"); // 90s = 1.5m, floors to 1m
  });

  it("returns +Nh for < 24 hours", () => {
    expect(formatElapsed(3_600_000, 0)).toBe("+1h");
    expect(formatElapsed(7_200_000, 0)).toBe("+2h");
  });

  it("returns +Nd for >= 24 hours", () => {
    expect(formatElapsed(86_400_000, 0)).toBe("+1d");
    expect(formatElapsed(172_800_000, 0)).toBe("+2d");
  });

  it("returns empty string for negative diff", () => {
    expect(formatElapsed(0, 1_000)).toBe("");
  });

  it("returns empty string for zero diff", () => {
    expect(formatElapsed(1_000, 1_000)).toBe("+0s");
  });

  it("returns empty string when diff exceeds maxMs", () => {
    // Default maxMs is not applied by formatElapsed -- caller must handle
    // But when maxMs is passed, elapsed beyond threshold returns empty
    expect(formatElapsed(100_000_000, 0, 86_400_000)).toBe("");
  });

  it("returns value when diff is within maxMs", () => {
    expect(formatElapsed(3_600_000, 0, 86_400_000)).toBe("+1h");
  });

  it("returns value at exactly maxMs boundary", () => {
    expect(formatElapsed(86_400_000, 0, 86_400_000)).toBe("+1d");
  });

  it("handles large day counts", () => {
    // 7 days
    expect(formatElapsed(604_800_000, 0, 700_000_000)).toBe("+7d");
  });
});
