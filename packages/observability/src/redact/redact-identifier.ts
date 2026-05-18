// SPDX-License-Identifier: Apache-2.0
/**
 * Opaque-id helper.
 *
 * Replaces a sensitive or correlation-bearing identifier (session id,
 * channel id, agent id, conversation id) with a sha256-prefixed truncated
 * hex digest. The output preserves correlation across log lines (same
 * input → same output) while never exposing the underlying identifier.
 *
 * Output shape: `"sha256:" + <hexChars> hex chars`. Default truncation
 * is 12 hex chars (48 bits of entropy), which is sufficient to keep
 * collisions unlikely across the typical 1k–1M identifiers a single
 * Comis daemon emits per session window. Callers needing strict
 * uniqueness can request a longer prefix (up to 64).
 *
 * Pure function — no I/O, no clock, no fs.
 *
 * @module
 */

import { createHash } from "node:crypto";

/** Default number of hex chars to retain after the `sha256:` prefix. */
const DEFAULT_HEX_CHARS = 12;

/** Full sha256 hex digest length (32 bytes × 2 hex chars/byte). */
const FULL_DIGEST_HEX_CHARS = 64;

/**
 * Generate an opaque sha256-prefixed correlation token for `id`.
 *
 *   redactIdentifier("comis-session-abcd1234")
 *     // → "sha256:e3b0c44298fc"
 *
 * @param id - the input identifier
 * @param hexChars - hex chars to retain after the `sha256:` prefix
 *   (default 12, clamped to [1, 64])
 * @returns `"sha256:" + <hexChars>` of the sha256 digest of `id`
 */
export function redactIdentifier(id: string, hexChars: number = DEFAULT_HEX_CHARS): string {
  const clamped = Math.max(1, Math.min(FULL_DIGEST_HEX_CHARS, Math.floor(hexChars)));
  const digest = createHash("sha256").update(id).digest("hex");
  return "sha256:" + digest.slice(0, clamped);
}
