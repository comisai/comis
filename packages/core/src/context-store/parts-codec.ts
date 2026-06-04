// SPDX-License-Identifier: Apache-2.0
// @allow-throw: parts-codec skeleton — the two functions are signature-final this plan (Phase 127 Plan 01) with deliberate "not yet implemented" stub bodies; Plan 02 replaces the throws with the real pure round-trip body (its RED tests drive that). The throws are temporary scaffolding, not a boundary contract.
/**
 * Pure parts <-> pi-ai canonical Message round-trip (F2/F3).
 *
 * Lives in core — the only non-agent package that depends on pi-ai. NO
 * SQLite, NO Date.now — pure + unit-testable. Provider-correct wire emission
 * is pi-ai's job (its provider modules map the canonical block to each
 * provider's shape); this codec reconstructs the CANONICAL block only.
 *
 * Anti-pattern: hand-rolling provider shapes (Anthropic `tool_use`, OpenAI
 * `function_call_output`, etc.) here — pi-ai owns that and is version-pinned.
 *
 * Bodies land in Phase 127 Plan 02; the SIGNATURES below are final this plan.
 *
 * @module
 */

import type { Message } from "@earendil-works/pi-ai";
import type { LcdMessage, LcdMessagePart } from "../ports/context-store-types.js";

/**
 * Decompose a canonical pi-ai `Message` into structured LCD parts (write path,
 * F1): one part per content block, plus a `tool_result` part for a top-level
 * `ToolResultMessage`. Captures `metadata.raw` = the verbatim block and the F3
 * top-level reasoning marker.
 *
 * @throws stub until Phase 127 Plan 02 supplies the body.
 */
export function messageToParts(msg: Message): LcdMessagePart[] {
  void msg;
  throw new Error("parts-codec.messageToParts: implemented in Phase 127 Plan 02");
}

/**
 * Reconstruct a canonical pi-ai `Message` from a persisted `LcdMessage` (read
 * path, F2): rebuild blocks with STABLE ids (so tool_use<->tool_result pair),
 * backfill from `metadata.raw` when a typed column is NULL, and restore
 * reasoning as metadata — NOT a visible content block (F3).
 *
 * @throws stub until Phase 127 Plan 02 supplies the body.
 */
export function partsToMessage(row: LcdMessage): Message {
  void row;
  throw new Error("parts-codec.partsToMessage: implemented in Phase 127 Plan 02");
}
