// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createFakeEnv } from "./fake-env.js";

describe("createFakeEnv (PORTS-08)", () => {
  it("get(key) returns the backing record's value", () => {
    const e = createFakeEnv({ FOO: "bar", BAZ: undefined });
    expect(e.get("FOO")).toBe("bar");
    expect(e.get("BAZ")).toBeUndefined();
    expect(e.get("MISSING")).toBeUndefined();
  });

  it("snapshot([…]) returns a frozen Record with the requested keys", () => {
    const e = createFakeEnv({ A: "1", B: undefined });
    const snap = e.snapshot(["A", "B", "C"]);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(snap["A"]).toBe("1");
    expect(snap["B"]).toBeUndefined();
    expect(snap["C"]).toBeUndefined();
  });
});
