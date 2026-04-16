/**
 * Pipeline execution graph management tool: multi-action tool for defining,
 * executing, monitoring, canceling, saving, loading, listing, deleting,
 * and retrieving outputs from execution graphs (DAG pipelines).
 *
 * Supports 9 actions: define, execute (default), status, cancel, save, load, list, delete, outputs.
 * Cancel and delete actions are gated via action classifier.
 * Save/load/list/delete delegate to named graph persistence RPCs.
 * All actions delegate to the graph backend via rpcCall indirection.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { ApprovalGate } from "@comis/core";
import { tryGetContext } from "@comis/core";
import {
  jsonResult,
  readStringParam,
  readNumberParam,
  readEnumParam,
  throwToolError,
  createActionGate,
} from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

/** TypeBox schema for a single pipeline node definition. */
const PipelineNode = Type.Object({
  node_id: Type.String({ description: "Unique node identifier within the graph" }),
  task: Type.String({ description: "Task description for this node. Use {{nodeId.result}} to inline upstream node output (nodeId must be in depends_on). Use ${VARIABLE_NAME} for user-provided inputs." }),
  depends_on: Type.Optional(
    Type.Array(Type.String(), { description: "Node IDs this node depends on" }),
  ),
  agent: Type.Optional(
    Type.String({ description: "Agent ID to run this node (default: caller's agent)" }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model override for this node" }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({ description: "Per-node timeout in milliseconds (default: 300000 — 5 minutes). Nodes with tool calls (web search, MCP, etc.) typically need 2-4 minutes. Debate and collaborate nodes need longer (5-8 minutes per round). Prefer the default unless you have a specific reason to change it." }),
  ),
  max_steps: Type.Optional(
    Type.Integer({ description: "Maximum execution steps for this node" }),
  ),
  barrier_mode: Type.Optional(
    Type.Union(
      [Type.Literal("all"), Type.Literal("majority"), Type.Literal("best-effort")],
      { description: "Barrier mode for fan-in nodes. Valid values: all (wait for every dependency, default), majority (proceed when >50% deps complete), best-effort (proceed when any dep completes)" },
    ),
  ),
  retries: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 3,
      description: "Number of automatic retries on failure with exponential backoff (0-3, default: 0). Retry delays: 1s, 2s, 4s.",
    }),
  ),
  type_id: Type.Optional(Type.Union([
    Type.Literal("agent"),
    Type.Literal("debate"),
    Type.Literal("vote"),
    Type.Literal("refine"),
    Type.Literal("collaborate"),
    Type.Literal("approval-gate"),
    Type.Literal("map-reduce"),
  ], {
    description: `Built-in node type. If omitted, runs as regular single-agent task. Valid values: agent (single sub-agent, ~1 LLM call), debate (multi-round adversarial, ~N*R calls), vote (parallel independent voting, ~N calls), refine (sequential review chain, ~N calls), collaborate (sequential building, ~N*R calls), approval-gate (pause for human approval, 0 calls), map-reduce (parallel map then reduce, ~N+1 calls)`
  })),
  type_config: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: `Configuration for the node type. Required when type_id is set. Examples:
  agent:         { "agent": "ta-analyst" }
  debate:        { "agents": ["ta-bull", "ta-bear"], "rounds": 2, "synthesizer": "ta-judge" }
  vote:          { "voters": ["analyst-1", "analyst-2", "analyst-3"] }
  refine:        { "reviewers": ["drafter", "editor", "pm"] }
  collaborate:   { "agents": ["team-1", "team-2"], "rounds": 1 }
  approval-gate: { "message": "Approve the trade?", "timeout_minutes": 60 }
  map-reduce:    { "mappers": [{"agent": "a1"}, {"agent": "a2"}], "reducer": "pm" }`
  })),
  context_mode: Type.Optional(
    Type.Union(
      [Type.Literal("full"), Type.Literal("summary"), Type.Literal("none")],
      { description: "Context verbosity mode. Valid values: full (complete upstream outputs, default), summary (500 chars + shared dir reference), none (no upstream outputs, use {{nodeId.result}} for explicit data)" },
    ),
  ),
  mcp_servers: Type.Optional(
    Type.Array(Type.String(), { description: "MCP server names whose tools should be pre-discovered for this node. Example: [\"yfinance\"] pre-seeds all yfinance tools so the sub-agent skips discover_tools calls." }),
  ),
});

