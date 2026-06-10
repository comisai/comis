// SPDX-License-Identifier: Apache-2.0
/**
 * Silent-failure detection branches — the five distinct recovery paths the
 * prompt runner takes when the SDK resolved `session.prompt()` without
 * throwing but emitted a content-less assistant turn:
 *
 *   1. signed-replay self-heal (scrub thinking state + retry once with 1s settle)
 *   2. tool-schema strip-retry (GBNF-02: strip pattern/format once per
 *      session + retry; body lives in tool-schema-unsupported-handler.ts —
 *      500-line directory cap — and is re-exported below)
 *   3. rate-limit short-circuit (window can't roll; declare terminal failure)
 *   4. client-request short-circuit (deterministic provider validation; do not retry)
 *   5. default strip-and-retry + LKW (last-known-working) auth-failure fallback
 *
 * Imports types only from `./prompt-runner-types.js` — never from
 * `./prompt-runner.js` (avoids circular dependency).
 *
 * @module
 */

import { formatSessionKey } from "@comis/core";
import type { ErrorKind } from "@comis/core";

import { isAuthError, type ModelRetryResult } from "../model-retry.js";
import { normalizeModelId } from "../../provider/model-id-normalize.js";
import { withPromptTimeout } from "../prompt-timeout.js";
import { scrubSignedReplayStateInPlace } from "../signature-block-scrubber.js";
import { getVisibleAssistantText } from "../phase-filter.js";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { RunPromptParams } from "./prompt-runner-types.js";

// GBNF-02 strip-retry handler (cascade member #2). Extracted to a sibling
// module for the prompt-runner 500-line file cap; re-exported here so the
// retry-loop dispatch imports the whole silent-failure cascade from one
// module. Behavioral coverage: tool-schema-unsupported-handler.test.ts.
export {
  handleToolSchemaUnsupported,
  resetToolSchemaStripGateForTest,
} from "./tool-schema-unsupported-handler.js";

/** Mutable state threaded through the silent-failure branches. */
export interface RetryState {
  promptSucceeded: boolean;
  promptError: unknown;
}

/** Snapshot of the bridge state captured once at the start of silent-failure detection. */
export type BridgeSnapshot = ReturnType<RunPromptParams["bridge"]["getResult"]>;

/** Callback that runs the model retry pipeline (provided by retry-loop.ts to share the deps wiring). */
export type InvokeRetry = (
  messageText: string,
  promptImages: ImageContent[] | undefined,
) => Promise<ModelRetryResult>;

