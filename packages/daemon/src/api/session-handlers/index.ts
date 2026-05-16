// SPDX-License-Identifier: Apache-2.0
/**
 * Session handlers (Phase 43 split per FILE-SPLIT-04).
 *
 * Barrel re-export of the canonical public API of the former
 * `session-handlers.ts` monolith (1,089L). No aliases — every export keeps
 * its canonical name.
 *
 * @module
 */

export type { SessionHandlerDeps } from "./session-helpers.js";

import type { RpcHandler } from "../types.js";
import type { SessionHandlerDeps } from "./session-helpers.js";
import { bindSessionListHandlers } from "./session-list.js";
import { bindSessionReadHandlers } from "./session-read.js";
import { bindSessionMutateHandlers } from "./session-mutate.js";
import { bindSessionArchiveHandlers } from "./session-archive.js";

/**
 * Create a record of session/agent RPC handlers bound to the given deps.
 */
export function createSessionHandlers(deps: SessionHandlerDeps): Record<string, RpcHandler> {
  return {
    ...bindSessionListHandlers(deps),
    ...bindSessionReadHandlers(deps),
    ...bindSessionMutateHandlers(deps),
    ...bindSessionArchiveHandlers(deps),
  };
}
