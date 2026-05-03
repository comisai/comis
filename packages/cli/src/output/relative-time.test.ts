// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { formatRelativeExpiry } from "./relative-time.js";

const NOW = 1_700_000_000_000;

describe("formatRelativeExpiry (Phase 8 D-16)", () => {
  it.each([
    { name: "expired (delta = 0)", expiresAt: NOW, expected: "expired" },
    { name: "expired (negative delta)", expiresAt: NOW - 60_000, expected: "expired" },
    { name: "5 minutes", expiresAt: NOW + 5 * 60_000, expected: "5m" },
    { name: "32 minutes", expiresAt: NOW + 32 * 60_000, expected: "32m" },
    { name: "59 minutes (just under 1h)", expiresAt: NOW + 59 * 60_000, expected: "59m" },
    { name: "1 hour", expiresAt: NOW + 60 * 60_000, expected: "1h" },
    { name: "23 hours", expiresAt: NOW + 23 * 3_600_000, expected: "23h" },
    { name: "1 day", expiresAt: NOW + 24 * 3_600_000, expected: "1d" },
    { name: "27 days", expiresAt: NOW + 27 * 24 * 3_600_000, expected: "27d" },
  ])("$name → $expected", ({ expiresAt, expected }) => {
    expect(formatRelativeExpiry(expiresAt, NOW)).toBe(expected);
  });
});
