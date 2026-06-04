// SPDX-License-Identifier: Apache-2.0
/**
 * RED stub — replaced by the GREEN implementation in the next commit.
 *
 * Exists only so `lcd-assembler.test.ts` compiles and the RED state is
 * reproducible from the test commit alone: `transformContext` returns the live
 * array unchanged (no store read, no fresh-tail split, no repair), so the
 * history-from-store / verbatim-fresh-tail / repair-last / A4-grows assertions
 * all fail.
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextEngineConfig } from "@comis/core";
import type { ContextEngine, ContextEngineDeps } from "./types.js";

export function createLcdContextEngine(
  _config: ContextEngineConfig,
  _deps: ContextEngineDeps,
): ContextEngine {
  return {
    lastBreakpointIndex: undefined,
    lastTrimOffset: 0,
    async transformContext(liveMessages: AgentMessage[]): Promise<AgentMessage[]> {
      return liveMessages;
    },
  };
}

export function freshTailBoundaryIndex(_messages: AgentMessage[], _freshTailSteps: number): number {
  return 0;
}