/** Signed-replay self-heal: scrub stored signed thinking state, retry once with a 1s settle. */
export async function handleSignedReplay(
  params: RunPromptParams,
  messageText: string,
  promptImages: ImageContent[] | undefined,
  earlyBridgeResult: BridgeSnapshot,
  retryState: RetryState,
  invokeRetry: InvokeRetry,
): Promise<void> {
  const { session, sessionKey, agentId, bridge, deps } = params;
  const llmErrSource = earlyBridgeResult.lastLlmErrorMessage ?? "";

  // Provider-agnostic signed-replay self-heal. Scrub stored signed
  // thinking / reasoning state in place, then re-enter the full
  // model retry pipeline once. Mirrors the silent-retry shape but
  // with a 1s settle (vs 3s for transient overload) since the
  // failure cause is deterministic state on disk, not a transient
  // provider condition.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgs: unknown[] = (session as any).messages ?? [];
  const { blocksRemoved, thoughtSignaturesStripped } = scrubSignedReplayStateInPlace(msgs);

  deps.logger.info(
    {
      blocksRemoved,
      thoughtSignaturesStripped,
      providerError: llmErrSource,
      hint: "Signed-replay rejection detected; scrubbing thinking state and retrying once",
      errorKind: "transient" as ErrorKind,
    },
    "Signed-replay self-heal: scrubbing and retrying",
  );

  // Brief settle before retry. Distinct from the 3s silent-retry
  // delay because signed-replay is a deterministic state error,
  // not a transient provider condition.
  await new Promise<void>(r => { const h = deps.timers.setTimeout(() => r(), 1_000); void h; });

  const retryResult = await invokeRetry(messageText, promptImages);
  retryState.promptSucceeded = retryResult.succeeded;
  retryState.promptError = retryResult.error;

  // Re-check for empty response after retry; mirror the
  // silent-retry post-check semantics so the recovery event
  // reports a faithful succeeded flag.
  let recovered = retryState.promptSucceeded;
  if (retryState.promptSucceeded) {
    const retryText = session.getLastAssistantText?.() ?? "";
    if (retryText === "") {
      const retryBridgeResult = bridge.getResult();
      if ((retryBridgeResult.llmCalls ?? 0) > 0 && !retryBridgeResult.textEmitted) {
        recovered = false;
        retryState.promptSucceeded = false;
        const llmDetail = retryBridgeResult.lastLlmErrorMessage
          ? ` — ${retryBridgeResult.lastLlmErrorMessage}`
          : "";
        retryState.promptError = new Error(
          `Signed-replay self-heal failed: ${retryBridgeResult.llmCalls} LLM call(s) produced empty response after retry (finishReason: ${retryBridgeResult.finishReason ?? "unknown"})${llmDetail}`,
        );
      }
    }
  }

  deps.eventBus.emit("execution:signed_replay_recovered", {
    agentId: agentId ?? "default",
    sessionKey: formatSessionKey(sessionKey),
    blocksRemoved,
    thoughtSignaturesStripped,
    succeeded: recovered,
    timestamp: deps.clock.now(),
  });

  if (recovered) {
    deps.logger.info(
      { blocksRemoved, thoughtSignaturesStripped, recovered: true },
      "Signed-replay self-heal succeeded",
    );
  } else {
    deps.logger.warn(
      {
        blocksRemoved,
        thoughtSignaturesStripped,
        hint: "Signed-replay self-heal retry also failed; declaring terminal failure",
        errorKind: "dependency" as ErrorKind,
      },
      "Signed-replay self-heal retry failed",
    );
  }
}

/** Rate-limit short-circuit: window can't roll within this invocation; emit terminal failure. */
export function handleRateLimited(
  params: RunPromptParams,
  earlyBridgeResult: BridgeSnapshot,
  retryState: RetryState,
): void {
  const { deps } = params;
  const llmErrSource = earlyBridgeResult.lastLlmErrorMessage ?? "";

  // Provider-side time-based throttle (429/529). Retrying within the
  // same runPrompt invocation cannot succeed — the rate-limit window
  // hasn't rolled. The model-retry layer's cache-aware short retry
  // (model-retry.ts:261-294) is the correct retry point for 429 with
  // a parseable Retry-After header < SHORT_RETRY_THRESHOLD_MS. If we
  // got here, that retry was either skipped (no Retry-After) or
  // exhausted, AND the SDK didn't throw the 429 out (caught inside
  // pi-ai's stream wrapper, surfaced as empty response). Re-entering
  // runWithModelRetry from this layer would do another N retries that
  // all hit the same rate-limit window — observed in production as
  // 1 user message → 8 LLM calls (daemon.1.log:23:35:06-23:35:52,
  // OpenRouter qwen/qwen3-coder:free 8 RPM cap). Short-circuit.
  deps.logger.warn(
    {
      llmCalls: earlyBridgeResult.llmCalls,
      finishReason: earlyBridgeResult.finishReason,
      providerError: llmErrSource,
      hint: "Provider returned a rate-limit error; retrying within the same window cannot succeed — surfacing terminal failure to caller",
      errorKind: "rate_limited" as ErrorKind,
    },
    "Rate-limit error — skipping silent-retry and declaring terminal failure",
  );
  retryState.promptSucceeded = false;
  const llmDetail = llmErrSource ? ` — ${llmErrSource}` : "";
  retryState.promptError = new Error(
    `Rate limit exceeded: ${earlyBridgeResult.llmCalls} LLM call(s) produced empty response (finishReason: ${earlyBridgeResult.finishReason ?? "unknown"})${llmDetail}`,
  );
}

