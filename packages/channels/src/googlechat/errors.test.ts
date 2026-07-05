// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { classifyGoogleChatError, parseRetryAfterSeconds } from "./errors.js";

describe("classifyGoogleChatError", () => {
  it("classifies an absent status (transport failure) as a network error", () => {
    const classified = classifyGoogleChatError(undefined);
    expect(classified.errorKind).toBe("network");
    expect(classified.status).toBeUndefined();
    expect(classified.hint.toLowerCase()).toContain("connectivity");
  });

  it("classifies a 401 response as an auth failure that names the grant/scope", () => {
    const classified = classifyGoogleChatError(401);
    expect(classified.errorKind).toBe("auth");
    expect(classified.status).toBe(401);
    expect(classified.hint.trim().length).toBeGreaterThan(0);
    expect(classified.hint.toLowerCase()).toContain("scope");
  });

  it("classifies a 403 response as an auth failure", () => {
    const classified = classifyGoogleChatError(403);
    expect(classified.errorKind).toBe("auth");
    expect(classified.status).toBe(403);
  });

  it("classifies a 429 response as a platform failure that surfaces the status", () => {
    const classified = classifyGoogleChatError(429);
    expect(classified.errorKind).toBe("platform");
    expect(classified.status).toBe(429);
    expect(classified.hint.trim().length).toBeGreaterThan(0);
  });

  it("classifies 500, 502 and 503 responses as platform failures", () => {
    for (const status of [500, 502, 503]) {
      const classified = classifyGoogleChatError(status);
      expect(classified.errorKind).toBe("platform");
      expect(classified.status).toBe(status);
    }
  });

  it("classifies 404/400 as a config error naming the subscription knob (not internal)", () => {
    // A 404 (subscription not found) or 400 (malformed subscription request) is
    // an operator config error, not our own internal defect — the hint must name
    // the exact knob so it is actionable at a glance.
    for (const status of [400, 404]) {
      const classified = classifyGoogleChatError(status);
      expect(classified.errorKind).toBe("config");
      expect(classified.status).toBe(status);
      expect(classified.hint).toContain("channels.googlechat.subscriptionName");
    }
  });

  it("classifies a genuinely unexpected 4xx status as an internal error", () => {
    for (const status of [405, 409]) {
      const classified = classifyGoogleChatError(status);
      expect(classified.errorKind).toBe("internal");
      expect(classified.status).toBe(status);
    }
  });

  it("returns an operator-actionable hint that never echoes a secret-bearing cause", () => {
    const classified = classifyGoogleChatError(401, new Error("token=SECRET"));
    expect(classified.hint.trim().length).toBeGreaterThan(0);
    expect(classified.hint).not.toContain("SECRET");
  });
});

describe("classifyGoogleChatError retry disposition", () => {
  it("marks a transport failure (no status) retryable — a resend is safe to attempt", () => {
    expect(classifyGoogleChatError(undefined).retryable).toBe(true);
  });

  it("marks 401/403 auth failures non-retryable — the grant must be fixed first", () => {
    expect(classifyGoogleChatError(401).retryable).toBe(false);
    expect(classifyGoogleChatError(403).retryable).toBe(false);
  });

  it("marks a 429 rate limit retryable — the request was rejected before it landed", () => {
    expect(classifyGoogleChatError(429).retryable).toBe(true);
  });

  it("marks 5xx upstream errors retryable", () => {
    for (const status of [500, 502, 503]) {
      expect(classifyGoogleChatError(status).retryable).toBe(true);
    }
  });

  it("marks 400/404 config errors non-retryable — an operator must fix the config", () => {
    expect(classifyGoogleChatError(400).retryable).toBe(false);
    expect(classifyGoogleChatError(404).retryable).toBe(false);
  });

  it("marks a genuinely unexpected status non-retryable", () => {
    for (const status of [405, 409]) {
      expect(classifyGoogleChatError(status).retryable).toBe(false);
    }
  });
});

describe("parseRetryAfterSeconds", () => {
  /** Build a minimal response whose header accessor returns a fixed value. */
  const withRetryAfter = (value: string | null) => ({
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === "retry-after" ? value : null,
    },
  });

  it("reads a bare non-negative integer as a second count", () => {
    expect(parseRetryAfterSeconds(withRetryAfter("12"))).toBe(12);
    expect(parseRetryAfterSeconds(withRetryAfter("0"))).toBe(0);
  });

  it("returns undefined when the header is absent", () => {
    expect(parseRetryAfterSeconds(withRetryAfter(null))).toBeUndefined();
  });

  it("returns undefined for a non-numeric, non-date value", () => {
    expect(parseRetryAfterSeconds(withRetryAfter("garbage"))).toBeUndefined();
  });

  it("rejects a negative second count rather than awaiting a bogus delay", () => {
    expect(parseRetryAfterSeconds(withRetryAfter("-5"))).toBeUndefined();
  });

  it("returns undefined when the response exposes no headers accessor", () => {
    expect(parseRetryAfterSeconds({})).toBeUndefined();
    expect(parseRetryAfterSeconds({ headers: {} })).toBeUndefined();
  });

  it("resolves a future HTTP-date to whole seconds from the injected reference clock", () => {
    const nowMs = 1_000_000;
    const future = new Date(nowMs + 30_000).toUTCString();
    expect(parseRetryAfterSeconds(withRetryAfter(future), nowMs)).toBe(30);
  });

  it("clamps a past HTTP-date to zero (never a negative delay)", () => {
    const nowMs = 1_000_000;
    const past = new Date(nowMs - 30_000).toUTCString();
    expect(parseRetryAfterSeconds(withRetryAfter(past), nowMs)).toBe(0);
  });

  it("returns undefined for an HTTP-date when no reference clock is supplied", () => {
    // The pure module never reads an ambient clock; a date delay needs an
    // explicit reference, so without one the caller falls back to bounded backoff.
    const future = new Date(2_000_000).toUTCString();
    expect(parseRetryAfterSeconds(withRetryAfter(future))).toBeUndefined();
  });
});