const PipelineParams = Type.Object({
  action: Type.Optional(
    Type.Union(
      [
        Type.Literal("define"),
        Type.Literal("execute"),
        Type.Literal("status"),
        Type.Literal("cancel"),
        Type.Literal("save"),
        Type.Literal("load"),
        Type.Literal("list"),
        Type.Literal("delete"),
        Type.Literal("outputs"),
      ],
      { description: "Pipeline action (default: execute). Valid values: define (validate graph structure), execute (run pipeline), status (check graph state), cancel (terminate running graph), save (persist named graph), load (retrieve saved graph), list (enumerate saved graphs), delete (soft-delete saved graph), outputs (retrieve node results)" },
    ),
  ),
  nodes: Type.Optional(
    Type.Array(PipelineNode, {
      description: "Array of node definitions for the execution graph",
    }),
  ),
  label: Type.Optional(
    Type.String({ description: "Human-readable label for the graph" }),
  ),
  on_failure: Type.Optional(
    Type.Union(
      [Type.Literal("fail-fast"), Type.Literal("continue")],
      { description: "Failure strategy (default: fail-fast). Valid values: fail-fast (abort pipeline on first error), continue (skip failed node, proceed)" },
    ),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({ description: "Overall graph timeout in milliseconds (default: 1500000 — 25 minutes). Heuristic: estimate ~3 minutes per node, double for debate/collaborate rounds. Multi-phase pipelines with debate rounds typically need 25-30 minutes. Do NOT lower below the default unless the graph is trivially small (2-3 simple nodes)." }),
  ),
  graph_id: Type.Optional(
    Type.String({ description: "Graph ID for status/cancel queries" }),
  ),
  id: Type.Optional(
    Type.String({ description: "Named graph ID for save/load/delete" }),
  ),
  edges: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Optional(Type.String({ description: "Edge identifier (auto-generated as 'source->target' if omitted)" })),
        source: Type.Optional(Type.String({ description: "Source node ID" })),
        target: Type.Optional(Type.String({ description: "Target node ID" })),
        from: Type.Optional(Type.String({ description: "Alias for source (normalized automatically)" })),
        to: Type.Optional(Type.String({ description: "Alias for target (normalized automatically)" })),
      }),
      { description: "Edge definitions for the graph" },
    ),
  ),
  settings: Type.Optional(
    Type.Unknown({ description: "Graph settings object" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Max entries to return (for list)" }),
  ),
  offset: Type.Optional(
    Type.Integer({ description: "Pagination offset (for list)" }),
  ),
  recent_minutes: Type.Optional(
    Type.Integer({ description: "Include graphs from last N minutes (for status listing)" }),
  ),
  _confirmed: Type.Optional(
    Type.Boolean({
      description:
        "Set to true when re-calling a destructive action after user approval. " +
        "When a gated action returns requiresConfirmation, present the action to the user, " +
        "and after they approve, call the same action again with _confirmed: true.",
    }),
  ),
  budget: Type.Optional(
    Type.Object({
      max_tokens: Type.Optional(Type.Integer({ description: "Maximum total tokens across all nodes" })),
      max_cost: Type.Optional(Type.Number({ description: "Maximum total cost across all nodes" })),
    }, { description: "Resource budget limits for the graph" }),
  ),
  variables: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Key-value map of ${VAR} substitutions to apply before execution",
    }),
  ),
});

