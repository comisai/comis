// SPDX-License-Identifier: Apache-2.0
/**
 * Unified tool deferral engine: replaces the MCP-only applyMcpToolDeferral()
 * with rule-based, budget-based, and small-model deferral, plus BM25-scored
 * discover_tools for searching deferred tools.
 *
 * Deferral model (exclude model): Deferred tools are removed from the tools
 * parameter entirely and partitioned into a DeferredToolEntry list. A
 * discover_tools tool is appended when deferred entries exist, allowing the
 * LLM to search and fetch full schemas on demand. Discovered tools (tracked
 * via DiscoveryTracker) are re-included in the active context with their
 * original schemas. This achieves ~81% token savings for 100 tools compared
 * to the previous description-swap (pre-register) model.
 *
 * @module
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ComisLogger } from "@comis/infra";
import type { EmbeddingPort } from "@comis/core";
import { getToolMetadata } from "@comis/core";
import type { DiscoveryTracker } from "./discovery-tracker.js";
import { extractMcpServerName } from "../bridge/bridge-event-handlers.js";
import { PRIVILEGED_TOOL_NAMES } from "../bootstrap/sections/tooling-sections.js";
import type { ModelTier } from "../bootstrap/sections/tooling-sections.js";
import { LEAN_TOOL_DESCRIPTIONS } from "../bootstrap/sections/tool-descriptions.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeferralRule {
  /** Tool names that can be deferred under this rule. */
  tools: string[];
  /** Condition that KEEPS the tool active (not deferred). When false, tool is deferred. */
  activeWhen: (ctx: DeferralContext) => boolean;
  /** Namespace label for the discovery tool listing. */
  namespace: string;
  /** Brief description for the discovery tool. */
  namespaceDescription: string;
}

export interface DeferralContext {
  trustLevel: string;
  channelType?: string;
  modelTier: ModelTier;
  recentlyUsedToolNames: Set<string>;
  toolNames: string[];
  contextEngineVersion?: string;
  /** Tool names demoted by lifecycle management. When provided, these tools
   *  are treated as an additional deferral source so discover_tools covers them. */
  lifecycleDemotedNames?: Set<string>;
  /** Session-scoped discovery tracker for re-including discovered tools. */
  discoveryTracker: DiscoveryTracker;
  /** Operator override: tools that should never be deferred (from config.deferredTools.neverDefer). */
  neverDefer?: string[];
  /** Operator override: tools that should always be deferred (from config.deferredTools.alwaysDefer). */
  alwaysDefer?: string[];
  /** Provider family for mid-turn injection awareness.
   *  "anthropic" and "google" support mid-turn tool injection, so MCP tools
   *  can be deferred behind discover_tools. Other providers (e.g., "openai",
   *  "default") do not inject mid-turn, so MCP tools must be active from the
   *  start. When undefined, defaults to deferring (backward compat). */
  providerFamily?: string;
  /** Names of tools currently ACTIVE in this session (post-deferral).
   *  Consumed by discover_tools to return "already active" guidance when
   *  queries re-ask for loaded MCPs. Must NOT include names that were
   *  deferred -- pass the post-deferral set, not mergedCustomTools. */
  activeToolNames?: ReadonlySet<string>;
}

/** Entry describing a deferred tool with its display description and original definition. */
export interface DeferredToolEntry {
  name: string;
  description: string;
  original: ToolDefinition;
}

