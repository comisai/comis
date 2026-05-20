// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  limitPayloadValue,
  BOUNDED_PAYLOAD_REASONS,
  PAYLOAD_BOUNDS,
} from "./bounded-payload.js";

describe("BOUNDED_PAYLOAD_REASONS — Comis-renamed sentinel enum", () => {
  it("exposes the five canonical sentinel reasons under bounded-payload-* names (NOT trajectory-*)", () => {
    expect(BOUNDED_PAYLOAD_REASONS.fieldSizeLimit).toBe(
      "bounded-payload-field-size-limit",
    );
    expect(BOUNDED_PAYLOAD_REASONS.arrayLengthLimit).toBe(
      "bounded-payload-array-length-limit",
    );
    expect(BOUNDED_PAYLOAD_REASONS.objectKeyLimit).toBe(
      "bounded-payload-object-key-limit",
    );
    expect(BOUNDED_PAYLOAD_REASONS.depthLimit).toBe(
      "bounded-payload-depth-limit",
    );
    expect(BOUNDED_PAYLOAD_REASONS.cycleDetected).toBe(
      "bounded-payload-cycle-detected",
    );
  });

  it("PAYLOAD_BOUNDS exposes the five numeric thresholds at their canonical values", () => {
    expect(PAYLOAD_BOUNDS.maxFieldSizeBytes).toBe(32 * 1024);
    expect(PAYLOAD_BOUNDS.maxArrayLength).toBe(64);
    expect(PAYLOAD_BOUNDS.maxObjectKeys).toBe(64);
    expect(PAYLOAD_BOUNDS.maxDepth).toBe(6);
  });
});

