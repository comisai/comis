// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { classifyMsTeamsError } from "../errors.js";

describe("classifyMsTeamsError", () => {
  it("classifies a 401 response as a non-retryable auth failure", () => {
    const classified = classifyMsTeamsError(401);
    expect(classified.errorKind).toBe("auth");
    expect(classified.retryable).toBe(false);
    expect(classified.status).toBe(401);
    expect(classified.hint.trim().length).toBeGreaterThan(0);
  });

  it("classifies a 403 response as a non-retryable auth failure", () => {
    const classified = classifyMsTeamsError(403);
    expect(classified.errorKind).toBe("auth");
    expect(classified.retryable).toBe(false);
    expect(classified.status).toBe(403);
  });

  it("classifies a 429 response as a retryable platform failure", () => {
    const classified = classifyMsTeamsError(429);
    expect(classified.errorKind).toBe("platform");
    expect(classified.retryable).toBe(true);
  });

  it("exposes the numeric 429 status the bounded send retry keys its Retry-After branch on", () => {
    // The send retry executor delays on Retry-After only when status === 429, so
    // the classification must surface the status alongside the retry disposition.
    const classified = classifyMsTeamsError(429);
    expect(classified.status).toBe(429);
    expect(classified.retryable).toBe(true);
  });

  it("marks a status-less transport fault retryable on the transience axis (send retry gates separately on status presence)", () => {
    // The classifier's `retryable` is a TRANSIENCE verdict; the send executor
    // gates on `status !== undefined` for SEND SAFETY — a fault with no status may
    // already have landed, so it is never resent despite being transient.
    const classified = classifyMsTeamsError(undefined, new Error("ECONNRESET"));
    expect(classified.retryable).toBe(true);
    expect(classified.status).toBeUndefined();
  });

  it("classifies 500, 502 and 503 responses as retryable platform failures", () => {
    for (const status of [500, 502, 503]) {
      const classified = classifyMsTeamsError(status);
      expect(classified.errorKind).toBe("platform");
      expect(classified.retryable).toBe(true);
      expect(classified.status).toBe(status);
    }
  });

  it("classifies an absent status (transport failure) as a retryable network error", () => {
    const classified = classifyMsTeamsError(undefined);
    expect(classified.errorKind).toBe("network");
    expect(classified.retryable).toBe(true);
    expect(classified.status).toBeUndefined();
  });

  it("classifies an unexpected 4xx status as a non-retryable internal error", () => {
    const classified = classifyMsTeamsError(400);
    expect(classified.errorKind).toBe("internal");
    expect(classified.retryable).toBe(false);
  });

  it("returns an operator-actionable hint that never echoes a secret-bearing cause", () => {
    const classified = classifyMsTeamsError(401, new Error("client_secret=super-secret-pw"));
    expect(classified.hint.trim().length).toBeGreaterThan(0);
    expect(classified.hint).not.toContain("super-secret-pw");
  });
});
