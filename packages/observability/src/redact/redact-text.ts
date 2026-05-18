// SPDX-License-Identifier: Apache-2.0
/**
 * `redactSecretsInText` — apply the default redact-pattern set to free
 * text.
 *
 * For each pattern in `getDefaultRedactPatterns()`, scan `input` via
 * `replacePatternBounded` (chunked for ReDoS protection) and replace
 * each matched substring with the edge-keeping mask of the matched
 * value. The mask preserves correlation across log lines for the same
 * secret while never exposing the body.
 *
 * The matched substring is what the callback receives — it's the full
 * regex match (e.g., the entire `Authorization: Bearer sk-…` header
 * substring), not just the secret body. We pipe that whole match
 * through `maskToken`. For headers / JSON / URL-query patterns the
 * mask hides the structural keywords too — that's the design intent
 * (operator only needs the masked correlation token, not the
 * structural context that betrays which secret was caught).
 *
 * Pure function — no I/O. Used by:
 *   - The Pino redact transport (`pino-redact-transport.ts`) for the
 *     free-form regex pass on JSON log lines.
 *   - The structured-walker `redactSecrets` for string-valued fields.
 *
 * @module
 */

import { maskToken, maskPemBlock } from "./edge-keeping.js";
import { getDefaultRedactPatterns } from "./patterns.js";
import { replacePatternBounded } from "./regex-bounded.js";

/**
 * Apply every default redact pattern to `input`, masking each match.
 *
 * Dispatches on the pattern's `kind` field:
 *   - `kind === "pem"` → `maskPemBlock(match)` (preserves BEGIN/END
 *     label lines so operators can still see WHAT was redacted, not
 *     just that something was).
 *   - everything else → `maskToken(match)` (edge-keeping or `"***"`
 *     for sub-MIN_LENGTH bodies).
 *
 * @param input - the free-text string to scan
 * @returns a new string with every recognized credential body replaced
 *   by an appropriate mask.
 */
export function redactSecretsInText(input: string): string {
  let out = input;
  for (const pattern of getDefaultRedactPatterns()) {
    if (pattern.kind === "pem") {
      out = replacePatternBounded(out, pattern.regex, (match) => maskPemBlock(match));
      continue;
    }
    out = replacePatternBounded(out, pattern.regex, (match) => maskToken(match));
  }
  return out;
}