describe("limitPayloadValue — under-cap inputs pass through unchanged", () => {
  it("passes through a plain object with few keys", () => {
    expect(limitPayloadValue({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("passes through a short array unchanged", () => {
    expect(limitPayloadValue([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("passes through a short string unchanged", () => {
    expect(limitPayloadValue("hello")).toBe("hello");
  });

  it("passes through nested object within depth 6 unchanged", () => {
    const value = { a: { b: { c: { d: { e: { f: "deep" } } } } } };
    expect(limitPayloadValue(value)).toEqual(value);
  });

  it("passes through null and primitives", () => {
    expect(limitPayloadValue(null)).toBeNull();
    expect(limitPayloadValue(42)).toBe(42);
    expect(limitPayloadValue(true)).toBe(true);
  });
});

describe("limitPayloadValue — over-cap sentinels (BOUNDED_PAYLOAD_REASONS)", () => {
  it("replaces a string > 32 KB with the field-size-limit sentinel", () => {
    const huge = "x".repeat(32 * 1024 + 1);
    const result = limitPayloadValue(huge) as Record<string, unknown>;
    expect(result["__bounded__"]).toBe(
      BOUNDED_PAYLOAD_REASONS.fieldSizeLimit,
    );
    expect(result["originalBytes"]).toBe(32 * 1024 + 1);
  });

  it("does NOT replace a string exactly at 32 KB (boundary is strictly greater than)", () => {
    const exact = "x".repeat(32 * 1024);
    expect(limitPayloadValue(exact)).toBe(exact);
  });

  it("replaces an array with > 64 items with the array-length-limit sentinel", () => {
    const big = Array.from({ length: 65 }, (_, i) => i);
    const result = limitPayloadValue(big) as Record<string, unknown>;
    expect(result["__bounded__"]).toBe(
      BOUNDED_PAYLOAD_REASONS.arrayLengthLimit,
    );
    expect(result["originalLength"]).toBe(65);
  });

  it("does NOT replace an array of exactly 64 items (boundary is strictly greater than)", () => {
    const arr64 = Array.from({ length: 64 }, (_, i) => i);
    expect(limitPayloadValue(arr64)).toEqual(arr64);
  });

  it("replaces an object with > 64 keys with the object-key-limit sentinel", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 65; i += 1) big[`k${i}`] = i;
    const result = limitPayloadValue(big) as Record<string, unknown>;
    expect(result["__bounded__"]).toBe(
      BOUNDED_PAYLOAD_REASONS.objectKeyLimit,
    );
    expect(result["originalKeyCount"]).toBe(65);
  });

  it("does NOT replace an object of exactly 64 keys (boundary is strictly greater than)", () => {
    const obj64: Record<string, number> = {};
    for (let i = 0; i < 64; i += 1) obj64[`k${i}`] = i;
    expect(limitPayloadValue(obj64)).toEqual(obj64);
  });

  it("replaces a value at depth > 6 with the depth-limit sentinel", () => {
    // depth 7: outer=0, then 6 levels of nesting under .a
    const tooDeep = { a: { a: { a: { a: { a: { a: { a: 1 } } } } } } };
    const result = limitPayloadValue(tooDeep);
    // The leaf reachable only beyond depth 6 should be replaced.
    const probe = (result as Record<string, unknown>)["a"] as Record<string, unknown>;
    const drilled = (((((probe["a"] as Record<string, unknown>)["a"] as Record<string, unknown>)["a"] as Record<string, unknown>)["a"] as Record<string, unknown>)["a"] as Record<string, unknown>)["a"];
    expect(drilled).toEqual({
      __bounded__: BOUNDED_PAYLOAD_REASONS.depthLimit,
    });
  });

  it("replaces a value reached via a self-referencing cycle with the cycle-detected sentinel", () => {
    const node: Record<string, unknown> = { v: 1 };
    node["self"] = node;
    const result = limitPayloadValue(node) as Record<string, unknown>;
    expect(result["v"]).toBe(1);
    expect(result["self"]).toEqual({
      __bounded__: BOUNDED_PAYLOAD_REASONS.cycleDetected,
    });
  });

  it("replaces a cycle that runs through two objects with the cycle-detected sentinel on the back-edge", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a["next"] = b;
    b["back"] = a;
    const result = limitPayloadValue(a) as Record<string, unknown>;
    expect(result["name"]).toBe("a");
    const stepB = result["next"] as Record<string, unknown>;
    expect(stepB["name"]).toBe("b");
    expect(stepB["back"]).toEqual({
      __bounded__: BOUNDED_PAYLOAD_REASONS.cycleDetected,
    });
  });
});

describe("limitPayloadValue — recursion preserves under-cap structure", () => {
  it("recursively bounds children: an over-long string inside a normal object is the only thing replaced", () => {
    const value = {
      ok: "hello",
      big: "x".repeat(32 * 1024 + 1),
    };
    const result = limitPayloadValue(value) as Record<string, unknown>;
    expect(result["ok"]).toBe("hello");
    expect(result["big"]).toEqual({
      __bounded__: BOUNDED_PAYLOAD_REASONS.fieldSizeLimit,
      originalBytes: 32 * 1024 + 1,
    });
  });

  it("recursively bounds children: an over-long array inside a normal object is the only thing replaced", () => {
    const value = {
      small: [1, 2, 3],
      big: Array.from({ length: 65 }, (_, i) => i),
    };
    const result = limitPayloadValue(value) as Record<string, unknown>;
    expect(result["small"]).toEqual([1, 2, 3]);
    expect(result["big"]).toEqual({
      __bounded__: BOUNDED_PAYLOAD_REASONS.arrayLengthLimit,
      originalLength: 65,
    });
  });
});

// ---------------------------------------------------------------------------
// 260520-wcf: per-key exemption overrides (PayloadBoundsOverrides).
// Opt-in carve-outs for slots the operator has explicitly chosen to surface
// in full (e.g., cache-trace `system` / `messages` when includeSystem /
// includeMessages is true).
// ---------------------------------------------------------------------------
describe("limitPayloadValue — PayloadBoundsOverrides per-key exemption", () => {
  it("preserves an exempted string field beyond the default 32 KB cap", () => {
    const payload = {
      system: "x".repeat(50_000),
      other: "y".repeat(50_000),
    };
    const result = limitPayloadValue(payload, {
      stringFieldExempt: new Set(["system"]),
    }) as Record<string, unknown>;

    // Exempted slot — kept verbatim past the 32 KB cap.
    expect(typeof result["system"]).toBe("string");
    expect((result["system"] as string).length).toBe(50_000);

    // Non-exempted slot — capped as before.
    expect(result["other"]).toEqual({
      __bounded__: BOUNDED_PAYLOAD_REASONS.fieldSizeLimit,
      originalBytes: 50_000,
    });
  });

  it("preserves an exempted array field beyond the default 64-item cap", () => {
    const payload = {
      messages: Array.from({ length: 50_000 }, (_, i) => i),
      other: Array.from({ length: 50_000 }, (_, i) => i),
    };
    const result = limitPayloadValue(payload, {
      arrayFieldExempt: new Set(["messages"]),
    }) as Record<string, unknown>;

    // Exempted slot — kept verbatim past the array-length cap.
    expect(Array.isArray(result["messages"])).toBe(true);
    expect((result["messages"] as unknown[]).length).toBe(50_000);

    // Non-exempted slot — capped as before.
    expect(result["other"]).toEqual({
      __bounded__: BOUNDED_PAYLOAD_REASONS.arrayLengthLimit,
      originalLength: 50_000,
    });
  });

  it("applies the default 32 KB cap when no overrides argument is supplied", () => {
    // Regression lock-in: the default code path must continue to cap
    // every string, regardless of any future override-default drift.
    const payload = { system: "x".repeat(50_000) };
    const result = limitPayloadValue(payload) as Record<string, unknown>;

    expect(result["system"]).toEqual({
      __bounded__: BOUNDED_PAYLOAD_REASONS.fieldSizeLimit,
      originalBytes: 50_000,
    });
  });
});
