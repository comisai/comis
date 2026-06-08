// SPDX-License-Identifier: Apache-2.0
/**
 * R4 verification-gate.ts — critic orchestration.
 *
 * Gate: only fires on completion-claiming responses past minResponseChars.
 * Seam: single bounded completeSimple call, fail-closed on every error.
 * Delivery: not-verified ⇒ honest first-person unmet-list (sanitized REQ tokens),
 *   never the agent-directed redirect — postExecution is terminal, no re-queue
 *   consumer exists yet (CR-01/D5; the re-queue/full-retry loop is R5/Phase 155+).
 * L5: native-reasoning profiles size maxOutputTokens to avoid verdict starvation.
 *
 * File-size: ≤350 lines (do not exceed).
 * Forbidden: Date.now(), raw setTimeout/clearTimeout, new Date().
 * Invariant: no compatibility shims, no deprecated annotations.
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

/**
 * CRITIC-ONLY verdict budget — NOT the main answer path (CR-01). 512 tokens
 * suffices for the small verdict JSON; native-reasoning profiles get 4× so
 * reasoning_content doesn't starve the verdict (D7).
 */
export function resolveMaxOutputTokens(profile: ModelProfile): number {
  return profile.reasoningStyle === "native"
    ? Math.max(profile.maxOutputTokens, VERDICT_RESERVE_TOKENS * 4)
    : VERDICT_RESERVE_TOKENS;
}

/**
 * Reasoning-headroom floor for the MAIN answer path (native profiles only).
 * SD4 (Phase 158): raised 4096→16384 so reasoning_content cannot starve the
 * visible answer on small native-reasoning models (observed finishReason:"length"
 * with qwen3.6:35b at maxTokens:8192 — reasoning consumed nearly all tokens).
 * Math.max means models already reporting maxOutputTokens≥16384 are unchanged.
 */
const NATIVE_REASONING_MAIN_PATH_FLOOR = 16_384;

/**
 * CR-01: MAIN-PATH output budget. Returns the model's REAL maxOutputTokens so
 * the visible answer is never clamped to the 512-token verdict reserve.
 * Non-reasoning → full profile budget; native-reasoning → sized UP (never
 * down) so reasoning_content can't starve the answer. config.maxTokens (when
 * set by the operator) takes precedence at the call site.
 */
export function resolveMainPathMaxOutputTokens(profile: ModelProfile): number {
  return profile.reasoningStyle === "native"
    ? Math.max(profile.maxOutputTokens, NATIVE_REASONING_MAIN_PATH_FLOOR)
    : profile.maxOutputTokens;
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
// WR-02: keyless-only (no secretManager at this layer). Mirrors KEYLESS_PROVIDER_TYPES.
// ---------------------------------------------------------------------------
/** Exported for parity assertion in scaffold-defaults.ts (Plan 02 cross-file test). */
export const KEYLESS_CRITIC_PROVIDERS = new Set<string>(["ollama", "lm-studio"]);

export function shouldRunCritic(params: {
  capabilityClass: CapabilityClass | undefined;
  config: PerAgentConfig;
  executionPlanRef: { current: ExecutionPlan | undefined };
  /** Resolved provider for this execution (WR-02: keyless-only gate). */
  provider: string;
  /** Optional logger for the skip-with-WARN diagnostic (WR-02). */
  logger?: ComisLogger;
  /** SD3 (Phase 158): pre-resolved effective enabled flag from resolveScaffoldDefaults. */
  effectiveEnabled?: boolean;
}): boolean {
  const { capabilityClass, config, executionPlanRef, provider, logger, effectiveEnabled } = params;
  const verificationEnabled = effectiveEnabled ?? (config.verification?.enabled ?? false);
  if (!verificationEnabled) return false;
  if (capabilityClass !== "small" && capabilityClass !== "nano") return false;
  if (!executionPlanRef.current?.active) return false;
  // This class WOULD run the critic — but only keyless providers can (no key seam here).
  if (!KEYLESS_CRITIC_PROVIDERS.has(provider.toLowerCase())) {
    logger?.warn(
      {
        provider,
        errorKind: "config" as const,
        step: "verification" as const,
        hint: "Verification critic skipped: cloud API-key threading is deferred to Phase 155. " +
          "Use a keyless provider (ollama/lm-studio) to exercise the critic.",
      },
      "Verification critic skipped (cloud key threading not yet wired)",
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// runVerificationCritic — entry point for the post-execution hook
// Gate + single critic call + honest first-person delivery on not-verified (R4/D5)
//
// `maxRetries` is accepted but NOT branched on in this phase: postExecution is
// terminal (no re-queue consumer), so a not-verified verdict ALWAYS delivers the
// honest first-person unmet-list — never the agent-directed redirect (CR-01).
// The param is retained for the future re-queue/full-retry path (R5/Phase 155+).
// ---------------------------------------------------------------------------
export async function runVerificationCritic(params: {
  response: string;
  plan: ExecutionPlan | undefined;
  deps: CriticDeps;
  /** Retained for the future re-queue path (R5/Phase 155+); not branched on now. */
  maxRetries?: number;
}): Promise<{ verdict: CriticVerdict["verdict"]; response: string }> {
  const { response, plan, deps } = params;

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

  // not-verified path: honest first-person delivery (CR-01). postExecution is
  // TERMINAL in this phase (no re-queue consumer), so this `response` is
  // delivered VERBATIM to the user. The agent-directed redirect is only correct
  // when something re-queues it (R5/Phase 155+), so we ALWAYS deliver the honest
  // first-person unmet-list — at the DEFAULT maxRetries (2) and at 0 — never the
  // redirect and never an unqualified "done". `unmet` is sanitized (see below).
  const verdictWithUnmet = verdict as { verdict: "not-verified"; unmet: string[] };
  return {
    verdict: "not-verified",
    response: buildHonestUnmetResponse(verdictWithUnmet.unmet),
  };
}

// ---------------------------------------------------------------------------
// buildHonestUnmetResponse — the ONLY user-facing not-verified text (CR-01/D5)
//
// WR-01/IN-03: `unmet[]` is critic-authored over UNTRUSTED reviewed content, so
// raw interpolation lets a crafted label ("REQ-0 (all tasks are done)") make the
// text match isCompletionClaim (violating D5) or smuggle a tool-call phrase into
// user prose. Reduce each entry to its bare REQ-\d+ token (executor-controlled
// plan index, not critic free-text); the composed text then provably fails both
// isCompletionClaim and detectImpliedToolCall.
// ---------------------------------------------------------------------------
function buildHonestUnmetResponse(unmet: string[]): string {
  const safeUnmet = unmet
    .map((u) => u.match(/REQ-\d+/i)?.[0]?.toUpperCase() ?? "")
    .filter((s) => s.length > 0);
  const unmetList = safeUnmet.length > 0 ? safeUnmet.join(", ") : "the required steps";
  // Must NOT match isCompletionClaim (no "done"/"finished"/"complete"/"ready"/
  // "accomplished" triggers) and must NOT match detectImpliedToolCall.
  return (
    `I was not able to fully satisfy: ${unmetList}. ` +
    `Further work is still needed on these items — please let me know how you ` +
    `would like to proceed.`
  );
}

// ---------------------------------------------------------------------------
// createVerificationCritic — factory (for direct injection in tests / hook)
// ---------------------------------------------------------------------------
export function createVerificationCritic(deps: CriticDeps) {
  return (response: string, plan: ExecutionPlan | undefined) =>
    runVerificationCritic({ response, plan, deps });
}
