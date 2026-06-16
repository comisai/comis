// SPDX-License-Identifier: Apache-2.0
/**
 * Voice (STT/TTS) domain error classifications.
 *
 * `SttErrorKind` is a STANDALONE domain union — it is NOT the closed 10-member
 * log `ErrorKind` (packages/core/src/logging/log-fields.ts:56-66) and MUST NOT
 * be added to it. This mirrors `ImageErrorKind` (image-error.ts) and the
 * `ErrorCategory` precedent, where the domain classification is its own type,
 * separate from the log union.
 *
 * `STT_ERR_TO_LOG` is the only bridge between the two: at log time a domain
 * `SttErrorKind` is mapped onto exactly one of the closed log `ErrorKind`
 * values, so observability stays parseable while the domain vocabulary stays
 * expressive. Callers log `{ errorKind: STT_ERR_TO_LOG[k], sttErrorKind: k,
 * hint }` per the §2.7 logging matrix (the full event bridge is Phase 196).
 *
 * TTS reuses `SttErrorKind` — design §17 lists the same kind-set for both STT
 * and TTS (Assumption A3). Do NOT split a separate TtsErrorKind unless `edge`
 * (or `piper`) needs a distinct kind.
 *
 * @module
 */

import type { ErrorKind } from "../logging/log-fields.js";

export type SttErrorKind =
  | "no_keyless_engine"
  | "auth_required"
  | "model_load_failed"
  | "model_download_failed"
  | "timeout"
  | "network"
  | "dependency";

/**
 * Maps each domain `SttErrorKind` onto one of the CLOSED 10-member log
 * `ErrorKind` literals. The closed union is never extended — this map is the
 * single point where the two vocabularies meet.
 */
export const STT_ERR_TO_LOG: Record<SttErrorKind, ErrorKind> = {
  // No keyless engine + no usable audio key is a configuration/setup
  // precondition (the operator must enable an engine or set a key), NOT a
  // transient dependency failure — keep it OUT of the retryable bucket.
  no_keyless_engine: "precondition",
  auth_required: "auth",
  model_load_failed: "dependency",
  model_download_failed: "dependency",
  timeout: "timeout",
  network: "network",
  dependency: "dependency",
};
