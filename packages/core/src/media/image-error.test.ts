// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { IMAGE_ERR_TO_LOG } from "./image-error.js";
import type { ImageErrorKind } from "./image-error.js";

/**
 * The image domain error union (ImageErrorKind) is SEPARATE from the closed
 * 10-member log ErrorKind union. IMAGE_ERR_TO_LOG is the only bridge: every
 * domain kind maps onto exactly one closed log ErrorKind at log time. This
 * proves observability stays parseable without extending the log union.
 */

// The 7 image error kinds, as a literal array (exhaustiveness driver).
const ALL_IMAGE_ERROR_KINDS: readonly ImageErrorKind[] = [
  "content_blocked",
  "auth_required",
  "quota_exceeded",
  "timeout",
  "unsupported_provider",
  "bad_request",
  "empty_response",
];

// The closed 10-member log ErrorKind union (log-fields.ts:56-66) as a literal set.
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

describe("IMAGE_ERR_TO_LOG", () => {
  it("contains a mapping for every member of the ImageErrorKind union", () => {
    for (const kind of ALL_IMAGE_ERROR_KINDS) {
      expect(IMAGE_ERR_TO_LOG[kind]).toBeDefined();
    }
    // No extra keys beyond the 6 domain kinds.
    expect(Object.keys(IMAGE_ERR_TO_LOG).sort()).toEqual([...ALL_IMAGE_ERROR_KINDS].sort());
  });

  it("maps every value onto one of the closed log ErrorKind literals", () => {
    for (const logKind of Object.values(IMAGE_ERR_TO_LOG)) {
      expect(CLOSED_LOG_ERROR_KINDS.has(logKind)).toBe(true);
    }
  });

  it("pins the load-bearing mappings that RES-03 and OBS-02 rely on", () => {
    expect(IMAGE_ERR_TO_LOG.unsupported_provider).toBe("precondition");
    expect(IMAGE_ERR_TO_LOG.auth_required).toBe("auth");
    expect(IMAGE_ERR_TO_LOG.quota_exceeded).toBe("resource");
    // bad_request is NON-retryable ("precondition", not the retryable
    // "dependency") — a permanent 4xx must not be retried (the HTTP-400 fix).
    expect(IMAGE_ERR_TO_LOG.bad_request).toBe("precondition");
  });
});