/** Result of the exclude-model deferral: tools partitioned into active, deferred, and discovered. */
export interface ExcludeDeferralResult {
  /** Tools to include in the LLM tools parameter (non-deferred). */
  activeTools: ToolDefinition[];
  /** Deferred tools not yet discovered (excluded from tools parameter). */
  deferredEntries: DeferredToolEntry[];
  /** Previously discovered tools re-included with full original schemas. */
  discoveredTools: ToolDefinition[];
  /** The discover_tools tool definition, or null when nothing is deferred. */
  discoverTool: ToolDefinition | null;
  /** Total number of tools in the deferral set (before discovery re-inclusion). */
  deferredCount: number;
  /** Names of all tools in the deferral set (before discovery re-inclusion). */
  deferredNames: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Declarative deferral rules. Each rule specifies tools to defer and the
 * condition under which they remain active.
 */
export const DEFERRAL_RULES: DeferralRule[] = [
  {
    tools: [...PRIVILEGED_TOOL_NAMES],
    activeWhen: (ctx) => ctx.trustLevel === "admin",
    namespace: "admin",
    namespaceDescription: "Fleet management, observability, session/memory/channel/token/skill/MCP admin (requires admin trust)",
  },
  {
    tools: ["discord_action"],
    activeWhen: (ctx) => ctx.channelType === "discord",
    namespace: "discord",
    namespaceDescription: "Discord-specific actions (pin, kick, ban, roles, threads, channels)",
  },
  {
    tools: ["telegram_action"],
    activeWhen: (ctx) => ctx.channelType === "telegram",
    namespace: "telegram",
    namespaceDescription: "Telegram-specific actions (pin, poll, sticker, chat admin, topics)",
  },
  {
    tools: ["slack_action"],
    activeWhen: (ctx) => ctx.channelType === "slack",
    namespace: "slack",
    namespaceDescription: "Slack-specific actions (pin, topic, archive, channels)",
  },
  {
    tools: ["whatsapp_action"],
    activeWhen: (ctx) => ctx.channelType === "whatsapp",
    namespace: "whatsapp",
    namespaceDescription: "WhatsApp-specific actions (group management, settings)",
  },
];

/**
 * Core tools that remain active even under aggressive small-model deferral.
 * These are the essential tools for basic file/exec/memory/web operations.
 */
export const CORE_TOOLS = new Set([
  "read", "edit", "write", "grep", "find", "ls", "apply_patch",
  "exec", "process",
  "message",
  "memory_search", "memory_store", "memory_get",
  "web_search", "web_fetch",
]);

// ---------------------------------------------------------------------------
// ModelTier resolution
// ---------------------------------------------------------------------------

/**
 * Classify a model by its context window size into small/medium/large tiers.
 *
 * - small (<= 32K): Aggressive deferral, 0.0 temperature
 * - medium (<= 64K): Standard deferral, 0.1 temperature
 * - large (> 64K): Standard deferral, 0.1 temperature
 */
export function resolveModelTier(contextWindow: number): ModelTier {
  if (contextWindow <= 32_000) return "small";
  if (contextWindow <= 64_000) return "medium";
  return "large";
}

// ---------------------------------------------------------------------------
// Tool calling temperature
// ---------------------------------------------------------------------------

/**
 * Resolve the optimal tool-calling temperature for a given model tier.
 * Small models benefit from deterministic tool selection (0.0).
 */
export function resolveToolCallingTemperature(modelTier: ModelTier): number {
  return modelTier === "small" ? 0.0 : 0.1;
}

// ---------------------------------------------------------------------------
// Recently-used tool extraction
// ---------------------------------------------------------------------------

/**
 * Extract recently-used tool names from session history messages.
 * Looks at the most recent N assistant messages for tool_use blocks.
 *
 * @param messages - Session context messages (AgentMessage[] or SDK Message[])
 * @param lookbackCount - Number of recent messages to scan (default: 20)
 * @returns Set of tool names used recently
 */
export function extractRecentlyUsedToolNames(
  messages: Array<Record<string, unknown>>,
  lookbackCount: number = 20,
): Set<string> {
  const names = new Set<string>();
  const startIdx = Math.max(0, messages.length - lookbackCount);
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === "tool_use" && typeof block.name === "string") {
            names.add(block.name);
          }
        }
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Shared description resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the lean display description for a tool.
 * Lookup chain: dynamic builder -> static lean -> original description -> tool name.
 * Used for both DeferredToolEntry.description and discover_tools output.
 * Does NOT include searchHint (display-only).
 */
export function resolveToolDescription(tool: ToolDefinition): string {
  const entry = LEAN_TOOL_DESCRIPTIONS[tool.name];
  if (typeof entry === "function") {
    return entry({ modelTier: "large" });
  }
  if (typeof entry === "string") return entry;
  return tool.description ?? tool.name;
}

// ---------------------------------------------------------------------------
// Deferred tools context block
// ---------------------------------------------------------------------------

/**
 * Build a `<deferred-tools>` XML block for dynamic preamble injection.
 * Lists deferred tool names and descriptions so the LLM knows what's
 * available behind discover_tools.
 *
 * @param entries - Deferred tool entries (remaining after discovery re-inclusion)
 * @returns XML block string, or empty string when no entries
 */
