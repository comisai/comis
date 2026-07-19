// SPDX-License-Identifier: Apache-2.0
// @allow-throw: HTTP cancellation boundary rejects an aborted request before executor entry.
import {
  formatSessionKey,
  sanitizeLogString,
  systemScheduleTimeout,
  tryGetContext,
  type ComisLogger,
  type ConversationRef,
  type EventMap,
  type SessionKey,
  type TypedEventBus,
} from "@comis/core";
import type { BackgroundSessionResolver, RunHandle } from "@comis/agent";
import {
  fromPromise,
  TimeoutError,
  tryCatch,
  withTimeout,
} from "@comis/shared";

const DEFAULT_ABORT_SETTLE_TIMEOUT_MS = 5_000;

class ApiRequestCancelledError extends Error {
  constructor() {
    super("HTTP request was cancelled before agent execution completed");
    this.name = "ApiRequestCancelledError";
  }
}

/** Lifecycle handle attached to one OpenAI-compatible HTTP execution. */
export interface ApiExecutionCancellation {
  throwIfAborted(): void;
  waitFor<T>(operation: Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

/** Bind one request signal to its exact active SDK run. */
export function bindApiExecutionCancellation(args: {
  signal: AbortSignal;
  traceId: string;
  agentId: string;
  channelType: "openai" | "responses";
  channelId: string;
  sessionKey: SessionKey;
  conversationRef: ConversationRef;
  sessionResolver: BackgroundSessionResolver;
  eventBus: Pick<TypedEventBus, "on" | "off">;
  logger: Pick<ComisLogger, "warn">;
  abortSettleTimeoutMs?: number;
}): ApiExecutionCancellation {
  const abortSettleTimeoutMs = args.abortSettleTimeoutMs !== undefined
    && Number.isSafeInteger(args.abortSettleTimeoutMs)
    && args.abortSettleTimeoutMs > 0
    ? args.abortSettleTimeoutMs
    : DEFAULT_ABORT_SETTLE_TIMEOUT_MS;
  let cancellationStarted = false;
  let activeAbort: Promise<void> | undefined;
  let promptSubmittedListener:
    | ((event: EventMap["prompt:submitted"]) => void)
    | undefined;

  const logCancellationFailure = (
    error: Error,
    hint: string,
    message: string,
    errorKind: "internal" | "timeout" = "internal",
  ): void => {
    void tryCatch(() => args.logger.warn(
      {
        agentId: args.agentId,
        channelType: args.channelType,
        err: sanitizeLogString(
          error instanceof TimeoutError || errorKind === "timeout"
            ? "TimeoutError"
            : "Error",
        ),
        hint,
        errorKind,
      },
      message,
    ));
  };

  const resolveActiveRun = (): RunHandle | undefined => {
    const resolved = tryCatch(() => args.sessionResolver.resolveActiveSession(args.conversationRef));
    if (!resolved.ok) {
      logCancellationFailure(
        resolved.error,
        "Fix active-session resolution; HTTP disconnect cancellation could not reach the running SDK session",
        "HTTP disconnect cancellation could not resolve the active session",
      );
      return undefined;
    }
    return resolved.value;
  };

  const abortResolvedRun = async (runHandle: RunHandle): Promise<void> => {
    const started = tryCatch(() => runHandle.abort());
    if (!started.ok) {
      logCancellationFailure(
        started.error,
        "Inspect the SDK session abort failure; the disconnected request will still reject later stream writes",
        "HTTP disconnect could not abort the active SDK session",
      );
      return;
    }
    const aborted = await fromPromise(withTimeout(
      started.value,
      abortSettleTimeoutMs,
      systemScheduleTimeout,
      "SDK session abort",
    ));
    if (!aborted.ok) {
      const timedOut = aborted.error instanceof TimeoutError;
      logCancellationFailure(
        aborted.error,
        timedOut
          ? "Inspect the SDK session abort path; cancellation exceeded its bounded settle deadline"
          : "Inspect the SDK session abort failure; the disconnected request will still reject later stream writes",
        timedOut
          ? "HTTP disconnect SDK abort exceeded its settle deadline"
          : "HTTP disconnect could not abort the active SDK session",
        timedOut ? "timeout" : "internal",
      );
    }
  };

  const beginResolvedRunAbort = (runHandle: RunHandle): void => {
    if (activeAbort !== undefined) return;
    activeAbort = abortResolvedRun(runHandle);
  };

  const removePromptSubmittedListener = (): void => {
    if (!promptSubmittedListener) return;
    const listener = promptSubmittedListener;
    promptSubmittedListener = undefined;
    const removed = tryCatch(() => args.eventBus.off(
      "prompt:submitted",
      listener,
    ));
    if (!removed.ok) {
      logCancellationFailure(
        removed.error,
        "Fix EventBus listener cleanup; the completed HTTP turn no longer needs its cancellation fallback",
        "HTTP disconnect cancellation listener cleanup failed",
      );
    }
  };

  const beginCancellation = (): void => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    const activeRun = resolveActiveRun();
    if (activeRun) {
      beginResolvedRunAbort(activeRun);
      return;
    }

    const formattedSessionKey = formatSessionKey(args.sessionKey);
    const listener = (event: EventMap["prompt:submitted"]): void => {
      if (
        tryGetContext()?.traceId !== args.traceId ||
        event.agentId !== args.agentId ||
        event.sessionKey !== formattedSessionKey
      ) {
        return;
      }
      removePromptSubmittedListener();
      const registeredRun = resolveActiveRun();
      if (registeredRun) beginResolvedRunAbort(registeredRun);
    };
    promptSubmittedListener = listener;
    const registered = tryCatch(() => args.eventBus.on(
      "prompt:submitted",
      listener,
    ));
    if (!registered.ok) {
      promptSubmittedListener = undefined;
      logCancellationFailure(
        registered.error,
        "Fix EventBus listener registration; an early HTTP disconnect could not wait for SDK run registration",
        "HTTP disconnect cancellation fallback registration failed",
      );
      return;
    }

    // The SDK run can become visible after the first lookup but before the
    // fallback listener is installed. Recheck after registration so that
    // interleaving cannot strand the now-active run.
    const newlyActiveRun = resolveActiveRun();
    if (newlyActiveRun) {
      removePromptSubmittedListener();
      beginResolvedRunAbort(newlyActiveRun);
    }
  };

  const onAbort = (): void => {
    beginCancellation();
  };
  args.signal.addEventListener("abort", onAbort, { once: true });
  if (args.signal.aborted) onAbort();

  return {
    throwIfAborted(): void {
      if (args.signal.aborted) {
        throw new ApiRequestCancelledError();
      }
    },
    async waitFor<T>(operation: Promise<T>): Promise<T> {
      if (args.signal.aborted) throw new ApiRequestCancelledError();
      let rejectCancellation!: (error: ApiRequestCancelledError) => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      const rejectOnAbort = (): void => {
        rejectCancellation(new ApiRequestCancelledError());
      };
      args.signal.addEventListener("abort", rejectOnAbort, { once: true });
      if (args.signal.aborted) rejectOnAbort();
      try {
        return await Promise.race([operation, cancelled]);
      } finally {
        args.signal.removeEventListener("abort", rejectOnAbort);
      }
    },
    async dispose(): Promise<void> {
      args.signal.removeEventListener("abort", onAbort);
      removePromptSubmittedListener();
      if (activeAbort) await activeAbort;
    },
  };
}
