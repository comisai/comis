// SPDX-License-Identifier: Apache-2.0
/**
 * handleToolSchemaUnsupported — GBNF-02's strip-`pattern`/`format`-and-retry
 * for grammar-400s surfacing on the SILENT path (pi-ai catches the provider
 * error in-stream, the SDK's retryable-regex does not match, `prompt()`
 * RESOLVES; the error lands in `bridge.lastLlmErrorMessage` and is
 * classified by detectSilentFailure in retry-loop.ts — which already runs
 * inside the executor's `withSession` scope).
 *
 * Fifth member of the silent-failure cascade. Lives in its own module
 * because the prompt-runner directory carries a 500-line file cap;
 * `silent-failure-handlers.ts` re-exports it so the dispatch imports the
 * whole cascade from one module. Mirrors `handleSignedReplay`'s structural
 * skeleton (mutate state → WARN with hint/errorKind → ONE `invokeRetry` →
 * post-retry empty-check → event emit → success/failure log pair) with two
 * deviations: a session-keyed ONCE-GATE (T-175-14 — bounded at +1 prompt
 * per session, set BEFORE the retry so re-entry during the retry cannot
 * loop) and NO settle delay (a grammar-400 is a deterministic schema
 * failure, not a transient provider condition).
 *
 * The retry's `invokeRetry` path re-enters `runWithModelRetry`; Plan 175-02's
 * ladder classify-guard guarantees a second grammar-400 inside that retry
 * returns immediately — zero rotation/fallback/LKW burn. The once-gate
 * guarantees the cascade never re-strips.
 *
 * I7: the new WARN/event lines carry tool + keyword NAMES only — never
 * schema bodies and never the raw provider body (llama-server bodies embed
 * full schema dumps; the raw error already reaches operator logs via the
 * existing failure-path `err` serializer).
 *
 * @module
 */

import { formatSessionKey } from "@comis/core";
import type { ErrorKind } from "@comis/core";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ModelRetryResult } from "../model-retry.js";
import type { RunPromptParams } from "./prompt-runner-types.js";
import { applyReactiveSchemaStripInPlace } from "./tool-schema-strip.js";

// Structural mirrors of silent-failure-handlers' RetryState / BridgeSnapshot /
// InvokeRetry. Declared here (not imported) because silent-failure-handlers
// re-exports THIS module — importing back from it would create a .d.ts cycle
// that `pnpm cycles` rejects. TypeScript structural typing keeps the dispatch
// call site (which passes the canonical types) assignment-compatible.
interface MutableRetryState {
  promptSucceeded: boolean;
  promptError: unknown;
}
type SnapshotOfBridge = ReturnType<RunPromptParams["bridge"]["getResult"]>;
type RetryInvoker = (
  messageText: string,
  promptImages: ImageContent[] | undefined,
) => Promise<ModelRetryResult>;

/**
 * Session-keyed once-gate (via `formatSessionKey`; the schema-snapshot /
 * deliveredGuides session-keyed store precedent). Bounded — one string per
 * session per process. The key is added BEFORE the retry fires so re-entry
 * during the retry cannot loop (T-175-14).
 */
const toolSchemaStripAttemptedSessions = new Set<string>();

/** Test hook: clears the module-level once-gate between test cases. */
export function resetToolSchemaStripGateForTest(): void {
  toolSchemaStripAttemptedSessions.clear();
}

/** Terminal state shape mirroring handleClientRequest: honest classified
 *  failure. `promptError` carries the raw classified source so the
 *  failure-path `classifyError` yields the canned tool_schema_unsupported
 *  userMessage (the body goes to retryState, NOT to any new log line). */
function declareStripTerminalFailure(retryState: MutableRetryState, llmErrSource: string): void {
  retryState.promptSucceeded = false;
  retryState.promptError = new Error(llmErrSource);
}

