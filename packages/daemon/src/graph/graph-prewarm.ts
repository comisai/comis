/**
 * Graph cache pre-warm: lightweight API call to seed Anthropic prompt cache
 * before graph nodes spawn.
 * Makes a single completeSimple call with max_tokens=1 using the shared
 * system prompt + tool definitions that graph nodes will use. If successful,
 * all subsequent graph nodes benefit from cache reads on their first API call.
 * @module
 */

import { fromPromise } from "@comis/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreWarmDeps {
  /** LLM provider name (e.g., "anthropic"). Pre-warm only activates for Anthropic-family. */
  provider: string;
  /** Model identifier (e.g., "claude-sonnet-4-20250514"). */
  modelId: string;
  /** API key for the provider. */
  apiKey: string;
  /** System prompt that graph nodes will use. */
  systemPrompt: string;
  /** Tool definitions for the graph (from assembleToolsForAgent). */
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  /** Logger (optional). */
  logger?: {
    debug(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface PreWarmResult {
  success: boolean;
  cacheWriteTokens: number;
  tokensUsed: number;
  cost: number;
  /** True when pre-warm was skipped (non-Anthropic provider, empty tools, etc.) */
  skipped?: boolean;
  error?: string;
}

/** Anthropic-family provider identifiers. */
const ANTHROPIC_PROVIDERS = new Set(["anthropic"]);

/** Minimum tool count to bother with pre-warm (cache minimum threshold heuristic). */
const MIN_TOOLS_FOR_PREWARM = 1;

// ---------------------------------------------------------------------------
// Factory-injected SDK functions (for testability)
// ---------------------------------------------------------------------------

/** SDK functions injected at call site. Allows mocking in tests without module mocks. */
export interface PreWarmSdk {
  getModel: (provider: string, modelId: string) => unknown;
  completeSimple: (model: unknown, context: unknown, options?: unknown) => Promise<{
    usage: { cacheWrite: number; totalTokens: number; cost: { total: number } };
  }>;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Make a lightweight API call to seed the prompt cache with the graph's shared prefix.
 * Conditions for activation:
 * - Provider is Anthropic-family (Gemini uses explicit CachedContent, not prefix caching)
 * - Tool list is non-empty (below-minimum prompts won't cache)
 * The call uses maxTokens=1 to minimize output cost. The system prompt + tools
 * form the cacheable prefix. On success, cacheWriteTokens > 0 confirms the cache
 * entry was created. On any failure, returns { success: false } -- caller falls
 * back to event-driven stagger.
 * @param deps - Pre-warm configuration (provider, model, apiKey, systemPrompt, tools)
 * @param sdk - SDK functions for model resolution and API call (injected for testability)
 * @returns PreWarmResult indicating success/failure, tokens used, and cost
 */
export async function preWarmGraphCache(
  deps: PreWarmDeps,
  sdk: PreWarmSdk,
): Promise<PreWarmResult> {
  // Guard: only Anthropic-family providers support prefix caching
  if (!ANTHROPIC_PROVIDERS.has(deps.provider)) {
    deps.logger?.debug(
      { provider: deps.provider },
      "Pre-warm skipped — provider does not support prefix caching",
    );
    return { success: false, cacheWriteTokens: 0, tokensUsed: 0, cost: 0, skipped: true };
  }

  // Guard: no tools = likely below minimum cacheable token threshold
  if (deps.tools.length < MIN_TOOLS_FOR_PREWARM) {
    deps.logger?.debug(
      { toolCount: deps.tools.length },
      "Pre-warm skipped — insufficient tools for cache minimum",
    );
    return { success: false, cacheWriteTokens: 0, tokensUsed: 0, cost: 0, skipped: true };
  }

  // Resolve model
  let model: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model = sdk.getModel(deps.provider as any, deps.modelId as any);
  } catch (modelErr) {
    const errorMsg = `Model resolution failed: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`;
    deps.logger?.warn(
      { provider: deps.provider, modelId: deps.modelId, hint: "Pre-warm will be skipped; graph proceeds with event-driven stagger", errorKind: "configuration" },
      `Pre-warm model resolution failed: ${errorMsg}`,
    );
    return { success: false, cacheWriteTokens: 0, tokensUsed: 0, cost: 0, error: errorMsg };
  }

  if (!model) {
    return { success: false, cacheWriteTokens: 0, tokensUsed: 0, cost: 0, error: "Model not found" };
  }

  // Build context: system prompt + tools (the cacheable prefix) + minimal user message
  const context = {
    systemPrompt: deps.systemPrompt,
    messages: [
      { role: "user" as const, content: ".", timestamp: Date.now() },
    ],
    tools: deps.tools.map((t) => ({
      name: t.name,
      description: t.description ?? `Tool: ${t.name}`,
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    })),
  };

  // Make the lightweight API call
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000); // 15s timeout

  const callResult = await fromPromise(
    sdk.completeSimple(model, context, {
      apiKey: deps.apiKey,
      maxTokens: 1,
      temperature: 0,
      cacheRetention: "long",
      signal: controller.signal,
    }),
  );

  clearTimeout(timer);

  if (!callResult.ok) {
    const errorMsg = callResult.error instanceof Error ? callResult.error.message : String(callResult.error);
    deps.logger?.warn(
      { provider: deps.provider, modelId: deps.modelId, err: callResult.error, hint: "Pre-warm failed; graph proceeds with event-driven stagger", errorKind: "network" },
      `Pre-warm API call failed: ${errorMsg}`,
    );
    return { success: false, cacheWriteTokens: 0, tokensUsed: 0, cost: 0, error: errorMsg };
  }

  const response = callResult.value;
  const cacheWriteTokens = response.usage.cacheWrite ?? 0;
  const tokensUsed = response.usage.totalTokens ?? 0;
  const cost = response.usage.cost?.total ?? 0;

  if (cacheWriteTokens > 0) {
    deps.logger?.debug(
      { cacheWriteTokens, tokensUsed, cost },
      "Pre-warm successful — cache prefix written",
    );
    return { success: true, cacheWriteTokens, tokensUsed, cost };
  }

  // Cache write returned 0 -- likely below minimum token threshold
  deps.logger?.debug(
    { cacheWriteTokens: 0, tokensUsed },
    "Pre-warm completed but no cache written (prompt may be below minimum cacheable tokens)",
  );
  return { success: false, cacheWriteTokens: 0, tokensUsed, cost };
}
