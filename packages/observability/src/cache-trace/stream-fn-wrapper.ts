// SPDX-License-Identifier: Apache-2.0
// @allow-throw: pi-ai StreamFn boundary — re-throws synchronous next() exception (contract violation) after recording model:after audit trail; the executor catches the throw at the streamFn invocation site.
/**
 * `buildCacheTraceWrapper` — StreamFn wrapper factory.
 *
 * Closure factory that emits TWO cache-trace events per LLM call:
 *
 *   1. `stream:context` (pre-call) — message + system digests +
 *      provider/modelId. The pre-call event is the message-content
 *      fingerprint for downstream replay/diff tools.
 *
 *   2. `model:after` (post-call) — cache-token attribution parsed from
 *      the StreamFn return value's `usage` block. The pi-ai
 *      `AssistantMessage` exposes `usage.cacheRead` and `usage.cacheWrite`
 *      (canonical pi-ai shape); we project them onto the cache-trace
 *      schema's `cacheReadInputTokens` / `cacheCreationInputTokens`
 *      (Anthropic-style envelope names — matches the EventBus bridge's
 *      `observability:token_usage` payload shape).
 *
 * Provider-shape narrowing is defensive: when `usage` is absent or
 * the numeric fields aren't numbers, the `model:after` event still
 * emits but without the token fields. The post-call event is the
 * audit trail; missing token data does NOT skip the emit.
 *
 * StreamFn error contract (per pi-agent-core types.d.ts):
 *   - Must not throw or return a rejected promise for model/runtime
 *     failures.
 *   - Failures are encoded in the returned stream via a final
 *     AssistantMessage with `stopReason: "error" | "aborted"` and
 *     `errorMessage`.
 *
 * The wrapper therefore relies on the stream's `.result()` Promise
 * (which never rejects per the contract) to fire `model:after` — we
 * project `result.errorMessage` onto the event when stopReason
 * indicates failure. If `next()` itself throws synchronously (a
 * contract violation, but defensive), we record `error` on the
 * model:after event and re-throw so the executor sees the failure.
 *
 * @module
 */

import { createHash } from "node:crypto";

import type { StreamFn } from "@earendil-works/pi-agent-core";

import { stableStringify } from "../shared/stable-stringify.js";
import type { CacheTrace } from "./runtime.js";

/**
 * StreamFn wrapper signature: receives the next link in the chain and
 * returns a decorated StreamFn. Mirrors the
 * `packages/agent/src/executor/stream-wrappers/types.ts` `StreamFnWrapper`
 * shape but kept locally to avoid a cross-package import (observability
 * is a leaf substrate; the agent package imports this wrapper via the
 * barrel, not the other way around).
 */
export type StreamFnWrapper = (next: StreamFn) => StreamFn;

// Structural narrowing types — Parameters<StreamFn> resolves to the pi-ai
// `Context` + `Model` types but we extract the few fields we actually
// touch to keep the cross-package coupling minimal.
type StreamModelArg = Parameters<StreamFn>[0];
type StreamContextArg = Parameters<StreamFn>[1];

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Build a StreamFn wrapper that records `stream:context` BEFORE the
 * call and `model:after` AFTER the call (when the stream's final
 * result resolves).
 *
 * @param trace - the per-session recorder (must be non-null; consumers
 *                should not call this when `createCacheTrace` returned
 *                null).
 */
