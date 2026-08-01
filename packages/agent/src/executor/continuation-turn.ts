// SPDX-License-Identifier: Apache-2.0
/** Starts a real model turn for recovery work after the prior prompt is idle. */

import { fromPromise, tryCatch, type Result } from "@comis/shared";
import {
  dispatchProviderPrompt,
  type ProviderDispatchGuard,
} from "./provider-dispatch.js";

export interface ContinuationTurnSession {
  prompt(
    text: string,
    options: { expandPromptTemplates: false; source: "extension" },
  ): Promise<unknown>;
  getActiveToolNames?(): string[];
  setActiveToolsByName?(names: string[]): void;
}

export interface ContinuationTurnOptions {
  /** Narrow this recovery turn to the capabilities that triggered it. */
  restrictToToolNames?: readonly string[];
}

/**
 * The SDK's `followUp()` only queues work for an active agent. Recovery paths
 * run after the prior prompt resolves, so they must start and await a new turn.
 */
export async function runContinuationTurn(
  session: ContinuationTurnSession,
  instruction: string,
  guardProviderDispatch: ProviderDispatchGuard,
  options: ContinuationTurnOptions = {},
): Promise<Result<unknown, Error>> {
  let previousActiveTools: string[] | undefined;
  if (
    options.restrictToToolNames !== undefined
    && session.getActiveToolNames
    && session.setActiveToolsByName
  ) {
    const previous = tryCatch(() => session.getActiveToolNames!());
    if (!previous.ok) return previous;
    previousActiveTools = previous.value;
    const restricted = tryCatch(() => session.setActiveToolsByName!(
      [...new Set(options.restrictToToolNames)],
    ));
    if (!restricted.ok) return restricted;
  }

  const result = await fromPromise(dispatchProviderPrompt(
    guardProviderDispatch,
    () => session.prompt(instruction, {
      expandPromptTemplates: false,
      source: "extension",
    }),
  ));
  if (previousActiveTools !== undefined) {
    const restored = tryCatch(() => session.setActiveToolsByName!(previousActiveTools));
    if (!restored.ok) return restored;
  }
  return result;
}