export function buildDeferredToolsContext(entries: DeferredToolEntry[]): string {
  if (entries.length === 0) return "";

  // Separate MCP tools (group by server) from non-MCP tools (individual listing)
  const mcpByServer = new Map<string, DeferredToolEntry[]>();
  const nonMcpEntries: DeferredToolEntry[] = [];

  for (const e of entries) {
    const server = extractMcpServerName(e.name);
    if (server) {
      const list = mcpByServer.get(server) ?? [];
      list.push(e);
      mcpByServer.set(server, list);
    } else {
      nonMcpEntries.push(e);
    }
  }

  const lines: string[] = [];

  // Non-MCP tools: individual listing (existing format)
  for (const e of nonMcpEntries) {
    lines.push(`${e.name} -- ${e.description}`);
  }

  // MCP tools: grouped by server with short names
  for (const [server, tools] of mcpByServer) {
    const prefix = `mcp__${server}--`;
    const shortNames = tools.map(t => t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name);
    lines.push(`[${server}] (${tools.length} tools): ${shortNames.join(", ")}`);
  }

  return [
    "<deferred-tools>",
    "The following tools are available but not loaded.",
    "Call discover_tools to search by keyword or server name (e.g., discover_tools(\"yfinance\")).",
    "",
    ...lines,
    "</deferred-tools>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main deferral function
// ---------------------------------------------------------------------------

/**
 * Apply unified tool deferral: rule-based, budget-based, small-model,
 * lifecycle merge, and operator overrides.
 *
 * Exclude model: deferred tools are removed from the tools parameter entirely
 * and partitioned into DeferredToolEntry[]. Discovered tools (via
 * DiscoveryTracker) are re-included with their full original schemas.
 * A discover_tools tool is created when remaining deferred entries exist.
 *
 * @param tools - Full list of custom tools (may include MCP tools)
 * @param contextWindow - Model context window in tokens
 * @param deferralContext - Session context for deferral decisions
 * @param logger - Logger for INFO/WARN output
 * @param embeddingPort - Optional embedding port for semantic search in discover_tools
 * @returns Partitioned tools and deferral metadata
 */
export function applyToolDeferral(
  tools: ToolDefinition[],
  _contextWindow: number,
  deferralContext: DeferralContext,
  logger: ComisLogger,
  embeddingPort?: EmbeddingPort,
  scoreConfig?: ToolDiscoveryScoreConfig,
): ExcludeDeferralResult {
  const deferredSet = new Set<string>();
  const originalToolMap = new Map<string, ToolDefinition>();
  for (const t of tools) {
    originalToolMap.set(t.name, t);
  }

  // Phase 1: Rule-based deferral
  for (const rule of DEFERRAL_RULES) {
    if (!rule.activeWhen(deferralContext)) {
      for (const toolName of rule.tools) {
        if (originalToolMap.has(toolName) && !deferralContext.recentlyUsedToolNames.has(toolName)) {
          deferredSet.add(toolName);
        }
      }
    }
  }

  // Phase 2: MCP tools deferred by default (only for providers with mid-turn injection)
  // Providers without mid-turn injection (OpenAI, xAI, etc.) get MCP tools from the start,
  // because sub-agents only call execute() once and there is no "next execution" for
  // discovered tools to appear in.
  const skipMcpDeferral = deferralContext.providerFamily !== undefined
    && deferralContext.providerFamily !== "anthropic"
    && deferralContext.providerFamily !== "google";
  if (!skipMcpDeferral) {
    for (const t of tools) {
      if ((t.name.startsWith("mcp:") || t.name.startsWith("mcp__"))
          && !deferralContext.recentlyUsedToolNames.has(t.name)) {
        deferredSet.add(t.name);
      }
    }
  }

  // Phase 3: Small model aggressive deferral
  if (deferralContext.modelTier === "small") {
    for (const t of tools) {
      if (!deferredSet.has(t.name) && !CORE_TOOLS.has(t.name) && !deferralContext.recentlyUsedToolNames.has(t.name)) {
        deferredSet.add(t.name);
      }
    }
  }

  // Phase 4: Merge lifecycle-demoted tools into deferral set for unified discover_tools
  // Clear discovery state for lifecycle-demoted tools (prevents appearing
  // in both discoveredTools and deferredEntries simultaneously)
  if (deferralContext.lifecycleDemotedNames) {
    for (const name of deferralContext.lifecycleDemotedNames) {
      if (originalToolMap.has(name)) {
        deferredSet.add(name);
        deferralContext.discoveryTracker.markUnavailable(name);
      }
    }
  }

  // Phase 5: Operator overrides (neverDefer / alwaysDefer from DeferredToolsConfigSchema)
  if (deferralContext.neverDefer) {
    for (const name of deferralContext.neverDefer) {
      deferredSet.delete(name);
    }
  }
  if (deferralContext.alwaysDefer) {
    for (const name of deferralContext.alwaysDefer) {
      if (name !== "discover_tools" && originalToolMap.has(name)) {
        deferredSet.add(name);
      }
    }
  }

  // If nothing deferred, return original tools unchanged
  if (deferredSet.size === 0) {
    return { activeTools: tools, deferredEntries: [], discoveredTools: [], discoverTool: null, deferredCount: 0, deferredNames: [] };
  }

  // Partition tools into active and deferred entries (exclude model)
  const activeTools: ToolDefinition[] = [];
  const deferredEntries: DeferredToolEntry[] = [];
  for (const tool of tools) {
    if (deferredSet.has(tool.name)) {
      deferredEntries.push({
        name: tool.name,
        description: resolveToolDescription(tool),
        original: tool,
      });
    } else {
      activeTools.push(tool);
    }
  }

  // Separate discovered tools from remaining deferred
  const discoveredTools: ToolDefinition[] = [];
  const remainingDeferred: DeferredToolEntry[] = [];
  for (const entry of deferredEntries) {
    if (deferralContext.discoveryTracker.isDiscovered(entry.name)) {
      discoveredTools.push(entry.original);
    } else {
      remainingDeferred.push(entry);
    }
  }

  // Create discover_tools only when remaining deferred entries exist.
  // Thread active-tool names through so "already active" guidance works.
  // NOTE: executor-tool-assembly.ts rebuilds this tool a second time with the
  // post-deferral active set (active + discovered) since the final active set
  // isn't known until after this function returns.
  const activeNamesForDiscover = deferralContext.activeToolNames ?? new Set<string>();
  const discoverTool = remainingDeferred.length > 0
    ? createDiscoverTool(remainingDeferred, logger, embeddingPort, scoreConfig, activeNamesForDiscover)
    : null;

  const deferredNames = [...deferredSet];

  // Log deferral
  logger.info(
    { deferredCount: deferredSet.size, deferredNames, discoveredCount: discoveredTools.length },
    "Tools deferred behind discovery tool",
  );

  return {
    activeTools,
    deferredEntries: remainingDeferred,
    discoveredTools,
    discoverTool,
    deferredCount: deferredSet.size,
    deferredNames,
  };
}

// ---------------------------------------------------------------------------
// BM25 scoring (inline implementation, ~30 lines)
// ---------------------------------------------------------------------------

interface BM25Document {
  name: string;
  text: string;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9_]/g, " ").split(/\s+/).filter(Boolean);
}

