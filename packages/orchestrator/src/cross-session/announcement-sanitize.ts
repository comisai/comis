// SPDX-License-Identifier: Apache-2.0
/**
 * Announcement text sanitization.
 *
 * Strips the machinery a user should never see from announcement text: the
 * system-message envelope wrapped around a completion, the trailing
 * instruction line addressed to the model, and the sub-agent result markers
 * that delimit sections internally.
 *
 * This is a display boundary, not a security one — it decides what reads as
 * the agent's own words rather than as plumbing leaking through.
 *
 * @module
 */

/**
 * Strip the `[System Message]\n` prefix and trailing LLM instruction line
 * from announcement text, leaving only the task-specific content.
 */
export function stripSystemPrefix(text: string): string {
  let result = text;
  // Strip [System Message] prefix
  if (result.startsWith("[System Message]\n")) {
    result = result.slice("[System Message]\n".length);
  }
  // Strip trailing instruction line
  const marker = "Inform the user about this completed background task.";
  const idx = result.lastIndexOf(marker);
  if (idx !== -1) {
    result = result.slice(0, idx).trimEnd();
  }
  return result;
}

export function containsInternalAnnouncementEnvelope(text: string): boolean {
  return text.startsWith("[System Message]\n")
    || text.includes("Inform the user about this completed background task.")
    || /\[Subagent Result:/iu.test(text)
    || text.includes("Full result (drill in with read/grep/jq):");
}

/**
 * Sanitize announcement text for direct user delivery (fallback path).
 * Extracts human-readable content (Summary or Result sections) and strips
 * internal metadata (session keys, file paths, condensation stats, subagent
 * markers, runtime stats). Returns a safe generic message if no extractable
 * content is found.
 * Used for durable decision fallbacks and as the final egress guard when a
 * parent rewrite echoes the internal completion envelope.
 */
export function sanitizeForUser(text: string): string {
  const GENERIC_FALLBACK =
    "A background task completed but the result could not be delivered properly. Please ask me to check on it.";

  // First strip system prefix and trailing instruction (shared cleanup)
  const stripped = stripSystemPrefix(text);

  // Try to extract "Summary:" content
  let extracted = extractAnnouncementSection(stripped, "Summary:");

  // If no Summary found, try "Result:" content
  if (!extracted) {
    extracted = extractAnnouncementSection(stripped, "Result:");
  }

  // If neither found, return generic fallback
  if (!extracted) {
    return GENERIC_FALLBACK;
  }

  // Strip internal metadata patterns from extracted text
  let sanitized = extracted;

  // [Subagent Result: ...] markers
  sanitized = stripSubagentResultMarkers(sanitized);

  // Session keys (e.g., default:user1:channel:123)
  sanitized = sanitized.replace(/\b\w+:\w+:[a-z_-]+:\d+\b/g, "");

  // File paths (starting with / or ~)
  sanitized = sanitized.replace(/(?<![:/\\\w])(?:\/[\w./-]+|~\/[\w./-]+)/g, "");

  // Runtime stats lines (Runtime: ... | Steps: ... | Tokens:)
  sanitized = sanitized.replace(/Runtime:.*\|.*Steps:.*\|.*Tokens:[^\n]*/g, "");

  // Token counts/costs (Tokens: 500 ... Cost: $0.0050)
  sanitized = sanitized.replace(/Tokens:\s*\d+.*Cost:\s*\$[\d.]+/g, "");

  // Condensation stats (e.g., "150->50 messages" or "condensed 150 to 50")
  sanitized = sanitized.replace(/\d+\u2192\d+\s*messages/g, "");
  sanitized = sanitized.replace(/condensed\s+\d+\s+to\s+\d+/gi, "");

  // Clean up: collapse multiple whitespace/newlines and trim
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n").replace(/ {2,}/g, " ").trim();

  return sanitized || GENERIC_FALLBACK;
}

export function extractAnnouncementSection(text: string, label: string): string | undefined {
  const lower = text.toLowerCase();
  const lowerLabel = label.toLowerCase();
  let labelStart = lower.startsWith(lowerLabel) ? 0 : lower.indexOf(`\n${lowerLabel}`);
  if (labelStart === -1) return undefined;
  if (labelStart > 0) labelStart++;
  let contentStart = labelStart + label.length;
  while (contentStart < text.length && /\s/.test(text[contentStart]!)) contentStart++;
  const terminators = ["\n---", "\n###", "\n[subagent result"];
  let contentEnd = text.length;
  for (const terminator of terminators) {
    const found = lower.indexOf(terminator, contentStart);
    if (found !== -1 && found < contentEnd) contentEnd = found;
  }
  const content = text.slice(contentStart, contentEnd).trim();
  return content || undefined;
}

export function stripSubagentResultMarkers(text: string): string {
  const lower = text.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = lower.indexOf("[subagent result:", cursor);
    if (start === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, start));
    const end = text.indexOf("]", start + 1);
    if (end === -1) break;
    cursor = end + 1;
  }
  return parts.join("");
}
