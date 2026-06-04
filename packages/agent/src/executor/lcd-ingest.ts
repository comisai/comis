// SPDX-License-Identifier: Apache-2.0
/**
 * RED stub — see lcd-ingest.test.ts. The real implementation lands in the
 * GREEN commit (Plan 128-03 feat).
 *
 * @module
 */

import type { ContextStorePort, ContextStoreScope, ComisLogger } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * RED stub: a no-op so the test file compiles and the behavioral assertions
 * fail (nothing is appended, no log is emitted) against the not-yet-built impl.
 */
export function ingestTurn(
  _store: ContextStorePort,
  _scope: ContextStoreScope,
  _startSeq: number,
  _messages: AgentMessage[],
  _now: number,
  _logger: ComisLogger,
): void {
  // Intentionally empty for the RED phase.
}
