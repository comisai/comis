// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-injected OFFLINE usefulness-judge seam builder.
 *
 * {@link createUsefulnessJudgeSeam} wraps a cheap resolved model into a
 * `judge({ candidateIds, answer })` seam that POST-HOC partitions a turn's
 * recalled-memory ids into USED vs IGNORED — a second, OPTIONAL usefulness signal
 * alongside the keyless citation-marker attribution. A future sentinel will inject
 * this seam and feed its verdict into `recordUsage`; this module is the SCAFFOLD
 * (the prompt + lenient parser kept AGENT-INTERNAL, mirroring how
 * {@link createUserRepresentationSeam} keeps `USER_REPRESENTATION_PROMPT` private
 * and how {@link createReasoningSeam} keeps `DEDUCTIVE_PROMPT` private).
 *
 * OFFLINE only — the seam is NEVER imported by the recall read path
 * (`memory-recall.ts`); the recall hot path stays LLM-free. The judge's costed
 * enablement is deferred; the knob ships OFF (no live call).
 *
 * Security posture (the same anti-laundering discipline as the userrep/reasoning seams):
 * - ONE cheap-model call per turn (a single post-hoc verdict).
 * - The lenient parser KEEPS only `{ usedIds, ignoredIds }` (any smuggled field is
 *   STRIPPED) and DROPS any id the seam was NOT given the candidate set — a hostile
 *   memory BODY can never inject a FOREIGN memory id into the usefulness verdict.
 *   The verdict can only ever reference ids the agent actually recalled.
 * - NON-FATAL: a thrown/aborted/malformed call yields the empty verdict
 *   `{ usedIds: [], ignoredIds: [] }` (the seam never throws out).
 * - Each call is BOUNDED by `maxOutputTokens` and a wall-clock-free abort timer (the
 *   injected `clock` supplies timestamps; the abort uses the sanctioned-root
 *   `systemSetTimeout`).
 *
 * @module
 */

import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import type { ClockPort, ComisLogger } from "@comis/core";
import { completeSimple } from "@earendil-works/pi-ai";
import { z } from "zod";
import { resolveJudgeModel, temperatureOption, type CustomCompletionsModelSpec } from "./judge-model-resolver.js";
import { parseLenientJson } from "./llm-json.js";

/** Hard abort ceiling per LLM call (mirrors the userrep/reasoning seam LLM timeout). */
const LLM_TIMEOUT_MS = 120_000;

/** The cheap-model + key + bound the daemon resolves for one judge run. */
export interface UsefulnessJudgeSeamDeps {
  /** Resolved cheap provider (the "cron" operation model — never the agent's primary). */
  provider: string;
  /** Resolved cheap model id. */
  modelId: string;
  /** The API key VALUE (resolved by NAME at the daemon; never logged here). */
  apiKey: string;
  /** Per-call LLM output bound (the cost axis). */
  maxOutputTokens: number;
  /** Wall-clock reads — the per-message timestamp. NEVER a wall-clock global. */
  clock: ClockPort;
  /** Counts-only logger (the seam logs failures with a hint + errorKind, never bodies). */
  logger: ComisLogger;
  /** Scope tag for the failure logs. */
  agentId: string;
  /**
   * Custom OpenAI-compatible model spec (resolved, normalized `…/v1` baseUrl) for
   * building the judge Model when the pi-ai catalog has no entry for
   * `provider/modelId` — a custom YAML provider (ollama/lm-studio/…). Undefined
   * for built-in providers. Without it, usefulness judging SKIPPED on every
   * keyless/local turn (the same bug as the outcome judge, live 2026-06-20).
   */
  customModel?: CustomCompletionsModelSpec;
}

/** The judge's input for one turn (ids + the answer text — never memory bodies cross the seam boundary upward). */
export interface UsefulnessJudgeInput {
  /** The opaque memory ids recalled this turn (the allowlist — the verdict may only reference these). */
  candidateIds: string[];
  /** The agent's final answer text the judge scores the candidates against. */
  answer: string;
}

/** The typed verdict: a partition of the candidate ids into used vs ignored. */
export interface UsefulnessJudgeVerdict {
  /** Candidate ids the judge deemed USED in the answer. */
  usedIds: string[];
  /** Candidate ids the judge deemed recalled-but-IGNORED. */
  ignoredIds: string[];
}

/** The judge's system prompt (AGENT-INTERNAL — never crosses the package boundary). */
const USEFULNESS_JUDGE_PROMPT = `You are auditing which of a set of recalled memories were actually USED to write an answer.

You are given a list of candidate memory IDs (already recalled for this turn) and the final answer text. Decide, for EACH candidate id, whether the answer actually relied on that memory (USED) or recalled-but-ignored it (IGNORED).

Return ONLY valid JSON of the form
{ "usedIds": ["<id>", ...], "ignoredIds": ["<id>", ...] }

- Use ONLY the candidate ids you were given. Do NOT invent ids.
- Every candidate id should appear in exactly one of the two arrays.
- Do NOT include any other fields, scores, or commentary. No markdown fences.`;

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
 * LENIENT verdict schema. `z.object` (NOT `strictObject`) so any smuggled field
 * (a `trust`, a `verdictScore`, …) is STRIPPED, not rejected. Each id array is
 * coerced to a string[] — a non-array / missing field defaults to `[]` so a partial
 * payload still parses to the empty-on-that-axis verdict.
 */
