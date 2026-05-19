// SPDX-License-Identifier: Apache-2.0
/**
 * `buildCacheTraceWrapper` — StreamFn wrapper factory.
 *
 * Closure factory that emits one `stream:context` cache-trace event per
 * LLM call. The wrapper itself is purely a closure factory; no shared
 * state outside the captured `CacheTrace` instance.
 *
 * Per-call payload shape:
 *   - `provider`, `modelId` from the model arg.
 *   - `messageCount`, `messageRoles[]` always populated (cheap; no PII).
 *   - `messageFingerprints[]`: per-message sha256(stableStringify(m)).
 *   - `messagesDigest`: sha256 of the joined fingerprint list (full
 *     64-char hex — replaces the legacy 16-char truncated SHA-256).
 *   - `systemDigest`: sha256 of the stable system-prompt serialization.
 *   - `messages` (raw): gated by `trace.includeMessages` — when false,
 *     the field is omitted.
 *   - `system` (raw): gated by `trace.includeSystem` — when false, the
 *     field is omitted.
 *
 * The wrapper is intentionally minimal — `recordStage("session:after",
 * {...})` is fired elsewhere (by the executor at session-end). This
 * wrapper only handles per-stream context.
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
 * Build a StreamFn wrapper that records a `stream:context` cache-trace
 * event before delegating to the next link in the chain.
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
      const messageFingerprints = messages.map((m: unknown) => sha256(stableStringify(m)));
      const messagesDigest = sha256(messageFingerprints.join("|"));
      const systemPromptText =
        typeof context.systemPrompt === "string"
          ? context.systemPrompt
          : stableStringify(context.systemPrompt ?? "");
      const systemDigest = sha256(systemPromptText);

      const payload: Record<string, unknown> = {
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
        payload.messages = messages;
      }
      if (trace.includeSystem) {
        payload.system = context.systemPrompt;
      }

      // model.provider / model.id are part of the pi-ai Model contract,
      // but we narrow defensively for test stubs.
      const modelProvider = (model as { provider?: unknown }).provider;
      const modelId = (model as { id?: unknown }).id;
      if (typeof modelProvider === "string") payload.provider = modelProvider;
      if (typeof modelId === "string") payload.modelId = modelId;

      trace.recordStage("stream:context", payload);

      return next(model, context, options);
    }) as StreamFn;
  };
}
