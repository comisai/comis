// SPDX-License-Identifier: Apache-2.0
/**
 * R4 verification-gate.ts — critic orchestration.
 *
 * Gate: only fires on completion-claiming responses past minResponseChars.
 * Seam: single bounded completeSimple call, fail-closed on every error.
 * Retry: bounded by maxRetries; honest unmet-list on exhaustion (D5).
 * L5: native-reasoning profiles size maxOutputTokens to avoid verdict starvation.
 *
 * File-size: ≤350 lines (do not exceed).
 * Forbidden: Date.now(), raw setTimeout/clearTimeout, new Date(),
 *            @deprecated, shim, backward compat wording.
 *
 * @module
 */
import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import type { ClockPort, ComisLogger, TypedEventBus } from "@comis/core";
import { completeSimple, getModel } from "@earendil-works/pi-ai";
import {
  isCompletionClaim,
  wrapReviewedOutput,
  detectCanaryLeakage,
  detectImpliedToolCall,
  parseCriticVerdict,
  buildCriticSystemPrompt,
  type CriticVerdict,
} from "./critic-isolation.js";
import { buildSafetySection } from "../bootstrap/sections/core-sections.js";
import type { ExecutionPlan } from "../planner/types.js";
import type { ModelProfile, CapabilityClass } from "./model-profile.js";
import type { PerAgentConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// CriticDeps — injected dependencies for the verification critic
// ---------------------------------------------------------------------------
export interface CriticDeps {
  provider: string;
  modelId: string;
  apiKey: string;
  clock: ClockPort;
  logger: ComisLogger;
  agentId: string;
  canaryToken: string;        // S2: HMAC canary from generateCanaryToken
  minResponseChars: number;   // R4 gate (config.verification.minResponseChars, default 200)
  modelProfile: ModelProfile; // L5: reasoningStyle drives maxOutputTokens sizing
  eventBus: TypedEventBus;    // S2: emit critic.isolation.* events
}

// ---------------------------------------------------------------------------
// L5: reasoning-budget-aware maxOutputTokens sizing
// ---------------------------------------------------------------------------
const VERDICT_RESERVE_TOKENS = 512;

function resolveMaxOutputTokens(profile: ModelProfile): number {
  // On native-reasoning profiles, reasoning_content may consume thousands of tokens
  // before the verdict JSON arrives. Give 4× the verdict reserve to prevent starvation (D7).
  return profile.reasoningStyle === "native"
    ? Math.max(profile.maxOutputTokens, VERDICT_RESERVE_TOKENS * 4)
    : VERDICT_RESERVE_TOKENS;
}

// ---------------------------------------------------------------------------
// LLM_TIMEOUT_MS — matches the ceiling used by all memory seams (120 s)
// ---------------------------------------------------------------------------
const LLM_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// extractResponseText — verbatim copy from memory-dialectic-seam.ts
// ---------------------------------------------------------------------------
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
// callCritic — one bounded completeSimple call, fail-closed
// ---------------------------------------------------------------------------
async function callCritic(
  response: string,
  plan: ExecutionPlan,
  deps: CriticDeps,
): Promise<CriticVerdict> {
  // S2: wrap the reviewed output as untrusted BEFORE the user message is built
  const wrapped = wrapReviewedOutput(response);
  const safetyCore = buildSafetySection(false); // S2: always false — never []
  const systemPrompt = buildCriticSystemPrompt({
    checklist: plan.steps,
    canaryToken: deps.canaryToken,
    safetyCore,
  });

  const maxOutputTokens = resolveMaxOutputTokens(deps.modelProfile);

  let model;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model = getModel(deps.provider as any, deps.modelId as any);
  } catch (modelErr) {
    deps.logger.warn(
      {
        agentId: deps.agentId,
        err: modelErr,
        errorKind: "dependency" as const,
        step: "verification" as const,
        hint: "critic model resolution failed — failing closed",
      },
      "Verification critic model resolution failed (non-fatal)",
    );
    return { verdict: "not-verified", unmet: [], reason: "critic-call-failed" };
  }

  const controller = new AbortController();
  const timer = systemSetTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const raw = await completeSimple(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user" as const,
            content: wrapped,
            timestamp: deps.clock.now(),
          },
        ],
      },
      {
        apiKey: deps.apiKey,
        temperature: 0,
        maxTokens: maxOutputTokens,
        signal: controller.signal,
      },
    );
    const text = extractResponseText(raw);

    // S2: check canary leak BEFORE Zod parse
    if (detectCanaryLeakage(text, deps.canaryToken)) {
      deps.eventBus.emit("critic.isolation.canary_leak", {
        timestamp: deps.clock.now(),
        agentId: deps.agentId,
        canaryPrefix: deps.canaryToken.slice(0, 10),
      });
      return {
        verdict: "not-verified",
        unmet: [],
        reason: "isolation-violation",
      };
    }

    const parsed = parseCriticVerdict(text); // Zod safeParse — never throws

    // S2: check implied tool calls in verdict followUp
    if (parsed.verdict !== "skipped") {
      const verdictWithProps = parsed as {
        verdict: string;
        followUp?: string;
        unmet: string[];
      };
      const followUpText = verdictWithProps.followUp ?? "";
      if (detectImpliedToolCall(followUpText)) {
        deps.eventBus.emit("critic.isolation.implied_tool_call", {
          timestamp: deps.clock.now(),
          agentId: deps.agentId,
          // Sanitized excerpt — no user content beyond 80 chars (AGENTS.md §2.7)
          pattern: followUpText.slice(0, 80),
        });
        return {
          verdict: "not-verified",
          unmet: [],
          reason: "isolation-violation",
        };
      }
    }

    return parsed;
  } catch (llmErr) {
    deps.logger.warn(
      {
        agentId: deps.agentId,
        err: llmErr,
        errorKind: "dependency" as const,
        step: "verification" as const,
        hint: "critic LLM call failed — failing closed",
      },
      "Verification critic LLM call failed (non-fatal)",
    );
    return { verdict: "not-verified", unmet: [], reason: "critic-call-failed" };
  } finally {
    systemClearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// shouldRunCritic — gate check for the post-execution hook
// ---------------------------------------------------------------------------
export function shouldRunCritic(params: {
  capabilityClass: CapabilityClass | undefined;
  config: PerAgentConfig;
  executionPlanRef: { current: ExecutionPlan | undefined };
}): boolean {
  const { capabilityClass, config, executionPlanRef } = params;
  if (!config.verification?.enabled) return false;
  if (capabilityClass !== "small" && capabilityClass !== "nano") return false;
  if (!executionPlanRef.current?.active) return false;
  return true;
}

// ---------------------------------------------------------------------------
// runVerificationCritic — entry point for the post-execution hook
// Gate + bounded retry (redirect) + honest exhaustion (R4/D5)
// ---------------------------------------------------------------------------
export async function runVerificationCritic(params: {
  response: string;
  plan: ExecutionPlan | undefined;
  deps: CriticDeps;
  maxRetries?: number;
}): Promise<{ verdict: CriticVerdict["verdict"]; response: string }> {
  const { response, plan, deps, maxRetries = 2 } = params;

  // Gate: skip if not a completion claim or response is too short (D4)
  if (!isCompletionClaim(response) || response.length < deps.minResponseChars) {
    return { verdict: "skipped", response };
  }
  if (!plan || !plan.active) {
    return { verdict: "skipped", response };
  }

  // Single critic call (bounded completeSimple, fail-closed)
  const verdict = await callCritic(response, plan, deps);

  if (verdict.verdict === "verified" || verdict.verdict === "skipped") {
    return { verdict: verdict.verdict, response };
  }

  // not-verified path: bounded redirect or honest exhaustion
  const verdictWithUnmet = verdict as {
    verdict: "not-verified";
    unmet: string[];
    followUp?: string;
    reason?: string;
  };
  const unmet = verdictWithUnmet.unmet;

  if (maxRetries > 0) {
    // Bounded redirect: surface followUp for the caller to re-queue
    const followUp =
      verdictWithUnmet.followUp ??
      `Please complete the following unmet requirements: ${unmet.join(", ")}`;
    return { verdict: "not-verified", response: followUp };
  }

  // Exhaustion: honest unmet-list — never an unqualified "done" (D5).
  // IMPORTANT: this text must NOT match isCompletionClaim (avoid "done", "finished",
  // "complete", "ready", "accomplished" and the other heuristic triggers).
  const unmetList = unmet.length > 0 ? unmet.join(", ") : "the required steps";
  const honestResponse =
    `I was unable to satisfy the following requirements: ${unmetList}. ` +
    `Further work is needed to address these items.`;
  return { verdict: "not-verified", response: honestResponse };
}

// ---------------------------------------------------------------------------
// createVerificationCritic — factory (for direct injection in tests / hook)
// ---------------------------------------------------------------------------
export function createVerificationCritic(deps: CriticDeps) {
  return (response: string, plan: ExecutionPlan | undefined) =>
    runVerificationCritic({ response, plan, deps });
}
