/**
 * Summary-ref rendering for the dag assembler — extracted VERBATIM from
 * `lcd-assembler.ts` (file-size cap, ≤800 lines) so the assembler keeps only
 * resolve/assemble flow. {@link summaryRefToMessage} stays the ONE resolution
 * point; the assembler's `resolveContextItem` is its sole caller.
 *
 * @module
 */

import { scrubSecretsFromText, systemDateFrom, wrapExternalContent } from "@comis/core";
import type { LcdSummary } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { LCD_FALLBACK_HEADER_MARKER } from "./constants.js";

/**
 * Render a summary as an HONEST, TAINT-SAFE `user`-role message — the ONE
 * resolution seam for summary refs (never a plain-text passthrough).
 *
 * The honesty markers (depth / descendant_count / ISO time-range / trust, plus
 * `fallback=emergency-truncation` when `summary.fallback`) are computed from
 * the STORE ROW (`summary.depth`/`descendantCount`/`earliestAt`/`latestAt`/
 * `fallback`), NEVER parsed from `content`, and placed in the TRUSTED header +
 * footer OUTSIDE the `wrapExternalContent` untrusted region. A poisoned summary
 * body therefore cannot forge them: the per-session random hex delimiter is
 * unpredictable, and `replaceMarkers` neutralizes any injected `<<<UNTRUSTED_…>>>`
 * / `<<<END_UNTRUSTED_…>>>` marker the content tries to smuggle in (test-proven:
 * a body forging `trust=trusted` / `fallback=emergency-truncation` + a fake
 * end-delimiter still renders the real `trust=untrusted` + the real fallback flag
 * and the forged delimiter collapses to `[[END_MARKER_SANITIZED]]`).
 *
 * Role stays `"user"` — the documented ceiling: a summary derived from
 * possibly-untrusted history is carried untrusted-by-role, NEVER `system`/
 * `assistant`. The body is wrapped via `wrapExternalContent` (the AGENTS.md §2.2
 * taint primitive) rather than hand-rolled XML escaping.
 *
 * The expand footer is an honest ADVERTISEMENT of WHAT was compressed (depth +
 * count + time-range); it deliberately does NOT name the recovery TOOLS
 * (`ctx_*`) — their descriptions own that surface. Keep this the single
 * resolution point so future swaps touch one function.
 */
export function summaryRefToMessage(summary: LcdSummary): AgentMessage {
  // `trust` is ALWAYS "untrusted" (the row is untrusted-by-derivation; the value
  // is derived, never widened to "trusted"). When the row's
  // `fallback` flag is set — the breaker/spend-cap bypass or the deterministic
  // Level-3 floor produced this summary with NO LLM — append the unspoofable
  // `LCD_FALLBACK_HEADER_MARKER` so the model is honestly told the summary is a
  // degraded emergency truncation. The marker lives in the TRUSTED header here,
  // OUTSIDE the `wrapExternalContent` region below, so a poisoned body can neither
  // forge it (the per-session random hex delimiter is unpredictable +
  // `replaceMarkers` sanitizes spoofed delimiters) nor strip it (only the real
  // `summary.fallback` row flag — never the content — drives it).
  const trust = "untrusted";
  const range = isoRange(summary.earliestAt, summary.latestAt);
  const fallbackMarker = summary.fallback ? `, ${LCD_FALLBACK_HEADER_MARKER}` : "";
  const header =
    `[LCD summary — depth=${summary.depth}, ` +
    `descendant_count=${summary.descendantCount}, ` +
    `${range}, trust=${trust}${fallbackMarker}]`;
  // The body is UNTRUSTED — scrub secrets, THEN wrap it. `source: "unknown"`
  // (label "External") is the generic untrusted-text source; the
  // `ExternalContentSource` union has no `lcd_summary` label and this rendering
  // layer does not edit the core security enum. The honesty markers live OUTSIDE
  // this wrapped region (the trusted header/footer), so no `includeWarning` wall
  // is needed per summary — the header + the system-prompt clause carry the policy.
  //
  // Egress scrub: a summary is DERIVED from a region that can legitimately
  // contain a credential (the lossless base store keeps the raw conversation). The
  // summary re-enters the model context every turn it is assembled, so the derived
  // body must never carry the secret verbatim — scrub this egress copy (the base
  // store stays lossless), mirroring the ctx_expand / ctx_search egress scrub.
  const safeBody = wrapExternalContent(scrubSecretsFromText(summary.content).text, {
    source: "unknown",
    includeWarning: false,
  });
  const footer =
    `Expand for details about: the ${summary.descendantCount} compressed ` +
    `message(s) at depth ${summary.depth} spanning ${range}.`;
  const text = `${header}\n${safeBody}\n${footer}`;
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

/**
 * Format the inclusive `[earliestAtMs, latestAtMs]` epoch-millisecond span as an
 * ISO date range `YYYY-MM-DD..YYYY-MM-DD`, collapsing to a single `YYYY-MM-DD`
 * when both ends fall on the same day. Pure formatting of already-known values —
 * NOT a clock read — but the globals classifier flags `new Date(arg)` regardless
 * of its argument, so the conversion goes through the sanctioned-root
 * `systemDateFrom` indirection (the AGENTS.md §1 helper for `new Date(stored)`
 * display formatting; the `rag-retriever.ts` precedent).
 */
function isoRange(earliestAtMs: number, latestAtMs: number): string {
  const start = systemDateFrom(earliestAtMs).toISOString().slice(0, 10);
  const end = systemDateFrom(latestAtMs).toISOString().slice(0, 10);
  return start === end ? start : `${start}..${end}`;
}
