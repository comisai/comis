// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { classifyGoogleChatError } from "./errors.js";

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

  it("classifies an unexpected 4xx status as an internal error", () => {
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
