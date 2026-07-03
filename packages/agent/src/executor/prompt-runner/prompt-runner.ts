// SPDX-License-Identifier: Apache-2.0
/**
 * Thin orchestrator for prompt execution — composes the four stage modules
 * (envelope-wrapper → budget-precheck → retry-loop → output-escalation).
 *
 * Each leaf module owns its own concern and never depends back on this file.
 *
 * Consumer: `pi-executor.ts` calls `runPrompt()` during `execute()`.
 *
 * @module
 */

import { createHash } from "node:crypto";

import { systemNowMs } from "@comis/core";

import { wrapEnvelope } from "./envelope-wrapper.js";
import { precheckBudget } from "./budget-precheck.js";
import { runRetryLoop, stuckSessionResult } from "./retry-loop.js";
import { escalateOutput } from "./output-escalation.js";
import type { PromptRunResult, RunPromptParams } from "./prompt-runner-types.js";

/**
 * Run the prompt execution phase of a PiExecutor turn.
 *
 * Handles: message envelope wrapping, dynamic preamble/deferred context,
 * image passthrough, RAG injection, budget pre-check, model retry, silent
 * failure detection, output escalation, budget continuation, overflow
 * recovery, timeout cost estimation, and output guard scanning.
 *
 * @param params - All inputs needed for prompt execution
 * @returns Prompt execution outcome (success, error, escalation state)
 */
export async function runPrompt(params: RunPromptParams): Promise<PromptRunResult> {
  // Envelope wrapping + preamble + RAG + images + user-budget parsing.
  const envelope = wrapEnvelope(params);

  // Emit prompt:submitted observability boundary event.
  // Fires after envelope assembly + before the retry-loop drives the
  // model call so the trajectory writer captures the exact (system,
  // messages) pair the model is about to see. Sha256 digests over the
  // raw strings are stable across runs that produce
  // byte-identical prompts (the cache-trace consumer joins on
  // these digests).
  emitPromptSubmitted(params, envelope.messageText);

  // Budget pre-check (skipped automatically when skipPrompt is true).
  const precheck = precheckBudget(params, envelope.messageText, envelope.skipPrompt);
  if (precheck.kind === "rejected") {
    return precheck.result;
  }

  // Model retry + silent-failure detection + stuck-session guard.
  const retry = await runRetryLoop(
    params,
    envelope.messageText,
    envelope.promptImages,
    envelope.skipPrompt,
  );
  if (retry.stuckSessionDetected) {
    return stuckSessionResult();
  }

  // Output escalation + success-path response processing + failure-path
  // overflow recovery + error classification + timeout cost emission.
  return escalateOutput(
    params,
    envelope.messageText,
    envelope.promptImages,
    envelope.budgetTracker,
    envelope.budgetCapped,
    envelope.requestedBudget,
    retry.promptSucceeded,
    retry.promptError,
    envelope.skipPrompt,
  );
}

/**
 * Emit the `prompt:submitted` observability event. The bridge picks this
 * up and writes one trajectory line per call. Best-effort: any error in
 * computing the digest is swallowed (we never block model dispatch on
 * an observability emit failure).
 */
function emitPromptSubmitted(params: RunPromptParams, messageText: string): void {
  try {
    const systemPrompt = params.systemPrompt ?? "";
    // sha256 over the raw text — both systemPrompt and messageText are
    // strings so a canonical-key-sort serializer (e.g.,
    // @comis/observability's stableStringify) is unnecessary here. The
    // digest only needs to be stable across runs that produce
    // byte-identical strings; cross-correlating with cache-trace and
    // SystemPromptReport uses the same primitive.
    const systemDigest = sha256Hex(systemPrompt);
    // Digest the assembled user-side text. This is the load-bearing
    // signal: the wrapped envelope, capability-index context, deferred
    // tools, inline memory, budget warning, and final user question.
    const messagesDigest = sha256Hex(messageText);

    // messageCount: session transcript length + 1 (the message about
    // to be submitted via params.session.send()). Access pi-mono's
    // state.messages defensively — the SDK may evolve the shape.
    const transcriptLen =
      (params.session as { agent?: { state?: { messages?: { length?: number } } } })
        .agent?.state?.messages?.length ?? 0;

    params.deps.eventBus.emit("prompt:submitted", {
      agentId: params.agentId ?? params.config.name,
      sessionKey: params.formattedKey,
      traceId: params.executionId,
      promptChars: systemPrompt.length + messageText.length,
      provider: params.resolvedModel?.provider ?? params.config.provider,
      modelId: params.resolvedModel?.id ?? params.config.model,
      messageCount: transcriptLen + 1,
      systemDigest,
      messagesDigest,
      timestamp: systemNowMs(),
    });
  } catch (err) {
    // Best-effort emit — never abort dispatch on observability errors.
    params.deps.logger.debug(
      { err, hint: "prompt:submitted emit failed; trajectory will miss this turn's record", errorKind: "internal" as const },
      "Failed to emit prompt:submitted",
    );
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