function bm25Score(
  query: string,
  documents: BM25Document[],
  k1 = 1.2,
  b = 0.75,
): Array<{ name: string; score: number }> {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || documents.length === 0) return [];

  const N = documents.length;
  const docTokens = documents.map(d => tokenize(d.text + " " + d.name));
  const avgDl = docTokens.reduce((s, t) => s + t.length, 0) / N;

  // IDF for each query term
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = docTokens.filter(tokens => tokens.includes(term)).length;
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  const scores: Array<{ name: string; score: number }> = [];
  for (let i = 0; i < N; i++) {
    const tokens = docTokens[i];
    let score = 0;
    for (const term of queryTerms) {
      const tf = tokens.filter(t => t === term).length;
      const idfVal = idf.get(term) ?? 0;
      score += idfVal * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * tokens.length / avgDl));
    }
    if (score > 0) {
      scores.push({ name: documents[i].name, score });
    }
  }

  return scores.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Structured search (deterministic modes before BM25 fallback)
// ---------------------------------------------------------------------------

/**
 * Deterministic structured search modes, applied before BM25 fallback.
 * Returns matched tools directly or empty array to signal BM25 fallback.
 *
 * Modes (checked in order):
 * 1. "select:tool1,tool2" -- batch fetch by exact name
 * 2. Exact name match -- single tool by exact name
 * 3. MCP prefix match -- tools starting with mcp__ or mcp: prefix
 */
