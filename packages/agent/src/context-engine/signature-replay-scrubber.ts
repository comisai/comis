// SPDX-License-Identifier: Apache-2.0
/**
 * Signature replay scrubber context engine layer.
 *
 * Activates only when `getReplayDriftMode()` returns `{ drop: true }`. When
 * active, drops every `type:"thinking"` block (signed and redacted alike)
 * and strips `thoughtSignature` from every `type:"toolCall"` /
 * `type:"tool_call"` block across the whole history. Respects
 * `budget.cacheFenceIndex` exactly like `thinking-block-cleaner`: messages
 * at or below the fence are passed through unchanged.
 *
 * Provider coverage rationale: the scrubber is NOT gated on `model.reasoning`
 * because Gemini's `thoughtSignature` lives on toolCall blocks even when the
 * model itself is not flagged as reasoning. Cost of running a no-op loop is
 * negligible vs the savings of preventing a 400-rejection round trip.
 *
 * Immutability: never mutates input messages or arrays. Returns new arrays
 * and shallow-copied messages only when changes are needed. When drift is
 * detected but the history happens to contain no thinking blocks or signed
 * toolCalls (e.g. fresh session), returns the original `messages` reference
 * (zero allocation).
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextLayer, TokenBudget } from "./types.js";
import type { DriftCheck } from "../executor/replay-drift-detector.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Stats reported via the `onScrubbed` callback. */
interface ScrubbedStats {
  /** Number of thinking blocks dropped across the whole history. */
  dropped: number;
  /** Number of thoughtSignatures stripped from toolCall blocks. */
  signaturesStripped: number;
  /** Drift reason that triggered the scrub (forwarded for observability). */
  reason?: string;
}

/** Dependencies for `createSignatureReplayScrubber`. */
export interface SignatureReplayScrubberDeps {
  /** Getter for the per-execute() memoized replay drift decision. The
   *  layer no-ops when this returns undefined or `{ drop: false }`. */
  getReplayDriftMode: () => DriftCheck | undefined;
  /** Optional callback invoked exactly once at the end of `apply()` with
   *  the scrub counts and drift reason. */
  onScrubbed?: (stats: ScrubbedStats) => void;
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
      const drift = deps.getReplayDriftMode();
      if (!drift || !drift.drop) {
        // Gate closed → no-op, return same reference (zero allocation).
        return messages;
      }

      if (messages.length === 0) return messages;

      let anyChanged = false;
      let dropped = 0;
      let signaturesStripped = 0;
      const result: AgentMessage[] = new Array(messages.length);

      for (let i = 0; i < messages.length; i++) {
        // eslint-disable-next-line security/detect-object-injection -- numeric index
        const original = messages[i];

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

        const content = msg.content as unknown[];
        let messageChanged = false;
        const newContent: unknown[] = [];

        for (let j = 0; j < content.length; j++) {
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          const block = content[j];
          if (!block || typeof block !== "object") {
            newContent.push(block);
            continue;
          }
          const b = block as { type?: string; thoughtSignature?: unknown };
          if (b.type === "thinking") {
            // Drop signed AND redacted alike — drift mode invalidates the
            // entire prefix, so retaining redacted thinking just keeps a
            // surface that the next replay can still reject.
            dropped++;
            messageChanged = true;
            continue;
          }
          if ((b.type === "toolCall" || b.type === "tool_call") && b.thoughtSignature !== undefined) {
            // Shallow-copy and drop only the thoughtSignature property.
            const copy = { ...(b as Record<string, unknown>) };
            delete copy.thoughtSignature;
            newContent.push(copy);
            signaturesStripped++;
            messageChanged = true;
            continue;
          }
          newContent.push(block);
        }

        if (messageChanged) {
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          result[i] = { ...(msg as object), content: newContent } as AgentMessage;
          anyChanged = true;
        } else {
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          result[i] = original;
        }
      }

      // Always notify so observers see the drift reason even on zero-touch
      // histories (drift fired but no signed state in the conversation yet).
      deps.onScrubbed?.({ dropped, signaturesStripped, reason: drift.reason });

      // Zero-allocation early return when nothing was actually changed.
      if (!anyChanged) return messages;

      return result;
    },
  };
}