/** Client-request short-circuit: deterministic provider validation rejection; do not retry. */
export function handleClientRequest(
  params: RunPromptParams,
  earlyBridgeResult: BridgeSnapshot,
  retryState: RetryState,
): void {
  const { deps } = params;
  const llmErrSource = earlyBridgeResult.lastLlmErrorMessage ?? "";

  // Plain client_request: deterministic failure (e.g. unprocessable_entity,
  // bare "cannot be modified" without signature noun). Retrying would
  // reproduce the same failure. Short-circuit before the strip+retry
  // block to avoid wasting tokens.
  deps.logger.warn(
    {
      llmCalls: earlyBridgeResult.llmCalls,
      finishReason: earlyBridgeResult.finishReason,
      providerError: llmErrSource,
      hint: "Anthropic returned a client-side validation error; retrying would reproduce the same failure",
      errorKind: "client_request" as ErrorKind,
    },
    "Client-request error — skipping silent-retry and declaring terminal failure",
  );
  retryState.promptSucceeded = false;
  const llmDetail = llmErrSource ? ` — ${llmErrSource}` : "";
  retryState.promptError = new Error(
    `Client request rejected by provider: ${earlyBridgeResult.llmCalls} LLM call(s) produced empty response (finishReason: ${earlyBridgeResult.finishReason ?? "unknown"})${llmDetail}`,
  );
}

/** Default silent-failure path: strip empty assistant turns + 3s settle + re-enter retry + LKW fallback. */
export async function handleSilentRetryDefault(
  params: RunPromptParams,
  messageText: string,
  promptImages: ImageContent[] | undefined,
  earlyBridgeResult: BridgeSnapshot,
  retryState: RetryState,
  invokeRetry: InvokeRetry,
): Promise<void> {
  const { session, bridge, deps } = params;

  // First silent failure: strip empty assistant turns and re-enter
  // the full model retry chain (cache-aware short retry, key rotation,
  // model fallback). Thinking-only messages (encrypted reasoning blocks
  // with no visible text) poison the conversation for the next attempt.
  deps.logger.info(
    {
      llmCalls: earlyBridgeResult.llmCalls,
      finishReason: earlyBridgeResult.finishReason,
      hint: "Stripping empty assistant turn and re-entering model retry",
      errorKind: "transient" as ErrorKind,
    },
    "Silent failure retry: stripping empty turn and re-entering model retry",
  );

  stripTrailingEmptyAssistantTurns(session);

  // Brief delay to let transient provider conditions clear
  await new Promise<void>(r => { const h = deps.timers.setTimeout(() => r(), 3_000); void h; });

  // Re-enter the full model retry pipeline
  const retryResult = await invokeRetry(messageText, promptImages);
  retryState.promptSucceeded = retryResult.succeeded;
  retryState.promptError = retryResult.error;

  // Re-check for empty response after retry
  if (retryState.promptSucceeded) {
    const retryText = session.getLastAssistantText?.() ?? "";
    if (retryText === "") {
      const retryBridgeResult = bridge.getResult();
      if ((retryBridgeResult.llmCalls ?? 0) > 0 && !retryBridgeResult.textEmitted) {
        deps.logger.warn(
          {
            llmCalls: retryBridgeResult.llmCalls,
            finishReason: retryBridgeResult.finishReason,
            hint: "Silent failure persisted after retry; treating as terminal failure",
            errorKind: "dependency" as ErrorKind,
          },
          "Silent LLM failure detected (after retry)",
        );
        retryState.promptSucceeded = false;
        const llmDetail = retryBridgeResult.lastLlmErrorMessage
          ? ` — ${retryBridgeResult.lastLlmErrorMessage}`
          : "";
        retryState.promptError = new Error(
          `Silent LLM failure: ${retryBridgeResult.llmCalls} LLM call(s) produced empty response after retry (finishReason: ${retryBridgeResult.finishReason ?? "unknown"})${llmDetail}`,
        );

        // LKW silent-failure fallback: some providers return 403 as
        // an empty response (SDK doesn't throw), so model-retry's LKW
        // block never fires. Detect auth errors here and try the LKW
        // model as a final attempt before giving up.
        await attemptLkwFallback(params, messageText, promptImages, retryBridgeResult, retryState);
      }
    }
  }
}

