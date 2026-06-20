// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-injected OFFLINE directional relationship build seam builder.
 *
 * {@link runRelationshipBuild} takes an INJECTED `build` seam (a HIGH-TRUST,
 * sender-prefixed source-memory text → typed {@link RelationshipBuildOutput}
 * directional candidates). This module is the factory the daemon's
 * `__SOCIAL_MODELING__` sentinel calls to BUILD that seam from a cheap resolved
 * model — so the daemon stays thin and the builder prompt (`RELATIONSHIP_PROMPT`,
 * embedded by {@link buildRelationshipPrompt}) + its lenient/total parser
 * ({@link parseRelationshipOutput}) stay AGENT-INTERNAL (the prompt string never
 * crosses the package boundary, mirroring how {@link createUserRepresentationSeam}
 * keeps `USER_REPRESENTATION_PROMPT` private).
 *
 * Security posture (the same anti-laundering discipline as the user-representation
 * seam):
 * - ONE cheap-model call per source set (the per-channel relationship model is a
 *   single distillation, not the reasoning job's two specialist contracts).
 * - The lenient `z.object` parser STRIPS any smuggled `trust` field before the value
 *   reaches the job — trust is computed in CODE by the job at the source ceiling,
 *   NEVER chosen by the LLM. A candidate missing either directional endpoint is
 *   dropped.
 * - NON-FATAL: a thrown/aborted/malformed call yields `[]` (the seam never throws
 *   out — the job's `fromPromise` wrap is a second belt, but the seam already
 *   degrades).
 * - Each call is BOUNDED by `maxOutputTokens` (the per-call LLM output cap) and a
 *   wall-clock-free abort timer (the injected `clock` supplies timestamps; the abort
 *   uses the sanctioned-root `systemSetTimeout`).
 *
 * @module
 */

import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import type { ClockPort, ComisLogger } from "@comis/core";
import { completeSimple } from "@earendil-works/pi-ai";
import { resolveJudgeModel, type CustomCompletionsModelSpec } from "./judge-model-resolver.js";
import {
  buildRelationshipPrompt,
  parseRelationshipOutput,
  type RelationshipBuildOutput,
} from "./memory-relationship-prompt.js";

/** Hard abort ceiling per LLM call (mirrors the user-representation-seam LLM timeout). */
const LLM_TIMEOUT_MS = 120_000;

/** The cheap-model + key + bound the daemon resolves for one relationship-build run. */
export interface RelationshipSeamDeps {
  /** Resolved cheap provider (the "cron" operation model — never the agent's primary). */
  provider: string;
  /** Resolved cheap model id. */
  modelId: string;
  /** The API key VALUE (resolved by NAME at the daemon; never logged here). */
  apiKey: string;
  /** Per-call LLM output bound (the cost axis; mirrors maxEntriesPerRun's intent). */
  maxOutputTokens: number;
  /** Wall-clock reads — the per-message timestamp. NEVER a wall-clock global. */
  clock: ClockPort;
  /** Counts-only logger (the seam logs failures with a hint + errorKind, never bodies). */
  logger: ComisLogger;
  /** Scope tag for the failure logs. */
  agentId: string;
  /** Custom-provider model spec (resolved `/v1` baseUrl) for a keyless/local YAML provider
   *  the pi-ai catalog can't see — without it the relationship build skipped on keyless
   *  (the #223/DIALECTIC-FIX bug class). Optional: built-in providers omit it. */
  customModel?: CustomCompletionsModelSpec;
}

/** Pull the concatenated text parts out of a pi-ai completeSimple response. */
function extractResponseText(response: { content?: unknown[] }): string {
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
 * Build the OFFLINE directional relationship build seam from a cheap resolved model.
 *
 * Returns the `build(sourceText)` function {@link runRelationshipBuild} injects: it
 * issues ONE cheap-model call over the sender-prefixed source-memory text (the
 * system prompt is {@link buildRelationshipPrompt}, which embeds
 * `RELATIONSHIP_PROMPT`), parses the response via the lenient/total
 * {@link parseRelationshipOutput}, and returns the typed
 * {@link RelationshipBuildOutput}. A model-resolution failure, a thrown/aborted
 * call, or a malformed payload degrades to `[]` — the seam NEVER throws out
 * (non-fatal, the same posture as the user-representation/reasoning seams).
 */
export function createRelationshipSeam(
  deps: RelationshipSeamDeps,
): (sourceText: string) => Promise<RelationshipBuildOutput> {
  const { provider, modelId, apiKey, maxOutputTokens, clock, logger, agentId, customModel } = deps;

  /** Issue one bounded, non-fatal cheap-model call; return raw text or undefined. */
  async function callModel(systemPrompt: string, userText: string): Promise<string | undefined> {
    let model;
    try {
      // Catalog-first, else construct from customModel (keyless/local) — #223/DIALECTIC-FIX.
      model = resolveJudgeModel(provider, modelId, customModel);
    } catch (modelErr) {
      logger.warn(
        {
          agentId,
          err: modelErr,
          errorKind: "dependency" as const,
          step: "relationship" as const,
          hint: `could not resolve model ${provider}/${modelId} — skipping this relationship build`,
        },
        "Relationship model resolution failed (non-fatal)",
      );
      return undefined;
    }
    if (!model) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          step: "relationship" as const,
          hint: `model not found ${provider}/${modelId} — skipping this relationship build`,
        },
        "Relationship model not found (non-fatal)",
      );
      return undefined;
    }

    const controller = new AbortController();
    const timer = systemSetTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const response = await completeSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: "user" as const, content: userText, timestamp: clock.now() }],
        },
        {
          apiKey,
          temperature: 0.2,
          maxTokens: maxOutputTokens,
          signal: controller.signal,
        },
      );
      return extractResponseText(response);
    } catch (llmErr) {
      logger.warn(
        {
          agentId,
          err: llmErr,
          errorKind: "dependency" as const,
          step: "relationship" as const,
          hint: "relationship build LLM call failed/aborted — no candidates from this run",
        },
        "Relationship LLM call failed (non-fatal)",
      );
      return undefined;
    } finally {
      systemClearTimeout(timer);
    }
  }

  return async function build(sourceText: string): Promise<RelationshipBuildOutput> {
    // ONE distillation call. The system prompt embeds RELATIONSHIP_PROMPT via
    // buildRelationshipPrompt (agent-internal); the sender-prefixed source text rides
    // the prompt. The user message repeats the source set so the call carries it on
    // both axes (the prompt assembly is internal — counts-only callers never log it).
    const systemPrompt = buildRelationshipPrompt(sourceText);
    const text = await callModel(systemPrompt, sourceText);
    if (text === undefined) return [];
    // The lenient/total parser STRIPS any smuggled trust + drops endpoint-less
    // candidates (never throws; a malformed payload → []).
    return parseRelationshipOutput(text);
  };
}
