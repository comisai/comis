// SPDX-License-Identifier: Apache-2.0
/**
 * LearningEvents: verified-learning (v2.26) write-back + telemetry events.
 *
 * Composed into `EventMap` (events.ts) as a sibling of `AgentEvents` — the
 * dedicated file keeps `events-agent.ts` under its 799-line cap (Plan 07 adds
 * its `learning:skill_*` telemetry keys to THIS same interface, not events-agent).
 *
 * Closed-graph discipline (the agent↛memory cut, SEC-01): the AGENT emits these
 * events; the DAEMON write-back subscriber does the memory store write. Mirrors
 * the `memory:recall_used → setup-memory-usefulness-wiring.ts → recordUsage`
 * precedent — the agent never imports `@comis/memory`.
 *
 * Counts/ids/closed-scalars ONLY — never bodies, procedure content, or query
 * text crosses the bus (§2.7, the whole memory: / learning: event family).
 * Adding a content-bearing field is a compile error by design (proven by an
 * `@ts-expect-error` test in events-learning.test.ts).
 *
 * Find events by prefix: memory:skill_*.
 */
export interface LearningEvents {
  /**
   * ATTR-02: skill-use attribution complete for one turn. MINIMAL payload —
   * the per-turn used-skill ids + count ONLY, NEVER procedure bodies, the agent
   * response, or the read path. The bridge attributes a `read` whose path
   * matches a frozen learned-skill `<location>` to a skill (ATTR-01) and
   * accumulates the ids in a per-turn carrier; `postExecution` emits this event
   * with those ids. Emit site: `postExecution` (executor-post-execution.ts),
   * gated on a non-empty `usedSkillIds` (absent/empty ⇒ no emit, byte-identical
   * to pre-patch). The daemon subscriber (setup-learning.ts, Plan 07) threads
   * `usedSkillIds` into `observe()` → the `used_skill_ids` column. Mirrors the
   * counts/ids-only `memory:recall_used`; NOT trajectory-bridged (it joins
   * EVENTS_NOT_TRAJECTORY_MAPPED).
   */
  "memory:skill_used": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    /** Opaque learned-skill ids (skillNames) attributed as USED this turn —
     *  ids only, never procedure bodies. */
    usedSkillIds: string[];
    /** == usedSkillIds.length (parity with the counts-only family). */
    usedCount: number;
    timestamp: number;
  };
}
