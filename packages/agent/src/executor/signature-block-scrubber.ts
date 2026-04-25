// SPDX-License-Identifier: Apache-2.0
/**
 * Signed-replay state scrubber for the reject-and-retry self-heal path.
 *
 * Mutates the in-memory session message array in place so the next API call
 * does not replay the rejected signed thinking / reasoning state. Distinct
 * from the steady-state thinking-block-cleaner pipeline layer:
 * - This scrubber is more aggressive: drops every `type:"thinking"` block
 *   regardless of `redacted` flag, and strips `thoughtSignature` from every
 *   `type:"toolCall"` block.
 * - It runs only on the rejection path in `executor-prompt-runner.ts`, after
 *   `isSignedReplayError` has classified the error.
 *
 * Defensive: tolerates undefined / non-array `messages`, individual messages
 * lacking `content`, non-array content, blocks lacking `type`. Returns the
 * counts so the caller can emit the recovery event with accurate numbers.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk every assistant message in `messages` and:
 * - Filter out every block where `block.type === "thinking"` (signed and
 *   redacted alike).
 * - For every remaining block where `block.type === "toolCall"` or
 *   `block.type === "tool_call"` (pi-ai normalizes inconsistently across
 *   providers), delete `thoughtSignature` if present.
 *
 * Mutates the input array in place. Returns the number of blocks removed and
 * the number of thoughtSignatures stripped so the caller can include them
 * in the recovery event payload.
 */
export function scrubSignedReplayStateInPlace(
  messages: unknown[],
): { blocksRemoved: number; thoughtSignaturesStripped: number } {
  let blocksRemoved = 0;
  let thoughtSignaturesStripped = 0;

  if (!Array.isArray(messages)) {
    return { blocksRemoved, thoughtSignaturesStripped };
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) continue;

    const content = m.content as unknown[];
    // Walk in reverse so splicing does not shift indices we still need to visit.
    for (let i = content.length - 1; i >= 0; i--) {
      // eslint-disable-next-line security/detect-object-injection -- numeric index over caller's array
      const block = content[i];
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; thoughtSignature?: unknown };
      if (b.type === "thinking") {
        content.splice(i, 1);
        blocksRemoved++;
        continue;
      }
      if ((b.type === "toolCall" || b.type === "tool_call") && b.thoughtSignature !== undefined) {
        delete b.thoughtSignature;
        thoughtSignaturesStripped++;
      }
    }
  }

  return { blocksRemoved, thoughtSignaturesStripped };
}
