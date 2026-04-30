// SPDX-License-Identifier: Apache-2.0
/**
 * Signature surrogate guard context engine layer.
 *
 * Defends against pi-ai's `sanitizeSurrogates(block.thinking)` mutating the
 * thinking text while preserving the original signature. When that happens,
 * Anthropic's signature validator rejects the assistant turn on replay with
 * `400 invalid_request_error: ... cannot be modified` because the bytes the
 * signature was computed over no longer match the bytes being sent.
 *
 * Reference: pi-ai upstream behavior in
 * `node_modules/.pnpm/@mariozechner+pi-ai@0.67.68_HASH/node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js`
 * around line 661 calls `sanitizeSurrogates(block.thinking)` while preserving
 * the original `signature`. A separate upstream PR is recommended (out of
 * scope for this commit); Comis is protected by this guard regardless of
 * upstream.
 *
 * Strategy: scan every type:"thinking" block on every assistant message
 * for unpaired UTF-16 surrogates in `block.thinking`. When found AND the
 * block carries a non-empty `thinkingSignature`, strip the signature so
 * pi-ai's downstream serialization falls back to converting the block to
 * plain text rather than sending sanitized-text + original-signature
 * mismatch. Skips `redacted: true` blocks (no readable text to taint).
 *
 * 260430-anthropic-400-thinking-block: cacheFenceIndex is intentionally
 * NOT consulted to gate guarding. The guard is pure/deterministic — input
 * messages → same guarded output every time — so iter 1 strips,
 * Anthropic caches the guarded prefix, iter 2 strips identically, and the
 * cache hits. The prior fence-skip caused per-execution divergence
 * symmetric to the bug found in `signature-replay-scrubber.ts` and
 * `thinking-block-cleaner.ts`: iter 1 stripped (fence=-1) and built a
 * surrogate-safe cached prefix, iter 2 preserved fence-protected messages
 * (fence>0) and re-introduced surrogate-tainted-with-original-signature
 * blocks at positions Anthropic had cached without them.
 *
 * Immutability: never mutates input; shallow-copies the block and the
 * containing message only when scrubbing is needed. When no scrub fires,
 * returns the input array reference unchanged (zero allocation).
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextLayer, TokenBudget } from "./types.js";

// ---------------------------------------------------------------------------
// Surrogate detection regexes (mirror pi-ai sanitizeSurrogates internals)
// ---------------------------------------------------------------------------

// Reference: pi-ai sanitizeSurrogates internals, anthropic.js:661 area.
// High surrogate not followed by low surrogate.
const UNPAIRED_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
// Low surrogate not preceded by high surrogate.
const UNPAIRED_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Stats reported via the `onGuarded` callback. */
interface GuardedStats {
  /** Number of thinkingSignatures stripped due to unpaired surrogates. */
  signaturesStripped: number;
}

/** Optional dependencies for `createSignatureSurrogateGuard`. */
export interface SignatureSurrogateGuardDeps {
  /** Optional callback invoked exactly once at the end of `apply()` with
   *  the count of signatures stripped. */
  onGuarded?: (stats: GuardedStats) => void;
}

/**
 * Create the signature-surrogate-guard pipeline layer.
 *
 * Layer ordering: runs AFTER `signature-replay-scrubber` (Fix #2) and
 * BEFORE `reasoning-tag-stripper`. Always added unconditionally — the cost
 * is one walk over thinking blocks with two regex tests per block, which
 * is negligible compared to a single 400-rejection round trip.
 */
export function createSignatureSurrogateGuard(
  deps?: SignatureSurrogateGuardDeps,
): ContextLayer {
  return {
    name: "signature-surrogate-guard",

    async apply(messages: AgentMessage[], _budget: TokenBudget): Promise<AgentMessage[]> {
      if (messages.length === 0) {
        deps?.onGuarded?.({ signaturesStripped: 0 });
        return messages;
      }

      let anyChanged = false;
      let signaturesStripped = 0;
      const result: AgentMessage[] = new Array(messages.length);

      for (let i = 0; i < messages.length; i++) {
        // eslint-disable-next-line security/detect-object-injection -- numeric index
        const original = messages[i];

        // 260430-anthropic-400-thinking-block: cacheFenceIndex is intentionally
        // NOT consulted here. Stripping uniformly across the array keeps the
        // guarded prefix identical across iterations of the same execution,
        // which is what Anthropic's prompt-cache validator requires.

        const msg = original as { role?: string; content?: unknown };
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
          // eslint-disable-next-line security/detect-object-injection -- numeric index
          result[i] = original;
          continue;
        }

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
            thinking?: unknown;
            redacted?: boolean;
            thinkingSignature?: unknown;
          };

          // Only inspect type:"thinking" blocks.
          if (b.type !== "thinking") {
            // eslint-disable-next-line security/detect-object-injection -- numeric index
            newContent[j] = block;
            continue;
          }
          // Skip redacted blocks: they have no readable text to taint.
          if (b.redacted === true) {
            // eslint-disable-next-line security/detect-object-injection -- numeric index
            newContent[j] = block;
            continue;
          }
          // Skip when there's no signature to strip in the first place.
          if (!b.thinkingSignature) {
            // eslint-disable-next-line security/detect-object-injection -- numeric index
            newContent[j] = block;
            continue;
          }
          const text = b.thinking;
          if (typeof text !== "string") {
            // eslint-disable-next-line security/detect-object-injection -- numeric index
            newContent[j] = block;
            continue;
          }
          if (UNPAIRED_HIGH_SURROGATE.test(text) || UNPAIRED_LOW_SURROGATE.test(text)) {
            // Strip the signature: shallow-copy the block and set
            // thinkingSignature to "" so pi-ai's downstream serialization
            // falls back to converting the block to plain text rather than
            // sending sanitized-text + original-signature mismatch.
            const copy = { ...(b as Record<string, unknown>), thinkingSignature: "" };
            // eslint-disable-next-line security/detect-object-injection -- numeric index
            newContent[j] = copy;
            signaturesStripped++;
            messageChanged = true;
          } else {
            // eslint-disable-next-line security/detect-object-injection -- numeric index
            newContent[j] = block;
          }
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

      deps?.onGuarded?.({ signaturesStripped });

      // Zero-allocation early return when nothing was scrubbed.
      if (!anyChanged) return messages;

      return result;
    },
  };
}
