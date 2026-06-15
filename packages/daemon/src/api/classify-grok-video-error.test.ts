// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for classifyGrokVideoError (GROK error classification — GROK-02).
 *
 * Unlike FAL (which has NO "failed" status — failure is a THROW) and like Veo,
 * the xAI Grok status union ALSO carries a terminal `failed`/`expired` status
 * (190-RESEARCH §Pattern 2 + Pitfall 3). The classifier therefore takes an
 * `opts.status` ("failed" | "expired") in addition to the FAL/Veo `emptyResult`:
 *   - `status:"expired"` (render expired before download) → empty_response with
 *     an "expired" hint, UNLESS an error payload substring-matches auth/quota/
 *     content (then that wins).
 *   - `status:"failed"` → classified by the `error` payload substring (a
 *     moderation `failed` → content_blocked; a generic `failed` → empty_response).
 *
 * The Grok `error` is a `{ code?, message? }` object (NOT an Error) — the
 * classifier stringifies it for matching. The auth branch MUST emit a FIXED
 * `XAI_API_KEY`/SuperGrok hint and NEVER echo the input message (a credential or
 * a fake `Bearer xai-…` embedded in the provider error must not round-trip into
 * the hint — the SEC test pins this). Every returned `videoErrorKind` must be one
 * of the closed 7-member `VideoErrorKind` union.
 * @module
 */
import { describe, it, expect } from "vitest";
import { classifyGrokVideoError } from "./classify-grok-video-error.js";

const KINDS = new Set([
  "content_blocked",
  "auth_required",
  "quota_exceeded",
  "timeout",
  "job_timeout",
  "unsupported_provider",
  "empty_response",
]);

describe("classifyGrokVideoError", () => {
  it("classifies a 401/unauthorized error as auth_required with a FIXED XAI_API_KEY hint", () => {
    const r = classifyGrokVideoError({ code: "unauthorized", message: "401 Unauthorized" });
    expect(r.videoErrorKind).toBe("auth_required");
    expect(r.hint).toContain("XAI_API_KEY");
    // The fixed hint never echoes the raw provider message text.
    expect(r.hint).not.toContain("401 Unauthorized");
  });

  it("classifies forbidden/api key/invalid key/authentication messages as auth_required", () => {
    for (const msg of [
      "403 forbidden",
      "invalid api key",
      "the api_key was rejected",
      "invalid key supplied",
      "authentication failed",
    ]) {
      const r = classifyGrokVideoError({ message: msg });
      expect(r.videoErrorKind).toBe("auth_required");
      expect(r.hint).toContain("XAI_API_KEY");
    }
  });

  it("classifies moderation/safety/content-policy/blocked/nsfw/rejected messages as content_blocked", () => {
    for (const msg of [
      "blocked by moderation",
      "safety filter triggered",
      "content policy violation",
      "content_policy: not allowed",
      "this prompt was blocked",
      "nsfw content detected",
      "rejected by policy",
    ]) {
      const r = classifyGrokVideoError({ message: msg });
      expect(r.videoErrorKind).toBe("content_blocked");
    }
  });

  it("classifies quota/rate-limit/429/insufficient-credits/billing messages as quota_exceeded", () => {
    for (const msg of [
      "quota exceeded",
      "rate limit reached",
      "rate_limit hit",
      "HTTP 429 too many requests",
      "insufficient credits",
      "billing issue: add a card",
    ]) {
      const r = classifyGrokVideoError({ message: msg });
      expect(r.videoErrorKind).toBe("quota_exceeded");
    }
  });

  it("GROK-02 expired: status:'expired' with no error payload → empty_response with an expired hint", () => {
    const r = classifyGrokVideoError(undefined, { status: "expired" });
    expect(r.videoErrorKind).toBe("empty_response");
    expect(r.hint.toLowerCase()).toContain("expired");
  });

  it("GROK-02 failed (moderation message) → content_blocked via the error substring", () => {
    const r = classifyGrokVideoError(
      { code: "x", message: "render failed: blocked by moderation" },
      { status: "failed" },
    );
    expect(r.videoErrorKind).toBe("content_blocked");
  });

  it("GROK-02 failed (generic message) → empty_response", () => {
    const r = classifyGrokVideoError({ code: "x", message: "render failed" }, { status: "failed" });
    expect(r.videoErrorKind).toBe("empty_response");
  });

  it("GROK-02 expired but the error payload matches auth → auth_required still wins", () => {
    // expired-with-an-auth-error: the substring classification takes precedence
    // over the bare expired→empty_response default.
    const r = classifyGrokVideoError({ message: "401 unauthorized" }, { status: "expired" });
    expect(r.videoErrorKind).toBe("auth_required");
    expect(r.hint).toContain("XAI_API_KEY");
  });

  it("returns empty_response for the emptyResult flag (done-but-no-video.url)", () => {
    const r = classifyGrokVideoError(null, { emptyResult: true });
    expect(r.videoErrorKind).toBe("empty_response");
    expect(r.hint.length).toBeGreaterThan(0);
  });

  it("returns empty_response for a generic 5xx/transport string and may include the (credential-free) message", () => {
    const r = classifyGrokVideoError({ message: "HTTP 503 service unavailable" });
    expect(r.videoErrorKind).toBe("empty_response");
    expect(r.hint).toContain("503");
  });

  it("stringifies a plain-object error ({ code, message }) for matching", () => {
    const r = classifyGrokVideoError({ code: "PERMISSION_DENIED", message: "forbidden" });
    expect(r.videoErrorKind).toBe("auth_required");
  });

  it("SEC: an embedded fake bearer in the auth error is ABSENT from the returned hint", () => {
    const r = classifyGrokVideoError({ message: "401: Bearer xai-SECRET" });
    expect(r.videoErrorKind).toBe("auth_required");
    expect(r.hint).not.toContain("xai-SECRET");
  });

  it("only ever returns a member of the closed VideoErrorKind union", () => {
    const samples = [
      classifyGrokVideoError({ message: "401" }),
      classifyGrokVideoError({ message: "safety" }),
      classifyGrokVideoError({ message: "quota" }),
      classifyGrokVideoError({ message: "boom 500" }),
      classifyGrokVideoError(null, { emptyResult: true }),
      classifyGrokVideoError(undefined, { status: "expired" }),
      classifyGrokVideoError({ message: "render failed" }, { status: "failed" }),
    ];
    for (const s of samples) expect(KINDS.has(s.videoErrorKind)).toBe(true);
  });
});
