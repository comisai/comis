// SPDX-License-Identifier: Apache-2.0
/**
 * degraded-reply — deterministic user-facing reply builder for degraded turns.
 *
 * PURE: no LLM, no I/O, no globals — same input → same output always.
 * Keyed on the named degraded endReason (output_starved / context_exhausted).
 * Fail-closed: always returns a non-empty honest line even when partial text is empty.
 *
 * @module
 */

// Stub implementation — see Task 2 GREEN for the real implementation.
// These stubs return undefined for all inputs so tests FAIL (RED step).

export function buildOutputStarvedAnnotation(): string {
  throw new Error("not implemented");
}

export function buildContextExhaustedReply(): string {
  throw new Error("not implemented");
}

export function buildDegradedReply(_endReason: string): string | undefined {
  return undefined;
}
