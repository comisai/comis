// SPDX-License-Identifier: Apache-2.0
/**
 * A greppable, bounded excerpt of WHY a background task failed.
 *
 * The failure path emitted an event and logged nothing, and the trajectory record carries typed
 * fields only (no raw error text, by design). So the actual upstream cause survived solely inside
 * the persisted task JSON, behind the external-content security banner. Live:
 * `PageSize must be between 1 and 1000. You entered 2000` — a precise, actionable upstream message —
 * produced ZERO hits when grepped over the daemon log, while the only log trace was a DEBUG line
 * reporting `firstBlockTextLen:962`. An operator following the documented read-order never reaches
 * the cause.
 *
 * The text is untrusted tool output, which is why it is banner-wrapped in the first place, so this
 * never passes it through verbatim: markers are stripped, control characters and newlines are
 * collapsed so a log line cannot be forged, secrets are scrubbed, and the result is hard-capped.
 *
 * @module
 */

import { scrubSecretsFromText } from "@comis/core";

/** Hard cap on the excerpt. Long enough for an upstream validation sentence, short enough to log. */
const CAUSE_MAX_CHARS = 240;

/** Opening/closing delimiters the external-content wrapper puts around untrusted payloads. */
const UNTRUSTED_OPEN = /<<<UNTRUSTED_[a-f0-9]+>>>/i;
const UNTRUSTED_CLOSE = /<<<END_UNTRUSTED_[a-f0-9]+>>>/i;

/**
 * Extract a loggable one-line cause from a background task's error text.
 *
 * When the text is banner-wrapped, the payload BETWEEN the delimiters is preferred — the cause sits
 * there, behind several hundred characters of security notice, so a naive head-of-string excerpt
 * would return only the banner.
 *
 * @param error - the raw error text or Error the task failed with.
 * @returns a single-line, secret-scrubbed, length-capped excerpt, or undefined when there is nothing
 *   substantive to report.
 */
export function backgroundFailureCause(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (raw === undefined) return undefined;

  let text = raw;
  const open = UNTRUSTED_OPEN.exec(text);
  if (open !== null) {
    const afterOpen = text.slice(open.index + open[0].length);
    const close = UNTRUSTED_CLOSE.exec(afterOpen);
    text = close === null ? afterOpen : afterOpen.slice(0, close.index);
  }

  // Collapse every control character and whitespace run to a single space: a multi-line excerpt in
  // a log could otherwise forge additional log lines from untrusted content.
  const oneLine = scrubSecretsFromText(text).text.replace(/[\p{C}\s]+/gu, " ").trim();
  if (oneLine.length === 0) return undefined;
  if (oneLine.length <= CAUSE_MAX_CHARS) return oneLine;

  // Keep both ends: an upstream message can sit at either end of a longer payload, and dropping the
  // tail is how the banner would win again.
  const half = Math.floor((CAUSE_MAX_CHARS - 3) / 2);
  return `${oneLine.slice(0, half)} … ${oneLine.slice(-half)}`;
}
