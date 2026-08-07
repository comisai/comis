// SPDX-License-Identifier: Apache-2.0
/**
 * One-shot recovery for OAuth access tokens invalidated before their recorded
 * expiry. The rejected stream has no start event, so it can be replaced with
 * one replay after the credential manager completes a forced refresh.
 *
 * @module
 */

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ClockPort, ComisLogger } from "@comis/core";
import { err, fromPromise, tryCatch, type Result } from "@comis/shared";
import { isInvalidatedOAuthTokenError } from "../error-classifier.js";
import type { StreamFnWrapper } from "./types.js";

export interface OAuthInvalidationRecoveryError {
  code: string;
  hint?: string;
}

export interface OAuthInvalidationRecoveryDeps {
  clock: ClockPort;
  logger: ComisLogger;
  /** Force-refresh the selected profile and install it for the next request. */
  recoverCredential: () => Promise<Result<void, OAuthInvalidationRecoveryError>>;
}

const DEFAULT_RECOVERY_HINT =
  "Run `comis auth login` for the affected provider, then retry the request.";

function terminalError(
  stream: AssistantMessageEventStream,
  model: Parameters<StreamFn>[0],
  timestamp: number,
): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "OAuth recovery stream dispatch failed",
    timestamp,
  };
  stream.push({ type: "error", reason: "error", error: message });
}

async function resolveStream(
  next: StreamFn,
  args: Parameters<StreamFn>,
): Promise<Result<AssistantMessageEventStream, Error>> {
  const invoked = tryCatch(() => next(...args));
  if (!invoked.ok) return invoked;
  return fromPromise(Promise.resolve(invoked.value));
}

async function recoverCredential(
  callback: OAuthInvalidationRecoveryDeps["recoverCredential"],
): Promise<Result<void, OAuthInvalidationRecoveryError>> {
  const invoked = tryCatch(callback);
  if (!invoked.ok) return err({ code: "RECOVERY_CALLBACK_FAILED" });
  const awaited = await fromPromise(invoked.value);
  if (!awaited.ok) return err({ code: "RECOVERY_CALLBACK_FAILED" });
  return awaited.value;
}

/** Build a wrapper that force-refreshes and replays one invalidated OAuth call. */
export function createOAuthInvalidationRecovery(
  deps: OAuthInvalidationRecoveryDeps,
): StreamFnWrapper {
  let recoveryAttempted = false;

  return function oauthInvalidationRecovery(next: StreamFn): StreamFn {
    return ((...args: Parameters<StreamFn>) => {
      const output = createAssistantMessageEventStream();

      const forward = async (allowRecovery: boolean): Promise<void> => {
        const sourceResult = await resolveStream(next, args);
        if (!sourceResult.ok) {
          deps.logger.error(
            {
              step: "oauth-invalidated-recovery",
              provider: args[0].provider,
              errorKind: "internal" as const,
              hint: "The provider stream violated its Result protocol; inspect the provider adapter before retrying.",
            },
            "OAuth recovery stream dispatch failed",
          );
          terminalError(output, args[0], deps.clock.now());
          return;
        }

        let forwardedEvent = false;
        for await (const event of sourceResult.value) {
          const invalidated =
            event.type === "error"
            && isInvalidatedOAuthTokenError(event.error.errorMessage);
          if (
            invalidated
            && allowRecovery
            && !forwardedEvent
            && !recoveryAttempted
          ) {
            recoveryAttempted = true;
            const startedAt = deps.clock.now();
            deps.logger.debug(
              {
                step: "oauth-invalidated-recovery",
                provider: args[0].provider,
              },
              "Refreshing provider-invalidated OAuth credential",
            );

            const refreshResult = await recoverCredential(deps.recoverCredential);
            if (!refreshResult.ok) {
              const recoveryError = refreshResult.error;
              deps.logger.warn(
                {
                  step: "oauth-invalidated-recovery",
                  provider: args[0].provider,
                  recoveryCode: recoveryError.code,
                  hint: recoveryError.hint ?? DEFAULT_RECOVERY_HINT,
                  errorKind: "auth" as const,
                },
                "OAuth credential recovery failed",
              );
              output.push(event);
              return;
            }

            deps.logger.info(
              {
                step: "oauth-invalidated-recovery",
                provider: args[0].provider,
                durationMs: deps.clock.now() - startedAt,
                replayed: true,
              },
              "OAuth credential refreshed after provider invalidation",
            );
            await forward(false);
            return;
          }

          output.push(event as AssistantMessageEvent);
          forwardedEvent = true;
          if (event.type === "done" || event.type === "error") return;
        }
      };

      void forward(true);
      return output;
    }) as StreamFn;
  };
}