const VerdictSchema = z.object({
  usedIds: z.array(z.string()).catch([]),
  ignoredIds: z.array(z.string()).catch([]),
});

/** The empty verdict — the non-fatal floor (a failed/empty judge yields this). */
const EMPTY_VERDICT: UsefulnessJudgeVerdict = { usedIds: [], ignoredIds: [] };

/**
 * Parse raw judge text into a {@link UsefulnessJudgeVerdict}, FILTERED to the
 * allowlist. TOTAL function — NEVER throws: a malformed/adversarial payload yields
 * the empty verdict. Steps: strip fences → `JSON.parse` inside try/catch (parse
 * error → empty) → lenient `safeParse` (smuggled fields stripped) → keep ONLY ids
 * present in `candidateIds` (an id the judge was not given is DROPPED — the
 * anti-injection boundary) → dedupe within each array.
 */
function parseVerdict(raw: string, candidateIds: string[]): UsefulnessJudgeVerdict {
  const json: unknown = parseLenientJson(raw);
  // parseLenientJson tolerates narration around the payload (live finding
  // 2026-06-11 — the whole-string parse degraded valid payloads).
  if (json === undefined) return EMPTY_VERDICT;
  const parsed = VerdictSchema.safeParse(json);
  if (!parsed.success) return EMPTY_VERDICT;

  // The allowlist: the verdict may ONLY reference ids the agent actually recalled.
  // A foreign id (smuggled via a hostile memory body) is dropped here in CODE.
  const allow = new Set(candidateIds);
  const filterToAllow = (ids: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!allow.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };

  return {
    usedIds: filterToAllow(parsed.data.usedIds),
    ignoredIds: filterToAllow(parsed.data.ignoredIds),
  };
}


/**
 * Build the OFFLINE usefulness-judge seam from a cheap resolved model.
 *
 * Returns the `judge({ candidateIds, answer })` function a sentinel would inject:
 * it issues ONE cheap-model call asking which candidate ids the answer used,
 * parses the response via the lenient/total {@link parseVerdict} (which FILTERS to
 * the allowlist), and returns the typed {@link UsefulnessJudgeVerdict}. An empty
 * candidate set short-circuits (no model call, no cost). A model-resolution failure,
 * a thrown/aborted call, or a malformed payload degrades to the empty verdict — the
 * seam NEVER throws out (non-fatal, the same posture as the userrep/reasoning seams).
 */
export function createUsefulnessJudgeSeam(
  deps: UsefulnessJudgeSeamDeps,
): (input: UsefulnessJudgeInput) => Promise<UsefulnessJudgeVerdict> {
  const { provider, modelId, apiKey, maxOutputTokens, clock, logger, agentId, customModel } = deps;

  /** Issue one bounded, non-fatal cheap-model call; return raw text or undefined. */
  async function callModel(systemPrompt: string, userText: string): Promise<string | undefined> {
    // Catalog first; else construct from the custom-provider spec (ollama/lm-studio/…)
    // so usefulness judging runs on keyless/local deployments instead of skipping.
    const model = resolveJudgeModel(provider, modelId, customModel);
    if (!model) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          step: "usefulness-judge" as const,
          hint: customModel
            ? `could not build usefulness model ${provider}/${modelId} from the custom baseUrl — skipping this usefulness judge`
            : `model ${provider}/${modelId} is not in the pi-ai catalog and no custom provider baseUrl was supplied — set providers.entries.${provider}.baseUrl or use a built-in provider for the cron/usefulness tier`,
        },
        "Usefulness judge model not found (non-fatal)",
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
          step: "usefulness-judge" as const,
          hint: "usefulness judge LLM call failed/aborted — no verdict from this run",
        },
        "Usefulness judge LLM call failed (non-fatal)",
      );
      return undefined;
    } finally {
      systemClearTimeout(timer);
    }
  }

  return async function judge(input: UsefulnessJudgeInput): Promise<UsefulnessJudgeVerdict> {
    // Nothing recalled → nothing to judge; short-circuit before any cost.
    if (input.candidateIds.length === 0) return EMPTY_VERDICT;

    // The user message carries the candidate ids + the answer (ids-only on the id
    // axis; the answer text is the agent's own output, not a foreign memory body).
    const userText = `Candidate memory IDs:\n${input.candidateIds.join("\n")}\n\nThe answer:\n${input.answer}`;
    const text = await callModel(USEFULNESS_JUDGE_PROMPT, userText);
    if (text === undefined) return EMPTY_VERDICT;
    // The lenient/total parser STRIPS smuggled fields + drops ids not in the
    // candidate set (the anti-injection boundary); a malformed payload → empty.
    return parseVerdict(text, input.candidateIds);
  };
}
