// SPDX-License-Identifier: Apache-2.0
/**
 * The consolidation LLM seam — the two cheap-model completions the
 * consolidation job makes over a cluster: the MERGE call (collapse near-dups of
 * the SAME fact into one statement) and the GENERALIZE call (abstract a
 * cross-context cluster into ONE higher-order "user prefers X in general"
 * statement — GENERAL-01).
 *
 * Split out of `memory-consolidation-job.ts` so the LLM-call scaffold gets its
 * own home and the job file stays under the 800-line cap (the same split
 * discipline as `memory-consolidation-prompt.ts` / `-clustering.ts`).
 *
 * Security posture (design §9 / SEC-01):
 * - The GENERALIZE call's cluster input is UNTRUSTED and is
 *   `wrapExternalContent`-wrapped (`source: "memory_generalization"`) BEFORE the
 *   LLM — the delimited+labeled boundary an embedded injection cannot cross (the
 *   WS6 new stage; mirrors the `learned_skill_synthesis` precedent). The MERGE
 *   call is intentionally NOT wrapped — retrofitting the pre-existing merge is
 *   out of this phase's scope.
 * - Trust is NOT in either prompt's output contract — it is computed in CODE by
 *   the job (`minTrust`, the ceiling); a smuggled trust field is stripped by the
 *   lenient parser.
 * - Every input is bounded (`MAX_MEMORY_CHARS` per member, `maxConsolidationTokens`
 *   output) and every failure is a non-fatal `undefined` skip.
 *
 * The agent consumes pi-ai + `@comis/core` types only (no `@comis/memory` import —
 * the agent↛memory build cut), and reads the clock via the injected port (never
 * a wall-clock global).
 *
 * @module
 */

import { wrapExternalContent } from "@comis/core";
import type { MemoryConsolidationConfig, MemoryEntry, ClockPort } from "@comis/core";
import { completeSimple, getModel } from "@earendil-works/pi-ai";
import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import {
  CONSOLIDATION_PROMPT,
  GENERALIZATION_PROMPT,
  parseConsolidationResult,
} from "./memory-consolidation-prompt.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_TIMEOUT_MS = 120_000;

/**
 * Per-member content cap (chars) fed into a cluster prompt — a prompt-size DoS
 * guard. `maxConsolidationTokens` bounds only the LLM OUTPUT; the INPUT would
 * otherwise be unbounded — every member's full `content` concatenated
 * (`MemoryEntrySchema.content` is `z.string().min(1)`, no max), so `maxClusterSize`
 * members of arbitrary length could build an arbitrarily large prompt. Each member
 * is sliced to this cap before assembly — bounding the input cost by
 * `maxClusterSize × MAX_MEMORY_CHARS` rather than uncontrolled member length.
 */
