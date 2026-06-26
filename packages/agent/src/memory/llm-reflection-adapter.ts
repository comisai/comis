// SPDX-License-Identifier: Apache-2.0
/**
 * The LLM-backed reflection adapter (v2.31 Reflection engine, Phase 223 Plan 04,
 * INV-5) — the cheap-model call seam the reflection job uses to distil a doc.
 * The reflect-engine replacement for the deleted `llm-skill-synthesis-adapter.ts`
 * (the cron deletes follow in Plans 05/06); it mirrors that adapter's two
 * load-bearing security properties:
 *
 *  1. The UNTRUSTED `trajectoryText` is `wrapExternalContent`-wrapped (the
 *     `learned_skill_reflection` source) BEFORE it reaches the LLM — the
 *     injection-defense keystone (INV-5). An injection embedded in the trajectory
 *     is delimited + labeled, never bare in the prompt. The doc's CURRENT
 *     sections (system-derived, trusted) are passed as a trusted preamble OUTSIDE
 *     the wrapped block so the model can emit a minimal delta against them.
 *  2. The response is parsed by the TOTAL {@link parseReflectionResult} — a
 *     malformed / adversarial payload yields `ok({})` (never a throw, never a
 *     half-formed op/section). Any LLM transport fault surfaces as `err(...)`,
 *     and a pi-ai `{stopReason:"error"}` ALSO surfaces as `err(...)` with a WARN
 *     naming the model (NOT a silent empty parse — the live-2026-06-18 judge
 *     precedent).
 *
 * Closed graph: this adapter consumes the `@comis/core` security keystone
 * (`wrapExternalContent`) + the `@comis/core` reflection types (`DocSection`) +
 * the `@earendil-works/pi-ai` model SDK — it imports NO `@comis/memory` /
 * `@comis/skills` value (the agent↛memory / agent↛skills closed-graph cut). The
 * cheap model is resolved via {@link resolveJudgeModel} (the keyless/custom seam
 * that survives the synthesis delete — 11 other consumers).
 *
 * @module
 */

import { ok, err, fromPromise, type Result } from "@comis/shared";
import { systemSetTimeout, systemClearTimeout, wrapExternalContent } from "@comis/core";
import type { DocSection, ExternalContentSource } from "@comis/core";
import { completeSimple } from "@earendil-works/pi-ai";
import { resolveJudgeModel, temperatureOption, type CustomCompletionsModelSpec } from "./judge-model-resolver.js";
import { REFLECT_PROMPT, parseReflectionResult, type ReflectionResult } from "./reflection-prompt.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard wall-clock bound on the single reflection LLM call (mirrors the cron jobs). */
const LLM_TIMEOUT_MS = 120_000;

/** Output-token cap for one reflection call (a doc body / delta is bounded prose). */
const REFLECT_MAX_TOKENS = 2_000;

/** Low LLM temperature — the doc should be a faithful generalization, not creative. */
const REFLECT_TEMPERATURE = 0.3;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** A minimal structural logger (no Pino import — the closed-graph discipline). */
export interface ReflectionAdapterLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Dependencies injected into {@link createLlmReflectionAdapter}. */
export interface LlmReflectionAdapterDeps {
  /** Provider id of the resolved cheap (judge-tier) model. */
  provider: string;
  /** Model id of the resolved cheap model. */
  modelId: string;
  /** The API key for the resolved provider (resolved daemon-side; never logged). */
  apiKey: string;
  /** Custom-provider model spec (resolved `/v1` baseUrl) so a keyless/local YAML provider the
   *  pi-ai catalog can't see still resolves a model — else reflection is skipped on keyless. */
  customModel?: CustomCompletionsModelSpec;
  /** Wall-clock reads for message timestamps — NEVER a wall-clock global. */
  clock: { now: () => number };
  /**
   * The per-kind reflect system prompt (Phase 225 FOLD). Omitted ⇒ the skill
   * `REFLECT_PROMPT` (a skill adapter stays byte-identical). Plans 02/03 pass
   * `PROFILE_REFLECT_PROMPT` / `TOPIC_REFLECT_PROMPT`.
   */
  systemPrompt?: string;
  /**
   * The per-kind `wrapExternalContent` source label (Phase 225 FOLD) — the
   * UNTRUSTED-input boundary the LLM sees. Omitted ⇒ `"learned_skill_reflection"`.
   * Plans 02/03 pass `"learned_profile_reflection"` / `"learned_topic_reflection"`.
   */
  source?: ExternalContentSource;
  /** Structural logger (counts/ids/step only — never doc bodies). */
  logger: ReflectionAdapterLogger;
}

/** One reflection request: the untrusted transcript + the doc's CURRENT sections (trusted). */
export interface ReflectInput {
  /** The flattened trajectory text the adapter wraps + distils. UNTRUSTED. */
  trajectoryText: string;
  /** The doc's current structured sections (empty ⇒ synthesize a fresh playbook). Trusted (system-derived). */
  currentSections: DocSection[];
}

