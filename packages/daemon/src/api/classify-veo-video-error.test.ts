// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for classifyVeoVideoError (VEO error classification).
 *
 * The Veo `operation.error` is a `Record<string,unknown>` (NOT an Error) — the
 * classifier must stringify it for substring matching. The auth branch MUST emit
 * a FIXED `GOOGLE_API_KEY` hint and NEVER echo the input message (a credential
 * embedded in the provider error must not round-trip into the hint — the SEC test
 * pins this). Every returned `videoErrorKind` must be one of the closed 7-member
 * `VideoErrorKind` union.
 * @module
 */
import { describe, it, expect } from "vitest";
import { classifyVeoVideoError } from "./classify-veo-video-error.js";

const KINDS = new Set([
  "content_blocked",
  "auth_required",
  "quota_exceeded",
  "timeout",
  "job_timeout",
  "unsupported_provider",
  "empty_response",
]);

describe("classifyVeoVideoError", () => {
  it("classifies a 401/unauthorized error as auth_required with a FIXED GOOGLE_API_KEY hint", () => {
    const r = classifyVeoVideoError({ code: 401, message: "401 Unauthorized" });
    expect(r.videoErrorKind).toBe("auth_required");
    expect(r.hint).toContain("GOOGLE_API_KEY");
    // The fixed hint never echoes the raw provider message text.
    expect(r.hint).not.toContain("401 Unauthorized");
  });

  it("classifies forbidden/permission/api key/credentials messages as auth_required", () => {
    for (const msg of [
      "403 forbidden",
      "permission denied on resource",
      "invalid api key",
      "the credentials were rejected",
    ]) {
      const r = classifyVeoVideoError(new Error(msg));
      expect(r.videoErrorKind).toBe("auth_required");
      expect(r.hint).toContain("GOOGLE_API_KEY");
    }
  });

  it("classifies moderation/safety/responsible-AI messages as content_blocked", () => {
    for (const msg of [
      "blocked by safety filter",
      "content policy violation",
      "this prompt was blocked",
      "nsfw content detected",
      "responsible AI policy rejected the prompt",
      "rai filtered the output",
    ]) {
      const r = classifyVeoVideoError(new Error(msg));
      expect(r.videoErrorKind).toBe("content_blocked");
    }
  });

  it("returns empty_response for the emptyResult flag (done-but-no-generatedVideos)", () => {
    const r = classifyVeoVideoError(new Error("anything"), { emptyResult: true });
    expect(r.videoErrorKind).toBe("empty_response");
    expect(r.hint.length).toBeGreaterThan(0);
  });

  it("classifies quota/rate-limit/429/resource-exhausted messages as quota_exceeded", () => {
    for (const msg of [
      "quota exceeded for this project",
      "rate limit reached",
      "HTTP 429 too many requests",
      "resource exhausted",
    ]) {
      const r = classifyVeoVideoError(new Error(msg));
      expect(r.videoErrorKind).toBe("quota_exceeded");
    }
  });

  it("returns empty_response for a generic 5xx/transport string and may include the (credential-free) message", () => {
    const r = classifyVeoVideoError(new Error("HTTP 503 service unavailable"));
    expect(r.videoErrorKind).toBe("empty_response");
    expect(r.hint).toContain("503");
  });

  it("stringifies a plain-object operation.error (Record<string,unknown>) for matching", () => {
    // The Veo operation.error is a Record, not an Error — JSON.stringify path.
    const r = classifyVeoVideoError({ code: 7, status: "PERMISSION_DENIED", message: "permission denied" });
    expect(r.videoErrorKind).toBe("auth_required");
  });

  it("SEC: an embedded fake key in the auth error is ABSENT from the returned hint", () => {
    const r = classifyVeoVideoError(new Error("401 Unauthorized: key=AIzaSECRET123"));
    expect(r.videoErrorKind).toBe("auth_required");
    expect(r.hint).not.toContain("AIzaSECRET123");
  });

  it("only ever returns a member of the closed VideoErrorKind union", () => {
    const samples = [
      classifyVeoVideoError(new Error("401")),
      classifyVeoVideoError(new Error("safety")),
      classifyVeoVideoError(new Error("quota")),
      classifyVeoVideoError(new Error("boom 500")),
      classifyVeoVideoError(null, { emptyResult: true }),
      classifyVeoVideoError({ message: "permission" }),
    ];
    for (const s of samples) expect(KINDS.has(s.videoErrorKind)).toBe(true);
  });
});