function structuredSearch(
  deferredTools: ToolDefinition[],
  query: string,
  maxResults: number,
): ToolDefinition[] {
  const q = query.toLowerCase().trim();
  if (!q || deferredTools.length === 0) return [];

  // Mode 1: "select:tool1,tool2"
  const selectMatch = q.match(/^select:(.+)$/);
  if (selectMatch) {
    const requested = selectMatch[1].split(",").map(s => s.trim()).filter(Boolean);
    return deferredTools.filter(t => requested.some(r => t.name.toLowerCase() === r));
  }

  // Mode 2: Exact name match
  const exact = deferredTools.find(t => t.name.toLowerCase() === q);
  if (exact) return [exact];

  // Mode 3: MCP prefix match (mcp__ or mcp:)
  if ((q.startsWith("mcp__") || q.startsWith("mcp:")) && q.length > 5) {
    const prefixMatches = deferredTools.filter(t => t.name.toLowerCase().startsWith(q)).slice(0, maxResults);
    if (prefixMatches.length > 0) return prefixMatches;
  }

  // Mode 4: Server name match (e.g., "yfinance" -> all mcp__yfinance--* tools)
  const serverPrefix = `mcp__${q}--`;
  const serverMatches = deferredTools.filter(t => t.name.toLowerCase().startsWith(serverPrefix));
  if (serverMatches.length > 0) return serverMatches.slice(0, maxResults);

  // No structured match -- caller falls through to BM25
  return [];
}

// ---------------------------------------------------------------------------
// Discovery tool factory
// ---------------------------------------------------------------------------

/**
 * Score-floor thresholds for discover_tools ranking. Applied to the filtered
 * ranked list before slice(0, 10) to prevent zero-signal queries from
 * surfacing incidental BM25 hits or cosine-noise matches.
 */
export interface ToolDiscoveryScoreConfig {
  minBm25Score: number;
  minHybridScore: number;
}

const DEFAULT_TOOL_DISCOVERY_SCORES: ToolDiscoveryScoreConfig = {
  minBm25Score: 0.8,
  minHybridScore: 0.35,
};

/**
 * Create a discovery tool that lets the agent search deferred tools by query.
 * Uses BM25 keyword scoring with optional EmbeddingPort semantic re-ranking.
 *
 * Receives DeferredToolEntry[] (with original schemas and display descriptions)
 * so it can serve full schemas and lean descriptions when queried.
 *
 * BM25 scores are normalized to [0, 1] (fraction of top match) BEFORE the
 * score-floor filter applies, matching the semantics of hybrid-mode scoring.
 * This ensures the top match always clears any floor <= 1.0 whenever any
 * positive signal exists (fixes the srv1593437 08:06:39Z "install MCP"
 * regression where raw BM25 ~0.74 was dropped by the 0.8 raw-score floor).
 *
 * @param scoreConfig Optional score-floor override (defaults to 0.8 BM25 /
 *   0.35 hybrid). Zero or negative floors disable the filter.
 * @param activeToolNames Names of tools currently ACTIVE in this session
 *   (post-deferral: active + discovered). Used to return "already active"
 *   guidance when queries re-ask for loaded MCPs. Must NOT include names
 *   that were deferred. Default empty set keeps callers backward-compatible.
 */
