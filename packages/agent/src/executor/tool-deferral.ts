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

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ComisLogger } from "@comis/core";
import type { EmbeddingPort } from "@comis/core";
import { getToolMetadata } from "@comis/core";
import type { DiscoveryTracker } from "./discovery-tracker.js";
import { extractMcpServerName } from "@comis/shared";
import { PRIVILEGED_TOOL_NAMES } from "../bootstrap/sections/tooling-sections.js";
import type { CapabilityClass } from "./model-profile.js";
import { LEAN_TOOL_DESCRIPTIONS } from "../bootstrap/sections/tool-descriptions.js";
import { toolDefOverheadChars } from "./tool-overhead.js";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/constants.js";
import { scriptTokenFactor } from "@comis/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard character cap on the query text fed to `EmbeddingPort.embed` for the
 * discover_tools semantic re-rank. A very large user message used as the query
 * throws `Input is longer than the context size` in a local embedding model,
 * collapsing the re-rank to BM25-only. Capping the query keeps the semantic lane
 * running on a truncated query instead of failing.
 *
 * The value is the DENSEST-RATIO safe bound for a 2048-token embedding context:
 * 1536 tokens × 3 chars/token = 4608 chars. A 4-chars/token estimate
 * UNDER-counts dense content (code/JSON/ids tokenize at ~2.5-3 chars/token), so
 * the earlier 8000-char cap still packed ~2700-3200 tokens and overflowed the
 * 2048 context. 4608 chars stays under 2048 tokens even at a dense 2.5
 * chars/token (4608/2.5 ≈ 1843). This MIRRORS the recall path's bound
 * (`truncateForEmbedding(_, 1536)` in @comis/memory). The constant is kept local
 * (not imported) to preserve the agent↛memory build cut.
 */
export const MAX_EMBED_QUERY_CHARS = 4_608;

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
  capabilityClass: CapabilityClass;
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
   *  "default", "other") do not inject mid-turn, so MCP tools must be active
   *  from the start. Required — pass the explicit family for the resolved
   *  model; use "default" when no specific family applies. */
  providerFamily: string;
  /** Names of tools currently ACTIVE in this session (post-deferral).
   *  Consumed by discover_tools to return "already active" guidance when
   *  queries re-ask for loaded MCPs. Must NOT include names that were
   *  deferred -- pass the post-deferral set, not mergedCustomTools. */
  activeToolNames?: ReadonlySet<string>;
  /** SD7 (Phase 159): capability-class active-tool ceiling.
   *  When set, the active tool count is capped to this value after all other
   *  deferral passes. Only CORE_TOOLS and recently-used tools are guaranteed
   *  active; the cold long-tail is deferred behind discover_tools until the
   *  active count <= ceiling.
   *  undefined = no ceiling (nano has its own aggressive path; frontier/mid uncapped). */
  activeToolCeiling?: number;
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
 * Channel-specific tool deferral table. Each entry collapses the
 * byte-identical rule shape — channel-action tools are deferred unless
 * the current channelType matches.
 *
 * The table-driven `.map()` rebuild below preserves DEFERRAL_RULES.length === 5
 * (1 privileged + 4 channel-action rules), so the existing test at
 * tool-deferral.test.ts:1099-1110 holds verbatim.
 *
 * Adding a new channel-action tool: append one entry below. The corresponding
 * generated rule defers the tool unless the current channelType matches.
 */
const CHANNEL_TOOL_GATES = [
  { channelType: "discord",  tool: "discord_action",  description: "Discord-specific actions (pin, kick, ban, roles, threads, channels)" },
  { channelType: "telegram", tool: "telegram_action", description: "Telegram-specific actions (pin, poll, sticker, chat admin, topics)" },
  { channelType: "slack",    tool: "slack_action",    description: "Slack-specific actions (pin, topic, archive, channels)" },
  { channelType: "whatsapp", tool: "whatsapp_action", description: "WhatsApp-specific actions (group management, settings)" },
] as const;

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
  ...CHANNEL_TOOL_GATES.map((gate) => ({
    tools: [gate.tool],
    activeWhen: (ctx: DeferralContext) => ctx.channelType === gate.channelType,
    namespace: gate.channelType,
    namespaceDescription: gate.description,
  })),
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

