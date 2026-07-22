// SPDX-License-Identifier: Apache-2.0
/** Bounded final-response locale enforcement with tools disabled during repair. */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  emitObservationalEventSafely,
  formatSessionKey,
  toSafeErrorLogString,
  type ResponseLocalePolicy,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { runContinuationTurn } from "../continuation-turn.js";
import { getVisibleAssistantText } from "../phase-filter.js";
import {
  evaluateResponseLocale,
  type ResponseLocaleQualityFinding,
} from "../resolve-response-locale-policy.js";
import type { RunPromptParams } from "./prompt-runner-types.js";

type LocaleEnforcementSession = Pick<AgentSession, "agent" | "prompt">;

export interface ResponseLocaleEnforcementOutcome {
  readonly response: string;
  readonly attempted: boolean;
  readonly repaired: boolean;
  readonly initialFinding?: ResponseLocaleQualityFinding;
  readonly finalFinding?: ResponseLocaleQualityFinding;
}

export interface ResponseLocaleEnforcementError {
  readonly cause: Error;
  readonly finding: ResponseLocaleQualityFinding;
}

function repairInstruction(locale: string): string {
  const localeDirection = locale.startsWith("und-")
    ? "Use the same human language as the current user request and the writing system identified by the locale tag."
    : "Rewrite only your immediately preceding user-visible answer in the specified locale.";
  return `<response-locale-repair locale="${locale}">\n`
    + `${localeDirection}\n`
    + "Preserve facts, identifiers, numbers, URLs, citations, code, and tool results exactly.\n"
    + "Do not invoke tools, add information, or discuss this instruction. Return only the replacement answer.\n"
    + "</response-locale-repair>";
}

/**
 * Validate the response and start at most one tools-disabled repair turn.
 * A remaining mismatch is returned as data so callers can fail visibly without
 * entering an unbounded model loop.
 */
export async function enforceResponseLocale(input: {
  readonly policy: ResponseLocalePolicy;
  readonly response: string;
  readonly session: LocaleEnforcementSession;
  readonly getVisibleResponse: () => string;
}): Promise<Result<ResponseLocaleEnforcementOutcome, ResponseLocaleEnforcementError>> {
  const initialFinding = evaluateResponseLocale(input.policy, input.response);
  if (initialFinding === undefined) {
    return ok({ response: input.response, attempted: false, repaired: false });
  }

  const originalTools = input.session.agent.state.tools;
  input.session.agent.state.tools = [];
  let continuation: Awaited<ReturnType<typeof runContinuationTurn>>;
  try {
    // The SDK session boundary may throw synchronously before its Promise is
    // created; translate that narrow boundary failure into the Result contract.
    continuation = await runContinuationTurn(
      input.session,
      repairInstruction(initialFinding.locale),
    );
  } catch (cause) {
    return err({
      cause: cause instanceof Error ? cause : new Error("Locale repair model boundary failed"),
      finding: initialFinding,
    });
  } finally {
    input.session.agent.state.tools = originalTools;
  }

  if (!continuation.ok) {
    return err({ cause: continuation.error, finding: initialFinding });
  }

  const response = input.getVisibleResponse();
  if (response.trim().length === 0) {
    return err({
      cause: new Error("Locale repair produced no visible response"),
      finding: initialFinding,
    });
  }
  const finalFinding = evaluateResponseLocale(input.policy, response);
  return ok({
    response,
    attempted: true,
    repaired: finalFinding === undefined,
    initialFinding,
    ...(finalFinding === undefined ? {} : { finalFinding }),
  });
}

function emitLocaleRecovery(params: RunPromptParams, succeeded: boolean): void {
  emitObservationalEventSafely(
    { eventBus: params.deps.eventBus, logger: params.deps.logger },
    "execution:recovery_attempted",
    {
      agentId: params.agentId ?? "default",
      sessionKey: formatSessionKey(params.sessionKey),
      reason: "locale_fidelity",
      succeeded,
      timestamp: params.deps.clock.now(),
    },
  );
}

/** Apply locale enforcement at the success-path egress boundary. */
export async function applyResponseLocaleEnforcement(params: RunPromptParams): Promise<void> {
  if (params.responseLocalePolicy === undefined) return;
  const enforcementStartedAt = params.deps.clock.now();
  const outcome = await enforceResponseLocale({
    policy: params.responseLocalePolicy,
    response: params.result.response,
    session: params.session,
    getVisibleResponse: () => getVisibleAssistantText(params.session),
  });
  const durationMs = Math.max(0, params.deps.clock.now() - enforcementStartedAt);

  if (!outcome.ok) {
    params.result.localeQualityFinding = outcome.error.finding;
    params.deps.logger.warn(
      {
        step: "response-locale-repair",
        locale: outcome.error.finding.locale,
        expectedScript: outcome.error.finding.expectedScript,
        actualScript: outcome.error.finding.actualScript,
        durationMs,
        err: toSafeErrorLogString(outcome.error.cause),
        hint: "Retry the turn or inspect provider availability; locale repair could not complete",
        errorKind: "dependency" as const,
      },
      "Response locale repair failed",
    );
    emitLocaleRecovery(params, false);
    return;
  }

  params.result.response = outcome.value.response;
  if (!outcome.value.attempted) return;
  params.result.localeQualityFinding = outcome.value.initialFinding;
  emitLocaleRecovery(params, outcome.value.repaired);

  if (outcome.value.repaired) {
    params.deps.logger.info(
      {
        step: "response-locale-repair",
        locale: params.responseLocalePolicy.locale,
        responseChars: outcome.value.response.length,
        durationMs,
      },
      "Response locale repair completed",
    );
    return;
  }

  params.deps.logger.warn(
    {
      step: "response-locale-repair",
      locale: outcome.value.finalFinding?.locale,
      expectedScript: outcome.value.finalFinding?.expectedScript,
      actualScript: outcome.value.finalFinding?.actualScript,
      durationMs,
      hint: "Inspect the selected model's locale fidelity; the bounded repair remained mismatched",
      errorKind: "validation" as const,
    },
    "Response locale remained mismatched after repair",
  );
}
