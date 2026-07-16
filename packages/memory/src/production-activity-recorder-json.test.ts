// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  serializeActivityPayload,
  validateActivityJsonGraph,
} from "./production-activity-recorder-json.js";

describe("production activity recorder JSON bounds", () => {
  it("rejects cycles and aggregate payloads beyond the configured byte cap", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateActivityJsonGraph(cyclic, 100).ok).toBe(false);
    const oversized = serializeActivityPayload({ first: "x".repeat(60), second: "y".repeat(60) }, 100);
    expect(!oversized.ok && oversized.error.reason).toBe("payload_too_large");
  });

  it("serializes bounded plain JSON without changing its field values", () => {
    const serialized = serializeActivityPayload({ message: "hello", count: 2 }, 100);
    expect(serialized.ok && JSON.parse(serialized.value)).toEqual({ message: "hello", count: 2 });
  });
});
