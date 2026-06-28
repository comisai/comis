// SPDX-License-Identifier: Apache-2.0
/**
 * The memory-cron sentinel dispatch entry — extracted from setup-channels-credentials.ts
 * to keep that leaf under the 600L setup-channels cap. After Phase 226 this file holds NO
 * LLM-backed intercept of its own: the LLM-backed sentinels were all removed —
 * __MEMORY_CONSOLIDATION__ / __MEMORY_REASONING__ / __USER_REPRESENTATION__ in Phase 225-05,
 * the KEYLESS __ONLINE_TUNING__ bandit in Phase 224, the __USEFULNESS_JUDGE__ +
 * __MEMORY_TRIPLE_EXTRACTION__ dormant crons in Phase 226-03, and the __SOCIAL_MODELING__
 * directional-relationship builder (the LAST LLM-backed intercept here) in Phase 226-04 with
 * the rest of the social-modeling subsystem. The surviving sentinels (the KEYLESS
 * __MEMORY_LIFECYCLE__ FORGET-01/06 sweep + the __REFLECT__ engine) live in
 * setup-channels-memory-crons-wire.ts (the 600L dir cap); this entry delegates to it.
 *
 * @module
 */

import { handleWireMemoryCronSentinel } from "./setup-channels-memory-crons-wire.js";
import type { MemoryCronPayload, MemoryCronContext } from "./setup-channels-memory-crons-types.js";

export type { MemoryCronPayload, MemoryCronContext } from "./setup-channels-memory-crons-types.js";

/**
 * Handle a memory-cron sentinel. Returns `true` when the sentinel was recognized +
 * handled (the caller then returns), `false` when it is neither (the caller falls
 * through to the normal delivery path).
 *
 * Phase 226-04: the `__SOCIAL_MODELING__` intercept — the last LLM-backed sentinel that
 * lived here — was REMOVED with the rest of the social-modeling subsystem (the
 * RelationshipStore port + sqlite adapter, the `relationship` table, the offline
 * directional-edge builder, the relationship-block prompt injection, the per-agent
 * socialModeling config key). The surviving WS7-wired sentinels (the KEYLESS
 * __MEMORY_LIFECYCLE__ sweep + the __REFLECT__ engine) live in the sibling wire leaf
 * (the 600L dir cap); this entry delegates the dispatch there. The signature is
 * preserved (it still returns a boolean) so the dispatch contract is unchanged.
 */
export async function handleMemoryCronSentinel(
  resultText: string | undefined,
  payload: MemoryCronPayload,
  ctx: MemoryCronContext,
): Promise<boolean> {
  // NOTE: the __ONLINE_TUNING__ bandit sentinel was DELETED in Phase 224 (the UCB
  // tuned-alpha bandit is gone; recall scoring is the fixed config.rag.scoring alphas),
  // and the __SOCIAL_MODELING__ directional-relationship sentinel in Phase 226-04 (the
  // whole social-modeling subsystem is gone). The remaining sentinels — the KEYLESS
  // __MEMORY_LIFECYCLE__ sweep + the __REFLECT__ engine — live in the sibling
  // setup-channels-memory-crons-wire.ts (the 600L dir cap); delegate the dispatch there.
  return handleWireMemoryCronSentinel(resultText, payload, ctx);
}
