// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Graph mutation RPC handlers.
 *
 * Write-side handlers that produce/modify execution graphs:
 *   - graph.define, graph.execute, graph.cancel
 *   - graph.save, graph.delete, graph.deleteRun
 *
 * Pure helpers (transformNodes, validateGraphWarnings, schemaToExample,
 * buildGraphInput, validateTypeConfigs) live in `graph-helpers.ts` to keep
 * this file under the per-file line cap.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import {
  safePath,
  GraphDefineContract,
  GraphExecuteContract,
  GraphCancelContract,
  GraphSaveContract,
  GraphDeleteContract,
  GraphDeleteRunContract,
  stripInternalFields,
  requireCapability,
  tryGetContext,
  type AgentCapability,
} from "@comis/core";
import { extractUserVariables, substituteUserVariables } from "../../graph/user-variables.js";
import type { RpcHandler } from "../types.js";
import { PreconditionError } from "../errors.js";
import {
  IS_DEV,
  type GraphHandlerDeps,
  buildGraphInput,
  validateGraphWarnings,
  validateTypeConfigs,
} from "./graph-helpers.js";
// Authoring telemetry/audit helpers extracted to keep this file under the
// graph-handlers/ 500-line cap (file-size cap; behavior byte-identical).
import { createGraphMutateTelemetry, isSynthPattern } from "./graph-mutate-telemetry.js";

// ---------------------------------------------------------------------------
// Mutation handlers
// ---------------------------------------------------------------------------

/**
 * Bind the write-side graph RPC handlers (define / execute / cancel / save /
 * delete / deleteRun). Object-spread compatible with `Record<string, RpcHandler>`.
 */