type PipelineParamsType = Static<typeof PipelineParams>;

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger for structured tool logging. */
interface ToolLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Transform snake_case node params to camelCase for RPC calls.
 * Also handles camelCase inputs (e.g., from graph.load) via ?? fallbacks.
 */
function transformNodes(
  nodes: Static<typeof PipelineNode>[],
): Record<string, unknown>[] {
  return nodes.map((node) => {
    // Cast to access both snake_case and camelCase fields
    // (loaded nodes from graph.load are already camelCase)
    const n = node as Record<string, unknown>;
    const nodeId = node.node_id ?? n.nodeId;
    const dependsOn = node.depends_on ?? n.dependsOn;
    const agent = node.agent ?? n.agentId;
    const timeoutMs = node.timeout_ms ?? n.timeoutMs;
    const maxSteps = node.max_steps ?? n.maxSteps;
    const barrierMode = node.barrier_mode ?? n.barrierMode;
    const contextMode = node.context_mode ?? n.contextMode;
    const mcpServers = (n.mcp_servers as string[] | undefined) ?? (n.mcpServers as string[] | undefined);
    return {
      nodeId,
      task: node.task,
      ...(dependsOn !== undefined && { dependsOn }),
      ...(agent !== undefined && { agent }),
      ...(node.model !== undefined && { model: node.model }),
      ...(timeoutMs !== undefined && { timeoutMs }),
      ...(maxSteps !== undefined && { maxSteps }),
      ...(barrierMode !== undefined && { barrierMode }),
      ...(node.retries !== undefined && { retries: node.retries }),
      ...(n.type_id ?? n.typeId ? { typeId: n.type_id ?? n.typeId } : {}),
      ...(n.type_config ?? n.typeConfig ? { typeConfig: n.type_config ?? n.typeConfig } : {}),
      ...(contextMode !== undefined && { contextMode }),
      ...(mcpServers !== undefined && mcpServers.length > 0 && { mcpServers }),
    };
  });
}

/** Normalized edge shape matching the web frontend's PipelineEdge interface. */
interface NormalizedEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * Normalize LLM-sent edges: convert from/to -> source/target,
 * auto-generate id.
 * Edges missing both source/from or target/to are silently dropped.
 */
function normalizeEdges(
  edges: { id?: string; source?: string; target?: string; from?: string; to?: string }[],
): NormalizedEdge[] {
  const result: NormalizedEdge[] = [];
  for (const edge of edges) {
    const source = edge.source ?? edge.from;
    const target = edge.target ?? edge.to;
    if (source === undefined || target === undefined) continue;
    result.push({
      id: edge.id ?? `${source}->${target}`,
      source,
      target,
    });
  }
  return result;
}

/**
 * Derive edges from node dependsOn when no explicit edges are provided.
 * Creates an edge for each dependency.
 */
