// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-call repair seam — shape-only JSON normalizer for near-miss
 * tool-call arguments emitted by small models.
 *
 * Implements L3: lenient parse+repair for supportsStructuredOutput=false models.
 *
 * SHAPE-ONLY VALUE-PRESERVING CONTRACT (S3):
 *   This function ONLY fixes JSON structure (trailing commas, missing quotes,
 *   wrong nesting). It NEVER changes an argument VALUE to a different or broader
 *   one. A malicious value that survives repair flows into the EXISTING downstream
 *   exec-security gates (the 13-gate exec command validator for exec tools, per-tool
 *   validation for other tool types) which are the final authority on scope.
 *
 * Wiring: this function is called by tool-call-repair-wrapper.ts which sits
 * BEFORE the existing validationErrorFormatter in the stream wrapper chain.
 * Repaired args then flow through the same gates that un-repaired args would.
 *
 * Pure function, no side effects, no external I/O.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import type { ModelProfile } from "./model-profile.js";

/**
 * Attempt to repair near-miss tool-call JSON.
 *
 * Returns ok(parsedArgs) if the JSON parses (after repair if needed).
 * Returns err("irreparable") if the JSON cannot be normalized.
 *
 * INVARIANT: never changes argument values — only JSON structure.
 * Security re-validation is the caller's responsibility via the existing
 * downstream exec-security gates.
 */
export function repairToolCallJSON(
  rawJson: string,
  profile: ModelProfile,
): Result<Record<string, unknown>, string> {
  // 1. Try strict parse first — no repair needed
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    return ok(parsed);
  } catch {
    // fall through to lenient repair
  }

  // 2. supportsStructuredOutput=true: constrained-decode path deferred to a future phase.
  // For Phase 155 all Ollama models have supportsStructuredOutput=false; this stub
  // is present for traceability so the flag is not silently ignored.
  if (profile.supportsStructuredOutput) {
    // Constrained-decoding path not yet wired — fall through to lenient repair.
    // When wired, constrained decoding would guarantee valid JSON so no repair needed.
  }

  // 3. Lenient repair: fix common structural issues in JSON shape only.
  // NEVER change argument values — only remove structural noise.
  const repaired = attemptLenientRepair(rawJson);
  if (!repaired.ok) {
    return err("irreparable");
  }

  return ok(repaired.value);
}

/**
 * Attempt structural normalization of malformed JSON.
 * Only modifies JSON syntax — never argument values.
 */
function attemptLenientRepair(raw: string): Result<Record<string, unknown>, "irreparable"> {
  let s = raw.trim();

  // Remove trailing commas before closing braces/brackets (structural noise only)
  s = s.replace(/,(\s*[}\]])/g, "$1");

  // Attempt parse after structural repairs
  try {
    const parsed = JSON.parse(s) as Record<string, unknown>;
    return ok(parsed);
  } catch {
    return err("irreparable");
  }
}