export function buildCacheTraceWrapper(trace: CacheTrace): StreamFnWrapper {
  return function cacheTraceWrapper(next: StreamFn): StreamFn {
    return ((
      model: StreamModelArg,
      context: StreamContextArg,
      options?: Parameters<StreamFn>[2],
    ) => {
      const messages = Array.isArray(context.messages) ? context.messages : [];
      const messageFingerprints = messages.map((m: unknown) =>
        sha256(stableStringify(m)),
      );
      const messagesDigest = sha256(messageFingerprints.join("|"));
      const systemPromptText =
        typeof context.systemPrompt === "string"
          ? context.systemPrompt
          : stableStringify(context.systemPrompt ?? "");
      const systemDigest = sha256(systemPromptText);

      const preCallPayload: Record<string, unknown> = {
        messageCount: messages.length,
        messageRoles: messages.map((m: unknown) => {
          const role = (m as { role?: unknown }).role;
          return typeof role === "string" ? role : "unknown";
        }),
        messageFingerprints,
        messagesDigest,
        systemDigest,
      };
      if (trace.includeMessages) {
        preCallPayload.messages = messages;
      }
      if (trace.includeSystem) {
        preCallPayload.system = context.systemPrompt;
      }

      // model.provider / model.id are part of the pi-ai Model contract,
      // but we narrow defensively for test stubs.
      const modelProvider = (model as { provider?: unknown }).provider;
      const modelId = (model as { id?: unknown }).id;
      if (typeof modelProvider === "string") preCallPayload.provider = modelProvider;
      if (typeof modelId === "string") preCallPayload.modelId = modelId;

      trace.recordStage("stream:context", preCallPayload);

      // Delegate to the next link. The pi-ai StreamFn contract says
      // failures are encoded in the returned stream (final AssistantMessage
      // with stopReason: "error" | "aborted") — next() should not throw
      // for model/runtime failures. We still wrap in try/catch defensively
      // for contract violations.
      let returned: ReturnType<StreamFn>;
      try {
        returned = next(model, context, options);
      } catch (e) {
        // Synchronous throw from next — contract violation but defensively
        // record model:after with the error and re-throw.
        const err = e instanceof Error ? e : new Error(String(e));
        trace.recordStage("model:after", {
          messagesDigest,
          systemDigest,
          error: err.message,
        });
        throw err;
      }

      // Project the stream's final result onto a model:after event.
      // The pi-ai AssistantMessageEventStream's .result() Promise
      // resolves to an AssistantMessage carrying `usage` (cacheRead +
      // cacheWrite per pi-ai types.d.ts:Usage). We splat onto the
      // Anthropic-style envelope names the cache-trace schema uses.
      //
      // The result handler does NOT block the caller — they receive
      // the stream synchronously and iterate at their own pace. Our
      // .result() consumption is concurrent and idempotent against the
      // caller's iteration (EventStream resolves result() from end()
      // independently of iteration progress).
      const handleResolved = (raw: unknown): void => {
        const post: Record<string, unknown> = {
          messagesDigest, // re-emit for correlation with the pre-call line
          systemDigest,
        };
        const usage = (raw as { usage?: unknown })?.usage;
        if (usage !== undefined && usage !== null && typeof usage === "object") {
          // pi-ai canonical shape: usage.cacheRead, usage.cacheWrite.
          // Provider variants may name them cacheReadInputTokens /
          // cacheCreationInputTokens (Anthropic) — accept either,
          // project onto the cache-trace schema's envelope names.
          const u = usage as {
            cacheRead?: unknown;
            cacheWrite?: unknown;
            cacheReadInputTokens?: unknown;
            cacheCreationInputTokens?: unknown;
          };
          const read =
            typeof u.cacheReadInputTokens === "number"
              ? u.cacheReadInputTokens
              : typeof u.cacheRead === "number"
                ? u.cacheRead
                : undefined;
          const write =
            typeof u.cacheCreationInputTokens === "number"
              ? u.cacheCreationInputTokens
              : typeof u.cacheWrite === "number"
                ? u.cacheWrite
                : undefined;
          if (read !== undefined) post.cacheReadInputTokens = read;
          if (write !== undefined) post.cacheCreationInputTokens = write;
        }
        // Surface a stream-encoded error on the model:after event so
        // failed calls produce an audit trail.
        const stopReason = (raw as { stopReason?: unknown })?.stopReason;
        const errorMessage = (raw as { errorMessage?: unknown })?.errorMessage;
        if (
          typeof errorMessage === "string" &&
          (stopReason === "error" || stopReason === "aborted")
        ) {
          post.error = errorMessage;
        }
        trace.recordStage("model:after", post);
      };

      const consumeResult = (
        ret: { result?: () => Promise<unknown> } | unknown,
      ): void => {
        const r = ret as { result?: () => Promise<unknown> };
        if (typeof r?.result === "function") {
          r.result().then(handleResolved, (err: unknown) => {
            // Per pi-ai contract .result() should not reject; defensive
            // emit if it does.
            const e = err instanceof Error ? err : new Error(String(err));
            trace.recordStage("model:after", {
              messagesDigest,
              systemDigest,
              error: e.message,
            });
          });
        } else {
          // Test stub or non-stream return: project usage directly
          // from the returned value. The test fixture in
          // stream-fn-wrapper.test.ts uses this branch.
          handleResolved(ret);
        }
      };

      // The StreamFn type union includes Promise<…> — if next() returned
      // a Promise, await it before consuming .result().
      if (
        returned !== null &&
        typeof returned === "object" &&
        typeof (returned as { then?: unknown }).then === "function"
      ) {
        (returned as Promise<unknown>).then(consumeResult, () => {
          trace.recordStage("model:after", {
            messagesDigest,
            systemDigest,
            error: "stream-fn-promise-rejected",
          });
        });
      } else {
        consumeResult(returned);
      }

      return returned;
    }) as StreamFn;
  };
}