/**
 * CWF-04 (Phase 168): orchestration entry primitives that stay active for `small`-class
 * models even under the SD7 tool-ceiling. Only `small` — nano's aggressive CORE_TOOLS-only
 * path fires before the ceiling block, so nano retains its own deliberate policy (nano is
 * below the NL→DAG comprehension cliff; promoting pipeline for nano gives it a tool it
 * cannot use and needlessly expands its manifest). frontier/mid: ceiling never fires.
 *
 * Net manifest impact: 83→24 ceiling saves ~5057 tokens; pipeline schema (~1729 tokens)
 * costs less than the saving → net ≈ 3328 tokens saved vs no-pipeline ceiling.
 * Formula: (83-24) tools × ~300 chars avg ÷ 3.5 chars/tok = ~5057 tokens;
 * pipeline schema ~6052 chars ÷ 3.5 = ~1729 tokens.
 *
 * Pre-deferral systemTokens estimate (cachedSystemTokensEstimate) remains stale for the
 * CURRENT turn (it's computed before deferral fires) — this is a pre-existing known
 * subtlety (Pitfall 4), not introduced by Phase 168. Budget algebra will accurately reflect
 * the post-ceiling manifest on the NEXT assembly.
 *
 * Extend only when O2 DAG templates demand it (future milestone); never add all four
 * orchestration primitives — each extra schema fights the ceiling this fix pursues.
 *
 * Exported for test access (mirrors the `CORE_TOOLS` convention); no non-test external
 * caller currently consumes this constant.
 */
export const SMALL_CLASS_ORCHESTRATION_TOOLS = new Set(["pipeline"]);

/**
 * Anthropic models that support server-side tool-search via defer_loading.
 * Sonnet 4.x+, Opus 4.x+; NOT Haiku.
 *
 * **Surviving caller:** `request-body-injector.ts` (the
 * `if (supportsToolSearch(model.id)) {...}` gate inside the Anthropic
 * `onPayload` handler). Used to gate the API-payload reshape that strips
 * the client-side discovery tool, appends the server-side tool-search
 * regex tool, and marks deferred tools `defer_loading: true`. This is a
 * runtime API-payload concern, distinct from the deferred-tool prompt
 * teaching emitted by `buildDeferredToolsContext`.
 *
 * Lowercase-normalize so provider-prefixed model ids
 * (`anthropic/claude-sonnet-4`, `bedrock/anthropic.claude-opus-4`) resolve
 * correctly.
 */
export function supportsToolSearch(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower.includes("haiku")) return false;
  return lower.includes("sonnet") || lower.includes("opus");
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
    // WR-01 / TODO(Phase-152): pass capabilityClass when small-model lean
    // descriptions are introduced. Until then, "large" is the correct safe
    // default — it produces the same output as the current behavior, and
    // DeferralContext.capabilityClass is not threaded to this function yet.
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
 * available behind a discovery mechanism.
 *
 * The instruction line names BOTH discovery tools concretely:
 *   - `tool_search_tool_regex` -- Anthropic Sonnet/Opus 4.x server-side path
 *     (the payload reshape in `request-body-injector.ts` gated by
 *     `supportsToolSearch(modelId)` swaps the client-side tool out for this
 *     server-side one).
 *   - `discover_tools` -- everything else (the client-side path
 *     constructed by {@link createDiscoverTool}).
 *
 * The pre-flip "discovery mechanism available in your active toolspace"
 * wording was empirically too vague: across three sub-agent sessions in
 * production we observed zero `server_tool_use` blocks invoking the
 * Anthropic regex tool. Naming the tool explicitly gives the model a
 * concrete next step.
 *
 * C3 (Plan 152-04): optional `maxEntries` cap truncates the formatted list
 * and appends a "[+N more deferred tools — use discover_tools to list all]"
 * suffix. Frontier/mid: uncapped (options undefined or {}). Small/nano: caller
 * passes `{ maxEntries: DEFERRED_TOOLS_MAX_BY_CLASS[capabilityClass] }`.
 * The options parameter is optional; omitting it leaves the list uncapped.
 *
 * @param entries - Deferred tool entries (remaining after discovery re-inclusion)
 * @param options - Optional cap options: `maxEntries` limits formatted lines
 * @returns XML block string, or empty string when no entries
 */
