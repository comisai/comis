import { describe, it, expect } from "vitest";
import { shouldBypassFileGates } from "./file-gate.js";
import type { HeartbeatTriggerKind } from "./file-gate.js";

describe("shouldBypassFileGates", () => {
  it("returns false for interval triggers", () => {
    expect(shouldBypassFileGates("interval")).toBe(false);
  });

  it("returns true for cron triggers", () => {
    expect(shouldBypassFileGates("cron")).toBe(true);
  });

  it("returns true for exec-event triggers", () => {
    expect(shouldBypassFileGates("exec-event")).toBe(true);
  });

  it("returns true for wake triggers", () => {
    expect(shouldBypassFileGates("wake")).toBe(true);
  });

  it("returns true for hook triggers", () => {
    expect(shouldBypassFileGates("hook")).toBe(true);
  });
});
