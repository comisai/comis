// SPDX-License-Identifier: Apache-2.0
/**
 * Graph handlers (Phase 43 split per FILE-SPLIT-05).
 *
 * Barrel re-export of the canonical public API of the former
 * `graph-handlers.ts` monolith (1,030L). No aliases — every export keeps
 * its canonical name.
 *
 * @module
 */

export type { GraphHandlerDeps, ValidationIssue } from "./graph-helpers.js";
export { transformNodes, validateGraphWarnings, schemaToExample } from "./graph-helpers.js";

import type { RpcHandler } from "../types.js";
import type { GraphHandlerDeps } from "./graph-helpers.js";
import { bindGraphQueryHandlers } from "./graph-query.js";
import { bindGraphMutateHandlers } from "./graph-mutate.js";
import { bindGraphExportHandlers } from "./graph-export.js";

/**
 * Create a record of graph RPC handlers bound to the given deps.
 */
export function createGraphHandlers(deps: GraphHandlerDeps): Record<string, RpcHandler> {
  return {
    ...bindGraphQueryHandlers(deps),
    ...bindGraphMutateHandlers(deps),
    ...bindGraphExportHandlers(deps),
  };
}
