// SPDX-License-Identifier: Apache-2.0
/**
 * Video-generation domain error classifications.
 *
 * `VideoErrorKind` is a STANDALONE domain union — it is NOT the closed
 * 10-member log `ErrorKind` (packages/core/src/logging/log-fields.ts) and MUST
 * NOT be added to it. This mirrors `ImageErrorKind` (image-error.ts), where the
 * domain classification is its own type, separate from the log union.
 *
 * DIVERGENCE 2 from the image union: video adds a 7th member, `job_timeout`,
 * for the bounded poll-loop deadline of `execute()` (VPORT-02) — distinct from
 * `timeout` (a single provider HTTP call timing out). It is the video-only
 * addition and is mapped — like `timeout` — onto the EXISTING closed log
 * `"timeout"`. The closed log union is never extended.
 *
 * `VIDEO_ERR_TO_LOG` is the only bridge between the two: at log time a domain
 * `VideoErrorKind` is mapped onto exactly one of the closed log `ErrorKind`
 * values, so observability stays parseable while the domain vocabulary stays
 * expressive. Callers log `{ errorKind: VIDEO_ERR_TO_LOG[k], videoErrorKind: k,
 * hint }` per the §2.7 logging matrix.
 *
 * @module
 */

import type { ErrorKind } from "../logging/log-fields.js";

export type VideoErrorKind =
  | "content_blocked"
  | "auth_required"
  | "quota_exceeded"
  | "timeout"
  | "job_timeout"
  | "unsupported_provider"
  | "empty_response";

/**
 * Maps each domain `VideoErrorKind` onto one of the CLOSED 10-member log
 * `ErrorKind` literals. The closed union is never extended — this map is the
 * single point where the two vocabularies meet. Both `timeout` and the
 * video-only `job_timeout` collapse onto the closed log `"timeout"` (DIVERGENCE 2).
 */
export const VIDEO_ERR_TO_LOG: Record<VideoErrorKind, ErrorKind> = {
  unsupported_provider: "precondition",
  auth_required: "auth",
  quota_exceeded: "resource",
  timeout: "timeout",
  job_timeout: "timeout",
  empty_response: "dependency",
  content_blocked: "dependency",
};

/**
 * Typed error carrying the domain `VideoErrorKind` + an operator-facing hint.
 *
 * Mirrors `ImageGenError` (packages/daemon/src/api/pi-image-adapter.ts). A video
 * adapter throws this inside its `execute()`/`submit()` boundary (caught by
 * `fromPromise`), so the resulting `Result` err carries a structured error — NOT
 * a message-only/string-encoded one. Plan 04's `makeUnavailableVideoPort` +
 * the handler's `extractVideoHint` construct/read this exact shape, so the
 * typed-class form is the cross-plan contract. The `message` is user-safe (it
 * never echoes the raw provider error, which could contain a key or token).
 */
export class VideoGenError extends Error {
  readonly videoErrorKind: VideoErrorKind;
  readonly hint: string;

  constructor(message: string, opts: { videoErrorKind: VideoErrorKind; hint: string }) {
    super(message);
    this.name = "VideoGenError";
    this.videoErrorKind = opts.videoErrorKind;
    this.hint = opts.hint;
  }
}
