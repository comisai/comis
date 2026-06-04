// SPDX-License-Identifier: Apache-2.0
/**
 * Transcript repair (A2) — RED stub.
 *
 * Replaced by the real three-pass pairing-invariant transform in the GREEN
 * commit. This identity stub exists only so the RED-first unit tests compile
 * and fail against pre-implementation code.
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * RED stub: returns the input untouched. The GREEN implementation guarantees a
 * provider-valid tool_use<->tool_result pairing.
 */
export function sanitizeToolUseResultPairing(
  messages: AgentMessage[],
  _now: number,
): AgentMessage[] {
  return messages;
}
