// SPDX-License-Identifier: Apache-2.0
/**
 * 3-level result condensation pipeline for subagent outputs.
 *
 * Processes raw subagent response text through three levels:
 *
 * 1. **Level 1 (Passthrough):** Results under `maxResultTokens` are wrapped
 *    in a minimal `SubagentResult` envelope without transformation.
 * 2. **Level 2 (LLM Condensation):** Results over threshold are condensed via
 *    `generateSummary()` with structured JSON output instructions. The LLM
 *    output is validated against `SubagentResultSchema`.
 * 3. **Level 3 (Head+Tail Truncation):** Fallback when LLM condensation fails
 *    or no model is available. Uses SDK `truncateHead()`/`truncateTail()` to
 *    preserve the beginning and end of the result.
 *
 * Full results are always persisted to disk at
 * `{dataDir}/subagent-results/{sanitizedSessionKey}/{runId}.json` regardless
 * of condensation level. Post-condensation validation checks that
 * file paths from the original result appear in the condensed output.
 *
 * @module
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { generateSummary, truncateHead, truncateTail } from "@mariozechner/pi-coding-agent";
import { type SubagentResult, SubagentResultSchema, type CondensedResult } from "@comis/core";
import { safePath } from "@comis/core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CHARS_PER_TOKEN } from "../safety/token-estimator.js";
import { sanitizeAssistantResponse } from "../provider/response/sanitize-pipeline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for the result condenser factory. */
export interface ResultCondenserDeps {
  /** Token threshold for Level 1 vs Level 2/3. */
  maxResultTokens: number;
  /** Condensation strategy from config. */
  condensationStrategy: "auto" | "always" | "never";
  /** Base directory for disk persistence (e.g., `~/.comis`). */
  dataDir: string;
  /** Minimal pino-compatible logger. */
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
}

/** Parameters for a single condensation call. */
export interface CondenseParams {
  /** Raw subagent response text. */
  fullResult: string;
  /** Original task description (for condensation prompt context). */
  task: string;
  /** Unique run identifier. */
  runId: string;
  /** Parent session key (may contain colons). */
  sessionKey: string;
  /** Agent identifier for logging. */
  agentId: string;
  /** Resolved model object for generateSummary (optional; no Level 2 if absent). */
  model?: unknown;
  /** API key for the model's provider (optional; no Level 2 if absent). */
  apiKey?: string;

  // --- Finding 20: Parent trace correlation ---
  /** Parent execution traceId for cross-session correlation. */
  parentTraceId?: string;
  /** Execution graph ID if spawned from a pipeline. */
  graphId?: string;
  /** Graph node ID if applicable. */
  nodeId?: string;

  // --- Finding 17: Tool metadata for offline analysis ---
  /** Tool names available to the sub-agent. */
  activeToolNames?: string[];
  /** Count of deferred tools. */
  deferredCount?: number;
  /** Ordered list of tool names called during execution. */
  toolCallHistory?: string[];
  /** Guide keys delivered during execution. */
  guidesDelivered?: string[];

