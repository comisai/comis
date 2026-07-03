// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Graph export/import RPC handlers.
 *
 * Export → import roundtrip handlers:
 *   - graph.load (load persisted named graph; strip migrated inputFrom/inputMapping)
 *
 * @module
 */

import {
  GraphLoadContract,
  stripInternalFields,
  requireCapability,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type GraphHandlerDeps } from "./graph-helpers.js";

// ---------------------------------------------------------------------------
// Export handlers
// ---------------------------------------------------------------------------

/**
 * Bind the graph export/import handlers (graph.load). Object-spread compatible
 * with `Record<string, RpcHandler>`.
 */
export function bindGraphExportHandlers(deps: GraphHandlerDeps): Record<string, RpcHandler> {
  return {
    [GraphLoadContract.method]: async (rawParams) => {
      // In-process capability gate — the agent loop skips
      // checkScope, so orch:graph is enforced here (graph.load is in the gated
      // graph family per HANDLER_CAPABILITY_MAP). Read _capabilities BEFORE strip.
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:graph");

      // Bespoke pre-Zod validation FIRST.
      if (!deps.namedGraphStore) {
        throw new Error("Named graph storage not available");
      }

      const id = rawParams.id as string | undefined;
      if (!id) {
        throw new Error("Missing required parameter: id");
      }

      const userParams = stripInternalFields(rawParams);
      GraphLoadContract.request.parse(userParams);

      const tenantId = deps.tenantId ?? "default";
      const entry = deps.namedGraphStore.load(id, tenantId);
      if (!entry) {
        throw new Error("Named graph not found");
      }

      // Strip inputFrom/inputMapping from persisted graph JSON
      const migratedNodes = (entry.nodes as Record<string, unknown>[]).map(node => {
        const { inputFrom: _inputFrom, input_from: _input_from, ...rest } = node as Record<string, unknown>;
        return rest;
      });
      const migratedEdges = (entry.edges as Record<string, unknown>[]).map(edge => {
        const { inputMapping: _inputMapping, input_mapping: _input_mapping, ...rest } = edge as Record<string, unknown>;
        return rest;
      });
      const result = { ...entry, nodes: migratedNodes, edges: migratedEdges };
      if (IS_DEV) GraphLoadContract.response.parse(result);
      return result;
    },
  };
}
