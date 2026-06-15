// SPDX-License-Identifier: Apache-2.0
/**
 * Image-generation domain error classifications.
 *
 * `ImageErrorKind` is a STANDALONE domain union — it is NOT the closed
 * 10-member log `ErrorKind` (packages/core/src/logging/log-fields.ts:56-66) and
 * MUST NOT be added to it. This mirrors the precedent set by `ErrorCategory`
 * (packages/agent/src/executor/error-classifier.ts), where the domain
 * classification is its own type, separate from the log union.
 *
 * `IMAGE_ERR_TO_LOG` is the only bridge between the two: at log time a domain
 * `ImageErrorKind` is mapped onto exactly one of the closed log `ErrorKind`
 * values, so observability stays parseable while the domain vocabulary stays
 * expressive. Callers log `{ errorKind: IMAGE_ERR_TO_LOG[k], imageErrorKind: k,
 * hint }` per the §2.7 logging matrix.
 *
 * @module
 */

import type { ErrorKind } from "../logging/log-fields.js";

export type ImageErrorKind =
  | "content_blocked"
  | "auth_required"
  | "quota_exceeded"
  | "timeout"
  | "unsupported_provider"
  | "bad_request"
  | "empty_response";

/**
 * Maps each domain `ImageErrorKind` onto one of the CLOSED 10-member log
 * `ErrorKind` literals. The closed union is never extended — this map is the
 * single point where the two vocabularies meet.
 */
export const IMAGE_ERR_TO_LOG: Record<ImageErrorKind, ErrorKind> = {
  unsupported_provider: "precondition",
  auth_required: "auth",
  quota_exceeded: "resource",
  timeout: "timeout",
  // bad_request: the provider rejected the request itself (a permanent 4xx that
  // is NOT auth/quota/content) — a caller/contract precondition failure, NOT a
  // transient dependency error. Mapping it to "precondition" (not "dependency")
  // keeps it OUT of the retryable bucket: retrying the same request just re-400s.
  bad_request: "precondition",
  empty_response: "dependency",
  content_blocked: "dependency",
};
