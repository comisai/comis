// SPDX-License-Identifier: Apache-2.0
/**
 * Signature replay scrubber context engine layer.
 *
 * Always-on policy: strips signed `thinking` blocks entirely from EVERY
 * assistant message (latest included) and strips `thoughtSignature` from
 * `toolCall` / `tool_call` blocks in the same messages. `redacted_thinking`
 * blocks are never modified, anywhere.
 *
 * Rationale: Anthropic's signed-thinking validation operates on the full
 * (system + tools + history) prefix. After 8 quick tasks of progressively
 * narrower drift detection (gj6 → kvl) we proved targeted detection is
 * intractable; trace 679c8927 had stable tools (49138 bytes across 4 turns)
 * but the system prompt grew +1824 bytes and the 400 fired anyway.
 *
 * 260428-lm6 introduced an unconditional drop that preserved the LATEST
 * assistant message's signatures, on the theory that the immediate-next
 * continuation could still validate them. 260428-nzp's repro proved that
 * carve-out doesn't work: cross-turn signature validation covers the whole
 * request body (system + tools + history) and comis's dynamic context
 * guarantees the surrounding context changes turn-to-turn. So the latest's
 * signatures get invalidated too. Drop them all.
 *
 * 260430-anthropic-400-thinking-block: the prior cache-fence skip
 * (`if (i <= budget.cacheFenceIndex) preserve`) caused a per-execution
 * regression. In iteration 1 of an execution the fence is -1 so all signed
 * thinking blocks are stripped and the wire body establishes a cached
 * prefix WITHOUT signatures. In subsequent iterations the fence becomes
 * positive (= the breakpoint placed in iter 1) and the skip preserved
 * messages 0…fence as-is. But `buildSessionContext()` reloads from on-disk
 * JSONL where signatures are intact, so the wire body re-introduced signed
 * thinking blocks at fence-protected positions that Anthropic had cached
 * as unsigned. The cache-prefix validator detected the divergence and
 * rejected with `400 invalid_request_error: ... blocks cannot be modified`.
 *
 * Fix: scrub uniformly across the array, regardless of cacheFenceIndex.
 * The scrubber is pure/deterministic — input messages → same scrubbed
 * output every time — so iter 1 strips, Anthropic caches the stripped
 * prefix, iter 2 strips identically, and the cache hits. There is NO
 * per-iteration cache penalty: the rebuild only happens once per session
 * (when iter 1 first establishes the cached prefix). The cacheFenceIndex
 * is read from the budget for diagnostic stats only and never gates
 * stripping.
 *
 * Provider coverage: NOT gated on `model.reasoning` because Gemini's
 * `thoughtSignature` lives on toolCall blocks even when the model itself
 * is not flagged as reasoning. Cost is one walk over assistant messages,
 * no I/O.
 *
 * Immutability: never mutates input messages or arrays. Returns new arrays
 * and shallow-copied messages only when changes are needed. When the
 * history contains zero touchable signed state (e.g., fresh session, or
 * single-assistant turn) returns the original `messages` reference (zero
 * allocation).
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ComisLogger } from "@comis/infra";
import type { ContextLayer, TokenBudget } from "./types.js";
import type { DriftCheck } from "../executor/replay-drift-detector.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Dependencies for `createSignatureReplayScrubber`. */
export interface SignatureReplayScrubberDeps {
  /** Kept on the deps shape for back-compat with existing wiring; unused
   *  by this layer. The thinking cleaner's keepTurns override in
   *  executor-context-engine-setup.ts still consults the same closure for
   *  unrelated reasons, so leaving the field plumbed avoids a chain of
   *  unrelated edits in callers. */
  getReplayDriftMode?: () => DriftCheck | undefined;
  /** Optional callback invoked at the end of `apply()` with the scrub
   *  counts. Fields preserve the legacy `dropped` / `signaturesStripped`
   *  names so the context-engine snapshot consumer keeps working without
   *  churn; the new explicit counter names are also included. */
  onScrubbed?: (stats: {
    scrubbedAssistantMessages: number;
    blocksAffected: number;
    toolCallsAffected: number;
    latestAssistantIdx: number;
    /** Alias of blocksAffected (legacy field name preserved). */
    dropped: number;
    /** Alias of toolCallsAffected (legacy field name preserved). */
    signaturesStripped: number;
    /** Legacy; always undefined now (no drift reason in the always-on path). */
    reason?: string;
  }) => void;
  /** Required: per-execute INFO log emission. */
  logger: ComisLogger;
}

/**
 * Create the signature-replay-scrubber pipeline layer.
 *
 * Layer ordering: runs AFTER `thinking-block-cleaner` and BEFORE
 * `signature-surrogate-guard` (and well before `reasoning-tag-stripper`).
 */