/** Strip-pattern/format-and-retry: exactly once per session, then honest failure. */
export async function handleToolSchemaUnsupported(
  params: RunPromptParams,
  messageText: string,
  promptImages: ImageContent[] | undefined,
  earlyBridgeResult: SnapshotOfBridge,
  retryState: MutableRetryState,
  invokeRetry: RetryInvoker,
): Promise<void> {
  const { session, sessionKey, agentId, bridge, deps } = params;
  const llmErrSource = earlyBridgeResult.lastLlmErrorMessage ?? "";
  const key = formatSessionKey(sessionKey);
  const provider = params.resolvedModel?.provider;
  const modelId = params.resolvedModel?.id;

  // Gate check FIRST: one strip-retry per session, ever. A second
  // grammar-400 in the same session is honest classified failure with zero
  // additional retries and zero fallback-model burn.
  if (toolSchemaStripAttemptedSessions.has(key)) {
    deps.logger.warn(
      {
        provider,
        modelId,
        hint: 'strip-retry already attempted this session; failing honestly — durable fix: models[].comisCompat.toolSchemaProfile: "gbnf"',
        errorKind: "validation" as ErrorKind,
      },
      "Tool schema rejected again after strip-retry; declaring terminal failure",
    );
    declareStripTerminalFailure(retryState, llmErrSource);
    deps.eventBus.emit("execution:tool_schema_unsupported", {
      agentId: agentId ?? "default",
      sessionKey: key,
      toolNames: [],
      strippedKeywords: [],
      retried: false,
      succeeded: false,
      timestamp: deps.clock.now(),
    });
    return;
  }

  // Close the gate BEFORE invoking the retry — re-entry during the retry
  // cannot loop back into the strip branch.
  toolSchemaStripAttemptedSessions.add(key);

  const { strippedToolNames, strippedKeywords } = applyReactiveSchemaStripInPlace(
    params.mergedCustomTools,
  );

  // Nothing-to-strip branch: a retry with byte-identical schemas is a
  // guaranteed identical 400 — futile. WARN pivots to the proactive profile.
  if (strippedToolNames.length === 0) {
    deps.logger.warn(
      {
        toolNames: [],
        strippedKeywords: [],
        provider,
        modelId,
        hint: 'Provider rejected a tool schema but no pattern/format keywords were strippable; failing honestly. Durable fix: models[].comisCompat.toolSchemaProfile: "gbnf" (auto-enabled for provider type "ollama")',
        errorKind: "validation" as ErrorKind,
      },
      "Tool schema rejected by provider; nothing to strip — declaring terminal failure",
    );
    declareStripTerminalFailure(retryState, llmErrSource);
    deps.eventBus.emit("execution:tool_schema_unsupported", {
      agentId: agentId ?? "default",
      sessionKey: key,
      toolNames: [],
      strippedKeywords: [],
      retried: false,
      succeeded: false,
      timestamp: deps.clock.now(),
    });
    return;
  }

  // Strippable branch. The raw provider body is deliberately NOT attached to
  // this WARN: llama-server bodies embed full schema dumps (I7 forbids
  // bodies in the new lines; the existing failure-path err serializer
  // already surfaces the raw error to operator logs).
  deps.logger.warn(
    {
      toolNames: strippedToolNames,
      strippedKeywords,
      provider,
      modelId,
      hint: 'Provider rejected a tool schema at grammar-compile; stripped pattern/format from the named tools and retrying once. Durable fix: models[].comisCompat.toolSchemaProfile: "gbnf" (auto-enabled for provider type "ollama")',
      errorKind: "validation" as ErrorKind,
    },
    "Tool schema rejected by provider; stripping pattern/format and retrying once",
  );

  const retryResult = await invokeRetry(messageText, promptImages);
  retryState.promptSucceeded = retryResult.succeeded;
  retryState.promptError = retryResult.error;

  // Post-retry empty-check — verbatim signed-replay shape so the event
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
          `Tool-schema strip-retry failed: ${retryBridgeResult.llmCalls} LLM call(s) produced empty response after retry (finishReason: ${retryBridgeResult.finishReason ?? "unknown"})${llmDetail}`,
        );
      }
    }
  }

  deps.eventBus.emit("execution:tool_schema_unsupported", {
    agentId: agentId ?? "default",
    sessionKey: key,
    toolNames: strippedToolNames,
    strippedKeywords,
    retried: true,
    succeeded: recovered,
    timestamp: deps.clock.now(),
  });

  if (recovered) {
    deps.logger.info(
      { toolNames: strippedToolNames, strippedKeywords, recovered: true },
      "Tool-schema strip-retry succeeded",
    );
  } else {
    deps.logger.warn(
      {
        toolNames: strippedToolNames,
        strippedKeywords,
        hint: 'Strip-retry also failed; declaring terminal failure. Durable fix: models[].comisCompat.toolSchemaProfile: "gbnf"',
        errorKind: "validation" as ErrorKind,
      },
      "Tool-schema strip-retry failed",
    );
  }
}
