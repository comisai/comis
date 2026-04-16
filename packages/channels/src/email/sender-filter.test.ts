/**
 * Tests for email sender filtering and automated sender detection.
 *
 * Verifies allowlist/open mode gating and automated sender detection
 * via RFC 3834 headers and noreply address patterns.
 */
import { describe, it, expect } from "vitest";
import { isAllowedSender, isAutomatedSender } from "./sender-filter.js";

// ---------------------------------------------------------------------------
// isAllowedSender
// ---------------------------------------------------------------------------

describe("isAllowedSender", () => {
  it("blocks all senders when allowFrom is empty and allowMode is allowlist", () => {
    expect(isAllowedSender("user@example.com", [], "allowlist")).toBe(false);
  });

  it("allows sender when in allowFrom list", () => {
    expect(isAllowedSender("user@example.com", ["user@example.com"], "allowlist")).toBe(true);
  });

  it("allows any sender when allowMode is open", () => {
    expect(isAllowedSender("anyone@example.com", [], "open")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isAllowedSender("User@Example.com", ["user@example.com"], "allowlist")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAutomatedSender
// ---------------------------------------------------------------------------

describe("isAutomatedSender", () => {
  it("detects Auto-Submitted: auto-replied", () => {
    expect(isAutomatedSender({ "auto-submitted": "auto-replied" }, "user@example.com")).toBe(true);
  });

  it("allows Auto-Submitted: no", () => {
    expect(isAutomatedSender({ "auto-submitted": "no" }, "user@example.com")).toBe(false);
  });

  it("detects Precedence: bulk", () => {
    expect(isAutomatedSender({ precedence: "bulk" }, "user@example.com")).toBe(true);
  });

  it("detects List-Unsubscribe header", () => {
    expect(isAutomatedSender({ "list-unsubscribe": "<mailto:unsub@example.com>" }, "user@example.com")).toBe(true);
  });

  it("detects X-Auto-Response-Suppress header", () => {
    expect(isAutomatedSender({ "x-auto-response-suppress": "All" }, "user@example.com")).toBe(true);
  });

  it("detects noreply@example.com", () => {
    expect(isAutomatedSender({}, "noreply@example.com")).toBe(true);
  });

  it("detects no-reply@example.com", () => {
    expect(isAutomatedSender({}, "no-reply@example.com")).toBe(true);
  });

  it("detects mailer-daemon@example.com", () => {
    expect(isAutomatedSender({}, "mailer-daemon@example.com")).toBe(true);
  });

  it("returns false for normal sender with no automation headers", () => {
    expect(isAutomatedSender({}, "human@example.com")).toBe(false);
  });
});
