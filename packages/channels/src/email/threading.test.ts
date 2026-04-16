/**
 * Tests for RFC 5322 threading header management.
 * @module
 */

import { describe, it, expect } from "vitest";
import { buildThreadingHeaders, extractThreadId } from "./threading.js";

describe("buildThreadingHeaders", () => {
  it("returns empty inReplyTo and empty references when no prior messageId", () => {
    const result = buildThreadingHeaders({});
    expect(result.inReplyTo).toBeUndefined();
    expect(result.references).toEqual([]);
  });

  it("returns inReplyTo and references with single entry when inReplyTo provided", () => {
    const result = buildThreadingHeaders({ inReplyTo: "<msg-1@example.com>" });
    expect(result.inReplyTo).toBe("<msg-1@example.com>");
    expect(result.references).toEqual(["<msg-1@example.com>"]);
  });

  it("appends inReplyTo to existing references array", () => {
    const result = buildThreadingHeaders({
      inReplyTo: "<msg-3@example.com>",
      existingReferences: ["<msg-1@example.com>", "<msg-2@example.com>"],
    });
    expect(result.inReplyTo).toBe("<msg-3@example.com>");
    expect(result.references).toEqual([
      "<msg-1@example.com>",
      "<msg-2@example.com>",
      "<msg-3@example.com>",
    ]);
  });
});

describe("extractThreadId", () => {
  it("returns emailMessageId from metadata", () => {
    const result = extractThreadId({ emailMessageId: "<msg-1@example.com>" });
    expect(result).toBe("<msg-1@example.com>");
  });

  it("returns undefined when emailMessageId not present", () => {
    const result = extractThreadId({ otherField: "value" });
    expect(result).toBeUndefined();
  });

  it("returns undefined for non-string emailMessageId", () => {
    const result = extractThreadId({ emailMessageId: 42 });
    expect(result).toBeUndefined();
  });
});
