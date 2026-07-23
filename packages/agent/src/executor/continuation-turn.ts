// SPDX-License-Identifier: Apache-2.0
/** Starts a real model turn for recovery work after the prior prompt is idle. */

import { fromPromise, type Result } from "@comis/shared";
import {
  dispatchProviderPrompt,
  type ProviderDispatchGuard,
} from "./provider-dispatch.js";

export interface ContinuationTurnSession {
  prompt(
    text: string,
    options: { expandPromptTemplates: false; source: "extension" },
  ): Promise<unknown>;
}

/**
 * The SDK's `followUp()` only queues work for an active agent. Recovery paths
 * run after the prior prompt resolves, so they must start and await a new turn.
 */
export async function runContinuationTurn(
  session: ContinuationTurnSession,
  instruction: string,
  guardProviderDispatch: ProviderDispatchGuard,
): Promise<Result<unknown, Error>> {
  return fromPromise(dispatchProviderPrompt(
    guardProviderDispatch,
    () => session.prompt(instruction, {
      expandPromptTemplates: false,
      source: "extension",
    }),
  ));
}
