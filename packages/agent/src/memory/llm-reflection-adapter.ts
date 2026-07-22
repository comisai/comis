// SPDX-License-Identifier: Apache-2.0
/**
 * The LLM-backed reflection adapter — the cheap-model call seam the reflection
 * job uses to distil a doc.
 * It carries two load-bearing security properties:
 *
 *  1. The UNTRUSTED `trajectoryText` is `wrapExternalContent`-wrapped (the
 *     `learned_skill_reflection` source) BEFORE it reaches the LLM — the
 *     injection-defense keystone. An injection embedded in the trajectory
 *     is delimited + labeled, never bare in the prompt. The doc's CURRENT
 *     sections (system-derived, trusted) are passed as a trusted preamble OUTSIDE
 *     the wrapped block so the model can emit a minimal delta against them.
 *  2. The response is parsed by the TOTAL {@link parseReflectionResult} — a
 *     malformed / adversarial payload yields `ok({})` (never a throw, never a
 *     half-formed op/section). Any LLM transport fault surfaces as `err(...)`,
 *     and a pi-ai `{stopReason:"error"}` ALSO surfaces as `err(...)` with a WARN
 *     naming the model (NOT a silent empty parse — the same diagnosability rule
 *     the outcome judge follows).
 *
 * Closed graph: this adapter consumes the `@comis/core` security keystone
 * (`wrapExternalContent`) + the `@comis/core` reflection types (`DocSection`) +
 * the `@earendil-works/pi-ai` model SDK — it imports NO `@comis/memory` /
 * `@comis/skills` value (the agent↛memory / agent↛skills closed-graph cut). The
 * cheap model is resolved via {@link resolveJudgeModel} (the shared keyless/custom
 * resolution seam).
 *
 * @module
 */

import { ok, err, fromPromise, type Result } from "@comis/shared";
import { systemSetTimeout, systemClearTimeout, wrapExternalContent } from "@comis/core";
import type { DocSection, ExternalContentSource } from "@comis/core";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { estimateMessageTokens } from "../safety/token-estimator.js";
import { resolveJudgeModel, temperatureOption, type CustomCompletionsModelSpec } from "./judge-model-resolver.js";
import { REFLECT_PROMPT, parseReflectionResult, type ReflectionResult } from "./reflection-prompt.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard wall-clock bound on the single reflection LLM call (mirrors the cron jobs). */
const LLM_TIMEOUT_MS = 120_000;

/** Output-token cap for one reflection call (a doc body / delta is bounded prose). */
const REFLECT_MAX_TOKENS = 2_000;

/** The completeSimple adapter reserves this much context before output clamping. */
const COMPLETE_SIMPLE_CONTEXT_SAFETY_TOKENS = 4_096;

/** Additional model-context headroom reserved for reflection input estimation. */
const REFLECTION_CONTEXT_SAFETY_PERCENT = 5;

/** Low LLM temperature — the doc should be a faithful generalization, not creative. */
const REFLECT_TEMPERATURE = 0.3;

/** Smallest useful head and tail retained when an oversized trajectory is bounded. */
const MIN_TRAJECTORY_EDGE_CHARS = 64;

/** Explicit marker between the retained trajectory head and tail. */
const TRAJECTORY_OMISSION_MARKER = "[trajectory content omitted to fit the model context]";

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
  apiKey?: string;
  /** Provider-scoped configuration for native model authentication; never logged. */
  providerEnv?: Record<string, string>;
  /** Scheduler-owned cancellation for the enclosing reflection occurrence. */
  signal?: AbortSignal;
  /** Custom-provider model spec (resolved `/v1` baseUrl) so a keyless/local YAML provider the
   *  pi-ai catalog can't see still resolves a model — else reflection is skipped on keyless. */
  customModel?: CustomCompletionsModelSpec;
  /** Wall-clock reads for message timestamps — NEVER a wall-clock global. */
  clock: { now: () => number };
  /**
   * The per-kind reflect system prompt. Omitted ⇒ the skill
   * `REFLECT_PROMPT` (a skill adapter stays byte-identical). Profile/topic
   * adapters pass `PROFILE_REFLECT_PROMPT` / `TOPIC_REFLECT_PROMPT`.
   */
  systemPrompt?: string;
  /**
   * The per-kind `wrapExternalContent` source label — the
   * UNTRUSTED-input boundary the LLM sees. Omitted ⇒ `"learned_skill_reflection"`.
   * Profile/topic adapters pass `"learned_profile_reflection"` / `"learned_topic_reflection"`;
   * the procedure pass passes `"learned_procedure_reflection"` (a distinct label so the
   * procedure transcript is wrapped under its own boundary).
   */
  source?: ExternalContentSource;
  /** Structural logger (counts/ids/step only — never doc bodies). */
  logger: ReflectionAdapterLogger;
  /**
   * Optional per-call usage sink. A background reflection run spends real
   * tokens with no executor in the loop — without this hook the spend hits
   * the provider bill with ZERO obs rows (invisible to system/billing). The
   * daemon wiring forwards it as an `observability:token_usage` event under
   * the synthetic `__REFLECT__` session key. Best-effort: a throwing sink
   * never fails the reflect call.
   */
  onUsage?: (usage: ReflectionLlmUsage) => void;
}