/** Terminal silent-failure branch when the gate is closed or follow-up didn't recover. */
export function declareSilentTerminalFailure(
  params: RunPromptParams,
  earlyBridgeResult: BridgeSnapshot,
  retryState: RetryState,
): void {
  const { deps } = params;

  // Already retried once, or followUp didn't help -- declare terminal failure
  deps.logger.warn(
    {
      llmCalls: earlyBridgeResult.llmCalls,
      finishReason: earlyBridgeResult.finishReason,
      hint: "LLM resolved without error but produced empty response; treating as failure",
      errorKind: "dependency" as ErrorKind,
    },
    "Silent LLM failure detected",
  );
  retryState.promptSucceeded = false;
  // Include the bridge's LLM error message so classifyError can
  // pattern-match on the real provider error (e.g. billing, auth).
  const llmDetail = earlyBridgeResult.lastLlmErrorMessage
    ? ` — ${earlyBridgeResult.lastLlmErrorMessage}`
    : "";
  retryState.promptError = new Error(
    `Silent LLM failure: ${earlyBridgeResult.llmCalls} LLM call(s) produced empty response (finishReason: ${earlyBridgeResult.finishReason ?? "unknown"})${llmDetail}`,
  );
}

/**
 * Strip trailing assistant messages with no visible text content. Walks
 * backward from the end, removing assistant messages where every content
 * block is thinking-only or has no visible text. Stops at the last
 * non-assistant message (user or toolResult).
 */
export function stripTrailingEmptyAssistantTurns(session: RunPromptParams["session"]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgs: any[] = (session as any).messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]; // eslint-disable-line security/detect-object-injection
    if (m?.role !== "assistant") break;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const hasVisibleText = blocks.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
      (b: any) => b.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
    );
    if (!hasVisibleText) {
      msgs.splice(i, 1);
    } else {
      break;
    }
  }
}

/**
 * Last-known-working fallback for silent auth failures. Some providers
 * return 403 as an empty response (SDK doesn't throw), so model-retry's
 * LKW block never fires. Detect auth errors here and try the LKW model
 * as a final attempt before giving up.
 */
async function attemptLkwFallback(
  params: RunPromptParams,
  messageText: string,
  promptImages: ImageContent[] | undefined,
  retryBridgeResult: BridgeSnapshot,
  retryState: RetryState,
): Promise<void> {
  const { session, config, agentId, effectiveTimeout, deps } = params;
  const silentAuthErr = retryBridgeResult.lastLlmErrorMessage ?? "";

  if (!isAuthError(new Error(silentAuthErr)) || !deps.lastKnownModel) {
    return;
  }

  const lkw =
    deps.lastKnownModel.getLastKnown(agentId ?? "") ??
    deps.lastKnownModel.getAnyKnown(config.provider);

  if (!lkw || (lkw.provider === config.provider && lkw.model === config.model)) {
    return;
  }

  deps.logger.info(
    { lkwProvider: lkw.provider, lkwModel: lkw.model, silentAuthErr },
    "Silent auth failure — attempting last-known-working model",
  );

  try {
    const normalizedLkw = normalizeModelId(lkw.provider, lkw.model);
    const lkwModelObj = deps.modelRegistry.find(lkw.provider, normalizedLkw.modelId);
    if (lkwModelObj) {
      await session.setModel(lkwModelObj);
    }

    // Strip trailing empty assistant turns before the LKW attempt
    stripTrailingEmptyAssistantTurns(session);

    await withPromptTimeout(
      session.prompt(messageText, { expandPromptTemplates: false, images: promptImages }),
      effectiveTimeout.retryPromptTimeoutMs,
      () => session.abort(),
      deps.timers,
    );

    const lkwText = getVisibleAssistantText(session);
    if (lkwText !== "") {
      retryState.promptSucceeded = true;
      retryState.promptError = undefined;
      deps.lastKnownModel.recordSuccess(agentId ?? "default", lkw.provider, lkw.model);
      deps.logger.info(
        { lkwProvider: lkw.provider, lkwModel: lkw.model },
        "LKW silent-failure fallback succeeded",
      );
    } else {
      deps.logger.warn(
        {
          lkwProvider: lkw.provider, lkwModel: lkw.model,
          hint: "LKW model also produced empty response",
          errorKind: "dependency" as ErrorKind,
        },
        "LKW silent-failure fallback produced empty response",
      );
    }
  } catch (lkwErr) {
    deps.logger.warn(
      {
        err: lkwErr, lkwProvider: lkw.provider, lkwModel: lkw.model,
        hint: "LKW model threw during silent-failure fallback",
        errorKind: "dependency" as ErrorKind,
      },
      "LKW silent-failure fallback failed",
    );
  }
}
