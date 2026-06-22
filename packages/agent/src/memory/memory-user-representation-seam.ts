// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-injected OFFLINE per-user representation build seam builder.
 *
 * {@link runUserRepresentationBuild} takes an INJECTED `build` seam (a HIGH-TRUST
 * source-memory text → typed {@link UserRepresentationBuildOutput} candidates). This
 * module is the factory the daemon's `__USER_REPRESENTATION__` sentinel calls to BUILD
 * that seam from a cheap resolved model — so the daemon stays thin and the builder
 * prompt (`USER_REPRESENTATION_PROMPT`, embedded by {@link buildUserRepresentationPrompt}) + its lenient/total parser
 * ({@link parseUserRepresentationOutput}) stay AGENT-INTERNAL (the prompt string never
 * crosses the package boundary, mirroring how {@link createReasoningSeam} keeps
 * `DEDUCTIVE_PROMPT`/`INDUCTIVE_PROMPT` private).
 *
 * Security posture (the same anti-laundering discipline as the reasoning seam):
 * - ONE cheap-model call per source set (the per-user profile is a single distillation,
 *   not the reasoning job's two specialist contracts).
 * - The lenient `z.object` parser STRIPS any smuggled `trust` field before the value
 *   reaches the job — trust is computed in CODE by the job at the source ceiling, NEVER
 *   chosen by the LLM. An out-of-set `entryType` is dropped (the four prefix-types only).
 * - NON-FATAL: a thrown/aborted/malformed call yields `[]` (the seam never throws out —
 *   the job's `fromPromise` wrap is a second belt, but the seam already degrades).
 * - Each call is BOUNDED by `maxOutputTokens` (the per-call LLM output cap) and a
 *   wall-clock-free abort timer (the injected `clock` supplies timestamps; the abort uses
 *   the sanctioned-root `systemSetTimeout`).
 *
 * @module
 */

import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import type { ClockPort, ComisLogger } from "@comis/core";
import { completeSimple } from "@earendil-works/pi-ai";
import { resolveJudgeModel, temperatureOption, type CustomCompletionsModelSpec } from "./judge-model-resolver.js";
import {
  buildUserRepresentationPrompt,
  parseUserRepresentationOutput,
  type UserRepresentationBuildOutput,
} from "./memory-user-representation-prompt.js";

/** Hard abort ceiling per LLM call (mirrors the reasoning-seam LLM timeout). */
const LLM_TIMEOUT_MS = 120_000;

/** The cheap-model + key + bound the daemon resolves for one representation-build run. */
export interface UserRepresentationSeamDeps {
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
  /**
   * Custom-provider model spec (resolved `/v1` baseUrl) for a YAML provider
   * (ollama / lm-studio / …) the pi-ai catalog can't see. Without it, a keyless/local
   * user-representation build resolved "model not found" and SKIPPED every run — the
   * keyless memory-quality pipeline was dead (live 2026-06-20; the #223/DIALECTIC-FIX
   * bug class). Optional: built-in providers omit it.
   */
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
 * Build the OFFLINE per-user representation build seam from a cheap resolved model.
 *
 * Returns the `build(sourceText)` function {@link runUserRepresentationBuild} injects: it
 * issues ONE cheap-model call over the source-memory text (the system prompt is
 * {@link buildUserRepresentationPrompt}, which embeds `USER_REPRESENTATION_PROMPT`),
 * parses the response via the lenient/total {@link parseUserRepresentationOutput}, and
 * returns the typed {@link UserRepresentationBuildOutput}. A model-resolution failure, a
 * thrown/aborted call, or a malformed payload degrades to `[]` — the seam NEVER throws out
 * (non-fatal, the same posture as the reasoning/consolidation/extraction seams).
 */
export function createUserRepresentationSeam(
  deps: UserRepresentationSeamDeps,
): (sourceText: string) => Promise<UserRepresentationBuildOutput> {
  const { provider, modelId, apiKey, maxOutputTokens, clock, logger, agentId, customModel } = deps;

  /** Issue one bounded, non-fatal cheap-model call; return raw text or undefined. */
  async function callModel(systemPrompt: string, userText: string): Promise<string | undefined> {
    let model;
    try {
      // Catalog-first, else construct from customModel (keyless/local YAML provider) —
      // mirrors the #223 judge-model-resolver / DIALECTIC-FIX.
      model = resolveJudgeModel(provider, modelId, customModel);
    } catch (modelErr) {
      logger.warn(
        {
          agentId,
          err: modelErr,
          errorKind: "dependency" as const,
          step: "user-repr" as const,
          hint: `could not resolve model ${provider}/${modelId} — skipping this representation build`,
        },
        "User representation model resolution failed (non-fatal)",
      );
      return undefined;
    }
    if (!model) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          step: "user-repr" as const,
          hint: `model not found ${provider}/${modelId} — skipping this representation build`,
        },
        "User representation model not found (non-fatal)",
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
          ...temperatureOption(model, 0.2),
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
          step: "user-repr" as const,
          hint: "representation build LLM call failed/aborted — no candidates from this run",
        },
        "User representation LLM call failed (non-fatal)",
      );
      return undefined;
    } finally {
      systemClearTimeout(timer);
    }
  }

  return async function build(sourceText: string): Promise<UserRepresentationBuildOutput> {
    // ONE distillation call. The system prompt embeds USER_REPRESENTATION_PROMPT via
    // buildUserRepresentationPrompt (agent-internal); the source text rides the prompt.
    // The user message repeats the source set so the call carries it on both axes (the
    // prompt assembly is internal — counts-only callers never log the returned text).
    const systemPrompt = buildUserRepresentationPrompt(sourceText);
    const text = await callModel(systemPrompt, sourceText);
    if (text === undefined) return [];
    // The lenient/total parser STRIPS any smuggled trust + drops out-of-set entryTypes
    // (never throws; a malformed payload → []).
    return parseUserRepresentationOutput(text);
  };
}
