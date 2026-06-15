// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { VIDEO_ERR_TO_LOG, VideoGenError } from "./video-error.js";
import type { VideoErrorKind } from "./video-error.js";

/**
 * The video domain error union (VideoErrorKind) is SEPARATE from the closed
 * 10-member log ErrorKind union. VIDEO_ERR_TO_LOG is the only bridge: every
 * domain kind maps onto exactly one closed log ErrorKind at log time.
 *
 * DIVERGENCE 2 from the image union: video adds `job_timeout` (the bounded-poll
 * deadline of VPORT-02) and (WR-02, Phase 192) `delivery_failed` (a render that
 * succeeded but whose off-turn channel delivery exhausted its retries) — each
 * mapped onto an existing closed log ErrorKind. The closed log ErrorKind is NEVER
 * extended.
 */

// The 8 video error kinds, as a literal array (exhaustiveness driver).
const ALL_VIDEO_ERROR_KINDS: readonly VideoErrorKind[] = [
  "content_blocked",
  "auth_required",
  "quota_exceeded",
  "timeout",
  "job_timeout",
  "unsupported_provider",
  "empty_response",
  "delivery_failed",
];

// The closed 10-member log ErrorKind union (log-fields.ts) as a literal set.
const CLOSED_LOG_ERROR_KINDS = new Set<string>([
  "config",
  "network",
  "auth",
  "validation",
  "precondition",
  "timeout",
  "resource",
  "dependency",
  "internal",
  "platform",
]);

describe("VIDEO_ERR_TO_LOG", () => {
  it("has exactly 8 members including the video-only job_timeout + delivery_failed (DIVERGENCE 2 / WR-02)", () => {
    expect(ALL_VIDEO_ERROR_KINDS).toHaveLength(8);
    expect(ALL_VIDEO_ERROR_KINDS).toContain("job_timeout");
    expect(ALL_VIDEO_ERROR_KINDS).toContain("delivery_failed");
  });

  it("contains a mapping for every member of the VideoErrorKind union", () => {
    for (const kind of ALL_VIDEO_ERROR_KINDS) {
      expect(VIDEO_ERR_TO_LOG[kind]).toBeDefined();
    }
    // No extra keys beyond the 8 domain kinds.
    expect(Object.keys(VIDEO_ERR_TO_LOG).sort()).toEqual([...ALL_VIDEO_ERROR_KINDS].sort());
  });

  it("maps delivery_failed onto the closed log platform kind (WR-02 — a channel/transport failure, not a provider dependency)", () => {
    expect(VIDEO_ERR_TO_LOG.delivery_failed).toBe("platform");
  });

  it("maps every value onto one of the closed log ErrorKind literals", () => {
    for (const logKind of Object.values(VIDEO_ERR_TO_LOG)) {
      expect(CLOSED_LOG_ERROR_KINDS.has(logKind)).toBe(true);
    }
  });

  it("maps both job_timeout and timeout onto the closed log timeout (DIVERGENCE 2)", () => {
    expect(VIDEO_ERR_TO_LOG.job_timeout).toBe("timeout");
    expect(VIDEO_ERR_TO_LOG.timeout).toBe("timeout");
  });

  it("pins the load-bearing mappings RES-03 / SEC-02 rely on", () => {
    expect(VIDEO_ERR_TO_LOG.unsupported_provider).toBe("precondition");
    expect(VIDEO_ERR_TO_LOG.auth_required).toBe("auth");
    expect(VIDEO_ERR_TO_LOG.quota_exceeded).toBe("resource");
  });
});

describe("VideoGenError", () => {
  it("carries the domain videoErrorKind and operator hint on the constructed error", () => {
    const err = new VideoGenError("Video generation is not authenticated.", {
      videoErrorKind: "auth_required",
      hint: "Provide FAL_KEY via the same secret store the main provider uses.",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("VideoGenError");
    expect(err.videoErrorKind).toBe("auth_required");
    expect(err.hint).toContain("FAL_KEY");
    expect(err.message).toBe("Video generation is not authenticated.");
  });

  it("supports the job_timeout kind that Plan 03's bounded-poll loop surfaces", () => {
    const err = new VideoGenError("Render exceeded the poll deadline.", {
      videoErrorKind: "job_timeout",
      hint: "Increase integrations.media.videoGeneration.timeoutMs or retry.",
    });
    expect(err.videoErrorKind).toBe("job_timeout");
  });
});
