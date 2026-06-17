// SPDX-License-Identifier: Apache-2.0
/**
 * The LLM-backed {@link SkillSynthesisPort} adapter (v2.26 Verified Learning
 * WS2, SKILL-02).
 *
 * Transforms a cluster of SUCCESSFUL-trajectory text into zero-or-more
 * {@link CandidateSkill}s via a single cheap-model `completeSimple` call (the
 * cost-efficient non-agentic path, mirroring `memory-review-job`). Two
 * load-bearing security properties:
 *
 *  1. The UNTRUSTED `trajectoryText` is `wrapExternalContent`-wrapped (the NEW
 *     `learned_skill_synthesis` source) BEFORE it reaches the LLM — the
 *     injection-defense keystone (SKILL-02 / SEC-01). An injection embedded in
 *     the trajectory is delimited + labeled, never bare in the prompt.
 *  2. The response is parsed by the TOTAL {@link parseSynthesisResult} — a
 *     malformed / adversarial payload yields `ok([])` (never a throw, never a
 *     half-formed candidate). Any LLM transport fault surfaces as `err(...)`.
 *
 * This adapter consumes the `@comis/core` PORT TYPE only (`SkillSynthesisPort`,
 * `SynthesisInput`, `CandidateSkill`) + the `@earendil-works/pi-ai` model SDK —
 * it imports NO `@comis/memory` / `@comis/skills` (the agent↛memory / agent↛skills
 * closed-graph cut). It is capability-routed by the daemon (it constructs the
 * adapter only on the `skillSynthesis` mid tier); the abstain decision for
 * weak models lives in `runSkillSynthesis`, not here.
 *
 * @module
 */

import { ok, err, fromPromise, type Result } from "@comis/shared";
import { systemSetTimeout, systemClearTimeout, wrapExternalContent } from "@comis/core";
import type { SkillSynthesisPort, SynthesisInput, CandidateSkill } from "@comis/core";
import { completeSimple, getModel } from "@earendil-works/pi-ai";
import { SKILL_SYNTHESIS_PROMPT, parseSynthesisResult } from "./skill-synthesis-prompt.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard wall-clock bound on the single synthesis LLM call (mirrors the cron jobs). */
const LLM_TIMEOUT_MS = 120_000;

/** Output-token cap for one synthesis call (a procedure body is bounded prose). */
const SYNTHESIS_MAX_TOKENS = 2_000;

/** Low LLM temperature — the procedure should be a faithful generalization, not creative. */
const SYNTHESIS_TEMPERATURE = 0.3;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** A minimal structural logger (no Pino import — the closed-graph discipline). */
export interface SkillSynthesisLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Dependencies injected into {@link createLlmSkillSynthesisAdapter}. */
export interface LlmSkillSynthesisAdapterDeps {
  /** Provider id of the resolved `skillSynthesis`-tier model (mid tier, SKILL-09). */
  provider: string;
  /** Model id of the resolved `skillSynthesis`-tier model. */
  modelId: string;
  /** The API key for the resolved provider (resolved daemon-side; never logged). */
  apiKey: string;
  /** Wall-clock reads for message timestamps — NEVER a wall-clock global. */
  clock: { now: () => number };
  /** Structural logger (counts/ids/step only — never procedure bodies, SEC-01 §7). */
  logger: SkillSynthesisLogger;
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

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Construct the LLM-backed {@link SkillSynthesisPort}.
 *
 * The returned adapter NEVER throws: every failure is a `Result` — a model
 * resolution / transport fault is `err(...)`; a malformed model payload is
 * `ok([])`. The untrusted trajectory is wrapped before the LLM regardless of
 * content.
 */
export function createLlmSkillSynthesisAdapter(deps: LlmSkillSynthesisAdapterDeps): SkillSynthesisPort {
  const { provider, modelId, apiKey, clock, logger } = deps;

  async function synthesize(input: SynthesisInput): Promise<Result<CandidateSkill[], Error>> {
    const { trajectoryText, clusterTrajIds } = input;

    // SECURITY: wrap the UNTRUSTED trajectory BEFORE the LLM — the
    // injection-defense keystone (SKILL-02 / SEC-01). The delimited + labeled
    // block is the boundary an embedded injection cannot cross.
    const wrapped = wrapExternalContent(trajectoryText, { source: "learned_skill_synthesis" });

    let model;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider/modelId are dynamic strings
      model = getModel(provider as any, modelId as any);
    } catch (modelErr) {
      return err(
        new Error(
          `Failed to resolve synthesis model ${provider}/${modelId}: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`,
        ),
      );
    }
    if (!model) {
      return err(new Error(`Synthesis model not found: ${provider}/${modelId}`));
    }

    const controller = new AbortController();
    const timer = systemSetTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    const responseResult = await fromPromise(
      completeSimple(
        model,
        {
          systemPrompt: SKILL_SYNTHESIS_PROMPT,
          messages: [{ role: "user" as const, content: wrapped, timestamp: clock.now() }],
        },
        {
          apiKey,
          temperature: SYNTHESIS_TEMPERATURE,
          maxTokens: SYNTHESIS_MAX_TOKENS,
          signal: controller.signal,
        },
      ),
    );
    systemClearTimeout(timer);

    if (!responseResult.ok) {
      logger.warn(
        {
          submodule: "llm-skill-synthesis-adapter",
          step: "synthesize" as const,
          // Closed-union errorKind: a network-class transport fault on the LLM call.
          errorKind: "network" as const,
          clusterSize: clusterTrajIds.length,
          hint: "synthesis LLM call failed; the cluster is skipped this run (no partial admit)",
        },
        "skill synthesis LLM call failed",
      );
      return err(
        new Error(
          `Skill synthesis LLM call failed: ${responseResult.error instanceof Error ? responseResult.error.message : String(responseResult.error)}`,
        ),
      );
    }

    // TOTAL parse — never throws; a malformed payload yields [] (no partial
    // corrupt candidate reaches validation/admission).
    const candidates = parseSynthesisResult(extractResponseText(responseResult.value as { content?: unknown[] }));

    logger.debug(
      {
        submodule: "llm-skill-synthesis-adapter",
        step: "synthesize" as const,
        clusterSize: clusterTrajIds.length,
        candidateCount: candidates.length,
      },
      "skill synthesis call complete",
    );

    return ok(candidates);
  }

  return { synthesize };
}
