// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-injected QUERY-TIME dialectic synthesis seam builder
 * (the ONE allowed query-time LLM surface).
 *
 * {@link createDialecticSeam} is the factory the daemon's `memory.ask` handler
 * calls to BUILD the `synthesize(question, groundingText)` seam from a cheap resolved model
 * (the daemon injects the model + key). It mirrors {@link createUserRepresentationSeam}
 * verbatim in structure, so the synthesis prompt (`DIALECTIC_PROMPT`, embedded by
 * {@link buildDialecticPrompt}) + its lenient/total parser ({@link parseDialecticOutput})
 * stay AGENT-INTERNAL — the prompt string never crosses the package boundary, mirroring how
 * `createReasoningSeam` keeps `DEDUCTIVE_PROMPT`/`INDUCTIVE_PROMPT` private.
 *
 * This is the ONLY query-time LLM call in the platform's memory path — the recall hot path
 * stays deterministic + LLM-free. The seam runs OVER the already-trust-filtered, redacted
 * recall output (the daemon assembles the grounding text from `createMemoryRecall`'s
 * survivors); it never reads raw memories.
 *
 * Security posture (the same discipline as the reasoning/representation seams):
 * - ONE bounded `completeSimple` call per ask — `temperature: 0` (deterministic synthesis),
 *   `maxTokens: maxOutputTokens` (the cost cap), and an `AbortController` armed by the
 *   sanctioned-root `systemSetTimeout` (the wall-clock-free abort; the injected `clock`
 *   supplies the per-message timestamp).
 * - NON-FATAL: a model-resolution failure, a thrown/aborted call, or a malformed payload
 *   degrades to `{ abstain: true }` — the seam NEVER throws into recall (mandatory abstention
 *   on failure, not a fabricated answer).
 * - Trust is NOT chosen by the LLM: the parser STRIPS any model-asserted `trust`/`trustLevel`;
 *   trust-first ordering is decided in CODE (`orderByTrust`, `memory-dialectic-synthesis.ts`).
 * - COUNTS/IDS-ONLY logging: a failure logs a `hint` + `errorKind` and NOTHING ELSE — the
 *   question, the grounding text, and the answer text are NEVER in the log fields (the
 *   strongest log-payload constraint).
 *
 * @module
 */

import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import type { ClockPort, ComisLogger } from "@comis/core";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { resolveJudgeModel, temperatureOption, type CustomCompletionsModelSpec } from "./judge-model-resolver.js";
import { buildDialecticPrompt, parseDialecticOutput, type DialecticParsed } from "./memory-dialectic-prompt.js";
import { resolveMemoryOpsStrategy } from "./memory-capability-router.js";
import type { CapabilityClass } from "../executor/model-profile.js";

/** Hard abort ceiling per LLM call (mirrors the representation/reasoning-seam LLM timeout). */
const LLM_TIMEOUT_MS = 120_000;

