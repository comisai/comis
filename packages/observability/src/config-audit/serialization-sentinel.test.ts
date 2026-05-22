// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { emitSerializationErrorSentinel } from "./serialization-sentinel.js";

describe("emitSerializationErrorSentinel", () => {
  it("returns a newline-terminated string", () => {
    const out = emitSerializationErrorSentinel();
    expect(typeof out).toBe("string");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("parses to the canonical sentinel shape", () => {
    const out = emitSerializationErrorSentinel();
    const parsed = JSON.parse(out.replace(/\n$/, "")) as Record<string, unknown>;
    expect(parsed.traceSchema).toBe("comis-config-audit");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.__serializationError).toBe("record-not-serializable");
    expect(typeof parsed.ts).toBe("string");
  });

  it("produces an ISO-8601 ts string", () => {
    const out = emitSerializationErrorSentinel();
    const parsed = JSON.parse(out.replace(/\n$/, "")) as Record<string, unknown>;
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
