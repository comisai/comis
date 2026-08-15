// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { hasAcceptedDelegation } from "./accepted-delegation.js";

describe("hasAcceptedDelegation", () => {
  it("recognizes only successful session spawn receipts", () => {
    expect(hasAcceptedDelegation(undefined)).toBe(false);
    expect(hasAcceptedDelegation([
      { toolName: "sessions_spawn", success: false },
      { toolName: "web_search", success: true },
    ])).toBe(false);
    expect(hasAcceptedDelegation([
      { toolName: "sessions_spawn", success: true },
    ])).toBe(true);
  });
});