function deriveEdgesFromDependsOn(
  nodes: Static<typeof PipelineNode>[],
): NormalizedEdge[] {
  const edges: NormalizedEdge[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.depends_on) {
      for (const dep of node.depends_on) {
        const key = `${dep}->${node.node_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ id: key, source: dep, target: node.node_id });
      }
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a pipeline execution graph management tool with 9 actions.
 *
 * The cancel and delete actions are gated via createActionGate. Execute is
 * the default action when no action is specified. Define validates the graph
 * structure without executing. Status retrieves graph state. Cancel terminates
 * a running graph. Save persists a named graph. Load retrieves a saved graph.
 * List enumerates saved graphs. Delete soft-deletes a saved graph.
 * Outputs retrieves node output values.
 *
 * @param rpcCall - RPC call function for delegating to the graph backend
 * @param logger - Optional structured logger for DEBUG-level operation logging
 * @param approvalGate - Optional approval gate for save and execute actions
 * @returns AgentTool implementing the pipeline management interface
 */
const VALID_ACTIONS = ["define", "execute", "status", "cancel", "save", "load", "list", "delete", "outputs"] as const;

export function createPipelineTool(rpcCall: RpcCall, logger?: ToolLogger, approvalGate?: ApprovalGate): AgentTool<typeof PipelineParams> {
  const cancelGate = createActionGate("graph.cancel");
  const deleteGate = createActionGate("graph.delete");

  // Session-scoped cache: stores the last define/execute graph so that
  // save can reference it without the LLM re-sending the full definition.
  let lastDefinedGraph: {
    nodes: Static<typeof PipelineNode>[];
    label?: string;
    edges?: NormalizedEdge[];
    onFailure?: string;
    timeoutMs?: number;
    budget?: { maxTokens?: number; maxCost?: number };
  } | undefined;

  return {
    name: "pipeline",
    label: "Pipeline",
    description:
      "Define, execute, monitor, cancel multi-node execution graphs (DAG pipelines). " +
      "When asked to create/build a pipeline, use action=save to persist it as a reusable template with ${VARIABLE} placeholders. " +
      "Use action=execute for running saved pipelines (load by id) or explicit one-shot requests.",
    parameters: PipelineParams,

    async execute(
      _toolCallId: string,
      params: PipelineParamsType,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const rawAction = readStringParam(p, "action", false) ?? "execute";
        // Validate action (handles optional default of "execute")
        if (!VALID_ACTIONS.includes(rawAction as typeof VALID_ACTIONS[number])) {
          throwToolError("invalid_action", `Invalid action: "${rawAction}".`, {
            validValues: [...VALID_ACTIONS],
            param: "action",
            hint: "Use one of the listed values for action.",
          });
        }
        const action = rawAction as typeof VALID_ACTIONS[number];

        if (action === "define") {
          const nodes = params.nodes;
          if (!nodes || nodes.length === 0) {
            throwToolError("missing_param", "Missing required parameter: nodes.", {
              param: "nodes",
              hint: "Provide an array of pipeline node definitions.",
            });
          }
          logger?.debug({ toolName: "pipeline", action: "define", nodeCount: nodes.length }, "Pipeline graph defined");
          const normalizedEdges = params.edges ? normalizeEdges(params.edges) : [];
          const result = await rpcCall("graph.define", {
            nodes: transformNodes(nodes),
            ...(params.label !== undefined && { label: params.label }),
            ...(params.on_failure !== undefined && { onFailure: params.on_failure }),
            ...(params.timeout_ms !== undefined && { timeoutMs: params.timeout_ms }),
            ...(params.budget !== undefined && {
              budget: {
                ...(params.budget.max_tokens !== undefined && { maxTokens: params.budget.max_tokens }),
                ...(params.budget.max_cost !== undefined && { maxCost: params.budget.max_cost }),
              },
            }),
            ...(normalizedEdges.length > 0 && { edges: normalizedEdges }),
          });
          // Cache the defined graph so save can reference it
          lastDefinedGraph = {
            nodes,
            ...(params.label !== undefined && { label: params.label }),
            ...(normalizedEdges.length > 0 && { edges: normalizedEdges }),
            ...(params.on_failure !== undefined && { onFailure: params.on_failure }),
            ...(params.timeout_ms !== undefined && { timeoutMs: params.timeout_ms }),
            ...(params.budget !== undefined && {
              budget: {
                ...(params.budget.max_tokens !== undefined && { maxTokens: params.budget.max_tokens }),
                ...(params.budget.max_cost !== undefined && { maxCost: params.budget.max_cost }),
              },
            }),
          };
          return jsonResult(result);
        }

        if (action === "execute") {
          let nodes = params.nodes;
          let label = params.label;

          // Load saved pipeline when id provided without inline nodes
          if ((!nodes || (Array.isArray(nodes) && nodes.length === 0)) && params.id) {
            const loaded = await rpcCall("graph.load", { id: params.id }) as Record<string, unknown>;
            nodes = loaded.nodes as typeof params.nodes;
            label = label ?? loaded.label as string;
            if (!params.edges && loaded.edges) {
              params.edges = loaded.edges as NonNullable<typeof params.edges>;
            }
            if (params.on_failure === undefined && loaded.settings) {
              const settings = loaded.settings as Record<string, unknown>;
              if (settings.onFailure !== undefined) params.on_failure = settings.onFailure as "fail-fast" | "continue";
            }
            if (params.timeout_ms === undefined && loaded.settings) {
              const settings = loaded.settings as Record<string, unknown>;
              if (settings.timeoutMs !== undefined) params.timeout_ms = settings.timeoutMs as number;
            }
          }

          if (!nodes || nodes.length === 0) {
            throwToolError("missing_param", "Missing required parameter: nodes (provide nodes or id of a saved pipeline).", {
              param: "nodes",
              hint: "Provide nodes directly or reference a saved pipeline by id.",
            });
          }
          // Approval gate check for execute
          if (approvalGate) {
            const ctx = tryGetContext();
            const resolution = await approvalGate.requestApproval({
              toolName: "pipeline",
              action: "graph.execute",
              params: { nodeCount: nodes.length, label },
              agentId: ctx?.userId ?? "unknown",
              sessionKey: ctx?.sessionKey ?? "unknown",
              trustLevel: (ctx?.trustLevel ?? "guest") as "admin" | "user" | "guest",
              channelType: ctx?.channelType,
            });
            if (!resolution.approved) {
              throwToolError(
                "permission_denied",
                `Action denied: graph.execute was not approved.`,
                { hint: resolution.reason ?? "no reason given" },
              );
            }
          }
          logger?.debug({ toolName: "pipeline", action: "execute", nodeCount: nodes.length }, "Pipeline graph executing");
          const execEdges = params.edges ? normalizeEdges(params.edges) : [];
          const result = await rpcCall("graph.execute", {
            nodes: transformNodes(nodes),
            ...(label !== undefined && { label }),
            ...(params.on_failure !== undefined && { onFailure: params.on_failure }),
            ...(params.timeout_ms !== undefined && { timeoutMs: params.timeout_ms }),
            ...(params.budget !== undefined && {
              budget: {
                ...(params.budget.max_tokens !== undefined && { maxTokens: params.budget.max_tokens }),
                ...(params.budget.max_cost !== undefined && { maxCost: params.budget.max_cost }),
              },
            }),
            ...(execEdges.length > 0 && { edges: execEdges }),
            ...(params.variables !== undefined && { variables: params.variables }),
            node_progress: false,
          });
          // Cache the graph so save can reference it
          lastDefinedGraph = {
            nodes,
            ...(label !== undefined && { label }),
            ...(execEdges.length > 0 && { edges: execEdges }),
            ...(params.on_failure !== undefined && { onFailure: params.on_failure }),
            ...(params.timeout_ms !== undefined && { timeoutMs: params.timeout_ms }),
            ...(params.budget !== undefined && {
              budget: {
                ...(params.budget.max_tokens !== undefined && { maxTokens: params.budget.max_tokens }),
                ...(params.budget.max_cost !== undefined && { maxCost: params.budget.max_cost }),
              },
            }),
          };
          return jsonResult(result);
        }

        if (action === "status") {
          const graphId = readStringParam(p, "graph_id", false);
          const recentMinutes = readNumberParam(p, "recent_minutes", false);
          logger?.debug({ toolName: "pipeline", action: "status", graphId }, "Pipeline status queried");
          const result = await rpcCall("graph.status", {
            ...(graphId !== undefined && { graphId }),
            ...(recentMinutes !== undefined && { recentMinutes }),
          });
          return jsonResult(result);
        }

        if (action === "cancel") {
          const gate = cancelGate(p);
          if (gate.requiresConfirmation) {
            return jsonResult({
              requiresConfirmation: true,
              actionType: gate.actionType,
              hint: "Ask the user to confirm this graph cancellation, then call again with _confirmed: true.",
            });
          }
          const graphId = readStringParam(p, "graph_id");
          logger?.debug({ toolName: "pipeline", action: "cancel", graphId }, "Pipeline graph cancelled");
          const result = await rpcCall("graph.cancel", { graphId });
          return jsonResult(result);
        }

        if (action === "save") {
          // Fall back to cached graph from last define/execute when params are omitted
          const nodes = params.nodes ?? lastDefinedGraph?.nodes;
          if (!nodes || nodes.length === 0) {
            throwToolError("missing_param", "Missing required parameter: nodes (either provide nodes or call define first).", {
              param: "nodes",
              hint: "Provide nodes directly or call define first to cache the graph.",
            });
          }
          const label = readStringParam(p, "label", false) ?? lastDefinedGraph?.label;
          if (!label) {
            throwToolError("missing_param", "Missing required parameter: label.", {
              param: "label",
              hint: "Provide a human-readable label for the saved pipeline.",
            });
          }
          // Approval gate check for save
          if (approvalGate) {
            const ctx = tryGetContext();
            const resolution = await approvalGate.requestApproval({
              toolName: "pipeline",
              action: "graph.save",
              params: { label, nodeCount: nodes.length },
              agentId: ctx?.userId ?? "unknown",
              sessionKey: ctx?.sessionKey ?? "unknown",
              trustLevel: (ctx?.trustLevel ?? "guest") as "admin" | "user" | "guest",
              channelType: ctx?.channelType,
            });
            if (!resolution.approved) {
              throwToolError(
                "permission_denied",
                `Action denied: graph.save was not approved.`,
                { hint: resolution.reason ?? "no reason given" },
              );
            }
          }
          const id = readStringParam(p, "id", false);
          const explicitEdges = normalizeEdges((params.edges ?? []) as Static<typeof PipelineParams>["edges"] & object);
          const cachedEdges = lastDefinedGraph?.edges ?? [];
          const finalEdges = explicitEdges.length > 0
            ? explicitEdges
            : cachedEdges.length > 0
              ? cachedEdges
              : deriveEdgesFromDependsOn(nodes);
          const settings = params.settings ?? {};
          logger?.debug({ toolName: "pipeline", action: "save", label, fromCache: !params.nodes }, "Pipeline graph saved");
          const result = await rpcCall("graph.save", {
            label,
            nodes: transformNodes(nodes),
            ...(id !== undefined && { id }),
            edges: finalEdges,
            settings,
          });
          return jsonResult(result);
        }

        if (action === "load") {
          const id = readStringParam(p, "id");
          logger?.debug({ toolName: "pipeline", action: "load", id }, "Pipeline graph loaded");
          const result = await rpcCall("graph.load", { id });
          return jsonResult(result);
        }

        if (action === "list") {
          const limit = readNumberParam(p, "limit", false);
          const offset = readNumberParam(p, "offset", false);
          logger?.debug({ toolName: "pipeline", action: "list" }, "Pipeline graphs listed");
          const result = await rpcCall("graph.list", {
            ...(limit !== undefined && { limit }),
            ...(offset !== undefined && { offset }),
          });
          return jsonResult(result);
        }

        if (action === "delete") {
          const gate = deleteGate(p);
          if (gate.requiresConfirmation) {
            return jsonResult({
              requiresConfirmation: true,
              actionType: gate.actionType,
              hint: "Ask the user to confirm this graph deletion, then call again with _confirmed: true.",
            });
          }
          const id = readStringParam(p, "id");
          logger?.debug({ toolName: "pipeline", action: "delete", id }, "Pipeline graph deleted");
          const result = await rpcCall("graph.delete", { id });
          return jsonResult(result);
        }

        // action === "outputs"
        const graphId = readStringParam(p, "graph_id");
        logger?.debug({ toolName: "pipeline", action: "outputs", graphId }, "Pipeline graph outputs queried");
        const result = await rpcCall("graph.outputs", { graphId });
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