export function bindGraphMutateHandlers(deps: GraphHandlerDeps): Record<string, RpcHandler> {
  // Authoring telemetry/audit helpers (best-effort emitters + server-side
  // tier/repair-context derivations) extracted to graph-mutate-telemetry.ts
  // (file-size cap) — behavior byte-identical. isSynthPattern is the closed
  // from_intent pattern guard (also moved there).
  const { emitPipelineAuthored, resolveAuthoringTier, repairContext, emitGraphSynthesized } =
    createGraphMutateTelemetry(deps);

  return {
    [GraphDefineContract.method]: async (rawParams) => {
      // In-process capability gate — the agent loop skips
      // checkScope, so orch:graph is enforced here, reading the injected
      // _capabilities from raw params BEFORE the strip.
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:graph");

      // Bespoke pre-Zod validation FIRST (preserves user-friendly error
      // messages matching existing handler-test assertions —
      // "Missing required parameter: nodes" rather than Zod's JSON dump).
      const rawNodes = rawParams.nodes as unknown[];
      if (!rawNodes || !Array.isArray(rawNodes) || rawNodes.length === 0) {
        throw new Error("Missing required parameter: nodes");
      }

      const userParams = stripInternalFields(rawParams);
      // A present-but-malformed authoring call that
      // fails the STRICT GraphDefineContract z.object (e.g. a wrong-typed
      // contract field) throws HERE, before buildGraphInput — yet it is a
      // genuine small-model "authored an invalid pipeline" attempt. Emit
      // schemaValid:false so it lands in the gate denominator (the metric counts
      // every contract-parse-reachable authoring, not only buildGraphInput-
      // reachable ones), then re-throw (the user-facing error contract is
      // unchanged). The bespoke "Missing required parameter: nodes" pre-check
      // above is deliberately NOT counted — an empty/garbage call is not an
      // authoring attempt (see the pipeline:authored doc comment for the
      // metric's exact boundary).
      try {
        GraphDefineContract.request.parse(userParams);
      } catch (e) {
        emitPipelineAuthored("define", false, rawParams);
        throw e;
      }

      // Resolve the calling agent's tier SERVER-SIDE,
      // gated on repairProducer. FLAGS-OFF (or absent) ⇒ undefined ⇒ the capable
      // direct-emit path ⇒ byte-identical to the ungated behavior. NEVER read the
      // tool-supplied userParams.capabilityClass for the tier — that is a spoofing
      // surface (a weak model claiming "frontier" to skip repair).
      const capabilityClass = resolveAuthoringTier(deps, rawParams);
      // Capture the REAL buildGraphInput parse+validate verdict.
      // buildGraphInput THROWS on parse/validate failure — emit schemaValid:false
      // and re-throw (the existing user-facing error contract is unchanged);
      // on success emit schemaValid:true BEFORE the later type_config/warning
      // logic so a valid-but-otherwise-rejected call still counts as authored.
      let validated;
      try {
        validated = await buildGraphInput(userParams, capabilityClass, repairContext(deps, rawParams));
      } catch (e) {
        emitPipelineAuthored("define", false, rawParams);
        throw e;
      }
      emitPipelineAuthored("define", true, rawParams);
      validateTypeConfigs(validated.graph, deps.nodeTypeRegistry);
      const { warnings, errors } = validateGraphWarnings(validated.graph);

      const result = {
        valid: true,
        nodeCount: validated.graph.nodes.length,
        executionOrder: validated.executionOrder,
        label: validated.graph.label,
        warnings,
        errors,
        userVariables: extractUserVariables(validated.graph.nodes),
      };
      if (IS_DEV) GraphDefineContract.response.parse(result);
      return result;
    },

    [GraphExecuteContract.method]: async (rawParams) => {
      // In-process capability gate (see graph.define).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:graph");

      // Bespoke pre-Zod validation FIRST.
      if (!deps.securityConfig.agentToAgent?.enabled) {
        throw new Error("Agent-to-agent messaging is disabled by policy.");
      }

      // Read the from_intent marker BEFORE the strip
      // (mirrors the _agentId/_callerSessionKey precedent — internal fields are
      // read from rawParams). It is the in-band signal the from_intent tool sets
      // so the daemon can GATE + AUDIT the synthesis at this chokepoint (the
      // synthesizer runs in the skills tool, separated from here by JSON-RPC).
      const synthPattern = rawParams._synthesizedFromIntent as string | undefined;
      // FLAGS-OFF refusal: refuse a from_intent
      // dispatch when orchestration.authoring.intentAction is off, BEFORE any
      // graph runs. A non-from_intent execute (no marker) is wholly unaffected —
      // byte-identical to the ungated behavior.
      if (synthPattern && !deps.authoringConfig?.intentAction) {
        // Typed: a gated-off policy refusal is a caller
        // precondition failure, not an internal handler fault — classifyRpcError maps
        // PreconditionError to precondition/warn so it doesn't read as a system ERROR.
        throw new PreconditionError(
          "from_intent authoring is disabled by policy (orchestration.authoring.intentAction).",
        );
      }

      const userParams = stripInternalFields(rawParams);
      // Marker-leak guard: _synthesizedFromIntent is NOT in
      // INTERNAL_FIELD_NAMES (a single-use graph-handler-local marker, not a
      // shared dispatcher field), and GraphExecuteContract.request is a loose
      // z.record — so the strip alone leaves it on userParams → it would reach
      // buildGraphInput. Remove it explicitly so it never reaches the graph builder.
      delete userParams._synthesizedFromIntent;
      // Unlike graph.define, GraphExecuteContract is a
      // LOOSE z.record(z.string(), z.unknown()) — it accepts essentially any
      // object, so a present-but-malformed authoring call does NOT throw here.
      // It instead reaches buildGraphInput below, which already emits
      // schemaValid:false via its own try/catch. There is therefore no
      // contract-parse-level denominator gap on the execute path; no emit guard
      // is needed around this parse.
      GraphExecuteContract.request.parse(userParams);

      // Server-side gated tier — see graph.define.
      // FLAGS-OFF ⇒ undefined ⇒ capable path (byte-identical). The tool-supplied
      // userParams.capabilityClass is never read for the tier (spoofing surface).
      const capabilityClass = resolveAuthoringTier(deps, rawParams);
      // Same try/catch verdict capture as graph.define — emit
      // schemaValid:false on a parse/validate throw (still re-throwing), true
      // on success, before the coordinator dispatch.
      let validated;
      try {
        validated = await buildGraphInput(userParams, capabilityClass, repairContext(deps, rawParams));
      } catch (e) {
        emitPipelineAuthored("execute", false, rawParams);
        throw e;
      }
      emitPipelineAuthored("execute", true, rawParams);
      validateTypeConfigs(validated.graph, deps.nodeTypeRegistry);

      // Emit the synthesis audit AFTER governance
      // succeeded, so it reflects a GOVERNED graph (best-effort emit).
      // Only when the marker was set AND intentAction is on (FLAGS-OFF already threw).
      if (synthPattern && deps.authoringConfig?.intentAction && isSynthPattern(synthPattern)) {
        emitGraphSynthesized(synthPattern, validated.graph.nodes.length, rawParams);
      }

      // Apply user-variable substitution if variables provided
      const variables = userParams.variables as Record<string, string> | undefined;
      let finalValidated = validated;
      if (variables && Object.keys(variables).length > 0) {
        const substitutedNodes = validated.graph.nodes.map((node) => ({
          ...node,
          task: substituteUserVariables(node.task, variables),
        }));
        finalValidated = {
          graph: { ...validated.graph, nodes: substitutedNodes },
          executionOrder: validated.executionOrder,
        };
      }

      // Check for unresolved variables AFTER substitution (execute-time only)
      const unresolvedWarnings: Array<{ nodeId: string; type: string; message: string; fix: string }> = [];
      const varPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
      for (const node of finalValidated.graph.nodes) {
        varPattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = varPattern.exec(node.task)) !== null) {
          unresolvedWarnings.push({
            nodeId: node.nodeId,
            type: "unresolved_variable",
            message: `Node "${node.nodeId}" has unresolved variable \${${match[1]}} -- provide a value in the variables parameter`,
            fix: `Provide a value for "${match[1]}" in the variables parameter, or remove the \${${match[1]}} placeholder.`,
          });
        }
      }

      // Pre-execution channel validation for approval-gate nodes
      const hasApprovalGate = finalValidated.graph.nodes.some(n => n.typeId === "approval-gate");
      if (hasApprovalGate) {
        const announceChannelType = rawParams._callerChannelType as string | undefined;
        const announceChannelId = rawParams._callerChannelId as string | undefined;
        if (!announceChannelType || !announceChannelId) {
          throw new Error(
            "Graph contains approval-gate nodes but no announcement channel is configured. " +
            "The graph must be triggered from a channel context (Telegram, Discord, etc.)."
          );
        }
      }

      const coordResult = await deps.graphCoordinator.run({
        graph: finalValidated,
        callerSessionKey: rawParams._callerSessionKey as string | undefined,
        callerAgentId: rawParams._agentId as string | undefined,
        callerCaps: rawParams._capabilities as AgentCapability[] | undefined,
        callerRootRunId: rawParams._rootRunId as string | undefined,
        callerLeaseId: rawParams._leaseId as string | undefined,
        callerDeliveryOrigin: tryGetContext()?.deliveryOrigin,
        announceChannelType: rawParams._callerChannelType as string | undefined,
        announceChannelId: rawParams._callerChannelId as string | undefined,
        nodeProgress: userParams.node_progress === true,
      });

      if (!coordResult.ok) {
        throw new Error(coordResult.error);
      }

      const graphId = coordResult.value;

      deps.logger?.info(
        { graphId, nodeCount: finalValidated.graph.nodes.length, method: "graph.execute" },
        "Graph execution started",
      );

      const result: Record<string, unknown> = {
        graphId,
        async: true,
        nodeCount: finalValidated.graph.nodes.length,
        label: finalValidated.graph.label,
        hint: "Pipeline launched — your job is now DONE. Tell the user the pipeline is running (and what it will produce), then STOP. Do NOT research this topic yourself, do NOT call more tools, and do NOT poll with status/cron: the sub-agents are doing the work in isolated contexts and you will be notified automatically with results when it completes. Duplicating their research here only exhausts your own context window.",
        ...(unresolvedWarnings.length > 0 && { warnings: unresolvedWarnings }),
      };
      if (IS_DEV) GraphExecuteContract.response.parse(result);
      return result;
    },

    [GraphCancelContract.method]: async (rawParams) => {
      // In-process capability gate (see graph.define).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:graph");

      // Bespoke pre-Zod validation FIRST.
      if (!deps.securityConfig.agentToAgent?.enabled) {
        throw new Error("Agent-to-agent messaging is disabled by policy.");
      }

      const cancelGraphId = rawParams.graphId ?? rawParams.graph_id;
      if (!cancelGraphId) {
        throw new Error("Missing required parameter: graphId");
      }

      const userParams = stripInternalFields(rawParams);
      GraphCancelContract.request.parse(userParams);

      const cancelled = deps.graphCoordinator.cancel(cancelGraphId as string);
      if (!cancelled) {
        throw new Error("Graph not found or already terminal");
      }

      deps.logger?.info(
        { graphId: cancelGraphId, method: "graph.cancel" },
        "Graph cancelled",
      );

      const result = { cancelled: true, graphId: cancelGraphId as string };
      if (IS_DEV) GraphCancelContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------
    // Named graph persistence
    // -----------------------------------------------------------------

    [GraphSaveContract.method]: async (rawParams) => {
      // In-process capability gate (see graph.define).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:graph");

      // Bespoke pre-Zod validation FIRST.
      if (!deps.namedGraphStore) {
        throw new Error("Named graph storage not available");
      }

      const label = rawParams.label as string | undefined;
      if (!label || typeof label !== "string" || label.trim().length === 0) {
        throw new Error("Missing required parameter: label (non-empty string)");
      }

      const userParams = stripInternalFields(rawParams);
      GraphSaveContract.request.parse(userParams);

      const id = (rawParams.id as string) ?? randomUUID();
      const tenantId = deps.tenantId ?? "default";
      const agentId = (rawParams.agentId as string) ?? deps.defaultAgentId;

      // Validate structure (typeId/typeConfig pairing, DAG sort, Zod schema).
      // Server-side gated tier — see graph.define.
      // FLAGS-OFF ⇒ undefined ⇒ capable direct path (byte-identical).
      const capabilityClass = resolveAuthoringTier(deps, rawParams);
      const validated = await buildGraphInput(userParams, capabilityClass, repairContext(deps, rawParams));
      validateTypeConfigs(validated.graph, deps.nodeTypeRegistry);

      // Deliberate: persists the ORIGINAL raw nodes, not the validated/repaired graph — the raw form preserves the author's input verbatim, and a loaded graph passes through buildGraphInput validation again when executed.
      deps.namedGraphStore.save({
        id,
        tenantId,
        agentId,
        label: label.trim(),
        nodes: (rawParams.nodes as unknown[]) ?? [],
        edges: (rawParams.edges as unknown[]) ?? [],
        settings: rawParams.settings ?? {},
      });

      const result = { id, saved: true };
      if (IS_DEV) GraphSaveContract.response.parse(result);
      return result;
    },

    [GraphDeleteContract.method]: async (rawParams) => {
      // In-process capability gate (see graph.define).
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
      GraphDeleteContract.request.parse(userParams);

      const tenantId = deps.tenantId ?? "default";
      const deleted = deps.namedGraphStore.softDelete(id, tenantId);
      if (!deleted) {
        throw new PreconditionError("Named graph not found");
      }

      const result = { id, deleted: true };
      if (IS_DEV) GraphDeleteContract.response.parse(result);
      return result;
    },

    [GraphDeleteRunContract.method]: async (rawParams) => {
      // In-process capability gate (see graph.define).
      // graph.deleteRun is a mutating graph op → orch:graph (HANDLER_CAPABILITY_MAP).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:graph");

      // Bespoke pre-Zod validation FIRST.
      const graphId = rawParams.graphId ?? rawParams.graph_id;
      if (!graphId || typeof graphId !== "string") {
        throw new Error("Missing required parameter: graphId");
      }

      if (!deps.dataDir) {
        throw new Error("dataDir not configured — cannot delete graph run");
      }

      const userParams = stripInternalFields(rawParams);
      GraphDeleteRunContract.request.parse(userParams);

      const graphDir = safePath(deps.dataDir, "graph-runs", graphId);
      if (!existsSync(graphDir)) {
        throw new Error("Graph run not found");
      }

      rmSync(graphDir, { recursive: true, force: true });

      const result = { graphId, deleted: true };
      if (IS_DEV) GraphDeleteRunContract.response.parse(result);
      return result;
    },
  };
}
