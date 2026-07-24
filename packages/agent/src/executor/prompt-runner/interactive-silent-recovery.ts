// SPDX-License-Identifier: Apache-2.0
/**
 * Recovery policy for an interactive execution that ends in a silent-control
 * response without a successful message-tool delivery to the request route.
 */

import {
  emitObservationalEventSafely,
  formatSessionKey,
  type ModelOperationType,
} from "@comis/core";
import {
  isSilentResponse,
  ok,
  tryCatch,
  type Result,
} from "@comis/shared";
import { getVisibleAssistantText } from "../phase-filter.js";
import { runContinuationTurn } from "../continuation-turn.js";
import { resolveProviderDispatchGuard } from "../provider-dispatch.js";
import type { RunPromptParams } from "./prompt-runner-types.js";

export const INTERACTIVE_SILENT_FAILURE_RESPONSE =
  "I couldn't produce a visible reply for this request. Please try again.";

export interface InteractiveSilentRecoveryOutcome {
  attempted: boolean;
  recovered: boolean;
  response: string;
  finishReason?: "error";
  failure?: "still_silent";
}

export interface InteractiveSilentRecoveryInput {
  operationType: ModelOperationType;
  response: string;
  outboundDelivered: boolean;
  continueTurn: (instruction: string) => Promise<Result<unknown, Error>>;
  getVisibleResponse: () => string;
}

const VISIBLE_REPLY_INSTRUCTION =
  "This is an interactive user request and no response was delivered. "
  + "Provide the user-visible answer now. Do not use NO_REPLY, HEARTBEAT_OK, "
  + "or any other silent-control marker.";

/** Re-enter once, while preserving silent responses for internal operations. */
export async function recoverInteractiveSilentResponse(
  input: InteractiveSilentRecoveryInput,
): Promise<Result<InteractiveSilentRecoveryOutcome, Error>> {
  if (
    input.operationType !== "interactive"
    || !isSilentResponse(input.response)
    || input.outboundDelivered
  ) {
    return ok({
      attempted: false,
      recovered: false,
      response: input.response,
    });
  }

  const continuationResult = await input.continueTurn(VISIBLE_REPLY_INSTRUCTION);
  if (!continuationResult.ok) return continuationResult;

  const visibleResult = tryCatch(input.getVisibleResponse);
  if (!visibleResult.ok) return visibleResult;

  if (isSilentResponse(visibleResult.value)) {
    return ok({
      attempted: true,
      recovered: false,
      response: INTERACTIVE_SILENT_FAILURE_RESPONSE,
      finishReason: "error",
      failure: "still_silent",
    });
  }

  return ok({
    attempted: true,
    recovered: true,
    response: visibleResult.value,
  });
}

function errorName(value: unknown): string {
  return value instanceof Error && value.name.length > 0 ? value.name : "UnknownError";
}

function emitRecoveryEvent(
  params: RunPromptParams,
  succeeded: boolean,
): void {
  const { agentId, sessionKey, deps } = params;
  emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, "execution:recovery_attempted", {
    agentId: agentId ?? "default",
    sessionKey: formatSessionKey(sessionKey),
    reason: "interactive_silent_sentinel",
    succeeded,
    timestamp: deps.clock.now(),
  });
}

/** Apply the recovery policy at the final success-path delivery boundary. */
export async function applyInteractiveSilentRecovery(
  params: RunPromptParams,
): Promise<void> {
  const { msg, session, result, executionOverrides, bridge, deps } = params;
  const outcome = await recoverInteractiveSilentResponse({
    operationType: executionOverrides?.operationType ?? "interactive",
    response: result.response,
    outboundDelivered: bridge.hasOutboundDelivery({
      channelType: msg.channelType,
      channelId: msg.channelId,
    }),
    continueTurn: (instruction) => runContinuationTurn(
      session,
      instruction,
      resolveProviderDispatchGuard(executionOverrides?.onProviderStart),
    ),
    getVisibleResponse: () => getVisibleAssistantText(session),
  });

  if (!outcome.ok) {
    result.response = INTERACTIVE_SILENT_FAILURE_RESPONSE;
    result.finishReason = "error";
    deps.logger.warn(
      {
        errorName: errorName(outcome.error),
        hint: "Retry the interactive request or inspect provider availability; a visible failure was returned",
        errorKind: "dependency" as const,
      },
      "Interactive silent-response recovery failed",
    );
    emitRecoveryEvent(params, false);
    return;
  }

  result.response = outcome.value.response;
  if (outcome.value.finishReason !== undefined) {
    result.finishReason = outcome.value.finishReason;
  }
  if (!outcome.value.attempted) return;

  if (outcome.value.recovered) {
    deps.logger.info(
      { outputChars: outcome.value.response.length },
      "Interactive silent-response recovery produced a visible reply",
    );
  } else {
    deps.logger.warn(
      {
        failure: outcome.value.failure,
        hint: "Inspect the model's silent-control behavior; a visible failure was returned to the user",
        errorKind: "internal" as const,
      },
      "Interactive silent-response recovery remained silent",
    );
  }
  emitRecoveryEvent(params, outcome.value.recovered);
}
