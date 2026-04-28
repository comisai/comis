// SPDX-License-Identifier: Apache-2.0
/**
 * Signature replay scrubber context engine layer.
 *
 * Always-on policy: clears `thinkingSignature` from every assistant message
 * older than the most recent assistant turn, and strips `thoughtSignature`
 * from `toolCall` / `tool_call` blocks in the same older messages. The
 * latest assistant message is preserved untouched so Anthropic's
 * extended-thinking continuation can validate the immediate next call's
 * prefix. `redacted_thinking` blocks are never modified, anywhere.
 *
 * Rationale: Anthropic's signed-thinking validation operates on the full
 * (system + tools + history) prefix. After 8 quick tasks of progressively
 * narrower drift detection (gj6 → kvl) we proved targeted detection is
 * intractable; trace 679c8927 had stable tools (49138 bytes across 4 turns)
 * but the system prompt grew +1824 bytes and the 400 fired anyway. Switch
 * from detection to prevention: older signatures cost nothing to drop —
 * they cannot be revalidated against any prefix the model will actually
 * re-emit. Latest-turn signatures stay live for the immediate continuation.
 *
 * Provider coverage: NOT gated on `model.reasoning` because Gemini's
 * `thoughtSignature` lives on toolCall blocks even when the model itself
 * is not flagged as reasoning. Cost is one walk over older assistant
 * messages, no I/O.
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

    async apply(messages: AgentMessage[], budget: TokenBudget): Promise<AgentMessage[]> {
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

        // Latest assistant message: untouched (signatures preserved).
        // Trailing user/toolResult messages (i > latestIdx): untouched.
        if (i >= latestIdx) {
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          result[i] = original;
          continue;
        }

        // Cache fence: messages at or below the fence must not be modified.
        if (i <= budget.cacheFenceIndex) {
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          result[i] = original;
          continue;
        }

        const msg = original as { role?: string; content?: unknown };
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          result[i] = original;
          continue;
        }

        // Older assistant message past the fence — walk content blocks.
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
            // Signed thinking: clear the signature (do NOT delete the field
            // — pi-ai's serializer expects the property to exist on signed
            // thinking blocks). The thinking content is still present and
            // replayable; only the signature is cleared, which Anthropic
            // tolerates. The alternative — dropping the block entirely —
            // breaks reasoning-token continuity for any future-prefix replay.
            if (typeof b.thinkingSignature === "string" && b.thinkingSignature.length > 0) {
              const copy = { ...(b as Record<string, unknown>), thinkingSignature: "" };
              // eslint-disable-next-line security/detect-object-injection -- numeric index
              newContent[j] = copy;
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
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          result[i] = { ...(msg as object), content: newContent } as AgentMessage;
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

      // Emit INFO once per execute() when at least one older assistant
      // message was actually scrubbed. Pino object-first; no string interp.
      if (scrubbedAssistantMessages > 0) {
        deps.logger.info(
          {
            module: "agent.context-engine.signature-replay-scrub",
            scrubbedAssistantMessages,
            blocksAffected,
            toolCallsAffected,
            latestAssistantIdx: latestIdx,
          },
          "Dropped thinking signatures from non-latest assistant messages",
        );
      }

      // Zero-allocation early return when nothing was actually changed.
      if (!anyChanged) return messages;

      return result;
    },
  };
}