export function createDiscoverTool(
  deferredEntries: DeferredToolEntry[],
  logger: ComisLogger,
  embeddingPort?: EmbeddingPort,
  scoreConfig: ToolDiscoveryScoreConfig = DEFAULT_TOOL_DISCOVERY_SCORES,
  activeToolNames: ReadonlySet<string> = new Set(),
): ToolDefinition {
  // Build ToolDefinition[] view for structuredSearch compatibility
  const deferredTools = deferredEntries.map(e => e.original);

  /**
   * Resolve BM25 corpus text for a tool (scoring only).
   * Appends searchHint from metadata registry for richer keyword matching.
   * Falls back to display text only when no hint is registered.
   */
  function resolveBM25Text(tool: ToolDefinition): string {
    const base = resolveToolDescription(tool);
    const meta = getToolMetadata(tool.name);
    if (meta?.searchHint) {
      return base + " " + meta.searchHint;
    }
    return base;
  }

  return {
    name: "discover_tools",
    label: "Tool Discovery",
    description: "Search for deferred tools by keyword or description. Returns ranked matches with usage guidance.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find a relevant tool",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: unknown) {
      const p = params as Record<string, unknown>;
      const query = String(p.query ?? "");

      // ---------- Path 1: structured deterministic modes ----------
      const structuredResults = structuredSearch(deferredTools, query, 10);
      if (structuredResults.length > 0) {
        const searchMode = query.toLowerCase().trim().startsWith("select:")
          ? "select"
          : query.toLowerCase().trim().startsWith("mcp__") || query.toLowerCase().trim().startsWith("mcp:")
            ? "prefix"
            : "exact";
        logger.debug(
          {
            toolName: "discover_tools",
            query,
            searchMode,
            candidateCount: deferredEntries.length,
            structuredMatchCount: structuredResults.length,
            topMatch: structuredResults[0]?.name ?? "none",
          },
          "discover_tools search completed",
        );
        return formatDiscoveryResponse(structuredResults, deferredEntries);
      }

      // ---------- Path 2: BM25 (+ optional hybrid) fallback ----------
      const documents: BM25Document[] = deferredTools.map(t => ({
        name: t.name,
        text: resolveBM25Text(t),
      }));

      const rankedRaw = bm25Score(query, documents);
      const rawTopScore = rankedRaw[0]?.score ?? 0;

      // NORMALIZE UP FRONT -- both modes now operate in [0, 1] space.
      // This makes `minBm25Score` semantically equivalent to `minHybridScore`:
      // a fraction of the top match. After this step, ranked[0].score === 1.0
      // whenever rawTopScore > 0, so the top match always clears any floor <= 1.0.
      let ranked = rawTopScore > 0
        ? rankedRaw.map(r => ({ name: r.name, score: r.score / rawTopScore }))
        : rankedRaw.map(r => ({ name: r.name, score: 0 }));

      // Optional: semantic re-ranking via EmbeddingPort
      let embeddingUsed = false;
      if (embeddingPort && ranked.length > 0) {
        try {
          const queryResult = await embeddingPort.embed(query);
          if (queryResult.ok) {
            const queryVec = queryResult.value;
            const textsToEmbed = ranked.map(r => {
              const doc = documents.find(d => d.name === r.name);
              return doc?.text ?? r.name;
            });
            const batchResult = await embeddingPort.embedBatch(textsToEmbed);
            if (batchResult.ok) {
              const docVecs = batchResult.value;
              // `ranked` is already BM25-normalized; combine with cosine.
              // NO second normalization -- that would double-normalize and
              // change the scoring contract.
              const combined = ranked.map((r, i) => ({
                name: r.name,
                score: 0.5 * r.score + 0.5 * cosine(queryVec, docVecs[i]),
              }));
              combined.sort((a, b) => b.score - a.score);
              ranked = combined;
              embeddingUsed = true;
            }
          }
        } catch (embeddingErr) {
          logger.warn(
            {
              err: embeddingErr,
              hint: "discover_tools falling back to BM25-only search; check embedding provider health",
              errorKind: "dependency" as const,
            },
            "discover_tools embedding re-ranking failed",
          );
        }
      }

      // ---------- Floor check ----------
      const floor = embeddingUsed ? scoreConfig.minHybridScore : scoreConfig.minBm25Score;
      const normalizedTopScore = ranked[0]?.score ?? 0;
      const filtered = ranked.filter(r => r.score >= floor);
      const topResults = filtered.slice(0, 10);
      const searchMode = embeddingUsed ? "hybrid" : "bm25";

      logger.debug(
        {
          toolName: "discover_tools",
          query,
          searchMode,
          candidateCount: deferredEntries.length,
          resultCount: topResults.length,
          normalizedTopScore,
          rawTopScore,
          topMatch: topResults[0]?.name ?? "none",
          floor,
          filteredOut: ranked.length - filtered.length,
        },
        "discover_tools search completed",
      );

      // ---------- No BM25 match -- check active tools before giving up ----------
      if (topResults.length === 0) {
        const activeMatches = findActiveToolMatches(query, activeToolNames);
        if (activeMatches.length > 0) {
          logger.info(
            {
              toolName: "discover_tools",
              query,
              activeMatchCount: activeMatches.length,
              topActiveMatch: activeMatches[0],
            },
            "discover_tools: query matches already-active tools",
          );
          return {
            content: [{
              type: "text" as const,
              text: `Tool(s) already active -- call directly, no discovery needed:\n${
                activeMatches.slice(0, 20).map(n => `  - ${n}`).join("\n")
              }${activeMatches.length > 20 ? `\n  ... (${activeMatches.length} total)` : ""}`,
            }],
            isError: false,
            details: undefined,
            sideEffects: { discoveredTools: [] },
          };
        }

        // Distinguish "corpus has signal but filtered" vs "query terms absent from corpus".
        // After normalization, the former is only reachable in hybrid mode with adversarial
        // cosine (combined < floor). In BM25-only mode it's unreachable because the top
        // match always normalizes to 1.0 >= any floor <= 1.0.
        const warnMsg = rawTopScore > 0
          ? "discover_tools: no matches above floor"
          : "discover_tools: query tokens absent from deferred corpus";

        logger.warn(
          {
            query,
            searchMode,
            floor,
            rawTopScore,
            normalizedTopScore,
            topCandidate: ranked[0]?.name ?? "none",
            filteredOut: ranked.length - filtered.length,
            activeCorpusSize: activeToolNames.size,
            hint: rawTopScore > 0
              ? "No tool scored above the discover_tools floor. Lower skills.toolDiscovery.minHybridScore, retry with an exact tool name, or use 'select:<name>' syntax."
              : "Query tokens do not appear in any deferred tool description. Use 'select:<name>' for exact match, or reconsider whether the tool you want is already active.",
            errorKind: "validation" as const,
          },
          warnMsg,
        );
        return {
          content: [{
            type: "text" as const,
            text: "No matching tools found. Try an exact tool name, MCP server name (e.g. 'yfinance'), or select:tool1,tool2 syntax.",
          }],
          isError: false,
          details: undefined,
          sideEffects: { discoveredTools: [] },
        };
      }

      // ---------- Resolve matches, expand, format ----------
      const matches: ToolDefinition[] = topResults
        .map(r => deferredTools.find(t => t.name === r.name))
        .filter((t): t is ToolDefinition => t !== undefined);

      return formatDiscoveryResponse(matches, deferredEntries);
    },
  } as unknown as ToolDefinition;
}

