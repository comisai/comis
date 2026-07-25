// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createApprovalHmac, snapshotApprovalParams } from "./approval-fingerprint.js";

describe("approval parameter snapshots", () => {
  it("copies and freezes every nested JSON value", () => {
    const input = { nested: { values: [1, 2] } };
    const snapshot = snapshotApprovalParams(input);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    input.nested.values.push(3);
    expect(snapshot.value.value).toEqual({ nested: { values: [1, 2] } });
    expect(Object.isFrozen(snapshot.value.value)).toBe(true);
    expect(Object.isFrozen(snapshot.value.value.nested)).toBe(true);
    expect(Object.isFrozen((snapshot.value.value.nested as { values: number[] }).values)).toBe(true);
  });

  it("uses the key and domain when producing an opaque digest", () => {
    const first = createApprovalHmac("key-a", "operation", '{"enabled":false}');
    const second = createApprovalHmac("key-b", "operation", '{"enabled":false}');
    const cache = createApprovalHmac("key-a", "cache", '{"enabled":false}');

    expect(first.ok && second.ok && cache.ok).toBe(true);
    if (!first.ok || !second.ok || !cache.ok) return;
    expect(first.value).not.toBe(second.value);
    expect(first.value).not.toBe(cache.value);
  });
});