export const MAX_MEMORY_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Deps (the narrow subset the LLM seam needs — structurally satisfied by the
// job's MemoryConsolidationDeps, so no type import from the job → no cycle)
// ---------------------------------------------------------------------------

/** The narrow dependency slice the cluster-completion calls read. */
export interface LlmClusterDeps {
  config: MemoryConsolidationConfig;
  agentId: string;
  provider: string;
  modelId: string;
  apiKey: string;
  clock: ClockPort;
  logger: {
    debug(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly + response parsing
// ---------------------------------------------------------------------------

/** Pull concatenated text parts out of the pi-ai completeSimple response. */
export function extractResponseText(response: { content?: unknown[] }): string {
  let text = "";
  if (response.content && Array.isArray(response.content)) {
    for (const part of response.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as Record<string, unknown>).type === "text" &&
        "text" in part
      ) {
        text += (part as Record<string, unknown>).text;
      }
    }
  }
  return text;
}

/**
 * Build the user-message text fed to a cluster LLM call. Each member's content is
 * sliced to {@link MAX_MEMORY_CHARS} so the INPUT prompt is bounded — not just the
 * output (`maxTokens`). Shared by the MERGE + GENERALIZE calls.
 */
export function buildClusterPrompt(cluster: MemoryEntry[]): string {
  let text = "Memories to merge:\n\n";
  for (const e of cluster) {
    text += `- (${e.id}) ${e.content.slice(0, MAX_MEMORY_CHARS)}\n`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// The shared completion scaffold
// ---------------------------------------------------------------------------

/**
 * Run ONE cheap-model completion over a cluster prompt and return the raw
 * response text, or `undefined` on ANY failure (model resolution, abort/timeout,
 * thrown call) — callers treat `undefined` as a non-fatal skip (mirrors the
 * review-job posture). Bounded by `config.maxConsolidationTokens`. The shared
 * scaffold behind both {@link mergeCluster} and {@link synthesizeGeneralization}
 * — the ONLY differences are the system prompt + whether the user content is
 * wrapped, so they pass those in and share everything else (model resolve,
 * abort/timeout, error mapping).
 */
async function runClusterCompletion(
  deps: LlmClusterDeps,
  systemPrompt: string,
  userContent: string,
  failHint: string,
): Promise<string | undefined> {
  const { config, agentId, clock, logger } = deps;

  let model;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider/modelId are dynamic strings
    model = getModel(deps.provider as any, deps.modelId as any);
  } catch (modelErr) {
    logger.warn(
      {
        agentId,
        err: modelErr,
        errorKind: "dependency" as const,
        hint: `could not resolve model ${deps.provider}/${deps.modelId} — skipping cluster`,
      },
      "Consolidation model resolution failed (non-fatal)",
    );
    return undefined;
  }
  if (!model) {
    logger.warn(
      {
        agentId,
        errorKind: "dependency" as const,
        hint: `model not found ${deps.provider}/${deps.modelId} — skipping cluster`,
      },
      "Consolidation model not found (non-fatal)",
    );
    return undefined;
  }

  const controller = new AbortController();
  const timer = systemSetTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await completeSimple(
      model,
      { systemPrompt, messages: [{ role: "user" as const, content: userContent, timestamp: clock.now() }] },
      {
        apiKey: deps.apiKey,
        temperature: 0.2,
        maxTokens: config.maxConsolidationTokens,
        signal: controller.signal,
      },
    );
    return extractResponseText(response);
  } catch (llmErr) {
    logger.warn({ agentId, err: llmErr, errorKind: "dependency" as const, hint: failHint }, "Consolidation LLM call failed (non-fatal)");
    return undefined;
  } finally {
    systemClearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The two public cluster completions
// ---------------------------------------------------------------------------

/**
 * Merge one homogeneous sub-cluster via a cheap-model LLM call (MERGE contract).
 * Returns the raw response text, or `undefined` on any failure.
 *
 * NOTE: the merge prompt input is NOT `wrapExternalContent`-wrapped — retrofitting
 * the pre-existing merge call is out of this phase's scope (only the NEW
 * generalization stage wraps; design §9/§17). See {@link synthesizeGeneralization}.
 */
export async function mergeCluster(
  deps: LlmClusterDeps,
  cluster: MemoryEntry[],
): Promise<string | undefined> {
  return runClusterCompletion(
    deps,
    CONSOLIDATION_PROMPT,
    buildClusterPrompt(cluster),
    "consolidation merge LLM call failed/aborted — skipping cluster",
  );
}

/**
 * Synthesize ONE higher-order generalization from a cross-context cluster
 * (GENERALIZE contract, GENERAL-01). Returns `{ content, confidence? }`, or
 * `undefined` on any failure (non-fatal skip).
 *
 * SEC-01 (the WS6 new stage): the cluster input is UNTRUSTED and is
 * `wrapExternalContent`-wrapped (`source: "memory_generalization"`) BEFORE the
 * LLM — the delimited+labeled boundary an embedded injection cannot cross.
 * Mirrors the `learned_skill_synthesis` precedent. The parsed result reuses the
 * MERGE-only lenient parser (same `{ content, confidence? }` shape; any smuggled
 * trust field is stripped — trust is computed in CODE via `minTrust`).
 */
export async function synthesizeGeneralization(
  deps: LlmClusterDeps,
  cluster: MemoryEntry[],
): Promise<{ content: string; confidence?: number } | undefined> {
  const wrapped = wrapExternalContent(buildClusterPrompt(cluster), { source: "memory_generalization" });
  const text = await runClusterCompletion(
    deps,
    GENERALIZATION_PROMPT,
    wrapped,
    "generalization synthesis LLM call failed/aborted — skipping cluster",
  );
  if (text === undefined) return undefined;
  const parsed = parseConsolidationResult(text);
  if (!parsed) return undefined;
  return { content: parsed.content, confidence: parsed.confidence };
}