// ---------------------------------------------------------------------------
// Helpers: active-tool match + output formatting
// ---------------------------------------------------------------------------

/**
 * Check whether `query` refers to any already-active tool.
 * Used to return "already active" guidance instead of "no matches" when
 * the agent re-discovers a previously-installed MCP or active builtin.
 *
 * Match modes (checked in order, first non-empty wins):
 * 1. Exact name match (case-insensitive) against the full query.
 * 2. `mcp__` / `mcp:` prefix match against the full query.
 * 3. Bare server-name match on full query (`"yfinance"` -> all `mcp__yfinance--*`).
 * 4. Per-token server-name fallback: for multi-word queries like
 *    `"yfinance get_stock"`, check each whitespace-separated token as a
 *    potential MCP server name. Catches the srv1593437 08:06:39Z scenario
 *    where the agent emits `{query: "yfinance get_stock"}` rather than just
 *    `{query: "yfinance"}`.
 */
function findActiveToolMatches(query: string, activeToolNames: ReadonlySet<string>): string[] {
  const q = query.toLowerCase().trim();
  if (!q || activeToolNames.size === 0) return [];

  const names = [...activeToolNames];
  const lowerMap = new Map(names.map(n => [n.toLowerCase(), n]));

  // Mode 1: exact match
  const exact = lowerMap.get(q);
  if (exact) return [exact];

  // Mode 2: prefix match (mcp__ or mcp:)
  if ((q.startsWith("mcp__") || q.startsWith("mcp:")) && q.length > 5) {
    const prefix = names.filter(n => n.toLowerCase().startsWith(q));
    if (prefix.length > 0) return prefix;
  }

  // Mode 3: bare server name -> mcp__<server>--*
  const serverPrefix = `mcp__${q}--`;
  const server = names.filter(n => n.toLowerCase().startsWith(serverPrefix));
  if (server.length > 0) return server;

  // Mode 4: per-token server fallback for multi-word queries.
  // Each whitespace-separated token is probed as a server name. The first
  // token that resolves to >= 1 active tool wins. This handles the common
  // "{server} {verb}" pattern like "yfinance get_stock".
  const tokens = q.split(/\s+/).filter(t => /^[a-z0-9_-]+$/.test(t));
  for (const token of tokens) {
    const tokenServerPrefix = `mcp__${token}--`;
    const tokenMatches = names.filter(n => n.toLowerCase().startsWith(tokenServerPrefix));
    if (tokenMatches.length > 0) return tokenMatches;
  }

  return [];
}

/**
 * Format matched tool definitions as a `<functions>` block with full JSON schemas,
 * applying server-expansion and co-discovery.
 *
 * Extracted from the inline block in `createDiscoverTool.execute()` so the two
 * return paths (structured + BM25) share one formatter.
 */
