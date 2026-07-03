// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the FAL video error classifier.
 *
 * The FAL queue status union has NO "FAILED" member (only IN_QUEUE / IN_PROGRESS
 * / COMPLETED) — failures surface as THROWN errors from queue.status()/result(),
 * or as a COMPLETED-with-no-video.url. This mapper turns either into a typed
 * `{ videoErrorKind, hint }`. Every branch carries a non-empty operator hint;
 * the raw provider message is inspected ONLY for classification (never a secret
 * leak — the adapter never logs it).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { classifyFalVideoError } from "./classify-fal-video-error.js";

describe("classifyFalVideoError", () => {
  it("maps the COMPLETED-with-no-video.url case to empty_response (emptyResult flag)", () => {
    const c = classifyFalVideoError(new Error("ignored when emptyResult is set"), {
      emptyResult: true,
    });
    expect(c.videoErrorKind).toBe("empty_response");
    expect(c.hint.length).toBeGreaterThan(0);
  });

  it("maps a thrown 401/unauthorized/credentials error to auth_required", () => {
    for (const msg of [
      "Request failed with status 401",
      "Unauthorized",
      "invalid credentials supplied",
    ]) {
      const c = classifyFalVideoError(new Error(msg));
      expect(c.videoErrorKind).toBe("auth_required");
      expect(c.hint).toMatch(/FAL_KEY/);
    }
  });

  it("maps a thrown moderation/safety/content-policy/blocked error to content_blocked", () => {
    for (const msg of [
      "request rejected by moderation",
      "safety system blocked the prompt",
      "violates content policy",
      "prompt was blocked",
    ]) {
      const c = classifyFalVideoError(new Error(msg));
      expect(c.videoErrorKind).toBe("content_blocked");
      expect(c.hint.length).toBeGreaterThan(0);
    }
  });

  it("falls back to empty_response (generic dependency failure) for an unrecognized error", () => {
    const c = classifyFalVideoError(new Error("503 upstream unavailable"));
    expect(c.videoErrorKind).toBe("empty_response");
    expect(c.hint).toMatch(/503 upstream unavailable/);
  });

  it("handles a non-Error thrown value (string) without crashing", () => {
    const c = classifyFalVideoError("plain string failure");
    expect(c.videoErrorKind).toBe("empty_response");
    expect(c.hint).toMatch(/plain string failure/);
  });

  it("never includes the literal API key in the hint (no-secret)", () => {
    // A raw provider error must never round-trip a credential into the hint; the
    // classifier only ever echoes the (classification-scanned) message text, and
    // for auth_required it returns a fixed FAL_KEY hint, not the message.
    const c = classifyFalVideoError(new Error("401 unauthorized: key=sk-secret-123"));
    expect(c.videoErrorKind).toBe("auth_required");
    expect(c.hint).not.toMatch(/sk-secret-123/);
  });
});
