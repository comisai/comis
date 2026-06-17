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

  /**
   * SKILL-09: a procedural-synthesis run admitted N candidate skills. Emitted
   * DAEMON-SIDE (plain `eventBus.emit`, never `?.`) by the __SKILL_SYNTHESIS__ cron
   * handler (setup-channels-memory-crons-wire.ts, Plan 07) AFTER `runSkillSynthesis`
   * returns — the daemon emit (not the agent job) keeps the trajectory-bridge entry
   * landing with the emit (no agent-side gate trip). COUNT ONLY — the synthesized
   * procedure body/script content is a compile error here (the §2.7 / SEC-01
   * firewall). Bridged (TRAJECTORY_BRIDGE_MAPPING) for `comis explain` / OBS-02.
   */
  "learning:skill_synthesized": {
    agentId: string;
    /** How many candidate skills were admitted this run (count only). */
    count: number;
    timestamp: number;
  };

  /**
   * SKILL-09: a synthesized candidate cleared (or failed) validation. Emitted
   * DAEMON-SIDE after the validation adapter returns. The static/dynamic verdict
   * BOOLEANS + the `coverage` CLOSED-ENUM ONLY — never the offending field name, a
   * finding body, or a script (the SEC-01 firewall; a body/scripts field is a
   * compile error). `coverage:'static-only'` means the dynamic sandbox replay did
   * NOT run (no bwrap jail / a script-free candidate); `'full'` means a jailed
   * script executed. Bridged for `comis explain` / OBS-02.
   */
  "learning:skill_validated": {
    agentId: string;
    /** The per-field static memory-poison scan passed (no CRITICAL field). */
    staticOk: boolean;
    /** The sandbox replay ran AND every embedded script exited 0 (false when static-only). */
    dynamicOk: boolean;
    /** Whether a real jail ran the dynamic replay (closed enum). */
    coverage: "full" | "static-only";
    timestamp: number;
  };
}