/** Content-free LLM usage from ONE reflection call (SDK usage passthrough). */
export interface ReflectionLlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  durationMs: number;
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

/** Estimate natural-language prompt tokens through the agent's canonical, script-aware estimator. */
function estimateTextTokens(content: string): number {
  return estimateMessageTokens({ role: "user", content, timestamp: 0 });
}

/** Retain deterministic, equally-sized evidence from both ends of an oversized trajectory. */
function retainTrajectoryEdges(trajectoryText: string, retainedChars: number): string {
  if (retainedChars >= trajectoryText.length) return trajectoryText;

  const headChars = Math.ceil(retainedChars / 2);
  const tailChars = Math.floor(retainedChars / 2);
  return [
    trajectoryText.slice(0, headChars),
    TRAJECTORY_OMISSION_MARKER,
    tailChars > 0 ? trajectoryText.slice(-tailChars) : "",
  ].join("\n\n");
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
  const { provider, modelId, apiKey, providerEnv, customModel, clock, logger } = deps;
  // Per-kind prompt + source label — default to the skill values
  // so an existing skill adapter construction is byte-identical.
  const systemPrompt = deps.systemPrompt ?? REFLECT_PROMPT;
  const source: ExternalContentSource = deps.source ?? "learned_skill_reflection";

  async function reflect(input: ReflectInput): Promise<Result<ReflectionResult, Error>> {
    const { trajectoryText, currentSections } = input;

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

    const reflectionOutputTokens = Math.min(REFLECT_MAX_TOKENS, model.maxTokens);
    const safetyMarginTokens = Math.max(
      Math.ceil((model.contextWindow * REFLECTION_CONTEXT_SAFETY_PERCENT) / 100),
      COMPLETE_SIMPLE_CONTEXT_SAFETY_TOKENS,
    );
    const inputBudgetTokens = Math.max(
      0,
      model.contextWindow - reflectionOutputTokens - safetyMarginTokens,
    );
    const systemPromptTokens = estimateTextTokens(systemPrompt);
    const trustedPreamble = `${renderCurrentDoc(currentSections)}\n\nSUCCESSFUL trajectories to distil:\n`;

    // SECURITY: truncate only the UNTRUSTED trajectory, then wrap the retained
    // text. The trusted current document is always passed byte-for-byte, outside
    // the delimited block. Each candidate gets a complete boundary, so fitting
    // can never cut off the end marker or expose attacker-controlled text.
    const buildUserContent = (retainedChars: number): string => {
      const boundedTrajectory = retainTrajectoryEdges(trajectoryText, retainedChars);
      return `${trustedPreamble}${wrapExternalContent(boundedTrajectory, { source })}`;
    };
    const fitsInputBudget = (content: string): boolean =>
      systemPromptTokens + estimateTextTokens(content) <= inputBudgetTokens;

    let retainedTrajectoryChars = trajectoryText.length;
    let userContent = buildUserContent(retainedTrajectoryChars);

    if (!fitsInputBudget(userContent)) {
      const minimumRetainedChars = Math.min(
        trajectoryText.length,
        MIN_TRAJECTORY_EDGE_CHARS * 2,
      );
      const minimumUserContent = buildUserContent(minimumRetainedChars);
      const minimumInputTokens = systemPromptTokens + estimateTextTokens(minimumUserContent);

      if (minimumInputTokens > inputBudgetTokens) {
        logger.warn(
          {
            submodule: "llm-reflection-adapter",
            step: "fit-context" as const,
            errorKind: "precondition" as const,
            model: `${provider}/${modelId}`,
            contextWindowTokens: model.contextWindow,
            inputBudgetTokens,
            requiredInputTokens: minimumInputTokens,
            hint: "use a reflection model with a larger context window or compact the current learned document before retrying",
          },
          "reflection prompt exceeds model context",
        );
        return err(
          new Error(
            `Reflection prompt requires at least ${minimumInputTokens} input tokens but ${provider}/${modelId} allows ${inputBudgetTokens}`,
          ),
        );
      }

      // Find the largest deterministic head/tail retention that the resolved
      // model can accept. Every stored candidate has already passed the same
      // script-aware estimator used by the agent's context pipeline.
      retainedTrajectoryChars = minimumRetainedChars;
      userContent = minimumUserContent;
      let lower = minimumRetainedChars + 1;
      let upper = trajectoryText.length - 1;
      while (lower <= upper) {
        const candidateRetainedChars = Math.floor((lower + upper) / 2);
        const candidateUserContent = buildUserContent(candidateRetainedChars);
        if (fitsInputBudget(candidateUserContent)) {
          retainedTrajectoryChars = candidateRetainedChars;
          userContent = candidateUserContent;
          lower = candidateRetainedChars + 1;
        } else {
          upper = candidateRetainedChars - 1;
        }
      }

      logger.debug(
        {
          submodule: "llm-reflection-adapter",
          step: "fit-context" as const,
          model: `${provider}/${modelId}`,
          trajectoryChars: trajectoryText.length,
          retainedTrajectoryChars,
          inputBudgetTokens,
        },
        "reflection trajectory bounded to model context",
      );
    }

    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(deps.signal?.reason);
    if (deps.signal?.aborted === true) controller.abort(deps.signal.reason);
    else deps.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = systemSetTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    const callStartMs = clock.now();

    const responseResult = await fromPromise(
      completeSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: "user" as const, content: userContent, timestamp: clock.now() }],
        },
        {
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(providerEnv === undefined ? {} : { env: providerEnv }),
          ...temperatureOption(model, REFLECT_TEMPERATURE),
          maxTokens: reflectionOutputTokens,
          signal: controller.signal,
        },
      ),
    );
    systemClearTimeout(timer);
    deps.signal?.removeEventListener("abort", abortFromCaller);

    if (!responseResult.ok) {
      logger.warn(
        {
          submodule: "llm-reflection-adapter",
          step: "reflect" as const,
          // Closed-union errorKind: a network-class transport fault on the LLM call.
          errorKind: "network" as const,
          model: `${provider}/${modelId}`,
          durationMs: clock.now() - callStartMs,
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

    // Usage attribution — BEFORE the stopReason guard: an error-stop response
    // still spent tokens, and unattributed spend is exactly the gap this hook
    // closes. Best-effort: absent usage (older providers) skips silently and a
    // throwing sink never fails the reflect call.
    if (deps.onUsage !== undefined) {
      try {
        const usage = (responseResult.value as {
          usage?: {
            input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
            cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
          };
        }).usage;
        if (usage !== undefined) {
          deps.onUsage({
            inputTokens: usage.input ?? 0,
            outputTokens: usage.output ?? 0,
            cacheReadTokens: usage.cacheRead ?? 0,
            cacheWriteTokens: usage.cacheWrite ?? 0,
            cost: {
              input: usage.cost?.input ?? 0,
              output: usage.cost?.output ?? 0,
              cacheRead: usage.cost?.cacheRead ?? 0,
              cacheWrite: usage.cost?.cacheWrite ?? 0,
              total: usage.cost?.total ?? 0,
            },
            durationMs: clock.now() - callStartMs,
          });
        }
      } catch {
        // Usage attribution is best-effort — never fail the reflect call.
      }
    }

    // A pi-ai API error does NOT throw — it RETURNS `{stopReason:"error", content:[],
    // errorMessage}` (e.g. a retired/invalid model id 404). Treat it like the thrown
    // branch above: WARN naming the model + skip the topic (err), NOT a silent empty
    // parse (the same diagnosability rule the outcome judge follows). The
    // deterministic !ok branch only catches a THROWN/transport fault.
    const resp = responseResult.value as { content?: unknown[]; stopReason?: string; errorMessage?: string };
    if (resp.stopReason === "error" || (Array.isArray(resp.content) && resp.content.length === 0)) {
      logger.warn(
        {
          submodule: "llm-reflection-adapter",
          step: "reflect" as const,
          errorKind: "dependency" as const,
          model: `${provider}/${modelId}`,
          durationMs: clock.now() - callStartMs,
          hint: `reflection model returned an error/empty response (${resp.errorMessage ?? "no content"}) — topic skipped; verify the resolved cheap model id is valid for ${provider}`,
        },
        "reflection model returned error/empty response",
      );
      return err(new Error(`Reflection model error/empty: ${resp.errorMessage ?? "no content"}`));
    }

    // TOTAL parse — never throws; a malformed payload yields {} (the job's
    // empty-content guard then skips the admit).
    const result = parseReflectionResult(extractResponseText(responseResult.value as { content?: unknown[] }));

    logger.debug(
      {
        submodule: "llm-reflection-adapter",
        step: "reflect" as const,
        model: `${provider}/${modelId}`,
        durationMs: clock.now() - callStartMs,
        opCount: result.ops?.length ?? 0,
        sectionCount: result.sections?.length ?? 0,
      },
      "reflection call complete",
    );

    return ok(result);
  }

  return { reflect };
}
