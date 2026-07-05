// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { classifyMatrixError } from "../errors.js";

describe("classifyMatrixError", () => {
  it("classifies M_UNKNOWN_TOKEN as a non-retryable auth failure the token-expiry recovery branch keys on", () => {
    const classified = classifyMatrixError({ errcode: "M_UNKNOWN_TOKEN" });
    expect(classified.errorKind).toBe("auth");
    expect(classified.retryable).toBe(false);
    expect(classified.hint.trim().length).toBeGreaterThan(0);
  });

  it("names the exact config knob in the M_UNKNOWN_TOKEN hint", () => {
    // The recovery step is to replace the credential, so the hint must name it.
    const classified = classifyMatrixError({ errcode: "M_UNKNOWN_TOKEN" });
    expect(classified.hint).toContain("channels.matrix.accessToken");
  });

  it("classifies the M_LIMIT_EXCEEDED errcode as a retryable platform failure with a backoff hint", () => {
    const classified = classifyMatrixError({ errcode: "M_LIMIT_EXCEEDED" });
    expect(classified.errorKind).toBe("platform");
    expect(classified.retryable).toBe(true);
    expect(classified.hint.trim().length).toBeGreaterThan(0);
    expect(classified.hint).toMatch(/back ?off|retry/i);
  });

  it("classifies a 429 status as a retryable platform failure and surfaces the 429 the backoff branch keys on", () => {
    // The bounded send/backoff branch delays on the retry-after window only when
    // status === 429, so the classification must surface the status too.
    const classified = classifyMatrixError({ status: 429 });
    expect(classified.errorKind).toBe("platform");
    expect(classified.retryable).toBe(true);
    expect(classified.status).toBe(429);
  });

  it("classifies the M_FORBIDDEN errcode as a non-retryable auth failure", () => {
    const classified = classifyMatrixError({ errcode: "M_FORBIDDEN" });
    expect(classified.errorKind).toBe("auth");
    expect(classified.retryable).toBe(false);
    expect(classified.hint.trim().length).toBeGreaterThan(0);
  });

  it("classifies a bare 403 status as a non-retryable auth failure and echoes the status", () => {
    const classified = classifyMatrixError({ status: 403 });
    expect(classified.errorKind).toBe("auth");
    expect(classified.retryable).toBe(false);
    expect(classified.status).toBe(403);
  });

  it("classifies 500, 502 and 503 homeserver responses as retryable platform failures", () => {
    for (const status of [500, 502, 503]) {
      const classified = classifyMatrixError({ status });
      expect(classified.errorKind).toBe("platform");
      expect(classified.retryable).toBe(true);
      expect(classified.status).toBe(status);
    }
  });

  it("classifies an absent errcode and status as a non-retryable internal error", () => {
    const classified = classifyMatrixError({});
    expect(classified.errorKind).toBe("internal");
    expect(classified.retryable).toBe(false);
    expect(classified.hint.trim().length).toBeGreaterThan(0);
  });

  it("evaluates the string errcode arm before the HTTP status (a token error wins over a co-reported 5xx)", () => {
    const classified = classifyMatrixError({ errcode: "M_UNKNOWN_TOKEN", status: 500 });
    expect(classified.errorKind).toBe("auth");
    expect(classified.retryable).toBe(false);
  });

  it("returns an operator-actionable hint that never echoes a secret-bearing cause", () => {
    const classified = classifyMatrixError({
      errcode: "M_UNKNOWN_TOKEN",
      cause: new Error("access_token=super-secret-tok"),
    });
    expect(classified.hint.trim().length).toBeGreaterThan(0);
    expect(classified.hint).not.toContain("super-secret-tok");
  });
});