export function buildDeferredToolsContext(
  entries: DeferredToolEntry[],
  options?: { maxEntries?: number },
): string {
  if (entries.length === 0) return "";

  // C3: apply maxEntries cap before formatting
  const maxEntries = options?.maxEntries;
  let effectiveEntries = entries;
  let truncatedCount = 0;

  if (maxEntries !== undefined && entries.length > maxEntries) {
    effectiveEntries = entries.slice(0, maxEntries);
    truncatedCount = entries.length - maxEntries;
  }

  // Separate MCP tools (group by server) from non-MCP tools (individual listing)
  const mcpByServer = new Map<string, DeferredToolEntry[]>();
  const nonMcpEntries: DeferredToolEntry[] = [];

  for (const e of effectiveEntries) {
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

  // C3: append truncation notice when entries were capped
  if (truncatedCount > 0) {
    lines.push(`[+${truncatedCount} more deferred tools — use discover_tools to list all]`);
  }

  const instruction =
    "These tools are connected but not currently loaded into your active context. " +
    "To use one, call `tool_search_tool_regex` (Anthropic Sonnet/Opus 4.x) or " +
    "`discover_tools` (other models) with a regex matching the tool name " +
    "(e.g. `mcp__yfinance--get_stock_price` or `.*stock.*`), then invoke the " +
    "loaded tool with the appropriate arguments.";

  return [
    "<deferred-tools>",
    "The following tools are available but not loaded.",
    instruction,
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

  // Rule-based deferral
  for (const rule of DEFERRAL_RULES) {
    if (!rule.activeWhen(deferralContext)) {
      for (const toolName of rule.tools) {
        if (originalToolMap.has(toolName) && !deferralContext.recentlyUsedToolNames.has(toolName)) {
          deferredSet.add(toolName);
        }
      }
    }
  }

  // MCP tools are ACTIVE BY DEFAULT for providers that support mid-turn tool
  // injection (`anthropic`, `google`). Empirically, the model rarely invokes
  // the server-side discovery tool (`tool_search_tool_regex`) and falls back
  // to `exec`/`web_fetch` -- deferral here paid a 0-discovery cost for no
  // benefit. Token cost of keeping ~20 MCP tools active is ~3-5k at cache-read
  // rates (~$0.005/turn), orders of magnitude cheaper than a single failed
  // sub-agent run.
  //
  // Operators who DO want MCP deferral opt in via
  // `config.deferredTools.alwaysDefer`. The nano-class rule below still
  // catches MCP tools when capabilityClass is `"nano"` (aggressive deferral for
  // the most constrained models). Providers without mid-turn injection (OpenAI,
  // xAI, etc.) were already exempt from MCP deferral and remain so -- the
  // flip means the Anthropic/Google branch now matches their behavior.

  // Aggressive deferral for nano-class models (behavior-neutral: old modelTier="small" at <=32K maps to capabilityClass="nano")
  // Phase 159/SD7: 'small' class ceiling policy implemented via DeferralContext.activeToolCeiling.
  // nano retains its own aggressive CORE_TOOLS-only path below.
  if (deferralContext.capabilityClass === "nano") {
    for (const t of tools) {
      if (!deferredSet.has(t.name) && !CORE_TOOLS.has(t.name) && !deferralContext.recentlyUsedToolNames.has(t.name)) {
        deferredSet.add(t.name);
      }
    }
  }

  // SD7 (Phase 159): active-tool ceiling for small class (fills Phase-152/SD7 deferred TODO).
  // Only fires when DeferralContext.activeToolCeiling is set — undefined guard preserves
  // the Phase-151 regression test (makeContext without activeToolCeiling → skipped).
  // CRITICAL: mirrors the nano path — CORE_TOOLS and recently-used tools are NEVER deferred.
  // Deferred tools remain fully reachable via discover_tools (no capability removal).
  if (deferralContext.activeToolCeiling !== undefined) {
    const ceiling = deferralContext.activeToolCeiling;
    const activeCount = tools.filter(t => !deferredSet.has(t.name)).length;
    if (activeCount > ceiling) {
      let remaining = activeCount - ceiling; // how many to defer
      for (const t of tools) {
        if (remaining <= 0) break;
        if (deferredSet.has(t.name)) continue;
        if (CORE_TOOLS.has(t.name)) continue;
        // CWF-04 (Phase 168): pipeline (and future orchestration entries) stays active for
        // small-class models. Only fires in this ceiling block — which only runs for small
        // (activeToolCeiling is undefined for nano/frontier/mid). The capabilityClass check
        // is technically redundant (the block only runs for small) but makes the SMALL-ONLY
        // intent unambiguous. Nano's aggressive path above is unaffected — nano stays
        // byte-identical (pipeline still deferred for nano, test :485 GREEN).
        if (deferralContext.capabilityClass === "small" && SMALL_CLASS_ORCHESTRATION_TOOLS.has(t.name)) continue;
        if (deferralContext.recentlyUsedToolNames.has(t.name)) continue;
        deferredSet.add(t.name);
        remaining--;
      }
    }
  }

  // Merge lifecycle-demoted tools into deferral set for unified discover_tools
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

  // Operator overrides (neverDefer / alwaysDefer from DeferredToolsConfigSchema)
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
// Window-aware tool-budget fit-enforcement (root-cause context-exhaustion fix)
// ---------------------------------------------------------------------------

/** Token estimate for a tool corpus — machine-Latin JSON schemas, so flat
 *  (matching estimateSystemTokensFactored's treatment of the toolOverheadChars
 *  term). ONE ceil over the summed chars. */
function toolCorpusTokens(tools: ReadonlyArray<ToolDefinition>): number {
  // tool name + description + JSON.stringify(parameters) is machine-emitted Latin
  // flat-by-design: JSON (scriptTokenFactor 1.0) — mirrors estimateSystemTokensFactored's toolOverheadChars (TOK-01)
  return Math.ceil(toolDefOverheadChars(tools) / CHARS_PER_TOKEN_RATIO);
}

/** Parameters for {@link enforceToolBudgetFit}. */
export interface EnforceToolBudgetFitParams {
  /** The post-deferral ACTIVE tool set (active + discovered + discover_tools) —
   *  the tools whose schemas actually ship on the wire. */
  activeTools: ToolDefinition[];
  /** The current deferred entries (reachable via discover_tools). Newly-deferred
   *  tools are appended here so they stay discoverable. */
  deferredEntries: DeferredToolEntry[];
  /** The system prompt text WITHOUT tool schemas — the non-evictable fixed
   *  overhead the fit budget must reserve. Passed as TEXT (not a char count) so
   *  the token estimate applies scriptTokenFactor over the actual script, exactly
   *  as estimateSystemTokensFactored does (TOK-01). */
  systemPromptText: string;
  /** Effective context window in tokens (min(configured, served, capabilityCap)). */
  contextWindow: number;
  /** Output headroom tokens reserved for the model's reply (+thinking block). */
  outputHeadroom: number;
  /** Minimum tokens reserved for the user message + a little history. */
  messageFloorTokens: number;
  /** CORE_TOOLS — kept active preferentially; dropped only as a last resort. */
  coreToolNames: ReadonlySet<string>;
  /** Recently-used tools — kept active preferentially (one tier above cold tools). */
  recentlyUsedToolNames: ReadonlySet<string>;
  /** The discover_tools tool name — kept while anything stays reachable; dropped
   *  last (a chat reply needs no tools). */
  discoverToolName: string;
  logger: ComisLogger;
}

/** Result of {@link enforceToolBudgetFit}. */
export interface EnforceToolBudgetFitResult {
  /** The refined active tool set whose overhead fits the residual budget. */
  activeTools: ToolDefinition[];
  /** The deferred entries, including any tools this pass moved out of active. */
  deferredEntries: DeferredToolEntry[];
  /** Names of tools this pass moved from active → deferred (lowest-priority first). */
  newlyDeferred: string[];
  /** True iff the active set changed (tools were deferred). When false, the
   *  returned `activeTools` is the SAME array reference (identity no-op). */
  changed: boolean;
  /** The computed tool-token budget (window − systemPromptOnly − headroom − floor).
   *  May be ≤ 0 in the degenerate case (window smaller than the fixed overhead),
   *  in which case every droppable tool is deferred. */
  toolTokenBudget: number;
}

/**
 * Window-aware tool-budget fit-enforcement — the ROOT-CAUSE guarantee that the
 * agent never context-exhausts on its FIXED overhead for any window size.
 *
 * `applyToolDeferral` defers by COUNT (activeToolCeiling / CORE_TOOLS heuristic),
 * never against a token budget. So on a small window a large system prompt plus
 * even a CORE_TOOLS-only active set can exceed `effectiveWindow − headroom`,
 * making the pre-flight fit check (lcd-preflight.ts) throw ContextExhaustionError
 * on every turn — even a 10-token message. This pass closes the gap: it
 * deterministically defers MORE active tools until the SHIPPING active-tool
 * overhead fits the residual budget
 *
 *   toolTokenBudget = contextWindow − systemPromptOnlyTokens − outputHeadroom − messageFloor
 *
 * where systemPromptOnlyTokens = ceil(systemPromptChars / CHARS_PER_TOKEN_RATIO)
 * (the same algebra as estimateSystemTokensFactored at toolOverheadChars=0).
 *
 * Drop order (lowest priority first, so capability loss is minimized):
 *   1. cold non-core tools (not CORE, not recently-used, not discover_tools)
 *   2. recently-used tools
 *   3. CORE_TOOLS (last resort — they ARE droppable when nothing else fits)
 *   4. discover_tools (dropped only when the budget is so tiny nothing else
 *      remains; a chat reply needs no tools).
 *
 * Dropped tools join `deferredEntries`, so they stay reachable via discover_tools
 * (no capability loss for adequately-sized windows — the discovery path is
 * intact). Terminates: each iteration defers exactly one tool or breaks, so it
 * runs at most `activeTools.length` times. Pure — no I/O beyond the WARN.
 */
export function enforceToolBudgetFit(
  params: EnforceToolBudgetFitParams,
): EnforceToolBudgetFitResult {
  const {
    activeTools, deferredEntries, systemPromptText, contextWindow,
    outputHeadroom, messageFloorTokens, coreToolNames, recentlyUsedToolNames,
    discoverToolName, logger,
  } = params;

  // TOK-01: the system-prompt term divides chars by the SAME script factor as
  // estimateSystemTokensFactored (a dense Hebrew/CJK prompt carries ~2-3× tokens
  // per char) so the residual budget is not over-stated for non-Latin prompts —
  // under-counting here would let tools through that then overflow the window.
  const systemPromptOnlyTokens = Math.ceil(
    systemPromptText.length / (CHARS_PER_TOKEN_RATIO * scriptTokenFactor(systemPromptText)),
  );
  const toolTokenBudget =
    contextWindow - systemPromptOnlyTokens - outputHeadroom - messageFloorTokens;

  // Already fits → identity no-op (same array reference; preserves cache stability).
  if (toolCorpusTokens(activeTools) <= toolTokenBudget) {
    return {
      activeTools,
      deferredEntries,
      newlyDeferred: [],
      changed: false,
      toolTokenBudget,
    };
  }

  // Priority rank: lower = dropped first. discover_tools is highest (dropped last).
  const rankOf = (name: string): number => {
    if (name === discoverToolName) return 3;
    if (coreToolNames.has(name)) return 2;
    if (recentlyUsedToolNames.has(name)) return 1;
    return 0; // cold non-core
  };

  // Drop candidates: every active tool, lowest-priority first. Stable on ties
  // (preserve the original order within a rank) so the drop set is deterministic.
  const indexed = activeTools.map((t, i) => ({ t, i }));
  const dropOrder = [...indexed].sort((a, b) => {
    const r = rankOf(a.t.name) - rankOf(b.t.name);
    return r !== 0 ? r : a.i - b.i;
  });

  const dropped = new Set<string>();
  const newlyDeferred: string[] = [];
  for (const { t } of dropOrder) {
    if (toolCorpusTokens(activeTools.filter((a) => !dropped.has(a.name))) <= toolTokenBudget) {
      break;
    }
    dropped.add(t.name);
    newlyDeferred.push(t.name);
  }

  const refinedActive = activeTools.filter((t) => !dropped.has(t.name));
  // Append dropped tools to the deferred set (de-duped) so discover_tools can
  // still surface them. discover_tools itself, if dropped, is NOT a deferred
  // entry (it is the discovery mechanism, not a discoverable capability).
  const deferredNameSet = new Set(deferredEntries.map((e) => e.name));
  const refinedDeferred = [...deferredEntries];
  for (const { t } of dropOrder) {
    if (!dropped.has(t.name) || t.name === discoverToolName) continue;
    if (deferredNameSet.has(t.name)) continue;
    deferredNameSet.add(t.name);
    refinedDeferred.push({
      name: t.name,
      description: resolveToolDescription(t),
      original: t,
    });
  }

  logger.warn(
    {
      step: "tool-budget-fit",
      errorKind: "resource" as const,
      hint:
        `Active tool schemas exceed the window's residual budget; deferred ${newlyDeferred.length} ` +
        `tool(s) to fit. Raise the model's context window, reduce active tools, or pin a larger ` +
        `capabilityClass. Dropped tools remain reachable via discover_tools.`,
      contextWindow,
      systemPromptOnlyTokens,
      outputHeadroom,
      messageFloorTokens,
      toolTokenBudget,
      droppedCount: newlyDeferred.length,
      activeToolsAfter: refinedActive.length,
    },
    "tool-budget fit-enforcement deferred active tools to fit the window",
  );

  return {
    activeTools: refinedActive,
    deferredEntries: refinedDeferred,
    newlyDeferred,
    changed: newlyDeferred.length > 0,
    toolTokenBudget,
  };
}

/** Inputs for {@link applyToolBudgetFit} — the budget terms + the discover_tools
 *  rebuild dependencies. */
export interface ApplyToolBudgetFitParams {
  systemPromptText: string;
  contextWindow: number;
  outputHeadroom: number;
  messageFloorTokens: number;
  recentlyUsedToolNames: ReadonlySet<string>;
  logger: ComisLogger;
  embeddingPort?: EmbeddingPort;
  scoreConfig?: ToolDiscoveryScoreConfig;
}

/**
 * Orchestrator wrapper around {@link enforceToolBudgetFit}: runs the pure
 * window-aware fit pass over the SHIPPING active set (active + discovered +
 * discover_tools), and — when it deferred more tools — refines `deferralResult`
 * IN PLACE so the downstream mergedCustomTools assembly, deferred-tools preamble,
 * auto-discovery stubs, and history-budget reservation all see the post-fit
 * state. discover_tools is rebuilt over the NEW deferred set (it must index the
 * newly-deferred tools), or cleared when the budget squeezed it out too (a tiny
 * window where a chat reply needs no tools).
 *
 * Extracted from executor-tool-assembly.ts (which is at its file-size cap) so the
 * call site is a single statement. Returns nothing — mutation is intentional and
 * mirrors the existing in-place discover_tools rebuild at the deferral call site.
 */
export function applyToolBudgetFit(
  deferralResult: ExcludeDeferralResult,
  params: ApplyToolBudgetFitParams,
): void {
  const fit = enforceToolBudgetFit({
    activeTools: [
      ...deferralResult.activeTools,
      ...deferralResult.discoveredTools,
      ...(deferralResult.discoverTool ? [deferralResult.discoverTool] : []),
    ],
    deferredEntries: deferralResult.deferredEntries,
    systemPromptText: params.systemPromptText,
    contextWindow: params.contextWindow,
    outputHeadroom: params.outputHeadroom,
    messageFloorTokens: params.messageFloorTokens,
    coreToolNames: CORE_TOOLS,
    recentlyUsedToolNames: params.recentlyUsedToolNames,
    discoverToolName: "discover_tools",
    logger: params.logger,
  });
  if (!fit.changed) return;

  // discover_tools was squeezed out if the budget pass DEFERRED it (it is rank 3 —
  // dropped last, when nothing else remains). Distinct from "it never existed":
  // when this pass newly defers tools but there was no pre-existing discover_tools,
  // we must STILL build one so the newly-deferred tools stay reachable (otherwise
  // the fit pass silently strips capability) — BUT only if discover_tools' own
  // schema fits the residual budget on top of the kept active tools. When the
  // budget is so tiny nothing fits (the degenerate window), drop discover_tools
  // too: a chat reply needs no tools, and re-adding it would re-overflow.
  const discoverWasDropped = fit.newlyDeferred.includes("discover_tools");
  const discoveredNames = new Set(deferralResult.discoveredTools.map((d) => d.name));
  deferralResult.activeTools = fit.activeTools.filter(
    (t) => t.name !== "discover_tools" && !discoveredNames.has(t.name),
  );
  deferralResult.deferredEntries = fit.deferredEntries;
  deferralResult.deferredNames = [
    ...new Set([...deferralResult.deferredNames, ...fit.newlyDeferred]),
  ];
  // Observability: enforceToolBudgetFit already emitted the structured WARN
  // (window/budget/droppedCount + actionable hint). The downstream
  // context:budget_computed event (lcd-preflight) then reflects the corrected,
  // smaller systemTokens reservation this pass produces.

  if (discoverWasDropped || deferralResult.deferredEntries.length === 0) {
    deferralResult.discoverTool = null;
    return;
  }
  // Build discover_tools over the new deferred set (with the post-fit active names
  // so its "already active" guidance is correct), then keep it ONLY if its own
  // schema fits the residual budget on top of the kept active+discovered set. When
  // the budget is so tiny nothing fits (the degenerate window), drop it too — a
  // chat reply needs no tools, and re-adding it would re-overflow the window.
  const activeAfterFit = new Set<string>([
    ...deferralResult.activeTools.map((t) => t.name),
    ...deferralResult.discoveredTools.map((t) => t.name),
  ]);
  const rebuiltDiscover = createDiscoverTool(
    deferralResult.deferredEntries,
    params.logger,
    params.embeddingPort,
    params.scoreConfig,
    activeAfterFit,
  );
  const keptOverheadTokens = toolCorpusTokens([
    ...deferralResult.activeTools,
    ...deferralResult.discoveredTools,
    rebuiltDiscover,
  ]);
  deferralResult.discoverTool = keptOverheadTokens <= fit.toolTokenBudget ? rebuiltDiscover : null;
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

  // Mode 4: Server name match (e.g., bare server token -> all mcp__<server>--* tools)
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
 *   that were deferred. Required — pass an empty set when no tools are
 *   active rather than relying on a default.
 */
export function createDiscoverTool(
  deferredEntries: DeferredToolEntry[],
  logger: ComisLogger,
  embeddingPort: EmbeddingPort | undefined,
  scoreConfig: ToolDiscoveryScoreConfig | undefined,
  activeToolNames: ReadonlySet<string>,
): ToolDefinition {
  const resolvedScoreConfig = scoreConfig ?? DEFAULT_TOOL_DISCOVERY_SCORES;
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
          // FIX: cap the query length before embedding. A ~69K-token query
          // overflows a local embedding model's context window ("Input is longer
          // than the context size") and would drop the semantic lane entirely;
          // the leading MAX_EMBED_QUERY_CHARS preserve the query's signal. The
          // BM25 lane above already ran on the full query, so recall is intact.
          const embedQuery = query.length > MAX_EMBED_QUERY_CHARS ? query.slice(0, MAX_EMBED_QUERY_CHARS) : query;
          const queryResult = await embeddingPort.embed(embedQuery);
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
      const floor = embeddingUsed ? resolvedScoreConfig.minHybridScore : resolvedScoreConfig.minBm25Score;
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
            text: "No matching tools found. Try an exact tool name, MCP server name, or select:tool1,tool2 syntax.",
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
 * 3. Bare server-name match on full query (e.g., bare server token -> all `mcp__<server>--*`).
 * 4. Per-token server-name fallback: for multi-word queries like
 *    `"<server> <verb>"`, check each whitespace-separated token as a
 *    potential MCP server name. Catches the case where the agent emits
 *    `{query: "<server> <verb>"}` rather than just `{query: "<server>"}`.
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
  // "<server> <verb>" pattern like "<bare-server-token> <verb>".
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