function formatDiscoveryResponse(
  matches: ToolDefinition[],
  deferredEntries: DeferredToolEntry[],
): {
  content: Array<{ type: "text"; text: string }>;
  isError: false;
  details: undefined;
  sideEffects: { discoveredTools: string[] };
} {
  const discoveredNames = matches.map(m => m.name);

  // Server-level activation: expand to all tools from same MCP server(s)
  const serverNames = new Set<string>();
  for (const name of discoveredNames) {
    const server = extractMcpServerName(name);
    if (server) serverNames.add(server);
  }
  if (serverNames.size > 0) {
    for (const entry of deferredEntries) {
      const server = extractMcpServerName(entry.name);
      if (server && serverNames.has(server) && !discoveredNames.includes(entry.name)) {
        discoveredNames.push(entry.name);
      }
    }
  }

  // Co-discovery: expand to related tools via ComisToolMetadata.coDiscoverWith
  const coDiscoveryNames: string[] = [];
  for (const name of discoveredNames) {
    const meta = getToolMetadata(name);
    if (meta?.coDiscoverWith) {
      for (const coName of meta.coDiscoverWith) {
        if (!discoveredNames.includes(coName) && !coDiscoveryNames.includes(coName)) {
          // Only add if the tool exists in the deferred set
          if (deferredEntries.some(e => e.name === coName)) {
            coDiscoveryNames.push(coName);
          }
        }
      }
    }
  }
  discoveredNames.push(...coDiscoveryNames);

  // Add co-discovered tool schemas to the display output
  const expandedMatches = [...matches];
  for (const coName of coDiscoveryNames) {
    const coEntry = deferredEntries.find(e => e.name === coName);
    if (coEntry && !expandedMatches.some(m => m.name === coName)) {
      expandedMatches.push(coEntry.original);
    }
  }

  // Format output as <functions> block with full JSON schemas (after all expansions)
  const functionsBlock = expandedMatches.map(m =>
    `<function>${JSON.stringify({
      name: m.name,
      description: resolveToolDescription(m),
      parameters: m.parameters,
    })}</function>`,
  ).join("\n");

  return {
    content: [{ type: "text" as const, text: `<functions>\n${functionsBlock}\n</functions>` }],
    isError: false,
    details: undefined,
    sideEffects: { discoveredTools: discoveredNames },
  };
}

// ---------------------------------------------------------------------------
// Cosine similarity (for optional EmbeddingPort re-ranking)
// ---------------------------------------------------------------------------

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Auto-discovery stubs
// ---------------------------------------------------------------------------

export const DEFERRAL_STUB_MARKER = "__comis_deferral_stub__" as const;

export function createAutoDiscoveryStubs(
  deferredEntries: DeferredToolEntry[],
  discoveryTracker: DiscoveryTracker,
  logger: ComisLogger,
): ToolDefinition[] {
  return deferredEntries.map(entry => {
    // `label` is a required field on ToolDefinition
    // (pi-coding-agent/core/extensions/types.d.ts). Some existing code paths
    // dereference it (pi-executor.ts mid-turn injection at line ~826), so
    // copy from the original rather than leave undefined.
    const originalLabel = (entry.original as unknown as Record<string, unknown>).label as
      | string
      | undefined;

    const stub = {
      name: entry.name,
      label: originalLabel ?? entry.name,
      description: entry.description,
      parameters: entry.original.parameters,
      [DEFERRAL_STUB_MARKER]: true,
      async execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
      ) {
        const result = await entry.original.execute(
          toolCallId,
          params,
          signal,
          onUpdate as Parameters<typeof entry.original.execute>[3],
          ctx as Parameters<typeof entry.original.execute>[4],
        );

        // Mark discovered only after a SUCCESSFUL execution. An MCP tool can
        // return `{ isError: true, content: [...] }` without throwing -- those
        // results must not promote the tool to the active set, or a broken tool
        // would persist across turns and keep wasting discovery budget.
        const isError = (result as unknown as Record<string, unknown>)?.isError === true;
        if (!isError) {
          discoveryTracker.markDiscovered([entry.name]);
        }

        logger.info(
          { toolName: entry.name, toolCallId, isError },
          "Auto-discovery stub triggered — forwarding to real tool",
        );

        return result;
      },
    };

    return stub as unknown as ToolDefinition;
  });
}