  // --- Finding 20: Token/cost usage breakdown ---
  /** Token and cost usage from execution result. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens: number;
    costUsd: number;
    /** Cache breakdown for post-mortem analysis. */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheSavedUsd?: number;
    /** Cache effectiveness ratio for post-mortem analysis. */
    cacheEffectiveness?: number;
  };

  // --- Error context for non-successful executions ---
  /** Structured error context for disk persistence of failure classification. */
  errorContext?: {
    errorType: string;
    retryable: boolean;
    originalError?: string;
    /** Tool that was in-flight when the error occurred. */
    failingTool?: string;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap for disk persistence to prevent OOM on massive results. */
const DISK_WRITE_HARD_CAP_CHARS = 500_000;

/** Maximum file paths to extract from result text. */
const MAX_EXTRACTED_PATHS = 100;

/** Summary field max length for SubagentResult.summary. */
const SUMMARY_MAX_CHARS = 10_000;

/** Head portion of the head+tail split (60%). */
const HEAD_RATIO = 0.6;

/** Tail portion of the head+tail split (40%). */
const TAIL_RATIO = 0.4;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a result condenser with the given dependencies.
 *
 * The returned `condense()` method never throws -- errors at any level
 * trigger fallback to the next level, with an emergency Level 3 catch-all.
 */
export function createResultCondenser(deps: ResultCondenserDeps) {
  return {
    async condense(params: CondenseParams): Promise<CondensedResult> {
      try {
        return await condenseInternal(params, deps);
      } catch (emergencyErr) {
        // Emergency fallback: if the entire pipeline somehow throws,
        // produce a minimal Level 3 result so the caller never crashes.
        deps.logger.warn(
          { runId: params.runId, agentId: params.agentId, fallbackLevel: 3, err: emergencyErr, hint: "Emergency fallback triggered; result may be incomplete", errorKind: "internal" },
          "ResultCondenser emergency fallback",
        );
        const originalTokens = estimateTokens(params.fullResult);
        const truncResult = headTailTruncate(params.fullResult, deps.maxResultTokens, params.task);
        const condensedTokens = truncResult.condensedTokens;
        return {
          level: 3,
          result: truncResult.result,
          originalTokens,
          condensedTokens,
          compressionRatio: originalTokens > 0 ? condensedTokens / originalTokens : 1,
          diskPath: "(emergency fallback - disk write skipped)",
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internal pipeline
// ---------------------------------------------------------------------------

async function condenseInternal(params: CondenseParams, deps: ResultCondenserDeps): Promise<CondensedResult> {
  const { fullResult, task, runId, sessionKey, agentId } = params;
  const originalTokens = estimateTokens(fullResult);

  // Compute disk path eagerly.
  // Simplified directory naming for new runs: {tenantId}/{runId}.json
  // Legacy directories used {sanitizedSessionKey}/{runId}.json -- those remain on disk as-is.
  const tenantId = sessionKey.split(":")[0] ?? "default";
  const diskPath = safePath(deps.dataDir, "subagent-results", tenantId, `${runId}.json`);

  // Determine condensation level.
  let level: 1 | 2 | 3;
  let result: SubagentResult;
  let condensedTokens: number;

  if (
    deps.condensationStrategy === "never" ||
    (deps.condensationStrategy === "auto" && originalTokens <= deps.maxResultTokens)
  ) {
    // Level 1: Passthrough
    result = wrapAsSubagentResult(fullResult, task);
    level = 1;
    condensedTokens = originalTokens;
    deps.logger.debug(
      { runId, agentId, originalTokens, level },
      "Result condenser: Level 1 passthrough",
    );
  } else if (
    (deps.condensationStrategy === "always" || deps.condensationStrategy === "auto") &&
    params.model &&
    params.apiKey
  ) {
    // Attempt Level 2: LLM condensation
    const llmResult = await tryLlmCondensation(params, deps);
    if (llmResult) {
      // Post-condensation validation
      const validation = validateCondensation(fullResult, llmResult.result);
      if (validation.missingPaths.length > 0) {
        const existing = llmResult.result.filePaths ?? [];
        llmResult.result = {
          ...llmResult.result,
          filePaths: [...existing, ...validation.missingPaths].slice(0, MAX_EXTRACTED_PATHS),
        };
        deps.logger.debug(
          { runId, agentId, missingPaths: validation.missingPaths.length },
          "Result condenser: merged missing paths into condensed result",
        );
      }
      result = llmResult.result;
      level = 2;
      condensedTokens = llmResult.condensedTokens;
      deps.logger.debug(
        { runId, agentId, originalTokens, condensedTokens, level },
        "Result condenser: Level 2 LLM condensation",
      );
    } else {
      // LLM failed, fall through to Level 3
      const truncResult = headTailTruncate(fullResult, deps.maxResultTokens, task);
      result = truncResult.result;
      level = 3;
      condensedTokens = truncResult.condensedTokens;
      deps.logger.debug(
        { runId, agentId, originalTokens, condensedTokens, level },
        "Result condenser: Level 3 truncation (LLM fallback)",
      );
    }
  } else {
    // No model/apiKey available, go straight to Level 3
    deps.logger.warn(
      { runId, agentId, fallbackLevel: 3, hint: "No condensation model available; falling through to truncation", errorKind: "config" },
      "Result condenser: skipping Level 2 (no model/apiKey)",
    );
    const truncResult = headTailTruncate(fullResult, deps.maxResultTokens, task);
    result = truncResult.result;
    level = 3;
    condensedTokens = truncResult.condensedTokens;
    deps.logger.debug(
      { runId, agentId, originalTokens, condensedTokens, level },
      "Result condenser: Level 3 truncation (no model)",
    );
  }

  // Persist full result to disk -- always, regardless of level.
  // Thread metadata for offline analysis (Findings 17, 20).
  const persistMetadata = {
    parentTraceId: params.parentTraceId,
    graphId: params.graphId,
    nodeId: params.nodeId,
    toolMetadata: (params.activeToolNames || params.deferredCount !== undefined || params.toolCallHistory || params.guidesDelivered)
      ? {
          activeTools: params.activeToolNames,
          deferredCount: params.deferredCount,
          toolCallHistory: params.toolCallHistory,
          guidesDelivered: params.guidesDelivered,
        }
      : undefined,
    usage: params.usage,
    errorContext: params.errorContext,
  };
  await persistFullResult(diskPath, runId, sessionKey, task, fullResult, level, persistMetadata);

  const compressionRatio = originalTokens > 0 ? condensedTokens / originalTokens : 1;

  deps.logger.info(
    { runId, agentId, level, originalTokens, condensedTokens, compressionRatio: Math.round(compressionRatio * 100) / 100, diskPath },
    "Result condensation complete",
  );

  return { level, result, originalTokens, condensedTokens, compressionRatio, diskPath };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Level 1 / Level 3 helper: wrap raw text as SubagentResult
// ---------------------------------------------------------------------------

function wrapAsSubagentResult(text: string, _task: string): SubagentResult {
  const sanitized = sanitizeAssistantResponse(text);
  return {
    taskComplete: true,
    summary: sanitized.slice(0, SUMMARY_MAX_CHARS),
    conclusions: [`Task result available. See full output for details.`],
    filePaths: extractFilePaths(text), // raw text for path extraction — paths may appear inside think blocks
  };
}

// ---------------------------------------------------------------------------
// File path extraction
// ---------------------------------------------------------------------------

/** Extract file-path-like strings (at least 2 segments) from text. */
function extractFilePaths(text: string): string[] {
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded by line-level input; no catastrophic backtracking on typical paths
  const matches = text.match(/(?:\/[\w.-]+){2,}(?:\.[\w]+)?/g);
  if (!matches) return [];
  const unique = [...new Set(matches)];
  return unique.slice(0, MAX_EXTRACTED_PATHS);
}

// ---------------------------------------------------------------------------
// Level 2: LLM condensation
// ---------------------------------------------------------------------------

async function tryLlmCondensation(
  params: CondenseParams,
  deps: ResultCondenserDeps,
): Promise<{ result: SubagentResult; condensedTokens: number } | null> {
  try {
    // Wrap fullResult in synthetic UserMessage for generateSummary.
    const messages = [{ role: "user" as const, content: params.fullResult, timestamp: Date.now() }];

    const rawOutput: string = await generateSummary(
      messages as any[],
      params.model as any,
      deps.maxResultTokens,
      params.apiKey!,
      undefined,
      undefined,
      buildCondensationInstructions(params.task),
    );

    // Extract JSON (handles markdown fencing, brace extraction).
    const jsonStr = extractJson(rawOutput);
    if (!jsonStr) {
      deps.logger.debug(
        { runId: params.runId, agentId: params.agentId },
        "Result condenser: Level 2 failed -- could not extract JSON from LLM output",
      );
      return null;
    }

    const parsed = JSON.parse(jsonStr);
    const validation = SubagentResultSchema.safeParse(parsed);
    if (!validation.success) {
      deps.logger.debug(
        { runId: params.runId, agentId: params.agentId, zodErrors: validation.error.issues.length },
        "Result condenser: Level 2 failed -- Zod validation failed",
      );
      return null;
    }

    const condensedTokens = estimateTokens(JSON.stringify(validation.data));
    return { result: validation.data, condensedTokens };
  } catch (llmErr) {
    deps.logger.debug(
      { runId: params.runId, agentId: params.agentId, err: llmErr },
      "Result condenser: Level 2 failed -- generateSummary threw",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON extraction (robust, handles markdown fences)
// ---------------------------------------------------------------------------

/** Try to extract valid JSON from LLM output. */
function extractJson(text: string): string | null {
  // 1. Try direct parse.
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // continue
  }

  // 2. Try extracting from markdown fences.
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    const fenced = fenceMatch[1].trim();
    try {
      JSON.parse(fenced);
      return fenced;
    } catch {
      // continue
    }
  }

  // 3. Try first `{` to last `}` brace extraction.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // give up
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Condensation instructions for LLM
// ---------------------------------------------------------------------------

function buildCondensationInstructions(task: string): string {
  return `You are condensing a subagent's execution result into structured JSON.

Original task: ${task}

Produce a JSON object with EXACTLY these fields:
{
  "taskComplete": boolean,       // Did the subagent complete its task?
  "summary": "string",           // 1-3 sentence summary of what was accomplished (max 10000 chars)
  "conclusions": ["string"],     // Key conclusions or findings (at least 1, max 50)
  "filePaths": ["string"],       // ALL file paths created or modified (optional, max 100)
  "actionableItems": ["string"], // Next steps for the parent (optional, max 50)
  "errors": ["string"],          // Error descriptions encountered (optional, max 50)
  "keyData": {},                 // Arbitrary structured data (optional)
  "confidence": 0.0-1.0          // Confidence in conclusions (optional)
}

CRITICAL: Preserve ALL file paths, line numbers, and specific identifiers from the original result.
Output ONLY the JSON object, no markdown fencing, no explanation.`;
}

// ---------------------------------------------------------------------------
// Level 3: Head+tail truncation
// ---------------------------------------------------------------------------

function headTailTruncate(
  fullResult: string,
  maxTokens: number,
  task: string,
): { result: SubagentResult; condensedTokens: number } {
  const budget = maxTokens * CHARS_PER_TOKEN;
  const headBudget = Math.floor(budget * HEAD_RATIO);
  const tailBudget = Math.floor(budget * TAIL_RATIO);

  const head = truncateHead(fullResult, { maxBytes: headBudget });
  const tail = truncateTail(fullResult, { maxBytes: tailBudget });

  const omittedChars = fullResult.length - head.content.length - tail.content.length;
  let combined: string;
  if (omittedChars > 0) {
    combined = `${head.content}\n\n[... ${omittedChars} chars omitted ...]\n\n${tail.content}`;
  } else {
    // Result fits within head+tail budget combined -- no omission needed.
    combined = fullResult;
  }

  const result = wrapAsSubagentResult(combined, task);
  const condensedTokens = estimateTokens(combined);
  return { result, condensedTokens };
}

// ---------------------------------------------------------------------------
// Post-condensation validation
// ---------------------------------------------------------------------------

function validateCondensation(
  original: string,
  condensed: SubagentResult,
): { valid: boolean; missingPaths: string[] } {
  const originalPaths = extractFilePaths(original);
  const condensedText = JSON.stringify(condensed);
  const missing = originalPaths.filter((p) => !condensedText.includes(p));
  return { valid: missing.length === 0, missingPaths: missing };
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

async function persistFullResult(
  diskPath: string,
  runId: string,
  sessionKey: string,
  task: string,
  fullResult: string,
  level: 1 | 2 | 3,
  metadata?: {
    parentTraceId?: string;
    graphId?: string;
    nodeId?: string;
    toolMetadata?: {
      activeTools?: string[];
      deferredCount?: number;
      toolCallHistory?: string[];
      guidesDelivered?: string[];
    };
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens: number;
      costUsd: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cacheSavedUsd?: number;
      cacheEffectiveness?: number;
    };
    errorContext?: {
      errorType: string;
      retryable: boolean;
      originalError?: string;
    };
  },
): Promise<void> {
  // Hard cap to prevent OOM on massive results.
  const cappedResult = fullResult.length > DISK_WRITE_HARD_CAP_CHARS
    ? fullResult.slice(0, DISK_WRITE_HARD_CAP_CHARS)
    : fullResult;

  await mkdir(dirname(diskPath), { recursive: true });
  await writeFile(
    diskPath,
    JSON.stringify(
      {
        runId,
        sessionKey,
        task,
        fullResult: cappedResult,
        condensationLevel: level,
        persistedAt: new Date().toISOString(),
        // Finding 20: Parent trace correlation
        ...(metadata?.parentTraceId ? { parentTraceId: metadata.parentTraceId } : {}),
        ...(metadata?.graphId ? { graphId: metadata.graphId } : {}),
        ...(metadata?.nodeId ? { nodeId: metadata.nodeId } : {}),
        // Finding 17: Tool metadata for offline analysis
        ...(metadata?.toolMetadata ? { toolMetadata: metadata.toolMetadata } : {}),
        // Finding 20: Token/cost usage breakdown
        ...(metadata?.usage ? { usage: metadata.usage } : {}),
        // Error context for non-successful executions
        ...(metadata?.errorContext ? { errorContext: metadata.errorContext } : {}),
      },
      null,
      2,
    ),
  );
}

/* eslint-enable @typescript-eslint/no-explicit-any */