/** The cheap-model + key + bound the daemon resolves for one synthesis ask. */
export interface DialecticSeamDeps {
  /** Resolved cheap provider (the "cron"/cheap operation model — never the agent's primary). */
  provider: string;
  /** Resolved cheap model id. */
  modelId: string;
  /** The API key VALUE (resolved by NAME at the daemon; never logged here). */
  apiKey: string;
  /** Optional async credential resolver. When set, `callModel` awaits it before
   *  `completeSimple` and uses its return as the key. This routes OAuth providers (openai-codex)
   *  through `resolveProviderApiKey` (which sets pi's runtime-override token) instead of the static
   *  empty `apiKey` that made `memory.ask` abstain for OAuth deployments. Absent ⇒ the static `apiKey`
   *  (keyless / built-in / test paths byte-identical). */
  resolveCredential?: () => Promise<string>;
  /** Per-call LLM output bound (the cost axis; from `dialectic.maxOutputTokens`). */
  maxOutputTokens: number;
  /** Wall-clock reads — the per-message timestamp. NEVER a wall-clock global. */
  clock: ClockPort;
  /** Counts-only logger (the seam logs failures with a hint + errorKind, never bodies). */
  logger: ComisLogger;
  /** Scope tag for the failure logs. */
  agentId: string;
  /**
   * The capability class of the agent's model (from ModelProfile.capabilityClass).
   * When small/nano without a capable override, synthesize() returns { abstain: true }
   * immediately — no LLM call is made (fabrication mitigation).
   * Optional: callers that don't pass it default to "frontier" behavior (capable).
   */
  capabilityClass?: CapabilityClass;
  /**
   * Operator override — a stronger cheap model is configured for the memory
   * pipeline. When true, small/nano are treated as "capable" for dialectic synthesis.
   * Optional; defaults to false.
   */
  hasCapableModelOverride?: boolean;
  /**
   * Custom-provider model spec (the resolved OpenAI-compat `…/v1` baseUrl) for a
   * YAML provider (ollama / lm-studio / …) the pi-ai catalog does NOT know. Without
   * it, a keyless/local memory.ask resolved "model not found" and abstained on EVERY
   * ask — even with a capable model (live 2026-06-20; the #223 judge-resolver bug class
   * applied to the dialectic seam). Optional: built-in providers omit it.
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
 * Build the QUERY-TIME dialectic synthesis seam from a cheap resolved model.
 *
 * Returns the `synthesize(question, groundingText)` function the daemon's `memory.ask`
 * handler injects: it issues ONE bounded cheap-model call (the system prompt is
 * {@link buildDialecticPrompt}; the question + the recall grounding ride the user message),
 * parses the response via the lenient/total {@link parseDialecticOutput}, and returns the
 * typed {@link DialecticParsed}. A model-resolution failure, a thrown/aborted call, or a
 * malformed payload degrades to `{ abstain: true }` — the seam NEVER throws out (non-fatal,
 * the same posture as the reasoning/representation/consolidation seams). The
 * code-level abstention (`abstainIfInsufficient`) + citation validation run in the handler
 * AROUND this seam; the seam itself only produces (or abstains on) the raw parse.
 */
export function createDialecticSeam(
  deps: DialecticSeamDeps,
): (question: string, groundingText: string) => Promise<DialecticParsed> {
  const { provider, modelId, apiKey, maxOutputTokens, clock, logger, agentId, customModel } = deps;
  // Pre-resolve the capability routing (once per seam instance, not per call).
  // Defaults to "frontier" behavior when capabilityClass is absent (capable path).
  const capabilityClass = deps.capabilityClass ?? "frontier";
  const hasCapableModelOverride = deps.hasCapableModelOverride ?? false;
  const strategy = resolveMemoryOpsStrategy(capabilityClass, hasCapableModelOverride);

  /** Issue one bounded, non-fatal cheap-model call; return raw text or undefined. */
  async function callModel(systemPrompt: string, userText: string): Promise<string | undefined> {
    let model;
    try {
      // Catalog-first, else construct from customModel (the resolved …/v1 baseUrl) so a
      // keyless/local YAML provider the pi-ai catalog can't see still resolves — mirrors
      // the #223 judge-model-resolver fix (this seam was the missed sibling).
      model = resolveJudgeModel(provider, modelId, customModel);
    } catch (modelErr) {
      logger.warn(
        {
          agentId,
          err: modelErr,
          errorKind: "dependency" as const,
          step: "dialectic" as const,
          hint: `could not resolve model ${provider}/${modelId} — abstaining`,
        },
        "Dialectic synthesis model resolution failed (non-fatal)",
      );
      return undefined;
    }
    if (!model) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          step: "dialectic" as const,
          hint: `model not found ${provider}/${modelId} — abstaining`,
        },
        "Dialectic synthesis model not found (non-fatal)",
      );
      return undefined;
    }

    const controller = new AbortController();
    const timer = systemSetTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      // Resolve the credential per-call so OAuth providers (openai-codex) get their bearer
      // (via resolveProviderApiKey's runtime-override) instead of the static empty apiKey that made
      // memory.ask abstain. Falls back to the static apiKey (keyless / built-in / test).
      const resolvedApiKey = deps.resolveCredential ? await deps.resolveCredential() : apiKey;
      // Verified live: `temperatureOption` gates the deterministic temperature:0 on
      // `model.reasoning` — reasoning models (gpt-5.x, o-series, Claude Opus 4.7+) reject `temperature`
      // (HTTP 400 "Unsupported parameter: temperature" → empty response → abstain). Paired with
      // resolveCredential (the OAuth bearer); BOTH are required — the temperature 400 fired before auth.
      const response = await completeSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: "user" as const, content: userText, timestamp: clock.now() }],
        },
        {
          apiKey: resolvedApiKey,
          ...temperatureOption(model, 0),
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
          step: "dialectic" as const,
          hint: "dialectic synthesis failed — abstaining",
        },
        "Dialectic synthesis LLM call failed (non-fatal)",
      );
      return undefined;
    } finally {
      systemClearTimeout(timer);
    }
  }

  return async function synthesize(
    question: string,
    groundingText: string,
  ): Promise<DialecticParsed> {
    // Pre-call capability check (fabrication mitigation): if the capability class
    // routes to "abstain", return immediately — NO LLM call is made. A small/nano
    // model receiving a dialectic synthesis task will fabricate citations; this
    // gate prevents fabricated citations from entering trusted storage.
    // The diagnostic: "insufficient model capability to synthesize grounded citations".
    if (strategy === "abstain") {
      return { abstain: true };
    }

    // ONE synthesis call. The system prompt is buildDialecticPrompt() (agent-internal); the
    // question + the trust-filtered/redacted recall grounding ride the user message. The
    // raw text is never logged by counts-only callers.
    const systemPrompt = buildDialecticPrompt();
    const userText = `${question}\n\n${groundingText}`;
    const text = await callModel(systemPrompt, userText);
    if (text === undefined) return { abstain: true };
    // The lenient/total parser STRIPS any smuggled trust + degrades a malformed payload to
    // { abstain: true } (never throws).
    const parsed = parseDialecticOutput(text);
    // Counts-only parse outcome (live finding 2026-06-11): an abstain caused by a
    // malformed payload was indistinguishable from the model's explicit
    // {"abstain": true} — both returned the bare sentinel with zero log lines.
    // responseChars + the explicit-abstain marker discriminate the two without
    // ever logging the response body (AGENTS.md §2.7).
    logger.debug(
      {
        agentId,
        step: "dialectic" as const,
        responseChars: text.length,
        parsedAbstain: parsed.abstain,
        explicitAbstain: parsed.abstain && /"abstain"\s*:\s*true/.test(text),
        citedCount: parsed.abstain ? 0 : parsed.citedIds.length,
        groundingChars: groundingText.length,
      },
      "Dialectic synthesis parsed",
    );
    return parsed;
  };
}
