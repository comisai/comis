// SPDX-License-Identifier: Apache-2.0
/**
 * `redactIdentifier` — sha256-prefixed opaque-id helper tests.
 *
 * Behavior:
 *   - Returns `"sha256:<hex>"` with default 12 hex chars
 *   - Custom hex char count via second arg
 *   - Deterministic (same input → same output)
 *   - Different inputs → different outputs
 *   - Hex digest matches Node's `crypto.createHash("sha256")` prefix
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { redactIdentifier } from "./redact-identifier.js";

describe("redactIdentifier — sha256-prefix opaque-id helper", () => {
  it("returns 'sha256:' prefix with default 12 hex chars (16 total chars after colon prefix)", () => {
    const out = redactIdentifier("comis-session-abcd1234");
    expect(out.startsWith("sha256:")).toBe(true);
    const hex = out.slice("sha256:".length);
    expect(hex).toHaveLength(12);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it("matches the leading hex chars of Node's crypto.createHash('sha256') digest", () => {
    const input = "deterministic-input-1";
    const out = redactIdentifier(input);
    const expectedFull = createHash("sha256").update(input).digest("hex");
    const hex = out.slice("sha256:".length);
    expect(hex).toBe(expectedFull.slice(0, 12));
  });

  it("honors a custom hex-char count passed as the second argument", () => {
    const out = redactIdentifier("custom-hex-count", 20);
    const hex = out.slice("sha256:".length);
    expect(hex).toHaveLength(20);
  });

  it("supports a 64-hex-char request (full sha256 hex digest length)", () => {
    const out = redactIdentifier("full-digest", 64);
    const hex = out.slice("sha256:".length);
    expect(hex).toHaveLength(64);
    expect(hex).toBe(createHash("sha256").update("full-digest").digest("hex"));
  });

  it("returns identical output for identical input (deterministic)", () => {
    expect(redactIdentifier("same")).toBe(redactIdentifier("same"));
  });

  it("returns different output for different input", () => {
    expect(redactIdentifier("a")).not.toBe(redactIdentifier("b"));
  });

  it("handles the empty string deterministically", () => {
    const out = redactIdentifier("");
    const hex = out.slice("sha256:".length);
    expect(hex).toBe(createHash("sha256").update("").digest("hex").slice(0, 12));
  });
});