/** The reflect adapter the job consumes (a thin, minimal port-shape). */
export interface ReflectionAdapter {
  reflect(input: ReflectInput): Promise<Result<ReflectionResult, Error>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the concatenated text parts from a completeSimple response. */
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

/** Render the doc's current sections as a trusted JSON preamble (the model edits against it). */
function renderCurrentDoc(sections: DocSection[]): string {
  if (sections.length === 0) return "CURRENT DOC: (empty — synthesize a fresh section list)";
  return `CURRENT DOC sections:\n${JSON.stringify({ sections }, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Construct the LLM-backed {@link ReflectionAdapter}.
 *
 * The returned adapter NEVER throws: every failure is a `Result` — a model
 * resolution / transport fault is `err(...)`; a malformed model payload is
 * `ok({})`. The untrusted trajectory is wrapped before the LLM regardless of
 * content.
 */
export function createLlmReflectionAdapter(deps: LlmReflectionAdapterDeps): ReflectionAdapter {
  const { provider, modelId, apiKey, customModel, clock, logger } = deps;
  // Per-kind prompt + source label (Phase 225 FOLD) — default to the skill values
  // so an existing skill adapter construction is byte-identical.
  const systemPrompt = deps.systemPrompt ?? REFLECT_PROMPT;
  const source: ExternalContentSource = deps.source ?? "learned_skill_reflection";

  async function reflect(input: ReflectInput): Promise<Result<ReflectionResult, Error>> {
    const { trajectoryText, currentSections } = input;

    // SECURITY: wrap the UNTRUSTED trajectory BEFORE the LLM — the
    // injection-defense keystone (INV-5). The delimited + labeled block is the
    // boundary an embedded injection cannot cross. The doc's CURRENT sections are
    // a TRUSTED preamble OUTSIDE the wrapped block. The per-kind source label only
    // varies the boundary's label (the 223 `learned_skill_reflection` precedent).
    const wrapped = wrapExternalContent(trajectoryText, { source });
    const userContent = `${renderCurrentDoc(currentSections)}\n\nSUCCESSFUL trajectories to distil:\n${wrapped}`;

    let model;
    try {
      // Catalog-first, else construct from customModel (keyless/local).
      model = resolveJudgeModel(provider, modelId, customModel);
    } catch (modelErr) {
      return err(
        new Error(
          `Failed to resolve reflection model ${provider}/${modelId}: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`,
        ),
      );
    }
    if (!model) {
      return err(new Error(`Reflection model not found: ${provider}/${modelId}`));
    }

    const controller = new AbortController();
    const timer = systemSetTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    const responseResult = await fromPromise(
      completeSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: "user" as const, content: userContent, timestamp: clock.now() }],
        },
        {
          apiKey,
          ...temperatureOption(model, REFLECT_TEMPERATURE),
          maxTokens: REFLECT_MAX_TOKENS,
          signal: controller.signal,
        },
      ),
    );
    systemClearTimeout(timer);

    if (!responseResult.ok) {
      logger.warn(
        {
          submodule: "llm-reflection-adapter",
          step: "reflect" as const,
          // Closed-union errorKind: a network-class transport fault on the LLM call.
          errorKind: "network" as const,
          hint: "reflection LLM call failed; the topic is skipped this run (the prior doc survives)",
        },
        "reflection LLM call failed",
      );
      return err(
        new Error(
          `Reflection LLM call failed: ${responseResult.error instanceof Error ? responseResult.error.message : String(responseResult.error)}`,
        ),
      );
    }

    // A pi-ai API error does NOT throw — it RETURNS `{stopReason:"error", content:[],
    // errorMessage}` (e.g. a retired/invalid model id 404). Treat it like the thrown
    // branch above: WARN naming the model + skip the topic (err), NOT a silent empty
    // parse (the live-2026-06-18 judge precedent). The deterministic !ok branch only
    // catches a THROWN/transport fault.
    const resp = responseResult.value as { content?: unknown[]; stopReason?: string; errorMessage?: string };
    if (resp.stopReason === "error" || (Array.isArray(resp.content) && resp.content.length === 0)) {
      logger.warn(
        {
          submodule: "llm-reflection-adapter",
          step: "reflect" as const,
          errorKind: "dependency" as const,
          model: `${provider}/${modelId}`,
          hint: `reflection model returned an error/empty response (${resp.errorMessage ?? "no content"}) — topic skipped; verify the resolved cheap model id is valid for ${provider}`,
        },
        "reflection model returned error/empty response",
      );
      return err(new Error(`Reflection model error/empty: ${resp.errorMessage ?? "no content"}`));
    }

    // TOTAL parse — never throws; a malformed payload yields {} (the job's
    // empty-content guard then skips admit, REFLECT-05).
    const result = parseReflectionResult(extractResponseText(responseResult.value as { content?: unknown[] }));

    logger.debug(
      {
        submodule: "llm-reflection-adapter",
        step: "reflect" as const,
        opCount: result.ops?.length ?? 0,
        sectionCount: result.sections?.length ?? 0,
      },
      "reflection call complete",
    );

    return ok(result);
  }

  return { reflect };
}