export function createSignatureReplayScrubber(
  deps: SignatureReplayScrubberDeps,
): ContextLayer {
  return {
    name: "signature-replay-scrubber",

    async apply(messages: AgentMessage[], _budget: TokenBudget): Promise<AgentMessage[]> {
      if (messages.length === 0) return messages;

      // Find the latest assistant message index. If none, no scrub.
      let latestIdx = -1;
      for (let i = 0; i < messages.length; i++) {
        // eslint-disable-next-line security/detect-object-injection -- numeric index
        const m = messages[i] as { role?: string };
        if (m && m.role === "assistant") latestIdx = i;
      }
      if (latestIdx < 0) return messages;

      let scrubbedAssistantMessages = 0;
      let blocksAffected = 0;
      let toolCallsAffected = 0;
      let anyChanged = false;
      const result: AgentMessage[] = new Array(messages.length);

      for (let i = 0; i < messages.length; i++) {
        // eslint-disable-next-line security/detect-object-injection -- numeric index
        const original = messages[i];

        // 260430-anthropic-400-thinking-block: cacheFenceIndex is intentionally
        // NOT consulted here. Stripping uniformly across the array keeps the
        // scrubbed prefix identical across iterations of the same execution,
        // which is what Anthropic's prompt-cache validator requires. See
        // module docstring for the full rationale.

        const msg = original as { role?: string; content?: unknown };
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          result[i] = original;
          continue;
        }

        // Walk content blocks. Latest included: cross-turn signature
        // validation invalidates it too.
        const content = msg.content as unknown[];
        let messageChanged = false;
        const newContent: unknown[] = new Array(content.length);

        for (let j = 0; j < content.length; j++) {
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          const block = content[j];
          if (!block || typeof block !== "object") {
            // eslint-disable-next-line security/detect-object-injection -- numeric index
            newContent[j] = block;
            continue;
          }
          const b = block as {
            type?: string;
            redacted?: unknown;
            thinkingSignature?: unknown;
            thoughtSignature?: unknown;
          };

          if (b.type === "thinking") {
            // redacted_thinking: never modified.
            if (b.redacted === true) {
              // eslint-disable-next-line security/detect-object-injection -- numeric index
              newContent[j] = block;
              continue;
            }
            // Signed thinking: strip the block entirely. Clearing the
            // signature to "" was previously attempted but Anthropic only
            // tolerates it while the prompt cache covers the prefix. On
            // cache eviction the full request is re-validated and a modified
            // thinkingSignature triggers a 400 ("thinking blocks cannot be
            // modified"). Stripping the block avoids this: Anthropic accepts
            // conversations where thinking blocks are absent from historical
            // turns. Reasoning-token continuity is lost, but that is
            // strictly better than a hard 400 that kills the session.
            if (typeof b.thinkingSignature === "string" && b.thinkingSignature.length > 0) {
              // Mark as null — filtered out below.
              // eslint-disable-next-line security/detect-object-injection -- numeric index
              newContent[j] = null;
              blocksAffected++;
              messageChanged = true;
              continue;
            }
            // eslint-disable-next-line security/detect-object-injection -- numeric index
            newContent[j] = block;
            continue;
          }

          if (
            (b.type === "toolCall" || b.type === "tool_call") &&
            b.thoughtSignature !== undefined &&
            b.thoughtSignature !== null &&
            !(typeof b.thoughtSignature === "string" && b.thoughtSignature.length === 0)
          ) {
            const copy = { ...(b as Record<string, unknown>) };
            delete copy.thoughtSignature;
            // eslint-disable-next-line security/detect-object-injection -- numeric index
            newContent[j] = copy;
            toolCallsAffected++;
            messageChanged = true;
            continue;
          }

          // eslint-disable-next-line security/detect-object-injection -- numeric index
          newContent[j] = block;
        }

        if (messageChanged) {
          const filtered = newContent.filter((b) => b !== null);
          // Safety: if stripping thinking blocks emptied the content, keep
          // a minimal text block so the message structure stays valid.
          const safeContent = filtered.length > 0
            ? filtered
            : [{ type: "text" as const, text: "" }];
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          result[i] = { ...(msg as object), content: safeContent } as AgentMessage;
          scrubbedAssistantMessages++;
          anyChanged = true;
        } else {
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          result[i] = original;
        }
      }

      // Always invoke onScrubbed so the context-engine snapshot stays
      // consistent on zero-touch turns (e.g., a single assistant message
      // history). Legacy aliases preserved for the existing snapshot
      // consumer at context-engine.ts ~lines 718–725.
      deps.onScrubbed?.({
        scrubbedAssistantMessages,
        blocksAffected,
        toolCallsAffected,
        latestAssistantIdx: latestIdx,
        dropped: blocksAffected,
        signaturesStripped: toolCallsAffected,
        reason: undefined,
      });

      // Emit INFO once per execute() when at least one assistant message
      // was actually scrubbed. Pino object-first; no string interp.
      if (scrubbedAssistantMessages > 0) {
        deps.logger.info(
          {
            module: "agent.context-engine.signature-replay-scrub",
            scrubbedAssistantMessages,
            blocksAffected,
            toolCallsAffected,
            latestAssistantIdx: latestIdx,
          },
          "Dropped thinking signatures from all assistant messages (cross-turn replay)",
        );
      }

      // Zero-allocation early return when nothing was actually changed.
      if (!anyChanged) return messages;

      return result;
    },
  };
}
